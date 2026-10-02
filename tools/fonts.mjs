/* =========================================================================
   fonts.mjs — 把 Google Fonts 搬到本地（零依赖，只用 Node 内置能力）

   为什么需要它：
     站点原来从 fonts.googleapis.com / fonts.gstatic.com 取字体。服务器放进
     国内之后，这两个域名国内访客基本拿不到，衬线标题会掉回系统字体 ——
     而衬线标题是这套设计语言的支点，掉了就不是这个站了。

   为什么是"镜像"而不是"子集化"：
     Google 返回的 CSS 已经把中文衬线按 unicode-range 切成了上百个分片，
     浏览器只下载页面上真正出现的那几个字所在的分片。这里把 CSS 和它引用的
     woff2 原样搬下来、只把 URL 改成相对路径，于是"按需取片"的行为完全没变，
     每页实际传输量跟以前一模一样。
     刻意不用 pyftsubset 自己切子集：那需要先把全站字符收集齐，漏一个字就会
     在某一篇文章里变成豆腐块 —— 一个只会在特定页面暴露的 bug。何况本机也没装
     fontTools。

   为什么相对路径能跨目录用：
     CSS 里的 url() 是相对**这个 CSS 文件自己**解析的，不是相对引用它的页面。
     所以 /、/blog/、/admin/ 三处引用同一份 fonts.css，字体路径都算得对。

   用法：
     node tools/fonts.mjs           下载分片并重写 assets/fonts/fonts.css
     node tools/fonts.mjs --check   只校验本地分片齐全，不联网
   ========================================================================= */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = join(ROOT, "assets", "fonts");
const OUT_CSS = join(OUT_DIR, "fonts.css");
const CHECK_ONLY = process.argv.includes("--check");

/* 这四个字族是站点的全部字体来源。URL 原样搬自各页 <head>，
   放这里当唯一事实源 —— 以后升级字体只改这一处。 */
const FONTS_CSS_URL =
  "https://fonts.googleapis.com/css2" +
  "?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..700,0..100,0..1;1,9..144,300..700,0..100,0..1" +
  "&family=Inter:opsz,wght@14..32,100..900" +
  "&family=JetBrains+Mono:wght@300..600" +
  "&family=Noto+Serif+SC:wght@300..600" +
  "&display=swap";

/* 必须报一个"现代浏览器"的 UA，Google 才会返回 woff2。
   报 Node 的默认 UA 会拿到全量 ttf，一个字体几十 MB。 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADER = `/* 这个文件是 tools/fonts.mjs 生成的，不要手改。
   改字体请改 tools/fonts.mjs 里的 FONTS_CSS_URL，然后重跑：

     node tools/fonts.mjs

   里面保留了 Google 原本的 unicode-range 分片，浏览器仍然只下载
   页面上真正用到的那几片。 */
`;

const FACE_RE = /@font-face\s*\{[\s\S]*?\}/g;
const GURL_RE = /url\(\s*(['"]?)(https:\/\/fonts\.gstatic\.com\/[^'")]+)\1\s*\)/g;

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "font";

/* gstatic 的路径形如 /s/fraunces/v37/xxx.woff2 或 /s/notoserifsc/v29/xxx.0.woff2，
   第二段就是字族 slug。取不到就退回 @font-face 里的 font-family。 */
function familySlug(url, body) {
  const m = /fonts\.gstatic\.com\/s\/([^/]+)\//.exec(url);
  if (m) return slugify(m[1]);
  const f = /font-family:\s*['"]?([^'";]+?)['"]?\s*;/.exec(body);
  return slugify(f ? f[1] : "font");
}

function familyOfBody(body) {
  const f = /font-family:\s*['"]?([^'";]+?)['"]?\s*;/.exec(body);
  return f ? f[1] : "?";
}

/* 小并发池：一次 6 个。Google 那边有上百个分片，全并发不礼貌也容易被限流。 */
async function pool(items, size, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    })
  );
  return out;
}

/* ------------------------------------------------------------- check 模式 */
if (CHECK_ONLY) {
  if (!existsSync(OUT_CSS)) {
    console.log("assets/fonts/fonts.css 不存在，先跑一次 node tools/fonts.mjs");
    process.exitCode = 1;
  } else {
    const css = readFileSync(OUT_CSS, "utf8");
    const missing = [];
    let count = 0;
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      count++;
      if (!existsSync(resolve(OUT_DIR, m[2]))) missing.push(m[2]);
    }
    if (/fonts\.gstatic\.com|fonts\.googleapis\.com/.test(css)) {
      missing.push("fonts.css 里还留着 Google 的绝对地址");
    }
    if (missing.length) {
      console.log(`字体分片缺失 ${missing.length} 项：\n - ` + missing.slice(0, 10).join("\n - "));
      process.exitCode = 1;
    } else {
      console.log(`本地字体分片齐全：${count} 处 url() 全部命中。`);
    }
  }
} else {
  /* ---------------------------------------------------------- 下载模式 */
  console.log("正在取 Google Fonts 的 CSS…");
  const res = await fetch(FONTS_CSS_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.error(`取 CSS 失败：HTTP ${res.status}`);
    process.exit(1);
  }
  const remote = (await res.text()).replace(/\r\n/g, "\n");
  if (!/@font-face/.test(remote)) {
    console.error("返回内容里没有 @font-face —— UA 可能被识别成老浏览器了，检查 UA 常量。");
    process.exit(1);
  }

  /* 每个分片要知道它属于哪个字族，所以先建立 url -> body 的对应 */
  const owner = new Map();
  const urlOrder = [];
  for (const m of remote.matchAll(FACE_RE)) {
    const body = m[0];
    for (const u of body.matchAll(GURL_RE)) {
      if (!owner.has(u[2])) {
        owner.set(u[2], body);
        urlOrder.push(u[2]);
      }
    }
  }
  console.log(`拿到 ${remote.match(FACE_RE).length} 个 @font-face，引用 ${urlOrder.length} 个不重复分片。开始下载…`);

  mkdirSync(OUT_DIR, { recursive: true });

  /* url -> 本地相对路径（相对 fonts.css 自己） */
  const relOf = new Map();
  const stats = new Map(); // familySlug -> { n, bytes }

  await pool(urlOrder, 6, async (url) => {
    const slug = familySlug(url, owner.get(url));
    const dir = join(OUT_DIR, slug);
    mkdirSync(dir, { recursive: true });

    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`下载分片失败 HTTP ${r.status}：${url}`);
    const buf = Buffer.from(await r.arrayBuffer());

    /* 文件名用内容哈希：同一份分片不会存两份，字体升级后文件名也会变，
       这样长缓存可以放心用 immutable。 */
    const hash = createHash("sha1").update(buf).digest("hex").slice(0, 8);
    const file = `${hash}.woff2`;
    const abs = join(dir, file);
    if (!existsSync(abs)) writeFileSync(abs, buf);

    relOf.set(url, `./${slug}/${file}`);

    const s = stats.get(slug) || { n: 0, bytes: 0 };
    s.n++;
    s.bytes += buf.length;
    stats.set(slug, s);
  });

  /* 重写 CSS：只动 url()，unicode-range、font-weight、注释全部原样保留。 */
  const localCss = HEADER + remote.replace(GURL_RE, (full, q, url) => {
    const rel = relOf.get(url);
    return rel ? `url(${rel})` : full;
  });

  const leftover = localCss.match(/fonts\.gstatic\.com|fonts\.googleapis\.com/g);
  if (leftover) {
    console.error(`还有 ${leftover.length} 处 Google 地址没换掉，中止。`);
    process.exit(1);
  }

  writeFileSync(OUT_CSS, localCss, "utf8");

  console.log("\n各字族落盘情况：");
  let total = 0;
  let totalN = 0;
  for (const [slug, s] of [...stats].sort()) {
    total += s.bytes;
    totalN += s.n;
    console.log(`  ${slug.padEnd(18)} ${String(s.n).padStart(4)} 片   ${(s.bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`  ${"合计".padEnd(16)} ${String(totalN).padStart(4)} 片   ${(total / 1024 / 1024).toFixed(2).padStart(8)} MB`);
  console.log(`\n已写入 assets/fonts/fonts.css（${(Buffer.byteLength(localCss) / 1024).toFixed(1)} KB）`);
  console.log("注意：磁盘上是全部分片，但访客只会下载页面上用到的那几片。");
}
