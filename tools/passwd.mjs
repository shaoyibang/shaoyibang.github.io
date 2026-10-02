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

/* ---------------------------------------------------------------- 版本闸
   必须在任何静态 import 之前判断版本。
   server/auth.mjs 里用了可选链和空值合并（Node 14+ 才有），如果直接静态导入，
   Node 12 会在**解析阶段**就抛 "SyntaxError: Unexpected token '.'"，并且指向
   auth.mjs 的某一行 —— 报错里完全不会出现"你的 Node 太旧"这几个字。
   Ubuntu 22.04 的 `apt install nodejs` 给的正是 Node 12，所以这条路很容易踩。

   还有一条同样要紧、而且更隐蔽的：**这个文件里不能有顶层 await**。
   顶层 await 要 Node 14.8+，在 Node 12 上是**解析期**报
   "SyntaxError: Unexpected reserved word" —— 那时候版本闸一行都还没执行，
   提示照样打不出来。所以下面把逻辑全部包进 main()，只在最后调用它。
   （这是实测出来的：先写成顶层 await，用真的 Node 12 一跑，
     版本闸根本没机会说话。） */
const NODE_MIN = 18;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < NODE_MIN) {
  console.error(`需要 Node ${NODE_MIN} 以上，当前是 v${process.versions.node}。\n`);
  console.error("注意：Ubuntu 22.04 用 apt 装出来是 Node 12，跑不了这个脚本（apt 装不到够新的）。");
  console.error("装一个够新的（国内镜像，装到 /usr/local）：\n");
  console.error("  f=$(curl -fsSL https://npmmirror.com/mirrors/node/latest-v22.x/SHASUMS256.txt \\");
  console.error("        | awk '/linux-x64\\.tar\\.xz$/ {print $2; exit}')");
  console.error('  curl -fsSL -o /tmp/node.tar.xz "https://npmmirror.com/mirrors/node/latest-v22.x/$f"');
  console.error("  sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1\n");
  console.error("或者直接跑 sudo bash deploy/bootstrap.sh --with-node —— 它会照上面做。\n");
  process.exit(1);
}

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

/* 全部逻辑包在这里，不在模块顶层 await —— 见上面版本闸的注释：
   顶层 await 会让 Node 12 在解析期就失败，版本闸根本来不及说话。 */
async function main() {
  const { hashPassword, newSecret } = await import("../server/auth.mjs");

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
}

main().catch((e) => {
  console.error("出错了：" + (e && e.message ? e.message : e));
  process.exit(1);
});
