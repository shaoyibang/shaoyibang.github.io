/**
 * tools/shots.mjs — 抓 README 用的预览图
 *
 * 需要一个支持 CDP 的浏览器（Windows 上 Edge 自带）。用法：
 *   1. 起本地服务：npx --yes serve . -l 4321
 *   2. 启动无头浏览器并开调试端口（9000 是本地服务端口，9222 是调试端口）：
 *      msedge --headless=new --remote-debugging-port=9222 about:blank
 *   3. node tools/shots.mjs
 *
 * 这个脚本只用于生成文档配图，不属于站点运行时，删掉不影响站点。
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.SITE_BASE || "http://127.0.0.1:4321";
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const OUT = "docs";

const shots = [
  { name: "preview.png", path: "index.html", w: 1440, h: 900, scale: 2 },
];

mkdirSync(OUT, { recursive: true });

const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("无法连接调试端口，确认浏览器已用 --remote-debugging-port 启动"));
});

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => {
  const id = ++seq;
  return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
};
const ev = async (expression) => {
  const m = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return m.result?.result?.value;
};

await send("Page.enable", {});

for (const s of shots) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: s.w, height: s.h, deviceScaleFactor: s.scale, mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/${s.path}` });
  await new Promise((r) => setTimeout(r, 2500));
  await ev("(async()=>{try{await document.fonts.ready}catch(e){};return 1})()");
  await new Promise((r) => setTimeout(r, 2800)); // 等入场动画结束
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${s.name}`, Buffer.from(shot.result.data, "base64"));
  console.log(`已生成 ${OUT}/${s.name}  (${s.path} @ ${s.w}x${s.h} ×${s.scale})`);
}

ws.close();
