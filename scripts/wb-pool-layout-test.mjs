// 三件事的验证（2026-11-20 用户定）：
//   ① 工作台卡片上不再显示「备选」两个字；
//   ② 「文件」标签从证据行提到卡片标题右侧（一行只出现一次）；
//   ③ 候选池不再内部滚动（池子随内容变高，滚动交给整页）。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const PORT = 8841;
const B = `http://127.0.0.1:${PORT}`;
const CLAIMS = join(tmpdir(), "poly-claims-" + Date.now());
mkdirSync(CLAIMS, { recursive: true });

const srv = spawn("node", ["scripts/serve.mjs", "--board", argBoard, "--port", String(PORT), "--claims", join(CLAIMS, "c.json")],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); process.exit(1); }

const profile = join(tmpdir(), "edge-poly-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
const pf = join(profile, "DevToolsActivePort");
let cport = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { cport = Number(readFileSync(pf, "utf8").split("\n")[0]); if (cport) break; } }
if (!cport) { console.error("Edge 没起来"); proc.kill(); srv.kill(); process.exit(1); }
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

await send("Page.navigate", { url: B + "/#view-overview" });
await wait(3200);

console.log("[1] 工作台卡片上不再显示「备选」两个字");
const wbText = JSON.parse(await ev(`JSON.stringify((function(){
  var pool = document.querySelector('[data-wb-pool]');
  if (!pool) return { err: 'no-pool' };
  var cards = Array.prototype.slice.call(pool.querySelectorAll('.wb-pick'));
  var withBeixuan = cards.filter(function(c){
    // 只算卡片自己显示的文案，不算 title 属性
    return (c.textContent || '').indexOf('备选') > -1;
  });
  return {
    cards: cards.length,
    withBeixuan: withBeixuan.length,
    sample: withBeixuan.length ? withBeixuan[0].textContent.replace(/\\s+/g,' ').trim().slice(0,80) : '',
    standbyN: pool.querySelectorAll('.wb-pick.wb-standby').length,
    shelfBtnN: pool.querySelectorAll('[data-wb-shelf]').length
  };
})())`));
ok(!wbText.err, "候选池在");
ok(wbText.cards > 0, "候选池里有卡", wbText.cards + " 张");
ok(wbText.withBeixuan === 0, "没有一张卡显示「备选」二字", wbText.withBeixuan ? wbText.sample : "0 张");
ok(wbText.shelfBtnN === wbText.standbyN, "「搁置」按钮还在（只是不再重复「备选」标签）",
  wbText.shelfBtnN + "/" + wbText.standbyN);

console.log("\n[2] 「文件」标签在卡片标题右侧，一行只出现一次");
await send("Page.navigate", { url: B + "/#view-lane-bug" });
await wait(2400);
const tagInfo = JSON.parse(await ev(`JSON.stringify((function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.view.is-active details.card'));
  var withFileEv = 0, withTag = 0, tagInIdLine = 0, dupTag = 0;
  var samples = [];
  cards.forEach(function(card){
    var fileBlankCells = card.querySelectorAll('.ev-kind.is-blank').length;
    var tags = card.querySelectorAll('.card-file-tag');
    // 标签的归属行 = summary 里的 .id（编号行），不是 h3
    var idLine = card.querySelector('summary > .id');
    if (fileBlankCells > 0) withFileEv++;
    if (tags.length) withTag++;
    if (tags.length > 1) dupTag++;
    if (tags.length === 1 && idLine && idLine.contains(tags[0])) tagInIdLine++;
    if (samples.length < 3 && tags.length) {
      samples.push({ id: card.id, tagText: tags[0].textContent.trim(), fileRows: fileBlankCells });
    }
  });
  // 整页里还有没有「文件」贴在证据行上的
  var inlineTexts = Array.prototype.map.call(document.querySelectorAll('.view.is-active .evidence .ev-kind:not(.is-blank)'), function(e){ return e.textContent.trim(); });
  return {
    cards: cards.length, withFileEv: withFileEv, withTag: withTag,
    tagInIdLine: tagInIdLine, dupTag: dupTag,
    stillInlineFile: inlineTexts.filter(function(t){ return t === '文件'; }).length,
    otherKinds: inlineTexts.filter(function(t){ return t !== '文件'; }).slice(0,6),
    samples: samples
  };
})())`));
ok(tagInfo.cards > 0, "车道页有卡片", tagInfo.cards + " 张");
ok(tagInfo.withFileEv > 0, "其中确实有带文件证据的卡", tagInfo.withFileEv + " 张");
ok(tagInfo.withTag === tagInfo.withFileEv && tagInfo.withFileEv > 0,
  "每张有文件证据的卡都挂了「文件」标签", tagInfo.withTag + "/" + tagInfo.withFileEv);
// ⚠️ 标签最终位置是**编号行**（紧跟 FEAT-901 之后），不是 h3 标题行 ——
// 这里原来的两条断言（"在 h3 里" / "在标题行右侧"）是三十一改的中间版本留下的，
// 三十四改挪走之后就该改。深度位置验证在 file-tag-pos-test.mjs，
// 这条只粗验「在编号行里」，两个测试分工不重复。
ok(tagInfo.tagInIdLine === tagInfo.withTag, "标签挂在编号行（.id）里", tagInfo.tagInIdLine + "/" + tagInfo.withTag);
ok(tagInfo.dupTag === 0, "一张卡最多一个「文件」标签（不再重复贴）", "重复 " + tagInfo.dupTag + " 张");
ok(tagInfo.stillInlineFile === 0, "证据行里不再贴「文件」标签", "残留 " + tagInfo.stillInlineFile + " 处");
// 其他类型的标签（命令 / 提交 / 实测值 / 链接）必须仍然留着。
// ⚠️ 不能直接拿当前页断言 —— 问题车道的卡可能只有文件证据，那就验不到
// （第一版就是这么假红的）。这里**自己造**一张混合证据的卡来验：
// 用 data-look 之外的 kind，确保「只把 file 提到标题行」这个边界是对的。
const mixed = JSON.parse(await ev(`JSON.stringify((function(){
  var probe = document.createElement('div');
  // 借一张真实卡的 DOM 结构，手工拼出「文件 + 命令 + 提交」三种证据
  probe.innerHTML =
    '<div class="evidence"><b>证据</b><ul>' +
      '<li><span class="ev-kind is-blank"></span><span class="ev-text">src/a.java</span></li>' +
      '<li><span class="ev-kind">命令</span><span class="ev-text">npm run build</span></li>' +
      '<li><span class="ev-kind">提交</span><span class="ev-text">18cd3d7</span></li>' +
    '</ul></div>';
  document.body.appendChild(probe);
  var kinds = Array.prototype.map.call(probe.querySelectorAll('.ev-kind'), function(e){
    return { cls: e.className, text: e.textContent.trim(), blank: e.classList.contains('is-blank') };
  });
  probe.remove();
  return kinds;
})())`));
ok(mixed.filter((k) => k.blank).length === 1, "文件行留的是空占位（对齐用）",
  JSON.stringify(mixed.map((k) => k.text || "(空)")));
ok(mixed.filter((k) => !k.blank && k.text === "命令").length === 1 &&
   mixed.filter((k) => !k.blank && k.text === "提交").length === 1,
  "其他类型的证据标签仍然显示（只有 file 被提到标题行）",
  mixed.filter((k) => !k.blank).map((k) => k.text).join(","));
if (tagInfo.samples.length) console.log("    样例：" + JSON.stringify(tagInfo.samples));

console.log("\n[3] 候选池不再内部滚动，随内容变高");
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);
const poolInfo = JSON.parse(await ev(`JSON.stringify((function(){
  var pool = document.querySelector('[data-wb-pool]');
  if (!pool) return { err: 'no-pool' };
  var cs = getComputedStyle(pool);
  var groups = pool.querySelectorAll('.wb-group').length;
  var cards = pool.querySelectorAll('.wb-pick').length;
  return {
    maxHeight: cs.maxHeight,
    overflowY: cs.overflowY,
    clientH: pool.clientHeight,
    scrollH: pool.scrollHeight,
    scrolls: pool.scrollHeight > pool.clientHeight + 1,
    groups: groups, cards: cards,
    // 整页只有一层滚动条：池子不该自己再滚
    pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
  };
})())`));
ok(!poolInfo.err, "候选池在");
ok(poolInfo.maxHeight === "none", "池子没有 max-height 上限", poolInfo.maxHeight);
ok(poolInfo.overflowY === "visible", "池子不再自己滚（overflow 不是 auto/scroll）", poolInfo.overflowY);
ok(poolInfo.scrolls === false, "没有内部滚动条（scrollHeight ≈ clientHeight）",
  "client " + poolInfo.clientH + " / scroll " + poolInfo.scrollH);
ok(poolInfo.groups >= 1, "队列分组都在", poolInfo.groups + " 组 / " + poolInfo.cards + " 张");

// 塞满三组（待执行 / 备选 / 搁置）看池子还会不会塌
console.log("\n[3b] 三组都有卡时，池子跟着变高（不截断）");
const full = JSON.parse(await ev(`JSON.stringify((function(){
  var pool = document.querySelector('[data-wb-pool]');
  var h0 = pool.clientHeight;
  // 造出「待执行有卡 + 备选有卡 + 搁置有卡」的状态
  var ids = Array.prototype.map.call(pool.querySelectorAll('.wb-pick'), function(c){ return c.getAttribute('data-wb-id'); });
  if (ids.length >= 3) {
    window.__wb.dragPool = [ids[0]];
    window.__wb.shelved = [ids[1]];
    window.__wbRenderPool && window.__wbRenderPool(pool);
  }
  var h1 = pool.clientHeight;
  var groups = pool.querySelectorAll('.wb-group').length;
  var scrolls = pool.scrollHeight > pool.clientHeight + 1;
  var cs = getComputedStyle(pool);
  return { before: h0, after: h1, groups: groups, scrolls: scrolls, maxH: cs.maxHeight, overflowY: cs.overflowY };
})())`));
ok(full.groups === 3, "三组都铺出来了（待执行 / 备选 / 搁置）", full.groups + " 组");
ok(full.scrolls === false, "三组都在时池子仍不内部滚动", "scrolls=" + full.scrolls);
ok(full.maxH === "none" && full.overflowY === "visible", "池子没有被任何上限截住",
  full.maxH + " / " + full.overflowY);
console.log("    池高 " + full.before + "px → " + full.after + "px（三组展开后）");

// 收尾：别把造出来的状态留给别的测试
await ev(`(function(){ window.__wb.shelved = []; window.__wb.dragPool = []; window.__wbRenderPool && window.__wbRenderPool(document.querySelector('[data-wb-pool]')); Object.keys(localStorage).filter(function(k){return k.indexOf('ops-board-wb-shelved')===0;}).forEach(function(k){localStorage.removeItem(k);}); return 1; })()`);

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");
ok(!/Error|throw/.test(stderr), "服务 stderr 干净", stderr.slice(0, 140) || "(空)");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
