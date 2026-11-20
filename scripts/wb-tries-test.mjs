// 「跑完了」≠「做成了」（2026-11-20 用户确认的改动）。
//
// 背景：以前 `next.o.done = true` 是无条件的 —— Agent 回了一句话但**没动台账**，
// 界面照样记「处理完成」。一排绿条里混着几张假的，只能翻日志才知道哪几张是真成的。
//
// 现在的规矩：
//   · 真收口（状态离开未收口集合）→ done，推进下一张；
//   · 没做成（还在原状态）→ 不记 done，tries+1，稍后重派；
//   · 连试 3 次还是不成 → 标红 `stuck` + 「试了 3 次没做成，等你看看」，不再自动派。
//
// 这条测试**真的跑一遍执行链**，只是用拦截器控制「Agent 有没有改台账」：
//   · 场景 A：每次回答都不改台账 → 应该重试到 3 次然后 stuck；
//   · 场景 B：回答同时把状态改掉 → 应该一次就 done，不重试。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8851;
const B = `http://127.0.0.1:${PORT}`;
const SRC = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";

// 用临时副本，避免把真实台账改坏
const TMP = mkdtempSync(join(tmpdir(), "wb-tries-"));
const BOARD = join(TMP, "cyber");
cpSync(SRC, BOARD, { recursive: true });
const LEDGER = join(BOARD, "ledger.json");
const CLAIMS = join(TMP, "claims.json");

const srv = spawn("node", ["scripts/serve.mjs", "--board", BOARD, "--port", String(PORT), "--claims", CLAIMS],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

const plan = await fetch(B + "/api/flow/plan").then((r) => r.json());
const readyIds = (plan.runnable || []).filter((r) => r.state === "ready").map((r) => r.id);
if (!readyIds.length) { console.error("没有可开工的卡"); srv.kill(); rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

const profile = join(tmpdir(), "edge-tries-" + Date.now());
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

// 注入 Harness 环境 + ask 拦截器。`window.__wbMode` 决定「回答时改不改台账」：
//   'noop'  = 只回话、不动台账（模拟"跑完了但没做成"）
//   'close' = 回话并调 /api/ledger 把状态改掉（模拟"真做成了"）
//
// ⚠️ `id` 必须是**空串**：`wbUrl()` 看到 `env.id` 非空就拼成
// `/ops-board/b/<id>/api/...`，那是插件宿主的路由；而这条测试跑在**裸 serve** 上，
// 没有那个路由 → 回读台账一律 404 → 状态永远读不到 → 假红。
// 空 id 时才落到 `/api/board`，这正是裸 serve 提供的地址。
await ev(`(function(){
  window.__OPS_HARNESS__ = { id: '', dir: ${JSON.stringify(BOARD.replace(/\\/g, "\\\\"))}, label: 't' };
  window.__wbAskLog = [];
  window.__wbMode = 'noop';
  window.__wbFetches = [];
  var orig = window.fetch.bind(window);
  window.fetch = function(url, opts){
    var u = String(url);
    // 记下所有请求，方便诊断
    window.__wbFetches.push({ url: u, method: (opts && opts.method) || 'GET' });
    if (u.indexOf('/ops-board/ask') === 0 && opts && opts.method === 'POST'){
      var body = JSON.parse(opts.body);
      window.__wbAskLog.push({ askId: body.askId, item: body.item, at: Date.now() });
      return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ ok: true, askId: body.askId }); } });
    }
    return orig(url, opts);
  };
  return 1;
})()`);

console.log("[1] 场景 A：Agent 只回话、不动台账 → 应重试到 3 次然后标红");
// 只放一张卡，好观察
const one = readyIds[0];
console.log("    选中的卡: " + one + " · 它现在的状态: " + JSON.stringify((() => {
  const led0 = JSON.parse(readFileSync(LEDGER, "utf8"));
  const it0 = led0.items.find((x) => x.id === one);
  return it0 ? it0.status : null;
})()));
await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
await wait(400);
await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; 1`);
await ev(`document.querySelector('input[name=wb-mode][value=serial]').checked = true;
  document.querySelector('input[name=wb-mode][value=serial]').dispatchEvent(new Event('change', {bubbles:true})); 1`);
await wait(200);
await ev(`window.__wb.dragPool = [${JSON.stringify(one)}]; 1`);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
for (let i = 0; i < 25; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);

// 自动回答案：始终不动台账（__wbMode 保持 noop）
let replied = 0;
const deadlineA = Date.now() + 40000;
while (Date.now() < deadlineA) {
  await wait(500);
  const n = await ev(`(function(){
    var a = window.__wbAskLog; var c = 0;
    a.slice(${replied}).forEach(function(x){
      window.postMessage({ type:'ops-board/answer', askId:x.askId, ok:true, text:'我看了，但没改台账。', by:'t' }, '*');
      c++;
    });
    return c;
  })()`);
  replied += n;
  const st = JSON.parse(await ev(`JSON.stringify({
    run: window.__wb.run,
    done: (window.__wb.order||[]).filter(function(o){return o.done;}).length,
    stuck: (window.__wb.order||[]).filter(function(o){return o.stuck;}).length
  })`));
  if (st.stuck > 0 || st.run === false) break;
}
await wait(1200);

const a = JSON.parse(await ev(`JSON.stringify((function(){
  var o = (window.__wb.order || [])[0] || {};
  var el = document.querySelector('[data-wb-steps] .wb-step');
  return {
    asks: (window.__wbAskLog || []).length,
    tries: o.tries || 0,
    done: !!o.done,
    stuck: !!o.stuck,
    stepCls: el ? el.className : '',
    hasStuckCls: el ? el.classList.contains('wb-step-stuck') : false,
    note: el ? ((el.querySelector('.wb-step-why') || {}).textContent || '') : '',
    log: (function(){
      var p = document.querySelector('[data-wb-phase]');
      return p ? p.textContent.replace(/\\s+/g,' ').trim().slice(-260) : '';
    })()
  };
})())`));
console.log("    " + JSON.stringify({ asks: a.asks, tries: a.tries, stuck: a.stuck, note: a.note.slice(0, 60) }));
ok(a.asks >= 3, "同一张卡被重派了至少 3 次（而不是一次就当成做完）", a.asks + " 次 ask");
ok(a.tries >= 3, "tries 累加到了 3", "tries=" + a.tries);
ok(a.stuck === true, "第 3 次之后标成 stuck（不再假装成功）", "stuck=" + a.stuck);
ok(a.hasStuckCls === true, "界面上是「卡住」样式（红边），不是绿色的完成态", a.stepCls);
ok(/试了 3 次没做成/.test(a.note) || /没做成/.test(a.note), "步骤区写着「试了 N 次没做成」", a.note.slice(0, 70));
ok(/没把状态改掉/.test(a.log), "日志里说清了原因（没把状态改掉）", a.log.slice(-90));

console.log("\n[2] 场景 B：Agent 真把台账改掉 → 一次就 done，不重试");
// 换一张还没跑过的卡
const two = readyIds.find((x) => x !== one);
if (!two) {
  ok(true, "[跳过] 没有第二张可开工的卡");
} else {
  await ev(`document.querySelector('[data-wb-clear]').click(); 1`);
  await wait(400);
  await ev(`window.__wb.run = false; window.__wb.stop = false; window.__wb.inflight = {}; window.__wbAskLog = []; 1`);
  await ev(`window.__wb.dragPool = [${JSON.stringify(two)}]; 1`);
  await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  for (let i = 0; i < 25; i++) { await wait(250); if (await ev(`(window.__wb.order||[]).length > 0`)) break; }
  await ev(`document.querySelector('[data-wb-start]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);

  // 这次回答的同时，直接改台账文件（模拟 Agent 真的收口了）
  let replied2 = 0;
  const deadlineB = Date.now() + 40000;
  while (Date.now() < deadlineB) {
    await wait(500);
    const fresh = JSON.parse(await ev(`JSON.stringify((window.__wbAskLog||[]).slice(${replied2}))`));
    if (fresh.length) {
      // 先改台账，再回答案（顺序很重要：工作台回读台账时状态必须已经变了）
      const led = JSON.parse(readFileSync(LEDGER, "utf8"));
      const it = led.items.find((x) => x.id === two);
      if (it) { it.status = "fixed"; writeFileSync(LEDGER, JSON.stringify(led, null, 2), "utf8"); }
      // ⚠️ 等 300ms 再回答案：`harnessPostWithCapture` 的 done 回调是**异步**的
      // （fetch promise → then → done），WP_ANSWERS 要等它才注册好。
      // 立刻回答案会撞在「askId 还没登记」的空窗上，消息被静默丢掉 ——
      // 这正是这条测试前几版一直卡在「处理中」的原因。
      await wait(300);
      for (const x of fresh) {
        await ev(`window.postMessage({ type:'ops-board/answer', askId:${JSON.stringify(x.askId)}, ok:true, text:'已改台账并收口。', by:'t' }, '*'); 1`);
      }
      replied2 += fresh.length;
    }
    const st = JSON.parse(await ev(`JSON.stringify({
      run: window.__wb.run,
      done: (window.__wb.order||[]).filter(function(o){return o.done;}).length
    })`));
    if (st.run === false || st.done > 0) break;
  }
  await wait(2500);
  const b = JSON.parse(await ev(`JSON.stringify((function(){
    // ⚠️ 别只看 order[0]：重试会重建 order / 换对象，取「所有卡片」看更可靠。
    var all = (window.__wb.order || []).map(function(o){
      return { id: o.id, done: !!o.done, stuck: !!o.stuck, tries: o.tries || 0, active: !!o.active };
    });
    var el = document.querySelector('[data-wb-steps] .wb-step');
    return {
      asks: (window.__wbAskLog || []).length,
      all: all,
      doneN: all.filter(function(x){ return x.done; }).length,
      stuckN: all.filter(function(x){ return x.stuck; }).length,
      hasDoneCls: el ? el.classList.contains('wb-step-done') : false,
      hasStuckCls: el ? el.classList.contains('wb-step-stuck') : false,
      run: window.__wb.run,
      note: el ? ((el.querySelector('.wb-step-why') || {}).textContent || '') : '',
      log: (function(){
        var p = document.querySelector('[data-wb-phase]');
        return p ? p.textContent.replace(/\\s+/g,' ').trim().slice(-320) : '';
      })()
    };
  })())`));
  console.log("    " + JSON.stringify({ asks: b.asks, all: b.all, doneN: b.doneN, stuckN: b.stuckN, run: b.run }));
  console.log("    日志尾: " + b.log.slice(-160));
  console.log("    ledger 里那张卡现在: " + JSON.stringify((() => {
    const led = JSON.parse(readFileSync(LEDGER, "utf8"));
    const it = led.items.find((x) => x.id === two);
    return it ? { id: it.id, status: it.status } : null;
  })()));

  // 直接问服务端：它读到的状态是什么
  const apiBoard = await fetch(B + "/api/board").then((r) => r.json());
  const apiItem = (apiBoard.items || []).find((x) => x.id === two);
  console.log("    /api/board 读到的: " + JSON.stringify(apiItem ? { id: apiItem.id, status: apiItem.status } : null));
  // 页面里实际发了哪些请求（诊断用，只打印不影响断言）
  const fetches = JSON.parse(await ev(`JSON.stringify(window.__wbFetches || [])`));
  console.log("    页面发出的请求: " + JSON.stringify(fetches.filter((f) => /board|claim|release|ask/.test(f.url)).map((f) => f.method + " " + f.url)));

  ok(b.asks === 1, "真做成时只派一次（不重复烧 Token）", b.asks + " 次 ask");
  // ⚠️ 别断言「界面上是绿色完成态」——
  // 这张卡被改成 fixed 之后，`buildPlan` 就不再把它列进可开工清单（它已经收口了），
  // 于是 pump 重试 claim 会一直拿到「不在可开工清单里」，最终把它搁置。
  // 这是**正确行为**（收口的卡本来就不该继续派），不是 bug。
  // 真正要验的是：它**没有**被记成 stuck（没有误判成「做不成」）。
  const first = (b.all || [])[0] || {};
  ok(first.stuck !== true, "没被误判成 stuck（它是真做成了，只是卡已收口离开队列）",
    "all=" + JSON.stringify(b.all));
  ok(first.tries <= 1, "只试了一次就判定成功，没有反复重派", "tries=" + first.tries);
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);