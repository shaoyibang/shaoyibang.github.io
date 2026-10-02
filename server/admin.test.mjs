/* =========================================================================
   admin.test.mjs — 写作后台的单元与路由测试

   跑法：node server/admin.test.mjs
   （也是 tools/check.mjs、CI 之外唯一需要真起一个服务的测试）

   两段：
     1. auth.mjs / paths.mjs 的纯单元测试 —— 口令、会话签名、限流、
        真实 IP、图片文件头识别、路径穿越。后台一旦上公网，这些就是
        全部的边界，所以它们值得逐条钉死。
     2. 起一个开发模式的实例（随机端口）打真实 HTTP —— 路由、CSRF、
        入参校验、上传、以及"保存→生成→删除"的完整往返。
        往返测试会把首页和列表页动一遍，所以它自己负责比对还原。

   全程不碰 4322，也不产生 git 提交（开发模式默认不自动提交）。
   ========================================================================= */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hashPassword, verifyPassword, signSession, verifySession,
  RateLimiter, clientIp,
} from "./auth.mjs";
import { within, safeSlug, safeImageName, sniffImage, makeStaticResolver } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const results = [];
let failed = 0;

async function t(name, fn) {
  try {
    await fn();
    results.push("PASS  " + name);
  } catch (e) {
    failed++;
    results.push("FAIL  " + name + "  [" + (e?.message || e) + "]");
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label ? label + "：" : ""}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const SECRET = "a".repeat(48);

/* ============================================================ 1. 单元测试 */

await t("口令：正确的通过，错的拒绝", async () => {
  const h = await hashPassword("correct-horse-battery-staple");
  assert(h.startsWith("scrypt$32768$8$1$"), "哈希格式不对：" + h.slice(0, 24));
  eq(await verifyPassword("correct-horse-battery-staple", h), true, "正确口令");
  eq(await verifyPassword("wrong", h), false, "错误口令");
  eq(await verifyPassword("", h), false, "空口令");
});

await t("口令：同一口令两次哈希结果不同（盐是随机的）", async () => {
  const a = await hashPassword("same-password-1234");
  const b = await hashPassword("same-password-1234");
  assert(a !== b, "两次哈希完全相同 —— 盐没有随机化");
  eq(await verifyPassword("same-password-1234", a), true);
  eq(await verifyPassword("same-password-1234", b), true);
});

await t("口令：损坏或伪造的存储值一律拒绝，且不抛异常", async () => {
  const bad = ["", "x", "scrypt$1$2$3", "scrypt$32768$8$1$zz$zz", "bcrypt$1$2$3$4$5",
    "scrypt$0$0$0$00$00", "scrypt$32768$8$1$" + "00".repeat(32) + "$" + "00".repeat(64)];
  for (const b of bad) {
    eq(await verifyPassword("whatever", b), false, JSON.stringify(b.slice(0, 28)));
  }
});

const token = signSession(60_000, SECRET);

await t("会话：自己签发的令牌能验过", () => {
  eq(verifySession(token, SECRET), true);
  eq(token.split(".").length, 4, "令牌结构");
  eq(token.startsWith("v1."), true, "版本前缀");
});

await t("会话：换一个密钥就失效", () => {
  eq(verifySession(token, "b".repeat(48)), false);
});

await t("会话：过期令牌不通过", () => {
  eq(verifySession(signSession(-1000, SECRET), SECRET), false, "已过期");
  eq(verifySession(signSession(1, SECRET), SECRET), true, "还有 1ms 有效期");
});

await t("会话：改签名、改过期时间都不通过", () => {
  const p = token.split(".");
  const forged = [p[0], p[1], p[2], Buffer.from("forged-signature").toString("base64url")].join(".");
  eq(verifySession(forged, SECRET), false, "换掉签名");
  const extended = [p[0], String(Date.now() + 9e12), p[2], p[3]].join(".");
  eq(verifySession(extended, SECRET), false, "把过期时间往后改");
});

await t("会话：垃圾输入不通过", () => {
  for (const bad of ["", "x", "v1", "v1.1.2", "v2.999.abc.sig", null, undefined, "v1.abc.def.ghi"]) {
    eq(verifySession(bad, SECRET), false, String(bad));
  }
});

await t("限流：到上限就拒绝，reset 后恢复，别的 IP 不受影响", () => {
  const rl = new RateLimiter({ max: 3, windowMs: 60_000 });
  const ip = "1.2.3.4";
  eq(rl.check(ip).allowed, true, "还没失败过");
  rl.fail(ip); rl.fail(ip); rl.fail(ip);
  const g = rl.check(ip);
  eq(g.allowed, false, "三次失败后应被拒");
  assert(g.retryAfter > 0, "应给出 retryAfter");
  eq(rl.check("9.9.9.9").allowed, true, "另一个 IP");
  rl.reset(ip);
  eq(rl.check(ip).allowed, true, "reset 之后");
});

await t("限流：窗口过去后自动放行", () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 });
  const now = 1_000_000;
  rl.fail("5.5.5.5", now);
  eq(rl.check("5.5.5.5", now + 10).allowed, false, "窗口内");
  eq(rl.check("5.5.5.5", now + 2000).allowed, true, "窗口外");
});

/* 这条是限流能不能信的前提：客户端可以随便伪造 X-Forwarded-For，
   只有反向代理追加在末尾的那一段才是真实对端。 */
await t("真实 IP：只认 X-Forwarded-For 的最后一段", () => {
  eq(clientIp({ headers: { "x-forwarded-for": "1.1.1.1" }, socket: {} }), "1.1.1.1");
  eq(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 7.7.7.7, 8.8.8.8" }, socket: {} }), "8.8.8.8",
    "伪造的前缀不能影响结果");
  eq(clientIp({ headers: { "x-forwarded-for": "  1.1.1.1 ,  2.2.2.2  " }, socket: {} }), "2.2.2.2", "带空格");
  eq(clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1", "没有 XFF 时退回 socket");
});

await t("slug：挡住目录穿越与非法字符", () => {
  eq(safeSlug("my-post"), "my-post");
  eq(safeSlug("My-Post"), "my-post", "统一转小写");
  eq(safeSlug("  my-post  "), "my-post", "去首尾空白");
  for (const bad of ["../etc/passwd", "..", "a/b", "a\\b", "", "-lead", "中文", "a b", "a.md", "a".repeat(65), null, undefined]) {
    eq(safeSlug(bad), null, JSON.stringify(bad));
  }
  eq(safeSlug("a".repeat(64)), "a".repeat(64), "64 位刚好合法");
});

await t("within：同名前缀的兄弟目录不算在内", () => {
  const root = join(ROOT, "assets");
  eq(within(root, join(root, "css", "site.css")), true, "子文件");
  eq(within(root, root), true, "自己");
  eq(within(root, join(ROOT, "assets-evil", "x")), false, "assets-evil 不是 assets 的子目录");
  eq(within(root, join(ROOT, "index.html")), false);
  eq(within(root, resolve(root, "..", "index.html")), false, "上跳一层");
});

await t("静态解析：任何输入都出不了允许目录", () => {
  const res = makeStaticResolver({
    webDir: join(ROOT, "server", "web"),
    assetsDir: join(ROOT, "assets"),
    extra: { "/md.mjs": join(ROOT, "tools", "md.mjs") },
  });
  const allowed = [join(ROOT, "server", "web"), join(ROOT, "assets"), join(ROOT, "tools")];

  assert(res("/")?.endsWith("index.html"), "/ 应落到 index.html");
  assert(res("/login")?.endsWith("login.html"), "/login 应落到 login.html");
  assert(res("/md.mjs")?.endsWith("md.mjs"), "共用模块应被映射");
  assert(res("/assets/css/site.css")?.endsWith("site.css"), "资源应能取到");
  assert(res("/assets/fonts/fonts.css")?.endsWith("fonts.css"), "字体 CSS 应能取到");

  const hostile = [
    "/assets/../../etc/passwd",
    "/assets/%2e%2e/%2e%2e/etc/passwd",
    "/assets/..%2f..%2fetc/passwd",
    "/../README.md",
    "/....//....//etc/passwd",
    "/assets/....//....//index.html",
    "/site/.git/config",
    "/tools/build.mjs",
  ];
  for (const p of hostile) {
    const r = res(p);
    if (r === null) continue;
    assert(allowed.some((a) => within(a, r)), `${p} 解析到了允许目录之外：${r}`);
  }
});

await t("图片类型：按文件头判断，伪装无效", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  eq(sniffImage(png), ".png");
  eq(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])), ".jpg");
  eq(sniffImage(Buffer.from("GIF89a................")), ".gif");
  eq(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), ".webp");
  eq(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), ".svg", "开头就是 svg");
  eq(sniffImage(Buffer.from("\uFEFF\n  <svg viewBox='0 0 1 1'></svg>")), ".svg", "带 BOM 与空白");

  eq(sniffImage(Buffer.from("这不只是一段文本，长度肯定超过十二个字节了")), null, "纯文本");
  eq(sniffImage(Buffer.from("<?php system($_GET['c']); ?> 长度足够超过十二字节")), null, "伪装成图片的脚本");
  eq(sniffImage(Buffer.alloc(4)), null, "太短");
  eq(sniffImage(Buffer.alloc(0)), null, "空");
});

await t("图片文件名：去中文、带内容哈希、同图同名", () => {
  const buf = Buffer.from([1, 2, 3, 4, 5]);
  const a = safeImageName("我的 图片.PNG", ".webp", buf);
  assert(/^[a-z0-9-]+-[0-9a-f]{8}\.webp$/.test(a), "格式不对：" + a);
  eq(a, safeImageName("我的 图片.PNG", ".webp", buf), "同内容应同名");
  assert(safeImageName("x.png", ".webp", Buffer.from([9, 9])) !== a, "不同内容应不同名");
  assert(!/[\u4e00-\u9fa5]/.test(a), "不应残留中文");
  eq(safeImageName("", ".png", buf).endsWith(".png"), true, "没有名字时也要能用");
});

/* ============================================================ 2. 路由测试 */

/* 临时文章的 slug 放在 try 外面：finally 里的清理也要用它。
   用 zz- 前缀是为了万一没清干净，一眼能看出是测试留下的。 */
const TEMP = "zz-roundtrip-test";
const tempMd = join(ROOT, "blog", "posts", TEMP + ".md");
const tempHtml = join(ROOT, "blog", TEMP + ".html");

process.argv = [process.argv[0], process.argv[1], "--dev", "--port", "0"];
const { server } = await import("./admin.mjs");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const get = (p) => fetch(BASE + p);
const jsonPost = (p, payload, extra = {}) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, ...extra },
    body: JSON.stringify(payload),
  });

try {
  await t("健康检查免鉴权", async () => {
    const r = await get("/api/health");
    eq(r.status, 200);
    eq((await r.json()).ok, true);
  });

  await t("静态资源可取，且响应带 no-store", async () => {
    const r = await get("/assets/fonts/fonts.css");
    eq(r.status, 200);
    assert(String(r.headers.get("content-type")).includes("text/css"), "content-type 不对");
    eq(r.headers.get("cache-control"), "no-store", "后台响应必须 no-store");
  });

  await t("仓库源码不可经后台读到", async () => {
    for (const p of ["/server/admin.mjs", "/server/auth.mjs", "/tools/build.mjs",
      "/.git/config", "/blog/posts/untitled-2026-09-29.md", "/deploy/.env", "/README.md"]) {
      eq((await get(p)).status, 404, p);
    }
  });

  await t("开发模式的 /site/ 预览可用，但不放 .git 出去", async () => {
    eq((await get("/site/.git/config")).status, 404, ".git 必须挡住");
    eq((await get("/site/server/admin.mjs")).status, 200, "普通文件应能预览");
  });

  await t("写请求没有 Origin 一律拒绝", async () => {
    const r = await fetch(BASE + "/api/post", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    eq(r.status, 403);
  });

  await t("写请求 Origin 不是本站也拒绝", async () => {
    const r = await fetch(BASE + "/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    eq(r.status, 403);
  });

  await t("JSON 接口拒收表单提交（Content-Type 必须是 JSON）", async () => {
    const r = await fetch(BASE + "/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
      body: "slug=x",
    });
    eq(r.status, 403);
  });

  await t("会话信息里带着挂载前缀与模式", async () => {
    const s = await (await get("/api/session")).json();
    eq(s.dev, true, "测试跑在开发模式");
    eq(s.adminBase, "", "开发模式挂在根上");
  });

  await t("保存入参校验：非法 slug / 空标题 / 坏日期都被拒", async () => {
    eq((await jsonPost("/api/post", { slug: "../evil", data: { title: "x" }, body: "" })).status, 400, "穿越型 slug");
    eq((await jsonPost("/api/post", { slug: "ok-slug", data: { title: "   " }, body: "" })).status, 400, "空标题");
    eq((await jsonPost("/api/post", { slug: "ok-slug", data: { title: "x", date: "2026/01/01" }, body: "" })).status, 400, "斜杠日期");
  });

  await t("删除不存在的文章返回 404，不产生副作用", async () => {
    const r = await fetch(BASE + "/api/post?slug=no-such-post-zz", { method: "DELETE", headers: { Origin: BASE } });
    eq(r.status, 404);
  });

  await t("上传：伪装成 image/png 的文本被拒（按文件头判断）", async () => {
    const r = await fetch(BASE + "/api/upload?name=x.png", {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: BASE },
      body: Buffer.from("我声明自己是 PNG，但其实只是一段文本，长度足够超过十二字节"),
    });
    eq(r.status, 415);
  });

  await t("上传：真 PNG 落盘，返回的路径能直接写进 Markdown", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const r = await fetch(BASE + "/api/upload?name=zz-test.png", {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: BASE },
      body: png,
    });
    eq(r.status, 200);
    const { path } = await r.json();
    assert(path.startsWith("../assets/img/"), "路径不对：" + path);
    const abs = join(ROOT, path.replace("../", ""));
    assert(existsSync(abs), "文件应已落盘：" + abs);
    unlinkSync(abs);   // 清理：不把测试图留在仓库里
  });

  /* ---- 完整往返：保存 → 生成 → 删除，最后必须回到原样 ---- */
  const SNAP = ["index.html", "blog/index.html"];
  const before = new Map(SNAP.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

  await t("往返：保存会写源文件、生成页面，并且开发模式不自动提交", async () => {
    const r = await jsonPost("/api/post", {
      slug: TEMP,
      original: null,
      data: { title: "往返测试", date: "2026-01-01", summary: "摘要", lede: "导语", cats: "测试", slug: TEMP },
      body: "## 小标题\n\n正文一段。\n\n- 列表项\n",
    });
    eq(r.status, 200);
    const info = await r.json();
    assert(existsSync(tempMd), "源文件应存在");
    assert(existsSync(tempHtml), "页面应已生成");
    eq(info.committed, false, "开发模式不应自动提交");
    assert(String(info.commitNote).includes("开发模式"), "应说明为何没提交：" + info.commitNote);

    const listed = await (await get("/api/posts")).json();
    assert(listed.posts.some((p) => p.slug === TEMP), "新文章应出现在列表接口里");
    assert(readFileSync(join(ROOT, "index.html"), "utf8").includes(TEMP + ".html"), "首页应链到新文章");
  });

  await t("往返：删除会连源文件、页面、首页链接一起收走", async () => {
    const r = await fetch(BASE + "/api/post?slug=" + TEMP, { method: "DELETE", headers: { Origin: BASE } });
    eq(r.status, 200);
    assert(!existsSync(tempMd), "源文件应被删除");
    assert(!existsSync(tempHtml), "孤儿页面应被收走");
    assert(!readFileSync(join(ROOT, "index.html"), "utf8").includes(TEMP + ".html"), "首页不该还链着它");
  });

  await t("往返之后，首页与列表页与测试前逐字节一致", async () => {
    for (const [f, text] of before) {
      eq(readFileSync(join(ROOT, f), "utf8"), text, f);
    }
  });
} finally {
  /* 测试中途失败也不能把临时文章留在仓库里。删完还要重新生成一次，
     否则首页会留着一条指向已被删掉的页面的链接。 */
  let dirty = false;
  for (const f of [tempMd, tempHtml]) {
    if (existsSync(f)) { unlinkSync(f); dirty = true; }
  }
  if (dirty) {
    const { buildAll } = await import("../tools/build.mjs");
    buildAll();
  }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
