// 菜单栏切换页面的可靠性（2026-11-20 用户报「有时候点击没有切换」）。
//
// 根因不是"点了没绑定事件"，而是**视图与 hash 不同步**：
//   · 阶段筛选（`applyStageFilter`）会调 show() 把视图换掉，但当时**不改 hash**；
//   · 于是「视图 = A、hash = B」；
//   · 用户接着点导航里的 B —— location.hash 本来就等于 "#view-b"，
//     浏览器**不会**触发 hashchange，点击处理器里 `location.hash !== href` 又直接 return；
//   · 结果：点了什么都不发生。
//
// 修法两处：
//   ① `applyStageFilter` 切视图后同步 hash（replaceState + saveRoute）；
//   ② 导航点击兜一层：hash 已等于目标、但激活视图不是它时，手动切过去。
//
// 这条测试要能在「修之前红、修之后绿」：
//   · 直接制造「视图与 hash 不同步」的状态，点那个 hash，断言真的切过去了；
//   · 再走一遍真实的阶段筛选 → 点导航，断言 hash 已经跟上。
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

const profile = join(tmpdir(), "edge-navfix-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--allow-file-access-from-files", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1440,1200", "about:blank"], { stdio: "ignore" });
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

// ① 每个导航项都能切过去（顺序走一遍，等 hashchange 落定）
console.log("[1] 六个导航项逐个点，都能切过去");
const navs = JSON.parse(await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.nav a[data-view]'), function(a){ return { href: a.getAttribute('href'), text: a.textContent.trim() }; }))`));
ok(navs.length >= 4, "导航项都读到了", navs.length + " 项");
const bad = [];
for (const it of navs) {
  const r = await ev(`(async function(){
    document.querySelector('.nav a[href="${it.href}"]').click();
    await new Promise(function(res){ setTimeout(res, 200); });
    var act = document.querySelector('.view.is-active');
    return { active: act ? act.getAttribute('data-view') : null, hash: location.hash };
  })()`);
  const want = it.href.slice(6); // 去掉 "#view-"
  if (r.active !== want || r.hash !== it.href) bad.push({ ...it, ...r, want });
}
ok(bad.length === 0, "每一项点完都切到了对应视图、hash 也对上",
  bad.length ? JSON.stringify(bad.slice(0, 3)) : navs.map((n) => n.text).join(" · "));

// ② 关键回归：人为制造「视图 ≠ hash」后点那个 hash，必须真的切过去
console.log("\n[2] 视图与 hash 不同步时，点导航仍然能切换（这就是那个「点了没反应」）");
await ev(`location.hash = "#view-lane-bug"`);
await wait(400);
const desync = await ev(`(async function(){
  // 只把视图换成 closed，故意不动 hash —— 模拟阶段筛选留下的不同步状态
  Array.prototype.forEach.call(document.querySelectorAll('.view'), function(v){ v.classList.remove('is-active'); });
  document.getElementById('view-closed').classList.add('is-active');
  var before = { active: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), hash: location.hash };
  // 点 hash 与之相同的那一项（修复前：毫无反应）
  document.querySelector('.nav a[href="#view-lane-bug"]').click();
  await new Promise(function(res){ setTimeout(res, 350); });
  return { before: before, after: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), hash: location.hash };
})()`);
ok(desync.before.active === "closed" && desync.before.hash === "#view-lane-bug",
  "先制造出不同步（视图=closed / hash=lane-bug）", JSON.stringify(desync.before));
ok(desync.after === "lane-bug",
  "点「问题修复」真的切过去了（修复前这里会毫无反应）", "切到 " + desync.after);

// ③ 阶段筛选之后 hash 要跟上（这是不同步的源头）
console.log("\n[3] 阶段筛选会把 hash 同步过去（不同步的源头）");
await ev(`location.hash = "#view-lane-bug"`);
await wait(400);
const filtered = await ev(`(async function(){
  var cell = document.querySelector('[data-view="lane-bug"] .stage-board-cell');
  if (!cell) return { err: 'no-cell' };
  var cellHref = cell.getAttribute('href');
  cell.click();
  await new Promise(function(res){ setTimeout(res, 350); });
  var act = (document.querySelector('.view.is-active')||{}).getAttribute('data-view');
  return { cellHref: cellHref, active: act, hash: location.hash, synced: location.hash === '#view-' + act };
})()`);
if (filtered.err) {
  ok(false, "车道页有阶段格子", filtered.err);
} else {
  ok(filtered.synced === true, "筛选后 hash 就是当前视图（不再各说各话）",
    "active=" + filtered.active + " hash=" + filtered.hash);
  // 紧接着点导航，必须能切走
  const afterNav = await ev(`(async function(){
    document.querySelector('.nav a[href="#view-overview"]').click();
    await new Promise(function(res){ setTimeout(res, 350); });
    return { active: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), hash: location.hash };
  })()`);
  ok(afterNav.active === "overview" && afterNav.hash === "#view-overview",
    "筛选之后点导航仍能切走", JSON.stringify(afterNav));
}

// ④ 连点六个导航，最后一个必须生效
console.log("\n[4] 快速连点六个导航，最后一个生效");
const rapid = await ev(`(async function(){
  location.hash = '#view-overview';
  await new Promise(function(res){ setTimeout(res, 250); });
  var seq = ['#view-lane-feature','#view-lane-bug','#view-lane-risk','#view-closed','#view-skills','#view-overview'];
  for (var i = 0; i < seq.length; i++) {
    document.querySelector('.nav a[href="' + seq[i] + '"]').click();
  }
  await new Promise(function(res){ setTimeout(res, 500); });
  return { active: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), hash: location.hash };
})()`);
ok(rapid.hash === "#view-overview", "hash 停在最后点的那一项", rapid.hash);
ok(rapid.active === "overview", "视图也停在最后点的那一项（没被中间某次抢走）", "active=" + rapid.active);

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
