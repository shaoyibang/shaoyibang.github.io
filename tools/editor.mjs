/* =========================================================================
   editor.mjs — 本地写作服务（零依赖，只用 Node 内置模块）

   为什么需要它：站点是纯静态的，浏览器里的页面写不了文件。所以写作这件事
   只能由本地进程代劳 —— 这个服务负责把编辑好的 Markdown 和图片落到磁盘，
   再调用 build.mjs 生成页面。生成的页面依旧是纯静态 HTML，线上不跑任何服务。

   安全边界：
   · 只监听 127.0.0.1，外部访问不到
   · 写文件前一律校验名字（防目录穿越）
   · 不接受任意路径，只认 blog/posts/*.md 和 assets/img/*

   用法：
     node tools/editor.mjs            默认 http://127.0.0.1:4322
     node tools/editor.mjs --port 5000
   ========================================================================= */
import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, extname, basename, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseFrontMatter, stringifyFrontMatter, buildAll } from "./build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const POSTS_DIR = join(ROOT, "blog", "posts");
const IMG_DIR = join(ROOT, "assets", "img");

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 4322;
const HOST = "127.0.0.1";

/* ------------------------------------------------------------------ 工具 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".mp3": "audio/mpeg", ".woff2": "font/woff2",
};

function send(res, code, body, type) {
  const headers = { "Cache-Control": "no-store" };
  if (type) headers["Content-Type"] = type;
  res.writeHead(code, headers);
  res.end(body);
}

const json = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve_(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* 名字只允许小写字母、数字、连字符，且不能超过 64 字符。
   这条校验同时防住了目录穿越（../）和奇怪的路径字符。 */
function safeSlug(name) {
  const s = String(name || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : null;
}

function safeImageName(original, ext, buf) {
  const stem = String(original || "image")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")      // 丢掉非 ASCII（中文文件名这里会被过滤）
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";
  // 加内容哈希：同样的图重复上传不会产生第二份，改了图也不会撞名
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 8);
  return `${stem}-${hash}${ext}`;
}

async function readPost(slug) {
  const p = join(POSTS_DIR, slug + ".md");
  const raw = await readFile(p, "utf8");
  const { data, body } = parseFrontMatter(raw.replace(/\r\n/g, "\n"));
  return { data, body };
}

async function writePost(slug, data, body) {
  await mkdir(POSTS_DIR, { recursive: true });
  const text = stringifyFrontMatter(data) + "\n" + String(body).replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
  await writeFile(join(POSTS_DIR, slug + ".md"), text, "utf8");
}

/* ------------------------------------------------------------- 静态文件 */
async function serveFile(res, abs, fallback) {
  try {
    const s = await stat(abs);
    if (!s.isFile()) throw new Error("not a file");
    const buf = await readFile(abs);
    send(res, 200, buf, MIME[extname(abs).toLowerCase()] || "application/octet-stream");
  } catch {
    if (fallback) return serveFile(res, fallback, null);
    send(res, 404, "404", "text/plain; charset=utf-8");
  }
}

/* 静态资源的白名单解析。

   这里刻意不靠字符串检查（比如找 ".."）来防穿越：
   Node 的 URL 会把 /assets/%2e%2e/index.html 这类编码点段先规范化掉，
   校验很容易被绕过或误判。改用"解析成绝对路径 + 断言仍在允许目录内"，
   这样不管前面怎么解码、怎么规范化，结果都跑不出边界。 */
const EDITOR_DIR = join(HERE, "editor");
const ASSETS_DIR = join(ROOT, "assets");

function within(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

function resolveStatic(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  if (clean === "/" || clean === "/index.html") return join(EDITOR_DIR, "index.html");
  if (clean === "/app.js") return join(EDITOR_DIR, "app.js");
  if (clean === "/editor.css") return join(EDITOR_DIR, "editor.css");
  if (clean === "/tools/md.mjs") return join(HERE, "md.mjs");

  // 只从编辑器目录和 assets/ 两个地方取文件
  const candidate = clean.startsWith("/assets/")
    ? join(ROOT, clean)
    : join(EDITOR_DIR, basename(clean));
  if (within(ASSETS_DIR, candidate) || within(EDITOR_DIR, candidate)) return candidate;
  return null;
}

/* ------------------------------------------------------------------ 路由 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    /* 文章列表 */
    if (path === "/api/posts" && req.method === "GET") {
      await mkdir(POSTS_DIR, { recursive: true });
      const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md"));
      const posts = [];
      for (const f of files) {
        const slug = f.replace(/\.md$/, "");
        try {
          const { data } = await readPost(slug);
          posts.push({ slug, title: data.title || slug, date: data.date || "" });
        } catch {
          posts.push({ slug, title: slug, date: "" });
        }
      }
      posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return json(res, 200, { posts });
    }

    /* 读一篇 */
    if (path === "/api/post" && req.method === "GET") {
      const slug = safeSlug(url.searchParams.get("slug"));
      if (!slug) return json(res, 400, { error: "文件名不合法" });
      if (!existsSync(join(POSTS_DIR, slug + ".md"))) {
        return json(res, 404, { error: "找不到 " + slug + ".md" });
      }
      const post = await readPost(slug);
      return json(res, 200, post);
    }

    /* 存一篇 */
    if (path === "/api/post" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const slug = safeSlug(payload.slug);
      if (!slug) return json(res, 400, { error: "文件名只能用 a-z、0-9 和连字符" });
      if (!String(payload.data?.title || "").trim()) {
        return json(res, 400, { error: "标题不能为空" });
      }

      const data = { ...payload.data };
      data.slug = slug;

      // 改了文件名就把旧文件删掉，避免留下孤儿
      const original = safeSlug(payload.original);
      if (original && original !== slug) {
        const old = join(POSTS_DIR, original + ".md");
        if (existsSync(old)) {
          const { unlink } = await import("node:fs/promises");
          await unlink(old);
        }
      }

      await writePost(slug, data, payload.body ?? "");

      // 存完立刻重新生成，省得忘了跑构建
      const { written } = buildAll();
      return json(res, 200, { slug, built: written.map((p) => p.replace(ROOT, "")) });
    }

    /* 删一篇。
       只删 Markdown 源文件，页面交给 buildAll 的孤儿清理一起收走 ——
       这样"源和产物"永远由同一个地方维护，不会出现删了源、
       页面还留着的半截状态。
       注意：删除只能从 git 里找回，所以界面上必须二次确认。 */
    if (path === "/api/post" && req.method === "DELETE") {
      const slug = safeSlug(url.searchParams.get("slug"));
      if (!slug) return json(res, 400, { error: "文件名不合法" });
      const target = join(POSTS_DIR, slug + ".md");
      if (!existsSync(target)) return json(res, 404, { error: "找不到 " + slug + ".md" });

      const { unlink } = await import("node:fs/promises");
      await unlink(target);
      const { removed, written } = buildAll();
      return json(res, 200, {
        slug,
        removed: removed.map((p) => p.replace(ROOT, "")),
        built: written.map((p) => p.replace(ROOT, "")),
      });
    }

    /* 只重新生成，不改内容 */
    if (path === "/api/build" && req.method === "POST") {
      const { written, removed } = buildAll();
      return json(res, 200, {
        written: written.map((p) => p.replace(ROOT, "")),
        removed: removed.map((p) => p.replace(ROOT, "")),
      });
    }

    /* 上传图片 */
    if (path === "/api/upload" && req.method === "POST") {
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: "空文件" });

      const ct = String(req.headers["content-type"] || "");
      let ext = ({
        "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
        "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg",
      })[ct];
      if (!ext) return json(res, 415, { error: "只接受图片（png / jpg / webp / gif / avif / svg）" });

      await mkdir(IMG_DIR, { recursive: true });
      const name = safeImageName(url.searchParams.get("name"), ext, buf);
      await writeFile(join(IMG_DIR, name), buf);
      return json(res, 200, {
        path: "../assets/img/" + name,
        bytes: buf.length,
      });
    }

    /* 站点预览：把仓库根目录挂在 /site/ 下。
       为什么要这么做 —— 之前写作和看效果是两个地址（编辑器 4322、
       预览另起一个服务），保存完还得切过去手动刷新，很容易看到旧页面。
       挂上之后保存完点一下「打开主页」就是最新的，而且这里的响应
       一律 no-store，浏览器不会拿缓存糊弄你。 */
    if (req.method === "GET" && (path === "/site" || path.startsWith("/site/"))) {
      const rel = decodeURIComponent(path.slice("/site".length)) || "/index.html";
      if (rel.includes("\0")) return send(res, 404, "404", "text/plain; charset=utf-8");
      let abs = resolve(ROOT, "." + (rel.startsWith("/") ? rel : "/" + rel));
      if (!within(ROOT, abs)) return send(res, 404, "404", "text/plain; charset=utf-8");
      // 目录（含 /site/ 本身）落到 index.html
      try {
        if (existsSync(abs) && (await stat(abs)).isDirectory()) abs = join(abs, "index.html");
      } catch { /* 下面按不存在处理 */ }
      if (!existsSync(abs)) return send(res, 404, "404", "text/plain; charset=utf-8");
      const buf = await readFile(abs);
      res.writeHead(200, {
        "Content-Type": MIME[extname(abs).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      return res.end(buf);
    }

    /* 静态资源 */
    if (req.method === "GET") {
      const abs = resolveStatic(path);
      if (abs) return serveFile(res, abs);
    }

    return send(res, 404, "404", "text/plain; charset=utf-8");
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`写作工具已启动：http://${HOST}:${PORT}`);
  console.log("  · 随笔源文件：blog/posts/*.md");
  console.log("  · 图片存放：assets/img/");
  console.log("  · 保存时会自动重新生成 blog/*.html");
  console.log("  按 Ctrl+C 停止");
});
