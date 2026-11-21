// 收口页改名：「已修复 / 已关闭 / 暂停」→「已上线 & 搁置」（2026-11-21 用户定）。
//
// 这条测试要钉住的**不是**「名字是什么」（那会随配置变），而是三件结构性的事：
//
//   ① 页面名**只有一个来源**：board.config.json 的 views[].label。
//      代码里（render.mjs / parts.mjs）不许再硬编码它 —— 硬编码过一次的代价是
//      「改了配置不生效，还得同时改代码，两处容易漂」。
//   ② 名字里带 `&` 这类需要 HTML 转义的字符时，导航和配置比对不能假失败。
//      实测踩过：导航渲染成 `已上线 &amp; 搁置`，配置是 `已上线 & 搁置`，
//      直接字符串比 → 永远不等 → 报「导航和配置不一致」的假红。
//   ③ 旧名不许在**用户能看见的地方**残留（注释里可以留，那是历史记录）。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, cpSync, rmSync, mkdtempSync } from "node:fs";
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

// ── ① 配置是唯一来源 ──
console.log("[1] 页名的唯一来源是 board.config.json");
const closedView = (CFG.views || []).find((v) => v.kind === "closed");
ok(!!closedView, "配置里有 kind=closed 的视图", closedView ? closedView.key : "(无)");
const wantName = String((closedView && closedView.label) || "").trim();
ok(wantName.length > 0, "它有 label", wantName);
ok(wantName === "已上线 & 搁置", "**名字是「已上线 & 搁置」**", wantName);

// ── ② 代码里不许硬编码（结构断言，读源码） ──
console.log("\n[2] 代码里不许再硬编码这个名字");
{
  const REPO = "D:\\WorkSpace-Tools\\ops-board";
  const files = ["scripts/render.mjs", "scripts/lib/parts.mjs"];
  for (const rel of files) {
    const src = readFileSync(join(REPO, rel), "utf8");
    // 只看**字符串字面量**里有没有旧名（注释不算 —— 注释记历史是好事）
    const literalHits = src.split(/\r?\n/).filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return /已修复\s*\/\s*已关闭\s*\/\s*暂停/.test(t);
    });
    ok(literalHits.length === 0,
      rel + " 的**代码**里没有硬编码旧名（注释可以留）",
      literalHits.length ? literalHits[0].trim().slice(0, 70) : "(无)");
  }
  // 新名也不该被硬编码成「主要来源」—— 只允许当兜底默认值
  const renderSrc = readFileSync(join(REPO, "scripts/render.mjs"), "utf8");
  ok(/config\.views/.test(renderSrc), "render.mjs 从配置读 views", "");
  ok(/config\.views/.test(readFileSync(join(REPO, "scripts/lib/parts.mjs"), "utf8")), "parts.mjs 也从配置读 views", "");
}

// ── ③ 渲染结果：导航 / kicker / 跳转链接都用新名 ──
const profile = join(tmpdir(), "edge-rename-" + Date.now());
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

await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2400);

console.log("\n[3] 页面上三处都显示新名");
const r = JSON.parse(await ev(`JSON.stringify((function(){
  // ① 导航
  var nav = Array.prototype.map.call(document.querySelectorAll('.nav a'), function(a){
    return a.textContent.trim();
  });
  // ② 收口页的 kicker
  var closed = document.querySelector('[data-view="closed"]');
  var kicker = closed ? (closed.querySelector('.kicker') || {}).textContent : '';
  // ③ 车道页上「这 N 项已收口，卡片都在 X 页」那个链接
  var tails = Array.prototype.map.call(document.querySelectorAll('.stage-tail a'), function(a){
    return a.textContent.trim();
  });
  return { nav: nav, kicker: (kicker || '').trim(), tails: tails.slice(0, 3), tailCount: tails.length };
})())`));
console.log("    导航: " + r.nav.join(" → "));
console.log("    kicker: " + r.kicker + " · tail 链接: " + JSON.stringify(r.tails));

ok(r.nav.indexOf(wantName) > -1, "**导航里是「" + wantName + "」**", JSON.stringify(r.nav));
ok(r.nav.every((n) => n.indexOf("&amp;") === -1), "**没有 `&amp;` 残留**（HTML 实体要还原成 `&`）",
  r.nav.filter((n) => n.indexOf("&amp;") > -1).join(",") || "(无)");
ok(r.kicker === wantName, "**收口页 kicker 也是新名**", r.kicker);
// ⚠️ `stage-tail` 那条链接是**死代码**（2026-11-21 复核）：
//    `shouldRenderStageSection()` 对已收口阶段直接返回 false，那段 HTML 不执行。
//    实测两块板 `stage-tail` 的 4 处命中**全是 CSS 规则**，没有实际 DOM。
//    所以这里**不断言它出现**，只断言「如果出现了，用的是新名」——
//    假装验证过一条从不执行的路径，比不验证更糟。
if (r.tailCount === 0) {
  ok(true, "[跳过] 「卡片都在 X 页」那段是死代码，两块板都没有输出",
    "已在 parts.mjs 注释里标明，等确认不要了再连 CSS 一起删");
} else {
  ok(r.tails.every((t) => t === wantName), "车道页的「卡片都在 X 页」链接也是新名",
    JSON.stringify(r.tails));
}

console.log("\n[4] 旧名不出现在用户能看见的地方");
const oldVisible = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ['overview','lane-feature','lane-bug','lane-risk','closed','skills'].forEach(function(k){
    var v = document.querySelector('[data-view="' + k + '"]');
    if (!v) return;
    // 只看可见文本（script/style 里的注释不算）
    var txt = v.textContent || '';
    if (txt.indexOf('已修复 / 已关闭 / 暂停') > -1) out.push(k);
  });
  return out;
})())`));
ok(oldVisible.length === 0, "**六个页面的可见文字里都没有旧名**", oldVisible.join(",") || "(无)");

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
