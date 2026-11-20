// 折叠按钮的箭头必须随收放旋转（2026-11-20 用户报）。
//
// 用户原话：「总览的工作台的收缩按钮，收放不会旋转」
//
// 根因：折叠状态是 JS 按「按钮所在的那个标题容器」加 class 的 ——
//   普通模块 → .section-head.is-collapsed
//   工作台   → .workbench-head.is-collapsed（它没有 .section-head）
// 而旋转规则只写了 .section-head 那一条，于是工作台那颗按钮永远指向下，
// 收起了也不转（内容确实收起来了，只是视觉上没有反馈）。
//
// 判据：读伪元素 ::after 的实际 transform 矩阵，换算成角度。
//   · 放开时 ≈ 45°（朝下/朝右的 V 形）
//   · 收起时 ≈ -45°（翻转过来）
// 不能只看 CSS 文本里有没有那条规则 —— 要验「真的算出了不同的角度」。
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

const profile = join(tmpdir(), "edge-rot-" + Date.now());
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
await wait(2600);

// 先清掉上一轮可能留下的折叠状态，保证起点是「全展开」
await ev(`(function(){
  Object.keys(localStorage).filter(function(k){ return k.indexOf('ops-fold-') === 0; }).forEach(function(k){ localStorage.removeItem(k); });
  return 1;
})()`);
await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2400);

// 读 ::after 的实际旋转角度（把 matrix 换算成度数）
const READ_ANGLE = (sel) => `(function(){
  var btn = document.querySelector(${JSON.stringify(sel)});
  if (!btn) return { err: 'no-button' };
  var cs = getComputedStyle(btn, '::after');
  var t = cs.transform || 'none';
  var deg = null;
  if (t && t !== 'none') {
    // matrix(a, b, c, d, e, f) → atan2(b, a)
    var m = t.match(/matrix\\(([^)]+)\\)/);
    if (m) {
      var v = m[1].split(',').map(Number);
      deg = Math.round(Math.atan2(v[1], v[0]) * 180 / Math.PI);
    }
  }
  var head = btn.closest('.section-head') || btn.closest('.workbench-head');
  return {
    deg: deg,
    content: cs.content,
    headCls: head ? head.className : '',
    collapsed: head ? head.classList.contains('is-collapsed') : null,
    expanded: btn.getAttribute('aria-expanded'),
    bodyHidden: (function(){
      var id = btn.getAttribute('data-fold');
      var body = document.querySelector('[data-fold-body="' + id + '"]');
      return body ? body.hasAttribute('hidden') : null;
    })()
  };
})()`;

// ── ① 工作台那颗按钮 ──
console.log("[1] 工作台的折叠按钮：箭头随收放旋转");
const before = await ev(READ_ANGLE(".workbench-head .section-fold"));
ok(!before.err, "找得到工作台的折叠按钮", JSON.stringify(before));
if (!before.err) {
  ok(before.collapsed === false, "起点是展开态", "collapsed=" + before.collapsed);
  const openDeg = before.deg;

  // 点一下收起。
  // ⚠️ 必须**等 transition 跑完**再看 transform（2026-11-20 自己踩的坑）：
  // .section-fold::after 有 `transition: transform .15s`，点击后立刻读
  // getComputedStyle 拿到的是**动画中间帧**（还是接近 45°），
  // 于是断言会假红说"没旋转"。等 350ms（>150ms 的两倍）再读。
  await ev(`document.querySelector('.workbench-head .section-fold').click(); 1`);
  await wait(350);
  const a = await ev(READ_ANGLE(".workbench-head .section-fold"));
  ok(a.collapsed === true, "点一下收起了", "collapsed=" + a.collapsed);
  ok(a.bodyHidden === true, "正文确实藏了", "hidden=" + a.bodyHidden);
  ok(a.deg !== null && openDeg !== null && Math.abs(a.deg - openDeg) >= 60,
    "箭头**旋转了**（收起前后角度差 ≥60°）",
    openDeg + "° → " + a.deg + "°（差 " + (a.deg !== null && openDeg !== null ? Math.abs(a.deg - openDeg) : "?") + "°）");

  // 再点一下展开
  await ev(`document.querySelector('.workbench-head .section-fold').click(); 1`);
  await wait(350);
  const b = await ev(READ_ANGLE(".workbench-head .section-fold"));
  ok(b.collapsed === false, "再点一下展开回去", "collapsed=" + b.collapsed);
  ok(b.deg !== null && openDeg !== null && Math.abs(b.deg - openDeg) <= 6,
    "箭头转回原来的角度", openDeg + "° → " + b.deg + "°");
}

// ── ② 普通模块那颗按钮（对照，本来就能转）──
console.log("\n[2] 普通模块的折叠按钮也要能转（对照）");
const secOpen = await ev(READ_ANGLE(".section-head.is-foldable .section-fold"));
if (secOpen.err) {
  ok(false, "总览页有普通模块的折叠按钮", secOpen.err);
} else {
  await ev(`document.querySelector('.section-head.is-foldable .section-fold').click(); 1`);
  await wait(350);   // 同样要等 transition
  const s2 = await ev(READ_ANGLE(".section-head.is-foldable .section-fold"));
  ok(s2.collapsed === true, "普通模块也能收起", "collapsed=" + s2.collapsed);
  ok(s2.deg !== null && secOpen.deg !== null && Math.abs(s2.deg - secOpen.deg) >= 60,
    "普通模块的箭头也旋转", secOpen.deg + "° → " + s2.deg + "°");
  // 恢复：点回展开态，别把折叠状态留给后面的断言
  await ev(`(function(){ var b = document.querySelector('.section-head.is-foldable .section-fold'); if (b && b.getAttribute('aria-expanded') === 'false') b.click(); return 1; })()`);
  await wait(350);
}

// ── ③ 两种折叠容器都受同一套规则管 ──
console.log("\n[3] 两种折叠容器（.section-head / .workbench-head）都覆盖到了");
// ⚠️ 这一段**不能在一个表达式里加 class 就立刻读角度**：transition 有 .15s，
// 同一个同步块里读到的永远是起始帧（45°），于是两条断言都假红 —— 第一版就是这样。
// 改成「加 class → 等 transition → 读 → 恢复」，每个容器独立走一遍。
for (const sel of [".workbench-head", ".section-head.is-foldable"]) {
  const info = await ev(`(function(){
    var head = document.querySelector(${JSON.stringify(sel)});
    if (!head) return { err: 'not-found' };
    var btn = head.querySelector('.section-fold');
    if (!btn) return { err: 'no-btn' };
    head.classList.remove('is-collapsed');    // 先归零
    var t = getComputedStyle(btn, '::after').transform || 'none';
    var m = t.match(/matrix\\(([^)]+)\\)/);
    var v = m ? m[1].split(',').map(Number) : null;
    return { deg: v ? Math.round(Math.atan2(v[1], v[0]) * 180 / Math.PI) : null };
  })()`);
  if (info.err) { ok(false, sel + " 存在折叠按钮", info.err); continue; }
  await ev(`document.querySelector(${JSON.stringify(sel)}).classList.add('is-collapsed'); 1`);
  await wait(350);
  const closedInfo = await ev(`(function(){
    var head = document.querySelector(${JSON.stringify(sel)});
    var btn = head.querySelector('.section-fold');
    var t = getComputedStyle(btn, '::after').transform || 'none';
    var m = t.match(/matrix\\(([^)]+)\\)/);
    var v = m ? m[1].split(',').map(Number) : null;
    return { deg: v ? Math.round(Math.atan2(v[1], v[0]) * 180 / Math.PI) : null };
  })()`);
  await ev(`document.querySelector(${JSON.stringify(sel)}).classList.remove('is-collapsed'); 1`);
  await wait(350);
  ok(closedInfo.deg !== null && info.deg !== null && Math.abs(closedInfo.deg - info.deg) >= 60,
    sel + " 加 is-collapsed → 箭头旋转",
    info.deg + "° → " + closedInfo.deg + "°");
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
