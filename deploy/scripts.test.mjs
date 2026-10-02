/* =========================================================================
   scripts.test.mjs — 部署脚本的测试

   需要 bash。优先读 BASH_BIN，否则找 PATH 和 Git for Windows 的常见位置。
   Git bash 也能跑这些（脚本本身就是 POSIX shell + tar + find）。

     node deploy/scripts.test.mjs

   验三件事：
     1. deploy/lib.sh 的 envval —— 它挡着一个"部署全绿但密码登不进去"的坑
     2. systemd 模板的占位符会不会被替换干净（漏一个，单元就跑不起来）
     3. deploy/backup.sh 真的跑一遍：归档里有没有该有的、有没有 .git、
        有没有把两个平台无关的坑（半截归档、轮转误删今天）踩上
   ========================================================================= */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../server/auth.mjs";

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

/* ------------------------------------------------------------- 找 bash */
function findBash() {
  if (process.env.BASH_BIN) return process.env.BASH_BIN;
  const cands = [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    "D:/dev/Git/bin/bash.exe",
    "/bin/bash",
  ];
  for (const c of cands) if (existsSync(c)) return c;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["bash"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    /* Windows 自带的 C:\Windows\system32\bash.exe 是 WSL 启动器，
       没装发行版时会失败 —— 那种要用它跑之前先排掉 */
    if (out && !/system32[\\/]bash\.exe$/i.test(out)) return out;
  } catch { /* 没有就算了 */ }
  return null;
}
const BASH = findBash();
if (!BASH) {
  console.error("没找到可用的 bash。用 BASH_BIN 指定，例如：");
  console.error('  BASH_BIN="C:/Program Files/Git/bin/bash.exe" node deploy/scripts.test.mjs');
  process.exit(2);
}

/* Windows 路径转成 bash 认的形式（/d/workplace/...），Linux 原样 */
const posix = (p) => process.platform === "win32"
  ? "/" + p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())
  : p;

function bash(script, opts = {}) {
  return spawnSync(BASH, ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd || ROOT,
  });
}

/* ==================================================== 1. lib.sh / envval */
const TMP = mkdtempSync(join(tmpdir(), "deploy-test-"));
/* 用真的口令工具生成，而不是手写一个"像那么回事"的字符串。
   理由：envval 一旦截断它，表现是"部署一路绿灯、密码怎么都登不进去" ——
   所以这里要的是真实的长度与真实的 $ 分布
   （scrypt$32768$8$1$ + 64 位十六进制盐 + $ + 128 位十六进制密钥）。 */
const REAL_HASH = await hashPassword("envval-fidelity-check-1234");
assert(REAL_HASH.length > 150, "参照哈希太短了，测试本身失去意义：" + REAL_HASH.length);
const ENV_PATH = join(TMP, ".env");

writeFileSync(ENV_PATH, [
  "# 注释行里有 = 也不能被当成键",
  "SITE_DOMAIN=example.com",
  "SITE_ROOT=/srv/site",
  `ADMIN_PASSWORD_HASH=${REAL_HASH}`,
  'QUOTED="有引号的值"',
  "SINGLE='单引号的值'",
  "EMPTYISH=",
  "WITH_CR=值后面有回车\r",
  "  SPACED  =  前后都有空格  ",
  "",
].join("\n"), "utf8");

const LIB = posix(join(HERE, "lib.sh"));
const ENVP = posix(ENV_PATH);
const envval = (key) => {
  const r = bash(`set -euo pipefail\n. "${LIB}"\nprintf '%s' "$(envval ${key})"`, {
    env: { ENV_FILE: ENVP },
  });
  if (r.status !== 0) throw new Error("bash 失败：" + (r.stderr || "").trim());
  return r.stdout;
};

await t("envval 能原样取出带 $ 的口令哈希（这是不 source .env 的原因）", () => {
  eq(envval("ADMIN_PASSWORD_HASH"), REAL_HASH, "哈希被改动了");
});

await t("对照：如果是 source .env，同一个值会被 shell 展开坏掉", () => {
  const r = bash(`set +u\n. "${ENVP}" 2>/dev/null || true\nprintf '%s' "$ADMIN_PASSWORD_HASH"`);
  const naive = r.stdout;
  assert(naive !== REAL_HASH, `source 之后居然没变？（得到 ${JSON.stringify(naive.slice(0, 40))}）`);
  /* 具体变形是 $32768 -> "" + "2768"，这里只断言"被改了"，不锁死细节 */
  assert(!naive.includes("$32768"), "应该已经被展开：" + JSON.stringify(naive.slice(0, 40)));
});

await t("envval 去掉两端引号、去空格、去掉行尾的 \\r", () => {
  eq(envval("QUOTED"), "有引号的值", "双引号");
  eq(envval("SINGLE"), "单引号的值", "单引号");
  eq(envval("SITE_DOMAIN"), "example.com", "普通值");
  eq(envval("WITH_CR"), "值后面有回车", "行尾 \\r 会让证书签发莫名其妙地失败");
  eq(envval("SPACED"), "前后都有空格", "键和值两侧的空白");
});

await t("envval 对不存在的键返回空；空值不报错", () => {
  eq(envval("NOT_THERE"), "", "不存在的键");
  eq(envval("EMPTYISH"), "", "空值");
});

await t("envval 在 .env 不存在时安静返回空", () => {
  const r = bash(`. "${LIB}"\nprintf '%s' "$(envval SITE_DOMAIN)"`, {
    env: { ENV_FILE: posix(join(TMP, "没有这个文件")) },
  });
  eq(r.status, 0, "不该报错");
  eq(r.stdout, "", "应为空");
});

/* ========================================== 2. systemd 模板占位符被换干净 */
await t("所有 systemd 模板的占位符都在 bootstrap 的替换范围内", async () => {
  const dir = join(HERE, "systemd");
  const files = readdirSync(dir).filter((f) => f.endsWith(".in"));
  assert(files.length >= 4, "模板数量不对：" + files.length);

  const bootstrap = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
  const handled = new Set([...bootstrap.matchAll(/s\|(@[A-Z_]+@)\|/g)].map((m) => m[1]));
  assert(handled.size > 0, "bootstrap.sh 里没找到替换规则，脚本可能被改过了");

  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/@[A-Z_]+@/g)) {
      assert(handled.has(m[0]), `${f} 里的 ${m[0]} 没有被 bootstrap.sh 替换`);
    }
    /* ExecStart 指向的脚本必须真实存在 */
    const exec = /^ExecStart=@SITE_ROOT@\/(.+)$/m.exec(text);
    if (exec) {
      assert(existsSync(join(ROOT, exec[1])), `${f} 的 ExecStart 指向不存在的文件：${exec[1]}`);
    }
  }
});

await t("systemd 的 ExecStart 目标在 git 里带可执行位", () => {
  /* systemd 的 ExecStart 走 execve，需要可执行位；缺了它单元会以
     "Permission denied" 失败，而 Windows 上的工作区完全看不出这个差别 ——
     所以要问 git 索引，别问文件系统。 */
  const dir = join(HERE, "systemd");
  const execs = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".in"))) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/^ExecStart=@SITE_ROOT@\/(.+)$/gm)) execs.add(m[1].trim());
  }
  assert(execs.size > 0, "模板里没找到 ExecStart");

  for (const rel of execs) {
    const out = execFileSync("git", ["ls-files", "-s", "--", rel], { cwd: ROOT, encoding: "utf8" }).trim();
    assert(out, `git 里没有这个文件：${rel}`);
    const mode = out.split(/\s+/)[0];
    eq(mode, "100755", `${rel} 在 git 索引里的模式`);
  }
});

await t("所有部署脚本通过 bash -n（语法错只有到了服务器上才会暴露）", () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith(".sh"));
  assert(files.length >= 5, "找到的脚本太少，可能路径不对：" + files.length);
  for (const f of files) {
    const r = spawnSync(BASH, ["-n", join(HERE, f)], { encoding: "utf8" });
    eq(r.status, 0, `${f} 有语法错误：` + String(r.stderr || "").trim());
  }
});

/* ================================================= 3. backup.sh 真跑一遍 */
const BK_DIR = join(TMP, "backups");
const siteP = posix(ROOT);
const bkP = posix(BK_DIR);

await t("backup.sh 生成归档，且内容正确", () => {
  const r = bash(`bash "${posix(join(HERE, "backup.sh"))}"`, {
    env: { SITE_ROOT: siteP, BACKUP_DIR: bkP, BACKUP_KEEP_DAYS: "14" },
  });
  eq(r.status, 0, "退出码（stderr: " + (r.stderr || "").trim() + "）");

  const files = readdirSync(BK_DIR);
  eq(files.length, 1, "应该只有一个归档，实际：" + files.join(", "));
  assert(/^site-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(files[0]), "文件名格式：" + files[0]);
  assert(!files.some((f) => f.endsWith(".part")), "不该留下半截的 .part 文件");

  const list = execFileSync(BASH, ["-c", `tar -tzf "${posix(join(BK_DIR, files[0]))}"`], { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);

  /* 该有的：内容源、生成物、图片、部署配置 */
  for (const want of ["./index.html", "./blog/index.html", "./blog/posts/untitled-2026-09-29.md",
    "./tools/build.mjs", "./server/admin.mjs", "./deploy/.env.example",
    "./assets/fonts/fonts.css"]) {
    assert(list.includes(want), "归档里缺少 " + want);
  }
  /* 不该有的：git 历史（那部分由 GitHub 兜着，进归档只会让体积翻几倍） */
  assert(!list.some((p) => p.startsWith("./.git/")), "归档里带了 .git：" +
    list.filter((p) => p.startsWith("./.git")).slice(0, 3).join(", "));
});

await t("backup.sh 会把 deploy/.env 一起备走（没有它恢复后登不进后台）", () => {
  /* 用一棵合成的目录树来验这一条，而不是往真实仓库里写 .env ——
     测试不该往它正在检查的东西里塞临时文件。 */
  const fake = join(TMP, "fake-site");
  const fakeDeploy = join(fake, "deploy");
  const fakeGit = join(fake, ".git");
  rmSync(fake, { recursive: true, force: true });
  for (const d of [fakeDeploy, fakeGit, join(fake, "blog", "posts")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(fakeDeploy, ".env"), "ADMIN_USER=test-only\nSESSION_SECRET=deadbeef\n", "utf8");
  writeFileSync(join(fake, "index.html"), "<!DOCTYPE html><title>t</title>", "utf8");
  writeFileSync(join(fakeGit, "config"), "[core]\n", "utf8");

  const fakeBk = join(TMP, "fake-backups");
  const r = bash(`bash "${posix(join(HERE, "backup.sh"))}"`, {
    env: { SITE_ROOT: posix(fake), BACKUP_DIR: posix(fakeBk), BACKUP_KEEP_DAYS: "14" },
  });
  eq(r.status, 0, "退出码（stderr: " + (r.stderr || "").trim() + "）");

  const archive = join(fakeBk, readdirSync(fakeBk)[0]);
  const list = execFileSync(BASH, ["-c", `tar -tzf "${posix(archive)}"`], { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  assert(list.includes("./deploy/.env"), "归档里没有 deploy/.env：" + list.join(", "));
  assert(list.includes("./index.html"), "归档里没有 index.html");
  assert(!list.some((p) => p.startsWith("./.git/")), "归档里带了 .git：" + list.join(", "));
});

await t("第二次备份覆盖同名归档，不会越堆越多", () => {
  const before = readdirSync(BK_DIR).filter((f) => f.endsWith(".tar.gz")).length;
  const r = bash(`bash "${posix(join(HERE, "backup.sh"))}"`, {
    env: { SITE_ROOT: siteP, BACKUP_DIR: bkP, BACKUP_KEEP_DAYS: "14" },
  });
  eq(r.status, 0, "退出码");
  const after = readdirSync(BK_DIR).filter((f) => f.endsWith(".tar.gz")).length;
  eq(after, before, "同一天重跑不该多出一个文件（实际 " + before + " → " + after + "）");
});

await t("超过保留期的旧档被清掉，今天这份留着", () => {
  const old = join(BK_DIR, "site-2000-01-01.tar.gz");
  writeFileSync(old, "old", "utf8");
  /* 把 mtime 推到 30 天前 */
  bash(`touch -d "30 days ago" "${posix(old)}"`);

  const r = bash(`bash "${posix(join(HERE, "backup.sh"))}"`, {
    env: { SITE_ROOT: siteP, BACKUP_DIR: bkP, BACKUP_KEEP_DAYS: "14" },
  });
  eq(r.status, 0, "退出码");
  assert(!existsSync(old), "30 天前的旧档应该被删掉");
  const today = readdirSync(BK_DIR).filter((f) => f.endsWith(".tar.gz"));
  assert(today.length === 1, "今天这份必须还在，实际：" + today.join(", "));
});

await t("归档权限是 600（里面有会话密钥和口令哈希）", () => {
  const f = join(BK_DIR, readdirSync(BK_DIR).filter((x) => x.endsWith(".tar.gz"))[0]);
  /* Windows 上 chmod 基本是空操作，只做存在性检查 */
  if (process.platform !== "win32") {
    eq(statSync(f).mode & 0o777, 0o600, "权限");
  }
  assert(statSync(f).size > 0, "归档不该是空的");
});

rmSync(TMP, { recursive: true, force: true });

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
