// 一次性自检：语法检查 + 本地引用完整性 + 常见可达性遗漏
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = resolve(".");
const problems = [];
const notes = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".git") continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".html")) htmlFiles.push(p);
  }
}
const htmlFiles = [];
walk(ROOT);

if (!htmlFiles.length) problems.push("没有找到任何 HTML 文件");

const localRef = /(?:href|src)="([^"#][^"]*)"/g;

for (const file of htmlFiles) {
  const src = readFileSync(file, "utf8");
  const rel = file.replace(ROOT + "\\", "").replace(ROOT + "/", "");
  // 代码示例里的转义标签不算真实引用
  const scan = src.replace(/<pre[\s\S]*?<\/pre>/g, "");

  let m;
  localRef.lastIndex = 0;
  while ((m = localRef.exec(scan))) {
    const ref = m[1];
    if (/^(https?:|mailto:|data:|tel:|javascript:)/.test(ref)) continue;
    const target = resolve(dirname(file), ref.split("#")[0].split("?")[0]);
    if (ref.split("#")[0] === "") continue; // 纯锚点
    if (!existsSync(target)) problems.push(`${rel}: 断链 -> ${ref}`);
  }

  // 基本结构检查
  if (!/<html[^>]*lang=/.test(src)) problems.push(`${rel}: <html> 缺少 lang`);
  if (!/<meta name="viewport"/.test(src)) problems.push(`${rel}: 缺少 viewport`);
  if (!/<title>/.test(src)) problems.push(`${rel}: 缺少 <title>`);
  if (!/class="skip-link"/.test(src)) notes.push(`${rel}: 没有 skip-link`);
  if (!/id="main"/.test(src)) problems.push(`${rel}: 缺少 id="main" 主内容锚点`);

  // 图片必须有 alt
  for (const img of src.match(/<img\b[^>]*>/g) || []) {
    if (!/\balt=/.test(img)) problems.push(`${rel}: <img> 缺少 alt -> ${img.slice(0, 60)}`);
  }

  // 每个页面都应有唯一的 h1
  const h1s = src.match(/<h1[\s>]/g) || [];
  if (h1s.length !== 1) problems.push(`${rel}: h1 数量为 ${h1s.length}（应为 1）`);

  // 图标按钮应有 aria-label 或可见文字
  for (const btn of src.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []) {
    const hasLabel = /aria-label=/.test(btn) || /<span[^>]*>[^<]/.test(btn);
    const textOnly = btn.replace(/<[^>]*>/g, "").trim();
    if (!hasLabel && !textOnly) {
      problems.push(`${rel}: 按钮缺少可访问名称 -> ${btn.replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }
}

console.log(`检查了 ${htmlFiles.length} 个 HTML 文件\n`);
if (notes.length) console.log("提示：\n - " + notes.join("\n - ") + "\n");
if (problems.length) {
  console.log("发现问题：\n - " + problems.join("\n - "));
  process.exitCode = 1;
} else {
  console.log("全部通过：引用完整、结构合法、无缺失 alt / aria-label。");
}
