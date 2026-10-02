/* =========================================================================
   build.mjs — 从 Markdown 生成随笔页面

   数据流：
     blog/posts/*.md  --(front matter + md.mjs)-->  blog/*.html
                                                 blog/index.html（列表页）

   设计上的两个取舍：
   1. 页面外壳（顶栏 / 菜单 / 页脚）在 Node 侧生成，而不是做一套模板引擎。
      这个站的页面本来就是手写的，模板字符串反而最好读、最容易改。
   2. 生成物是纯静态 HTML，浏览时不跑任何转换 —— "零依赖"这条不能破。

   用法：
     node tools/build.mjs          生成全部
     node tools/build.mjs --check  只检查，不写文件（CI / 自检用）
   ========================================================================= */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { mdToHtml, indentBody, readingMinutes } from "./md.mjs";

const ROOT = resolve(".");
const POSTS_DIR = join(ROOT, "blog", "posts");
const CHECK_ONLY = process.argv.includes("--check");

/* ---------------------------------------------------------------- 站点常量 */
/* 字体已经从 Google 搬到了本地（见 tools/fonts.mjs），所以这里只是一个
   指向 assets/fonts/fonts.css 的相对链接 —— 随笔页在 blog/ 下，多一层 ../。 */
const FONTS_LINK = '<link rel="stylesheet" href="../assets/fonts/fonts.css">';

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23faf9f5'/%3E%3Cg transform='matrix(0.046195,0,0,0.046195,-7.12,-9.26)'%3E%3Cpath fill='%23d97757' d='M 665 300 L 420 300 C 330 300 265 345 265 425 C 265 495 315 530 390 550 L 555 595 C 610 610 635 630 635 665 C 635 705 600 730 540 730 L 335 730 L 285 800 L 555 800 C 655 800 730 750 730 665 C 730 590 680 555 605 535 L 430 488 C 375 473 360 450 360 425 C 360 395 385 370 435 370 L 615 370 Z'/%3E%3C/g%3E%3C/svg%3E";

const SPIKE = '<svg class="spike" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>';

/* Sean 的 S 字标（源图 C:\Users\SYB\Pictures\Slogo\minimal_S_logo(1).svg）。
   页头用它；菜单里那个 SPIKE 是装饰性眉标，保持星形不变。
   32×32 画布、16% 内边距、居中；珊瑚填充配奶油圆角底，
   保证在深色浏览器工具栏上也能看见。
   注意：下面用到模板插值，所以注释里不要出现美元符号加左花括号。 */
const S_PATH = "M 665 300 L 420 300 C 330 300 265 345 265 425 C 265 495 315 530 390 550 " +
  "L 555 595 C 610 610 635 630 635 665 C 635 705 600 730 540 730 L 335 730 " +
  "L 285 800 L 555 800 C 655 800 730 750 730 665 C 730 590 680 555 605 535 " +
  "L 430 488 C 375 473 360 450 360 425 C 360 395 385 370 435 370 L 615 370 Z";

const BRAND_MARK = '<svg class="brand__mark" width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">' +
  '<rect width="32" height="32" rx="7" fill="#faf9f5"/>' +
  '<g transform="matrix(0.046195,0,0,0.046195,-7.12,-9.26)">' +
  `<path fill="#d97757" d="${S_PATH}"/></g></svg>`;

const SOCIALS = `        <a class="menu__social" href="https://github.com/shaoyibang" target="_blank" rel="noopener me" aria-label="GitHub" title="GitHub">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.85-2.35 4.7-4.58 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
        </a>
        <a class="menu__social" href="https://x.com/wulabulafuo" target="_blank" rel="noopener me" aria-label="X（原 Twitter）" title="X">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>
        </a>
        <a class="menu__social" href="https://space.bilibili.com/66916738" target="_blank" rel="noopener me" aria-label="哔哩哔哩" title="哔哩哔哩">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"/></svg>
        </a>`;

const MENU = [
  ["../index.html", "01", "首页", "Home"],
  ["index.html", "02", "随笔", "Journal"],
  ["../tools.html", "03", "工具", "Tools"],
  ["../index.html#contact", "04", "联系", "Contact"],
].map(([href, num, label, en]) =>
  `      <li><a class="menu__item" href="${href}">\n` +
  `        <span class="menu__num">${num}</span>` +
  `<span class="menu__label">${label}</span>` +
  `<span class="menu__en">${en}</span>\n` +
  `        <span class="menu__go" aria-hidden="true">` +
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ` +
  `stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>\n` +
  `      </a></li>`
).join("\n");

/* ------------------------------------------------------------ front matter */

/* 极薄的 YAML 子集：只认 key: value，值两边去空白。
   够用就好 —— 写随笔不需要嵌套结构，真需要时直接用 HTML 也行。 */
export function parseFrontMatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: String(text) };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { data, body: String(text).slice(m[0].length) };
}

export function stringifyFrontMatter(data) {
  const order = ["title", "date", "summary", "lede", "cats", "slug", "minutes"];
  const keys = [...order.filter((k) => k in data), ...Object.keys(data).filter((k) => !order.includes(k))];
  return "---\n" + keys.map((k) => `${k}: ${data[k]}`).join("\n") + "\n---\n";
}

/* ------------------------------------------------------------------ 读文章 */

export function loadPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const raw = readFileSync(join(POSTS_DIR, f), "utf8").replace(/\r\n/g, "\n");
      const { data, body } = parseFrontMatter(raw);
      return {
        slug,
        file: slug + ".html",
        title: data.title || slug,
        date: data.date || "1970-01-01",
        summary: data.summary || "",
        lede: data.lede || data.summary || "",
        cats: data.cats || "",
        body,
        // 阅读时长优先用 front matter 里写的值。
        // 估算只是给新文章一个起点 —— 作者对自己文章该读多久更有判断，
        // 而且技术文章的实际阅读速度比字数估出来的慢。
        minutes: /^\d+$/.test(String(data.minutes || ""))
          ? Number(data.minutes)
          : readingMinutes(body),
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* -------------------------------------------------------------- 文章页外壳 */
export function renderPost(p, all) {
  const idx = all.findIndex((x) => x.slug === p.slug);
  // 列表按日期降序：idx+1 是更早的文章，idx-1 是更新的文章。
  // 按作者的约定：更早的叫「下一篇」，更新的叫「上一篇」。
  // 一篇都不给（首篇）时退回到有哪篇写哪篇。
  const older = all[idx + 1];
  const newer = all[idx - 1];
  let prevHtml = "&nbsp;";
  if (newer) prevHtml = `上一篇：<a href="${newer.file}">${escAttr(newer.title)}</a>`;
  else if (older) prevHtml = `下一篇：<a href="${older.file}">${escAttr(older.title)}</a>`;

  const bodyHtml = indentBody(mdToHtml(p.body));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escAttr(p.title)} · Sean 的工具库</title>
<meta name="description" content="${escAttr(p.summary)}">
<meta name="theme-color" content="#faf9f5">
<link rel="icon" href="${FAVICON}">
${FONTS_LINK}
<link rel="stylesheet" href="../assets/css/site.css">
<script>
  (function () { document.documentElement.classList.add("js"); })();
</script>
</head>
<body>
<a class="skip-link" href="#main">跳到主要内容</a>

<header class="site-header">
  <div class="wrap site-header__in">
    <a class="brand" href="../index.html">
      ${BRAND_MARK}
      Sean 工具库
      <span class="sr-only">回到首页</span>
    </a>

    <nav class="nav" aria-label="主导航">
      <a class="nav__link is-active" href="index.html" aria-current="page">随笔</a>
      <a class="nav__link" href="../tools.html">工具</a>
    </nav>

    <div class="site-header__right">
      <time class="clock" role="timer" aria-live="off" aria-label="当前北京时间" title="北京时间 · UTC+8">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.2 2"/></svg>
        <b data-bj-time>--:--:--</b>
      </time>

      <button class="icon-btn music" type="button" id="music-btn" aria-pressed="false" aria-label="打开背景音乐" title="背景音乐：关（点一下播放）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 18V6l10-2v12"/>
          <circle cx="6.5" cy="18" r="2.5"/>
          <circle cx="16.5" cy="16" r="2.5"/>
          <path class="slash" d="M4.5 4.5l15 15"/>
        </svg>
      </button>

      <button class="icon-btn" type="button" id="menu-open" aria-haspopup="dialog" aria-expanded="false" aria-controls="menu">
        <span class="sr-only">打开导航菜单</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>
      </button>
    </div>
  </div>
</header>

<main id="main">
  <div class="wrap">

    <a class="back-link" href="index.html">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>
      返回文章列表
    </a>

    <div class="post-head">
      <div class="card__meta" style="margin-bottom:16px">
        <time datetime="${escAttr(p.date)}">${escAttr(p.date)}</time><span>·</span><span>${p.minutes} 分钟</span>${p.cats ? `<span>·</span><span>${escAttr(p.cats)}</span>` : ""}
      </div>
      <h1>${escAttr(p.title)}</h1>
      <p class="lede">${escAttr(p.lede)}</p>
    </div>

    <article class="prose">
${bodyHtml}
    </article>

    <footer class="footer">
      <div class="footer__in">
        <p>${prevHtml}</p>
        <p class="footer__links">
          <a href="index.html">← 回随笔列表</a>
          <a href="../index.html">回首页</a>
        </p>
      </div>
    </footer>
  </div>
</main>

<!-- ================= 编号菜单 ================= -->
<div class="menu" id="menu" data-open="false" role="dialog" aria-modal="true" aria-label="站点导航">
  <div class="menu__card" role="document">
    <div class="menu__head">
      <span class="menu__badge">
        ${SPIKE}
        Sean
      </span>
      <button class="icon-btn menu__close" type="button" id="menu-close">
        <span class="sr-only">关闭菜单</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>

    <ul class="menu__list">
${MENU}
    </ul>

    <div class="menu__foot">
      <div class="menu__socials">
${SOCIALS}
      </div>
      <a class="menu__mail" href="mailto:shaoyibang@163.com">shaoyibang@163.com</a>
      <p class="menu__copy">© 2026 邵乙梆 · Sean 的工具库</p>
    </div>
  </div>
</div>

<audio id="bgm" src="../music.mp3" loop preload="none"></audio>
<script src="../assets/js/site.js"></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------ 文章列表页 */
export function renderIndex(all) {
  const rows = all.map((p) => `      <a class="row" href="${p.file}">
        <time datetime="${escAttr(p.date)}">${escAttr(p.date)}</time>
        <span>
          <b>${escAttr(p.title)}</b>
          <p>${escAttr(p.summary)}</p>
        </span>
        <span class="row__go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span>
      </a>`).join("\n\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>随笔 · Sean 的工具库</title>
<meta name="description" content="关于界面设计、前端实现与可访问性的随笔，写得慢，但每篇都尽量给出可验证的结论。">
<meta name="theme-color" content="#faf9f5">
<link rel="icon" href="${FAVICON}">
${FONTS_LINK}
<link rel="stylesheet" href="../assets/css/site.css">
<script>
  (function () { document.documentElement.classList.add("js"); })();
</script>
</head>
<body>
<a class="skip-link" href="#main">跳到主要内容</a>

<header class="site-header">
  <div class="wrap site-header__in">
    <a class="brand" href="../index.html">
      ${BRAND_MARK}
      Sean 工具库
      <span class="sr-only">回到首页</span>
    </a>

    <nav class="nav" aria-label="主导航">
      <a class="nav__link is-active" href="index.html" aria-current="page">随笔</a>
      <a class="nav__link" href="../tools.html">工具</a>
    </nav>

    <div class="site-header__right">
      <time class="clock" role="timer" aria-live="off" aria-label="当前北京时间" title="北京时间 · UTC+8">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.2 2"/></svg>
        <b data-bj-time>--:--:--</b>
      </time>

      <button class="icon-btn music" type="button" id="music-btn" aria-pressed="false" aria-label="打开背景音乐" title="背景音乐：关（点一下播放）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 18V6l10-2v12"/>
          <circle cx="6.5" cy="18" r="2.5"/>
          <circle cx="16.5" cy="16" r="2.5"/>
          <path class="slash" d="M4.5 4.5l15 15"/>
        </svg>
      </button>

      <button class="icon-btn" type="button" id="menu-open" aria-haspopup="dialog" aria-expanded="false" aria-controls="menu">
        <span class="sr-only">打开导航菜单</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>
      </button>
    </div>
  </div>
</header>

<main id="main">
  <div class="wrap">

    <div class="page-head">
      <span class="eyebrow">
        ${SPIKE}
        Journal
      </span>
      <h1>写下来才算想清楚</h1>
      <p class="lede">关于界面设计、前端实现和可访问性的随笔。更新很慢，因为每篇我都希望能给出一个可以被验证的结论，而不是一堆形容词。</p>
    </div>

    <section class="rows" aria-label="文章列表">

${rows}

    </section>

    <section class="section">
      <div class="callout" style="max-width:var(--w-text)">
        <span class="tile__label">Note</span>
        <h3>文章不多，写一篇算一篇</h3>
        <p class="muted">都是自己踩过的坑，写完就放上来——所以更新没有固定频率。想催更，或者发现哪里写错了，直接发邮件告诉我。</p>
        <p style="margin:20px 0 0">
          <a class="btn btn--primary btn--sm" href="mailto:shaoyibang@163.com?subject=%E5%85%B3%E4%BA%8E%E9%9A%8F%E7%AC%94">发邮件</a>
        </p>
      </div>
    </section>

    <footer class="footer">
      <div class="footer__in">
        <p>© 2026 邵乙梆 · Sean 的工具库</p>
        <p class="footer__links"><a href="../index.html">← 回首页</a></p>
      </div>
    </footer>
  </div>
</main>

<!-- ================= 编号菜单 ================= -->
<div class="menu" id="menu" data-open="false" role="dialog" aria-modal="true" aria-label="站点导航">
  <div class="menu__card" role="document">
    <div class="menu__head">
      <span class="menu__badge">
        ${SPIKE}
        Sean
      </span>
      <button class="icon-btn menu__close" type="button" id="menu-close">
        <span class="sr-only">关闭菜单</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>

    <ul class="menu__list">
${MENU}
    </ul>

    <div class="menu__foot">
      <div class="menu__socials">
${SOCIALS}
      </div>
      <a class="menu__mail" href="mailto:shaoyibang@163.com">shaoyibang@163.com</a>
      <p class="menu__copy">© 2026 邵乙梆 · Sean 的工具库</p>
    </div>
  </div>
</div>

<audio id="bgm" src="../music.mp3" loop preload="none"></audio>
<script src="../assets/js/site.js"></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------ 首页的随笔区块 */

/* 首页本身是手写的，但「随笔」列表和随笔篇数是文章状态的投影 ——
   手写就意味着每加/删一篇文章都要记得改首页，实测忘得很快（删完文章
   首页还列着三篇已经不存在的文章，链接全断）。
   所以这两块改成生成：用注释标记出范围，生成时只替换标记之间的内容，
   首页其余部分仍然手写。 */
const HOME = join(ROOT, "index.html");
const JOURNAL_START = "<!-- journal:start";
const JOURNAL_END = "<!-- journal:end";
const UPDATES_START = "<!-- updates:start";
const UPDATES_END = "<!-- updates:end";

/* 工具清单：首页「最近更新」要把工具和随笔混在一起按时间排，
   所以每个工具在这里留一条日期。加/改工具时同步这里。 */
const TOOLS = [
  { title: "涂鸦板", href: "tools.html#doodle", date: "2026-01-18", kind: "工具" },
  { title: "贪吃蛇", href: "tools.html#snake", date: "2026-01-12", kind: "工具" },
  { title: "生命游戏", href: "tools.html#life", date: "2026-01-06", kind: "工具" },
];

const UPDATES_LIMIT = 3;

function renderUpdates(posts) {
  const items = [
    ...posts.map((p) => ({
      date: p.date,
      kind: "随笔",
      title: p.title,
      href: `blog/${p.file}`,
    })),
    ...TOOLS,
  ]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, UPDATES_LIMIT);

  if (!items.length) return `          <li class="update"><span><b>还没有内容</b></span></li>`;

  return items
    .map(
      (it) => `          <li class="update">
            <time datetime="${escAttr(it.date)}">${escAttr(it.date.slice(5))}</time>
            <span>
              <b><a href="${escAttr(it.href)}">${escAttr(it.title)}</a></b>
              <small>${escAttr(it.kind)} · ${escAttr(it.date)}</small>
            </span>
          </li>`
    )
    .join("\n");
}

function renderHomeRows(posts) {
  if (!posts.length) {
    return `        <p class="muted" style="padding:8px 4px">还没有写过随笔。`
      + `<a href="blog/index.html">去随笔列表看看</a></p>`;
  }
  return posts.map((p) => `        <a class="row" href="blog/${p.file}">
          <time datetime="${escAttr(p.date)}">${escAttr(p.date)}</time>
          <span>
            <b>${escAttr(p.title)}</b>
            <p>${escAttr(p.summary)}</p>
          </span>
          <span class="row__go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span>
        </a>`).join("\n");
}

export function renderHome(posts) {
  if (!existsSync(HOME)) return null;
  const src = readFileSync(HOME, "utf8").replace(/\r\n/g, "\n");

  // 1. 随笔列表：替换两个标记之间的全部内容
  const a = src.indexOf(JOURNAL_START);
  const b = src.indexOf(JOURNAL_END);
  if (a < 0 || b < 0 || b < a) return null;
  const lineEnd = src.indexOf("\n", a);
  const head = src.slice(0, lineEnd + 1);
  const tail = src.slice(b);
  let out = head + renderHomeRows(posts) + "\n        " + tail;

  // 2. 随笔篇数：<!-- stat:posts -->N<!-- /stat:posts -->
  out = out.replace(
    /(<!-- stat:posts -->)\d+(<!-- \/stat:posts -->)/,
    `$1${posts.length}$2`
  );

  // 3. 最近更新：随笔 + 工具混合，按日期倒序取前 3 条
  const ua = out.indexOf(UPDATES_START);
  const ub = out.indexOf(UPDATES_END);
  if (ua >= 0 && ub > ua) {
    const uLineEnd = out.indexOf("\n", ua);
    const uHead = out.slice(0, uLineEnd + 1);
    const uTail = out.slice(ub);
    out = uHead + renderUpdates(posts) + "\n        " + uTail;
    // 面板右上角的日期跟着最新一条走
    const latest = [...posts.map((p) => p.date), ...TOOLS.map((t) => t.date)]
      .sort()
      .pop();
    out = out.replace(
      /(<!-- updated-at -->)[^<]*(<!-- \/updated-at -->)/,
      `$1${latest}$2`
    );
  }

  return out;
}

/* -------------------------------------------------------------------- 主流程 */

/* 找出"源已经没了、页面还留着"的孤儿。
   页面命名规则是 blog/<slug>.html ↔ blog/posts/<slug>.md，
   所以 blog/ 下任何不属于当前文章的 .html（除列表页 index.html）都是孤儿。
   不做这一步的话，删掉一篇文章会在仓库里留下一个永远没人访问、
   但会被部署上去的死页面。 */
export function findOrphans(posts) {
  const keep = new Set(posts.map((p) => p.file));
  keep.add("index.html");
  const blogDir = join(ROOT, "blog");
  if (!existsSync(blogDir)) return [];
  return readdirSync(blogDir)
    .filter((f) => f.endsWith(".html") && !keep.has(f))
    .map((f) => join(blogDir, f));
}

export function buildAll({ check = false } = {}) {
  const all = loadPosts();

  mkdirSync(join(ROOT, "blog"), { recursive: true });
  const written = [];
  const stale = [];
  const removed = [];
  const orphans = findOrphans(all);

  if (!all.length) {
    // 一篇文章都不剩时，列表页仍然要生成（空的随笔列表也是一个正常页面）
    console.log("blog/posts/ 里没有文章");
  }

  const outputs = [
    ...all.map((p) => [join(ROOT, "blog", p.file), renderPost(p, all)]),
    [join(ROOT, "blog", "index.html"), renderIndex(all)],
    [HOME, renderHome(all)],
  ].filter(([, content]) => content !== null && content !== undefined);

  for (const [path, content] of outputs) {
    const next = content.replace(/\r\n/g, "\n");
    const cur = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
    if (cur === next) continue;
    if (check) { stale.push(path); continue; }
    writeFileSync(path, next, { encoding: "utf8" });
    written.push(path);
  }

  for (const path of orphans) {
    if (check) { stale.push(path); continue; }
    try {
      unlinkSync(path);
      removed.push(path);
    } catch { /* 删不掉就算了，不要让构建整体失败 */ }
  }

  return { written, stale, removed, posts: all };
}

// 作为脚本直接运行时才执行
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
    process.argv[1].endsWith("build.mjs")) {
  const { written, stale, removed } = buildAll({ check: CHECK_ONLY });
  const rel = (p) => p.replace(ROOT + "\\", "").replace(ROOT + "/", "");
  if (CHECK_ONLY) {
    if (stale.length) {
      console.log("以下文件与 Markdown 源不一致，需要重新生成：");
      stale.forEach((p) => console.log("  " + rel(p)));
      process.exitCode = 1;
    } else {
      console.log("生成物与 Markdown 源一致");
    }
  } else {
    if (written.length) written.forEach((p) => console.log("wrote " + rel(p)));
    if (removed.length) removed.forEach((p) => console.log("removed " + rel(p)));
    if (!written.length && !removed.length) console.log("没有变化，未写文件");
  }
}
