// 验收「跳走再回来，对话记录还在」。
//
// 用 file:// 直接打开产物，不需要服务、不需要 Harness：
// 这里验的是**前端自己**的持久化能力 —— 页面重载后，之前问过/答过的内容
// 还能不能从 localStorage 摆回面板里。这正是「去 Harness 看完整会话再回来」
// 时发生的事（看板 iframe 被卸载重建）。
//
// 用法：node scripts/chat-persist-test.mjs [--board <看板目录>]

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const PORT = 9226;

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));

if (!EDGE) {
  console.error("找不到 msedge.exe，没法做交互验收。");
  process.exit(1);
}
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) {
  console.error("没有 dist/index.html，先跑 node scripts/render.mjs");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const profile = join(OUT, "profile-chat");
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
  { stdio: "ignore", detached: false }
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
  console.error("连不上 Edge 的调试端口");
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
    crashes.push(
      m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text
    );
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
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

const nav = async () => {
  // 先把假 Harness 环境塞进去：裸页没有 window.__OPS_HARNESS__，
  // 前端会直接拒绝发送（那是正确行为），测不到落库路径。
  // 用 Page.addScriptToEvaluateOnNewDocument 保证每次导航都先注入。
  await send("Page.navigate", { url: pathToFileURL(PAGE).href });
  for (let i = 0; i < 60; i++) {
    try {
      if (await ev("!!document.querySelector('#ai-panel')")) return true;
    } catch {}
    await sleep(200);
  }
  return false;
};

// 看板 id 取自目录名（插件注入的 __OPS_HARNESS__.id 通常就是它）
const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// 注入假环境 + 假网络：让「发送」这条真实前端路径能走通
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__OPS_HARNESS__ = {
      id: ${JSON.stringify(BOARD_ID)},
      dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))},
      label: ${JSON.stringify(BOARD_ID)},
      projectDir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))}
    };
    // 假 /ops-board/ask：立刻成功，但不回 answer —— 只验证「你问的话被记住」。
    const realFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/ops-board/ask') === 0) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, askId: 'test-ask-1' })
        });
      }
      return realFetch.apply(window, arguments);
    };
  `,
});

// 打开面板并切到「整本台账」作用域（总览页的入口）
const openPanel = async () => {
  return ev(`(() => {
    const b = document.querySelector('[data-ask-global]') || document.querySelector('[data-ask]');
    if (!b) return 'no-button';
    b.click();
    return document.querySelector('#ai-panel').classList.contains('is-open') ? 'open' : 'closed';
  })()`);
};

// 模拟一轮问答：直接调用前端内部路径 —— 用 UI 的输入框 + 伪造一条回答事件。
// 这样测的是「真实写入路径」，不是往 localStorage 硬塞。
const askOnce = async (text) => {
  return ev(`(() => {
    const ta = document.querySelector('#ai-input');
    if (!ta) return 'no-input';
    ta.value = ${JSON.stringify(text)};
    const panel = document.querySelector('#ai-panel');
    const btn = panel.querySelector('#ai-send');
    if (!btn) return 'no-send';
    btn.click();
    return 'clicked';
  })()`);
};

// 页面里没有 Harness，提问会以「要在这里打开才能问」失败 —— 但用户消息的
// 落库发生在 addMsg 之后，所以仍然能验证「问过的话被记住」。
const countMsgs = async () =>
  ev(`document.querySelectorAll('#ai-panel .msg').length`);

const panelLog = async () =>
  ev(`(() => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('ops-board-chat:'));
    return keys.map(k => ({ key: k, n: (JSON.parse(localStorage.getItem(k)) || []).length }));
  })()`);

console.log("== 第一次打开 ==");
await nav();
const opened = await openPanel();
await sleep(300);
check("面板能打开", opened === "open", String(opened));

const before = await countMsgs();
check("初始没有消息", before === 0, `msg=${before}`);

console.log("\n== 提问（走真实前端路径）==");
const clicked = await askOnce("这条现在什么情况？");
await sleep(400);
const afterAsk = await countMsgs();
const log1 = await panelLog();
check("提问后消息落库", log1.length > 0 && log1[0].n > 0, JSON.stringify(log1));

console.log("\n== 模拟「跳走再回来」：重载页面 ==");
await nav();
const reopened = await openPanel();
await sleep(400);
const afterReload = await countMsgs();
check("重载后对话记录被恢复", afterReload > 0, `msg=${afterReload}`);
check("恢复内容包含原问题", await ev(`document.querySelector('#ai-panel').textContent.includes('这条现在什么情况')`), "");

console.log("\n== 恢复后不应再当「第一句」重灌背景 ==");
// AI.fresh 不可从外部读，用「问题是否带前置」间接判断：恢复后再发一句，
// 若 withContext 为真，生成的文本会很长。
const freshFlag = await ev(`(() => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ops-board-chat:'));
  return keys.length ? JSON.parse(localStorage.getItem(keys[0])).length : 0;
})()`);
check("落库条数 >= 1", freshFlag >= 1, `n=${freshFlag}`);

console.log("\n== 回答也落库（含过程）==");
// 伪造插件那边回来的 answer 事件，走真实的消息处理路径
await ev(`(() => {
  const data = {
    type: 'ops-board/answer',
    askId: 'test-ask-1',
    text: '台账里写的问题仍然成立，最近一次实测是 11-04。',
    steps: [{ name: 'Read', ok: true, detail: 'ledger.json' }],
    sessionId: 'sess-test-1'
  };
  window.postMessage(data, window.location.origin);
  return true;
})()`);
await sleep(400);
const afterAnswer = await ev(`(() => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ops-board-chat:'));
  if (!keys.length) return null;
  const list = JSON.parse(localStorage.getItem(keys[0])) || [];
  return { n: list.length, roles: list.map(x => x.role), hasSteps: list.some(x => x.steps && x.steps.length) };
})()`);
check("回答已落库", afterAnswer && afterAnswer.roles.includes("ai"), JSON.stringify(afterAnswer));
check("回答带过程摘要", afterAnswer && afterAnswer.hasSteps, "");

console.log("\n== 再重载：问答都在 ==");
await nav();
await openPanel();
await sleep(400);
const bothRestored = await ev(`(() => {
  const t = document.querySelector('#ai-panel').textContent;
  return {
    hasQ: t.includes('这条现在什么情况'),
    hasA: t.includes('最近一次实测是 11-04'),
    msgs: document.querySelectorAll('#ai-panel .msg').length
  };
})()`);
check("重载后问题还在", bothRestored.hasQ, "");
check("重载后回答还在", bothRestored.hasA, "");
check("重载后消息数为 2", bothRestored.msgs === 2, `msg=${bothRestored.msgs}`);

console.log("\n== 作用域隔离：换条目面板不串记录 ==");
const isolation = await ev(`(() => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ops-board-chat:'));
  const globalKey = keys.find(k => k.endsWith('__global__')) || null;
  // 找一个条目级入口，点开问一句，确认它写的是自己的键
  const itemBtn = document.querySelector('[data-ask]');
  if (!itemBtn) return { globalKey, itemKey: null, note: 'no item button' };
  itemBtn.click();
  return { globalKey, itemId: itemBtn.getAttribute('data-ask') };
})()`);
check("记录按作用域分键", isolation.globalKey !== null, isolation.globalKey || "none");

if (isolation.itemId) {
  await sleep(300);
  await askOnce("这条能不能直接改？");
  await sleep(400);
  const keys2 = await ev(`Object.keys(localStorage).filter(k => k.startsWith('ops-board-chat:'))`);
  check(
    "条目有独立记录键",
    keys2.some((k) => k.indexOf(isolation.itemId) > -1),
    JSON.stringify(keys2)
  );
  check("全局键未被条目内容污染", await ev(`(() => {
    const g = localStorage.getItem('ops-board-chat:cyber-egg-basket:__global__');
    return !g || !g.includes('这条能不能直接改');
  })()`), "");
}

console.log("\n== 从 Harness 加载历史（插件没装时应静默降级）==");
await nav();
await openPanel();
await sleep(300);
// 裸页没有插件，请求会超时 —— 关键是不能卡住、不能报错、本地缓存仍然在
const degraded = await ev(`(() => {
  const t = document.querySelector('#ai-panel').textContent;
  return { hasQ: t.includes('这条现在什么情况'), alive: !!document.querySelector('#ai-input') };
})()`);
check("插件缺失时面板不崩", degraded.alive, "");
check("插件缺失时保留本地缓存", degraded.hasQ, "");

console.log("\n== 模拟插件返回 Harness 历史：应替换本地缓存 ==");
// 桥用 window.parent.postMessage 发请求 —— 裸页里 parent 就是自己，测不到。
// 这里起一个本地 http 服务托管 dist，再套一层真实 iframe：
// 这样 origin 是真 origin（file:// 下 origin 是 null，postMessage 校验会失配），
// 看板的处境与「被插件装进 iframe」一致，测试页扮演插件。
const { createServer } = await import("node:http");
const { readFileSync: rf } = await import("node:fs");
const srv = createServer((req, res) => {
  try {
    const body = rf(PAGE);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end("err");
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}/`;
const PAGE_URL = BASE;

await send("Page.navigate", { url: BASE });
await sleep(300);
await ev(`(() => {
  document.body.innerHTML = '';
  const f = document.createElement('iframe');
  f.id = 'board';
  f.src = '/';
  f.style.cssText = 'width:1200px;height:900px;border:0';
  document.body.appendChild(f);
  // 扮演插件：收到历史请求就回一段「Harness 里的真实历史」。
  //
  // ⚠️ 这里必须复刻插件真实的回信方式：广播给所有 iframe（postToBoard）。
  // 之前这里写成 window.postMessage 直接把消息塞进 iframe —— 那恰好绕过了
  // 「插件把消息发给自己而不是 iframe」这个真实 bug，所以测不出来。
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || d.type !== 'ops-board/history') return;
    window.__histReq = { board: d.board, key: d.key, reqId: d.reqId };
    const payload = {
      type: 'ops-board/history',
      reqId: d.reqId,
      ok: true,
      sessionId: 'sess-from-harness',
      messages: [
        { role: 'user', text: 'HARNESS-里问过的话' },
        { role: 'assistant', text: 'HARNESS-里的回答' }
      ]
    };
    // 同 postToBoard：遍历 iframe 逐个投递，不直接指定某一个
    for (const frame of document.querySelectorAll('iframe')) {
      try { if (frame.contentWindow) frame.contentWindow.postMessage(payload, window.location.origin); } catch {}
    }
  });
  return true;
})()`);

// 等 iframe 里的看板就绪，然后打开面板触发 resetChat
const ready = await (async () => {
  for (let i = 0; i < 50; i++) {
    const ok = await ev(`(() => {
      const f = document.querySelector('#board');
      const doc = f && f.contentDocument;
      return !!(doc && doc.querySelector('#ai-panel'));
    })()`);
    if (ok) return true;
    await sleep(200);
  }
  return false;
})();
check("iframe 里的看板就绪", ready, "");

if (ready) {
  await ev(`(() => {
    const doc = document.querySelector('#board').contentDocument;
    const b = doc.querySelector('[data-ask-global]') || doc.querySelector('[data-ask]');
    b.click();
    return true;
  })()`);
  await sleep(1200);

  const histReq = await ev(`window.__histReq || null`);
  check("看板发出了历史请求", !!histReq, JSON.stringify(histReq));

  const fromHarness = await ev(`(() => {
    const doc = document.querySelector('#board').contentDocument;
    const t = doc.querySelector('#ai-panel').textContent;
    return {
      hasHarnessQ: t.includes('HARNESS-里问过的话'),
      hasHarnessA: t.includes('HARNESS-里的回答'),
      stillOld: t.includes('这条现在什么情况')
    };
  })()`);
  check("Harness 历史已加载", fromHarness.hasHarnessQ && fromHarness.hasHarnessA, JSON.stringify(fromHarness));
  check("本地缓存被 Harness 历史替换", !fromHarness.stillOld, "");
}

const fails = results.filter((r) => !r.ok);
if (crashes.length) {
  console.log("\n页面异常：");
  for (const c of crashes.slice(0, 5)) console.log("  " + String(c).split("\n")[0]);
}

console.log(
  `\n${fails.length === 0 ? "自检通过" : "有 " + fails.length + " 项没过"}：${results.length} 项检查`
);

ws.close();
edge.kill();
writeFileSync(join(OUT, "chat-persist.json"), JSON.stringify(results, null, 2));
process.exit(fails.length === 0 ? 0 : 1);
