#!/usr/bin/env node
/**
 * 独立对话窗的端到端验收：真的开一个系统浏览器窗口（headless Edge 代替），
 * 地址就是「弹窗」按钮算出来的那个 —— Harness 的 http 源 + 看板代理路径 + ?chat=1。
 *
 * 验两件真事：
 *   ① 这一份页面在 http 源下起得来，且只显示对话框（data-chat / 骨架藏掉）；
 *   ② 在它里面真问一句，回答真的回到这个窗口里（走 /ops-board/ask + SSE 广播）。
 *
 * ② 是关键：之前所有断言都只证明「窗口画得像窗口」，没有一条证明
 * 「在窗口里问的问题真的有人回答」。
 *
 * 用法：node standalone-e2e.mjs [--board <id>] [--wait <秒>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

// --board 收两种写法：看板 id（在默认根下找）或看板目录的绝对路径。
const BOARD_ARG = arg('board', 'cyber-egg-basket');
const ROOT = /[\\/]/.test(BOARD_ARG)
  ? resolve(BOARD_ARG)
  : resolve('D:/WorkSpace-Tools/ops-board-reports', BOARD_ARG);
const BOARD = ROOT.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const WAIT_S = Number(arg('wait', '150'));
const OUT = join(ROOT, '.uitest', 'e2e');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe',
  'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('找不到 msedge.exe');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (n, d) => {
  pass += 1;
  console.log(`✓ ${n}${d ? ' — ' + d : ''}`);
};
const bad = (n, d) => {
  fail += 1;
  console.log(`✗ ${n}${d ? ' — ' + d : ''}`);
};

// 1) 拿 origin（就是「弹窗」按钮用的那个源）
const state = await (await fetch('http://127.0.0.1:1534/ops-board/state', { cache: 'no-store' })).json();
const origin = String(state.origin || '').replace(/\/+$/, '');
const board = (state.boards || []).find((b) => b.id === BOARD);
if (!origin || !board || !board.ready) {
  console.error('看板没就绪：', origin, board && board.ready);
  process.exit(2);
}
const URL = `${origin}${board.proxy}?chat=1`;
console.log('独立窗地址：' + URL);
console.log('askListeners：' + state.askListeners);

// 2) 开一个真的浏览器窗口
const profile = join(OUT, 'profile-' + Date.now().toString(36));
mkdirSync(profile, { recursive: true });
const edge = spawn(
  EDGE,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--disable-extensions',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=760,900', URL,
  ],
  { stdio: 'ignore' },
);

let port = 0;
for (let i = 0; i < 60; i += 1) {
  const marker = join(profile, 'DevToolsActivePort');
  if (existsSync(marker)) {
    const t = readFileSync(marker, 'utf8').split(/\r?\n/);
    if (t[0] && Number(t[0]) > 0) {
      port = Number(t[0]);
      break;
    }
  }
  await sleep(200);
}

let target = null;
for (let i = 0; i < 40 && port; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) {
  edge.kill();
  console.error('连不上调试端口');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
let seq = 0;
const wait = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
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
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await sleep(2500);

try {
  // ── ① 独立窗真的拿到了 Harness 注入的上下文 ──────────────────
  const env = await ev('window.__OPS_HARNESS__ || null');
  if (env && env.id === BOARD) ok('独立窗拿到了 __OPS_HARNESS__（知道自己属于哪块板）', env.id);
  else bad('独立窗拿到了 __OPS_HARNESS__', JSON.stringify(env));

  const chat = await ev('document.documentElement.getAttribute("data-chat")');
  if (chat === '1') ok('?chat=1 生效，只剩对话框');
  else bad('?chat=1 生效', String(chat));

  const hidden = await ev(`(() => {
    const sels = ['.topbar', '.masthead', '.nav', '.layout', '.finder', '.settings'];
    return sels.filter((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
  })()`);
  if (Array.isArray(hidden) && hidden.length === 0) ok('整页骨架全部不显示');
  else bad('整页骨架全部不显示', JSON.stringify(hidden));

  const fill = await ev(`(() => {
    const p = document.getElementById('ai-panel');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             vw: innerWidth, vh: innerHeight };
  })()`);
  if (fill.x === 0 && fill.y === 0 && Math.abs(fill.w - fill.vw) <= 2) {
    ok('对话框铺满整个浏览器窗口', JSON.stringify(fill));
  } else {
    bad('对话框铺满整个浏览器窗口', JSON.stringify(fill));
  }

  // ── ② 在这个窗口里真问一句 ────────────────────────────────────
  const asked = await ev(`(() => {
    const box = document.getElementById('ai-input');
    if (!box) return { error: 'no input' };
    box.value = '独立窗口连通性自检：请只回复这四个字——收到收到';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.getElementById('ai-send');
    if (!btn) return { error: 'no send' };
    btn.click();
    return { ok: true };
  })()`);
  if (asked && asked.ok) ok('问题已经发出去（点了发送）');
  else bad('问题已经发出去', JSON.stringify(asked));

  // 等回答：气泡从「正在回答…」变成正文，或报错
  const deadline = Date.now() + WAIT_S * 1000;
  let answer = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    const snap = await ev(`(() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const last = msgs.filter((m) => m.className.indexOf('ai') >= 0).pop();
      const pending = !!document.querySelector('.is-pending');
      return {
        count: msgs.length,
        pending: pending,
        text: last ? (last.innerText || '').slice(0, 400) : '',
        cls: last ? last.className : '',
        hint: (document.getElementById('ai-hint') || {}).textContent || '',
      };
    })()`);
    if (snap && snap.text && !snap.pending && snap.text.indexOf('正在回答') < 0) {
      answer = snap;
      break;
    }
    if (snap && snap.cls && snap.cls.indexOf('msg-error') >= 0) {
      answer = snap;
      break;
    }
  }

  if (answer && answer.text && answer.text.indexOf('正在回答') < 0 && answer.cls.indexOf('msg-error') < 0) {
    ok('回答真的回到了这个独立窗口', JSON.stringify(answer.text.slice(0, 120)));
  } else if (answer) {
    // 报错也要把原文摆出来 —— 「窗口能开但问不了」是最该被看见的失败。
    bad('回答真的回到了这个独立窗口', JSON.stringify(answer).slice(0, 400));
  } else {
    bad('回答真的回到了这个独立窗口', `等了 ${WAIT_S}s 没有任何回答（hint / pending 见下）`);
    const snap = await ev(`(() => ({
      html: (document.getElementById('ai-msgs') || {}).innerHTML ? 'yes' : 'no',
      hint: (document.getElementById('ai-hint') || {}).textContent || '',
      text: [ ...document.querySelectorAll('.msg') ].map((m) => m.innerText.slice(0, 200)),
    }))()`);
    console.log('  现场：' + JSON.stringify(snap).slice(0, 600));
  }

  // ── ③ 截图留证 ────────────────────────────────────────────────
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) {
      const file = join(OUT, 'standalone-' + BOARD + '.png');
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      ok('截图已保存', file);
    }
  } catch (e) {
    bad('截图', String(e && e.message));
  }

  if (errors.length === 0) ok('全程没有 JS 报错');
  else bad('全程没有 JS 报错', JSON.stringify(errors.slice(0, 3)));
} finally {
  console.log(`\n${pass} 项通过 · ${fail} 项失败`);
  try {
    ws.close();
  } catch {}
  edge.kill();
  process.exit(fail === 0 ? 0 : 1);
}

