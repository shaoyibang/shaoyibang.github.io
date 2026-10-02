/* =========================================================================
   paths.mjs — 路径安全与 HTTP 公共零件

   这个文件里的东西被 admin.mjs 和 tools/editor.mjs（开发模式）共用，
   所以不依赖任何全局状态。

   两条贯穿全文件的原则：
   1. 判断"路径是否越界"时，一律解析成绝对路径再断言仍在允许目录内，
      不用字符串查 ".." —— Node 会先把 /assets/%2e%2e/x 这类编码点段规范化，
      字符串层面的检查很容易被绕过或误判。
   2. 上传的图片类型按**文件头**判断，不信 Content-Type 头 —— 那个头是客户端
      说了算的。
   ========================================================================= */
import { stat, readFile } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { createHash } from "node:crypto";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

/* 写作后台的每个响应都是 no-store：这是"所见即最新"的前提，
   也让"保存完刷新还是旧的"这类问题不可能出现。 */
export function send(res, code, body, type, headers = {}) {
  const h = { "Cache-Control": "no-store", ...headers };
  if (type) h["Content-Type"] = type;
  res.writeHead(code, h);
  res.end(body);
}

export const json = (res, code, obj, headers) =>
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8", headers);

export function readBody(req, limit = 25 * 1024 * 1024) {
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

export function within(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

/* 文件名只允许小写字母、数字、连字符。
   这一条同时挡住了目录穿越和奇怪的路径字符 —— slug 会直接变成文件名。 */
export function safeSlug(name) {
  const s = String(name || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : null;
}

const SVG_RE = /<svg[\s>]/i;

/* 按文件头认图片类型。认不出来就返回 null，调用方据此拒绝。
   返回的是"真实类型"，跟客户端声明的 Content-Type 无关。 */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return ".png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  const ascii = (o, n) => b.subarray(o, o + n).toString("latin1");
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return ".gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return ".webp";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return ".avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return ".heic";
  }
  /* SVG 是文本，只看开头一段就够；它没有魔数，所以放最后判。 */
  const head = b.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (SVG_RE.test(head)) return ".svg";
  return null;
}

/* 文件名：可读前缀 + 内容哈希。
   加哈希是为了两件事：同一张图重复上传不会存两份；改了图不会撞上旧名字，
   于是 assets/img/ 可以放心用 immutable 长缓存。 */
export function safeImageName(original, ext, buf) {
  const stem = String(original || "image")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")      // 丢掉非 ASCII（中文文件名在这里被过滤）
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 8);
  return `${stem}-${hash}${ext}`;
}

/* ------------------------------------------------------------ 静态资源解析

   只认一张显式的路径表，不做 basename 兜底。

   一开始这里是"取 basename 再看 web/ 下有没有这个文件"，看着方便，实际有两个
   毛病：地址空间变得不可预测（/随便什么/app.js 都能返回 app.js），
   而且"这个路径本该 404"就没法当断言了 —— 生产模式下 /site/index.html
   会安静地返回后台首页而不是 404，就是这么来的。

   assets/ 按相对路径取，然后断言结果仍在 assets/ 内：先解析成绝对路径，
   再判断边界，不用字符串查 ".." —— Node 会先把 %2e%2e 这类编码点段规范化，
   字符串层面的检查很容易被绕过或误判。 */
export function makeStaticResolver({ webDir, assetsDir, extra = {} }) {
  const routes = new Map([
    ["/", join(webDir, "index.html")],
    ["/index.html", join(webDir, "index.html")],
    ["/login", join(webDir, "login.html")],
    ["/login.html", join(webDir, "login.html")],
    ["/app.js", join(webDir, "app.js")],
    ["/editor.css", join(webDir, "editor.css")],
    ...Object.entries(extra),
  ]);

  return function resolveStatic(urlPath) {
    const clean = decodeURIComponent(urlPath.split("?")[0]);
    if (routes.has(clean)) return routes.get(clean);
    if (clean.startsWith("/assets/")) {
      const candidate = resolve(assetsDir, clean.slice("/assets/".length));
      return within(assetsDir, candidate) ? candidate : null;
    }
    return null;
  };
}

export async function serveFile(res, abs, fallback) {
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
