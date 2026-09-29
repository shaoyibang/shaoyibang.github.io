/* =========================================================================
   md.mjs — 极简 Markdown → HTML

   只支持写随笔真正用得到的那一小撮语法，刻意不做成通用实现：
   语法越少，"编辑器里是好的、页面上坏了"的情况就越少。

   支持：
     # ~ ####        标题
     ---             分隔线（也接受 *** / ___）
     ```lang … ```   围栏代码块
     > 引用
     - / * / +       无序列表
     1.              有序列表
     空行            段落分隔
     **粗体**  *斜体*  `行内代码`  [文字](链接)  ![说明](图片)
     行尾两个空格    强制换行
     裸 HTML 标签    原样透传（写复杂结构时的逃生口）

   ---------------------------------------------------------------------------
   两条容易混的规则，先写在前面（改这个文件前请先读这段）：

   1. 反引号里写的是「源码」，会被转义
        `a < b`   →   <code>a &lt; b</code>

   2. <code>…</code> 里写的是「最终 HTML」，原样保留
        <code>&lt;a&gt;</code>   →   <code>&lt;a&gt;</code>（尖括号照旧显示）

      这两种写法语义不同，所以刻意不做归一化 —— 强行统一必然有一边失真。
      现有文章的 <code> 里写的都是转义好的实体，属于第 2 种。

   ---------------------------------------------------------------------------
   为什么 esc() 连引号也转义，最后又还原：
   只有把引号也转义成 &quot;，"真标签"和"代码里的标签"才在文本层面同形，
   判断依据才会收敛到唯一一个 —— 它在不在代码里。输出前统一还原成裸引号，
   因为站点的正文一直是手写 HTML，用的是裸引号（全文没有一处 &quot;）。
   ========================================================================= */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ESC[c]);
}

/* 代码内容只挡 & < > 三种。
   引号不转义：现有代码块里写的就是裸引号（ctx.lineCap = "round";），
   转成 &quot; 既和现有页面不一致，读者看到的也是一堆实体。 */
function escCode(s) {
  return String(s).replace(/[&<>]/g, (c) => ESC[c]);
}

/* 允许在正文里直接写的标签白名单。
   用白名单而不是"任意字母开头"，是为了不把实体序列误判成标签：
   &lt;a&gt; 里的 a 同样满足"字母开头"。需要新标签时往这里加一行。 */
const KNOWN_TAGS = new Set([
  "a", "b", "strong", "em", "i", "code", "br", "img", "span", "small",
  "sup", "sub", "kbd", "mark", "u", "s", "del", "ins", "abbr", "time",
  "figure", "figcaption", "video", "audio", "source", "picture",
  "ul", "ol", "li", "p", "div", "blockquote", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody",
  "tr", "th", "td",
]);

const TAG_TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>]*)?)(\/?)>/g;

/* ---------------------------------------------------------------------------
   行内解析
   --------------------------------------------------------------------------- */
function inline(s) {
  const store = [];
  const stash = (html) => {
    store.push(html);
    return `\u0000${store.length - 1}\u0000`;
  };

  // 1. 反引号：内容当源码，转义
  let out = s.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escCode(code)}</code>`));

  // 2. <code>…</code>：作者已写好最终 HTML，整段原样保留
  out = out.replace(/<code>[\s\S]*?<\/code>/g, (m) => stash(m));

  // 3. 其余裸标签（白名单内的才认）
  out = out.replace(TAG_TOKEN, (m, _slash, name) =>
    (KNOWN_TAGS.has(name.toLowerCase()) ? stash(m) : m));

  // 4. 转义剩下的内容
  out = esc(out);

  // 5. Markdown 行内语法。图片要在链接之前处理，否则 ![x](y) 会被链接规则先吃掉
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, src, title) =>
      `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy">`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, text, href, title) =>
      `<a href="${href}"${title ? ` title="${title}"` : ""}>${text}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  // 6. 还原被屏蔽的内容；属性里的实体引号变回裸引号
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)].replace(/&quot;/g, '"'));
  return out;
}

/* ---------------------------------------------------------------------------
   块级解析
   --------------------------------------------------------------------------- */

/* 正文里的标题整体降一级：作者写 # 就渲染成 h2。
   原因：页面自身的文章标题已经是 <h1>，每页只能有一个 h1
   （自检脚本 tools/check.mjs 会查这一条）。
   降级量按正文里出现的最小级别来算，这样作者从 ## 开始写也不会被压到 h4。 */
function demoteHeadings(html) {
  const levels = [...html.matchAll(/<h([1-6])>/g)].map((m) => Number(m[1]));
  if (!levels.length) return html;
  const shift = Math.max(0, 2 - Math.min(...levels));
  if (!shift) return html;
  return html.replace(/<(\/?)h([1-6])>/g, (_, slash, n) =>
    `<${slash}h${Math.min(6, Number(n) + shift)}>`);
}

export function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  // 代码块先抽走，避免内容被后面的规则误伤
  const codeStore = [];
  const stashCode = (html) => {
    codeStore.push(html);
    return `\u0001CODE${codeStore.length - 1}\u0001`;
  };

  const isBlank = (n) => n >= lines.length || lines[n].trim() === "";
  const indentOf = (s) => (s.match(/^[ \t]*/) || [""])[0].replace(/\t/g, "  ").length;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // 围栏代码块
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const lang = fence[2];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 收尾围栏
      const cls = lang ? ` class="language-${escCode(lang)}"` : "";
      blocks.push(stashCode(`<pre><code${cls}>${escCode(buf.join("\n"))}</code></pre>`));
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(h[1].length, 6);
      blocks.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 引用：连续 > 行合成一块。统一走 inline()，不加内层 <p>，
    // 与现有文章保持一致
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const text = buf.join("\n").trim().replace(/\n/g, " ");
      blocks.push(`<blockquote>${inline(text)}</blockquote>`);
      continue;
    }

    // 列表
    const ulRe = /^(\s*)([-*+])\s+(.*)$/;
    const olRe = /^(\s*)(\d+)[.)]\s+(.*)$/;
    if (ulRe.test(line) || olRe.test(line)) {
      const ordered = !ulRe.test(line);
      const re = ordered ? olRe : ulRe;
      const items = [];
      let baseIndent = null;

      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) {
          // 列表项的续行（缩进更深且不是新的一项）
          if (!isBlank(i) && items.length && indentOf(lines[i]) > (baseIndent ?? 0)) {
            items[items.length - 1] += " " + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        const ind = m[1].replace(/\t/g, "  ").length;
        if (baseIndent === null) baseIndent = ind;
        if (ind < baseIndent) break;
        items.push(m[3]);
        i++;
      }

      const tag = ordered ? "ol" : "ul";
      blocks.push(
        `<${tag}>\n` +
        items.map((t) => `  <li>${inline(t.trim())}</li>`).join("\n") +
        `\n</${tag}>`
      );
      continue;
    }

    // 多行原始 HTML 块：整段透传。
    // 这类块自带完整结构（例如 <ul>…</ul>），不再跑行内解析。
    // 需要行内语法时写单行即可（单行的裸标签会走上面各分支的 inline()）。
    if (/^\s*</.test(line)) {
      const buf = [];
      while (i < lines.length && !isBlank(i)) {
        buf.push(lines[i]);
        i++;
      }
      if (!buf.length) { i++; continue; }
      blocks.push(buf.join("\n"));
      continue;
    }

    // 段落
    const buf = [];
    while (i < lines.length && !isBlank(i)) {
      const l = lines[i];
      if (/^\s*(#{1,6}\s|>|\s*(```|~~~)|(\s*)([-*+]|\d+[.)])\s)/.test(l)) break;
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) break;
      buf.push(l);
      i++;
    }
    if (!buf.length) { i++; continue; }

    const text = buf.join("\n").replace(/ {2,}$/gm, "<br>");
    blocks.push(`<p>${inline(text)}</p>`);
  }

  // 放回代码块，并把代码块之外的 &quot; 还原成裸引号
  let html = blocks.join("\n\n");
  html = html.replace(/\u0001CODE(\d+)\u0001/g, (_, n) => codeStore[Number(n)]);

  const pres = [];
  html = html.replace(/<pre>[\s\S]*?<\/pre>/g, (m) => {
    pres.push(m);
    return `\u0002PRE${pres.length - 1}\u0002`;
  });
  html = html.replace(/&quot;/g, '"');
  html = html.replace(/\u0002PRE(\d+)\u0002/g, (_, n) => pres[Number(n)]);
  return demoteHeadings(html);
}

/* 把正文按站点的缩进习惯排版（纯为了 diff 好看，不影响渲染）。
   规则：<pre> 的起始行照常缩进，但块**内部**的行不动 ——
   代码的缩进是内容的一部分，多出来的空格会直接改变读者看到的代码。 */
export function indentBody(html, pad = "      ") {
  const out = [];
  let inPre = false;
  for (const line of html.split("\n")) {
    const opens = line.includes("<pre>");
    // 起始行按普通行处理；只有块内后续行才跳过缩进
    const skip = inPre && !opens;
    out.push(line.trim() === "" || skip ? line : pad + line);
    if (opens) inPre = true;
    if (line.includes("</pre>")) inPre = false;
  }
  return out.join("\n");
}

/* 粗略估算阅读时长：中文约 350 字/分钟，英文约 200 词/分钟 */
export function readingMinutes(text) {
  const s = String(text);
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (s.replace(/[\u4e00-\u9fa5]/g, " ").match(/[A-Za-z0-9']+/g) || []).length;
  return Math.max(1, Math.round(cjk / 350 + words / 200));
}
