/* =========================================================================
   web.test.mjs — 写作界面的浏览器端验收

   需要：一个开了调试端口的浏览器（跟 tools/verify.mjs 一样）

     msedge --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录>
     node server/web.test.mjs

   为什么单独有这么一层：写作界面是模块化的，而且这次重构动了两件"错了就
   整个界面都打不开"的事 ——
     · app.js 从 "/tools/md.mjs" 改成了相对路径 "./md.mjs"，因为绝对路径在生产
       模式下会被反向代理的白名单挡掉（那里没有 /tools/ 这个地址）
     · 所有接口从 "/api/xxx" 改成相对路径，理由同上（页面在 /admin/ 下）
   这两处一旦写错，静态文件的 HTTP 状态码全都是 200，只有真正在浏览器里跑
   才会暴露 —— 所以这里必须真开一个页面，并且收集 JS 报错和失败请求。

   界面自己起服务（开发模式，随机端口），不依赖外部先跑好的后台。
   ========================================================================= */
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";

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

/* ---------------------------------------------------- 起一个开发模式实例 */
process.argv = [process.argv[0], process.argv[1], "--dev", "--port", "0"];
const { server } = await import("./admin.mjs");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------- 连浏览器 */
let ws;
try {
  const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("无法连接调试端口 " + CDP));
  });
} catch (e) {
  console.error("连不上浏览器调试端口：" + (e?.message || e));
  console.error("先起一个：msedge --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录>");
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  process.exit(2);
}

let seq = 0;
const pending = new Map();
const consoleErrors = [];
const failedRequests = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "异常");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (m.method === "Network.loadingFailed") {
    failedRequests.push(m.params.errorText);
  }
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
    failedRequests.push(m.params.response.status + " " + m.params.response.url);
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => {
  const id = ++seq;
  return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
};
const ev = async (expression) => {
  const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const d = m.result?.exceptionDetails;
  if (d) throw new Error("页面里求值失败：" + (d.exception?.description || d.text));
  return m.result?.result?.value;
};

try {
  await send("Page.enable", {});
  await send("Runtime.enable", {});
  await send("Network.enable", {});
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: BASE + "/" });
  /* 等界面把列表拉回来并打开第一篇。轮询而不是死等，慢一点也不会假失败。 */
  for (let i = 0; i < 40; i++) {
    const n = await ev("document.querySelectorAll('.list__item').length");
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await ev("(async()=>{try{await document.fonts.ready}catch(e){};return 1})()");

  await t("界面自己的模块能加载（./md.mjs 走的是后台的命名空间）", async () => {
    const v = await ev("typeof window.__mdProbe");
    /* 没有全局探针时，用"预览区渲染成功"间接证明 md.mjs 加载成功 ——
       见下面那条断言。这里只确认页面没有模块加载报错。 */
    void v;
    const bad = consoleErrors.filter((x) => /md\.mjs|Failed to fetch dynamically|Cannot find module/i.test(x));
    eq(bad.length, 0, "模块加载报错：" + bad.join(" | "));
  });

  await t("文章列表渲染出来了", async () => {
    const n = await ev("document.querySelectorAll('.list__item').length");
    assert(n >= 1, "列表项数量 = " + n);
  });

  await t("选中第一篇后，正文与预览都填上了（证明共用转换器生效）", async () => {
    const r = JSON.parse(await ev(`JSON.stringify({
      editor: document.getElementById('editor').value.length,
      preview: document.getElementById('preview').innerHTML.length,
      title: document.getElementById('f-title').value,
      status: document.getElementById('status').textContent
    })`));
    assert(r.editor > 0, "编辑器是空的（status=" + r.status + "）");
    assert(r.preview > 60, "预览没渲染出来（长度 " + r.preview + "）");
    assert(r.title.length > 0, "标题没填上");
  });

  await t("接口走的是相对路径，且都成功了", async () => {
    assert(!consoleErrors.some((x) => /HTTP 4\d\d|HTTP 5\d\d/.test(x)), "出现接口报错：" + consoleErrors.join(" | "));
    eq(failedRequests.length, 0, "有失败请求：" + failedRequests.join(" | "));
  });

  await t("开发模式下两个出口链接指向 /site/ 预览，退出按钮不显示", async () => {
    const r = JSON.parse(await ev(`JSON.stringify({
      home: document.getElementById('open-home').getAttribute('href'),
      blog: document.getElementById('open-blog').getAttribute('href'),
      logoutHidden: document.getElementById('logout').hidden
    })`));
    eq(r.home, "/site/index.html", "打开主页");
    eq(r.blog, "/site/blog/index.html", "随笔列表");
    eq(r.logoutHidden, true, "开发模式不该出现退出按钮");
  });

  await t("界面用的是自托管字体，没有第三方请求", async () => {
    const r = JSON.parse(await ev(`JSON.stringify({
      display: document.fonts.check('16px Fraunces'),
      css: getComputedStyle(document.querySelector('.bar__brand')).fontFamily
    })`));
    eq(r.display, true, "Fraunces 没加载：" + r.css);
    assert(!failedRequests.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)), "还在请求 Google 字体");
  });

  await t("页面没有 JS 报错", async () => {
    eq(consoleErrors.length, 0, consoleErrors.join(" | "));
  });
} finally {
  try { ws.close(); } catch { /* 已经关了 */ }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

console.log(results.join("\n"));
console.log(`\n合计 ${results.length} 项，${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
