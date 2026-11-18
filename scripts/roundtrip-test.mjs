// 端到端复刻用户的真实路径：
//   看板里聊一句 → 跳去 Harness 会话（= iframe 重载）→ 回到看板
// 三件事必须同时还在：面板开着、问答都在、还在同一个作用域。
//
// 前三组测试各自只覆盖一段（消息对齐 / 聊天持久 / 面板状态），
// 这里把它们串成一条链，防止「单看都过、连着用就散」。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const PORT = 9231;
const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) process.exit(1);
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) process.exit(1);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-e2e");
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
if (!target) { edge.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
let seq = 0;
const wait = new Map();
const crashes = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    crashes.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
  }
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__OPS_HARNESS__ = { id: ${JSON.stringify(BOARD_ID)}, dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))}, label: ${JSON.stringify(BOARD_ID)} };
    const rf = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/ops-board/ask') === 0) {
        try { window.__ASK_ID = JSON.parse(opts.body).askId; } catch (e) {}
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, askId: window.__ASK_ID }) });
      }
      return rf.apply(window, arguments);
    };
  `,
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.querySelector('#ai-panel')")) return true;
    await sleep(200);
  }
  return false;
};

await send("Page.navigate", { url: pathToFileURL(PAGE).href });
await ready();

// ① 在单条台账里聊一句
const itemId = await ev(`(() => {
  const b = document.querySelector('[data-ask]');
  return b ? (b.getAttribute('data-ask') || '') : '';
})()`);
if (!itemId) { console.log("本板没有单条 data-ask，跳过"); ws.close(); edge.kill(); process.exit(0); }

await ev(`(() => { document.querySelector('[data-ask="${itemId}"]').click(); return true; })()`);
await sleep(400);
const ctxBefore = await ev(`(document.querySelector('#ai-ctx')||{}).textContent || ''`);
check("面板已打开且在单条台账作用域", !!ctxBefore, ctxBefore);

await ev(`(() => {
  document.querySelector('#ai-input').value = '这一条到底还成不成立？';
  document.querySelector('#ai-input').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#ai-send').click();
  return true;
})()`);
await sleep(500);
await ev(`(() => {
  window.postMessage({ type: 'ops-board/answer', askId: window.__ASK_ID,
    text: '仍然成立，最近一次实测在 11-04。', steps: [] }, window.location.origin);
  return true;
})()`);
await sleep(700);

const before = await ev(`(() => {
  const t = document.querySelector('#ai-msgs').textContent;
  return { user: t.includes('这一条到底还成不成立'), ai: t.includes('仍然成立'), msgs: document.querySelectorAll('#ai-msgs .msg').length };
})()`);
check("问答都已显示", before.user && before.ai, `msgs=${before.msgs}`);

// ② 跳去 Harness 会话再回来 —— 对 iframe 来说就是整页重载
await send("Page.reload", { ignoreCache: false });
await sleep(600);
check("回来之后页面就绪", await ready());

const after = await ev(`(() => {
  const t = document.querySelector('#ai-msgs').textContent;
  return {
    open: document.querySelector('#ai-panel').classList.contains('is-open'),
    ctx: (document.querySelector('#ai-ctx')||{}).textContent || '',
    user: t.includes('这一条到底还成不成立'),
    ai: t.includes('仍然成立'),
    msgs: document.querySelectorAll('#ai-msgs .msg').length,
    empty: !!document.querySelector('#ai-msgs .ai-empty'),
  };
})()`);

check("回来后对话面板仍然打开", after.open === true);
check("回来后作用域没变", after.ctx === ctxBefore, `"${ctxBefore}" → "${after.ctx}"`);
check("回来后自己问的那句还在", after.user === true);
check("回来后回答还在", after.ai === true);
check("回来后不是空面板", after.empty === false, `空占位=${after.empty}`);
check("回来后消息条数没缩水", after.msgs >= before.msgs, `${before.msgs} → ${after.msgs}`);

if (crashes.length) {
  for (const c of crashes.slice(0, 3)) console.log("异常: " + String(c).split("\n")[0]);
  check("无未捕获异常", false, `${crashes.length} 个`);
} else {
  check("无未捕获异常", true);
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${fails.length === 0 ? "自检通过" : "有 " + fails.length + " 项没过"}：${results.length} 项`);
ws.close();
edge.kill();
process.exit(fails.length === 0 ? 0 : 1);
