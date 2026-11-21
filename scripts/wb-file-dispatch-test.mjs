// 文件级调派接进执行链（2026-11-22）。
//
// 背景：这套东西之前**只有定义、从来没被调用过** —— 勾上开关也不会有任何效果。
// 现在真正接进 workbenchAsk，流程变成两阶段：
//
//   ① 先问「你打算改哪些文件」（明确禁止动手）
//   ② 交给 /api/dispatch 判冲突
//        · 放行 → 拿着锁进入真正干活那一轮 → 干完释放
//        · 排队 → 当成「没做成」稍后重试（不是失败，也不是 stuck）
//   ③ 报的 files 顺手写回台账 ← **这是 files 数据的唯一来源**
//
// 这条测试要验的就是上面每一步**真的发生了**，尤其是第 ③ 步：
// 不写回去，攒数据的整个目标就落空。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8895;
const B = `http://127.0.0.1:${PORT}`;
const SRC = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";

const TMP = mkdtempSync(join(tmpdir(), "filedisp-"));
const BOARD = join(TMP, "board");
mkdirSync(BOARD, { recursive: true });
for (const f of ["ledger.json", "board.config.json", "project.json", "skills.json"]) {
  try { cpSync(join(SRC, f), join(BOARD, f)); } catch {}
}
const LEDGER = join(BOARD, "ledger.json");
const LEDGER_ORIGINAL = readFileSync(LEDGER, "utf8");

const srv = spawn("node", ["scripts/serve.mjs", "--board", BOARD, "--port", String(PORT), "--locks", join(TMP, "locks.json")],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

const profile = join(tmpdir(), "edge-filedisp-" + Date.now());
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

// 拦 /ops-board/ask，记录每一轮的 prompt，并按预设回答
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(3000);

await ev(`(function(){
  window.__OPS_HARNESS__ = { id: '', dir: ${JSON.stringify(BOARD.replace(/\\/g, "\\\\"))}, label: 't' };
  window.__asks = [];
  window.__replySeq = [];      // 预设的回复队列
  var orig = window.fetch.bind(window);
  window.fetch = function(url, opts){
    if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var body = JSON.parse(opts.body);
      var rec = { askId: body.askId, q: String(body.question || '') };
      window.__asks.push(rec);
      var reply = window.__replySeq.shift() || '完成：默认回复';
      setTimeout(function(){
        window.postMessage({ type: 'ops-board/answer', askId: body.askId, ok: true, text: reply, by: 't' }, '*');
      }, 60);
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok: true, askId: body.askId }); } });
    }
    return orig(url, opts);
  };
  return 1;
})()`);

// ── ① 开关默认关，且关着时不走两阶段 ──
console.log("[1] 开关默认关：不报意图，只问一轮");
{
  const plan = await fetch(B + "/api/flow/plan").then((r) => r.json());
  const ready = (plan.runnable || []).filter((r) => r.state === "ready").map((r) => r.id);
  if (!ready.length) { ok(false, "有可开工的卡", "没有"); }
  else {
    const card = ready[0];
    await ev(`window.__asks = []; window.__replySeq = ['完成：做完了']; 1`);
    await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
    await wait(300);
    await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; 1`);
    await ev(`window.__wb.dragPool = [${JSON.stringify(card)}]; 1`);
    await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
    for (let i = 0; i < 25; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
    await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
    await wait(4000);
    const asks = JSON.parse(await ev(`JSON.stringify(window.__asks || [])`));
    ok(asks.length >= 1, "问了", asks.length + " 轮");
    ok(!/先别动手/.test(asks[0].q || ""), "**没有报意图那一轮**（开关关着）",
      (asks[0].q || "").slice(0, 40));
  }
}

// ── ② 开关打开：两阶段 ──
console.log("\n[2] 开关打开：先报意图（不动手），再干活");
{
  writeFileSync(LEDGER, LEDGER_ORIGINAL, "utf8");
  await send("Page.navigate", { url: B + "/#view-overview" });
  await wait(2600);
  await ev(`(function(){
    window.__OPS_HARNESS__ = { id: '', dir: ${JSON.stringify(BOARD.replace(/\\/g, "\\\\"))}, label: 't' };
    window.__asks = []; window.__replySeq = [];
    var orig = window.fetch.bind(window);
    window.fetch = function(url, opts){
      if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
        var body = JSON.parse(opts.body);
        window.__asks.push({ askId: body.askId, q: String(body.question || '') });
        var reply = window.__replySeq.shift() || '完成：默认';
        setTimeout(function(){ window.postMessage({ type:'ops-board/answer', askId: body.askId, ok:true, text: reply, by:'t' }, '*'); }, 60);
        return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok:true, askId: body.askId }); } });
      }
      return orig(url, opts);
    };
    document.querySelector('[data-wb-file-dispatch]').checked = true;
    return 1;
  })()`);

  const plan = await fetch(B + "/api/flow/plan").then((r) => r.json());
  const card = (plan.runnable || []).filter((r) => r.state === "ready")[0].id;
  // 第一轮回计划，第二轮回结论
  await ev(`window.__asks = []; window.__replySeq = ${JSON.stringify([
    '看完了。\n```json\n{"files":["utils/data-store.js"],"willUse":["utils/request.js"],"plan":"改数据层"}\n```',
    '完成：改好了 utils/data-store.js',
  ])}; 1`);
  await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
  await wait(300);
  await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; 1`);
  await ev(`window.__wb.dragPool = [${JSON.stringify(card)}]; 1`);
  await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  for (let i = 0; i < 25; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
  await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  await wait(7000);

  const asks = JSON.parse(await ev(`JSON.stringify(window.__asks || [])`));
  console.log("    问了 " + asks.length + " 轮");
  ok(asks.length >= 2, "**问了两轮**（先报计划、再干活）", asks.length + " 轮");
  ok(/先别动手/.test(asks[0].q || ""), "第一轮是**报意图**（明确禁止动手）",
    (asks[0].q || "").slice(0, 40));
  ok(!/先别动手/.test(asks[1].q || ""), "第二轮是**真干活**", (asks[1].q || "").slice(0, 40));
  ok(/计划已批准/.test(asks[1].q || ""), "第二轮明确说「计划已批准，可以动手」", "");
  ok(/只改这些/.test(asks[1].q || ""), "**把批准的清单念给它**，防止擅自扩大范围", "");
}

// ── ③ files 真的写回台账（最关键）──
console.log("\n[3] 报的 files **真的写回台账**（这是数据来源）");
{
  await wait(1200);
  const led = JSON.parse(readFileSync(LEDGER, "utf8"));
  const withFiles = (led.items || []).filter((i) => Array.isArray(i.files) && i.files.length);
  console.log("    带 files 的卡: " + withFiles.length + " 条 · " +
    JSON.stringify(withFiles.map((i) => ({ id: i.id, files: i.files }))));
  ok(withFiles.length >= 1, "**至少一张卡有了 files**", withFiles.length + " 条");
  const it = withFiles[0];
  ok(it && it.files.indexOf("utils/data-store.js") > -1, "内容就是 agent 报的那个",
    it ? it.files.join(",") : "(无)");
  ok(it && Array.isArray(it.willUse) && it.willUse.indexOf("utils/request.js") > -1,
    "willUse 也记下来了（下次判冲突不用再问）", it ? JSON.stringify(it.willUse) : "(无)");
}

// ── ④ 锁用完要释放 ──
console.log("\n[4] 干完释放锁（不释放会一直挡着别人）");
{
  const locks = await fetch(B + "/api/locks").then((r) => r.json());
  ok(locks.count === 0, "**锁已释放**", locks.count + " 把还占着");
}

// ── ⑤ 计划不合要求 → 按未做成处理，不崩 ──
console.log("\n[5] 计划写得乱七八糟 → 按未做成处理，不崩");
{
  writeFileSync(LEDGER, LEDGER_ORIGINAL, "utf8");
  await send("Page.navigate", { url: B + "/#view-overview" });
  await wait(2400);
  await ev(`(function(){
    window.__OPS_HARNESS__ = { id: '', dir: ${JSON.stringify(BOARD.replace(/\\/g, "\\\\"))}, label: 't' };
    window.__asks = []; window.__replySeq = ['我觉得这个卡挺简单的，随便改改就行。','还是不行','真的不行'];
    var orig = window.fetch.bind(window);
    window.fetch = function(url, opts){
      if (String(url).indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
        var body = JSON.parse(opts.body);
        window.__asks.push({ askId: body.askId, q: String(body.question || '') });
        var reply = window.__replySeq.shift() || '完成：默认';
        setTimeout(function(){ window.postMessage({ type:'ops-board/answer', askId: body.askId, ok:true, text: reply, by:'t' }, '*'); }, 60);
        return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok:true, askId: body.askId }); } });
      }
      return orig(url, opts);
    };
    document.querySelector('[data-wb-file-dispatch]').checked = true;
    return 1;
  })()`);
  const plan = await fetch(B + "/api/flow/plan").then((r) => r.json());
  const card = (plan.runnable || []).filter((r) => r.state === "ready")[0].id;
  await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
  await wait(300);
  await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; 1`);
  await ev(`window.__wb.dragPool = [${JSON.stringify(card)}]; 1`);
  await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  for (let i = 0; i < 25; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
  await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  await wait(9000);
  const st = JSON.parse(await ev(`JSON.stringify((window.__wb.order||[]).map(function(o){
    return { id:o.id, done:!!o.done, stuck:!!o.stuck, tries:o.tries||0 };
  }))`));
  console.log("    " + JSON.stringify(st));
  ok(st.length > 0, "仍有一张卡在队列里", "");
  ok(st[0].stuck === true || st[0].tries >= 1,
    "**被当成「没做成」处理**（重试或标红，而不是假装成功）", JSON.stringify(st[0]));
}

writeFileSync(LEDGER, LEDGER_ORIGINAL, "utf8");
ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
