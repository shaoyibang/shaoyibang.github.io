/* =========================================================================
   login.test.mjs — 生产模式的鉴权流程测试

   为什么要单独一个文件：同一个进程里只能加载一次 server/admin.mjs，
   而开发模式和生产模式是互斥的两个配置。所以这个文件自己起一个
   生产模式实例（随机端口、临时密钥），开发模式的测试在 admin.test.mjs。

   这里验的是"这个后台敢不敢放上公网"这件事本身：
     · 缺配置时拒绝启动，而不是降级成不鉴权
     · 未登录：页面 302 到登录页，接口 401
     · 口令错 → 401，连错 5 次 → 429 锁住，且只锁这一个 IP
     · 登录成功后 cookie 带 HttpOnly / Secure / SameSite / Path=/admin
     · 生产模式下 /site/ 预览必须是关的（它会把 .git 和文章源文件公开）
   ========================================================================= */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, newSecret } from "./auth.mjs";

const execFileAsync = promisify(execFile);
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
    /* fetch 的报错常常只有一句 "fetch failed"，真正的原因在 cause 里 */
    const cause = e?.cause ? " → " + (e.cause.code || e.cause.message) : "";
    results.push("FAIL  " + name + "  [" + (e?.message || e) + cause + "]");
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

/* ------------------------------------------------ 1. 缺配置时拒绝启动 */
await t("生产模式缺凭据时拒绝启动，并说清缺了什么", async () => {
  const env = { ...process.env };
  delete env.ADMIN_USER;
  delete env.ADMIN_PASSWORD_HASH;
  delete env.SESSION_SECRET;

  let code = 0;
  let stderr = "";
  try {
    await execFileAsync(process.execPath, ["server/admin.mjs"], { cwd: ROOT, env, timeout: 20000 });
  } catch (e) {
    code = e.code;
    stderr = String(e.stderr || "");
  }
  eq(code, 1, "退出码");
  for (const key of ["ADMIN_USER", "ADMIN_PASSWORD_HASH", "SESSION_SECRET"]) {
    assert(stderr.includes(key), `错误信息里应点名 ${key}，实际：${stderr.trim()}`);
  }
});

/* ---------------------------------------------------- 2. 起一个生产实例 */
const PASSWORD = "test-password-9f3a2b";
const USER = "tester";
process.env.ADMIN_USER = USER;
process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSWORD);
process.env.SESSION_SECRET = newSecret();
process.env.ADMIN_BASE = "/admin";
process.env.HOST = "127.0.0.1";
process.argv = [process.argv[0], process.argv[1], "--port", "0"];   // 注意：不传 --dev

const { server } = await import("./admin.mjs");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* 用不同的 X-Forwarded-For 模拟不同来源 IP。
   顺带证明限流确实是按"最后一段"这个真实对端来分的。

   redirect 一律 manual：这个套件验的就是"服务端回什么"，让 fetch 自动
   跟着跳转会把 302 吃掉，看到的是跳过去之后的 404。 */
const as = (ip) => ({ "X-Forwarded-For": ip });
const req = (p, init = {}) => fetch(BASE + p, {
  redirect: "manual",
  ...init,
  headers: { ...(init.headers || {}), ...as(init.ip || "203.0.113.1") },
});

try {
  await t("未登录：页面跳登录页，接口返回 401", async () => {
    const page = await req("/");
    eq(page.status, 302, "首页");
    eq(page.headers.get("location"), "/admin/login", "跳转目标");

    const api = await req("/api/posts");
    eq(api.status, 401, "接口");

    const css = await req("/assets/fonts/fonts.css");
    eq(css.status, 200, "静态资源不该被鉴权挡住（登录页要用字体）");
  });

  await t("登录页可访问，且带 noindex", async () => {
    const r = await req("/login");
    eq(r.status, 200);
    const html = await r.text();
    assert(html.includes("写作后台"), "登录页内容");
    assert(/name="robots" content="noindex/.test(html), "登录页应 noindex");
  });

  await t("未登录时 /site/ 什么都不给（不是 200 就行）", async () => {
    for (const p of ["/site/index.html", "/site/.git/config", "/site/blog/posts/untitled-2026-09-29.md"]) {
      const r = await req(p);
      assert([302, 404].includes(r.status), `${p} 返回了 ${r.status}`);
    }
  });

  await t("口令错返回 401，且不区分用户名不存在与口令不对", async () => {
    const mk = (payload, ip) => req("/api/login", {
      method: "POST",
      ip,
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify(payload),
    });
    const wrongPw = await mk({ user: USER, password: "nope-nope-nope" }, "203.0.113.2");
    eq(wrongPw.status, 401);
    const noUser = await mk({ user: "ghost", password: "nope-nope-nope" }, "203.0.113.4");
    eq(noUser.status, 401, "用户名不存在");
    eq((await wrongPw.json()).error, (await noUser.json()).error, "两种失败的提示文字必须一致");
  });

  await t("连错 5 次后被限流，且限流只针对这个 IP", async () => {
    const login = (payload, ip) => req("/api/login", {
      method: "POST",
      ip,
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify(payload),
    });
    const bad = { user: USER, password: "still-wrong" };

    /* 上面那条已经用 203.0.113.2 失败过一次，再补四次就正好 5 次 */
    for (let i = 0; i < 4; i++) eq((await login(bad, "203.0.113.2")).status, 401, `第 ${i + 2} 次`);

    const blocked = await login({ user: USER, password: PASSWORD }, "203.0.113.2");
    eq(blocked.status, 429, "锁住之后连正确口令也不放行");
    assert(Number(blocked.headers.get("retry-after")) > 0, "应带 Retry-After");

    const other = await login({ user: USER, password: PASSWORD }, "203.0.113.3");
    eq(other.status, 200, "另一个 IP 不受影响");
  });

  let cookie = "";
  await t("登录成功：cookie 属性齐备", async () => {
    const r = await req("/api/login", {
      method: "POST",
      ip: "203.0.113.5",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ user: USER, password: PASSWORD }),
    });
    eq(r.status, 200);
    const raw = r.headers.get("set-cookie") || "";
    cookie = raw.split(";")[0];
    assert(cookie.startsWith("sean_admin="), "cookie 名：" + raw);
    assert(/HttpOnly/i.test(raw), "缺 HttpOnly");
    assert(/Secure/i.test(raw), "缺 Secure");
    assert(/SameSite=Lax/i.test(raw), "缺 SameSite");
    assert(/Path=\/admin/i.test(raw), "Path 应为 /admin，实际：" + raw);
  });

  await t("带会话：页面与接口都放行", async () => {
    const h = { Cookie: cookie };
    eq((await req("/", { headers: h })).status, 200, "首页");
    eq((await req("/api/posts", { headers: h })).status, 200, "接口");
    const s = await (await req("/api/session", { headers: h })).json();
    eq(s.authed, true);
    eq(s.dev, false, "这是生产模式");
    eq(s.adminBase, "/admin");
    eq(s.user, USER);
  });

  await t("带会话访问登录页会跳回后台", async () => {
    const r = await req("/login", { headers: { Cookie: cookie } });
    eq(r.status, 302);
    eq(r.headers.get("location"), "/admin/");
  });

  /* 这一条是安全项：/site/ 会把整个仓库（含 .git 和文章源文件）挂在
     /admin/site/ 下，而反代恰好会把 /admin 剥掉 —— 生产模式必须整个关掉它。 */
  await t("生产模式下 /site/ 预览是关的，连登录了也读不到 .git", async () => {
    const h = { Cookie: cookie };
    for (const p of ["/site/index.html", "/site/.git/config", "/site/blog/posts/untitled-2026-09-29.md",
      "/site/deploy/.env", "/site/server/admin.mjs"]) {
      eq((await req(p, { headers: h })).status, 404, p);
    }
  });

  await t("伪造的会话 cookie 不认", async () => {
    const forged = "sean_admin=v1." + (Date.now() + 9e12) + ".abc.forged";
    eq((await req("/api/posts", { headers: { Cookie: forged } })).status, 401);
    eq((await req("/api/posts", { headers: { Cookie: "sean_admin=" } })).status, 401);
  });

  await t("退出会清掉 cookie", async () => {
    const r = await req("/api/logout", {
      method: "POST",
      headers: { Origin: BASE, Cookie: cookie },
    });
    eq(r.status, 200);
    const raw = r.headers.get("set-cookie") || "";
    assert(/Max-Age=0/.test(raw), "应把 Max-Age 置零：" + raw);
  });

  await t("生产模式下的写请求同样要求 Origin", async () => {
    const r = await fetch(BASE + "/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...as("203.0.113.6") },
      body: "{}",
    });
    eq(r.status, 403);
  });
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
