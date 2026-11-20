// 「每个页面每个大标题模块都能被收起」（2026-11-20 用户定）。
//
// 用户原话：「每个页面每个大标题模块，我觉得都应该是可以被收起的」。
//
// 这条测试要盯的是**覆盖面**，不是某一个模块：六个视图里凡是长得像
// 「大标题 + 正文」的块，都得有一个能点的折叠按钮，点了正文真的藏起来、
// 标题栏还在、再点能回来，而且状态按 ops-fold-<key> 记在本机。
//
// 判据刻意写成「找出所有模块，逐个验」而不是列举几个已知 id：
// 将来谁加了一个新模块却忘了用 sectionHead()，这里会直接红。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const HTML = "file:///" + join(argBoard, "dist", "index.html").replace(/\\/g, "/");

const profile = join(tmpdir(), "edge-fold-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,1200", "about:blank"], { stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let port = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { port = Number(readFileSync(pf, "utf8").split("\n")[0]); if (port) break; } }
if (!port) { console.error("Edge 没起来"); proc.kill(); process.exit(1); }
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
await new Promise((r) => (ws.onopen = r));
const crashes = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") crashes.push(JSON.stringify(m.params));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await send("Page.enable"); await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

const VIEWS = ["overview", "lane-feature", "lane-bug", "lane-risk", "closed", "skills"];

// 把「哪些块算大标题模块」这件事写成页面里的判据，六个视图共用。
// 判定：视图内每个 .section-head.is-foldable 或 .workbench-head（含 .section-fold）
// 都算一个模块；同时统计「看起来该能收但没有折叠按钮」的漏网块。
const SCAN = `(function(){
  var view = document.querySelector('.view.is-active');
  if (!view) return { err: 'no-active-view' };
  var heads = Array.prototype.slice.call(
    view.querySelectorAll('.section-head.is-foldable, .workbench-head')
  );
  var mods = heads.map(function (h) {
    var btn = h.querySelector('.section-fold[data-fold]');
    var key = btn ? btn.getAttribute('data-fold') : '';
    return {
      title: (h.querySelector('h2, h3') || {}).textContent ? h.querySelector('h2, h3').textContent.trim() : '',
      key: key,
      hasBtn: !!btn,
      canFindBody: !!btn && !!document.querySelector('[data-fold-body="' + key + '"]')
    };
  });
  // 漏网：有 .section-head 但没有折叠按钮的块（除工作台那种用 .workbench-head 的）
  var unfolable = Array.prototype.slice.call(view.querySelectorAll('.section-head'))
    .filter(function (h) { return !h.classList.contains('is-foldable'); })
    .map(function (h) { return ((h.querySelector('h2') || {}).textContent || '?').trim(); });
  return { mods: mods, unfolable: unfolable, view: view.getAttribute('data-view') };
})()`;

let totalModules = 0;
const perView = {};

// 先从 file:// 打开这块看板本身 —— 上面只开了 about:blank，
// 只改 location.hash 是没用的（同源都没有）。
await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2600);
ok(await ev(`!!document.querySelector('.view.is-active')`), "看板页面已加载（有激活视图）");

for (const view of VIEWS) {
  await ev(`location.hash = "#view-${view}"; 1`);
  await wait(700);
  const scan = await ev(SCAN);
  if (!scan || scan.err) { ok(false, `[${view}] 页面结构可读`, JSON.stringify(scan)); continue; }
  // 每次进页面先把折叠状态清干净，避免上一条断言留下的 localStorage 干扰
  await ev(`(function(){
    Array.prototype.forEach.call(document.querySelectorAll('.section-fold[data-fold]'), function (b) {
      var k = b.getAttribute('data-fold');
      try { localStorage.removeItem('ops-fold-' + k); } catch (e) {}
    });
    return 1;
  })()`);

  ok(scan.unfolable.length === 0,
    `[${view}] 没有「该能收却没有折叠按钮」的模块`,
    scan.unfolable.length ? scan.unfolable.join(" / ") : (scan.mods.length + " 个模块都有按钮"));

  for (const m of scan.mods) {
    totalModules += 1;
    if (!m.hasBtn || !m.key) { ok(false, `[${view}] 「${m.title}」有折叠按钮`, JSON.stringify(m)); continue; }
    if (!m.canFindBody) { ok(false, `[${view}] 「${m.title}」的正文节点找得到`, "key=" + m.key); continue; }

    const result = await ev(`(function(){
      var key = ${JSON.stringify(m.key)};
      var btn = document.querySelector('.section-fold[data-fold="' + key + '"]');
      var body = document.querySelector('[data-fold-body="' + key + '"]');
      if (!btn || !body) return { err: 'missing' };
      var h0 = Math.round(body.getBoundingClientRect().height);
      var headStill = true;
      btn.click();
      var hidden1 = body.hasAttribute('hidden');
      var h1 = Math.round(body.getBoundingClientRect().height);
      var headVisible = !!(btn.offsetParent || btn.getClientRects().length);
      var expanded1 = btn.getAttribute('aria-expanded');
      var stored = localStorage.getItem('ops-fold-' + key);
      var headStillAfter = !!(document.querySelector('.section-fold[data-fold="' + key + '"]') &&
        (document.querySelector('.section-fold[data-fold="' + key + '"]').getClientRects().length));
      btn.click();
      var hidden2 = body.hasAttribute('hidden');
      var h2 = Math.round(body.getBoundingClientRect().height);
      return { h0: h0, h1: h1, h2: h2, hidden1: hidden1, hidden2: hidden2,
               expanded1: expanded1, stored: stored, headVisible: headVisible, headStillAfter: headStillAfter };
    })()`);
    if (!result || result.err) { ok(false, `[${view}] 「${m.title}」折叠可读`, JSON.stringify(result)); continue; }

    const collapsedOk = result.hidden1 === true && result.h1 < Math.max(result.h0, 1);
    const restoredOk = result.hidden2 === false && result.h2 === result.h0;
    const headKept = result.headVisible === true && result.headStillAfter === true;
    const ariaOk = result.expanded1 === "false";
    const storedOk = result.stored === "1";
    ok(collapsedOk && restoredOk && headKept && ariaOk && storedOk,
      `[${view}] 「${m.title}」能收起再展开${collapsedOk ? "" : "（正文没藏住）"}${restoredOk ? "" : "（没恢复）"}${headKept ? "" : "（标题栏跟着没了）"}${ariaOk ? "" : "（aria 没更新）"}${storedOk ? "" : "（状态没记住）"}`,
      `${result.h0}→${result.h1}→${result.h2}px · hidden=${result.hidden1}/${result.hidden2} · aria=${result.expanded1} · stored=${result.stored}`);
  }
}

ok(totalModules >= 8, "六个视图里的模块都被覆盖到（不是只测了一两个）", totalModules + " 个模块");

console.log("\n[7] 刷新后折叠状态保持（记在本机，不是一次性的）");
await ev(`location.hash = "#view-overview"; 1`);
await wait(600);
const pKey = await ev(`(function(){
  var b = document.querySelector('.section-fold[data-fold]');
  if (!b) return '';
  var k = b.getAttribute('data-fold');
  b.click();
  return k;
})()`);
if (pKey) {
  await wait(200);
  await send("Page.navigate", { url: HTML + "#view-overview" });
  await wait(2000);
  const persisted = await ev(`(function(){
    var key = ${JSON.stringify(pKey)};
    var btn = document.querySelector('.section-fold[data-fold="' + key + '"]');
    var body = document.querySelector('[data-fold-body="' + key + '"]');
    return { found: !!btn, hidden: body ? body.hasAttribute('hidden') : null, aria: btn ? btn.getAttribute('aria-expanded') : null };
  })()`);
  ok(persisted && persisted.found && persisted.hidden === true && persisted.aria === "false",
    "刷新后被收起的那块仍是收起的", JSON.stringify(persisted));
  // 收尾：把它展开回去，别把 localStorage 留给下一条测试
  await ev(`(function(){
    var btn = document.querySelector('.section-fold[data-fold="' + ${JSON.stringify(pKey)} + '"]');
    if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    try { localStorage.removeItem('ops-fold-' + ${JSON.stringify(pKey)}); } catch (e) {}
    return 1;
  })()`);
} else {
  ok(true, "[跳过] 总览页没找到折叠按钮（结构可能变了）");
}

console.log("\n[8] 跳到被收起的模块里的条目会自动展开那一块");
// 场景：用户先把「问题修复」页某个阶段收起来，然后从表格点条目标题跳进来 ——
// 不展开的话跳过去只有一行标题，等于跳了个寂寞。
await ev(`location.hash = "#view-lane-bug"; 1`);
await wait(600);
const jumpRes = await ev(`(function(){
  var btn = document.querySelector('.view.is-active .section-fold[data-fold]');
  if (!btn) return { skip: true };
  var key = btn.getAttribute('data-fold');
  var body = document.querySelector('[data-fold-body="' + key + '"]');
  if (!body) return { skip: true };
  var card = body.querySelector('[id]');
  if (!card) return { skip: true };
  var cardId = card.id;
  btn.click();                                  // 先收起来
  var collapsedNow = body.hasAttribute('hidden');
  location.hash = '#' + cardId;                 // 走页面自己的锚点跳转
  return { skip: false, key: key, cardId: cardId, collapsedNow: collapsedNow };
})()`);
if (jumpRes && !jumpRes.skip) {
  await wait(900);
  const afterJump = await ev(`(function(){
    var key = ${JSON.stringify(jumpRes.key)};
    var body = document.querySelector('[data-fold-body="' + key + '"]');
    var btn = document.querySelector('.section-fold[data-fold="' + key + '"]');
    return { hidden: body ? body.hasAttribute('hidden') : null, aria: btn ? btn.getAttribute('aria-expanded') : null };
  })()`);
  ok(jumpRes.collapsedNow === true, "先把它收起来了（否则这条验不到）", jumpRes.key);
  ok(afterJump && afterJump.hidden === false && afterJump.aria === "true",
    "跳到块内条目时那块自动展开（不会只看到一行标题）", JSON.stringify(afterJump));
} else {
  ok(true, "[跳过] 该页第一个模块里没有可跳的条目");
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 120) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
