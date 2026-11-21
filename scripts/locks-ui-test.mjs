// 文件占用面板 + 文件级调派开关（中控化步骤 6）。
//
// 要验的是**用户能不能看懂**，不是代码跑没跑通：
//   ① 没有锁时，面板整块藏起来（空面板只是噪音）
//   ② 有锁时显示：谁占的、哪些文件、波及面、**对应哪几张卡**、还有多久到期
//   ③ 锁回收按钮能真的把锁清掉（agent 崩了要能人工清）
//   ④ 文件级调派开关默认关（新机制先能试，不默认打断现有流程）
//   ⑤ 拉 /api/locks 走的是真接口，不是前端编的
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8893;
const B = `http://127.0.0.1:${PORT}`;
const SRC = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";

const TMP = mkdtempSync(join(tmpdir(), "locks-ui-"));
const BOARD = join(TMP, "board");
mkdirSync(BOARD, { recursive: true });
for (const f of ["ledger.json", "board.config.json", "project.json", "skills.json"]) {
  try { cpSync(join(SRC, f), join(BOARD, f)); } catch {}
}
const LOCKS = join(TMP, "locks.json");

const srv = spawn("node", ["scripts/serve.mjs", "--board", BOARD, "--port", String(PORT), "--locks", LOCKS],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); rmSync(TMP, { recursive: true, force: true }); process.exit(1); }

const profile = join(tmpdir(), "edge-locks-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
const pf = join(profile, "DevToolsActivePort");
let cport = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { cport = Number(readFileSync(pf, "utf8").split("\n")[0]); if (cport) break; } }
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

// ── ① 没锁时面板藏起来 ──
console.log("[1] 没有锁：面板整块藏起来（空面板只是噪音）");
{
  const r = JSON.parse(await ev(`JSON.stringify((function(){
    var box = document.querySelector('[data-wb-locks]');
    return { exists: !!box, hidden: box ? box.hidden : null };
  })())`));
  ok(r.exists === true, "面板节点在", "");
  ok(r.hidden === true, "**默认隐藏**（没有锁不占地方）", "hidden=" + r.hidden);
}

// ── ② 有锁时显示内容 ──
console.log("\n[2] 有锁：显示谁占的、哪些文件、对应哪几张卡、还有多久");
{
  // 先给一张卡补上 files（真实台账里现在还没人填，这正是 0-a 要解决的），
  // 好验证「文件锁 → 卡片编号」的翻译真的能对上。
  {
    const led = JSON.parse(readFileSync(join(BOARD, "ledger.json"), "utf8"));
    const it = (led.items || []).find((x) => x.id === "OPS-903") || (led.items || [])[0];
    if (it) {
      it.files = ["utils/data-store.js"];
      writeFileSync(join(BOARD, "ledger.json"), JSON.stringify(led, null, 2), "utf8");
    }
  }
  await send("Page.navigate", { url: B + "/#view-overview" });
  await wait(2200);

  // 用真接口造一把锁（顺便验接口本身）
  const disp = await fetch(B + "/api/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: "agent-test", task: "改 request", intent: { files: ["utils/data-store.js"], addsEdges: [] } }),
  }).then((r) => r.json());
  ok(disp.decision === "go", "调派接口放行", JSON.stringify({ d: disp.decision, n: (disp.closure || []).length }));
  ok(Array.isArray(disp.closure) && disp.closure.length > 0, "给出了波及面", disp.closure.join(","));

  // 点刷新，把锁拉进界面
  await ev(`document.querySelector('[data-wb-locks-refresh]').click(); 1`);
  await wait(700);

  const r = JSON.parse(await ev(`JSON.stringify((function(){
    var box = document.querySelector('[data-wb-locks]');
    var rows = box.querySelectorAll('.wb-lock-row');
    var row = rows[0];
    return {
      hidden: box.hidden,
      rows: rows.length,
      owner: row ? (row.querySelector('.wb-lock-owner') || {}).textContent : '',
      files: row ? Array.prototype.map.call(row.querySelectorAll('.wb-lock-file'), function(f){ return f.textContent; }) : [],
      cards: row ? (row.querySelector('.wb-lock-cards') || {}).textContent : '',
      ttl: row ? (row.querySelector('.wb-lock-ttl') || {}).textContent : '',
      hasReclaim: row ? !!row.querySelector('[data-wb-lock-reclaim]') : false,
      meta: (box.querySelector('[data-wb-locks-meta]') || {}).textContent
    };
  })())`));
  console.log("    " + JSON.stringify(r));
  ok(r.hidden === false, "**有锁时显示出来**", "");
  ok(r.rows === 1, "1 行", r.rows + " 行");
  ok(r.owner === "agent-test", "显示谁占的", r.owner);
  ok(r.files.some((f) => f.indexOf("data-store.js") > -1), "**显示占用的文件名**", r.files.join(","));
  ok(/卡：/.test(r.cards), "**把文件锁翻译成卡片编号**（用户认的是编号不是路径）", r.cards.slice(0, 60));
  ok(/秒|分钟/.test(r.ttl), "显示还有多久到期", r.ttl);
  ok(r.hasReclaim === true, "有回收按钮（agent 崩了要能人工清）", "");
  ok(/1 个文件被占着/.test(r.meta || ""), "顶部有数量摘要", r.meta);
}

// ── ③ 回收按钮真的能清锁 ──
console.log("\n[3] 回收按钮：真能清掉锁");
{
  const before = await fetch(B + "/api/locks").then((r) => r.json());
  ok(before.count === 1, "回收前 1 把锁", before.count + " 把");
  // confirm 在 headless 里会返回 false，先覆盖掉
  await ev(`window.confirm = function(){ return true; }; 1`);
  await ev(`document.querySelector('[data-wb-lock-reclaim]').click(); 1`);
  await wait(900);
  const after = await fetch(B + "/api/locks").then((r) => r.json());
  ok(after.count === 0, "**回收后锁没了**", after.count + " 把");
  const r = JSON.parse(await ev(`JSON.stringify({ hidden: document.querySelector('[data-wb-locks]').hidden })`));
  ok(r.hidden === true, "面板重新藏起来（没锁了）", "");
}

// ── ④ 文件级调派开关 ──
console.log("\n[4] 文件级调派开关：默认关（新机制先能试，不默认打断现有流程）");
{
  const r = JSON.parse(await ev(`JSON.stringify((function(){
    var cb = document.querySelector('[data-wb-file-dispatch]');
    var box = document.querySelector('[data-wb-filedispatch-box]');
    var hint = box ? (box.querySelector('.wb-filedispatch-hint') || {}).textContent : '';
    return { exists: !!cb, checked: cb ? cb.checked : null, hasHint: !!hint, hintLen: (hint || '').length };
  })())`));
  ok(r.exists === true, "开关在", "");
  ok(r.checked === false, "**默认未勾选**", "checked=" + r.checked);
  ok(r.hasHint === true && r.hintLen > 40, "有说明文字（用户要知道多花一个来回）", r.hintLen + " 字");
  // 勾上后能读到
  await ev(`document.querySelector('[data-wb-file-dispatch]').checked = true; 1`);
  const on = await ev(`document.querySelector('[data-wb-file-dispatch]').checked`);
  ok(on === true, "能勾上", "");
}

// ── ⑤ 冲突时被挡住并说明原因 ──
console.log("\n[5] 冲突：第二个任务被挡住，并说清撞在哪个文件");
{
  const a = await fetch(B + "/api/dispatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: "agent-A", task: "改 data-store", intent: { files: ["utils/data-store.js"], addsEdges: [] } }),
  }).then((r) => r.json());
  ok(a.decision === "go", "A 放行", "");
  const b = await fetch(B + "/api/dispatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: "agent-B", task: "也改", intent: { files: ["utils/data-store.js"], addsEdges: [] } }),
  }).then((r) => r.json());
  ok(b.decision === "queue", "**B 被挡住**", JSON.stringify(b.conflicts));
  ok(/排\s*队|与/.test(b.summary || ""), "摘要可读", b.summary);
  await ev(`document.querySelector('[data-wb-locks-refresh]').click(); 1`);
  await wait(700);
  const rows = await ev(`document.querySelectorAll('.wb-lock-row').length`);
  ok(rows >= 1, "界面能看到那把锁", rows + " 行");
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");
ok(!/Error|throw/.test(stderr), "服务 stderr 干净", stderr.slice(0, 140) || "(空)");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
