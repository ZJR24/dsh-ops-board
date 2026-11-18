// 验证旧 hash #view-flow 的兜底：不白屏 + localStorage 落点被清掉 + 刷新后不再卡死
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const HTML = "file:///D:/WorkSpace-Tools/ops-board-reports/cyber-egg-basket/dist/index.html";
const profile = join(tmpdir(), "edge-stale-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let port = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { port = Number(readFileSync(pf, "utf8").split("\n")[0]); if (port) break; } }
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await send("Page.enable"); await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

console.log("[1] 模拟老用户：localStorage 里记着已删除的 view-flow");
await send("Page.navigate", { url: HTML });
await wait(2000);
// 先写一个指向已删页面的落点（key 前缀按 client.js 的 routeKey 规则：ops-board-route:<path>）
await ev(`(function(){
  var keys = Object.keys(localStorage);
  var k = keys.filter(function(x){ return x.indexOf('ops-board-route:')===0; })[0] || 'ops-board-route:/D:/WorkSpace-Tools/ops-board-reports/cyber-egg-basket/dist/index.html';
  localStorage.setItem(k, 'view-flow');
  return k + ' => ' + localStorage.getItem(k);
})()`).then((v) => console.log("    写入落点：" + v));

console.log("\n[2] 无 hash 重开（会走 restoreRoute 恢复那个已删页面）");
await send("Page.navigate", { url: HTML });
await wait(2500);
const r1 = await ev(`(function(){
  var a = document.querySelector('.view.is-active');
  return { active: a ? a.getAttribute('data-view') : null, hash: location.hash };
})()`);
ok(r1.active !== null, "没有白屏（有激活视图）", "激活 = " + r1.active);

console.log("\n[3] 再刷新一次：坏落点不该被反复读到");
await send("Page.navigate", { url: HTML });
await wait(2500);
const r2 = await ev(`(function(){
  var a = document.querySelector('.view.is-active');
  var keys = Object.keys(localStorage).filter(function(x){ return x.indexOf('ops-board-route:')===0; });
  return { active: a ? a.getAttribute('data-view') : null, stored: keys.map(function(k){ return localStorage.getItem(k); }) };
})()`);
ok(r2.active !== null, "仍然没有白屏", "激活 = " + r2.active);
ok(JSON.stringify(r2.stored).indexOf("view-flow") === -1, "localStorage 里的坏落点已被清掉", JSON.stringify(r2.stored));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);