// 验证本轮两件事：
//   ① 切到「新对话」要把这个插件窗口的聊天记录清空（消息区 + 本地缓存），
//      而且重载之后不能自己"复活"成旧内容。
//   ② 「继续上次」改成「选择对话」：下拉能列出该作用域聊过的多条对话，
//      选中哪条就把窗口换成哪条的内容。
//
// 环境：本地 http 服务托管 dist + 真实 iframe。
// file:// 下 origin 是 "null"，postMessage 的 origin 校验会失配，测不出真实行为；
// 用 http 才能让看板处在「被插件装进 iframe」的处境，由测试页扮演插件。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const PORT = 9232;

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
  console.error("没有 dist/index.html");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-pick");
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
const SID1 = "sess-a1b2c3d4e5f6";
const SID2 = "sess-f6e5d4c3b2a1";

// 托管 dist，并把 harness 环境变量、假映射表、假历史回包都注入 iframe
const srv = createServer((req, res) => {
  try {
    const body = readFileSync(PAGE);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end("err");
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}/`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

// 在 iframe 自己的全局里执行（看板的真实处境）。
//
// ⚠️ 不能写成 `(function(){...}).call(f.contentDocument)`：函数体里出现的 `document`
// 仍然是顶层页面的 document（词法作用域在顶层脚本里），拿到的永远是外层文档。
// 必须走 contentWindow.eval，让代码在 iframe 的全局环境里跑。
const frameEval = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      const f = document.querySelector('#board');
      if (!f || !f.contentWindow) return null;
      return f.contentWindow.eval('(function(){' + ${JSON.stringify(expr)} + '}).call(window)');
    })()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
const fdoc = frameEval;
const fwin = frameEval;

// 建立测试页（扮演插件）：iframe + 消息桥
const mount = async () => {
  await ev(`(() => {
    document.body.innerHTML = '';
    const f = document.createElement('iframe');
    f.id = 'board';
    f.src = '/';
    f.style.cssText = 'width:1200px;height:900px;border:0';
    document.body.appendChild(f);
    if (window.__bridged) return true;
    window.__bridged = true;
    window.__HIST_REQS = [];
    window.__ASK_REQS = [];
    // 扮演插件：收到「列出这个看板目录下的会话」就回两条。
    // 真实实现按会话的 cwd 过滤，这里只需要证明前端确实问了、并且用了回包。
    window.__LIST_REQS = [];
    // 清单内容做成可改的：本轮要验证「从某个问题点进去」时，
    // 前端能在同一份清单里认出属于那个条目的对话。
    window.__LIST_ITEMS = window.__LIST_ITEMS || [
      { id: ${JSON.stringify(SID2)}, title: '第二次对话', at: 2, blank: false },
      { id: ${JSON.stringify(SID1)}, title: '第一次对话', at: 1, blank: false }
    ];
    window.addEventListener('message', function (e) {
      const d = e.data;
      if (!d || d.type !== 'ops-board/list-sessions') return;
      window.__LIST_REQS.push({ reqId: d.reqId, dir: d.dir || '' });
      const payload = {
        type: 'ops-board/sessions-list', reqId: d.reqId, board: d.board, ok: true,
        items: window.__LIST_ITEMS
      };
      for (const frame of document.querySelectorAll('iframe')) {
        try { if (frame.contentWindow) frame.contentWindow.postMessage(payload, window.location.origin); } catch {}
      }
    });
    // 扮演插件：收到 history 请求就按它要的 sessionId 回一份有编号的假历史。
    // ⚠️ 回信必须广播给所有 iframe（postToBoard 的行为），
    //    直接 window.postMessage 会绕过「插件把消息发给自己」那个真实 bug。
    window.addEventListener('message', function (e) {
      const d = e.data;
      if (!d || d.type !== 'ops-board/history') return;
      window.__HIST_REQS.push({ reqId: d.reqId, key: d.key, sessionId: d.sessionId || '' });
      // 只有映射表里记过的作用域才有历史（__global__）。
      // 真实插件也是这个行为：没记过的 key 查不到会话，回「没有可显示的消息」，
      // 前端据此认为这是新对话。若这里对任何 key 都编一段历史，风险审核这种
      // 全新作用域会被伪装成「聊过」，首句就不带背景了 —— 那测的不是真实行为。
      const known = d.key === '__global__';
      if (!known && !d.sessionId) {
        const empty = {
          type: 'ops-board/history', reqId: d.reqId, board: d.board,
          ok: true, sessionId: '', entries: 0, messages: []
        };
        for (const frame of document.querySelectorAll('iframe')) {
          try { if (frame.contentWindow) frame.contentWindow.postMessage(empty, window.location.origin); } catch {}
        }
        return;
      }
      const sid = d.sessionId || ${JSON.stringify(SID2)};
      const tag = sid === ${JSON.stringify(SID1)} ? '第一次对话' : '第二次对话';
      const payload = {
        type: 'ops-board/history', reqId: d.reqId, board: d.board,
        ok: true, sessionId: sid, entries: 2,
        messages: [
          { role: 'user', text: tag + ' · 我问的话' },
          { role: 'ai', text: tag + ' · 它答的话' }
        ]
      };
      for (const frame of document.querySelectorAll('iframe')) {
        try { if (frame.contentWindow) frame.contentWindow.postMessage(payload, window.location.origin); } catch {}
      }
    });
    return true;
  })()`);
  for (let i = 0; i < 60; i++) {
    const ok = await ev(`(() => {
      const f = document.querySelector('#board');
      const d = f && f.contentDocument;
      return !!(d && d.querySelector('#ai-panel'));
    })()`);
    if (ok) return true;
    await sleep(200);
  }
  return false;
};

// 每帧 iframe 都要重新注入：假映射表 + harness 环境
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    if (window.top === window) {
      // 顶层测试页不用装
    } else {
      window.__OPS_HARNESS__ = {
        id: ${JSON.stringify(BOARD_ID)},
        dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))},
        label: ${JSON.stringify(BOARD_ID)}
      };
      const rf = window.fetch;
      window.fetch = function (url, opts) {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        const method = (opts && opts.method) || 'GET';
        if (u.indexOf('/ops-board/sessions') === 0) {
          if (method === 'GET') {
            const body = {
              ${JSON.stringify(BOARD_ID)}: {
                __global__: {
                  id: ${JSON.stringify(SID2)},
                  title: '第二次对话',
                  history: [
                    { id: ${JSON.stringify(SID2)}, title: '第二次对话', at: 2 },
                    { id: ${JSON.stringify(SID1)}, title: '第一次对话', at: 1 }
                  ]
                }
              }
            };
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
        }
        if (u.indexOf('/ops-board/ask') === 0) {
          try {
            const b = JSON.parse(opts.body);
            window.__ASK_ID = b.askId;
            // 记下整份请求，重点是 reuseSessionId —— 本轮的核心断言就是它。
            if (!window.__ASK_BODIES) window.__ASK_BODIES = [];
            window.__ASK_BODIES.push(b);
          } catch (e) {}
          return Promise.resolve({ json: () => Promise.resolve({ ok: true, askId: window.__ASK_ID }) });
        }
        return rf.apply(window, arguments);
      };
    }
  `,
});

await send("Page.navigate", { url: BASE });
await sleep(400);
check("iframe 里的看板就绪", await mount());

// 清掉上次跑测试留下的状态，保证起点干净
await fwin(`return (() => {
  for (const k of Object.keys(window.localStorage)) {
    if (k.indexOf('ops-board-chat:') === 0 || k.indexOf('ops-board-cleared:') === 0 ||
        k.indexOf('ops-board-panel:') === 0) window.localStorage.removeItem(k);
  }
  return true;
})()`);

const msgCount = () => fdoc(`return document.querySelectorAll('#ai-msgs .msg').length;`);
const msgTexts = () =>
  fdoc(`return Array.prototype.map.call(document.querySelectorAll('#ai-msgs .msg'), function(n){ return n.textContent.trim(); });`);
const chatKey = () => fwin(`return 'ops-board-chat:' + window.__OPS_HARNESS__.id + ':__global__';`);
const cached = async () => {
  const k = await chatKey();
  return fwin(`return window.localStorage.getItem(${JSON.stringify(k)});`);
};
const pickChecked = () => fdoc(`return document.querySelector('#ai-mode-reuse').checked;`);
const pickOptions = () =>
  fdoc(`return Array.prototype.map.call(document.querySelectorAll('#ai-pick option'), function(o){ return { v: o.value, t: o.textContent }; });`);

// ① 打开「整本台账」面板，让它从（假）Harness 拿到两条对话可选
await fdoc(`return (() => {
  const b = document.querySelector('[data-ask-global]') || document.querySelector('[data-ask]');
  if (!b) return false;
  b.click(); return true;
})()`);
await sleep(1400);

check("面板已打开", (await fdoc(`return document.querySelector('#ai-panel').classList.contains('is-open');`)) === true);

// ② 下拉里应该列出两条对话（「选择对话」的核心）
const opts = (await pickOptions()) || [];
const realOpts = opts.filter((o) => o.v);
check("下拉列出了多条对话", realOpts.length >= 2, JSON.stringify(realOpts.map((o) => o.t)));
check("选项里带第一次对话", realOpts.some((o) => /第一次对话/.test(o.t)), JSON.stringify(realOpts.map((o) => o.t)));
check("选项里带第二次对话", realOpts.some((o) => /第二次对话/.test(o.t)), JSON.stringify(realOpts.map((o) => o.t)));

// ③ 有旧对话时默认接进上次那条，窗口里应该有内容
check("默认落在「选择对话」上", (await pickChecked()) === true);
const beforeCount = await msgCount();
check("窗口里已有历史内容", beforeCount > 0, `${beforeCount} 条`);
const beforeTexts = (await msgTexts()) || [];
check("历史内容来自 Harness 回包", beforeTexts.join(" ").indexOf("第二次对话") > -1, JSON.stringify(beforeTexts));

// ④ 切到「新对话」→ 窗口必须清空（本轮第一个需求）
await fdoc(`return (() => { const r = document.querySelector('#ai-mode-new'); r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
await sleep(600);
const afterNew = await msgCount();
check("切到新对话后消息区清空", afterNew === 0, `${beforeCount} → ${afterNew} 条`);
check("新对话后显示空态占位", (await fdoc(`return !!document.querySelector('#ai-msgs .ai-empty');`)) === true);
const cacheAfterNew = await cached();
check("新对话后本地缓存被清空", cacheAfterNew === "[]" || cacheAfterNew === null, String(cacheAfterNew));
check("新对话模式下下拉隐藏", (await fdoc(`return document.querySelector('#ai-pick').hidden;`)) === true);

// ⑤ 重载后不能"复活"：这才是「清了又回来」的真正判据
await send("Page.reload", { ignoreCache: false });
await sleep(600);
check("重载后就绪", await mount());
await sleep(1800);
const afterReload = await msgCount();
check("重载后仍然是清空的", afterReload === 0, `${afterReload} 条`);
check("重载后没有被自动拨回「选择对话」", (await pickChecked()) === false);

// ⑥ 再切回「选择对话」→ 内容应该回来（清空只针对窗口，不删记录）
const backOk = await fdoc(`return (() => {
  const r = document.querySelector('#ai-mode-reuse');
  if (!r || r.disabled) return false;
  r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); return true;
})()`);
await sleep(2000);
const backCount = await msgCount();
check("切回选择对话后内容回来", backOk && backCount > 0, `${backCount} 条`);

// ⑦ 换一条对话，窗口内容应该换成那一条
const s1 = realOpts.find((o) => /第一次对话/.test(o.t));
if (s1) {
  const switched = await fdoc(`return (() => {
    const sel = document.querySelector('#ai-pick');
    if (!sel) return false;
    sel.value = ${JSON.stringify(s1.v)};
    sel.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`);
  await sleep(2000);
  const texts = (await msgTexts()) || [];
  const joined = texts.join(" | ");
  check("选中哪条就显示哪条", switched && /第一次对话/.test(joined) && !/第二次对话/.test(joined), joined.slice(0, 120));
  const reqs = (await ev(`window.__HIST_REQS || []`)) || [];
  check("历史请求带上了选中的会话 id", reqs.some((r) => r.sessionId === s1.v),
    JSON.stringify(reqs.slice(-2)));
} else {
  console.log("（没找到第一条对话，跳过切换检查）");
}

// ⑧ 文案不该再出现「继续上次」
const barText = (await fdoc(`return (document.querySelector('#ai-session')||{}).textContent || '';`)) || "";
check("按钮文案已改为「选择对话」", /选择对话/.test(barText), barText.replace(/\s+/g, " ").trim().slice(0, 60));
check("不再出现「继续上次」", !/继续上次/.test(barText), barText.replace(/\s+/g, " ").trim().slice(0, 60));

// ⑨ 本轮核心：选中某条对话后发消息，必须真的接进那一条。
//
// 用户的原话是「选择对话并不能实际上选择接入的对话」—— 下拉能选中、历史也能换，
// 但发出去的消息进了新会话。所以这里不看界面，只看真正发出去的那份请求体。
const listReqs = (await ev(`window.__LIST_REQS || []`)) || [];
check("前端向插件问过会话清单", listReqs.length > 0, JSON.stringify(listReqs.slice(-1)));
check("清单请求带上了看板目录", !!(listReqs.length && listReqs[0].dir), JSON.stringify(listReqs.slice(-1)));

// 确保停在「选择对话」且选中第一条（SID1）
await fdoc(`return (() => {
  const r = document.querySelector('#ai-mode-reuse');
  if (r && !r.disabled) { r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); }
  return true;
})()`);
await sleep(600);
const sendOk = await fdoc(`return (() => {
  const sel = document.querySelector('#ai-pick');
  const inp = document.querySelector('#ai-input');
  const btn = document.querySelector('#ai-send');
  if (!sel || !inp || !btn) return false;
  sel.value = ${JSON.stringify(SID1)};
  sel.dispatchEvent(new Event('change', {bubbles:true}));
  inp.value = '接进这条对话试试';
  inp.dispatchEvent(new Event('input', {bubbles:true}));
  btn.click();
  return true;
})()`);
await sleep(1200);
const askBodies = (await fdoc(`return window.__ASK_BODIES || []`)) || [];
const lastAsk = askBodies[askBodies.length - 1];
check("发消息时确实带上了选中的会话 id",
  !!(sendOk && lastAsk && lastAsk.reuseSessionId === SID1),
  lastAsk ? `reuseSessionId=${JSON.stringify(lastAsk.reuseSessionId)}` : "没有发出请求");
check("接进旧对话时不再当作新会话", !!(lastAsk && lastAsk.fresh === false),
  lastAsk ? `fresh=${JSON.stringify(lastAsk.fresh)}` : "没有发出请求");

// ⑩ 切回「新对话」再发：必须不带 reuseSessionId（不能偷偷接进旧会话）
await fdoc(`return (() => {
  const r = document.querySelector('#ai-mode-new');
  if (r) { r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); }
  return true;
})()`);
await sleep(500);
await fdoc(`return (() => {
  const inp = document.querySelector('#ai-input');
  const btn = document.querySelector('#ai-send');
  if (!inp || !btn) return false;
  inp.value = '开一条新的';
  inp.dispatchEvent(new Event('input', {bubbles:true}));
  btn.click(); return true;
})()`);
await sleep(1200);
const ask2 = ((await fdoc(`return window.__ASK_BODIES || []`)) || []).slice(-1)[0];
check("新对话发消息时不带旧会话 id", !!(ask2 && !ask2.reuseSessionId),
  ask2 ? `reuseSessionId=${JSON.stringify(ask2.reuseSessionId)}` : "没有发出请求");
check("新对话发消息时按新会话处理", !!(ask2 && ask2.fresh === true),
  ask2 ? `fresh=${JSON.stringify(ask2.fresh)}` : "没有发出请求");

// ⑪ 本轮核心之二：从某条问题点进去，要优先对应到**这条问题**自己的对话，
//    而不是「这个目录里最近谁聊过」。
//
// 做法：把清单换成按条目标题的（真实插件就是这么起名的：`OPS-030 · 时间 · 标题`），
// 找一条真实存在的台账条目点「问 AI」，断言选中的是它自己那条会话。
const itemId = (await fdoc(`return (() => {
  const b = document.querySelector('[data-ask]');
  return b ? b.getAttribute('data-ask') : '';
})()`)) || "";

if (!itemId) {
  console.log("（本板没有单条 data-ask，跳过条目认领检查）");
} else {
  const OTHER = "sess-000000000001";
  const MINE = "sess-111111111111";
  // 清单里故意把「别的条目的、更新的」排在前面 —— 按"最近更新"就会选错。
  await ev(`window.__LIST_ITEMS = ${JSON.stringify([
    { id: SID2, title: "别的条目 · 最近聊过", at: 9, blank: false },
    { id: MINE, title: itemId + " · 10:20 · 这条问题自己的对话", at: 1, blank: false },
    { id: OTHER, title: "OPS-000 · 无关对话", at: 5, blank: false },
  ])}`);

  // 重新从该条目打开面板（相当于用户点条目的「问 AI」）
  await fdoc(`return (() => {
    const p = document.querySelector('#ai-panel');
    if (p) p.classList.remove('is-open');
    const c = document.querySelector('#ai-close');
    if (c) c.click();
    return true;
  })()`);
  await sleep(300);
  await fdoc(`return (() => {
    const b = document.querySelector('[data-ask="${itemId}"]');
    if (!b) return false;
    b.click(); return true;
  })()`);
  await sleep(2200);

  const pickedId = (await fdoc(`return (document.querySelector('#ai-pick')||{}).value || '';`)) || "";
  check("从某条问题点进去选中它自己的对话", pickedId === MINE,
    `选中=${pickedId || "(空)"}，条目=${itemId}`);
  check("没有被「最近更新」的那条抢走", pickedId !== SID2, `选中=${pickedId || "(空)"}`);

  // 认领到之后，发出去的消息必须接进这一条
  await fdoc(`return (() => {
    const inp = document.querySelector('#ai-input');
    const btn = document.querySelector('#ai-send');
    if (!inp || !btn) return false;
    inp.value = '接着这条问题聊';
    inp.dispatchEvent(new Event('input', {bubbles:true}));
    btn.click(); return true;
  })()`);
  await sleep(1200);
  const ask3 = ((await fdoc(`return window.__ASK_BODIES || [];`)) || []).slice(-1)[0];
  check("发消息接进的是这条问题的对话",
    !!(ask3 && ask3.reuseSessionId === MINE),
    ask3 ? `reuseSessionId=${JSON.stringify(ask3.reuseSessionId)}` : "没有发出请求");
}

// ⑫ 「待处理风险」右侧的「风险审核」：和「总结项目状态」并列，但作用域只到风险车道。
//
// 要证的四件事：
//   ① 按钮在、文案对（和问题块右侧那个对称）
//   ② 点它开面板，标注的作用域是风险审核，不是整本台账
//   ③ 发出去的请求 item=__risks__（插件按它记会话），不会落到 __global__
//   ④ 问题带上的是风险条目原文，不是空壳
const riskBtnInfo = await fdoc(`return (() => {
  const b = document.querySelector('[data-ask-risks]');
  if (!b) return null;
  const sec = b.closest('section');
  const h2 = sec ? sec.querySelector('h2') : null;
  return { text: b.textContent.trim(), sectionTitle: h2 ? h2.textContent.trim() : '' };
})()`);
check("待处理风险右侧有「风险审核」按钮", !!riskBtnInfo && riskBtnInfo.text === "风险审核",
  riskBtnInfo ? `文案=${riskBtnInfo.text}，所属块=${riskBtnInfo.sectionTitle}` : "没有这个按钮");
check("它挂在「待处理风险」块里", !!riskBtnInfo && riskBtnInfo.sectionTitle === "待处理风险",
  riskBtnInfo ? riskBtnInfo.sectionTitle : "");

if (riskBtnInfo) {
  await fdoc(`return (() => {
    const c = document.querySelector('#ai-close');
    if (c) c.click();
    return true;
  })()`);
  await sleep(300);
  await fdoc(`return (() => {
    const b = document.querySelector('[data-ask-risks]');
    if (!b) return false;
    b.click(); return true;
  })()`);
  await sleep(1200);

  const ctxText = (await fdoc(`return (document.querySelector('#ai-ctx')||{}).textContent || '';`)) || "";
  check("点开后作用域标成「风险审核」", ctxText.indexOf("风险审核") === 0, `头部=${ctxText}`);

  // 快捷动作要换成本作用域那一套（不该再出现「更新台账」这种整本动作）
  const quickLabels = (await fdoc(`return Array.prototype.map.call(
    document.querySelectorAll('#ai-quick button'), function(b){ return b.textContent.trim(); });`)) || [];
  check("快捷动作换成了风险那一套", quickLabels.length > 0 && quickLabels.indexOf("更新台账") === -1,
    quickLabels.join(" / "));

  await fdoc(`return (() => {
    const inp = document.querySelector('#ai-input');
    const btn = document.querySelector('#ai-send');
    if (!inp || !btn) return false;
    inp.value = '审一下这些风险';
    inp.dispatchEvent(new Event('input', {bubbles:true}));
    btn.click(); return true;
  })()`);
  await sleep(1400);
  const askRisk = ((await fdoc(`return window.__ASK_BODIES || [];`)) || []).slice(-1)[0];
  check("请求按风险作用域记账，不落到整本台账",
    !!(askRisk && askRisk.item === "__risks__"),
    askRisk ? `item=${JSON.stringify(askRisk.item)}` : "没有发出请求");
  check("会话标题是「风险审核」", !!(askRisk && askRisk.title === "风险审核"),
    askRisk ? `title=${JSON.stringify(askRisk.title)}` : "");

  // 问题正文要带上风险条目原文：只发一句"审一下风险"，agent 还得自己去翻台账。
  const q = (askRisk && askRisk.question) || "";
  const riskIds = (await fdoc(`return (() => {
    const D = JSON.parse(document.getElementById('board-data').textContent);
    return Object.keys(D.items).filter(function(id){
      const it = D.items[id];
      return it.laneLabel === '风险' && !/^(已修复|已关闭|暂停|已解决)/.test(it.statusLabel);
    });
  })()`)) || [];
  const missing = riskIds.filter((id) => q.indexOf(id) === -1);
  check("问题里带了未收口风险条目的原文", riskIds.length > 0 && missing.length === 0,
    `风险 ${riskIds.length} 条，缺 ${missing.length ? missing.join(",") : "无"}`);

  // 最关键的一条：风险审核和整本台账必须各用一条会话，不能串。
  // 头部文案不同只说明显示对，会话键相同才是真的串了。
  const riskChatKeys = (await fdoc(`return (() => {
    return Object.keys(window.localStorage).filter(function(k){
      return k.indexOf('ops-board-chat:') === 0;
    });
  })()`)) || [];
  check("风险审核与整本台账的对话分开存",
    riskChatKeys.some((k) => k.indexOf("__risks__") > -1) &&
      riskChatKeys.filter((k) => k.indexOf("__global__") > -1).length >= 0,
    riskChatKeys.map((k) => k.split(":").pop()).join(" / "));
}

if (crashes.length) {
  console.log("\n页面异常：");
  for (const c of crashes.slice(0, 5)) console.log("  " + String(c).split("\n")[0]);
  check("无未捕获异常", false, `${crashes.length} 个`);
} else {
  check("无未捕获异常", true);
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${fails.length === 0 ? "自检通过" : "有 " + fails.length + " 项没过"}：${results.length} 项`);
ws.close();
edge.kill();
try { srv.close(); } catch {}
process.exit(fails.length === 0 ? 0 : 1);
