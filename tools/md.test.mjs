// md.mjs 的单元测试：把「什么该被转义、什么该被还原」这条规则固定下来。
// 之前是靠逐篇比对发现问题的，太慢；这里把每个坑都写成一条断言。
import { mdToHtml } from "./md.mjs";

const cases = [
  // [说明, markdown, 期望输出]
  ["普通段落", "你好世界", "<p>你好世界</p>"],

  ["粗体", "这是**重点**。", "<p>这是<b>重点</b>。</p>"],

  ["斜体", "这是*强调*。", "<p>这是<em>强调</em>。</p>"],

  // 行内代码里的 HTML 必须是转义后的字面量，绝不能被还原成真标签。
  // 两种写法（反引号 / 原始 code 标签）必须得到同一个结果。
  //
  // 关于引号：这里刻意保留裸引号。现有文章的 <code> 里写的就是
  // `&lt;div id="app"&gt;`（裸引号），全文没有一处 &quot;。
  // 裸引号在 HTML 里是合法的，渲染结果一致，所以迁就既有写法更安全。
  ["行内代码里的标签（反引号写法）",
    "一个空 `<div id=\"app\"></div>` 在这里",
    "<p>一个空 <code>&lt;div id=\"app\"&gt;&lt;/div&gt;</code> 在这里</p>"],

  ["行内代码里的标签（原始 code 标签写法）",
    "一个空 <code>&lt;div id=\"app\"&gt;&lt;/div&gt;</code> 在这里",
    "<p>一个空 <code>&lt;div id=\"app\"&gt;&lt;/div&gt;</code> 在这里</p>"],

  ["行内代码里的单个标签",
    "原生 <code>&lt;a&gt;</code>、<code>&lt;button&gt;</code> 自带焦点",
    "<p>原生 <code>&lt;a&gt;</code>、<code>&lt;button&gt;</code> 自带焦点</p>"],

  ["反引号里的裸尖括号会被转义",
    "写 `a < b` 表示小于",
    "<p>写 <code>a &lt; b</code> 表示小于</p>"],

  // 逃生口：正文里直接写裸标签应当保留
  ["裸内联链接",
    "我在<a href=\"../tools.html\">工具实验室</a>里放了三个东西",
    "<p>我在<a href=\"../tools.html\">工具实验室</a>里放了三个东西</p>"],

  ["裸 strong",
    "我的经验是<strong>桌面 12 列</strong>。",
    "<p>我的经验是<strong>桌面 12 列</strong>。</p>"],

  ["裸自闭合标签", "换行<br>下一行", "<p>换行<br>下一行</p>"],

  // 普通文本里的小于号不能被当成标签
  ["小于号", "如果 a < 3 就成立", "<p>如果 a &lt; 3 就成立</p>"],
  ["小于号带引号", "参数 < 3 且 name=\"x\"", "<p>参数 &lt; 3 且 name=\"x\"</p>"],

  ["Markdown 链接",
    "见[作品](works.html)。",
    "<p>见<a href=\"works.html\">作品</a>。</p>"],

  ["图片",
    "![示意图](../assets/img/a.png)",
    "<p><img src=\"../assets/img/a.png\" alt=\"示意图\" loading=\"lazy\"></p>"],

  ["图片带标题",
    "![图](../assets/img/a.png \"说明\")",
    "<p><img src=\"../assets/img/a.png\" alt=\"图\" title=\"说明\" loading=\"lazy\"></p>"],

  // 块级
  ["二级标题", "## 标题", "<h2>标题</h2>"],
  ["分隔线", "---", "<hr>"],

  ["引用（无标签）", "> 一句引用", "<blockquote>一句引用</blockquote>"],
  ["引用（内联代码）",
    "> 顺带说一句，原生 <code>&lt;a&gt;</code> 自带焦点",
    "<blockquote>顺带说一句，原生 <code>&lt;a&gt;</code> 自带焦点</blockquote>"],
  ["引用（粗体）", "> 这里有**重点**", "<blockquote>这里有<b>重点</b></blockquote>"],

  ["无序列表", "- 甲\n- 乙", "<ul>\n  <li>甲</li>\n  <li>乙</li>\n</ul>"],
  ["有序列表", "1. 甲\n2. 乙", "<ol>\n  <li>甲</li>\n  <li>乙</li>\n</ol>"],

  ["列表项里有粗体和代码",
    "- **不用 UI 框架。**手写 `CSS` 更快",
    "<ul>\n  <li><b>不用 UI 框架。</b>手写 <code>CSS</code> 更快</li>\n</ul>"],

  ["围栏代码块不转义反引号内容",
    "```\n<div class=\"x\">a & b</div>\n```",
    "<pre><code>&lt;div class=\"x\"&gt;a &amp; b&lt;/div&gt;</code></pre>"],

  ["围栏代码块带语言",
    "```js\nconst a = 1;\n```",
    "<pre><code class=\"language-js\">const a = 1;</code></pre>"],

  ["代码块里的 HTML 不被还原",
    "```\n&lt;div&gt;已转义&lt;/div&gt;\n```",
    "<pre><code>&amp;lt;div&amp;gt;已转义&amp;lt;/div&amp;gt;</code></pre>"],

  ["段落内换行合并", "第一行\n第二行", "<p>第一行\n第二行</p>"],

  ["多段落", "第一段\n\n第二段", "<p>第一段</p>\n\n<p>第二段</p>"],
];

let pass = 0;
const fails = [];
for (const [name, src, want] of cases) {
  const got = mdToHtml(src);
  if (got === want) { pass++; continue; }
  fails.push({ name, src, want, got });
}

console.log(`${pass}/${cases.length} 通过`);
for (const f of fails) {
  console.log(`\nFAIL  ${f.name}`);
  console.log(`  输入: ${JSON.stringify(f.src)}`);
  console.log(`  期望: ${JSON.stringify(f.want)}`);
  console.log(`  实际: ${JSON.stringify(f.got)}`);
}
process.exitCode = fails.length ? 1 : 0;
