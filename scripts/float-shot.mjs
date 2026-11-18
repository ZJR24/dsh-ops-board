// 拍浮窗的样子：夜景 + 纸面两套主题，各拍「默认浮窗」「拉大后的浮窗」。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BOARD = "D:/WorkSpace-Tools/ops-board-reports/cyber-egg-basket";
const OUT = "D:/WorkSpace-DeepSeek";
const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
const profile = join(OUT, "profile-shot-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(EDGE, ["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars","--no-first-run","--disable-extensions","--allow-file-access-from-files",`--user-data-dir=${profile}`,"--remote-debugging-port=0","--window-size=1440,960","about:blank"], { stdio: "ignore" });
let port = 0;
for (let i = 0; i < 60; i++) {
  const m = join(profile, "DevToolsActivePort");
  if (existsSync(m)) { const t = readFileSync(m, "utf8").split(/\r?\n/); if (t[0] && Number(t[0]) > 0) { port = Number(t[0]); break; } }
  await sleep(200);
}
let target;
for (let i = 0; i < 40 && port; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = l.find((t) => t.type === "page"); if (target) break; } catch {}
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let seq = 0; const wait = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r?.result?.value; };
await send("Runtime.enable"); await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__OPS_HARNESS__={id:"cyber-egg-basket",dir:"${BOARD}",label:"cyber-egg-basket"};
  const rf=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'&&u.indexOf('/ops-board/ask')===0){
      let id=''; try{id=JSON.parse(o.body).askId;}catch(e){}
      setTimeout(function(){ window.postMessage({type:'ops-board/answer',askId:id,text:'这是回答区的示例内容。\\n\\n拖动上面那条分界，就能把输入区拉高或压低；拖标题栏可以挪窗，拉四条边可以改大小。'},'*'); },300);
      return Promise.resolve({json:()=>Promise.resolve({ok:true,askId:id})});
    }
    return rf.apply(window,arguments);
  };
` });
await send("Page.navigate", { url: pathToFileURL(join(BOARD, "dist", "index.html")).href });
await sleep(1400);

const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
  console.log("写入 " + name);
};

// 夜景 · 默认浮窗
await ev(`(function(){var b=document.querySelector('[data-ask]');if(b)b.click();})()`);
await sleep(700);
await ev(`(function(){var t=document.getElementById('ai-input');if(t){t.value='这个项目现在最大的风险是什么？';t.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
await sleep(200);
await ev(`document.getElementById('ai-send').click()`);
await sleep(900);
await shot("float-night.png");

// 夜景 · 拉大 + 置顶 + 分界上拉
await ev(`window.localStorage.setItem('ops-board-win:cyber-egg-basket', JSON.stringify({mode:"float",pinned:true,x:420,y:60,w:780,h:720,foot:240}))`);
await send("Page.reload", {});
await sleep(1500);
await ev(`(function(){var b=document.querySelector('[data-ask]');if(b)b.click();})()`);
await sleep(700);
await ev(`(function(){var t=document.getElementById('ai-input');if(t){t.value='把还没收口的 7 条，按严重程度排一下';t.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
await sleep(200);
await ev(`document.getElementById('ai-send').click()`);
await sleep(900);
await shot("float-night-big.png");

// 纸面主题 · 浮窗
await ev(`document.documentElement.setAttribute('data-theme','paper')`);
await sleep(400);
await shot("float-paper.png");

// 停靠对比图
await ev(`document.getElementById('ai-float-toggle').click()`);
await sleep(400);
await ev(`document.documentElement.setAttribute('data-theme','night')`);
await sleep(300);
await shot("float-docked.png");

ws.close(); edge.kill(); await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
