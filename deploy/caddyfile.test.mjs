/* =========================================================================
   caddyfile.test.mjs — 真的把 Caddyfile 跑起来，验公开面

   需要 caddy 可执行文件。优先读环境变量 CADDY_BIN，否则找 PATH 里的 caddy。
   没有就跳过（以 exit 2 退出，跟"测试失败"区分开）：

     CADDY_BIN=/path/to/caddy node deploy/caddyfile.test.mjs

   为什么值得单独测：Caddyfile 里的公开面是一张"允许列表"，站点源码能不能
   被下载出去、缓存头对不对，全押在它身上。而这些东西没法靠读代码确认 ——
   匹配器的语义（`not path`、`handle_path` 剥前缀、`handle` 的互斥顺序）
   必须由 Caddy 自己说了算。

   做法：把真文件读进来，只改三处"跟本机环境有关"的地方 —— 站点地址、
   站点根目录、日志路径 —— 其余一个字不动，跑起来打真实请求。
   因此这个测试验的就是那份要部署上去的配置本身。

   （本机靠一个改地址的副本来跑；上线后 `caddy validate` 会验原文件。）
   ========================================================================= */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
function assert(cond, msg) { if (!cond) throw new Error(msg || "断言失败"); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label ? label + "：" : ""}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------------------------------------- 找 caddy */
function findCaddy() {
  if (process.env.CADDY_BIN) return process.env.CADDY_BIN;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, ["caddy"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}
const CADDY = findCaddy();
if (!CADDY) {
  console.error("没找到 caddy。装一个，或用 CADDY_BIN 指过去：");
  console.error("  CADDY_BIN=/path/to/caddy node deploy/caddyfile.test.mjs");
  process.exit(2);
}

/* --------------------------------------------------------------- 准备 */
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "caddy-test-"));
const CFG = join(TMP, "Caddyfile");
const LOG = join(TMP, "access.log");

/* 只替换与"本机"有关的三处，其余保持原样 */
const source = readFileSync(join(HERE, "Caddyfile"), "utf8");
const derived = source
  .replace(/\{\$SITE_DOMAIN\}/, BASE)
  .replace(/^(\s*)root \* \/srv\/site$/m, `$1root * ${ROOT.replace(/\\/g, "/")}`)
  .replace(/\/var\/log\/caddy\/access\.log/g, LOG.replace(/\\/g, "/"))
  /* admin 端口容易被上一次没退干净的实例占着；测试不关心它。
     注意不能锚在文件开头的 "^"：Caddyfile 前面是一大段注释，
     全局选项块在那个 "{" 处才刚开始。 */
  .replace(/\{\n\temail /, "{\n\tadmin off\n\temail ");

assert(derived !== source, "替换没有生效 —— Caddyfile 的写法可能被改过了");
assert(derived.includes(BASE), "站点地址没换掉");
writeFileSync(CFG, derived, "utf8");

const child = spawn(CADDY, ["run", "--config", CFG, "--adapter", "caddyfile"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ACME_EMAIL: "you@example.com" },
});
let caddyOut = "";
child.stdout.on("data", (d) => { caddyOut += d.toString(); });
child.stderr.on("data", (d) => { caddyOut += d.toString(); });

try {
  /* 等端口起来 */
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/index.html");
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) {
    console.error("Caddy 没能起来，输出如下：\n" + caddyOut);
    throw new Error("Caddy 启动失败");
  }

  const HEAD = { redirect: "manual" };

  await t("公开页面照常服务", async () => {
    for (const p of ["/", "/index.html", "/tools.html", "/blog/", "/blog/index.html", "/blog/untitled-2026-09-29.html"]) {
      const r = await fetch(BASE + p, HEAD);
      eq(r.status, 200, p);
      assert(String(r.headers.get("content-type")).includes("text/html"), p + " 应是 HTML");
    }
  });

  await t("仓库源码与工具脚本一律 404 —— 这是这次部署最要紧的一条", async () => {
    /* GitHub Pages 是把仓库根目录整个公开的：blog/posts/*.md、
       tools/*.mjs、README、.git 全都下得到。自有服务器上必须是 404。 */
    for (const p of [
      "/blog/posts/untitled-2026-09-29.md",
      "/blog/posts/",
      "/tools/build.mjs",
      "/tools/md.mjs",
      "/tools/editor.mjs",
      "/server/admin.mjs",
      "/server/auth.mjs",
      "/deploy/.env",
      "/deploy/docker-compose.yml",
      "/README.md",
      "/.git/config",
      "/.gitattributes",
      "/.github/workflows/ci.yml",
      "/package.json",
      /* 接口只在 /admin/api/ 下。/api/* 不在允许列表里，所以这里必须是 404 ——
         验收清单里把这条写成了 401，跑一遍才发现是错的。 */
      "/api/posts",
      "/api/health",
      "/api/login",
    ]) {
      eq((await fetch(BASE + p, HEAD)).status, 404, p);
    }
  });

  await t("路径穿越打不出去", async () => {
    for (const p of ["/assets/../../etc/passwd", "/assets/%2e%2e/%2e%2e/etc/passwd", "/assets/../README.md"]) {
      const r = await fetch(BASE + p, HEAD);
      assert(r.status !== 200, `${p} 竟然返回了 200`);
    }
  });

  await t("缓存头按文件类型分开", async () => {
    /* HTML 不能长缓存，否则改完文章访客还是旧的 */
    const html = await fetch(BASE + "/index.html", HEAD);
    assert((html.headers.get("cache-control") || "").includes("no-cache"), "HTML 应 no-cache：" + html.headers.get("cache-control"));

    /* site.css / site.js 文件名里没有指纹，只能短缓存 */
    const css = await fetch(BASE + "/assets/css/site.css", HEAD);
    eq(css.status, 200);
    assert(/max-age=3600$/.test(css.headers.get("cache-control") || ""), "site.css 应 max-age=3600：" + css.headers.get("cache-control"));

    /* 图片与字体是内容哈希命名的，可以 immutable */
    const img = await fetch(BASE + "/assets/img/image-c1aaba8f.webp", HEAD);
    eq(img.status, 200, "随笔里引用的那张图");
    assert(/immutable/.test(img.headers.get("cache-control") || ""), "图片应 immutable：" + img.headers.get("cache-control"));

    const font = await fetch(BASE + "/assets/fonts/fonts.css", HEAD);
    eq(font.status, 200);
    assert(/immutable/.test(font.headers.get("cache-control") || ""), "字体 CSS 应 immutable");

    const audio = await fetch(BASE + "/music.mp3", HEAD);
    eq(audio.status, 200);
    assert(/max-age=604800/.test(audio.headers.get("cache-control") || ""), "音频应 max-age=604800：" + audio.headers.get("cache-control"));
  });

  await t("安全响应头在，且不暴露服务器版本", async () => {
    const r = await fetch(BASE + "/index.html", HEAD);
    eq(r.headers.get("x-content-type-options"), "nosniff");
    eq(r.headers.get("x-frame-options"), "SAMEORIGIN");
    eq(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    eq(r.headers.get("server"), null, "不该出现 Server 头");
  });

  await t("/admin 会跳一下，/admin/ 进了反代分支", async () => {
    const bare = await fetch(BASE + "/admin", HEAD);
    eq(bare.status, 308, "/admin");
    eq(bare.headers.get("location"), "/admin/", "跳转目标");

    /* 测试环境里没有 admin 容器，所以上游不可达 —— 502 恰好证明
       /admin/* 确实被路由进了 reverse_proxy，而不是掉进 404 兜底。 */
    const slash = await fetch(BASE + "/admin/", HEAD);
    assert([200, 502, 503].includes(slash.status), "/admin/ 应进入反代分支，实际 " + slash.status);
  });

  await t("404 兜底不泄露任何东西", async () => {
    const r = await fetch(BASE + "/不存在的路径", HEAD);
    eq(r.status, 404);
    const body = await r.text();
    assert(!/Caddy|Directory listing/i.test(body), "404 页面不该带服务器信息");
  });
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }
  rmSync(TMP, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
