// 结论前缀约定（2026-11-21 起）。
//
// 背景：工作台要判断「这轮到底做成了没」，以前只能猜 Agent 那句自然语言 ——
// 我们曾把「我看了，但没改台账」当成「处理完成」，一排绿条里混着几张假的。
//
// 借的是 agent-autoloop 的做法：让 Agent 在**第一行**用固定前缀表明结果，
// 判定就变成「读前缀」而不是「理解语义」。三种前缀：
//   完成：…       → 真做完了
//   未完成：原因   → 跑了但没做成（值得重试）
//   无需处理：原因 → 看过了本来就没事（不重试，也不算失败）
//
// 要验两层：
//   ① 解析器本身（纯函数）：各种写法认不认得出、会不会误判；
//   ② 端到端：真的跑一遍执行链，看四种情况各得到什么结果。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8871;
const B = `http://127.0.0.1:${PORT}`;
const SRC = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
const TMP = mkdtempSync(join(tmpdir(), "wb-verdict-"));
const BOARD = join(TMP, "cyber");
cpSync(SRC, BOARD, { recursive: true });
const LEDGER = join(BOARD, "ledger.json");
const LEDGER_ORIGINAL = readFileSync(LEDGER, "utf8");

const srv = spawn("node", ["scripts/serve.mjs", "--board", BOARD, "--port", String(PORT), "--claims", join(TMP, "c.json")],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来"); srv.kill(); rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

const profile = join(tmpdir(), "edge-verdict-" + Date.now());
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

// ── ① 解析器（纯函数）─────────────────────────────────────────────
//
// `wbParseVerdict` 在 client.js 的 IIFE 内部，页面外取不到，所以**不抄一份逻辑**
// （抄一遍就变成"验我的抄写"，不是验真代码）。解析正确性由下面四段端到端覆盖：
// 每种前缀各自跑一轮真实执行链，看结果落在哪条分支上 —— 那才是真正要保的东西。
console.log("[1] 用端到端验四种前缀（不单独测纯函数，避免抄逻辑）");

// ── ② 端到端：四种前缀各跑一轮 ──
const plan0 = await fetch(B + "/api/flow/plan").then((r) => r.json());
const ready = (plan0.runnable || []).filter((r) => r.state === "ready").map((r) => r.id);
if (!ready.length) { console.error("没有可开工的卡"); ws.close(); proc.kill(); srv.kill(); rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

await ev(`(function(){
  window.__OPS_HARNESS__ = { id: '', dir: ${JSON.stringify(BOARD.replace(/\\/g, "\\\\"))}, label: 't' };
  window.__wbAskLog = [];
  var orig = window.fetch.bind(window);
  window.fetch = function(url, opts){
    if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var body = JSON.parse(opts.body);
      window.__wbAskLog.push({ askId: body.askId, q: String(body.question || '') });
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok: true, askId: body.askId }); } });
    }
    return orig(url, opts);
  };
  return 1;
})()`);

// 跑一张卡，Agent 回指定文本、台账不改；返回最终 order 状态
async function runOne(cardId, replyText) {
  writeFileSync(LEDGER, LEDGER_ORIGINAL, "utf8");
  await send("Page.navigate", { url: B + "/#view-overview" });
  await wait(2600);
  await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
  await wait(300);
  await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; window.__wbAskLog = []; 1`);
  await ev(`window.__wb.dragPool = [${JSON.stringify(cardId)}]; 1`);
  await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  for (let i = 0; i < 30; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
  await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);

  let seen = 0;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await wait(400);
    const fresh = JSON.parse(await ev(`JSON.stringify((window.__wbAskLog||[]).slice(${seen}))`));
    if (fresh.length) {
      await wait(300);   // 等 WP_ANSWERS 注册好
      for (const x of fresh) {
        await ev(`window.postMessage({ type:'ops-board/answer', askId:${JSON.stringify(x.askId)}, ok:true, text:${JSON.stringify(replyText)}, by:'t' }, '*'); 1`);
      }
      seen += fresh.length;
    }
    const st = JSON.parse(await ev(`JSON.stringify({
      run: window.__wb.run,
      done: (window.__wb.order||[]).filter(function(o){return o.done;}).length,
      stuck: (window.__wb.order||[]).filter(function(o){return o.stuck;}).length,
      skipped: (window.__wb.order||[]).filter(function(o){return o.skipped;}).length
    })`));
    if (st.stuck > 0 || (st.done > 0 && seen > 0)) break;
  }
  await wait(1200);
  return JSON.parse(await ev(`JSON.stringify((function(){
    var all = (window.__wb.order||[]).map(function(o){ return { id:o.id, done:!!o.done, stuck:!!o.stuck, skipped:!!o.skipped, tries:o.tries||0 }; });
    var el = document.querySelector('[data-wb-steps] .wb-step');
    return { all: all, asks: (window.__wbAskLog||[]).length,
      cls: el ? el.className : '',
      log: (function(){ var p = document.querySelector('[data-wb-phase]'); return p ? p.textContent.replace(/\\s+/g,' ').trim().slice(-320) : ''; })() };
  })())`));
}

const card = ready[0];

console.log("\n[2] 说「无需处理」→ 记完成、**不重试**（灰条，不是红条）");
{
  const r = await runOne(card, "无需处理：这张卡其实已经被别处修好了，不需要再动。");
  const c0 = (r.all || [])[0] || {};
  console.log("    " + JSON.stringify({ asks: r.asks, done: c0.done, stuck: c0.stuck, skipped: c0.skipped, tries: c0.tries, cls: r.cls }));
  ok(r.asks === 1, "只派一次（无需处理的卡不该重试）", r.asks + " 次 ask");
  ok(c0.done === true, "记成完成，从队列里摘掉", "done=" + c0.done);
  ok(c0.stuck !== true, "**没有**被标成卡住（它不是失败）", "stuck=" + c0.stuck);
  ok(c0.skipped === true, "打了 skipped 标记（便于区分「真做成」和「本来就不用做」）", "skipped=" + c0.skipped);
  ok(/wb-step-na/.test(r.cls), "界面是中性灰条（.wb-step-na），不是红也不是绿", r.cls);
}

console.log("\n[3] 说「未完成」→ 重试到 3 次后标红");
{
  const r = await runOne(card, "未完成：需要动数据库，我不能自己决定，要人来拍板。");
  const c0 = (r.all || [])[0] || {};
  console.log("    " + JSON.stringify({ asks: r.asks, done: c0.done, stuck: c0.stuck, tries: c0.tries, cls: r.cls }));
  ok(r.asks >= 2, "被重派了（不是一次就放过）", r.asks + " 次 ask");
  ok(c0.stuck === true, "最后标成卡住等人", "stuck=" + c0.stuck);
  ok(/wb-step-stuck/.test(r.cls), "界面是红条", r.cls);
  ok(/未完成/.test(r.log), "日志里引用了 Agent 自报的「未完成」原因", r.log.slice(-100));
}

console.log("\n[4] 说「完成」但台账没动 → 记完成，但日志留痕（不静默）");
{
  const r = await runOne(card, "完成：我把该改的都改了。");
  const c0 = (r.all || [])[0] || {};
  console.log("    " + JSON.stringify({ asks: r.asks, done: c0.done, stuck: c0.stuck, tries: c0.tries }));
  ok(c0.done === true, "按完成记（它自报了完成）", "done=" + c0.done);
  ok(/自报「完成」但台账状态没动/.test(r.log), "日志里明确写了「自报完成但台账没动」", r.log.slice(-120));
}

console.log("\n[5] 不按约定前缀说话 → 按未做成处理（会重试）");
{
  const r = await runOne(card, "我看了这张卡，感觉问题不大，建议再观察一下。");
  const c0 = (r.all || [])[0] || {};
  console.log("    " + JSON.stringify({ asks: r.asks, done: c0.done, stuck: c0.stuck, tries: c0.tries }));
  ok(r.asks >= 2, "没按前缀 → 不放过，会重试", r.asks + " 次 ask");
  ok(c0.stuck === true, "重试到上限后标红", "stuck=" + c0.stuck);
  ok(/没按约定前缀/.test(r.log), "日志提示它没按格式回报", r.log.slice(-120));
}

writeFileSync(LEDGER, LEDGER_ORIGINAL, "utf8");
ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
