// 拍「脱离看板的独立对话窗」那一半的样子：?chat=1 铺满时的夜景与纸面。
//
// 外壳那部分（.ob-chatwin 那层壳）只有重启 Harness 才拍得到，所以这里拍的是
// 窗口「里面」—— 也就是 chatwin-test 验的那一份页面。这一张图能同时说明：
// 骨架真的没了、对话真的铺满、主题跟着走、分界和输入区都还在。
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
const profile = join(OUT, "profile-chatshot-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-extensions",
    "--allow-file-access-from-files",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    // 独立窗的默认尺寸就在这附近，按它拍才看得出铺满
    "--window-size=560,700",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let port = 0;
for (let i = 0; i < 60; i++) {
  const m = join(profile, "DevToolsActivePort");
  if (existsSync(m)) {
    const t = readFileSync(m, "utf8").split(/\r?\n/);
    if (t[0] && Number(t[0]) > 0) {
      port = Number(t[0]);
      break;
    }
  }
  await sleep(200);
}
let target;
for (let i = 0; i < 40 && port; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = l.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
let seq = 0;
const wait = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) {
    wait.get(m.id)(m.result);
    wait.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    wait.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
  window.__OPS_HARNESS__={id:"cyber-egg-basket",dir:"${BOARD}",label:"cyber-egg-basket"};
  const rf=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'&&u.indexOf('/ops-board/ask')===0){
      let id=''; try{id=JSON.parse(o.body).askId;}catch(e){}
      setTimeout(function(){
        window.postMessage({type:'ops-board/answer',surface:'chat',askId:id,text:'这扇窗由 DSH 插件画在外壳层，所以它盖得住侧边栏和顶栏，也不再被看板页面的大小限住。\\n\\n里面仍然是同一份看板页面，只是自己把骨架收了起来 —— 对话逻辑、作用域、历史、主题全都沿用。'},'*');
      },300);
      return Promise.resolve({json:()=>Promise.resolve({ok:true,askId:id})});
    }
    return rf.apply(window,arguments);
  };
  // 历史/会话列表之类的后台请求一律给个空壳，免得它们等待超时
  const origFetch=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'&&(u.indexOf('/ops-board/history')===0||u.indexOf('/ops-board/sessions')===0)){
      return Promise.resolve({ok:true,json:()=>Promise.resolve({})});
    }
    return origFetch.apply(window,arguments);
  };
`,
});

const url = pathToFileURL(join(BOARD, "dist", "index.html")).href + "?chat=1&scope=__global__";
await send("Page.navigate", { url });
await sleep(1500);

const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
  console.log("写入 " + name);
};

// 夜景 · 铺满的对话窗
await ev(`(function(){var t=document.getElementById('ai-input');if(t){t.value='这个项目现在最大的风险是什么？';t.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
await sleep(200);
await ev(`document.getElementById('ai-send').click()`);
await sleep(1100);
await shot("chatwin-night.png");

// 纸面主题
await ev(`document.documentElement.setAttribute('data-theme','paper')`);
await sleep(500);
await shot("chatwin-paper.png");

ws.close();
edge.kill();
await sleep(300);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}