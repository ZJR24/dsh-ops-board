// 工作台执行驱动器（真 claim/release/互斥 + 模拟 Harness 回答）
//
// 关键前提（flow.mjs 语义）：一张卡要「真的收口」同区域下一件才能顶上。
// 所以 answer stub 收到某张卡的回答后，测试侧就把它在台账里收口，让链能往下走。
// 用临时拷贝看板 + 独立端口/浏览器，串行与并行分成两个互不污染的 phase。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const SRC = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log("  ✓ " + msg + (extra ? " — " + extra : "")); }
  else { fail++; console.log("  ✗ " + msg + (extra ? " — " + extra : "")); }
};

// 起一个独立测试环境：临时看板 + serve + 无头 Edge。返回操作句柄。
async function launchPhase(suffix, port) {
  const TMP = mkdtempSync(join(tmpdir(), "wb-phase-" + suffix));
  const BOARD = join(TMP, "cyber");
  cpSync(SRC, BOARD, { recursive: true });
  const B = `http://127.0.0.1:${port}`;
  const CLAIMS = join(TMP, "flow-claims.json");
  const LEDGER = join(BOARD, "ledger.json");

  const srv = spawn("node", ["scripts/serve.mjs", "--board", BOARD, "--port", String(port), "--claims", CLAIMS], {
    cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
  let up = false;
  for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
  if (!up) { srv.kill(); throw new Error("serve 没起来\n" + stderr); }

  // 收口状态对照
  const led = JSON.parse(readFileSync(LEDGER, "utf8"));
  const ITEM_META = {};
  for (const it of led.items || []) ITEM_META[it.id] = it;
  const CONFIG = JSON.parse(readFileSync(join(BOARD, "board.config.json"), "utf8"));
  const CLOSED = {};
  for (const lane of CONFIG.lanes || []) {
    for (const st of lane.stages || []) { if (!st.open) { CLOSED[lane.key] = st.statuses[0]; break; } }
  }
  const closedSet = new Set();
  // 模拟「Agent 真把卡收口了」。
  //
  // ⚠️ 判据不能只看 plan 里的 running（2026-11-20 修一个间歇性假红 5/6）：
  // 一张卡可能在同一轮里**被领走又交还**，中间只隔几百毫秒；这个 setInterval
  // 每 120ms 扫一次，扫到与否全看运气。漏扫一次 → 卡的状态没变 →
  // 同区域下一张（OPS-902 之于 OPS-901）永远 claim 不到 → 最后卡在 5/6。
  //
  // 改成两个**确定性**来源：
  //   ① 页面已经 ask 过的卡（`window.__wbAsked` 里记着，见 inject()）——
  //      它们走完了整条链路，一定要收口；
  //   ② plan 里正在跑的（兜住「已领未交还」那一刻）。
  // 不再依赖采样时机。
  let askedSnap = null; // () => Promise<string[]>，由 launchPhase 之后赋值
  const closer = setInterval(async () => {
    try {
      const fromPage = askedSnap ? await askedSnap() : [];
      const plan = await fetch(B + "/api/flow/plan").then((r) => r.json());
      const running = (plan.runnable || []).filter((x) => x.state === "running").map((x) => x.id);
      const candidates = [...new Set([...running, ...(fromPage || [])])];
      for (const id of candidates) {
        if (closedSet.has(id)) continue;
        const meta = ITEM_META[id];
        if (!meta || !CLOSED[meta.lane]) continue;
        const l = JSON.parse(readFileSync(LEDGER, "utf8"));
        const it = l.items.find((i) => i.id === id);
        if (!it) { closedSet.add(id); continue; }
        if (it.status === CLOSED[meta.lane]) { closedSet.add(id); continue; }
        it.status = CLOSED[meta.lane];
        writeFileSync(LEDGER, JSON.stringify(l, null, 2), "utf8");
        closedSet.add(id);
        console.log("    [收口] " + id + " → " + CLOSED[meta.lane]);
      }
    } catch {}
  }, 120);

  // Edge
  const profile = join(tmpdir(), "edge-" + suffix + "-" + Date.now());
  mkdirSync(profile, { recursive: true });
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1440,2200", "about:blank"], { stdio: "ignore" });
  const pf = join(profile, "DevToolsActivePort");
  let cport = null;
  for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { cport = Number(readFileSync(pf, "utf8").split("\n")[0]); if (cport) break; } }
  const list = await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: B + "/#view-overview" });
  await wait(3500);
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

  const inject = () => ev(`(function(){
    window.__OPS_HARNESS__ = { id:'cyber', dir:'${BOARD}', label:'cyber', projectDir:'${BOARD}' };
    window.__wbAsked=[];
    var orig=window.fetch;
    window.fetch=function(url,opts){ var u=String(url); if(u.indexOf('/ops-board/ask')>-1){ var b=opts&&opts.body?JSON.parse(opts.body):{}; b.__item=b.title||''; window.__wbAsked.push(b); return Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,askId:b.askId})}); } return orig.apply(window,arguments); };
    setInterval(function(){ var a=window.__wbAsked; if(!a.length)return; var d=window.__wbReplied||[]; for(var i=0;i<a.length;i++){var askId=a[i].askId; if(d.indexOf(askId)>-1)continue; d.push(askId); window.postMessage({type:'ops-board/answer',askId:askId,text:'「'+a[i].__item+'」已处理并收口，结论完成。',error:''},window.location.origin);} window.__wbReplied=d; },600);
    1;
  })()`);

  // 给 closer 一个「页面已经问过哪些卡」的取数口。
  // 从 askId 反查卡号不可靠，直接从页面上的执行进度里读：
  // `.wb-step-done` 的 id 就是「已经跑完的卡」—— 那正是该收口的集合。
  askedSnap = async () => {
    try {
      const ids = await ev(`Array.prototype.map.call(document.querySelectorAll('[data-wb-steps] .wb-step-done'), function(s){ return s.getAttribute('data-wb-step'); })`);
      return Array.isArray(ids) ? ids.filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const close = () => { clearInterval(closer); ws.close(); proc.kill(); srv.kill(); rmSync(TMP, { recursive: true, force: true }); };
  return { B, ev, inject, close, stderr: () => stderr };
}

// 选卡必须走真实路径：点备选卡（[data-wb-add]）加入队列。
// 不能直接改 WB.dragPool —— 那样绕过了 renderWorkbenchPool + workbenchRefreshModeBtn，
// 「分析 / 开始」两个按钮会一直是 disabled，而 disabled 按钮上的 .click() 不派发事件，
// 于是「点了没反应、一件都没跑」，看起来像执行引擎坏了，其实是测试自己把按钮留在了禁用态。
//
// 也不写死卡号：台账在推进，OPS-022 等会随收口掉出候选池，写死就变成「数据一变测试就红」。
// 这里取当下真正可排队的卡（备选区），要几张点几张。
async function selectReady(ev, n) {
  // 先清空队列（点掉所有已排队的 ✕），保证起点确定
  await ev(`(function(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-wb-pool] [data-wb-x]'), function(x){ x.click(); });
    return 1;
  })()`);
  const ready = (await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('[data-wb-pool] [data-wb-add]'), function(e){return e.getAttribute('data-wb-add');}))`)) || "[]";
  const ids = JSON.parse(ready).slice(0, n);
  if (!ids.length) throw new Error("备选区没有可排队的卡");
  for (const id of ids) {
    const clicked = await ev(`(function(){
      var el = document.querySelector('[data-wb-pool] [data-wb-add="' + ${JSON.stringify(id)} + '"]');
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error("备选里找不到卡：" + id);
    await wait(120);
  }
  const pool = JSON.parse((await ev(`JSON.stringify(window.__wb.dragPool)`)) || "[]");
  console.log("    备选可用 " + JSON.parse(ready).length + " 张 · 本次排入 " + pool.join(", "));
  return pool;
}

// 顺序很重要：**先选模式，再点分析**。
// 模式 radio 的 change 只刷新按钮态（workbenchRefreshModeBtn），**不会**重新分析；
// 分析时才读取当前模式决定铺成串行步骤还是多路队列（.wb-lane）。
// 先分析后切模式 = 渲染仍是串行那份，只是按钮变了，看起来像「并行没分路」。
async function analyzeThenStart(ev, mode) {
  await ev(`(function(){
    var r = document.querySelector('input[name=wb-mode][value=${mode}]');
    r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); return 1;
  })()`);
  await wait(200);
  const disabled = await ev(`document.querySelector('[data-wb-analyze]').disabled`);
  if (disabled) throw new Error("分析按钮是 disabled —— 队列没排上卡");
  await ev(`document.querySelector('[data-wb-analyze]').click()`);
  let orderN = 0;
  // 等分析结果。**并行模式下分析会真去问一次「分析窗口」**（三十四改之前是纯本地分组，
  // 现在是 await 一次 LLM 往返），而 gate 里同时还有别的 Edge 在抢 CPU，
  // 12 秒根本不够 —— 之前几次在 gate 里假红就是这个。
  // 给 60 秒；超时仍然报错（那时是真出不来结果，不是慢）。
  for (let i = 0; i < 300; i++) {
    await wait(200);
    orderN = (await ev(`(window.__wb.order||[]).length`)) || 0;
    if (orderN > 0) break;
  }
  if (!orderN) throw new Error("分析 60 秒内没出结果");
  const wbMode = await ev(`window.__wb.mode`);
  if (wbMode !== mode) throw new Error("分析后的执行模式是 " + wbMode + "，期望 " + mode);
  const planned = JSON.parse((await ev(`JSON.stringify((window.__wb.order||[]).map(function(o){return o.id;}))`)) || "[]");
  await ev(`document.querySelector('[data-wb-start]').click()`);
  const running = await ev(`!!window.__wb.run`);
  if (!running) throw new Error("点了开始但 WB.run 仍是 false（按钮可能仍 disabled）");
  return planned;
}

// ============ Phase 1：串行 ============
console.log("[1] 串行：从备选里排若干张（最多 3 张），验证逐件完成且顺序服从建议");
(async () => {
  const h = await launchPhase("serial", 8797);
  await h.inject();
  const picked = await selectReady(h.ev, 3);
  const planned = await analyzeThenStart(h.ev, "serial");
  await wait(26000);
  const stepsDone = await h.ev(`document.querySelectorAll('[data-wb-steps] .wb-step-done').length`);
  const domOrder = (await h.ev(`Array.prototype.map.call(document.querySelectorAll('[data-wb-steps] .wb-step-id'),function(s){return s.textContent;})`)) || [];
  console.log("\n[串行] 完成：" + stepsDone + " · 顺序=" + domOrder.join(","));
  // 排进去几张就断言几张：以前写死 3，台账被真实收口收到只剩 1 张未收口时
  // 这条必然失败 —— 那是数据变了，不是执行引擎坏了。
  ok(planned.length === picked.length && picked.length > 0, "排进去的卡都进了执行计划", "排队 " + picked.join(",") + " · 计划 " + planned.join(","));
  ok(stepsDone === planned.length && stepsDone > 0, "串行全部完成（逐件推进）", "完成 " + stepsDone + "/" + planned.length);
  ok(domOrder.length === planned.length && domOrder.every((v, i) => v === planned[i]), "DOM 顺序 = 分析给出的串行建议", domOrder.join(","));
  const claimsLeft = await fetch(h.B + "/api/flow/plan").then((r) => r.json()).then((j) => (j.runnable || []).filter((x) => x.state === "running").length);
  ok(claimsLeft === 0, "串行 claims 全部交还", "running=" + claimsLeft);
  ok(!/Error|throw/.test(h.stderr()), "串行 stderr 干净", h.stderr().slice(0, 160) || "(空)");
  h.close();
})()

// ============ Phase 2：并行 ============
.then(() => new Promise(async (resolve) => {
  console.log("\n[2] 并行：把备选全部排入，验证多路队列都推进到完成");
  const h = await launchPhase("parallel", 8798);
  await h.inject();
  const picked = await selectReady(h.ev, 99);   // 99 = 备选全要
  const planned = await analyzeThenStart(h.ev, "parallel");
  // 不写死等待时间：路数 = 区域前缀数，某个区域有多张卡时要一张一张轮，
  // 轮数随台账变化。固定 26s 在多一张同区卡的时候就会假红（数据变了，不是坏了）。
  //
  // 上限给 150s，并且**按卡数算**：一个 A 区里 2 张卡就要多轮一轮，5 路 × 每路
  // 若干张，加上每次 claim 重试 1.5s、每批之间 400ms，机器一忙（gate 里同时还有
  // 别的 Edge 在跑）实际耗时会翻倍。60s 在单独跑时够、在 gate 里就不够 ——
  // 这不是引擎的问题，是预算没留够。给足时间仍然不过才是真的没跑完。
  const turnBudget = Math.max(60000, (picked.length + 1) * 20000);
  const paraDeadline = Date.now() + turnBudget;
  while (Date.now() < paraDeadline) {
    await wait(1000);
    const allDone = await h.ev(`(function(){
      var n = document.querySelectorAll('[data-wb-steps] .wb-step-done').length;
      var t = document.querySelectorAll('[data-wb-steps] .wb-step').length;
      return t > 0 && n === t;
    })()`);
    if (allDone) break;
  }
  const paraDone = await h.ev(`document.querySelectorAll('[data-wb-steps] .wb-step-done').length`);
  const paraIds = (await h.ev(`Array.prototype.map.call(document.querySelectorAll('[data-wb-steps] .wb-step-id'),function(s){return s.textContent;})`)) || [];
  const lanes = await h.ev(`document.querySelectorAll('[data-wb-steps] .wb-lane').length`);
  console.log("\n[并行] 完成：" + paraDone + "/" + paraIds.length + " · " + lanes + " 路 · " + paraIds.join(","));
  ok(lanes > 0, "并行按区域铺成了多路队列", lanes + " 路");
  ok(planned.length === picked.length, "排进去的卡都进了执行计划", "排队 " + picked.length + " · 计划 " + planned.length);
  ok(paraDone === paraIds.length && paraDone > 0, "并行全部完成（每路都推进到底）", "完成 " + paraDone + "/" + paraIds.length);
  const claimsLeft = await fetch(h.B + "/api/flow/plan").then((r) => r.json()).then((j) => (j.runnable || []).filter((x) => x.state === "running").length);
  ok(claimsLeft === 0, "并行 claims 全部交还", "running=" + claimsLeft);
  ok(!/Error|throw/.test(h.stderr()), "并行 stderr 干净", h.stderr().slice(0, 160) || "(空)");
  h.close();
  resolve();
}))

.then(() => {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});