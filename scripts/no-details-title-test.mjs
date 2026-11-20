// 详情页不再有「没实际意义的大标题」（2026-11-20 用户定）。
//
// 用户原话：「需求 / 按阶段推进 这种没有实际意义的大标题不要加上」
// 追问确认：三个页面的大标题全删（车道页「按阶段推进」、收口页「收口记录」、
// Skill 页「Skill 台账」）。
//
// 理由：这三个 h1 对所有页面都一样 / 说的就是上一行 kicker 已经说过的事，
// 提供不了新信息，只是把内容往下推一大截。
//
// 要验：
//   ① 五个详情页都没有 `.details-title`（h1 大标题）；
//   ② kicker 那行**必须还在** —— 现在是页面唯一的身份标识，删了大标题
//      就只剩它了，丢了就真的没标题了；
//   ③ kicker 后面紧跟的就是状态表（不再有一大块空白 / 空标题占位）；
//   ④ CSS 里 .details-title 规则也删了（不留孤儿样式）。
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

const profile = join(tmpdir(), "edge-notitle-" + Date.now());
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

const DETAIL_VIEWS = ["lane-feature", "lane-bug", "lane-risk", "closed", "skills"];

console.log("[1] 五个详情页都没有大标题");
const titles = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(DETAIL_VIEWS)}.forEach(function(k){
    var v = document.querySelector('[data-view="' + k + '"]');
    if (!v) { out.push({ view: k, exists: false }); return; }
    out.push({
      view: k, exists: true,
      h1: v.querySelectorAll('h1').length,
      detailsTitle: v.querySelectorAll('.details-title').length,
      // 页面上第一个 h1 的文字（如果还有）
      h1Text: v.querySelector('h1') ? v.querySelector('h1').textContent.trim() : ''
    });
  });
  return out;
})())`));
const stillHas = titles.filter((t) => t.exists && (t.h1 > 0 || t.detailsTitle > 0));
ok(stillHas.length === 0, "五个详情页都没有 h1 / .details-title",
  stillHas.length ? JSON.stringify(stillHas) : DETAIL_VIEWS.length + " 页全部干净");
// 具体点名三个原来有大标题的
for (const v of ["lane-feature", "lane-bug", "lane-risk"]) {
  const t = titles.find((x) => x.view === v);
  ok(t && t.exists && t.h1 === 0, v + " 没有「按阶段推进」那行大标题",
    t && t.h1Text ? "仍有：" + t.h1Text : "已删");
}

console.log("\n[2] kicker 必须还在（现在是页面唯一的身份标识）");
const kickers = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(DETAIL_VIEWS)}.forEach(function(k){
    var v = document.querySelector('[data-view="' + k + '"]');
    if (!v) return;
    var kk = v.querySelector('.details-main > .kicker');
    out.push({ view: k, has: !!kk, text: kk ? kk.textContent.trim().slice(0, 40) : '' });
  });
  return out;
})())`));
const noKicker = kickers.filter((k) => !k.has || !k.text);
ok(noKicker.length === 0, "每页都有 kicker 且有文字",
  kickers.map((k) => k.view + "=「" + k.text + "」").join(" · "));

console.log("\n[3] kicker 后面紧跟状态表（不再有空白或空标题占位）");
const order = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(DETAIL_VIEWS)}.forEach(function(k){
    var v = document.querySelector('[data-view="' + k + '"]');
    if (!v) return;
    var main = v.querySelector('.details-main');
    if (!main) { out.push({ view: k, err: 'no-main' }); return; }
    var kk = main.querySelector(':scope > .kicker');
    if (!kk) { out.push({ view: k, err: 'no-kicker' }); return; }
    // kicker 的**下一个元素兄弟**应该就是状态表
    var next = kk.nextElementSibling;
    out.push({
      view: k,
      nextTag: next ? next.tagName : null,
      nextIsBoard: !!(next && next.classList.contains('stage-board')),
      // kicker 与下一个元素之间的垂直间距（不该有大块空白）
      gap: next ? Math.round(next.getBoundingClientRect().top - kk.getBoundingClientRect().bottom) : null
    });
  });
  return out;
})())`));
const badOrder = order.filter((o) => o.err || !o.nextIsBoard);
ok(badOrder.length === 0, "每页 kicker 的下一个元素就是 .stage-board",
  badOrder.length ? JSON.stringify(badOrder) : order.map((o) => o.view + "(间距" + o.gap + "px)").join(" · "));
const bigGap = order.filter((o) => o.gap !== null && o.gap > 24);
ok(bigGap.length === 0, "kicker 与状态表之间没有残留的大块空白（<24px）",
  bigGap.length ? JSON.stringify(bigGap) : "最大间距 " + Math.max(...order.map((o) => o.gap || 0)) + "px");

console.log("\n[4] CSS 里的 .details-title 规则也删了（不留孤儿样式）");
const cssSrc = readFileSync("D:\\WorkSpace-Tools\\ops-board\\scripts\\lib\\css.mjs", "utf8");
// 只查「作为选择器出现」，不查注释里提到这个名字
const ruleRe = /^\s*\.details-title\s*\{/m;
ok(!ruleRe.test(cssSrc), "css.mjs 里没有 .details-title 的样式规则",
  ruleRe.test(cssSrc) ? "仍有规则" : "已删");

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
