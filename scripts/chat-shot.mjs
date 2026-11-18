// 给对话区域拍三套主题的截图，供人眼看配色是否可读。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const PORT = 9229;
const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) process.exit(1);
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-shot");
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  "--window-size=1200,900", "about:blank",
], { stdio: "ignore" });

let target;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
let seq = 0;
const wait = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__OPS_HARNESS__={id:${JSON.stringify(BOARD_ID)},dir:${JSON.stringify(ROOT.replace(/\\/g, "/"))},label:${JSON.stringify(BOARD_ID)}};
  const rf=window.fetch;window.fetch=function(u,o){
    if(typeof u==='string'&&u.indexOf('/ops-board/ask')===0){
      // 记下前端自己生成的 askId，回答必须用同一个 id，否则会另起一条
      try{window.__ASK_ID=JSON.parse(o.body).askId}catch(e){}
      return Promise.resolve({json:()=>Promise.resolve({ok:true,askId:window.__ASK_ID})});
    }
    return rf.apply(window,arguments)
  };`,
});

await send("Page.navigate", { url: pathToFileURL(PAGE).href });
for (let i = 0; i < 60; i++) {
  if (await ev("!!document.querySelector('#ai-panel')")) break;
  await sleep(200);
}
await ev(`(()=>{const b=document.querySelector('[data-ask-global]')||document.querySelector('[data-ask]');b.click();return 1})()`);
await sleep(300);
await ev(`(()=>{document.querySelector('#ai-input').value='这一条现在什么情况？';document.querySelector('#ai-send').click();return 1})()`);
await sleep(400);
await ev(`(()=>{window.postMessage({type:'ops-board/answer',askId:window.__ASK_ID,text:'台账里的问题仍然成立，最近一次实测是 11-04。这里再放长一点文字，看气泡换行后的样子是否舒服，以及三套主题下的对比度。',steps:[]},window.location.origin);return 1})()`);
await sleep(600);

const themes = ["night", "paper", "eye"];
for (const t of themes) {
  await ev(`(()=>{document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)});return 1})()`);
  await sleep(250);
  // 只截面板那块
  const rect = await ev(`(()=>{const r=document.querySelector('#ai-panel').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})()`);
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 620), scale: 2 },
  });
  if (shot?.data) {
    writeFileSync(join(OUT, `chat-${t}.png`), Buffer.from(shot.data, "base64"));
    console.log("已写出 " + join(OUT, `chat-${t}.png`));
  }
}

ws.close();
edge.kill();
