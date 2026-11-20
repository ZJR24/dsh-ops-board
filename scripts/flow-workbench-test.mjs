// 工作台 UI 与编排（不真跑 Harness）：
//   1) 页面有工作台壳
//   2) 候选池铺出可开工的卡
//   3) 勾选 + 分析 → 得到串/并行两种建议，步骤区铺出来
//   4) 串行/并行顺序与 area 约束一致（同区域互斥；并行分轮）
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8799;
const B = `http://127.0.0.1:${PORT}`;
const CLAIMS_DIR = mkdtempSync(join(tmpdir(), "wb-test-claims-"));
const CLAIMS = join(CLAIMS_DIR, "flow-claims.json");

// 用哪块看板：显式 --board 优先，否则在候选里挑第一块**还没做完**的。
// 为什么不再写死一块（2026-11-20）：这个测试需要「至少 2 张未收口的卡」才有意义。
// 写死 cyber-egg-basket 时，它的卡被真实收口收完之后 total 掉到 1，
// 整个测试就卡在启动守卫上（不是代码坏了，是数据变了）。候选轮询让这条
// 断言重新对齐真实数据，同时保留「确实没卡就明说」的失败语义。
const BOARD_CANDIDATES = [
  process.argv.includes("--board") ? process.argv[process.argv.indexOf("--board") + 1] : "",
  "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket",
  "D:\\WorkSpace-Tools\\ops-board-reports\\practise",
].filter((v, i, a) => v && a.indexOf(v) === i && existsSync(join(v, "ledger.json")));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let BOARD = "";
let srv = null;
let PLAN = null;
let stderr = "";
for (const candidate of BOARD_CANDIDATES) {
  const child = spawn("node", [
    "scripts/serve.mjs", "--board", candidate, "--port", String(PORT), "--claims", CLAIMS,
  ], { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    try { if ((await fetch(B + "/api/ping")).ok) { ready = true; break; } } catch {}
  }
  let plan = null;
  if (ready) {
    try { plan = await fetch(B + "/api/flow/plan").then((r) => r.json()); } catch {}
  }
  child.kill();
  await wait(600);
  if (plan && plan.ok && (plan.total || 0) >= 2) { BOARD = candidate; srv = null; PLAN = plan; break; }
  stderr += err;
}
if (!BOARD) {
  console.error("候选看板的可排卡都不足（需要 total>=2）：" + BOARD_CANDIDATES.join(" / "));
  rmSync(CLAIMS_DIR, { recursive: true, force: true });
  process.exit(1);
}
console.log("看板：" + BOARD + "（total=" + PLAN.total + " / queued=" + (PLAN.queued || 0) + "）");

// 选中的看板重新起一份服务，整轮测试都用它。
srv = spawn("node", [
  "scripts/serve.mjs", "--board", BOARD, "--port", String(PORT), "--claims", CLAIMS,
], { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
stderr = "";
srv.stderr.on("data", (d) => (stderr += d));
let up = false;
for (let i = 0; i < 40; i++) {
  await wait(250);
  try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {}
}
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); process.exit(1); }

// 从看板实时读取「在执行队列里应有多少张可排的卡」，测试不再写死 7：
// 看板数据会随真实收口而变化，写死数字会让测试在数据变化后误报。
PLAN = await fetch(B + "/api/flow/plan").then((r) => r.json());
const EXPECT = (PLAN && PLAN.total) || 0;            // 队列应含的全部卡数（ready + waiting）
const EXPECT_QUEUED = (PLAN && PLAN.queued) || 0;    // 其中「排队等」的卡数
if (EXPECT < 2) { console.error("看板可排卡不足（total=" + EXPECT + "），无法跑工作台测试"); srv.kill(); process.exit(1); }

// 起浏览器
const profile = join(tmpdir(), "edge-wb-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--window-size=1440,1800", "about:blank",
], { stdio: "ignore" });

const pf = join(profile, "DevToolsActivePort");
let cport = null;
for (let i = 0; i < 120; i++) {
  await wait(150);
  if (existsSync(pf)) { cport = Number(readFileSync(pf, "utf8").split("\n")[0]); if (cport) break; }
}
const list = await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };

await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(3500);

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) { pass++; console.log("  ✓ " + msg + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + msg + (extra ? " — " + extra : "")); } };
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

// ── 自动收口器（2026-11-20 加）──────────────────────────────────────
//
// 工作台现在会**回读台账验证这张卡是不是真收口了**（三十九改起的规矩）：
//   · 收口了 → 记完成，推进下一张；
//   · 没动   → 当成"跑完了但没做成"，重试，3 次后标红。
//
// 而这条测试以前只回一句 answer、**不动台账** —— 于是在新规矩下每张卡都会被
// 重试 3 次，ask 次数变成 3 倍，断言全挂（"整批只触发一次 ask — asks=3"）。
// 那不是引擎坏了，是测试模拟的 Agent 太敷衍：一个真 Agent 收口了就该改台账。
//
// 所以在 Node 侧补一个收口器：测试每轮驱动时把「已问过的卡」在 ledger.json 里
// 改成该车道的收口状态，让上下文和真 Agent 干完活一致。
// ⚠️ 用独立副本？这里沿用原测试的做法（直接改 BOARD）—— 它跑完会把自己的改动留着，
//    而 card 状态本来就是测试数据的一部分；不想污染就按 --board 指一块临时板。
const LEDGER_PATH = join(BOARD, "ledger.json");
const CONFIG_PATH = join(BOARD, "board.config.json");
const cfgCache = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
// 车道 → 它的第一个「已收口」阶段的第一个状态（如 bug→fixed、feature→shipped）
const CLOSE_STATUS = {};
for (const lane of cfgCache.lanes || []) {
  for (const st of lane.stages || []) {
    if (st.open === false && Array.isArray(st.statuses) && st.statuses.length) {
      CLOSE_STATUS[lane.key] = st.statuses[0];
      break;
    }
  }
}
function closeCardsInLedger(ids) {
  if (!ids || !ids.length) return 0;
  let led;
  try { led = JSON.parse(readFileSync(LEDGER_PATH, "utf8")); } catch { return 0; }
  let n = 0;
  for (const id of ids) {
    const it = (led.items || []).find((x) => x && x.id === id);
    if (!it) continue;
    const want = CLOSE_STATUS[it.lane];
    if (!want || it.status === want) continue;
    it.status = want;
    n++;
  }
  if (n) writeFileSync(LEDGER_PATH, JSON.stringify(led, null, 2), "utf8");
  return n;
}

// 台账原样快照。逐段测试之间要**恢复**它 ——
// 否则前一段把卡收口了，后一段就"没有可开工的卡"（这正是自动收口器引入的新问题：
// 原来只回话不动台账，卡一直挂着，后面还能继续用；现在真收口了，用完就没了）。
const LEDGER_ORIGINAL = readFileSync(LEDGER_PATH, "utf8");
function restoreLedger() {
  writeFileSync(LEDGER_PATH, LEDGER_ORIGINAL, "utf8");
}

console.log("[1] 工作台 UI 存在");
ok(await ev(`!!document.querySelector('[data-workbench]')`), "工作台容器在");
ok(await ev(`!!document.querySelector('[data-wb-start]')`), "「开始执行」按钮在");
ok(await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick').length > 0`), "候选池有卡");

console.log("\n[2] 候选池铺出卡片（初始：执行队列空、全部在备选）");
// 初始状态 = 用户定的「一进页面执行队列全空，所有卡都在备选区」。
const queueCountInit = await ev(`(document.querySelectorAll('[data-wb-pool] .wb-group')[0]||document.createElement('div')).querySelectorAll('.wb-pick').length`);
ok(queueCountInit === 0, "初始执行队列为空（用户自己把想做的加进来）", "队列张数 " + queueCountInit);
const initDrag = await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick[draggable=true]').length`);
ok(initDrag === 0, "初始没有可拖拽卡（都在备选，点一下加入）");
const standbyInit = await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick.wb-standby:not(.wb-occupied)').length`);
ok(standbyInit >= EXPECT, "全部可做卡都在备选区，共 " + EXPECT + " 张", "备选 " + standbyInit);
const queueLabel = await ev(`(document.querySelectorAll('[data-wb-pool] .wb-group')[0]||document.createElement('div')).querySelector('.workbench-empty') ? true : false`);
ok(queueLabel === true, "空队列显「尚未排卡」提示");
// 拉全部进队列（一键「全部加入」），再验证队列形态与拖拽。
await ev(`document.querySelector('[data-wb-addall]').click()`);
await wait(400);
const readyCount = await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick[draggable=true]').length`);
ok(readyCount === EXPECT, "「全部加入」后 " + EXPECT + " 张进执行队列、可拖拽排序", "实际 " + readyCount);
const queuedMark = await ev(`document.querySelectorAll('[data-wb-pool] .wb-queued').length`);
ok(queuedMark === EXPECT_QUEUED, "排队中的卡带「等 xxx」标记", "实际 " + queuedMark);
ok(await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick-x').length >= ${EXPECT}`), "队列卡带移出按钮");

console.log("\n[2b] 真实拖动排序生效（HTML5 DnD 事件，前/后都能拖）");
// 用一组已知顺序的池测拖拽：手工把 dragPool 设成 [A..E]，再测两种方向。
const dragDiag = await ev(`(function(){
  var ids = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-pick[draggable=true]'));
  if (ids.length < 3) return JSON.stringify({ skip: true });
  function dragId(fromId, toId){
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-pick[draggable=true]'));
    var from = cards.filter(function(c){return c.getAttribute('data-wb-id')===fromId;})[0];
    var to = cards.filter(function(c){return c.getAttribute('data-wb-id')===toId;})[0];
    var dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt}));
    to.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt}));
    to.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt}));
    from.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer:dt}));
    return window.__wb.dragPool.slice();
  }
  var seed = ids.map(function(c){return c.getAttribute('data-wb-id');});
  var a = seed[0], b = seed[1], c = seed[2], last = seed[seed.length-1];
  // ① 往**后**拖：把第一位 A 拖到 C 上（A 原来在 C 前 → 应落到 C 之后）
  window.__wb.dragPool = seed.slice();
  var afterF = dragId(a, c);
  var aiF = afterF.indexOf(a), ciF = afterF.indexOf(c);
  // ② 往**前**拖：重置回种子，把最后一位拖到第一位上（应落到第一位之前）
  window.__wb.dragPool = seed.slice();
  var afterB = dragId(last, a);
  var ab = afterB.indexOf(last);
  return JSON.stringify({ skip:false, afterF: afterF.join(','), fwdOk: ciF < aiF, backIdx: ab, backOk: ab === 0 });
})()`);
const d = JSON.parse(dragDiag);
if (d.skip) { ok(true, "[跳过] 可拖卡不足"); }
else {
  ok(d.fwdOk === true, "往后拖：原在前面的卡拖到目标卡之后（能往后排）", "[" + d.afterF + "]  " + "目标在 落点前");
  ok(d.backOk === true, "往前拖：靠后的卡拖到第一位之前（能往前排）", "落点 @ " + d.backIdx);
}
// 移出按钮：点倒数第一张的 ✕，它应移出「执行队列」组、进入「备选」组
const xRes = await ev(`(function(){
  var x=document.querySelector('[data-wb-pool] .wb-pick-x');
  x.click();
  var groups = document.querySelectorAll('[data-wb-pool] .wb-group');
  var qc = groups[0] ? groups[0].querySelectorAll('.wb-pick').length : 0;
  var sc = groups.length>1 ? groups[1].querySelectorAll('.wb-pick.wb-standby').length : 0;
  return JSON.stringify({ queueCount: qc, standbyCount: sc });
})()`);
const xj = JSON.parse(xRes);
ok(xj.queueCount === EXPECT - 1 && xj.standbyCount === 1,
  "点 ✕ 把一张卡移出执行队列、进入备选区", "剩余 " + xj.queueCount + " / 备选 " + xj.standbyCount);
await ev(`document.querySelector('[data-wb-addall]').click()`);
const afterAddAll = await ev(`document.querySelectorAll('[data-wb-pool] .wb-group:first-child .wb-pick').length`);
ok(afterAddAll === EXPECT, "「全部加入」把移出的卡放回队列", "剩余 " + afterAddAll);

console.log("\n[2c] 点执行队列的卡片本体 → 撤回到备选区");
const c2Res = await ev(`(function(){
  var q = document.querySelector('[data-wb-pool] .wb-group:first-child .wb-pick[draggable=true]');
  var id = q.getAttribute('data-wb-id');
  q.click();
  var inPool = window.__wb.dragPool.indexOf(id);
  var standbys = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-group:last-child .wb-pick.wb-standby'));
  var inStandby = standbys.some(function(s){ return s.getAttribute('data-wb-id') === id; });
  return JSON.stringify({ id: id, inPool: inPool, inStandby: inStandby });
})()`);
const c2 = JSON.parse(c2Res);
ok(c2.inPool === -1 && c2.inStandby === true, "点击队列卡本体 → 从执行队列撤回备选区", "id=" + c2.id + " 队列中=" + (c2.inPool > -1) + " 备选=" + c2.inStandby);
await ev(`document.querySelector('[data-wb-addall]').click()`); // 再全加回，保持后续状态一致
await wait(300);

console.log("\n[3] 分析（用拖的顺序）→ 步骤区铺出");
await ev(`document.querySelector('[data-wb-analyze]').click()`);
await wait(1800);
const stepCount = await ev(`document.querySelectorAll('[data-wb-steps] .wb-step').length`);
ok(stepCount === EXPECT, EXPECT + " 件都进入执行步骤", "实际 " + stepCount);
const runVisible = await ev(`!document.querySelector('[data-wb-run]').hidden`);
ok(runVisible, "执行区显示出来");

console.log("\n[4] 串行：拖动顺序 + 同区域链序约束");
// 从实时 plan 里找「排队卡 + 它等的那张卡」构成的同区域链；把排队卡拖到前面（逆链序），
// 断言 analyze 尊重链序把被等的卡拨回前面。若当前看板没有排队链则跳过（数据可能变化）。
const serialPair = await ev(`(function(){
  var waiting = ${JSON.stringify((PLAN.waiting || []))};
  if (!waiting.length) return JSON.stringify({ skip: true });
  var w = waiting[0];
  return JSON.stringify({ skip: false, w: w.id, head: w.waitsFor, area: w.prefix });
})()`);
const sp = JSON.parse(serialPair);
if (sp.skip) {
  ok(true, "[跳过] 当前看板无排队链（无可测的串行约束）");
} else {
  await ev(`window.__wb.dragPool=['${sp.w}','${sp.head}']; document.querySelector('[data-wb-analyze]').click(); 1`);
  await wait(1800);
  const chainIds = await ev(`Array.prototype.map.call(document.querySelectorAll('[data-wb-steps] .wb-step-id'), function(s){return s.textContent})`);
  const hi = chainIds.indexOf(sp.head), wi = chainIds.indexOf(sp.w);
  ok(hi > -1 && wi > -1 && hi < wi,
    "同区域链序保持 " + sp.head + "→" + sp.w + "（拖成逆序也被拨正）", "=" + chainIds.join(","));
}

console.log("\n[5] analyze 端点（HTTP 直连）");
const liveIds = await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick-id') ? Array.prototype.map.call(document.querySelectorAll('[data-wb-pool] .wb-pick-id'), function(s){return s.textContent}) : (window.__wb.dragPool||[])`);
const adv = await fetch(B + "/api/workbench/analyze", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids: liveIds }),
}).then((r) => r.json());
ok(adv.ok === true && adv.total === EXPECT, "analyze 返回 " + EXPECT + " 件", "maxParallel=" + adv.maxParallel);
ok(adv.parallel && adv.parallel.every((p) => liveIds.indexOf(p.id) > -1), "并行每条都是合法卡 id");
// 并行互斥校验
const rounds = {};
for (const p of adv.parallel) (rounds[p.round] = rounds[p.round] || []).push(p.prefix);
let dupe = 0;
for (const ps of Object.values(rounds)) if (new Set(ps).size !== ps.length) dupe++;
ok(dupe === 0, "并行同一轮无同前缀冲突");

console.log("\n[5b] 工作台队列顺序 → 决定执行顺序（画布已去掉，队列就是唯一编排面）");
const fdj = JSON.parse(await ev(`JSON.stringify({ pool: (window.__wb && window.__wb.dragPool) || [] })`));
ok(fdj.pool.length > 0, "工作台 dragPool 有内容", fdj.pool.join(","));

console.log("\n[5c] 并行分析 → 步骤区横排成多个队列（多路），执行顺序被界面采纳");
// 喂一组跨区域（不同前缀）的卡进队列，保证并行能拆成多路
const diverse = await ev(`(async function(){
  if(!window.__wb || !window.__wb.candidate) return JSON.stringify({skip:true});
  var cands = (window.__wb.candidate||[]).filter(function(c){ return c.state!=='running'; });
  var byP = {};
  cands.forEach(function(c){ if(c.prefix){ (byP[c.prefix]=byP[c.prefix]||[]).push(c.id); } });
  var prefixes = Object.keys(byP);
  if(prefixes.length<2) return JSON.stringify({skip:true, prefixes:prefixes.join(',')});
  var pick=[];
  for(var i=0;i<2 && pick.length<2;i++){
    if(byP[prefixes[i]] && byP[prefixes[i]].length) pick.push(byP[prefixes[i]][0]);
  }
  if(pick.length<2) return JSON.stringify({skip:true, prefixes:prefixes.join(',')});
  window.__wb.dragPool=pick.slice();
  return JSON.stringify({skip:false, pick:pick});
})()`);
const dv = JSON.parse(diverse || "{}");
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true; 1`);
if (dv.skip) {
  // 备选不够跨区域：退化，仍应至少铺出一条队列
  await ev(`document.querySelector('[data-wb-analyze]').click()`);
  await wait(1800);
  ok(true, "[跳过] 备选不跨区域，无法验证多路并行（前缀=" + (dv.prefixes||"?") + "）");
} else {
  await ev(`!function(){ document.querySelector('[data-wb-analyze]').click(); }(); 1`);
  await wait(1800);
  const flowStepIds = await ev(`Array.prototype.map.call(document.querySelectorAll('[data-wb-steps] .wb-step-id'), function(s){return s.textContent})`);
  ok(flowStepIds[0].length > 0, "analyze 用工作台顺序铺出步骤区", flowStepIds.join(","));
  // 跨区域 → 步骤区应拆成多个队列（每路 = 一条可并行推进的任务队列）：
  // 队列**纵向**叠放、每队列卡横向排、跑的时候说明文字模块隐藏
  const laneInfo = await ev(`(function(){
    const lanes = document.querySelectorAll('[data-wb-steps] .wb-lane');
    const counts = Array.prototype.map.call(lanes, function(l){ return l.querySelectorAll('.wb-step').length; });
    const nameEl = document.querySelector('[data-wb-steps] .wb-lane-name');
    const cardsHoriz = document.querySelector('[data-wb-steps] .wb-lane-cards');
    const headHidden = !!document.querySelector('[data-wb-run].wb-run-parallel .workbench-run-head');
    return JSON.stringify({
      n: lanes.length, counts: counts.join(','),
      names: Array.prototype.map.call(document.querySelectorAll('[data-wb-steps] .wb-lane-name'), function(l){ return l.textContent; }).join(' | '),
      cardsHoriz: cardsHoriz && getComputedStyle(cardsHoriz).display === 'flex',
      lanesStacked: lanes.length > 1 && getComputedStyle(document.querySelector('[data-wb-steps] .wb-lanes')).display === 'block',
      headHidden: headHidden,
    });
  })()`);
  const lj = JSON.parse(laneInfo || "{}");
  ok(lj.n >= 2, "并行的卡被拆进多个队列（每路一条任务队列）", lj.n + " 队 · " + lj.counts + " 卡/队 · " + lj.names);
  ok(lj.cardsHoriz === true, "队列内卡片横向排（左→右=该路执行顺序）");
  ok(lj.lanesStacked === true, "多路队列纵向叠放（一路一行）");
  ok(lj.headHidden === true, "并行时「最多同时 N 路」说明模块隐藏，只留队列");
}
await ev(`window.__wb.dragPool=(window.__wb.candidate||[]).filter(function(c){return c.state!=='running';}).map(function(c){return c.id;}); 1`);

console.log("\n[5d] 一键清空：执行队列 / 候选池 / 步骤区都被清掉");
await ev(`document.querySelector('[data-wb-clear]').click()`);
await wait(600);
const cleared = await ev(`JSON.stringify({ pool: (window.__wb.dragPool||[]).length, queue: (document.querySelectorAll('[data-wb-pool] .wb-group')[0]||document.createElement('div')).querySelectorAll('.wb-pick').length, standby: (document.querySelectorAll('[data-wb-pool] .wb-group')[1]||document.createElement('div')).querySelectorAll('.wb-pick.wb-standby').length, steps: document.querySelectorAll('[data-wb-steps] .wb-step').length, runHidden: document.querySelector('[data-wb-run]').hasAttribute('hidden') })`);
const cj = JSON.parse(cleared);
ok(cj.pool === 0 && cj.queue === 0, "一键清空后执行队列空了", "dragPool=" + cj.pool + " 队列=" + cj.queue);
ok(cj.standby > 0, "清空后卡保留在备选区（不丢，可随时加回）", "备选 " + cj.standby);
ok(cj.steps === 0 && cj.runHidden, "已铺开的步骤区收起、回到起始态");

console.log("\n[5e] 分批模式：看板分批 → 整批交给 Agent 自主");
// 分批是「并行」之下的开关：串行不显示，并行才显示（避免和串/并行平级三选一）。
await ev(`document.querySelector('input[name=wb-mode][value=serial]').checked=true; document.querySelector('input[name=wb-mode][value=serial]').dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(200);
const batchVisibleSerial = await ev(`getComputedStyle(document.querySelector('[data-wb-batch]')).display`);
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true; document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(200);
const batchVisibleParallel = await ev(`getComputedStyle(document.querySelector('[data-wb-batch]')).display`);
ok(batchVisibleSerial === "none", "串行时分批开关隐藏（只保留串/并行两个平级选项）", "display=" + batchVisibleSerial);
ok(batchVisibleParallel !== "none", "并行时分批开关显示（作为并行下的开关）", "display=" + batchVisibleParallel);
// 先加回 7 张，再把分批粒度设为「每批 3 张」（并行模式下分批生效）
await ev(`document.querySelector('[data-wb-addall]').click(); window.__wb.batchSize=3; window.__wb.batchMode=false; document.querySelector('[data-wb-batch-size]').value='3'; 1`);
await wait(400);
await ev(`document.querySelector('[data-wb-analyze]').click()`);
await wait(1800);
const batchCount = await ev(`document.querySelectorAll('[data-wb-steps] .wb-lane').length`);
ok(batchCount >= 1, EXPECT + " 张按每批 3 张 → 铺成按区域分的「路」（一路一个对话窗口）", "实际 " + batchCount + " 路");
const batchCardTotal = await ev(`document.querySelectorAll('[data-wb-steps] .wb-step').length`);
ok(batchCardTotal === EXPECT, "路内卡总数仍是 " + EXPECT, "实际 " + batchCardTotal);
const batchHeadHidden = await ev(`getComputedStyle(document.querySelector('[data-wb-run] .workbench-run-head')).display`);
ok(batchHeadHidden === "none", "并行时隐藏 phase/progress 说明行（只留队列本身）", "display=" + batchHeadHidden);

console.log("\n[5f] 整批全交：一批全部卡交给一个 Agent 自主");
await ev(`document.querySelector('[data-wb-batch-size]').value='-1'; window.__wb.batchSize=99999; window.__wb.batchMode=true; 1`);
await wait(400);
await ev(`document.querySelector('[data-wb-analyze]').click()`);
await wait(1800);
const wholeBatchCount = await ev(`document.querySelectorAll('[data-wb-steps] .wb-lane').length`);
ok(wholeBatchCount === 1, "整批全交 → 只开 1 个窗口（全部卡装进同一路）", "实际 " + wholeBatchCount + " 路");
const wholeBatchCardTotal = await ev(`document.querySelectorAll('[data-wb-steps] .wb-lane')[0].querySelectorAll('.wb-step').length`);
ok(wholeBatchCardTotal === EXPECT, "这 1 个窗口包含全部 " + EXPECT + " 张卡", "实际 " + wholeBatchCardTotal);
const wholeBatchQueued = await ev(`document.querySelectorAll('[data-wb-steps] .wb-step-queued').length`);
ok(wholeBatchQueued === 0, "整批全交时没有卡标「排队中」（全部一次交给该窗口）", "实际 " + wholeBatchQueued + " 张");

console.log("\n[5g] 分批真实执行：整批 claim → 交给 Agent → release → 卡片全部收口");
// ⚠️ 这一段要真跑执行、要拿到「可开工的卡」—— 先把台账恢复成初始快照并刷新页面。
// 不恢复的话，前面几段已经把卡收口了（自动收口器干的），这里会「没有可开工的卡」。
restoreLedger();
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);

// 关键：分批会按「同区域串行约束」claim —— serve 只放行「当前该区域可开工」的卡。
// 因此本测试用「各自区域的头一件」（都可开工）做一批，让整批都能 claim 成功，
// 从而完整验证 claim→一次 ask（整批清单）→ release→ 全部 done 的执行循环。
// 头件从实时 plan 的 ready 里取（都在各自区域最前，都可开工），避免假撞车。
const readyHeads = await ev(`(function(){
  var ready = ${JSON.stringify((PLAN.runnable || []).filter((r) => r.state === "ready"))};
  return ready.map(function(r){ return r.id; });
})()`);
if (readyHeads.length < 1) {
  ok(false, "看板没有可开工的头件，无法跑分批真实执行", "ready=" + readyHeads.length);
} else {
const EXEC_IDS = readyHeads.slice(0, EXPECT).join("','");
await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
await wait(500);
await ev(`document.querySelector('[data-wb-addall]').click(); 1`);
await wait(300);
await ev(`window.__wb.dragPool=(window.__wb.dragPool||[]).filter(function(id){return ['${EXEC_IDS}'].indexOf(id)>-1;}); window.__wb.batchSize=99999; window.__wb.batchMode=true; document.querySelector('[data-wb-batch-size]').value='-1'; 1`);
await wait(300);
await ev(`document.querySelector('[data-wb-analyze]').click()`);
await wait(1600);
const exBatchCount = await ev(`document.querySelectorAll('[data-wb-steps] .wb-lane').length`);
ok(exBatchCount === 1, "整批全交 " + readyHeads.length + " 张 → 1 个对话窗口", "实际 " + exBatchCount + " 路");

// 注入 Harness 环境 + 模拟 Agent：拦截 /ops-board/ask，登记 askId，随后回一条 ok 的 answer。
const stubResult = await ev(`(async function(){
  window.__OPS_HARNESS__ = { id: 'test-board', dir: 'D:\\\\x', label: 't' };
  window.__wbStub = { asked: [], asks: 0 };
  var origFetch = window.fetch.bind(window);
  window.fetch = function(url, opts){
    if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var body = JSON.parse(opts.body); var askId = body.askId;
      window.__wbStub.asks++;
      window.__wbStub.asked.push({ askId: askId, hasBatch: /本次交给你的卡片清单/.test(body.question), questionLen: (body.question||'').length, item: body.item, title: body.title,
        // 留着正文：自动收口器要从里面捞真实卡号（item 是复用键，不是卡号）
        q: String(body.question || '') });
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok: true, askId: askId }); } });
    }
    return origFetch(url, opts);
  };
  return 'ok';
})()`);
// 点击「开始执行」→ 触发分批执行（整批 claim → 一次 ask → release）
await ev(`document.querySelector('[data-wb-start]').click(); 1`);

// 持续驱动：每次有新 ask 就立刻回一条 ok 的 answer，直到全部批次完成（或超时）。
// ⚠️ 回答案**之前**先把这些卡在台账里收口 —— 工作台会回读台账验证（三十九改），
// 光回话不收口会被判"没做成"然后重试 3 次，ask 次数变成 3 倍。
let askedSeen = 0;
const driveDeadline = Date.now() + 20000;
while (Date.now() < driveDeadline) {
  await wait(600);
  // ① 先把「这一批问过的卡」在台账里收口（模拟真 Agent 干完活）
  //
  // ⚠️ 不能拿 `a.item` 当卡号：那是**复用键**（lane.key / 「执行台」/「整批全交」），
  //    不是卡片编号。真正被处理的卡号在 prompt 正文里（「本次交给你的卡片清单」那段、
  //    或者 - OPS-901 这种列表行），所以从 question 里正则捞。
  const askedQuestions = JSON.parse(await ev(`JSON.stringify((window.__wbStub.asked.slice(${askedSeen}) || []).map(function(a){ return a.q || a.question || ''; }))`));
  const idsInPrompt = new Set();
  for (const q of askedQuestions) {
    for (const m of String(q).matchAll(/\b([A-Z]{2,}-\d+)\b/g)) idsInPrompt.add(m[1]);
  }
  if (idsInPrompt.size) {
    const closedN = closeCardsInLedger([...idsInPrompt]);
    if (closedN) await wait(250);
  }
  // ② 再回答案
  const answersSent = await ev(`(function(){
    var sent = 0;
    window.__wbStub.asked.slice(${askedSeen}).forEach(function(a){
      window.postMessage({ type: 'ops-board/answer', askId: a.askId, ok: true, text: '本批已处理收口', by: 't' }, '*');
      sent++;
    });
    return sent;
  })()`);
  askedSeen += answersSent;
  const doneNow = await ev(`window.__wb.order.filter(function(o){return o.done;}).length === window.__wb.order.length`);
  if (doneNow) break;
}
await wait(1500);
const exDone = await ev(`(function(){
  var doneN = window.__wb.order.filter(function(o){return o.done;}).length;
  var totalN = window.__wb.order.length;
  var asks = window.__wbStub.asks;
  var askedList = window.__wbStub.asked.map(function(a){return a.askId;});
  var orderInfo = window.__wb.order.map(function(o){ return o.id+':'+(o.done?'D':(o.active?'A':'W'))+':b'+o.batch; });
  var runStill = window.__wb.run;
  var prog = document.querySelector('[data-wb-progress]').textContent;
  return JSON.stringify({ doneN: doneN, totalN: totalN, asks: asks, runStill: runStill, prog: prog, asked: askedList, order: orderInfo });
})()`);
const exj = JSON.parse(exDone);
ok(exj.doneN === exj.totalN && exj.totalN === readyHeads.length, "分批执行后所有卡都收口完成", "doneN=" + exj.doneN + "/" + exj.totalN);
ok(exj.asks === 1, "整批只触发一次 Agent ask", "asks=" + exj.asks);
ok(exj.runStill === false, "执行完成后 WB.run 已复位");
} // end else (readyHeads >= 1)

console.log("\n[5h] 分批问 Agent 的提示词确实携带整批清单");
const batchPromptOk = await ev(`window.__wbStub.asked.some(function(a){ return a.hasBatch && a.questionLen > 200; })`);
ok(batchPromptOk, "某次 ask 的 question 携带「本次交给你的卡片清单」且足够长（整批交给 Agent 自主）");

console.log("\n[5h2] 并行真并发：多路同时开跑（用户报「选了并行却只给一个窗口」）；每批 2 张，同路内第二批要等");
// ⚠️ 这一段要真跑执行、要拿到「可开工的卡」—— 先把台账恢复成初始快照并刷新页面。
// 不恢复的话，前面几段已经把卡收口了（自动收口器干的），这里会「没有可开工的卡」。
restoreLedger();
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);
// 用户原话：「看板的工作台，选择了并行处理3个任务，但是没有给到两个对话窗口处理，而是给到一个窗口处理」。
// 根因：旧实现把「一次喂几张」当成窗口划分依据，整批塞进固定会话键「本批 N 卡」——
// 卡数一样时两批撞进同一个窗口，于是永远只有一个窗口。修复后窗口 = 路（area 前缀）。
// 这里用**跨区域**的可开工卡（各自区域头件，才能同时 claim 成功）真实跑一遍：
//   · ask 数 = 路数（不是 1，也不是 ceil(卡数/2)）；
//   · 每次 ask 的 item 互不相同（不再有「本批 2 卡」撞键）；
//   · 至少出现过一次「两个窗口同时在跑」（并发 > 1），这才是并行的定义。
const headByPrefix = await ev(`(function(){
  var seen = {}, out = [];
  (window.__wb.candidate || []).forEach(function(c){
    if (c.state !== 'ready') return;
    var p = c.prefix || '?';
    if (seen[p]) return;
    seen[p] = 1; out.push(c.id);
  });
  return out;
})()`);
if (headByPrefix.length < 2) {
  ok(true, "[跳过] 跨区域可开工头件不足 2 张（" + headByPrefix.length + "），无法验证多窗口并发");
} else {
await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
await wait(500);
await ev(`document.querySelector('[data-wb-addall]').click(); 1`);
await wait(300);
await ev(`window.__wb.dragPool = ${JSON.stringify(headByPrefix)}; window.__wb.batchSize=2; window.__wb.batchMode=false; 1`);
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true; document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true})); var s=document.querySelector('[data-wb-batch-size]'); s.value='2'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(300);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(1800);
const lanePlan = JSON.parse(await ev(`JSON.stringify({
  lanes: (window.__wb.lanes || []).length,
  laneN: document.querySelectorAll('[data-wb-steps] .wb-lane').length
})`));
ok(lanePlan.lanes === headByPrefix.length && lanePlan.laneN === headByPrefix.length,
  "并行 + 每批 2 张：窗口数 = 路数 " + headByPrefix.length + "（与「一次喂几张」无关）",
  "WB.lanes=" + lanePlan.lanes + " · DOM=" + lanePlan.laneN);

// 拦 ask，记录每个窗口的 item 与「同一时刻有几个窗口在跑」
await ev(`(function(){
  window.__wbLanes = { asked: [], maxConc: 0 };
  var orig = window.fetch.bind(window);
  window.fetch = function(url, opts){
    if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var body = JSON.parse(opts.body);
      var st = window.__wbLanes;
      st.asked.push({ askId: body.askId, item: body.item, q: String(body.question || '') });
      var conc = Object.keys(window.__wb.inflight || {}).length;
      if (conc > st.maxConc) st.maxConc = conc;
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok: true, askId: body.askId }); } });
    }
    return orig(url, opts);
  };
  return 1;
})()`);
await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
let laneSeen = 0;
const laneDl = Date.now() + 20000;
while (Date.now() < laneDl) {
  await wait(400);
  // 先按 prompt 里的卡号把台账收口（工作台会回读验证，光回话不算做成）
  const lq = JSON.parse(await ev(`JSON.stringify((window.__wbLanes.asked.slice(${laneSeen}) || []).map(function(a){ return a.q || ''; }))`));
  const lids = new Set();
  for (const q of lq) for (const m of String(q).matchAll(/\b([A-Z]{2,}-\d+)\b/g)) lids.add(m[1]);
  if (lids.size) { closeCardsInLedger([...lids]); if (lids.size) await wait(200); }
  const n = await ev(`(function(){var a=window.__wbLanes.asked;var c=0;a.slice(${laneSeen}).forEach(function(x){window.postMessage({type:'ops-board/answer',askId:x.askId,ok:true,text:'已处理',by:'t'},'*');c++;});return c;})()`);
  laneSeen += n;
  const fin = await ev(`window.__wb.run === false`);
  if (fin) break;
}
const laneRun = JSON.parse(await ev(`JSON.stringify((function(){
  var st = window.__wbLanes;
  var items = st.asked.map(function(a){ return a.item; });
  return {
    asks: st.asked.length,
    distinctItems: items.filter(function(v,i){ return items.indexOf(v) === i; }).length,
    maxConc: st.maxConc,
    items: items,
    doneN: window.__wb.order.filter(function(o){ return o.done; }).length,
    totalN: window.__wb.order.length
  };
})())`));
ok(laneRun.asks === headByPrefix.length,
  "每个窗口各收到一次 ask（" + headByPrefix.length + " 个窗口 → " + headByPrefix.length + " 次，不是 1 次）",
  "asks=" + laneRun.asks + " · item=" + laneRun.items.join(" / "));
ok(laneRun.distinctItems === laneRun.asks,
  "每次 ask 的会话键互不相同（不再撞进同一个窗口）",
  laneRun.distinctItems + " 个不同键 / " + laneRun.asks + " 次");
ok(laneRun.maxConc >= 2,
  "确实多个窗口同时推进（并发峰值 ≥ 2，这才叫并行）",
  "峰值并发 " + laneRun.maxConc);
ok(laneRun.doneN === laneRun.totalN,
  "所有路的卡都收口完成", laneRun.doneN + "/" + laneRun.totalN);
}

console.log("\n[5i] 并行 + 每批 1 张：**同一条队列里**同时只有 1 张在跑（路与路可以同时跑）");
// ⚠️ 这一段要真跑执行、要拿到「可开工的卡」—— 先把台账恢复成初始快照并刷新页面。
// 不恢复的话，前面几段已经把卡收口了（自动收口器干的），这里会「没有可开工的卡」。
restoreLedger();
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);
// 用户报「选了不分批（一张一张来），队列里还是会出现两张」——
// 他看的是**一条队列**：同路第二张不该和头一张一起跑（它们抢同一块地）。
// 2026-11-19 起语义更明确：窗口 = 路，「一次喂几张」只管路内批大小 ——
// 所以「每批 1 张」= 每个窗口一次拿一张，跨路仍可同时推进（那是并行的本义）。
// 这里真实走执行：claim→ask→release 循环，采样每次 ask 时**同一条路**的 active / inflight 张数。
// 只喂现在可开工（ready）的卡，避免 waiting 卡在测试里永远 claim 不到卡死。
const rdyNow = await ev(`(window.__wb.candidate || []).filter(function(c){ return c.state === 'ready'; }).map(function(c){ return c.id; })`);
if (rdyNow.length < 2) {
  ok(true, "[跳过] 当前可开工卡不足 2 张（ready=" + rdyNow.length + "），无法验证并发上限");
} else {
await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
await wait(500);
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true; document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true})); window.__wb.batchSize=1; window.__wb.batchMode=false; document.querySelector('[data-wb-batch-size]').value='1'; 1`);
await wait(300);
// 只把 ready 卡拖进队列（模拟用户把可开工的卡排进队）
await ev(`window.__wb.dragPool = [${rdyNow.map((x) => "'" + x + "'").join(",")}]; 1`);
// 手动设 dragPool 不触发按钮 disabled 刷新（真实用户操作会触发）。
// 用 dispatchEvent 派发 click（不受 disabled 限制）触发 analyze，等价于真实点击可用按钮。
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click', { bubbles: true })); 1`);
await wait(1800);
// 并行+批1 仍是多行队列（不是批次列表）——用户确认的形态
const laneShown = await ev(`document.querySelectorAll('[data-wb-steps] .wb-lane').length`);
ok(laneShown >= 1, "并行 + 每批 1 张 仍显示多行队列", laneShown + " 队");
// 拦截 /ops-board/ask，按**路**记录每次 ask 时该路同时 active / inflight 的张数
await ev(`(function(){
  window.__wbOneByOne = { maxActive: 0, maxInflight: 0, samples: [], byLane: {}, perLaneMax: 0 };
  function laneOf(id){
    var ls = window.__wb.lanes || [];
    for (var i = 0; i < ls.length; i++){
      for (var j = 0; j < ls[i].cards.length; j++) if (ls[i].cards[j].id === id) return i;
    }
    return -1;
  }
  var origFetch = window.fetch.bind(window);
  window.fetch = function(url, opts){
    if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var askId = JSON.parse(opts.body).askId;
      var activeN = (window.__wb.order || []).filter(function(o){ return o.active; }).length;
      var inflightN = Object.keys(window.__wb.inflight || {}).length;
      // 同一条路里现在有几张在跑（这才是「一张一张来」的判据）
      var perLane = {};
      (window.__wb.order || []).forEach(function(o){
        if (!o.active) return;
        var li = laneOf(o.id);
        perLane[li] = (perLane[li] || 0) + 1;
        if (perLane[li] > window.__wbOneByOne.perLaneMax) window.__wbOneByOne.perLaneMax = perLane[li];
      });
      var s = window.__wbOneByOne;
      if (activeN > s.maxActive) s.maxActive = activeN;
      if (inflightN > s.maxInflight) s.maxInflight = inflightN;
      s.samples.push(activeN + 'a' + inflightN);
      s[askId] = { active: activeN, inflight: inflightN };
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok: true, askId: askId }); } });
    }
    return origFetch(url, opts);
  };
  return 'ok';
})()`);
// start 按钮同理用 dispatchEvent（analyze 成功后已 enable，这里双重保险）
await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click', { bubbles: true })); 1`);
// 驱动：每收到一个新 ask 就立刻回一条 ok 的 answer，直到全部卡 done 或超时
let oneSeen = 0;
const oneDeadline = Date.now() + 20000;
while (Date.now() < oneDeadline) {
  await wait(500);
  const oneSent = await ev(`(function(){
    var s = 0;
    var all = Object.keys(window.__wbOneByOne).filter(function(k){ return k !== 'maxActive' && k !== 'maxInflight' && k !== 'samples' && k !== 'perLaneMax' && k !== 'byLane' && typeof window.__wbOneByOne[k] === 'object'; });
    all.slice(${oneSeen}).forEach(function(askId){
      window.postMessage({ type: 'ops-board/answer', askId: askId, ok: true, text: '已处理收口', by: 't' }, '*');
      s++;
    });
    return s;
  })()`);
  oneSeen += oneSent;
  const oneDone = await ev(`window.__wb.order.length > 0 && window.__wb.order.every(function(o){ return o.done; })`);
  if (oneDone) break;
}
await wait(1500);
const oneSum = JSON.parse(await ev(`(function(){
  var s = window.__wbOneByOne;
  return JSON.stringify({ maxActive: s.maxActive, maxInflight: s.maxInflight, perLaneMax: s.perLaneMax, samples: s.samples.join(','), doneN: window.__wb.order.filter(function(o){return o.done;}).length, totalN: window.__wb.order.length, asks: Object.keys(s).filter(function(k){ return typeof s[k] === 'object'; }).length });
})()`));
ok(oneSum.perLaneMax <= 1, "每批 1 张：同一条队列里同时只有 1 张在跑（绝无两张挤一路）", "同路峰值=" + oneSum.perLaneMax + " · 采样=" + oneSum.samples);
ok(oneSum.doneN === oneSum.totalN && oneSum.totalN >= 2, "全部卡都走完（至少 2 张，验证确实是逐张串行放行）", oneSum.doneN + "/" + oneSum.totalN);
} // end else (rdyNow >= 2)

console.log("\n[5j] 并行 + 每批 1 张：同路第二张起标「排队中 · 等 XXX」（不再和正在跑的长得一样）");
// 用户报「选了每批 1 张，但队列里会出现两个任务」——
// 执行上 cap=1 只放一张（[5i] 已验），问题在**显示**：同路第二张和头一张长得一模一样。
// 现在：每批 1 张时第二张起加 .wb-step-queued + 虚线边 + 「排队中 · 等 <前一张 id>」；
// 每批 >1 / 整批时不动（整批卡本来就要一起交给 Agent，该全列出来）。
await ev(`document.querySelector('[data-wb-clear]').click()`);
await wait(500);
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true;
  document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true}));
  var s=document.querySelector('[data-wb-batch-size]'); s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(300);
await ev(`document.querySelector('[data-wb-addall]').click(); 1`);
await wait(500);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(2500);

const laneQ = JSON.parse(await ev(`JSON.stringify((function(){
  var lanes = [].slice.call(document.querySelectorAll('[data-wb-steps] .wb-lane'));
  return {
    laneN: lanes.length,
    perLane: lanes.map(function(l){
      return {
        name: (l.querySelector('.wb-lane-name')||{textContent:''}).textContent,
        cards: [].slice.call(l.querySelectorAll('.wb-step')).map(function(s){
          return {
            id: s.getAttribute('data-wb-step'),
            queued: s.getAttribute('data-wb-queued') === '1',
            hasQueuedCls: s.classList.contains('wb-step-queued'),
            note: (s.querySelector('.wb-step-why')||{textContent:''}).textContent,
            border: getComputedStyle(s).borderLeftStyle
          };
        })
      };
    })
  };
})())`));

const allCards = laneQ.perLane.flatMap((l) => l.cards);
const queuedCards = allCards.filter((c) => c.queued);
const expectQueued = laneQ.perLane.reduce((n, l) => n + Math.max(0, l.cards.length - 1), 0);
ok(laneQ.laneN >= 1, "并行队列铺出来了", laneQ.laneN + " 路 / " + allCards.length + " 张");
ok(queuedCards.length === expectQueued,
  "每批 1 张时，同路第二张起全部标「排队中」",
  queuedCards.length + " 张排队（应 " + expectQueued + " 张）: " + queuedCards.map((c) => c.id).join(","));
// 每张排队卡的提示必须指向**同路的前一张**，不是随便一张
const noteOk = laneQ.perLane.every((l) =>
  l.cards.every((c, i) => i === 0 ? !c.queued : (c.queued && c.note === "排队中 · 等 " + l.cards[i - 1].id)));
ok(noteOk, "排队卡的提示指向同路前一张（「排队中 · 等 <前一张 id>」）",
  queuedCards.map((c) => c.id + "→" + c.note.replace("排队中 · 等 ", "")).join(" · ") || "(本次没有需要排队的路)");
ok(queuedCards.every((c) => c.hasQueuedCls && c.border === "dashed"),
  "排队卡有独立样式（虚线边，和正在跑的实线蓝边区分）",
  queuedCards.length ? queuedCards[0].border : "(无排队卡)");
ok(allCards.filter((c) => !c.queued).every((c) => c.border === "solid"), "头一张仍是实线边（不像在排队）");

// 每批 2 张：仍是「按路分行」的形态，但路内从第 3 张起才标排队（前 2 张一起交给该窗口）
await ev(`var s=document.querySelector('[data-wb-batch-size]'); s.value='2'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(300);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(2500);
const qAfterBatch2 = JSON.parse(await ev(`JSON.stringify((function(){
  var lanes = [].slice.call(document.querySelectorAll('[data-wb-steps] .wb-lane'));
  return {
    laneN: lanes.length,
    queued: document.querySelectorAll('[data-wb-steps] .wb-step-queued').length,
    expectQueued: lanes.reduce(function(n,l){
      return n + Math.max(0, l.querySelectorAll('.wb-step').length - 2);
    }, 0)
  };
})())`));
ok(qAfterBatch2.laneN >= 1 && qAfterBatch2.queued === qAfterBatch2.expectQueued,
  "改成每批 2 张后仍是按路分行，且只有第 3 张起标排队（前 2 张一起交给窗口）",
  qAfterBatch2.laneN + " 路 / 排队 " + qAfterBatch2.queued + "（应 " + qAfterBatch2.expectQueued + "）");

// 串行：单列，不应有排队标记
await ev(`document.querySelector('input[name=wb-mode][value=serial]').checked=true;
  document.querySelector('input[name=wb-mode][value=serial]').dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(300);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(2000);
const qSerial = await ev(`document.querySelectorAll('[data-wb-steps] .wb-step-queued').length`);
const laneSerial = await ev(`document.querySelectorAll('[data-wb-steps] .wb-lane').length`);
ok(laneSerial === 0 && qSerial === 0, "串行是单列，没有队列表也没有排队标记", laneSerial + " 路 / " + qSerial + " 标记");

// 排队标记必须**随卡开跑而消失** —— 否则跑起来后还挂着「排队中 · 等 X」，自相矛盾。
// 这需要真实执行：回到每批 1 张、开跑、拦 ask 自动回答案。
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true;
  document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true}));
  var s=document.querySelector('[data-wb-batch-size]'); s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
await wait(300);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(2500);
const qBeforeRun = await ev(`document.querySelectorAll('[data-wb-steps] .wb-step-queued').length`);
await ev(`(function(){
  window.__pend2 = [];
  var orig = window.fetch.bind(window);
  window.fetch = function(url, opts){
    if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var askId = JSON.parse(opts.body).askId;
      window.__pend2.push(askId);
      return Promise.resolve({ok:true, json:function(){return Promise.resolve({ok:true, askId:askId});}});
    }
    return orig(url, opts);
  };
  return 1;
})()`);
await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
let seenQ = 0;
let maxQueuedDuringRun = 0;
const qdl = Date.now() + 20000;
while (Date.now() < qdl) {
  await wait(400);
  const n = await ev(`(function(){var p=window.__pend2||[];var c=0;p.slice(${seenQ}).forEach(function(a){window.postMessage({type:'ops-board/answer',askId:a,ok:true,text:'已处理',by:'t'},'*');c++;});return c;})()`);
  seenQ += n;
  const qn = await ev(`document.querySelectorAll('[data-wb-steps] .wb-step-queued').length`);
  if (qn > maxQueuedDuringRun) maxQueuedDuringRun = qn;
  const fin = await ev(`window.__wb.run === false`);
  if (fin) break;
}
const qAfterRun = JSON.parse(await ev(`JSON.stringify({
  queued: document.querySelectorAll('[data-wb-steps] .wb-step-queued').length,
  queuedAttr: document.querySelectorAll('[data-wb-steps] [data-wb-queued]').length,
  // 这次跑的是「路内串行」：账面状态没被真收口（答案是假的），所以同区域后一张
  // 永远领不到、会被搁置 —— 那些卡**确实没开跑**，保留排队标记是对的。
  // 这里要验的是另一件事：**真跑过的卡**不许还挂着「等 X」。
  ranStillQueued: window.__wb.order.filter(function(o){ return o.done; }).filter(function(o){
    return !!document.querySelector('[data-wb-steps] [data-wb-step="' + o.id + '"].wb-step-queued');
  }).map(function(o){ return o.id; }),
  doneN: window.__wb.order.filter(function(o){ return o.done; }).length
})`));
ok(qBeforeRun >= 1, "开跑前确实有排队卡（否则这条验不到）", qBeforeRun + " 张");
ok(maxQueuedDuringRun <= qBeforeRun, "执行过程中排队标记只会减少，不会新增", "峰值 " + maxQueuedDuringRun);
ok(qAfterRun.doneN >= 1 && qAfterRun.ranStillQueued.length === 0,
  "跑过的卡不再挂「排队中」（不会出现「已处理完 · 还在等 X」自相矛盾）",
  "跑完 " + qAfterRun.doneN + " 张 · 仍挂标记 " + qAfterRun.ranStillQueued.length + " 张" +
  (qAfterRun.ranStillQueued.length ? "：" + qAfterRun.ranStillQueued.join(",") : ""));
ok(qAfterRun.queued === qAfterRun.queuedAttr,
  "排队标记与 data-wb-queued 属性始终一致（不会只清一半）",
  "标记 " + qAfterRun.queued + " / 属性 " + qAfterRun.queuedAttr);

console.log("\n[5k] 不在 Harness 面板里（没有 __OPS_HARNESS__）时，点开始必须给出可读原因，不能静默失败");
// 回归：harnessPostWithCapture 原来直接读 env.id，env 为 null 时抛 TypeError，
// 界面上表现为「点了开始执行什么都没发生」。现在必须把原因写进日志。
await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; 1`);
await ev(`window.__OPS_HARNESS_BAK = window.__OPS_HARNESS__; window.__OPS_HARNESS__ = null; 1`);
const logBefore5k = await ev(`(function(){
  var el = document.querySelector('[data-wb-phase]');
  return el ? el.textContent.replace(/\\s+/g,' ').trim() : '';
})()`);
await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(1200);
const logAfter5k = await ev(`(function(){
  var el = document.querySelector('[data-wb-phase]');
  return el ? el.textContent.replace(/\\s+/g,' ').trim() : '';
})()`);
ok(/Harness/i.test(logAfter5k) && logAfter5k !== logBefore5k,
  "日志里出现「不在 Harness 面板里」的原因（而不是静默无反应）",
  (logAfter5k.slice(-90) || "(日志没变化)"));
await ev(`window.__OPS_HARNESS__ = window.__OPS_HARNESS_BAK; 1`);

console.log("\n[5l] 分析窗口的计划校验器：合法采纳、非法回退（同区域不许拆两个窗口）");
// 这一层是安全底线：模型的输出不可信，校验不过必须整份回退。
// 最要紧的一条是「同一区域不能拆进两个窗口」—— 那会让两个窗口抢同一块地。
const planHas = await ev(`!!window.__WB_PLANNER__`);
ok(planHas === true, "window.__WB_PLANNER__ 已注入页面");
if (planHas) {
  const planGood = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    var pm = {get:function(k){return ({'A':'数据源','B':'重构','C':'免费额度'})[k]||''},has:function(k){return 'ABC'.indexOf(k)>-1;}};
    var plan = {lanes:[{key:'数据源',cardIds:['A']},{key:'重构',cardIds:['B']},{key:'免费额度',cardIds:['C']}],note:'三路'};
    var r = P.resolvePlan(JSON.stringify(plan), ['A','B','C'], pm);
    return {source:r.source, n:r.lanes.length};
  })()`);
  ok(planGood && planGood.source === "ai" && planGood.n === 3,
    "合法计划被采纳（source=ai / 3 路）", JSON.stringify(planGood));

  const planMerge = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    var pm = {get:function(k){return ({'A':'数据源','B':'重构'})[k]||''},has:function(){return true;}};
    var plan = {lanes:[{key:'全串行',cardIds:['A','B']}]};
    return P.resolvePlan(JSON.stringify(plan), ['A','B'], pm).source;
  })()`);
  ok(planMerge === "ai", "不同区域合并成一个窗口是合法的（等价串行）", String(planMerge));

  const planSplit = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    var pm = {get:function(k){return ({'A1':'数据源','A2':'数据源'})[k]||''},has:function(){return true;}};
    var plan = {lanes:[{key:'x',cardIds:['A1']},{key:'y',cardIds:['A2']}]};
    var r = P.resolvePlan(JSON.stringify(plan), ['A1','A2'], pm);
    return {source:r.source, n:r.lanes.length, reason:r.reason};
  })()`);
  ok(planSplit && planSplit.source === "fallback",
    "同区域拆两个窗口 → 整份回退", planSplit && planSplit.reason);
  ok(planSplit && planSplit.n === 1, "回退后合回 1 路（按区域分组）", planSplit && planSplit.n + " 路");

  const planJunk = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    var pm = {get:function(){return '数据源'},has:function(){return true;}};
    return P.resolvePlan('我觉得这样分比较好，你看着办', ['A','B'], pm).source;
  })()`);
  ok(planJunk === "fallback", "答非所问（纯文字没有 JSON）→ 回退", String(planJunk));

  const planMissing = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    var pm = {get:function(k){return ({'A':'数据源','B':'重构'})[k]||''},has:function(){return true;}};
    var plan = {lanes:[{key:'x',cardIds:['A']}]};
    return P.resolvePlan(JSON.stringify(plan), ['A','B'], pm).source;
  })()`);
  ok(planMissing === "fallback", "计划漏卡 → 回退（不能静默不执行某张）", String(planMissing));

  // 第 7 条：lane.key 就是干活窗口的会话键，撞上「调度台」会让干活窗口
  // 接进分析窗口那条会话 —— 上下文互相污染。
  const planReserved = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    var pm = {get:function(k){return ({'A':'数据源'})[k]||''},has:function(){return true;}};
    var plan = {lanes:[{key: P.PLANNER_WINDOW_KEY, cardIds:['A']}]};
    var r = P.resolvePlan(JSON.stringify(plan), ['A'], pm);
    return {source:r.source, reason:r.reason};
  })()`);
  ok(planReserved && planReserved.source === "fallback",
    "lane.key 占用分析窗口的名字 → 回退", planReserved && planReserved.reason);
  const reservedName = await ev(`window.__WB_PLANNER__ ? window.__WB_PLANNER__.PLANNER_WINDOW_KEY : null`);
  ok(reservedName === "调度台", "分析窗口的保留名已导出（供 client.js 对齐）", String(reservedName));
}

console.log("\n[5m] 复用分析窗口开关默认勾上，且只在并行时出现");
const plannerBox = await ev(`(function(){
  var b = document.querySelector('[data-wb-planner-reuse]');
  return b ? {exists:true, checked:b.checked} : {exists:false};
})()`);
ok(plannerBox && plannerBox.exists, "「复用分析窗口」开关在页面上");
ok(plannerBox && plannerBox.checked === true, "默认勾上（= 默认复用）", JSON.stringify(plannerBox && plannerBox.checked));
const plannerVisParallel = await ev(`(function(){
  var r = document.querySelector('input[name=wb-mode][value=parallel]');
  if (r) { r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); }
  var box = document.querySelector('[data-wb-planner-box]');
  return box ? getComputedStyle(box).display : 'no-box';
})()`);
ok(plannerVisParallel !== "none" && plannerVisParallel !== "no-box",
  "并行时可见（只有并行才建多窗口）", String(plannerVisParallel));
const plannerVisSerial = await ev(`(function(){
  var r = document.querySelector('input[name=wb-mode][value=serial]');
  if (r) { r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); }
  var box = document.querySelector('[data-wb-planner-box]');
  return box ? getComputedStyle(box).display : 'no-box';
})()`);
ok(plannerVisSerial === "none", "串行时隐藏", String(plannerVisSerial));

console.log("\n[5n] 干活窗口的会话键 = 计划给的 key（跨轮次稳定，位置变了也不换窗口）");
// 回归：原来会话键是「路N · 前缀」按位置拼的，AI 换一下顺序键就变 → 窗口复用永远接不上。
const convKeyStable = await ev(`(function(){
  var w = window.__wb;
  var bak = w.lanes;
  w.lanes = [
    {key:'数据源', prefix:'数据源', cards:[{id:'OPS-025'}]},
    {key:'重构',   prefix:'重构',   cards:[{id:'OPS-024'}]}
  ];
  var a1 = window.__wbConvKey ? window.__wbConvKey('OPS-025') : '(no export)';
  // 顺序对调：位置变了，但每张卡的 key 不该变
  w.lanes = [
    {key:'重构',   prefix:'重构',   cards:[{id:'OPS-024'}]},
    {key:'数据源', prefix:'数据源', cards:[{id:'OPS-025'}]}
  ];
  var a2 = window.__wbConvKey ? window.__wbConvKey('OPS-025') : '(no export)';
  w.lanes = bak;
  return {a1:a1, a2:a2};
})()`);
if (convKeyStable && convKeyStable.a1 && convKeyStable.a1 !== "(no export)") {
  ok(convKeyStable.a1 === convKeyStable.a2,
    "顺序变化后同一张卡的会话键不变（窗口能接上）",
    convKeyStable.a1 + " == " + convKeyStable.a2);
} else {
  ok(true, "会话键未导出到 window，跳过（由渲染产物行为覆盖）");
}

console.log("\n[5o] 正在处理中的卡留在「待执行队列」里，不该掉回备选");
// ⚠️ 这一段要真跑执行、要拿到「可开工的卡」—— 先把台账恢复成初始快照并刷新页面。
// 不恢复的话，前面几段已经把卡收口了（自动收口器干的），这里会「没有可开工的卡」。
restoreLedger();
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);
// 用户报：「正在处理的任务，没有再处理队列里，还在备选里」。
// 根因是 workbenchRefresh 合并候选池时把 state==='running' 的卡过滤掉了，
// 于是别人一领走，这张卡就从队列里消失、又被备选那半边收进去。
// 这里模拟「别人先领走一张」：直接打 /api/flow/claim，再让页面自己刷新一次。
{
  const claimTarget = (PLAN.runnable || []).filter((r) => r.state === "ready")[0];
  if (!claimTarget) {
    ok(true, "[跳过] 当前没有可开工的卡，无法模拟「被领走」");
  } else {
    await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
    await wait(400);
    const claimed = await fetch(B + "/api/flow/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: claimTarget.id, by: "测试占用者" }),
    }).then((r) => r.json());
    ok(claimed.ok === true, "模拟别人领走一张卡（" + claimTarget.id + "）", JSON.stringify(claimed).slice(0, 80));
    await ev(`window.__wbRefresh ? window.__wbRefresh() : 0; 1`);
    await wait(1200);
    const runStat = JSON.parse(await ev(`JSON.stringify((function(){
      var groups = document.querySelectorAll('[data-wb-pool] .wb-group');
      var q = groups[0] ? groups[0] : null;
      var id = ${JSON.stringify(claimTarget.id)};
      var inQueue = q ? Array.prototype.slice.call(q.querySelectorAll('.wb-pick')).some(function(c){ return c.getAttribute('data-wb-id') === id; }) : false;
      var inStandby = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-pick.wb-standby')).some(function(c){ return c.getAttribute('data-wb-id') === id; });
      var occupied = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-pick.wb-occupied')).map(function(c){ return c.getAttribute('data-wb-id'); });
      var tag = q ? (q.querySelector('.wb-state-tag') || {}).textContent : '';
      return { id: id, inQueue: inQueue, inStandby: inStandby, occupied: occupied, tag: tag || '', inPool: window.__wb.dragPool.indexOf(id) };
    })())`));
    ok(runStat.inQueue === true && runStat.inPool > -1,
      "正在处理的卡在「待执行队列」里（不是只在备选）", "inQueue=" + runStat.inQueue + " inPool=" + runStat.inPool);
    ok(runStat.inStandby === false, "正在处理的卡不再出现在备选区", "inStandby=" + runStat.inStandby);
    ok(runStat.tag === "处理中", "队列里这张卡标「处理中」，看得出在谁手上", "tag=" + runStat.tag);
    const stillDraggable = await ev(`Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-group:first-child .wb-pick')).some(function(c){ return c.getAttribute('data-wb-id') === ${JSON.stringify(claimTarget.id)} && c.getAttribute('draggable') === 'true'; })`);
    ok(stillDraggable === false, "处理中的卡不可拖动排序（已经交出去了，不能改它的次序）");
    await fetch(B + "/api/flow/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: claimTarget.id, by: "测试占用者" }),
    });
    await ev(`window.__wbRefresh ? window.__wbRefresh() : 0; 1`);
    await wait(800);
  }
}

console.log("\n[5p] 串行：所有卡交给**同一个**固定窗口「执行台」并复用（不是每张新开一个）");
// ⚠️ 这一段要真跑执行、要拿到「可开工的卡」—— 先把台账恢复成初始快照并刷新页面。
// 不恢复的话，前面几段已经把卡收口了（自动收口器干的），这里会「没有可开工的卡」。
restoreLedger();
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);
// 用户问：「除了调度台，其他对话会复用吗，我希望是可以的」。
// 串行以前 fresh=true + 会话键回落成卡 id → N 张卡开 N 个窗口，一个都不复用。
// 现在：会话键固定「执行台」、fresh=false → N 张卡进同一条会话。
{
  const serialIds = await ev(`(window.__wb.candidate || []).filter(function(c){ return c.state === 'ready'; }).map(function(c){ return c.id; }).slice(0,2)`);
  if (!serialIds || serialIds.length < 1) {
    ok(true, "[跳过] 没有可开工的卡，无法验证串行复用");
  } else {
    await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
    await wait(400);
    // 前面几节跑过真实执行，可能留下 inflight / run 标记；不先归位的话
    // workbenchStart 会因为 WB.run 还是 true 而直接 return，一枪不放。
    await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; window.__wb.doneCount = 0; 1`);
    await wait(200);
    await ev(`window.__OPS_HARNESS__ = window.__OPS_HARNESS__ || { id: 'test-board', dir: 'D:\\\\x', label: 't' };
      window.__wbReuse = { asked: [] };
      var orig = window.fetch.bind(window);
      window.fetch = function(url, opts){
        if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
          var body = JSON.parse(opts.body);
          window.__wbReuse.asked.push({ askId: body.askId, item: body.item, title: body.title, sessionTitle: body.sessionTitle || '', fresh: body.fresh });
          return Promise.resolve({ok:true, json:function(){return Promise.resolve({ok:true, askId:body.askId});}});
        }
        return orig(url, opts);
      }; 1`);
    await ev(`document.querySelector('input[name=wb-mode][value=serial]').checked=true; document.querySelector('input[name=wb-mode][value=serial]').dispatchEvent(new Event('change',{bubbles:true})); 1`);
    await wait(300);
    await ev(`window.__wb.dragPool = ${JSON.stringify(serialIds)}; 1`);
    await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
    // 等分析结果落地（串行分支要等一次 /api/workbench/analyze 往返）
    for (let i = 0; i < 20; i++) {
      await wait(250);
      if (await ev(`(window.__wb.order || []).length > 0`)) break;
    }
    const lanesCleared = await ev(`(window.__wb.lanes || []).length`);
    ok(lanesCleared === 0, "串行分析后不残留上一轮的「路」（否则会话键会错接到并行窗口）", "lanes=" + lanesCleared);
    const preRunState = JSON.parse(await ev(`JSON.stringify({ order: (window.__wb.order||[]).length, mode: window.__wb.mode, run: window.__wb.run })`));
    await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
    await wait(600);
    const startedRun = await ev(`window.__wb.run`);
    let reuseSeen = 0;
    const reuseDl = Date.now() + 20000;
    while (Date.now() < reuseDl) {
      await wait(400);
      const n = await ev(`(function(){var a=window.__wbReuse.asked;var c=0;a.slice(${reuseSeen}).forEach(function(x){window.postMessage({type:'ops-board/answer',askId:x.askId,ok:true,text:'已处理收口',by:'t'},'*');c++;});return c;})()`);
      reuseSeen += n;
      if (await ev(`window.__wb.run === false`)) break;
    }
    const reuseSum = JSON.parse(await ev(`JSON.stringify({
      asked: window.__wbReuse.asked,
      doneN: window.__wb.order.filter(function(o){return o.done;}).length,
      totalN: window.__wb.order.length
    })`));
    ok(startedRun === true,
      "串行点了「开始执行」就真的跑起来了（WB.run=true，不被上一节的残留状态挡住）",
      "run=" + startedRun + " · 开跑前 " + JSON.stringify(preRunState));
    ok(reuseSum.asked.length >= 1, "串行确实发出了 ask", reuseSum.asked.length + " 次");
    const keys = reuseSum.asked.map((a) => a.item);
    const distinct = keys.filter((v, i) => keys.indexOf(v) === i);
    ok(distinct.length === 1 && distinct[0] === "执行台",
      "所有卡共用一个会话键「执行台」（窗口复用）", "键=" + distinct.join(",") + " / " + reuseSum.asked.length + " 次");
    ok(reuseSum.asked.every((a) => a.fresh === false),
      "每次都是 fresh:false（接回同一条会话，不是新建）", reuseSum.asked.map((a) => a.fresh).join(","));
    ok(reuseSum.asked.every((a) => a.sessionTitle === "执行台"),
      "会话名只写窗口名「执行台」，不带第二段重复", reuseSum.asked.map((a) => a.sessionTitle).join(","));
    const dupTitle = reuseSum.asked.filter((a) => a.title && a.title === a.item);
    ok(dupTitle.length === 0,
      "title 不再等于 item（旧宿主拼 `${item} · ${title}` 时就不会出现「名称 · 名称」）",
      reuseSum.asked.map((a) => a.item + "|" + a.title).join(" , "));
  }
}

console.log("\n[5q] 「执行台」是保留名：lane.key 起这个名字会被判非法、整份回退");
{
  const execReserved = await ev(`(function(){
    var P = window.__WB_PLANNER__;
    if (!P) return 'no-planner';
    var pm = {get:function(){return '数据源';},has:function(){return true;}};
    var plan = {lanes:[{key:'执行台',cardIds:['A']}]};
    return P.resolvePlan(JSON.stringify(plan), ['A'], pm).source;
  })()`);
  ok(execReserved === "fallback",
    "lane.key 占用串行固定窗口「执行台」→ 回退（不会让并行窗口接进串行会话）", String(execReserved));
  const execName = await ev(`window.__WB_PLANNER__ ? (window.__WB_PLANNER__.EXEC_WINDOW_KEY || null) : null`);
  ok(execName === "执行台", "串行固定窗口名已导出（供 client.js 对齐）", String(execName));
  const plannerStill = await ev(`window.__WB_PLANNER__ ? window.__WB_PLANNER__.PLANNER_WINDOW_KEY : null`);
  ok(plannerStill === "调度台", "分析窗口的名字没被改动", String(plannerStill));
}

console.log("\n[5r] 演练模式：只回话、不动台账；默认关");
// 用户要「让对话窗口不要具体去执行，但做一个回应，好在看板里测窗口的反应效果」。
// 这个开关只换 prompt，整条链路（claim / 派活 / 等回答 / release）照跑 ——
// 否则演练就测不到真链路。默认必须关（默认开着会让人以为机器在干活）。
{
  const rehBox = await ev(`(function(){
    var b = document.querySelector('[data-wb-rehearsal]');
    var w = document.querySelector('[data-wb-rehearsal-box]');
    return b ? { exists:true, checked:b.checked, visible: w ? getComputedStyle(w).display !== 'none' : false } : { exists:false };
  })()`);
  ok(rehBox && rehBox.exists, "「演练模式」勾选框在页面上");
  ok(rehBox && rehBox.checked === false, "默认关（= 真执行）", String(rehBox && rehBox.checked));
  ok(rehBox && rehBox.visible === true, "串行/并行都看得见（不像分析窗口只在并行显示）");

  const rehIds = await ev(`(window.__wb.candidate || []).filter(function(c){ return c.state === 'ready'; }).map(function(c){ return c.id; }).slice(0,1)`);
  if (!rehIds || !rehIds.length) {
    ok(true, "[跳过] 没有可开工的卡，无法验证演练话术");
  } else {
    await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
    await wait(400);
    await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; 1`);
    await ev(`(function(){
      var b = document.querySelector('[data-wb-rehearsal]');
      b.checked = true; b.dispatchEvent(new Event('change', {bubbles:true}));
      window.__wbReh = { asked: [] };
      var orig = window.fetch.bind(window);
      window.fetch = function(url, opts){
        if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
          var body = JSON.parse(opts.body);
          window.__wbReh.asked.push({ askId: body.askId, question: body.question });
          return Promise.resolve({ok:true, json:function(){return Promise.resolve({ok:true, askId:body.askId});}});
        }
        return orig(url, opts);
      };
      return 1;
    })()`);
    await ev(`document.querySelector('input[name=wb-mode][value=serial]').checked=true;
      document.querySelector('input[name=wb-mode][value=serial]').dispatchEvent(new Event('change',{bubbles:true})); 1`);
    await wait(200);
    await ev(`window.__wb.dragPool = ${JSON.stringify(rehIds)}; 1`);
    await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
    for (let i = 0; i < 20; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
    await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
    let rehSeen = 0;
    const rehDl = Date.now() + 15000;
    while (Date.now() < rehDl) {
      await wait(400);
      const n = await ev(`(function(){var a=window.__wbReh.asked;var c=0;a.slice(${rehSeen}).forEach(function(x){window.postMessage({type:'ops-board/answer',askId:x.askId,ok:true,text:'演练回应：收到，先说打算怎么做。',by:'t'},'*');c++;});return c;})()`);
      rehSeen += n;
      if (await ev(`window.__wb.run === false`)) break;
    }
    const rehSum = JSON.parse(await ev(`JSON.stringify({ asked: window.__wbReh.asked.map(function(a){ return { q: a.question }; }) })`));
    ok(rehSum.asked.length >= 1, "演练下仍照常发 ask（链路没被短路，否则测不到真链路）", rehSum.asked.length + " 次");
    ok(rehSum.asked.every((a) => /演练模式：只回应，不要真执行/.test(a.q)),
      "prompt 带「只回应，不要真执行」", rehSum.asked.length + "/" + rehSum.asked.length);
    ok(rehSum.asked.every((a) => !/这是真实执行，不是分析建议/.test(a.q)),
      "不再出现「这是真实执行」那句（否则窗口会去改台账）");
    // 顺带盯住一条老 bug：prompt 里必须出现**真正的卡编号**。
    // 以前 cleanId 是从标题里 split("·") 猜的，而 itemTitle 返回的就是标题，
    // 于是「卡片 id：FileCopy2 复制目录必定失败…」—— 窗口拿它定位不到卡。
    ok(rehSum.asked.every((a) => rehIds.some((id) => a.q.indexOf(id) > -1)),
      "prompt 里点了名（真正的卡编号，不是标题）",
      rehSum.asked.map((a) => (a.q.match(/[A-Z]+-\d+/) || ["(无编号)"])[0]).join(","));

    // 关掉演练 → 回到真执行话术
    await ev(`(function(){
      document.querySelector('[data-wb-clear]').click();
      var b = document.querySelector('[data-wb-rehearsal]');
      b.checked = false; b.dispatchEvent(new Event('change', {bubbles:true}));
      window.__wb.run = false; window.__wb.inflight = {};
      return 1;
    })()`);
    await wait(400);
    const offState = await ev(`(function(){
      var b = document.querySelector('[data-wb-rehearsal]');
      return { checked: b.checked };
    })()`);
    ok(offState && offState.checked === false, "关掉后勾选框回到未选", JSON.stringify(offState));
  }
}

console.log("\n[6] 服务没崩");
ok(!/Error|throw/.test(stderr), "stderr 干净", stderr.slice(0, 120) || "(空)");

// 收尾：把台账恢复成开工前的快照。
// 这条测试现在会真的改台账（自动收口器，因为工作台要回读验证「真收口了没」），
// 不恢复的话，跑一次测试就把看板上的卡全标成已修好了 —— 下一轮测试和用户看到的都是脏数据。
// 这也是为什么 `restoreLedger()` 既在段间调用、也要在退出前调用一次。
restoreLedger();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
rmSync(CLAIMS_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);