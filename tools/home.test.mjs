// 一次性核对：首页随笔区块是否与 blog/posts 里的文章一致。
import { readFileSync, readdirSync } from "node:fs";

const home = readFileSync("index.html", "utf8");
const stat = (home.match(/<!-- stat:posts -->(\d+)<!-- \/stat:posts -->/) || [])[1];
const links = [...home.matchAll(/class="row" href="(blog\/[^"]+)"/g)].map((m) => m[1]);

const posts = readdirSync("blog/posts").filter((f) => f.endsWith(".md"))
  .map((f) => "blog/" + f.replace(/\.md$/, ".html"));

const same = links.length === posts.length && links.every((l) => posts.includes(l));
console.log("首页篇数标记 =", stat);
console.log("首页链接数   =", links.length, "|", links.join(", ") || "(无)");
console.log("posts 实际   =", posts.length, "|", posts.join(", ") || "(无)");
console.log(same && stat === String(posts.length) ? "一致" : "不一致！");
process.exitCode = same && stat === String(posts.length) ? 0 : 1;
