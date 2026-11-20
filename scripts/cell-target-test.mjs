// 阶段格子的落点必须和**目标分组的标题**对得上（2026-11-20 用户报的 bug）。
//
// 用户原话：「新增功能页面，点击暂停跳转到 已修复/已关闭/暂停 页面显示的类别是已关闭而不是暂停，
// 检查下其他页面的跳转有没有这样的问题」
//
// 根因：三十五改把收口页按**状态**重划成三组（已解决 / 已上线 / 已暂停），
// 不再是「一个车道一组」。但车道页那两处格子还在用 `stage-<lane>-closed` 拼落点
// —— 那是按**车道**拼的。于是需求车道的「暂停」指向 #stage-feature-closed（已上线组），
// 点过去看到的是「已上线」那一组的内容。
//
// 这条测试的判据刻意做成**通用**的，不写死任何具体映射：
//   对每一页的每一个已收口格子，拿它的 href 找到目标分组，读出那个分组的标题，
//   再断言「格子名字 == 分组标题（或属于该分组的合理归属）」。
//
// 具体规则：格子名与分组标题**必须一致**，只有一种例外 ——
// 合并组（「已暂停」）可以收下不同名字的阶段（暂停 / 已解除 / 已知并接受），
// 这时要求**格子名出现在该分组的说明文字里**（分组 meta 会列出「暂停 3 · 已解除 1 …」）。
// 这样既抓得住错位，又不会把合法的合并组误判成错。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const PAGE = join(argBoard, "dist", "index.html");
if (!existsSync(PAGE)) { console.error("没有 dist/index.html"); process.exit(1); }
const HTML = "file:///" + PAGE.replace(/\\/g, "/");

const profile = join(tmpdir(), "edge-celltarget-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--allow-file-access-from-files", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let cport = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { cport = Number(readFileSync(pf, "utf8").split("\n")[0]); if (cport) break; } }
if (!cport) { console.error("Edge 没起来"); proc.kill(); process.exit(1); }
const list = await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json();
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

await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2400);

// 收集：收口页每个分组的 {id, label, meta}
const groups = JSON.parse(await ev(`JSON.stringify((function(){
  var v = document.querySelector('[data-view="closed"]');
  return Array.prototype.slice.call(v.querySelectorAll('.detail-group')).map(function(g){
    var h2 = g.querySelector('.section-head h2');
    var meta = g.querySelector('.section-head > span');
    return { id: g.id, label: h2 ? h2.textContent.trim() : '', meta: meta ? meta.textContent.trim() : '' };
  });
})())`));
console.log("收口页分组：" + groups.map((g) => g.id + "=「" + g.label + "」").join(" · "));

// 收集：三个车道页里所有已收口格子（指向 closed 页的）
const cells = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ['bug','feature','risk'].forEach(function(k){
    var view = document.querySelector('[data-view="lane-' + k + '"]');
    if (!view) return;
    Array.prototype.slice.call(view.querySelectorAll('.stage-board-cell')).forEach(function(c){
      var href = c.getAttribute('href') || '';
      if (c.tagName !== 'A') { out.push({ lane: k, label: '', static: true, href: '' }); return; }
      // 只关心跳到收口页的（href 不在本页里的那些）
      var isClosedTarget = /-closed$|-other$/.test(href);
      out.push({
        lane: k,
        label: (c.querySelector('span') || {}).textContent || '',
        n: Number((c.querySelector('b') || {}).textContent || 0),
        href: href, isClosedTarget: isClosedTarget
      });
    });
  });
  return out;
})())`));

const closedCells = cells.filter((c) => !c.static && c.isClosedTarget);
console.log("\n已收口格子：" + closedCells.map((c) => c.lane + "/" + c.label + "→" + c.href).join(" · "));

console.log("\n[1] 每个已收口格子的落点，标题必须对得上");
const bad = [];
for (const c of closedCells) {
  const gid = c.href.slice(1);
  const g = groups.find((x) => x.id === gid);
  if (!g) { bad.push({ ...c, why: "目标分组不存在（死链）" }); continue; }
  if (c.label === g.label) continue;                     // 名字完全一致，最佳
  // 合并组允许：格子名出现在分组说明里（「暂停 3 · 已解除 1 …」）
  if (g.meta && g.meta.indexOf(c.label) > -1) continue;
  bad.push({ ...c, why: "落到「" + g.label + "」组，但格子上写的是「" + c.label + "」" });
}
ok(bad.length === 0, "全部对得上（同名，或属于该合并组的说明里）",
  bad.length ? JSON.stringify(bad) : closedCells.length + " 个格子全部正确");

console.log("\n[2] 具体盯住用户报的那一条：需求页「暂停」");
const pausedCell = closedCells.find((c) => c.lane === "feature" && c.label === "暂停");
if (!pausedCell) {
  ok(true, "[跳过] 这块板需求车道没有「暂停」格子（可能 0 项或没配这个阶段）");
} else {
  const gid = pausedCell.href.slice(1);
  const g = groups.find((x) => x.id === gid);
  ok(!!g, "「暂停」有落点", pausedCell.href);
  ok(g && g.label === "已暂停", "落到「已暂停」组（不是「已上线」/「已关闭」）",
    g ? g.label : "(不存在)");
  // 反证：不能落到「已上线」那一组
  const shipped = groups.find((x) => x.label === "已上线");
  ok(!shipped || gid !== shipped.id, "没有落到「已上线」组", "已上线组=" + (shipped ? shipped.id : "(无)"));
}

console.log("\n[3] 三个车道逐个：已收口格子不能互相串组");
const byLane = {};
for (const c of closedCells) {
  (byLane[c.lane] = byLane[c.lane] || []).push(c.label + "→" + c.href);
}
for (const k of Object.keys(byLane)) {
  console.log("    " + k + ": " + byLane[k].join(" · "));
}
// 需求车道如果同时有「已上线」和「暂停」，它们**必须**去不同的组
const featShipped = closedCells.find((c) => c.lane === "feature" && c.label === "已上线");
const featPaused = closedCells.find((c) => c.lane === "feature" && c.label === "暂停");
if (featShipped && featPaused) {
  ok(featShipped.href !== featPaused.href,
    "需求页「已上线」和「暂停」指向**不同**的分组（以前两个都指向同一个）",
    featShipped.href + " vs " + featPaused.href);
} else {
  ok(true, "[跳过] 需求车道没有同时存在这两个格子");
}

console.log("\n[4] 点一下真的跳过去，且页面上的分组标题就是格子的名字");
if (pausedCell) {
  await send("Page.navigate", { url: HTML + "#view-lane-feature" });
  await wait(1800);
  const clicked = JSON.parse(await ev(`JSON.stringify((function(){
    var view = document.querySelector('[data-view="lane-feature"]');
    var cell = Array.prototype.slice.call(view.querySelectorAll('.stage-board-cell')).filter(function(c){
      return c.tagName === 'A' && (c.querySelector('span') || {}).textContent === '暂停';
    })[0];
    if (!cell) return { err: 'no-cell' };
    var href = cell.getAttribute('href');
    cell.click();
    return { href: href };
  })())`));
  if (clicked.err) ok(false, "找得到「暂停」格子", clicked.err);
  else {
    await wait(1100);
    const landed = JSON.parse(await ev(`JSON.stringify((function(){
      var act = document.querySelector('.view.is-active');
      var gid = ${JSON.stringify(clicked.href)}.slice(1);
      var el = document.getElementById(gid);
      var h2 = el ? el.querySelector('.section-head h2') : null;
      return {
        active: act ? act.getAttribute('data-view') : null,
        groupId: gid,
        groupLabel: h2 ? h2.textContent.trim() : '(找不到)',
        inClosedView: !!(el && el.closest('[data-view="closed"]'))
      };
    })())`));
    ok(landed.active === "closed", "跳到收口页", landed.active);
    ok(landed.inClosedView === true, "落点在收口页里", landed.groupId);
    ok(landed.groupLabel === "已暂停", "落点分组的标题就是「已暂停」（点「暂停」看到的是暂停）",
      landed.groupLabel);
  }
} else {
  ok(true, "[跳过] 没有「暂停」格子，跳过点击验证");
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
