// 给「搜索」和「设置」这两层浮窗拍截图，供人眼看排版与配色。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const SHOT_DIR = arg("out") || "D:\\WorkSpace-DeepSeek";

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) { console.error("找不到 msedge.exe"); process.exit(1); }
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) { console.error("没有 dist/index.html"); process.exit(1); }
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-shot-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  "--window-size=1200,900", "about:blank",
], { stdio: "ignore" });

let port = 0;
for (let i = 0; i < 60; i++) {
  const marker = join(profile, "DevToolsActivePort");
  if (existsSync(marker)) {
    const txt = readFileSync(marker, "utf8").split(/\r?\n/);
    if (txt[0] && Number(txt[0]) > 0) { port = Number(txt[0]); break; }
  }
  await sleep(200);
}
let target;
if (port) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(250);
  }
}
if (!target) { edge.kill(); console.error("连不上调试端口"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
let seq = 0;
const wait = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    wait.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false });

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__OPS_HARNESS__ = { id: ${JSON.stringify(BOARD_ID)}, dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))}, label: ${JSON.stringify(BOARD_ID)} };`,
});
await send("Page.navigate", { url: pathToFileURL(PAGE).href });
for (let i = 0; i < 60; i++) {
  if (await ev("!!document.querySelector('#finder')")) break;
  await sleep(200);
}
await sleep(400);

const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = join(SHOT_DIR, name);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("已保存：" + file);
};

// ① 搜索：拿标题里出现过的词当查询，才有多条分组的样子
const q = await ev(`(() => {
  const bd = JSON.parse(document.getElementById('board-data').textContent);
  const it = bd.items[Object.keys(bd.items)[0]];
  const t = String(it.title || '');
  return t.length >= 4 ? t.slice(0, 2) : '问题';
})()`);
await ev(`document.querySelector('#finder-open').click()`);
await sleep(200);
await ev(`(() => {
  const i = document.querySelector('#finder-input');
  i.value = ${JSON.stringify(q)};
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await shot("finder-night.png");

// ② 设置：夜晚
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(150);
await ev(`document.querySelector('#settings-open').click()`);
await sleep(300);
await shot("settings-night.png");

// ③ 设置：纸面主题下也看一眼（三套主题的配色都要能读）
await ev(`document.querySelector('#set-theme button[data-value="paper"]').click()`);
await sleep(300);
await shot("settings-paper.png");

// ④ 搜索：纸面主题 + 已放大的字号
await ev(`document.querySelector('#set-font button[data-value="19"]').click()`);
await sleep(200);
await ev(`document.querySelector('#settings-close').click()`);
await sleep(150);
await ev(`document.querySelector('#finder-open').click()`);
await sleep(200);
await ev(`(() => {
  const i = document.querySelector('#finder-input');
  i.value = ${JSON.stringify(q)};
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await shot("finder-paper-big.png");

ws.close();
edge.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
