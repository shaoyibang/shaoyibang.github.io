/* =========================================================================
   admin.mjs — 写作后台（开发 / 生产同一个人实现，两种模式）

   为什么是一个实现两种模式：
     写路径只有一份代码。开发模式（tools/editor.mjs）和生产模式跑的是同一个
     文件，区别只在"绑哪个地址、要不要鉴权、挂不挂 /site/ 预览"。
     两份各自演化的写逻辑迟早会不一致 —— 那是这个仓库已经记过的教训。

   模式差异：
     --dev  绑 127.0.0.1、不鉴权、保留 /site/ 站点预览（保存完即见）
     生产   绑 0.0.0.0（只应被 Caddy 反代到）、强制登录、禁用 /site/

   生产模式为什么要禁用 /site/：
     它把整个仓库挂在 /site/ 下，包括 .git 和 blog/posts/*.md 源文件。
     反代是把 /admin 前缀剥掉再转发的，于是 /admin/site/ 就等于把仓库
     连同历史一起公开了。开发模式因为只绑回环才留着它。

   用法：
     node server/admin.mjs --dev             开发：http://127.0.0.1:4322
     node server/admin.mjs                   生产：需要下面三个环境变量
   ========================================================================= */
import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MIME, send, json, readBody, within, safeSlug, safeImageName, sniffImage,
  makeStaticResolver, serveFile,
} from "./paths.mjs";
import {
  verifyPassword, signSession, verifySession, parseCookies,
  RateLimiter, clientIp,
} from "./auth.mjs";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
process.chdir(ROOT);

/* build.mjs 用 resolve(".") 定位仓库根，但 ESM 的 import 会在本模块函数体
   之前求值 —— 所以必须 chdir 之后再动态导入，否则它按启动时的 CWD 算，
   从别的目录启动就会写错地方。 */
const { parseFrontMatter, stringifyFrontMatter, buildAll } = await import("../tools/build.mjs");
const { mdToHtml } = await import("../tools/md.mjs");

/* ------------------------------------------------------------------ 配置 */
const argv = process.argv.slice(2);
const DEV = argv.includes("--dev");
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : Number(process.env.PORT || 4322);
/* 开发模式硬绑回环：绝不能让"不鉴权"的实例被外网摸到。 */
const HOST = DEV ? "127.0.0.1" : process.env.HOST || "0.0.0.0";

const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 3600_000;

/* 反代把 /admin 前缀剥掉再转发，所以应用自己看到的是 /、/api/...。
   但 cookie 的 Path 和登录跳转必须是浏览器看得到的绝对路径，因此需要知道
   挂载前缀。开发模式挂在根上，所以是空串。 */
const ADMIN_BASE = process.env.ADMIN_BASE !== undefined
  ? process.env.ADMIN_BASE
  : (DEV ? "" : "/admin");

const COOKIE_NAME = "sean_admin";

if (!DEV) {
  const missing = [];
  if (!ADMIN_USER) missing.push("ADMIN_USER");
  if (!ADMIN_PASSWORD_HASH) missing.push("ADMIN_PASSWORD_HASH");
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) missing.push("SESSION_SECRET（至少 32 字符）");
  if (missing.length) {
    console.error("生产模式缺少配置，拒绝启动：\n  - " + missing.join("\n  - "));
    console.error("\n用 node tools/passwd.mjs 生成口令哈希和会话密钥。");
    process.exit(1);
  }
}

const WEB_DIR = join(HERE, "web");
const ASSETS_DIR = join(ROOT, "assets");
const POSTS_DIR = join(ROOT, "blog", "posts");
const IMG_DIR = join(ASSETS_DIR, "img");
const GIT_DIR = join(ROOT, ".git");

/* 共用模块挂到后台自己的命名空间下。前端用相对路径 ./md.mjs 引它，
   于是在根上（开发）和 /admin/ 下（生产）都算得对。 */
const resolveStatic = makeStaticResolver({
  webDir: WEB_DIR,
  assetsDir: ASSETS_DIR,
  extra: { "/md.mjs": join(ROOT, "tools", "md.mjs") },
});

const loginLimiter = new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

/* --------------------------------------------------------------- 文章读写 */
async function readPost(slug) {
  const raw = await readFile(join(POSTS_DIR, slug + ".md"), "utf8");
  const { data, body } = parseFrontMatter(raw.replace(/\r\n/g, "\n"));
  return { data, body };
}

async function writePost(slug, data, body) {
  await mkdir(POSTS_DIR, { recursive: true });
  const text = stringifyFrontMatter(data) + "\n" +
    String(body).replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
  await writeFile(join(POSTS_DIR, slug + ".md"), text, "utf8");
}

/* 保存是"改文件 + 重新生成 + 提交"三件事，必须串行。
   两个标签页同时保存时，交错的 buildAll 会写出半新半旧的页面。 */
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

/* 自动提交只圈定后台真正会写的路径。
   用 git add -A 会把工作区里任何无关改动一起扫进来（比如别的工具留下的
   临时文件），提交历史就不再是"内容变动的记录"了。 */
const COMMIT_PATHS = ["blog", "index.html", "assets/img"];

/* 自动提交默认"生产开、开发关"。
   开发模式关掉是有原因的：本地写作服务如果在你的工作区里悄悄建 commit，
   等于把"改稿"和"提交"两件事混在一起，你还没看过 diff 就已经进历史了。
   生产模式相反 —— 那个环境没有别的提交者，自动提交才是安全的默认。
   想改：ADMIN_COMMIT=1 或 ADMIN_COMMIT=0。 */
const AUTOCOMMIT = process.env.ADMIN_COMMIT !== undefined
  ? process.env.ADMIN_COMMIT !== "0"
  : !DEV;

/* 返回的 committed 表示"真的产生了一个 commit"，不是"提交这一步没报错" ——
   界面要靠它判断历史有没有前进，这两件事必须分清。 */
async function gitCommit(message) {
  if (!AUTOCOMMIT) return { ok: true, committed: false, note: DEV ? "开发模式不自动提交" : "已关闭自动提交" };
  try {
    await execFileAsync("git", ["add", "--", ...COMMIT_PATHS], { cwd: ROOT });
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", ...COMMIT_PATHS], { cwd: ROOT });
    if (!stdout.trim()) return { ok: true, committed: false, note: "没有内容变更" };
    await execFileAsync("git", ["commit", "-m", message], { cwd: ROOT });
    return { ok: true, committed: true };
  } catch (e) {
    /* 提交失败不算保存失败：文件已经落盘、页面已经生成，站点是好的。
       但要如实告诉界面，否则用户以为历史前进了。 */
    const msg = String(e?.stderr || e?.message || e).trim().split("\n").slice(-2).join(" ");
    return { ok: false, committed: false, error: msg.slice(0, 300) };
  }
}

/* ------------------------------------------------------------------ 鉴权 */
function isAuthed(req) {
  if (DEV) return true;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return verifySession(token, SESSION_SECRET);
}

/* CSRF：SameSite=Lax 已经挡住跨站表单，这里再要求 Origin 与 Host 一致。
   Origin 是浏览器自己写的，脚本改不了；缺失 Origin 的写请求一律拒绝 ——
   正常浏览器发 POST / DELETE 一定带它。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers.host || "");
  return origin === `${proto}://${host}`;
}

/* 只有"body 是 JSON 对象"的接口才要求 application/json。
   logout / build 没有 body，upload 是原始二进制 —— 对它们一律要求 JSON
   会把正常请求也挡掉（logout 就这么被挡过一次）。 */
const JSON_BODY_ENDPOINTS = new Set(["/api/login", "/api/post"]);

function csrfOk(req, path) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  /* 必须有 Origin 且与本站一致。Origin 是浏览器自己写的，脚本改不了；
     跨站表单即使提交 multipart，Origin 也是攻击者的站点。 */
  if (!sameOrigin(req)) return false;
  /* 再对 JSON 接口要求 application/json：HTML 表单发不出这个类型，
     于是"用 <form> 打后台"这条最省事的 CSRF 通路被彻底关掉。 */
  if (req.method === "POST" && JSON_BODY_ENDPOINTS.has(path)) {
    return String(req.headers["content-type"] || "").includes("application/json");
  }
  return true;
}

function setSessionCookie(res, token) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${ADMIN_BASE || "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (!DEV) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=; Path=${ADMIN_BASE || "/"}; HttpOnly; SameSite=Lax; Max-Age=0${DEV ? "" : "; Secure"}`);
}

/* ------------------------------------------------------------------ 路由 */
const PUBLIC_API = new Set(["/api/health", "/api/login", "/api/logout"]);

/* 导出是为了让 server/admin.test.mjs 能拿到实际监听的端口：
   测试用 --port 0 起在随机端口上，跑完 close() 掉，不碰 4322。 */
export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST + ":" + PORT}`);
  const path = url.pathname;
  const ip = clientIp(req);

  try {
    /* 健康检查：给容器 healthcheck 用，不鉴权、不落日志。 */
    if (path === "/api/health") return json(res, 200, { ok: true, dev: DEV });

    /* 写请求先过 CSRF，连登录也不例外。 */
    if (!csrfOk(req, path)) {
      return json(res, 403, { error: "拒绝跨站请求（Origin 校验未通过）" });
    }

    /* -------------------------------------------------------------- 登录 */
    if (path === "/api/login" && req.method === "POST") {
      const gate = loginLimiter.check(ip);
      if (!gate.allowed) {
        return json(res, 429, { error: `尝试过于频繁，请 ${gate.retryAfter} 秒后再试` },
          { "Retry-After": String(gate.retryAfter) });
      }
      const payload = JSON.parse((await readBody(req, 4 * 1024)).toString("utf8"));
      const okUser = String(payload.user || "") === ADMIN_USER;
      const okPass = await verifyPassword(String(payload.password || ""), ADMIN_PASSWORD_HASH);

      /* 用户名错和口令错返回同一句话，不给探测用户名留下区分点。
         两者都要走一遍 scrypt 才返回，避免用响应时间侧信出用户名对不对。 */
      if (!okUser || !okPass) {
        loginLimiter.fail(ip);
        console.warn(`[auth] 登录失败 ip=${ip} user=${JSON.stringify(payload.user || "")}`);
        return json(res, 401, { error: "用户名或口令不对" });
      }

      loginLimiter.reset(ip);
      setSessionCookie(res, signSession(SESSION_TTL_MS, SESSION_SECRET));
      console.log(`[auth] 登录成功 ip=${ip} user=${ADMIN_USER}`);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/logout" && req.method === "POST") {
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    /* -------------------------------------------------------------- 鉴权闸 */
    const authed = isAuthed(req);
    const isApi = path.startsWith("/api/");
    const isAsset = path.startsWith("/assets/");
    const isLoginPage = path === "/login" || path === "/login.html";

    if (!authed && !isAsset && !isLoginPage && !PUBLIC_API.has(path)) {
      if (isApi) return json(res, 401, { error: "未登录" });
      /* 相对跳转对两种模式都对：开发在 /login，生产在 /admin/login。 */
      return send(res, 302, "", null, { Location: `${ADMIN_BASE}/login` });
    }

    /* 已经登录就不用再看登录页 */
    if (isLoginPage) {
      if (authed) return send(res, 302, "", null, { Location: `${ADMIN_BASE}/` });
      return serveFile(res, join(WEB_DIR, "login.html"));
    }

    /* -------------------------------------------------------------- 会话信息 */
    if (path === "/api/session") {
      return json(res, 200, { authed, dev: DEV, adminBase: ADMIN_BASE, user: DEV ? "(开发模式)" : ADMIN_USER });
    }

    /* -------------------------------------------------------------- 文章 CRUD */
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

    if (path === "/api/post" && req.method === "GET") {
      const slug = safeSlug(url.searchParams.get("slug"));
      if (!slug) return json(res, 400, { error: "文件名不合法" });
      if (!existsSync(join(POSTS_DIR, slug + ".md"))) {
        return json(res, 404, { error: "找不到 " + slug + ".md" });
      }
      return json(res, 200, await readPost(slug));
    }

    if (path === "/api/post" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const slug = safeSlug(payload.slug);
      if (!slug) return json(res, 400, { error: "文件名只能用 a-z、0-9 和连字符" });

      const data = { ...payload.data, slug };
      if (!String(data.title || "").trim()) return json(res, 400, { error: "标题不能为空" });
      if (data.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
        return json(res, 400, { error: "日期要写成 YYYY-MM-DD" });
      }

      const body = String(payload.body ?? "");
      /* mdToHtml 不会对"语法错"报错（Markdown 本来就宽容），所以这里不是
         语法校验，而是拦住转换器自身崩掉的情况 —— 让磁盘别留下一个
         能写进去、却再也渲染不出来的源文件。 */
      try {
        mdToHtml(body);
      } catch (e) {
        return json(res, 400, { error: "正文转换失败：" + String(e?.message || e) });
      }

      const out = await serialize(async () => {
        const original = safeSlug(payload.original);
        if (original && original !== slug) {
          const old = join(POSTS_DIR, original + ".md");
          if (existsSync(old)) await unlink(old);
        }
        await writePost(slug, data, body);
        const { written, removed } = buildAll();
        const commit = await gitCommit(`content: ${slug}`);
        return { written, removed, commit };
      });

      const rel = (p) => p.replace(ROOT, "").replace(/\\/g, "/");
      return json(res, 200, {
        slug,
        built: out.written.map(rel),
        removed: out.removed.map(rel),
        committed: out.commit.committed,
        commitNote: out.commit.note || out.commit.error || "",
      });
    }

    /* 删除只删 Markdown 源，页面交给 buildAll 的孤儿清理一起收走 ——
       "源和产物"永远由同一处维护，不会出现删了源、页面还挂着的半截状态。 */
    if (path === "/api/post" && req.method === "DELETE") {
      const slug = safeSlug(url.searchParams.get("slug"));
      if (!slug) return json(res, 400, { error: "文件名不合法" });
      const target = join(POSTS_DIR, slug + ".md");
      if (!existsSync(target)) return json(res, 404, { error: "找不到 " + slug + ".md" });

      const out = await serialize(async () => {
        await unlink(target);
        const { written, removed } = buildAll();
        const commit = await gitCommit(`content: 删除 ${slug}`);
        return { written, removed, commit };
      });

      const rel = (p) => p.replace(ROOT, "").replace(/\\/g, "/");
      return json(res, 200, {
        slug,
        removed: out.removed.map(rel),
        built: out.written.map(rel),
        committed: out.commit.committed,
        commitNote: out.commit.note || out.commit.error || "",
      });
    }

    if (path === "/api/build" && req.method === "POST") {
      const out = await serialize(async () => buildAll());
      const rel = (p) => p.replace(ROOT, "").replace(/\\/g, "/");
      return json(res, 200, { written: out.written.map(rel), removed: out.removed.map(rel) });
    }

    if (path === "/api/upload" && req.method === "POST") {
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: "空文件" });

      /* 按文件头认类型，不信 Content-Type —— 那个头客户端说了算。
         heic 认得出来但浏览器显示不了，也一并拒掉。 */
      const ext = sniffImage(buf);
      const ALLOWED = new Set([".png", ".jpg", ".gif", ".webp", ".avif", ".svg"]);
      if (!ext || !ALLOWED.has(ext)) {
        return json(res, 415, { error: "只接受图片（png / jpg / gif / webp / avif / svg）" });
      }

      await mkdir(IMG_DIR, { recursive: true });
      const name = safeImageName(url.searchParams.get("name"), ext, buf);
      await writeFile(join(IMG_DIR, name), buf);
      return json(res, 200, { path: "../assets/img/" + name, bytes: buf.length });
    }

    /* --------------------------------------------------------- 开发模式预览 */
    if (DEV && req.method === "GET" && (path === "/site" || path.startsWith("/site/"))) {
      const rel = decodeURIComponent(path.slice("/site".length)) || "/index.html";
      if (rel.includes("\0")) return send(res, 404, "404", "text/plain; charset=utf-8");
      let abs = resolve(ROOT, "." + (rel.startsWith("/") ? rel : "/" + rel));
      /* 连开发模式也不放 .git 出去：这个口子一旦被习惯性带进生产就是灾难。 */
      if (!within(ROOT, abs) || within(GIT_DIR, abs)) {
        return send(res, 404, "404", "text/plain; charset=utf-8");
      }
      try {
        if (existsSync(abs) && (await stat(abs)).isDirectory()) abs = join(abs, "index.html");
      } catch { /* 下面按不存在处理 */ }
      if (!existsSync(abs)) return send(res, 404, "404", "text/plain; charset=utf-8");
      return send(res, 200, await readFile(abs), MIME[extname(abs).toLowerCase()] || "application/octet-stream");
    }

    /* ------------------------------------------------------------ 静态资源 */
    if (req.method === "GET" || req.method === "HEAD") {
      const abs = resolveStatic(path);
      if (abs) return serveFile(res, abs);
    }

    return send(res, 404, "404", "text/plain; charset=utf-8");
  } catch (e) {
    const msg = String(e?.message || e);
    console.error(`[err] ${req.method} ${path} -> ${msg}`);
    /* 响应头可能已经发出去了（比如读文件读到一半失败），这时再写头会抛，
       把真正的错误盖掉。 */
    if (res.headersSent) return res.end();
    return json(res, 500, { error: msg });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`写作后台已启动（${DEV ? "开发模式：不鉴权，仅回环可访问" : "生产模式：需要登录"}）`);
  console.log(`  · 地址：http://${HOST}:${PORT}${ADMIN_BASE}/`);
  console.log(`  · 随笔源文件：blog/posts/*.md    图片：assets/img/`);
  console.log(`  · 保存时重新生成页面；自动提交：${AUTOCOMMIT ? "开" : "关"}`);
  if (DEV) console.log(`  · 站点预览：http://${HOST}:${PORT}/site/index.html`);
  else console.log(`  · 只能经反向代理访问，不要把这个端口发布到公网`);
  console.log("  按 Ctrl+C 停止");
});

/* 请求体过大之类的错误不该让进程挂掉 */
server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
