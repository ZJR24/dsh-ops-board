// 二十改的三件事，各验一条真行为：
//   ① 需求车道「计划中」右侧的「和 AI 谈谈要加什么」在，且**挂在「计划中」这个分节标题里**
//      （不是挂在 .stage-board 数字格里 —— 那是第 4 项，用户当场撤回了，这里顺带钉死）。
//   ② 点它开面板，作用域是「新增功能 · 只谈需求车道」，**不是**整本台账 / 风险审核。
//   ③ 发出去的请求 item = "__feature__"（插件按它记会话），且问题里带上需求条目原文
//      ——「已上线」的也要带上，否则 AI 会把已有功能当缺口重复建议。
//   ④ 各页第一个模块都是状态表（二十一改）：问题页 / 风险页的状态表排在「待处理」块**之前**，
//      收口页 / Skill 页也各自有状态表且排在第一个；总览页一张表都没有。
//
// 用真实 Edge + CDP，装一个假 Harness（只拦 /ops-board/ask 与 /ops-board/sessions），
// 因为这几件事都发生在「点一下」之后，静态读 HTML 验不到。
//
// 端口：9245（本项目其他测试用 8797/8799/9233/9241… 这里单独占一个，串行跑）

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket");
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) {
  console.error("没有 dist/index.html，先渲染：" + PAGE);
  process.exit(1);
}

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  process.exit(1);
}

const BOARD_ID = "stage-ask-" + Date.now().toString(36);
const profile = join(tmpdir(), "edge-stage-ask-" + Date.now());
mkdirSync(profile, { recursive: true });

const proc = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1400,1200",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let port = null;
for (let i = 0; i < 120; i++) {
  await wait(150);
  if (existsSync(pf)) {
    port = Number(readFileSync(pf, "utf8").split("\n")[0]);
    if (port) break;
  }
}
if (!port) {
  console.error("Edge 没起来（拿不到 DevToolsActivePort）");
  proc.kill();
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === "page");
if (!target) {
  console.error("没有可用的 page target");
  proc.kill();
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res) => {
    const i2 = ++id;
    pending.set(i2, res);
    ws.send(JSON.stringify({ id: i2, method: m, params: p }));
  });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await send("Page.enable");
await send("Runtime.enable");

const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) {
    pass++;
    console.log("  ✓ " + m + (extra ? " — " + extra : ""));
  } else {
    fail++;
    console.log("  ✗ " + m + (extra ? " — " + extra : ""));
  }
};

// 假 Harness：只拦两个端点，其余照原样走（file:// 下没有别的请求）。
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__OPS_HARNESS__ = { id: ${JSON.stringify(BOARD_ID)}, dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))}, label: "测试板" };
    var rf = window.fetch;
    window.fetch = function (url, opts) {
      var u = typeof url === "string" ? url : (url && url.url) || "";
      if (u.indexOf("/ops-board/sessions") === 0) {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
      }
      if (u.indexOf("/ops-board/ask") === 0) {
        try {
          window.__ASK_BODY = JSON.parse(opts.body);
        } catch (e) {}
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, askId: (window.__ASK_BODY||{}).askId }); } });
      }
      return rf.apply(window, arguments);
    };
  `,
});

const crashes = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") crashes.push(JSON.stringify(m.params));
});

await send("Page.navigate", { url: "file:///" + PAGE.replace(/\\/g, "/") + "#view-lane-feature" });
await wait(2600);

// ── ① 按钮在「计划中」的分节标题里 ──────────────────────────────
console.log("\n[1] 需求车道「计划中」右侧有入口按钮");
const where = await ev(`(function(){
  var b = document.querySelector('[data-ask-feature]');
  if (!b) return null;
  var head = b.closest('.section-head');
  var grp = b.closest('.detail-group');
  var h2 = head ? head.querySelector('h2') : null;
  var inNum = !!b.closest('.stage-board');
  return {
    text: b.textContent.trim(),
    headTitle: h2 ? h2.textContent.trim() : '',
    groupId: grp ? grp.id : '',
    inStageBoard: inNum
  };
})()`);
ok(!!where, "页面上有这个按钮");
if (where) {
  ok(where.text === "和 AI 谈谈要加什么", "文案对", where.text);
  ok(where.headTitle === "计划中", "挂在「计划中」分节标题里", where.headTitle);
  ok(where.groupId === "stage-feature-planned", "就在 planned 那一段", where.groupId);
  // 第 4 项（去掉数字区表单）已被用户撤回，这条断言防它被误删/误搬
  ok(where.inStageBoard === false, "不在 .stage-board 数字格里（第 4 项已撤回，别搬过去）");
}

// 空阶段是常态：确认它即使 0 项也照样在（这是它存在的理由）
const emptyOk = await ev(`(function(){
  var grp = document.getElementById('stage-feature-planned');
  if (!grp) return null;
  var empty = !!grp.querySelector('.stage-empty');
  var btn = !!grp.querySelector('[data-ask-feature]');
  return { empty: empty, btn: btn, n: grp.querySelectorAll('.detail-card').length };
})()`);
ok(!!emptyOk && emptyOk.btn, "「计划中」为空时按钮依然在", emptyOk ? `卡片 ${emptyOk.n} 张、空提示=${emptyOk.empty}` : "");

// ── ② 点它开面板，作用域是需求车道 ────────────────────────────
console.log("\n[2] 点它 → 面板打开、作用域是「新增功能」");
await ev(`(function(){ var b=document.querySelector('[data-ask-feature]'); if(b) b.click(); return 1; })()`);
await wait(1400);
const panelState = await ev(`(function(){
  var p = document.getElementById('ai-panel');
  var ctx = document.getElementById('ai-ctx');
  return {
    open: !!p && p.classList.contains('is-open'),
    ctx: ctx ? ctx.textContent.trim() : '',
    quick: Array.prototype.map.call(document.querySelectorAll('#ai-quick button'), function(x){ return x.textContent.trim(); })
  };
})()`);
ok(panelState.open === true, "面板已打开");
ok(/^新增功能/.test(String(panelState.ctx || "")), "作用域是「新增功能 · 只谈需求车道」", panelState.ctx);
ok(String(panelState.ctx || "").indexOf("整本台账") !== 0, "没有退回整本台账", panelState.ctx);
ok(String(panelState.ctx || "").indexOf("风险审核") !== 0, "没有串成风险审核", panelState.ctx);
ok(
  (panelState.quick || []).indexOf("这个项目还缺什么功能") > -1,
  "快捷动作是需求车道那一套",
  (panelState.quick || []).join(" / ")
);

// ── ③ 发一次，验 item / title / 上下文 ────────────────────────
console.log("\n[3] 发一次：item 与上下文");
const sentOk = await ev(`(function(){
  var input = document.getElementById('ai-input');
  if (!input) return { err: 'no input' };
  input.value = '先看看现状';
  var btn = document.getElementById('ai-send');
  if (!btn || btn.disabled) return { err: 'send disabled' };
  btn.click();
  return { sent: true };
})()`);
await wait(1200);
const body = await ev(`window.__ASK_BODY || null`);
ok(!!sentOk && sentOk.sent === true, "能点发送", sentOk && sentOk.err ? sentOk.err : "");
ok(!!body, "拦到了发出去的请求");
if (body) {
  ok(body.item === "__feature__", 'item 是 "__feature__"（插件按它记会话）', body.item);
  ok(body.title === "新增功能", "title 是「新增功能」", body.title);
  const q = String(body.question || "");
  ok(q.indexOf("需求") > -1, "问题里点名需求车道", q.slice(0, 60).replace(/\n/g, " "));
  // 上下文必须覆盖**全部**需求条目，不只是未上线的那些 —— 否则 AI 会把已有功能
  // 当缺口重复建议。用台账里的条数与问题里那句「共 N 条」对照，不写死数字。
  const lead = await ev(`(function(){
    var t = ${JSON.stringify(q)}.match(/共 (\\d+) 条/);
    var D = JSON.parse(document.getElementById('board-data').textContent);
    var n = 0;
    for (var k in D.items) { if (D.items[k].laneLabel === '需求') n += 1; }
    return { said: t ? Number(t[1]) : null, real: n };
  })()`);
  ok(!!lead && lead.said === lead.real, "上下文覆盖全部需求条目（含已上线/暂停）",
    lead ? `问题里说 ${lead.said} 条，台账实际 ${lead.real} 条` : "");
  // 每条都要有编号行，随便抽一条台账里真实存在的需求验证确实被带上
  const oneId = await ev(`(function(){
    var D = JSON.parse(document.getElementById('board-data').textContent);
    for (var k in D.items) { if (D.items[k].laneLabel === '需求') return k; }
    return null;
  })()`);
  if (oneId) ok(String(body.question).indexOf("【" + oneId + "】") > -1, `带上了真实条目的原文（${oneId}）`);
}

// ── ④ 每个页面的第一个模块都是状态表 ──────────────────────────
//
// 二十改时用户要的是「待处理块第一行第一模块」，二十一改**反转**了：
// 现在要求「各个页面显示各个状态的状态表应该是第一个模块」，
// 待处理块 / 「问 AI」只是紧跟在它后面。两种说法都靠同一条判据落地 ——
// 状态表（.stage-board，是 div 不是 section）必须排在页面里所有 section 之前。
console.log("\n[4] 状态表是各页第一个模块，待处理块紧随其后");
const placed = await ev(`(function(){
  function probe(sel){
    var b = document.querySelector(sel);
    if (!b) return null;
    var view = b.closest('.view');
    var main = b.closest('.details-main');
    var sec = b.closest('section');
    var h2 = sec ? sec.querySelector('h2') : null;
    // 状态表是 div，只查「第一个 section」看不出它在数字条前后，
    // 必须按文档序比一次；DOCUMENT_POSITION_FOLLOWING = 4
    //   sec.compareDocumentPosition(board) & 4 → board 在 sec 之后（旧顺序）
    //   board.compareDocumentPosition(sec) & 4 → board 在 sec 之前（现在要求这个）
    var secs = main ? Array.prototype.slice.call(main.querySelectorAll('section')) : [];
    var board = main ? main.querySelector('.stage-board') : null;
    var boardAbove = null;
    if (board && sec) boardAbove = !!(board.compareDocumentPosition(sec) & 4);
    return {
      view: view ? view.dataset.view : '',
      isFirstSection: secs.length > 0 && secs[0] === sec,
      boardAbove: boardAbove,
      hasBoard: !!board,
      secCount: secs.length,
      firstId: secs.length ? (secs[0].id || secs[0].className) : '',
      h2: h2 ? h2.textContent.trim() : ''
    };
  }
  return { bug: probe('[data-ask-global]'), risk: probe('[data-ask-risks]') };
})()`);
ok(!!placed.bug, "「总结项目状态」还在页面上");
if (placed.bug) {
  ok(placed.bug.view === "lane-bug", "它在问题修复页", placed.bug.view);
  ok(placed.bug.h2 === "待处理问题", "所属块是「待处理问题」", placed.bug.h2);
  ok(placed.bug.isFirstSection === true, "待处理块仍是页面里第一个 section（状态表是 div，不算抢位）",
    `第 1 个 section = ${placed.bug.firstId}，全页 ${placed.bug.secCount} 个`);
  ok(placed.bug.boardAbove === true, "状态表排在「待处理问题」之前（表第一、块第二）",
    placed.bug.hasBoard ? "顺序对了" : "该页无状态表");
}
ok(!!placed.risk, "「风险审核」还在页面上");
if (placed.risk) {
  ok(placed.risk.view === "lane-risk", "它在风险页", placed.risk.view);
  ok(placed.risk.h2 === "待处理风险", "所属块是「待处理风险」", placed.risk.h2);
  ok(placed.risk.isFirstSection === true, "待处理块仍是页面里第一个 section（状态表是 div，不算抢位）",
    `第 1 个 section = ${placed.risk.firstId}，全页 ${placed.risk.secCount} 个`);
  ok(placed.risk.boardAbove === true, "状态表排在「待处理风险」之前（表第一、块第二）",
    placed.risk.hasBoard ? "顺序对了" : "该页无状态表");
}

// ── ⑤ 收口页 / Skill 页的状态表 ──────────────────────────────
console.log("\n[5] 收口页与 Skill 页也把状态表放在第一个模块");
await ev(`location.hash = "#view-closed"`);
await wait(700);
const closed = await ev(`(function(){
  var v = document.querySelector('[data-view="closed"]');
  if (!v) return null;
  var main = v.querySelector('.details-main');
  var board = main.querySelector('.stage-board');
  if (!board) return { hasBoard: false };
  var cells = Array.prototype.slice.call(board.querySelectorAll('.stage-board-table > *'));
  var secs = Array.prototype.slice.call(main.querySelectorAll('.detail-group'));
  var dead = [];
  cells.forEach(function(c){
    var h = c.getAttribute('href');
    if (h && !document.getElementById(h.slice(1))) dead.push(h);
  });
  // 大数 ÷ 每格数字应能对上分组里的卡片数：两者都取自同一份台账，对不上就是算错了
  var total = Number((board.querySelector('.stage-board-num') || {}).textContent || -1);
  var cardSum = Number(cells.reduce(function(a, c){
    return a + Number((c.querySelector('b') || {}).textContent || 0);
  }, 0));
  return {
    hasBoard: true,
    boardAboveAllSections: secs.length === 0 || !!(board.compareDocumentPosition(secs[0]) & 4),
    total: total,
    cardSum: cardSum,
    cells: cells.length,
    labels: cells.map(function(c){ return (c.querySelector('span') || {}).textContent || ''; }).join(' / '),
    links: cells.filter(function(c){ return c.tagName === 'A'; }).length,
    dead: dead,
    cards: main.querySelectorAll('.detail-card, details.card').length
  };
})()`);
ok(!!closed && closed.hasBoard === true, "收口页有状态表");
if (closed && closed.hasBoard) {
  ok(closed.cells === 5, "跨车道合并成 5 格（已解决 / 已上线 / 暂停 / 已解除 / 已知并接受）", closed.labels);
  ok(closed.total === closed.cardSum, "左侧「已收口」总数等于各格之和", `${closed.total} vs ${closed.cardSum}`);
  ok(closed.dead.length === 0, "有数的格子都能点到自己那组（没有死链）", closed.dead.join(", ") || "全部可落点");
  ok(closed.boardAboveAllSections === true, "状态表排在所有分组之前（第一个模块）");
}

// 收口页那块表是新型交互：点一格只留那一组（复用车道页的阶段筛选）。
// 只在真有可点格子时才验 —— practise 板 0 收口，5 格全是静态 span，没有可点的东西。
if (closed && closed.hasBoard && closed.links > 0) {
  const filtered = await ev(`(function(){
    var main = document.querySelector('[data-view="closed"] .details-main');
    var cell = main.querySelector('.stage-board a');
    var href = cell.getAttribute('href');
    cell.click();
    var kept = main.querySelector('.detail-group.is-stage-keep');
    var dim = main.classList.contains('is-stage-filtered');
    var hint = !!main.querySelector('.stage-filter-hint');
    var lit = cell.classList.contains('is-stage-filter');
    // 再点一次应该恢复
    cell.click();
    return {
      href: href,
      dim: dim,
      keptId: kept ? kept.id : '',
      lands: !!document.getElementById(href.slice(1)),
      hint: hint,
      lit: lit,
      restored: !main.classList.contains('is-stage-filtered'),
      keptAfter: main.querySelectorAll('.is-stage-keep').length,
      boardStillVisible: !!main.querySelector('.stage-board') &&
        main.querySelector('.stage-board').offsetParent !== null
    };
  })()`);
  ok(filtered.lit === true, "点一格会点亮它", filtered.href);
  ok(filtered.dim === true && filtered.keptId === filtered.href.slice(1),
    "只留这一组（其余分组收起）", `keep=${filtered.keptId} filtered=${filtered.dim}`);
  ok(filtered.hint === true, "给出了「只看…再点恢复」的提示条");
  ok(filtered.boardStillVisible === true, "筛选时状态表本身还在（不然没法再点回去）");
  ok(filtered.restored === true && filtered.keptAfter === 0, "再点一次恢复全部");
}
await ev(`location.hash = "#view-skills"`);
await wait(700);
const skills = await ev(`(function(){
  var v = document.querySelector('[data-view="skills"]');
  if (!v) return null;
  var main = v.querySelector('.details-main');
  var board = main.querySelector('.stage-board');
  var ask = main.querySelector('[data-ask-skills]');
  if (!board) return { hasBoard: false };
  return {
    hasBoard: true,
    beforeAsk: ask ? !!(board.compareDocumentPosition(ask) & 4) : null,
    aboveGroups: (function(){
      var g = main.querySelector('.skill-group');
      return g ? !!(board.compareDocumentPosition(g) & 4) : null;
    })()
  };
})()`);
ok(!!skills && skills.hasBoard === true, "Skill 页有状态表");
if (skills && skills.hasBoard) {
  ok(skills.beforeAsk === true, "状态表排在「问 AI」块之前");
  ok(skills.aboveGroups === true, "状态表排在三个 skill 分组之前");
}
// 工作台是单实例节点：切到没有挂载点的车道页时它被收进 #wb-park，
// 所以必须先回到总览页再验 —— 在车道页上查 [data-view="overview"] [data-workbench]
// 永远是空的，那不是 bug。
await ev(`location.hash = "#view-overview"`);
await wait(900);
const overview = await ev(`(function(){
  var v = document.querySelector('[data-view="overview"]');
  if (!v) return null;
  return {
    tables: v.querySelectorAll('table').length,
    wb: !!v.querySelector('[data-workbench]'),
    one: document.querySelectorAll('[data-workbench]').length,
    text: v.textContent.replace(/\\s+/g,' ').slice(0, 120)
  };
})()`);
ok(!!overview, "总览页在");
if (overview) {
  ok(overview.tables === 0, "总览页一张表都没有（用户定的：只留工作台 + 处理记录）", `表 ${overview.tables} 张`);
  ok(overview.wb === true, "工作台仍在总览页（单实例挂载点没被搬走）");
  ok(overview.one === 1, "全站仍只有一份工作台", `${overview.one} 份`);
}

if (crashes.length) {
  ok(false, "全程无未捕获异常", `${crashes.length} 个：` + crashes[0].slice(0, 160));
} else {
  ok(true, "全程无未捕获异常");
}

ws.close();
proc.kill();
await wait(300);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
