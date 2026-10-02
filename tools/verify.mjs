/**
 * tools/verify.mjs — 端到端验收
 *
 * 需要本地服务和开启了调试端口的浏览器（见 tools/shots.mjs 的说明）。
 * 检查两类事情：
 *   1. 设计令牌是否真的生效（字体、颜色、圆角、字重）
 *   2. 交互是否真的可用（菜单、分段切换、时钟、倒计时）
 * 关键点是"回读计算样式与状态"，而不是只看页面有没有报错。
 */
const BASE = process.env.SITE_BASE || "http://127.0.0.1:4321";
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";

const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("无法连接调试端口"));
});
let seq = 0;
const pending = new Map();
/* 收集整页加载发出的每一个请求，用来证明"零第三方请求"。
   字体原本外链 Google（fonts.googleapis.com / gstatic.com），国内访客拿不到，
   衬线标题会掉回系统字体。这条断言就是那次自托管迁移的守门人。 */
const requests = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => {
  const id = ++seq;
  return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
};
const ev = async (expression) => {
  const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return "异常: " + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
  return m.result?.result?.value;
};

const results = [];
const ok = (name, pass, detail) => results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);

/* 本站 origin 之外的子资源请求。data: / blob: 以及 <a> 的外链不会出现在
   Network.requestWillBeSent 的子资源里（导航到外站才会），所以这里够用。 */
const { host: SELF_HOST } = new URL(BASE);
const externalRequests = () =>
  [...new Set(requests)].filter((u) => {
    try {
      const x = new URL(u);
      return /^https?:$/.test(x.protocol) && x.host !== SELF_HOST;
    } catch {
      return false;
    }
  });

await send("Page.enable", {});
await send("Network.enable", {});
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${BASE}/index.html` });
await new Promise((r) => setTimeout(r, 3000));
await ev("(async()=>{try{await document.fonts.ready}catch(e){};return 1})()");

// ---------- 1. 设计令牌 ----------
const css = JSON.parse(await ev(`(() => {
  const pick = (el, prop) => el ? getComputedStyle(el)[prop] : null;
  const q = (s) => document.querySelector(s);
  return JSON.stringify({
    fonts: ["Fraunces", "Noto Serif SC", "Inter", "JetBrains Mono"].map(n => n + "=" + document.fonts.check('16px "' + n + '"')),
    h1Family: pick(q(".hero__title"), "fontFamily"),
    h1Weight: pick(q(".hero__title"), "fontWeight"),
    bodyBg: pick(document.body, "backgroundColor"),
    bodySize: pick(document.body, "fontSize"),
    bodyColor: pick(document.body, "color"),
    btnBg: pick(q(".btn--primary"), "backgroundColor"),
    btnRadius: pick(q(".btn--primary"), "borderRadius"),
    btnWeight: pick(q(".btn--primary"), "fontWeight"),
    cardBg: pick(q(".tile"), "backgroundColor"),
    cardRadius: pick(q(".tile"), "borderRadius"),
    cardBorder: pick(q(".tile"), "borderColor"),
    panelRadius: pick(q(".hero__panel"), "borderRadius"),
    selection: (() => { try { return getComputedStyle(document.body, "::selection").backgroundColor; } catch (e) { return "n/a"; } })(),
  });
})()`));

ok("字体全部加载", css.fonts.every((f) => f.endsWith("=true")), css.fonts.join(" "));
const ext0 = externalRequests();
ok(
  "零第三方请求（字体已自托管）",
  ext0.length === 0,
  ext0.length ? "外链: " + ext0.join(", ") : `首屏共 ${requests.length} 个请求，全部同源`
);
ok("标题用衬线且字重轻于正文", /Fraunces/.test(css.h1Family) && Number(css.h1Weight) < 400, `weight=${css.h1Weight}`);
ok("页面底色是暖奶油 #faf9f5", css.bodyBg === "rgb(250, 249, 245)", css.bodyBg);
ok("正文 15px / #3d3d3a", css.bodySize === "15px" && css.bodyColor === "rgb(61, 61, 58)", `${css.bodySize} ${css.bodyColor}`);
ok("主按钮黑底 #141413", css.btnBg === "rgb(20, 20, 19)", css.btnBg);
ok("按钮圆角 8px（不是胶囊）", css.btnRadius === "8px", css.btnRadius);
ok("按钮字重 480（可变字重生效）", css.btnWeight === "480", css.btnWeight);
ok("卡片白底 + 发丝线 + 16px 圆角", css.cardBg === "rgb(255, 255, 255)" && css.cardRadius === "16px", `${css.cardBg} ${css.cardRadius} ${css.cardBorder}`);
ok("hero 面板圆角 32px", css.panelRadius === "32px", css.panelRadius);
ok("文字选中是珊瑚色 #d97757", css.selection === "rgb(217, 119, 87)", css.selection);

// ---------- 2. 交互 ----------
// 首页「最近更新」：应该正好 3 条，每条都是指向随笔或工具的链接，
// 并且按日期倒序（这是构建器从 blog/posts 与工具清单生成的，值得验一下）。
let r = await ev(`(() => {
  const items = [...document.querySelectorAll('.update')];
  const rows = items.map(el => {
    const a = el.querySelector('b a');
    const t = el.querySelector('time');
    return {
      href: a ? a.getAttribute('href') : null,
      text: a ? a.textContent.trim() : null,
      date: t ? t.getAttribute('datetime') : null,
      kind: (el.querySelector('small') || {}).textContent || ''
    };
  });
  const dates = rows.map(x => x.date);
  return JSON.stringify({
    count: items.length,
    rows,
    sortedDesc: dates.every((d, i) => i === 0 || dates[i - 1] >= d),
    allLinked: rows.every(x => x.href && x.text),
    kinds: [...new Set(rows.map(x => (x.kind.split('·')[0] || '').trim()))],
    panelBg: getComputedStyle(document.querySelector('.hero__panel')).backgroundColor
  });
})()`);
r = JSON.parse(r);
ok("最近更新正好 3 条", r.count === 3, `${r.count} 条`);
ok("更新条目都是可点链接", r.allLinked, r.rows.map((x) => x.text).join(" / "));
ok("更新按日期倒序", r.sortedDesc, r.rows.map((x) => x.date).join(" ≥ "));
ok("更新条目都标了类型", r.kinds.length >= 1 && r.kinds.every((k) => k), r.kinds.join(" + "));
ok("更新列表在深色面板里", r.panelBg === "rgb(20, 20, 19)", r.panelBg);

r = JSON.parse(await ev(`(() => {
  const menu = document.getElementById('menu');
  const btn = document.getElementById('menu-open');
  btn.click();
  const opened = menu.dataset.open === "true" && document.body.classList.contains("is-locked") && btn.getAttribute("aria-expanded") === "true";
  const cands = Array.from(menu.querySelectorAll('button, a[href]')).filter(el => el.offsetParent !== null);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const closed = menu.dataset.open === "false" && !document.body.classList.contains("is-locked");
  return JSON.stringify({ opened, closed, first: cands[0] ? (cands[0].id || cands[0].className) : null, count: cands.length });
})()`));
ok("菜单开合与滚动锁定", r.opened && r.closed, JSON.stringify(r));
ok("焦点陷阱候选顺序正确", r.first === "menu-close" && r.count >= 8, `${r.first} / 共 ${r.count}`);

r = JSON.parse(await ev(`(async () => {
  const el = document.querySelector('[data-bj-time]');
  const a = el.textContent;
  await new Promise(r => setTimeout(r, 1600));
  const cd = document.querySelector('[data-countdown]');
  return JSON.stringify({
    a, b: el.textContent,
    // 页面被切到后台时时钟会主动停表（省电），这时不能要求它跳动
    visible: !document.hidden,
    cdShown: cd ? !cd.hidden : false,
    cdText: cd ? cd.querySelector('[data-cd-text]').textContent : "无",
    revealsHidden: document.querySelectorAll('.reveal:not(.is-in)').length
  });
})()`));
ok(
  "北京时间在走",
  /^\d{2}:\d{2}:\d{2}$/.test(r.b) && (!r.visible || r.a !== r.b),
  `${r.a} -> ${r.b}` + (r.visible ? "" : "（页面在后台，停表属预期）")
);
ok("节假日倒计时已填充", r.cdShown && r.cdText.length > 3, r.cdText);
ok("入场动画没有藏住内容", r.revealsHidden === 0, `未显示元素=${r.revealsHidden}`);

// ---------- 3. 逐页加载 ----------
// 首屏之外的 .reveal 靠滚动触发，所以这里真的滚一遍到底再回来 —— 这既模拟了
// 真实阅读，也验证了"内容不会因为观察器没触发而永久留在 opacity:0"。
// 页面清单在 Node 侧从列表页解析：文章页是生成物，写死的话删了文章就会去
// 检查 404（断言只会一直超时，看着像通过，其实什么都没验到）。
const listHtml = await (await fetch(`${BASE}/blog/index.html`)).text();
const postPages = [...listHtml.matchAll(/href="([^"]+\.html)"/g)]
  .map((m) => m[1])
  .filter((h) => /^[A-Za-z0-9_-]+\.html$/.test(h) && h !== "index.html")
  .map((h) => "blog/" + h);
const pageList = ["index.html", "tools.html", "blog/index.html", ...new Set(postPages)];
console.log("待验证页面: " + pageList.join(", ") + "\n");

for (const p of pageList) {
  requests.length = 0;
  await send("Page.navigate", { url: `${BASE}/${p}` });
  await new Promise((res) => setTimeout(res, 2000));
  await ev(`(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 160));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 500));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
    return 1;
  })()`);
  const info = JSON.parse(await ev(`JSON.stringify({
    h1: document.querySelectorAll('h1').length,
    title: document.title,
    hidden: document.querySelectorAll('.reveal:not(.is-in)').length,
    css: !!document.styleSheets.length
  })`));
  const bad = await ev("window.__err || ''");
  ok(`页面 ${p}`, info.h1 === 1 && info.hidden === 0 && info.css && !bad, `h1=${info.h1} 未显示=${info.hidden}${bad ? " JS错误:" + bad : ""}`);
  const ext = externalRequests();
  ok(`页面 ${p} 无第三方请求`, ext.length === 0, ext.join(", "));
}

console.log(results.join("\n"));
const failed = results.filter((x) => x.startsWith("FAIL")).length;
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
ws.close();
process.exitCode = failed ? 1 : 0;
