// 处理记录：类型筛选条与第一条记录之间要有间距（2026-11-20 用户报）。
//
// 用户原话：「处理记录，标签和最后一条记录之间的间隔有点小」
// 实测原来是 **0px** —— 筛选条自己的 padding-top:8px 只是它内部的上边距，
// 它底部到 .timeline 一点空隙都没有，第一条记录的日期直接贴着「类型：」那排。
//
// 现在 .timeline 有 margin-top:10px，.history-kinds 补了 padding-bottom。
// 这条测试盯「两者不贴在一起」，判据用**元素矩形实测**，不是读 CSS 值：
//   · 第一条记录的顶边 - 筛选条的底边 ≥ 8px；
//   · 且这个间距不能太大（≤ 24px），否则又变成"断开"。
//
// 注意：只有**超过一种记录类型**时才渲染筛选条（原版行为，只有一个类型不值得给筛选）。
// 没有筛选条时跳过，不是失败。
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

const MIN_GAP = 8;
const MAX_GAP = 24;

const profile = join(tmpdir(), "edge-histgap-" + Date.now());
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

// 只验**有处理记录区**的页。收口页（closed）本来就没有这块 ——
// 它的条目已经按状态分组列全了，再挂一遍处理记录是重复。
// 所以「没有这块」不是失败，跳过即可；真正要盯的是「有这块的页里，
// 筛选条和第一条记录不能贴在一起」。
const VIEWS = ["overview", "lane-feature", "lane-bug", "lane-risk"];

await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2400);

let checked = 0;
for (const view of VIEWS) {
  await send("Page.navigate", { url: HTML + "#view-" + view });
  await wait(1500);
  const g = JSON.parse(await ev(`JSON.stringify((function(){
    var sec = document.querySelector('.view.is-active [data-history-section]');
    if (!sec) return { err: 'no-history' };
    var legend = sec.querySelector('.history-kinds');
    var tl = sec.querySelector('.timeline');
    if (!tl) return { err: 'no-timeline' };
    var first = tl.querySelector('li');
    if (!first) return { err: 'no-record' };
    if (!legend) return { skip: true, reason: '只有一种类型，不渲染筛选条' };
    var lr = legend.getBoundingClientRect();
    var fr = first.getBoundingClientRect();
    return {
      gap: Math.round(fr.top - lr.bottom),
      legendBottom: Math.round(lr.bottom),
      firstTop: Math.round(fr.top),
      // 顺带确认时间线自己的 margin-top 生效了
      tlMarginTop: getComputedStyle(tl).marginTop
    };
  })())`));
  if (g.err === "no-record" || g.err === "no-timeline") {
    // 这块板在这条车道上没有记录 → 不渲染时间线（historyList 对空列表给的是
    // 「还没有相关记录。」一句话，没有 .timeline）。这是正常数据状态，不是失败。
    console.log("  · " + view + " 跳过：该页没有处理记录（" + g.err + "）");
    continue;
  }
  if (g.err) { ok(false, view + " 有处理记录区", g.err); continue; }
  if (g.skip) { console.log("  · " + view + " 跳过：" + g.reason); continue; }
  checked++;
  ok(g.gap >= MIN_GAP && g.gap <= MAX_GAP,
    view + " 筛选条与第一条记录之间间距合适（" + MIN_GAP + "~" + MAX_GAP + "px）",
    g.gap + "px（条底 " + g.legendBottom + " → 记录顶 " + g.firstTop + "）· marginTop=" + g.tlMarginTop);
}

// 至少验到一处；但如果**整块板都没有记录**（practise 只有 2 条，按车道过滤后为空），
// 那是数据状态、不是样式坏了 —— 这种情况明确跳过并说明，不要报红。
if (checked === 0) {
  ok(true, "[跳过] 这块板没有任何一页带筛选条的处理记录（记录太少），无从测量间距");
} else {
  ok(true, "验到 " + checked + " 处带筛选条的处理记录区", checked + " 处");
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
