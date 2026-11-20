// 报头尺寸（2026-11-20 用户定：「报表顶部的大标题可以变小点，然后缩小标题所在的行高」）。
//
// 这条测试盯两件事：
//   ① **变小了**：h1 字号不超过上限、报头总高度在预算内；
//       以后谁把 clamp 上限调回去、或者往报头里又塞一行，会直接红。
//   ② **没挤坏**：从 1440 到 600 六档宽度，没有横向滚动、没有标题截断、
//       三栏互不压住、导航仍在报头下方。
//
// 为什么要有 ②：光把字号调小很容易，但报头是三栏网格（左翼「台账·更新」/ 中间书名 /
// 右翼主题与按钮），字号一动就可能某一档挤在一起。只验 1440 一档会漏掉窄屏。
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

// 预算：1440 宽下 h1 ≤ 26px、报头 ≤ 66px（改前是 34px / 78px）。
// 留一点余量给不同字体渲染，但足够挡住「又调回大字号」。
const MAX_H1_PX = 26;
const MAX_MASTHEAD_PX = 66;

const profile = join(tmpdir(), "edge-masthead-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1440,1200", "about:blank"], { stdio: "ignore" });
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

const PROBE = `(function(){
  var m = document.querySelector('.masthead');
  if (!m) return { err: 'no-masthead' };
  var h1 = m.querySelector('h1');
  var left = m.querySelector(':scope > .topbar');
  var right = m.querySelector(':scope > .topbar-right');
  var title = m.querySelector('.masthead-title');
  var r = m.getBoundingClientRect(), hr = h1.getBoundingClientRect();
  var lr = left.getBoundingClientRect(), rr = right.getBoundingClientRect(), tr = title.getBoundingClientRect();
  // 三栏压住 = **水平与垂直都有交叠**。760px 以下报头变单列堆叠（标题提到最上面），
  // 那时水平重叠是正常的，只看水平会误报。
  function clashes(a,b){
    var v = a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5;
    var h = a.right > b.left + 0.5 && b.right > a.left + 0.5;
    return v && h;
  }
  return {
    mastheadH: Math.round(r.height),
    h1Font: parseFloat(getComputedStyle(h1).fontSize),
    h1H: Math.round(hr.height),
    stacked: getComputedStyle(m).gridTemplateColumns.split(' ').length === 1,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    h1Overflow: h1.scrollWidth > h1.clientWidth + 1,
    clashLeft: clashes(tr, lr),
    clashRight: clashes(tr, rr),
    enVisible: getComputedStyle(m.querySelector('.en')).display !== 'none',
    navBelow: Math.round(document.querySelector('.nav').getBoundingClientRect().top) >= Math.round(r.bottom) - 1
  };
})()`;

// ── ① 尺寸预算（1440 宽，最常见的桌面宽度）──
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2000);
const wide = await ev(PROBE);
ok(!wide.err, "报头在");
ok(wide.h1Font <= MAX_H1_PX, "大标题字号 ≤ " + MAX_H1_PX + "px", wide.h1Font + "px");
ok(wide.mastheadH <= MAX_MASTHEAD_PX, "报头总高 ≤ " + MAX_MASTHEAD_PX + "px", wide.mastheadH + "px");
// 行高：h1 盒子高度 ≈ 字号 × line-height。这里间接验「行高收紧了」——
// 若 line-height 还是 1.1，h1H 会明显大于字号 × 1.08。
ok(wide.h1H <= Math.ceil(wide.h1Font * 1.1),
  "标题行高收紧（盒子高 ≈ 字号，没有多余行距）", wide.h1H + "px / 字号 " + wide.h1Font + "px");
ok(wide.enVisible === true, "副标题还在（没被顺手删掉）");

// ── ② 六档宽度都不挤 ──
console.log("\n各宽度下的报头：");
for (const w of [1440, 1200, 1000, 900, 760, 600]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: HTML + "#view-overview" });
  await wait(1300);
  const g = await ev(PROBE);
  const problems = [];
  if (g.err) problems.push(g.err);
  if (g.overflowX) problems.push("横向滚动");
  if (g.h1Overflow) problems.push("标题被截断");
  if (g.clashLeft) problems.push("标题压到左翼");
  if (g.clashRight) problems.push("标题压到右翼");
  if (!g.navBelow) problems.push("导航没在报头下面");
  ok(problems.length === 0, w + "px 下报头不挤（" + (g.stacked ? "单列堆叠" : "三栏并排") + "）",
    problems.length ? problems.join(",") : g.h1Font + "px · 报头 " + g.mastheadH + "px");
  if (!g.err) {
    ok(g.h1Font <= MAX_H1_PX + 1, w + "px 下标题也没超预算", g.h1Font + "px");
  }
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 120) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
