/* =========================================================================
   stack.test.mjs — 把整条链路真跑一遍：Caddy 反代 → 生产模式后台

   需要 caddy 可执行文件（读 CADDY_BIN，或 PATH 里的 caddy）：

     CADDY_BIN=/path/to/caddy node deploy/stack.test.mjs

   为什么不直接用 docker compose 起：
     本机不一定有容器守护进程，而且起容器会动到别人的 Docker Desktop。
     但这里要验的东西里，绝大部分其实**不依赖容器**：

       · handle_path 剥掉 /admin 前缀之后，后台的路由还对不对
       · 剥前缀之后 cookie 的 Path=/admin 还正不正确（前端在浏览器里的位置
         是 /admin/，不是 /）
       · 经反代之后 Origin 校验过不过 —— 后台是拿 X-Forwarded-Proto + Host
         拼出自己的 origin 再跟请求头比的；反代一旦改写 Host，登录就会 403
       · 未登录时页面 302、接口 401，两种响应在同一套路由下分得开
       · 登录 → 上传图片 → 新建文章 → 线上立即可见 → 删掉 → 文件恢复原样
       · 自动提交在容器里能不能成 —— 这条恰恰是 compose 里那几个
         GIT_AUTHOR_* 环境变量在管，缺了它 commit 会直接失败

     上面这些用"真 Caddy + 真 Node"就能全覆盖。**唯一没覆盖的是容器那一层**：
     bind mount、user: uid 映射、healthcheck、镜像能不能拉下来。那几条在
     deploy/README.md 的验收清单里留着手工步骤。

   全程在一个临时副本里跑，不碰你的工作仓库；副本自带一个 git 仓库，
   所以自动提交是真提交、能查作者。
   ========================================================================= */
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, newSecret } from "../server/auth.mjs";

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
    const cause = e?.cause ? " → " + (e.cause.code || e.cause.message) : "";
    results.push("FAIL  " + name + "  [" + (e?.message || e) + cause + "]");
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "断言失败"); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label ? label + "：" : ""}期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

/* ------------------------------------------------------------- 找 caddy */
function findCaddy() {
  if (process.env.CADDY_BIN) return process.env.CADDY_BIN;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, ["caddy"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}
const CADDY = findCaddy();
if (!CADDY) {
  console.error("没找到 caddy。用 CADDY_BIN 指过去：");
  console.error("  CADDY_BIN=/path/to/caddy node deploy/stack.test.mjs");
  process.exit(2);
}

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------- 在临时副本里造一个真仓库 */
const TMP = mkdtempSync(join(tmpdir(), "stack-test-"));
const SITE = join(TMP, "site");
const LOG = join(TMP, "access.log");

cpSync(ROOT, SITE, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(ROOT.length).replace(/^[\\/]/, "");
    if (!rel) return true;
    const top = rel.split(/[\\/]/)[0];
    if (top === ".git" || top === "node_modules") return false;
    /* 别把真实凭据带进测试副本；测试自己造一套 */
    if (rel.replace(/\\/g, "/") === "deploy/.env") return false;
    return true;
  },
});

const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: SITE, encoding: "utf8", ...opts });

git(["init", "-q"]);
git(["config", "user.name", "baseline"]);
git(["config", "user.email", "baseline@example.invalid"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "baseline"]);

const BEFORE_INDEX = readFileSync(join(SITE, "index.html"), "utf8");
const BEFORE_LOG = git(["log", "--oneline"]).trim().split("\n").length;

/* ------------------------------------------------------------ 起后台 */
const ADMIN_PORT = await freePort();
const CADDY_PORT = await freePort();
const PUBLIC = `http://127.0.0.1:${CADDY_PORT}`;

const USER = "stack-tester";
const PASSWORD = "stack-test-password-7c1f";
const AUTHOR_NAME = "stack-test-bot";
const AUTHOR_EMAIL = "stack-test@example.invalid";

/* 这一组环境变量就是 docker-compose.yml 里给 admin 容器的那一套 */
const ADMIN_ENV = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(ADMIN_PORT),
  ADMIN_BASE: "/admin",
  ADMIN_USER: USER,
  ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
  SESSION_SECRET: newSecret(),
  SESSION_TTL_HOURS: "168",
  ADMIN_COMMIT: "1",
  TZ: "Asia/Shanghai",
  HOME: TMP,
  GIT_AUTHOR_NAME: AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: AUTHOR_NAME,
  GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: SITE,
};

const admin = spawn(process.execPath, ["server/admin.mjs"], {
  cwd: SITE, env: ADMIN_ENV, stdio: ["ignore", "pipe", "pipe"],
});
let adminOut = "";
admin.stdout.on("data", (d) => { adminOut += d.toString(); });
admin.stderr.on("data", (d) => { adminOut += d.toString(); });

/* ------------------------------------------------------- 起真 Caddy */
/* 只改跟"本机没有 Docker"有关的三处：站点地址、根目录、上游地址。
   其余一个字不动，所以验的就是那份要部署的 Caddyfile。 */
const derived = readFileSync(join(HERE, "Caddyfile"), "utf8")
  .replace(/\{\$SITE_DOMAIN\}/, PUBLIC)
  .replace(/^(\s*)root \* \/srv\/site$/m, `$1root * ${SITE.replace(/\\/g, "/")}`)
  .replace(/reverse_proxy admin:4322/, `reverse_proxy 127.0.0.1:${ADMIN_PORT}`)
  .replace(/\/var\/log\/caddy\/access\.log/g, LOG.replace(/\\/g, "/"))
  .replace(/\{\n\temail /, "{\n\tadmin off\n\temail ");
const CFG = join(TMP, "Caddyfile");
assert(derived.includes(PUBLIC) && derived.includes(`reverse_proxy 127.0.0.1:${ADMIN_PORT}`), "Caddyfile 改写没生效");
writeFileSync(CFG, derived, "utf8");

const caddy = spawn(CADDY, ["run", "--config", CFG, "--adapter", "caddyfile"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ACME_EMAIL: "you@example.com" },
});
let caddyOut = "";
caddy.stdout.on("data", (d) => { caddyOut += d.toString(); });
caddy.stderr.on("data", (d) => { caddyOut += d.toString(); });

const get = (p, init = {}) => fetch(PUBLIC + p, { redirect: "manual", ...init });
const jsonPost = (p, payload, cookie) => get(p, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: PUBLIC,
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: JSON.stringify(payload),
});
const waitUp = async (url) => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url); return true; } catch { await sleep(250); }
  }
  return false;
};

try {
  if (!await waitUp(`http://127.0.0.1:${ADMIN_PORT}/api/health`)) {
    throw new Error("后台没起来：\n" + adminOut);
  }
  if (!await waitUp(PUBLIC + "/index.html")) {
    throw new Error("Caddy 没起来：\n" + caddyOut);
  }

  /* ------------------------------------------------ 反代与静态面 */
  await t("经反代，公开页面照常，源码仍然 404", async () => {
    eq((await get("/")).status, 200, "/");
    eq((await get("/blog/index.html")).status, 200, "随笔列表");
    for (const p of ["/blog/posts/", "/server/admin.mjs", "/deploy/Caddyfile", "/.git/config"]) {
      eq((await get(p)).status, 404, p);
    }
  });

  /* ------------------------------------------------ 前缀剥离与鉴权 */
  await t("未登录：/admin 跳登录页、/admin/api/* 返回 401", async () => {
    const page = await get("/admin/");
    eq(page.status, 302, "/admin/");
    /* 这条同时验证了两件事：handle_path 剥掉了 /admin 前缀（否则后台根本
       匹配不到这个请求），以及后台返回的跳转地址补回了 /admin 前缀
       （否则浏览器会跳到主站的 /login 上去）。 */
    eq(page.headers.get("location"), "/admin/login", "跳转地址");

    eq((await get("/admin/api/posts")).status, 401, "接口");
    eq((await get("/admin")).status, 308, "/admin 不带斜杠");
    eq((await get("/admin/login")).status, 200, "登录页");
  });

  await t("未登录时后台自己的界面文件也拿不到", async () => {
    for (const p of ["/admin/app.js", "/admin/editor.css", "/admin/md.mjs"]) {
      eq((await get(p)).status, 302, p);
    }
  });

  /* ------------------------------------------------ 登录（含 Origin 校验） */
  let cookie = "";
  await t("经反代后 Origin 校验仍然通过 —— 反代改写 Host 就会在这里炸", async () => {
    const wrong = await jsonPost("/admin/api/login", { user: USER, password: "nope-nope" });
    eq(wrong.status, 401, "口令错");

    const ok = await jsonPost("/admin/api/login", { user: USER, password: PASSWORD });
    eq(ok.status, 200, "口令对（拿到 403 说明 Origin 校验跟反代对不上）");
    const raw = ok.headers.get("set-cookie") || "";
    cookie = raw.split(";")[0];
    assert(/Path=\/admin/i.test(raw), "cookie 的 Path 必须是 /admin（前端在 /admin/ 下）：" + raw);
    assert(/HttpOnly/i.test(raw) && /Secure/i.test(raw) && /SameSite=Lax/i.test(raw), "cookie 属性：" + raw);
  });

  await t("带会话：后台界面与接口都放行，会话信息拿到的是 /admin", async () => {
    const h = { Cookie: cookie };
    eq((await get("/admin/", { headers: h })).status, 200, "写作界面");
    for (const p of ["/admin/app.js", "/admin/editor.css", "/admin/md.mjs"]) {
      eq((await get(p, { headers: h })).status, 200, p);
    }
    const s = await (await get("/admin/api/session", { headers: h })).json();
    eq(s.authed, true);
    eq(s.dev, false, "这是生产模式");
    eq(s.adminBase, "/admin");
    eq(s.user, USER);
  });

  /* ------------------------------------------------ 上传（二进制 + CSRF） */
  let uploaded = "";
  await t("上传图片：走二进制 body、经反代、按文件头认类型", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 5)]);
    const r = await get("/admin/api/upload?name=stack-test.png", {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: PUBLIC, Cookie: cookie },
      body: png,
    });
    eq(r.status, 200, "上传");
    uploaded = (await r.json()).path;
    assert(uploaded.startsWith("../assets/img/"), "返回路径：" + uploaded);
  });

  await t("刚上传的图经公开路径就能取到（后台写的和 Caddy 读的是同一份文件）", async () => {
    const name = uploaded.replace("../assets/img/", "");
    const r = await get("/assets/img/" + name);
    eq(r.status, 200, "/assets/img/" + name);
    assert(/immutable/.test(r.headers.get("cache-control") || ""), "图片应长缓存：" + r.headers.get("cache-control"));
  });

  /* ------------------------------------------------ 保存 → 立即可见 → 自动提交 */
  const SLUG = "stack-roundtrip";
  await t("新建文章：生成页面、线上立即可见、并且真的产生了 commit", async () => {
    const r = await jsonPost("/admin/api/post", {
      slug: SLUG,
      original: null,
      data: { title: "链路测试", date: "2026-01-02", summary: "摘要", lede: "导语", cats: "测试", slug: SLUG },
      body: "## 小标题\n\n正文。\n",
    }, cookie);
    eq(r.status, 200, "保存");
    const info = await r.json();
    eq(info.committed, true, "自动提交（false 说明 " + info.commitNote + "）");

    /* 经 Caddy 立刻可见 —— 后台重新生成的页面，Caddy 下一个请求就读到了 */
    eq((await get(`/blog/${SLUG}.html`)).status, 200, "文章页");
    const home = await (await get("/")).text();
    assert(home.includes(`${SLUG}.html`), "首页应该链到新文章");
  });

  await t("自动提交的作者就是 compose 里配的那一套（缺了它 commit 会失败）", async () => {
    const last = git(["log", "-1", "--format=%an|%ae|%s"]).trim();
    const [an, ae] = last.split("|");
    eq(an, AUTHOR_NAME, "作者名");
    eq(ae, AUTHOR_EMAIL, "作者邮箱");
  });

  await t("删除文章：页面收走、线上立即 404、首页与测试前逐字节一致", async () => {
    const r = await get(`/admin/api/post?slug=${SLUG}`, { method: "DELETE", headers: { Origin: PUBLIC, Cookie: cookie } });
    eq(r.status, 200, "删除");
    eq((await get(`/blog/${SLUG}.html`)).status, 404, "文章页应被收走");
    eq(readFileSync(join(SITE, "index.html"), "utf8"), BEFORE_INDEX, "首页应回到原样");
    assert(git(["log", "--oneline"]).trim().split("\n").length > BEFORE_LOG, "应该多出提交");
  });

  /* ------------------------------------------------ 收尾一致性 */
  await t("链路跑完之后，生成物仍然与 Markdown 源同步", () => {
    const out = execFileSync(process.execPath, ["tools/build.mjs", "--check"], { cwd: SITE, encoding: "utf8" });
    assert(/一致/.test(out), out.trim());
  });
} catch (e) {
  failed++;
  results.push("FAIL  (致命) " + (e?.message || e));
  if (adminOut) console.error("--- admin 输出 ---\n" + adminOut);
  if (caddyOut) console.error("--- caddy 输出 ---\n" + caddyOut);
} finally {
  for (const c of [caddy, admin]) {
    try { c.kill(); } catch { /* 已退 */ }
  }
  await sleep(600);
  for (const c of [caddy, admin]) {
    try { c.kill("SIGKILL"); } catch { /* 已退 */ }
  }
  await sleep(300);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶尔有文件锁，留着也无害 */ }
}

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
if (existsSync(TMP)) console.log("（临时目录没能删干净：" + TMP + "，可以手动删）");
process.exitCode = failed ? 1 : 0;
