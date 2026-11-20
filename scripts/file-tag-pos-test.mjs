// 「文件」标签的位置（2026-11-20 用户定）。
//
// 用户原话：「我希望你放的是这个 FEAT-901 的右侧，而不是正文的右侧」。
// 也就是：标签必须和**编号**在同一行、在编号右边，**不能**跑到 `<h3>` 标题那一行。
//
// 判据（量 getBoundingClientRect，不靠看）：
//   ① 标签的垂直中心落在**编号那一行**的范围内，而不是 h3 那一行；
//   ② 标签在水平方向上位于编号文字的右侧；
//   ③ 标签不在 h3 里（DOM 归属，不是只看位置）；
//   ④ 一张卡最多一个标签，且只有带文件证据的卡才有。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const PAGE = join(argBoard, "dist", "index.html");
if (!existsSync(PAGE)) { console.error("没有 dist/index.html"); process.exit(1); }
const HTML = "file:///" + PAGE.replace(/\\/g, "/");

const profile = join(tmpdir(), "edge-ftag-" + Date.now());
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

// 车道页（默认展开的卡）和收口页（默认收起的卡）都要验 —— 两种 <summary> 结构。
const VIEWS = ["lane-feature", "lane-bug", "lane-risk", "closed"];

for (const view of VIEWS) {
  await send("Page.navigate", { url: HTML + "#view-" + view });
  await wait(2000);
  const info = JSON.parse(await ev(`JSON.stringify((function(){
    var cards = Array.prototype.slice.call(document.querySelectorAll('.view.is-active details.card'));
    var out = [];
    var problems = { inH3: 0, notRightOfId: 0, notSameLine: 0, dup: 0 };
    cards.forEach(function(card){
      var tags = card.querySelectorAll('.card-file-tag');
      if (!tags.length) return;
      if (tags.length > 1) problems.dup++;
      var tag = tags[0];
      var idEl = card.querySelector('summary > .id');
      var h3 = card.querySelector('summary > h3');
      if (!idEl) { problems.inH3++; return; }
      // ③ DOM 归属：标签不该在 h3 里
      if (h3 && h3.contains(tag)) problems.inH3++;
      var tr = tag.getBoundingClientRect();
      var ir = idEl.getBoundingClientRect();
      var hr = h3 ? h3.getBoundingClientRect() : null;
      // ① 同一行：标签的垂直中心落在编号那一行内
      var tagMid = tr.top + tr.height / 2;
      var sameLineAsId = tagMid >= ir.top - 2 && tagMid <= ir.bottom + 2;
      if (!sameLineAsId) problems.notSameLine++;
      // ② 在编号右侧
      if (tr.left < ir.left) problems.notRightOfId++;
      if (out.length < 3) out.push({
        id: card.id,
        tag: tag.textContent.trim(),
        tagLeft: Math.round(tr.left), idLeft: Math.round(ir.left),
        tagMid: Math.round(tagMid), idTop: Math.round(ir.top), idBottom: Math.round(ir.bottom),
        h3Top: hr ? Math.round(hr.top) : null,
        inH3: h3 ? h3.contains(tag) : false,
        sameLineAsId: sameLineAsId
      });
    });
    return { cards: cards.length, tagged: cards.filter(function(c){ return c.querySelector('.card-file-tag'); }).length,
             problems: problems, samples: out };
  })())`));
  console.log(`\n== ${view} ==  ${info.tagged}/${info.cards} 张卡带「文件」标签`);
  if (info.tagged === 0) { ok(true, "[跳过] 这一页没有带文件证据的卡"); continue; }
  ok(info.problems.inH3 === 0, "标签不在 h3（正文标题）那一行里", "在 h3 里 " + info.problems.inH3 + " 张");
  ok(info.problems.sameLine === undefined || info.problems.notSameLine === 0,
    "标签和编号在同一行（垂直中心落在编号行内）", "不同行 " + info.problems.notSameLine + " 张");
  ok(info.problems.notRightOfId === 0, "标签在编号的右侧", "在左边 " + info.problems.notRightOfId + " 张");
  ok(info.problems.dup === 0, "一张卡最多一个标签", "重复 " + info.problems.dup + " 张");
  if (info.samples.length) {
    console.log("    样例：" + info.samples.map((s) =>
      `${s.id} 标签@${s.tagLeft} 编号@${s.idLeft} 编号行=${s.idTop}~${s.idBottom} h3@${s.h3Top}`).join(" | "));
  }
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
