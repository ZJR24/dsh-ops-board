// 证据点开看 —— 端到端验收。
//
// 覆盖三件事：
//   ① 服务端三个接口（stale / file / commit）真的能答，且越界和不存在的情况被挡
//   ② 页面上的证据真的带上了 data-look，数量与台账对得上
//   ③ 真在浏览器里点一下 → 浮层出来 → 内容是真的代码 / 真的 diff；再点提交能换过去；Esc 能关
//
// 用法（在看板模板目录下）：node scripts/evidence-look-test.mjs --board "<绝对路径>"

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathsIn } from "./lib/evidence-path.mjs";

const boardArg = process.argv.indexOf("--board");
const BOARD = resolve(boardArg > -1 ? process.argv[boardArg + 1] : process.cwd());
if (!existsSync(join(BOARD, "ledger.json"))) {
  console.error("这不是看板目录：" + BOARD);
  process.exit(1);
}

const OUT = join(BOARD, ".uitest-look");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  process.exit(1);
}

const PORT = 8861 + Math.floor(Math.random() * 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (extra ? "  ← " + extra : ""));
  }
}

const ledger = JSON.parse(readFileSync(join(BOARD, "ledger.json"), "utf8"));
const projectDir = (() => {
  try {
    return JSON.parse(readFileSync(join(BOARD, "project.json"), "utf8")).projectDir || "";
  } catch {
    return "";
  }
})();

const srv = spawn(process.execPath, [join(BOARD, "scripts", "serve.mjs"), "--port", String(PORT)], {
  cwd: BOARD,
  stdio: "ignore",
});
await sleep(2400);

const base = `http://127.0.0.1:${PORT}`;
async function api(p) {
  try {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  } catch (e) {
    return { status: 0, body: null, err: String(e) };
  }
}

// ─────────────────────── 一、接口层 ───────────────────────

console.log("\n[1] 新鲜度接口");
const st = await api("/api/evidence/stale");
ok("GET /api/evidence/stale 能答", st.status === 200 && st.body && st.body.ok === true, JSON.stringify(st.body).slice(0, 120));
ok(
  "project.json 指的目录是 git 仓库时才给结论",
  st.body && (st.body.available === true || typeof st.body.reason === "string"),
  JSON.stringify(st.body && st.body.reason)
);
if (st.body && st.body.available) {
  ok("每条过期卡片都带得出证据和天数", st.body.items.every((i) => Array.isArray(i.refs) && i.refs.length > 0 && i.maxDays >= 1));
  ok("按过期天数从大到小排", st.body.items.every((it, n, a) => n === 0 || a[n - 1].maxDays >= it.maxDays));
  ok(
    "只统计已完成状态的卡片",
    st.body.items.every((i) => ["fixed", "shipped", "closed"].includes(i.status))
  );
}

console.log("\n[2] 文件接口");
// 从台账里挑一条真的 file 证据来查
// 路径怎么认，跟页面渲染用的是同一套判据（scripts/lib/evidence-path.mjs），
// 否则测试会拿一份过时的正则去数，跟页面实际生成的按钮对不上。
let sampleFile = null;
let sampleHint = null;
for (const it of ledger.items) {
  for (const e of it.evidence || []) {
    if (e && e.kind === "file") {
      const p = pathsIn(String(e.text || ""))[0];
      if (p) {
        sampleFile = p.path;
        sampleHint = e.text;
        break;
      }
    }
  }
  if (sampleFile) break;
}

if (sampleFile && projectDir) {
  const fr = await api(
    "/api/evidence/file?path=" + encodeURIComponent(sampleFile) + "&hint=" + encodeURIComponent(sampleHint)
  );
  ok("GET /api/evidence/file 能答", fr.status === 200 && fr.body && fr.body.ok === true, JSON.stringify(fr.body).slice(0, 140));
  ok("回来的正文带行号", typeof fr.body.text === "string" && /^\s*\d+│ /m.test(fr.body.text));
  ok("回来的路径和请求的一致", fr.body.path === sampleFile, fr.body.path);
  ok("给了总行数", Number.isFinite(fr.body.total) && fr.body.total > 0, String(fr.body.total));

  const esc = await api("/api/evidence/file?path=" + encodeURIComponent("../../Windows/win.ini"));
  ok("往上跳目录的路径被挡住", esc.status === 404 && esc.body && esc.body.ok === false, JSON.stringify(esc.body).slice(0, 120));

  const miss = await api("/api/evidence/file?path=" + encodeURIComponent("no/such/file_zzz.js"));
  ok("不存在的文件给出明确原因", miss.status === 404 && /不在了|找不到/.test(miss.body.error || ""), miss.body && miss.body.error);

  const empty = await api("/api/evidence/file");
  ok("不给 path 不崩", empty.status === 404 && empty.body && empty.body.ok === false);
}

console.log("\n[3] 提交接口");
let sampleHash = null;
for (const it of ledger.items) {
  for (const e of it.evidence || []) {
    if (e && e.kind === "commit") {
      const m = String(e.text || "").match(/\b[0-9a-f]{7,40}\b/i);
      if (m) {
        sampleHash = m[0];
        break;
      }
    }
  }
  if (sampleHash) break;
}
if (sampleHash && projectDir) {
  const cr = await api("/api/evidence/commit?hash=" + encodeURIComponent(sampleHash));
  ok("GET /api/evidence/commit 能答", cr.status === 200 && cr.body && cr.body.ok === true, JSON.stringify(cr.body).slice(0, 140));
  ok("带出提交标题", typeof cr.body.subject === "string" && cr.body.subject.length > 0);
  ok("带出改动文件清单", Array.isArray(cr.body.files) && cr.body.files.length > 0);
  ok("带出 diff 正文", typeof cr.body.diff === "string" && cr.body.diff.indexOf("diff --git") >= 0);
  ok("时间取自提交本身", /^\d{4}-\d\d-\d\dT/.test(cr.body.at || ""), cr.body.at);

  const bad = await api("/api/evidence/commit?hash=deadbeef");
  ok("不存在的 commit 给出明确原因", bad.status === 404 && /找不到/.test(bad.body.error || ""), bad.body && bad.body.error);
  const junk = await api("/api/evidence/commit?hash=" + encodeURIComponent("not-a-hash"));
  ok("乱填的 hash 直接拒绝", junk.status === 404 && junk.body && junk.body.ok === false);
}

// ─────────────────────── 二、页面元素 ───────────────────────

// profile 必须每次唯一。原来固定用 OUT/profile，于是上一轮跑完留下的
// DevToolsActivePort 还在（里面是上一轮那个已经关掉的端口号），这一轮 spawn 之后
// 立刻就读到了这个**陈旧**文件，拿着死端口去连 /json，一路超时，最后
// `target` 是 undefined，在 `new WebSocket(target.webSocketDebuggerUrl)` 处崩掉。
// 症状看起来像「浏览器起不来」，实际是「读到了上一轮的端口」。
// 单独跑往往没事（上一轮的 OUT 已被清），只有在门禁里连着跑时才现形 —— 典型的假阴性。
//
// 已实测（预置一个死端口的 DevToolsActivePort 再启动 Edge，循环第一次就读到它）：
// 3/3 次都锁定到死端口 2049。而 Edge 启动时自己也会清/重写这个文件，
// 所以真实脚本里是否踩中是**竞态** —— 取决于 Edge 重写得快还是循环读得快。
//
// 两处都堵：profile 唯一（不继承上一轮的目录）+ 启动前删掉这个文件（不继承上一轮的端口）。
const profile = join(OUT, "profile-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });
// 目录是新的，理论上不会有这个文件；但若 OUT 被复用或人工塞过东西，
// 这一句就是确定性兜底 —— 让下面的循环不可能读到陈旧的端口号。
try {
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
} catch {}
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--window-size=1500,1100",
    "about:blank",
  ],
  { stdio: "ignore" }
);

let port = 0;
for (let i = 0; i < 60; i++) {
  const m = join(profile, "DevToolsActivePort");
  if (existsSync(m)) {
    const t = readFileSync(m, "utf8").split(/\r?\n/);
    if (Number(t[0]) > 0) {
      port = Number(t[0]);
      break;
    }
  }
  await sleep(200);
}

let target;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(200);
}

if (!target) {
  edge.kill();
  console.error("连不上调试端口（端口 " + port + "，profile " + profile + "）");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r));

const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: base + "/" });
await sleep(2200);

console.log("\n[4] 页面上证据变成可点的");
const nFile = await evaluate(`document.querySelectorAll('[data-look="file"]').length`);
const nCommit = await evaluate(`document.querySelectorAll('[data-look="commit"]').length`);
ok("有可点的文件证据", nFile > 0, String(nFile));
// 有些看板（比如 Java 那个）台账里根本没写 commit，只有文件。
// 这时不该判失败，只跳过与提交相关的几组用例。
const hasCommitEvidence = ledger.items.some((it) =>
  (it.evidence || []).some((e) => e && e.kind === "commit" && /\b[0-9a-f]{7,40}\b/i.test(String(e.text || "")))
);
ok(
  hasCommitEvidence ? "有可点的提交证据" : "台账里没有提交类证据（跳过提交相关用例）",
  hasCommitEvidence ? nCommit > 0 : true,
  String(nCommit)
);

// 台账里 file/commit 类证据的总数，页面上的可点数不能多于它
let ledgerFile = 0;
let ledgerCommit = 0;
for (const it of ledger.items) {
  for (const e of it.evidence || []) {
    if (!e) continue;
    if (e.kind === "file" && pathsIn(String(e.text || "")).length > 0) ledgerFile++;
    if (e.kind === "commit" && /\b[0-9a-f]{7,40}\b/i.test(String(e.text || ""))) ledgerCommit++;
  }
}
ok("可点的文件数不超过台账里的文件证据数", nFile <= ledgerFile, `${nFile} > ${ledgerFile}`);
ok("可点的提交数不超过台账里的提交证据数", nCommit <= ledgerCommit, `${nCommit} > ${ledgerCommit}`);

ok("默认不显示浮层", (await evaluate(`(function(){var e=document.querySelector(".look"); return e? e.classList.contains("on") : false})()`)) === false);

console.log("\n[5] 点文件证据");
const clickedFile = await evaluate(`(function(){
  var b=document.querySelector('[data-look="file"]');
  if(!b) return "none";
  b.click();
  return b.getAttribute("data-path");
})()`);
ok("找到了一个文件按钮并点了", clickedFile !== "none", String(clickedFile));
await sleep(2600);

const fileState = await evaluate(`(function(){
  var el=document.querySelector(".look");
  return {
    on: el ? el.classList.contains("on") : false,
    title: (el.querySelector(".look-title")||{}).textContent || "",
    sub: (el.querySelector(".look-sub")||{}).textContent || "",
    body: (el.querySelector(".look-body")||{}).textContent || ""
  };
})()`);
ok("浮层显示出来了", fileState.on === true);
ok("标题就是那个文件", fileState.title === clickedFile, fileState.title);
ok("正文是真代码（带行号）", /^\s*\d+│ /m.test(fileState.body), fileState.body.slice(0, 80));
ok("副题说清了行号或总行数", /行/.test(fileState.sub), fileState.sub);

console.log("\n[6] 点提交证据");
if (nCommit > 0) {
  const clickedCommit = await evaluate(`(function(){
  var b=document.querySelector('[data-look="commit"]');
  if(!b) return "none";
  b.click();
  return b.getAttribute("data-hash");
})()`);
  ok("找到了一个提交按钮并点了", clickedCommit !== "none", String(clickedCommit));
  await sleep(3000);

  const commitState = await evaluate(`(function(){
  var el=document.querySelector(".look");
  return {
    on: el ? el.classList.contains("on") : false,
    title: (el.querySelector(".look-title")||{}).textContent || "",
    sub: (el.querySelector(".look-sub")||{}).textContent || "",
    body: (el.querySelector(".look-body")||{}).textContent || ""
  };
})()`);
  ok("浮层切到了提交", commitState.on === true);
  ok("标题里带 hash 和提交说明", commitState.title.indexOf(clickedCommit) === 0 && commitState.title.length > 8, commitState.title.slice(0, 60));
  ok("副题带日期和增删行数", /\d{4}-\d\d-\d\d/.test(commitState.sub) && /[+−]/.test(commitState.sub), commitState.sub);
  ok("正文里有 diff 原文", commitState.body.indexOf("diff --git") >= 0);
  ok("正文里有文件清单", /[+−]\d+/.test(commitState.body), commitState.body.slice(0, 80));

  await send("Page.captureScreenshot", { format: "png" }).then((r) => {
    if (r.result && r.result.data) writeFileSync(join(OUT, "look-commit.png"), Buffer.from(r.result.data, "base64"));
  });
} else {
  console.log("  · 这块看板没有提交类证据，跳过");
}

console.log("\n[7] 关掉");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`);
await sleep(280);
ok("按 Esc 能关", (await evaluate(`document.querySelector(".look").classList.contains("on")`)) === false);

await evaluate(`document.querySelector('[data-look="file"]').click()`);
await sleep(1500);
ok("再点又能打开", (await evaluate(`document.querySelector(".look").classList.contains("on")`)) === true);
await evaluate(`document.querySelector(".look-x").click()`);
await sleep(280);
ok("点 × 能关", (await evaluate(`document.querySelector(".look").classList.contains("on")`)) === false);

console.log("\n[8] 三种主题下浮层都不透明");
for (const theme of ["paper", "eye", "night"]) {
  await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
  await evaluate(`document.querySelector('[data-look="file"]').click()`);
  await sleep(1400);
  const bg = await evaluate(`(function(){
    var el=document.querySelector(".look");
    return getComputedStyle(el).backgroundColor;
  })()`);
  // 半透明（rgba 且 alpha < 1）会让后面的卡片透上来，字读不成
  const m = String(bg).match(/rgba?\(([^)]+)\)/);
  const parts = m ? m[1].split(",").map((s) => s.trim()) : [];
  const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
  ok(`主题 ${theme} 下浮层底色不透明`, alpha >= 0.98, bg);
}
await evaluate(`document.documentElement.setAttribute("data-theme","night")`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
srv.kill();
process.exit(fail ? 1 : 0);
