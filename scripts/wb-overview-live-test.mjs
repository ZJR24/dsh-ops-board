// 带后端跑：总览页工作台能否真的铺出候选池、并行分析、以及工作流页搬移后是否仍正常
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8799;
const BOARD = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
const B = `http://127.0.0.1:${PORT}`;
const CLAIMS_DIR = mkdtempSync(join(tmpdir(), "probe-claims-"));
const srv = spawn("node", ["scripts/serve.mjs", "--board", BOARD, "--port", String(PORT), "--claims", join(CLAIMS_DIR, "flow-claims.json")],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let serr = ""; srv.stderr.on("data", (d) => (serr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("serve 没起来\n" + serr); process.exit(1); }

const profile = join(tmpdir(), "edge-live-" + Date.now());
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await send("Page.enable"); await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

await send("Page.navigate", { url: B + "/#view-overview" });
await wait(3500);

console.log("[1] 总览页工作台（真实后端）");
ok(await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick').length > 0`), "候选池铺出了卡", await ev(`document.querySelectorAll('[data-wb-pool] .wb-pick').length + " 张"`));
ok(await ev(`(function(){var w=document.querySelector('[data-workbench]');return !!w && !!w.closest('[data-view="overview"]');})()`), "工作台在总览页（挂载成功）");
const geom = JSON.parse(await ev(`JSON.stringify((function(){var w=document.querySelector('[data-workbench]');var r=w.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};})())`));
ok(geom.w > 600, "工作台占满主列宽度", geom.w + "×" + geom.h);

console.log("\n[2] 在总览页直接分析（并行）");
await ev(`document.querySelector('[data-wb-addall]') && document.querySelector('[data-wb-addall]').click(); 1`);
await wait(400);
await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true; document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true})); 1`);
await ev(`document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
await wait(2000);
const st = JSON.parse(await ev(`JSON.stringify({orderN:(window.__wb.order||[]).length, lanes:document.querySelectorAll('[data-wb-steps] .wb-lane').length, steps:document.querySelectorAll('[data-wb-steps] .wb-step').length, view:document.querySelector('[data-workbench]').closest('[data-view]').getAttribute('data-view')})`));
ok(st.orderN > 0, "总览页上分析成功", "order " + st.orderN + " · " + st.steps + " 步");
ok(st.lanes >= 1, "并行多路队列在总览页正常渲染", st.lanes + " 路");
ok(st.view === "overview", "分析过程工作台没被搬走");

console.log("\n[3] 带着分析结果切到别的页再切回来（工作流页已删，改测 Skill 页往返）");
await ev(`location.hash="#view-skills"`); await wait(800);
const st2 = JSON.parse(await ev(`JSON.stringify({parked:!!document.querySelector('#wb-park [data-workbench]'), lanes:document.querySelectorAll('[data-wb-steps] .wb-lane').length, orderN:(window.__wb.order||[]).length})`));
ok(st2.parked === true, "离开总览时工作台收进隐藏暂存区");
await ev(`location.hash="#view-overview"`); await wait(800);
const st3 = JSON.parse(await ev(`JSON.stringify({view:document.querySelector('[data-workbench]').closest('[data-view]').getAttribute('data-view'), lanes:document.querySelectorAll('[data-wb-steps] .wb-lane').length, orderN:(window.__wb.order||[]).length})`));
ok(st3.view === "overview", "工作台回到总览页");
ok(st3.orderN === st.orderN && st3.lanes === st.lanes, "分析结果往返后没丢", st3.orderN + " / " + st3.lanes + " 路");

console.log("\n[4] 旧 hash #view-flow（该页已删）落回总览，工作台正常");
await ev(`location.hash="#view-flow"`); await wait(800);
const st4 = JSON.parse(await ev(`JSON.stringify({active:(document.querySelector('.view.is-active')||{getAttribute:function(){return null}}).getAttribute('data-view'), wbCount:document.querySelectorAll('[data-workbench]').length, lanes:document.querySelectorAll('[data-wb-steps] .wb-lane').length})`));
ok(st4.active === "overview", "落回总览页");
ok(st4.wbCount === 1 && st4.lanes === st.lanes, "工作台与分析结果都还在", st4.lanes + " 路");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
srv.kill(); proc.kill(); process.exit(fail ? 1 : 0);
