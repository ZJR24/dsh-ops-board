// 区域标签位置与轮廓尺寸（2026-11-20 用户定）。
//
// 用户原话：「演练ABC这几个标签没有像我说的那样放在标题的右侧呀我看这个标签还有那个鸽子按钮，
// 其实很相似，我希望你改动一下这个标签的样式或颜色区分一下。我希望这个按钮的轮廓线形状，
// 与目前标签的轮廓线在大小上保持一致」
//
// 「鸽子按钮」= 搁置按钮（语音输入）。要验三件事：
//   ① 区域标签（演练A/B/C…）在**标题右侧**，不再压在卡片底部；
//   ② 区域标签与「搁置」按钮**轮廓尺寸一致**（宽高差 ≤1px、圆角/边框同值）；
//   ③ 两者**颜色可区分**（边框色 / 文字色不同，不能长得一样）。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const PORT = 8845;
const B = `http://127.0.0.1:${PORT}`;
const CLAIMS = join(tmpdir(), "tag-claims-" + Date.now());
mkdirSync(CLAIMS, { recursive: true });

const srv = spawn("node", ["scripts/serve.mjs", "--board", argBoard, "--port", String(PORT), "--claims", join(CLAIMS, "c.json")],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); process.exit(1); }

const profile = join(tmpdir(), "edge-tag-" + Date.now());
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

console.log("[1] 区域标签在标题右侧");
const pos = JSON.parse(await ev(`JSON.stringify((function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-pick'));
  var out = [];
  var notRight = 0, inFoot = 0;
  cards.forEach(function(card){
    var pre = card.querySelector('.wb-pick-prefix');
    var title = card.querySelector('.wb-pick-title');
    if (!pre || !title) return;
    var pr = pre.getBoundingClientRect(), tr = title.getBoundingClientRect();
    var cr = card.getBoundingClientRect();
    // 「在标题右侧」：标签左缘 ≥ 标题右缘 - 2，且与该标题在同一视觉行（垂直有交叠）
    var rightOfTitle = pr.left >= tr.right - 2;
    var sameRow = pr.top < tr.bottom && pr.bottom > tr.top;
    var inFootEl = !!pre.closest('.wb-pick-foot');
    if (!(rightOfTitle && sameRow)) notRight++;
    if (inFootEl) inFoot++;
    if (out.length < 4) out.push({
      id: card.getAttribute('data-wb-id'), prefix: pre.textContent.trim(),
      prLeft: Math.round(pr.left), trRight: Math.round(tr.right), cardRight: Math.round(cr.right),
      rightOfTitle: rightOfTitle, sameRow: sameRow, inFoot: inFootEl
    });
  });
  return { cards: cards.length, notRight: notRight, inFoot: inFoot, samples: out };
})())`));
ok(pos.cards > 0, "候选池有卡", pos.cards + " 张");
ok(pos.notRight === 0, "每张卡的区域标签都在标题右侧", pos.notRight + " 张不在右侧");
ok(pos.inFoot === 0, "标签不再压在卡片底部（.wb-pick-foot）里", pos.inFoot + " 张还在底部");
if (pos.samples.length) console.log("    样例：" + JSON.stringify(pos.samples));

console.log("\n[2] 区域标签与「搁置」按钮：轮廓尺寸一致");
const box = JSON.parse(await ev(`JSON.stringify((function(){
  // 同一张备选卡上同时有区域标签和搁置按钮，直接量两者
  var card = document.querySelector('.wb-pick.wb-standby');
  if (!card) return { err: 'no-standby-card' };
  var pre = card.querySelector('.wb-pick-prefix');
  var btn = card.querySelector('[data-wb-shelf]');
  if (!pre || !btn) return { err: 'missing-elements' };
  function info(el) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      padV: cs.paddingTop + '/' + cs.paddingBottom,
      padH: cs.paddingLeft + '/' + cs.paddingRight,
      radius: cs.borderTopLeftRadius,
      borderW: cs.borderTopWidth,
      borderStyle: cs.borderTopStyle,
      borderColor: cs.borderTopColor,
      color: cs.color,
      text: el.textContent.trim()
    };
  }
  return { prefix: info(pre), button: info(btn) };
})())`));
if (box.err) {
  ok(false, "能同时拿到区域标签和搁置按钮", box.err);
} else {
  const a = box.prefix, b = box.button;
  console.log("    区域标签：" + JSON.stringify(a));
  console.log("    搁置按钮：" + JSON.stringify(b));
  ok(Math.abs(a.h - b.h) <= 1, "两者高度一致（轮廓线大小相同）", a.h + "px vs " + b.h + "px");
  ok(a.fontSize === b.fontSize, "字号相同", a.fontSize + " vs " + b.fontSize);
  ok(a.padV === b.padV && a.padH === b.padH, "内边距相同", a.padV + " / " + a.padH + " vs " + b.padV + " / " + b.padH);
  ok(a.radius === b.radius, "圆角相同", a.radius + " vs " + b.radius);
  ok(a.borderW === b.borderW && a.borderStyle === b.borderStyle, "边框粗细与线型相同",
    a.borderW + " " + a.borderStyle + " vs " + b.borderW + " " + b.borderStyle);
  // 区分：颜色必须不同，否则「大小一样 + 长得一样」等于没区分
  ok(a.borderColor !== b.borderColor, "边框颜色不同（一眼分得清谁是标签、谁是按钮）",
    a.borderColor + " vs " + b.borderColor);
  ok(a.color !== b.color, "文字颜色也不同", a.color + " vs " + b.color);
}

console.log("\n[3] 四种卡片形态都用同一套（待执行 / 处理中 / 备选 / 搁置）");
const forms = JSON.parse(await ev(`JSON.stringify((function(){
  var pool = document.querySelector('[data-wb-pool]');
  var ids = Array.prototype.map.call(pool.querySelectorAll('.wb-pick'), function(c){ return c.getAttribute('data-wb-id'); });
  if (ids.length >= 3) {
    window.__wb.dragPool = [ids[0]];      // 待执行
    window.__wb.shelved = [ids[1]];       // 搁置
    window.__wbRenderPool && window.__wbRenderPool(pool);   // 剩下的进备选
  }
  var kinds = { queue: 0, standby: 0, shelved: 0 };
  var prefixInMain = 0, prefixTotal = 0;
  Array.prototype.forEach.call(pool.querySelectorAll('.wb-pick'), function(c){
    if (c.classList.contains('wb-shelved')) kinds.shelved++;
    else if (c.classList.contains('wb-standby')) kinds.standby++;
    else if (c.classList.contains('wb-occupied')) { /* 处理中：单独一类 */ }
    else kinds.queue++;
    var pre = c.querySelector('.wb-pick-prefix');
    if (pre) {
      prefixTotal++;
      if (pre.closest('.wb-pick-main')) prefixInMain++;
    }
  });
  return { kinds: kinds, prefixTotal: prefixTotal, prefixInMain: prefixInMain,
           occupiedExists: !!pool.querySelector('.wb-pick.wb-occupied') };
})())`));
ok(forms.kinds.queue > 0 && forms.kinds.standby > 0 && forms.kinds.shelved > 0,
  "三种形态都在（待执行 / 备选 / 搁置）", JSON.stringify(forms.kinds));
ok(forms.prefixTotal > 0 && forms.prefixInMain === forms.prefixTotal,
  "每张卡的标签都在 .wb-pick-main（标题行）里，不在底部", forms.prefixInMain + "/" + forms.prefixTotal);

// 收尾
await ev(`(function(){ window.__wb.shelved = []; window.__wb.dragPool = []; window.__wbRenderPool && window.__wbRenderPool(document.querySelector('[data-wb-pool]')); Object.keys(localStorage).filter(function(k){return k.indexOf('ops-board-wb-shelved')===0;}).forEach(function(k){localStorage.removeItem(k);}); return 1; })()`);

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");
ok(!/Error|throw/.test(stderr), "服务 stderr 干净", stderr.slice(0, 140) || "(空)");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
