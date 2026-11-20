// 搁置队列（2026-11-20 用户定）。
//
// 用户原话：「有的任务，我是不想他出现在备选的，所以，我觉得有必要在卡片上增加一个按钮
//（搁置），可以让这个卡片不在备选显示，增加一行搁置队列。搁置队列中的卡片显示备选按钮，
// 点击备选后，回到备选队列。」
//
// 要验的是完整闭环：
//   ① 备选卡上有「搁置」按钮，点了它从备选消失、出现在「搁置」那一行；
//   ② 搁置的卡**不进执行队列**（「全部加入」也不能把它带进去）；
//   ③ 搁置里点「备选」→ 回到**备选**（不是直接进队列）；
//   ④ 刷新后搁置状态还在（存 localStorage，按板分开）；
//   ⑤ 搁置不动台账（它是用户意愿，不是卡的状态）。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const PORT = 8837;
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const B = `http://127.0.0.1:${PORT}`;
const CLAIMS = join(tmpdir(), "shelf-claims-" + Date.now());
mkdirSync(CLAIMS, { recursive: true });

const srv = spawn("node", ["scripts/serve.mjs", "--board", argBoard, "--port", String(PORT), "--claims", join(CLAIMS, "c.json")],
  { cwd: "D:\\WorkSpace-Tools\\ops-board", stdio: ["ignore", "pipe", "pipe"] });
let stderr = ""; srv.stderr.on("data", (d) => (stderr += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { await wait(250); try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {} }
if (!up) { console.error("服务没起来\n" + stderr); srv.kill(); process.exit(1); }

const PLAN = await fetch(B + "/api/flow/plan").then((r) => r.json());
if (!PLAN.ok || (PLAN.total || 0) < 2) {
  console.error("这块板可排卡不足（total=" + (PLAN && PLAN.total) + "），换一块或加卡再跑");
  srv.kill(); process.exit(1);
}

const profile = join(tmpdir(), "edge-shelf-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1440,1600", "about:blank"], { stdio: "ignore" });
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

// 先清干净：别把上一条测试留下的搁置带进来。
// 按前缀扫（键名带板标识，不能写死），扫完重载让页面重新读。
await ev(`(function(){
  Object.keys(localStorage).filter(function(k){ return k.indexOf('ops-board-wb-shelved') === 0; }).forEach(function(k){ localStorage.removeItem(k); });
  return 1;
})()`);
await send("Page.navigate", { url: B + "/#view-overview" });
await wait(2600);
const startShelved = await ev(`(window.__wb.shelved || []).length`);
ok(startShelved === 0, "起点干净：搁置清单是空的", String(startShelved));

const ledgerBefore = readFileSync(join(argBoard, "ledger.json"), "utf8");

console.log("[1] 备选卡上有「搁置」按钮");
const scan = JSON.parse(await ev(`JSON.stringify((function(){
  var groups = document.querySelectorAll('[data-wb-pool] .wb-group');
  var standby = null;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].querySelector('.wb-pick.wb-standby')) { standby = groups[i]; break; }
  }
  var cards = standby ? Array.prototype.slice.call(standby.querySelectorAll('.wb-pick.wb-standby')) : [];
  return {
    standbyCards: cards.length,
    shelfBtns: document.querySelectorAll('[data-wb-shelf]').length,
    shelfGroups: document.querySelectorAll('.wb-group-shelf').length,
    firstId: cards.length ? cards[0].getAttribute('data-wb-id') : '',
    firstHasBtn: cards.length ? !!cards[0].querySelector('[data-wb-shelf]') : false,
    btnText: cards.length && cards[0].querySelector('[data-wb-shelf]') ? cards[0].querySelector('[data-wb-shelf]').textContent.trim() : ''
  };
})())`));
ok(scan.standbyCards > 0, "备选区有卡", scan.standbyCards + " 张");
ok(scan.shelfBtns === scan.standbyCards, "每张备选卡都有「搁置」按钮", scan.shelfBtns + "/" + scan.standbyCards);
ok(scan.btnText === "搁置", "按钮文案是「搁置」", scan.btnText);
ok(scan.shelfGroups === 0, "还没搁置时，没有空的「搁置」行（不占地方）");

console.log("\n[2] 点「搁置」→ 从备选消失，进「搁置」那一行");
const shelfId = scan.firstId;
const afterShelf = JSON.parse(await ev(`JSON.stringify((function(){
  var btn = document.querySelector('[data-wb-shelf="${shelfId}"]');
  if (!btn) return { err: 'no-button' };
  btn.click();
  var id = ${JSON.stringify(shelfId)};
  var shelfGroup = document.querySelector('.wb-group-shelf');
  var inShelf = !!shelfGroup && Array.prototype.slice.call(shelfGroup.querySelectorAll('.wb-pick')).some(function(c){ return c.getAttribute('data-wb-id') === id; });
  var inStandby = Array.prototype.slice.call(document.querySelectorAll('.wb-pick.wb-standby')).some(function(c){ return c.getAttribute('data-wb-id') === id; });
  var inQueue = Array.prototype.slice.call(document.querySelectorAll('[data-wb-pool] .wb-group:first-child .wb-pick')).some(function(c){ return c.getAttribute('data-wb-id') === id; });
  var unshelf = shelfGroup ? !!shelfGroup.querySelector('[data-wb-unshelf="' + id + '"]') : false;
  var unshelfText = shelfGroup && shelfGroup.querySelector('[data-wb-unshelf="' + id + '"]') ? shelfGroup.querySelector('[data-wb-unshelf="' + id + '"]').textContent.trim() : '';
  return { inShelf: inShelf, inStandby: inStandby, inQueue: inQueue, unshelf: unshelf, unshelfText: unshelfText,
           shelfCount: window.__wb.shelved.length };
})())`));
ok(!afterShelf.err, "搁置按钮可点");
ok(afterShelf.inStandby === false, "搁置后不在备选区了");
ok(afterShelf.inShelf === true, "出现在「搁置」那一行");
ok(afterShelf.inQueue === false, "搁置的卡不进执行队列");
ok(afterShelf.unshelf === true && afterShelf.unshelfText === "备选", "搁置卡上有「备选」按钮", afterShelf.unshelfText);
ok(afterShelf.shelfCount === 1, "搁置清单里正好 1 张", String(afterShelf.shelfCount));

console.log("\n[3] 「全部加入」不能把搁置的卡带进队列");
const addAllRes = JSON.parse(await ev(`JSON.stringify((function(){
  var id = ${JSON.stringify(shelfId)};
  var btn = document.querySelector('[data-wb-addall]');
  if (!btn) return { err: 'no-addall' };
  btn.click();
  return {
    inQueue: window.__wb.dragPool.indexOf(id) > -1,
    stillShelved: window.__wb.shelved.indexOf(id) > -1,
    queueN: window.__wb.dragPool.length
  };
})())`));
ok(!addAllRes.err, "「全部加入」按钮还在");
ok(addAllRes.inQueue === false, "「全部加入」跳过了搁置的卡", "队列 " + addAllRes.queueN + " 张");
ok(addAllRes.stillShelved === true, "搁置标记没被「全部加入」冲掉");

console.log("\n[4] 搁置里的「备选」→ 回到备选（不是直接进队列）");
const unshelfRes = JSON.parse(await ev(`JSON.stringify((function(){
  var id = ${JSON.stringify(shelfId)};
  var btn = document.querySelector('[data-wb-unshelf="' + id + '"]');
  if (!btn) return { err: 'no-unshelf' };
  btn.click();
  var inQueue = window.__wb.dragPool.indexOf(id) > -1;
  var inStandby = Array.prototype.slice.call(document.querySelectorAll('.wb-pick.wb-standby')).some(function(c){ return c.getAttribute('data-wb-id') === id; });
  return { inQueue: inQueue, inStandby: inStandby, shelvedN: window.__wb.shelved.length,
           shelfGroup: document.querySelectorAll('.wb-group-shelf').length };
})())`));
ok(!unshelfRes.err, "「备选」按钮可点");
ok(unshelfRes.inStandby === true, "回到了备选区");
ok(unshelfRes.inQueue === false, "没有直接进执行队列（用户说的是「回到备选队列」）");
ok(unshelfRes.shelvedN === 0, "搁置清单已清空", String(unshelfRes.shelvedN));
ok(unshelfRes.shelfGroup === 0, "空的「搁置」行收起来了");

console.log("\n[5] 刷新后搁置状态还在（存本机，不是一次性的）");
const persistId = await ev(`(function(){
  var btn = document.querySelector('[data-wb-shelf]');
  if (!btn) return '';
  var id = btn.getAttribute('data-wb-shelf');
  btn.click();
  return id;
})()`);
if (!persistId) {
  ok(false, "找不到可搁置的卡，无法验证持久化");
} else {
  await wait(300);
  await send("Page.navigate", { url: B + "/#view-overview" });
  await wait(2600);
  const afterReload = JSON.parse(await ev(`JSON.stringify((function(){
    var id = ${JSON.stringify(persistId)};
    var shelfGroup = document.querySelector('.wb-group-shelf');
    return {
      inShelf: !!shelfGroup && Array.prototype.slice.call(shelfGroup.querySelectorAll('.wb-pick')).some(function(c){ return c.getAttribute('data-wb-id') === id; }),
      inStandby: Array.prototype.slice.call(document.querySelectorAll('.wb-pick.wb-standby')).some(function(c){ return c.getAttribute('data-wb-id') === id; }),
      store: window.__wb.shelved.length
    };
  })())`));
  ok(afterReload.inShelf === true, "刷新后仍在「搁置」行", persistId);
  ok(afterReload.inStandby === false, "刷新后也没回到备选");
  ok(afterReload.store >= 1, "storage 里记着搁置清单", afterReload.store + " 张");
}

console.log("\n[6] 搁置不动台账（它是用户意愿，不是卡的状态）");
const ledgerAfter = readFileSync(join(argBoard, "ledger.json"), "utf8");
ok(ledgerAfter === ledgerBefore, "整轮下来 ledger.json 一个字节没变");

// 收尾：把搁置清干净，别把状态留给别的测试。
// 不靠「删 localStorage 键」收尾 —— 键名是按板标识拼的，写死一个字符串很容易对不上
// （第一版就是这么翻车的）。直接走界面：把搁置里每张卡的「备选」都点一遍。
await ev(`(function(){
  var n = 0;
  Array.prototype.slice.call(document.querySelectorAll('[data-wb-unshelf]')).forEach(function(b){ b.click(); n++; });
  return n;
})()`);
await wait(500);
const cleaned = await ev(`(window.__wb.shelved || []).length`);
ok(cleaned === 0, "收尾后搁置清单清空", String(cleaned));

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");
ok(!/Error|throw/.test(stderr), "服务 stderr 干净", stderr.slice(0, 140) || "(空)");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill(); srv.kill();
