/* =========================================================================
   passwd.mjs — 生成后台口令哈希与会话密钥

   用法：
     node tools/passwd.mjs                    交互式，口令输入不回显
     node tools/passwd.mjs --user sean        指定用户名
     node tools/passwd.mjs --out deploy/.env  直接写成 env 文件（会被 gitignore）

   为什么口令不回显也不从命令行参数读：
     命令行参数会进 shell 历史和进程列表（同机器上任何用户 ps 一眼就看到），
     对"这个后台唯一的凭据"来说太随便了。

   生成的哈希格式是 scrypt$N$r$p$salt$key，校验在 server/auth.mjs。
   会话密钥每次重新生成都会让已登录的会话全部失效 —— 这是预期行为。
   ========================================================================= */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, newSecret } from "../server/auth.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const USER = argOf("--user", "sean");
const OUT = argOf("--out", null);

function askHidden(question) {
  return new Promise((resolve_) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve_(buf);
        }
        if (c === "\u0003") {                       // Ctrl+C
          process.stdout.write("\n已取消。\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") {         // Backspace
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

if (!process.stdin.isTTY) {
  console.error("需要交互式终端来输入口令。");
  process.exit(1);
}

console.log(`为 ${USER} 设置口令（至少 10 位，建议用一句话而不是单词）。\n`);
const pw1 = await askHidden("口令：");
if (pw1.length < 10) {
  console.error("\n太短了：至少 10 位。短口令在能被公网访问的后台上等于没有。");
  process.exit(1);
}
const pw2 = await askHidden("再输一次：");
if (pw1 !== pw2) {
  console.error("\n两次输入不一致。");
  process.exit(1);
}

console.log("\n正在计算 scrypt（N=32768，约需一秒）…");
const hash = await hashPassword(pw1);
const secret = newSecret();

const block = [
  "# 写作后台的凭据。这个文件不要提交到 git。",
  `ADMIN_USER=${USER}`,
  `ADMIN_PASSWORD_HASH=${hash}`,
  `SESSION_SECRET=${secret}`,
  "# 会话有效期（小时），默认 168 = 7 天",
  "SESSION_TTL_HOURS=168",
].join("\n") + "\n";

if (OUT) {
  const abs = resolve(ROOT, OUT);
  if (existsSync(abs)) {
    const cur = readFileSync(abs, "utf8");
    if (!/^ADMIN_USER=/m.test(cur)) {
      console.error(`\n${OUT} 已存在但不是本工具生成的，没有覆盖它。请手工合并：\n`);
      console.log(block);
      process.exit(1);
    }
    console.log(`\n注意：${OUT} 已存在，下面几行已替换原有的凭据行。`);
  }
  /* 只替换这三行，其它配置（域名、UID 等）保持不动 */
  let next = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  for (const [key, val] of [["ADMIN_USER", USER], ["ADMIN_PASSWORD_HASH", hash], ["SESSION_SECRET", secret]]) {
    const re = new RegExp(`^${key}=.*$`, "m");
    next = re.test(next) ? next.replace(re, `${key}=${val}`) : next + (next.endsWith("\n") || !next ? "" : "\n") + `${key}=${val}\n`;
  }
  writeFileSync(abs, next, "utf8");
  console.log(`\n已写入 ${OUT}（权限请自行确认：chmod 600）`);
  console.log("接着需要重启后台容器让它生效：docker compose up -d --force-recreate admin");
} else {
  console.log("\n把下面几行写进 deploy/.env：\n");
  console.log(block);
  console.log("（不要提交到 git；换了会话密钥，所有已登录的会话会立刻失效）");
}
