// 量「用户消息是否真的显示在右侧」。
//
// 只读 CSS 不算验证 —— float / flex / max-width / 父级宽度任何一处不对，
// 规则写着「靠右」，实际还是贴左。这里用 getBoundingClientRect() 量真实像素：
//   用户气泡：右边缘应接近容器右边缘，左边缘应明显离开容器左边缘
//   助手正文：左边缘贴近容器左边，占满宽度

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
const PORT = 9228;

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  process.exit(1);
}
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) {
  console.error("没有 dist/index.html，先 render");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-align");
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1200,900", "about:blank",
  ],
  { stdio: "ignore" }
);

let target;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) {
  edge.kill();
  console.error("连不上调试端口");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
let seq = 0;
const wait = new Map();
const crashes = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    crashes.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
  }
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
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__OPS_HARNESS__ = {
      id: ${JSON.stringify(BOARD_ID)},
      dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))},
      label: ${JSON.stringify(BOARD_ID)},
      projectDir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))}
    };
    const realFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/ops-board/ask') === 0) {
        // 记下前端自己生成的 askId：回答必须用同一个 id 回来，
        // 否则前端认为「气泡不在了」，会另起一条，测出来就是两条助手消息。
        try { window.__ASK_ID = JSON.parse(opts.body).askId; } catch {}
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, askId: window.__ASK_ID }) });
      }
      return realFetch.apply(window, arguments);
    };
  `,
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

await send("Page.navigate", { url: pathToFileURL(PAGE).href });
for (let i = 0; i < 60; i++) {
  if (await ev("!!document.querySelector('#ai-panel')")) break;
  await sleep(200);
}

// 造一轮完整问答：问一句（用户消息），再喂一条回答（助手消息）
await ev(`(() => {
  const b = document.querySelector('[data-ask-global]') || document.querySelector('[data-ask]');
  b.click();
  return true;
})()`);
await sleep(300);
await ev(`(() => {
  const ta = document.querySelector('#ai-input');
  ta.value = '这一条现在到底什么情况？给我一句话说明。';
  document.querySelector('#ai-send').click();
  return true;
})()`);
await sleep(400);
await ev(`(() => {
  window.postMessage({
    type: 'ops-board/answer',
    askId: window.__ASK_ID,
    text: '台账里写的问题仍然成立，最近一次实测是在 11-04。',
    steps: []
  }, window.location.origin);
  return true;
})()`);
await sleep(600);

// 顺带守住一个回归点：用同一个 askId 回来时，「正在回答…」那条必须被替换掉，
// 不能变成「正在回答…」+ 真回答两条并存的怪样子。
const msgCount = await ev(`(() => ({
  total: document.querySelectorAll('#ai-msgs .msg').length,
  pending: document.querySelectorAll('#ai-msgs .is-pending').length,
  text: document.querySelector('#ai-msgs').textContent
}))()`);
check("回答到达后没有残留「正在回答…」", msgCount.pending === 0, `is-pending=${msgCount.pending}`);
check("一问一答共 2 条消息", msgCount.total === 2, `total=${msgCount.total}`);
check("「正在回答…」占位文字已消失", !msgCount.text.includes("正在回答"), "");

const geo = await ev(`(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
  const list = document.querySelector('#ai-msgs');
  const user = document.querySelector('.msg-user');
  const ai = document.querySelector('.msg-ai');
  if (!user || !ai) return { missing: !user ? 'user' : 'ai' };
  return {
    list: box(list),
    userMsg: box(user),
    userBody: box(user.querySelector('.msg-body')),
    userRole: box(user.querySelector('.msg-role')),
    aiBody: box(ai.querySelector('.msg-body')),
  };
})()`);

if (geo.missing) {
  check("问答两条消息都在", false, "缺 " + geo.missing);
} else {
  const L = geo.list, UB = geo.userBody, AB = geo.aiBody;
  // 容器内边距约 14px，气泡贴右应距右边 < 20px
  const rightGap = L.r - UB.r;
  const leftGap = UB.l - L.l;
  console.log(`容器 [${L.l}, ${L.r}] 宽${L.w} / 用户气泡 [${UB.l}, ${UB.r}] 宽${UB.w} / 助手正文 [${AB.l}, ${AB.r}]`);
  check("用户气泡靠右", rightGap <= 20, `右侧间隙 ${rightGap}px`);
  check("用户气泡确实从左边挪开了", leftGap > 20, `左侧间隙 ${leftGap}px`);
  check("用户气泡不满宽（有气泡感）", UB.w < L.w * 0.95, `气泡宽 ${UB.w} / 容器 ${L.w}`);
  check("助手正文仍在左侧", AB.l - L.l < 20, `左侧间隙 ${AB.l - L.l}px`);
  check("助手正文占满（不对称挤压）", AB.w > L.w * 0.6, `正文宽 ${AB.w} / 容器 ${L.w}`);
  check("「你」标签跟着靠右", L.r - geo.userRole.r <= 25, `右侧间隙 ${L.r - geo.userRole.r}px`);
}

if (crashes.length) {
  console.log("\n页面异常：");
  for (const c of crashes.slice(0, 5)) console.log("  " + String(c).split("\n")[0]);
}
const fails = results.filter((r) => !r.ok);
console.log(`\n${fails.length === 0 ? "自检通过" : "有 " + fails.length + " 项没过"}：${results.length} 项`);
writeFileSync(join(OUT, "msg-align.json"), JSON.stringify({ geo, results }, null, 2));
ws.close();
edge.kill();
process.exit(fails.length === 0 ? 0 : 1);
