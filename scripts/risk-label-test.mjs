// 风险页改名「风险」→「风险观察」（2026-11-21 用户定）。
//
// 这次改名的**真正风险不是名字**，而是**功能静默失效**：
//
//   client.js 的 `riskItems()` 原来写的是 `it.laneLabel !== "风险"` ——
//   按**显示名**找车道。改名之后这个判断立刻失效，一条都选不出来，
//   于是「风险审核」功能静默变成「共 0 条」。**它不报错，只是没数据。**
//
// 所以这条测试要钉住：
//   ① 名字确实改了（导航 + 页内）
//   ② **按 lane 键找车道的功能仍然工作**（风险条目一条不少）
//   ③ board-data 里带 `lane` 字段（改名的判据来源）
//   ④ 代码里不再按显示名判断车道
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
const CFG = JSON.parse(readFileSync(join(argBoard, "board.config.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

// ── ① 配置 ──
console.log("[1] 配置：车道名和视图名都是「风险观察」");
const riskLane = (CFG.lanes || []).find((l) => l.key === "risk");
const riskView = (CFG.views || []).find((v) => v.key === "lane:risk");
ok(!!riskLane, "有 key=risk 的车道", riskLane ? riskLane.key : "(无)");
ok(riskLane && riskLane.label === "风险观察", "车道名是「风险观察」", riskLane ? riskLane.label : "");
ok(riskView && riskView.label === "风险观察", "视图名也是「风险观察」", riskView ? riskView.label : "");
// 车道**键**不能跟着改 —— 台账里的 lane 字段用的是它
ok(riskLane && riskLane.key === "risk", "**车道键仍是 risk**（台账数据靠它关联，不能改）", riskLane.key);

// ── ② 代码里不再按显示名判断车道 ──
console.log("\n[2] 代码里不再按显示名判断车道（改名不该让功能失效）");
{
  const REPO = "D:\\WorkSpace-Tools\\ops-board";
  const clients = readFileSync(join(REPO, "scripts/lib/client.js"), "utf8");
  // 找「把显示名当判据」的写法：laneLabel === "风险" 之类
  const badLines = clients.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return false;
    return /laneLabel\s*[!=]==\s*["']风险["']/.test(t);
  });
  ok(badLines.length === 0, "**没有 `laneLabel === \"风险\"` 这种按显示名的判断**",
    badLines.length ? badLines[0].trim().slice(0, 70) : "(无)");
  ok(/it\.lane !== "risk"/.test(clients) || /it\.lane === "risk"/.test(clients),
    "改成按 lane 键判断", "");

  // context.mjs 要给出 lane 字段
  const ctx = readFileSync(join(REPO, "scripts/lib/context.mjs"), "utf8");
  ok(/lane:\s*item\.lane/.test(ctx), "context.mjs 的 itemVars 带上了 lane 字段", "");
}

// ── ③ 页面 ──
const profile = join(tmpdir(), "edge-risklabel-" + Date.now());
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

await send("Page.navigate", { url: HTML + "#view-lane-risk" });
await wait(2400);

console.log("\n[3] 页面：导航和页内都用新名");
const r = JSON.parse(await ev(`JSON.stringify((function(){
  var nav = Array.prototype.map.call(document.querySelectorAll('.nav a'), function(a){ return a.textContent.trim(); });
  var view = document.querySelector('[data-view="lane-risk"]');
  var kicker = view ? (view.querySelector('.kicker') || {}).textContent : '';
  var head = view ? view.querySelector('.section-head h2') : null;
  return { nav: nav, kicker: (kicker||'').trim(), firstH2: head ? head.textContent.trim() : '' };
})())`));
console.log("    导航: " + r.nav.join(" → "));
ok(r.nav.indexOf("风险观察") > -1, "**导航里是「风险观察」**", JSON.stringify(r.nav));
ok(r.nav.indexOf("风险") === -1, "导航里没有单独的「风险」了", "");
ok(r.kicker === "风险观察", "**页内 kicker 也是新名**", r.kicker);

// ── ④ 关键：功能没坏 ──
console.log("\n[4] 关键：改名没让「风险审核」功能失效");
const f = JSON.parse(await ev(`JSON.stringify((function(){
  var D = JSON.parse(document.getElementById('board-data').textContent);
  var items = D.items || {};
  var all = [], withLane = 0, riskByKey = 0;
  var CLOSED = ["已修复","已关闭","暂停","已解决","已上线"];
  for (var id in items) {
    if (!Object.prototype.hasOwnProperty.call(items, id)) continue;
    var it = items[id];
    all.push(it);
    if (it.lane) withLane++;
    if (it.lane === 'risk') riskByKey++;
  }
  return { total: all.length, withLane: withLane, riskByKey: riskByKey };
})())`));
console.log("    " + JSON.stringify(f));
ok(f.total > 0, "board-data 有条目", f.total + " 条");
ok(f.withLane === f.total, "**每条都带 lane 字段**（按 key 判车道的依据）", f.withLane + "/" + f.total);
// 台账里真实的风险条目数（不写死，现算）
const LEDGER = JSON.parse(readFileSync(join(argBoard, "ledger.json"), "utf8"));
const realRisk = (LEDGER.items || []).filter((i) => i.lane === "risk").length;
ok(f.riskByKey === realRisk, "**按 lane 键能数出全部风险条目**（改名不影响）",
  f.riskByKey + " / 台账 " + realRisk + " 条");
ok(realRisk > 0, "这块板确实有风险条目（否则这条断言没意义）", realRisk + " 条");

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
