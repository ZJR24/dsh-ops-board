// 验收「没经过 Harness 直接打开页面时，面板说的是人话」。
// 用法：node scripts/offline-test.mjs
// 它会自己开 Edge，用 file:// 打开页面 —— 不需要服务起着，也不需要它关着。
//
// 为什么单独一个脚本：uitest 走的是 http://，注入过 window.__OPS_HARNESS__；
// 裸页那条路径（没有注入）只有在这里才验得到。

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, ".uitest");
const PORT = 9224;

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));

if (!EDGE) {
  console.error("找不到 msedge.exe，没法做交互验收。");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const profile = join(OUT, "profile-offline");
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1100,760", "about:blank",
  ],
  { stdio: "ignore", detached: false }
);

let page;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((t) => t.type === "page");
    if (page) break;
  } catch {}
  await sleep(250);
}
if (!page) {
  edge.kill();
  console.error("连不上 Edge 的调试端口");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});

let seq = 0;
const wait = new Map();
const crashes = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    crashes.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
  }
  if (m.id && wait.has(m.id)) {
    wait.get(m.id)(m.result);
    wait.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    wait.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");

const problems = [];
function check(label, ok, detail) {
  if (!ok) problems.push(label);
  console.log(`  ${ok ? "✓" : "×"} ${label}${detail ? "  " + detail : ""}`);
}

console.log("\n〔裸页〕直接双击 dist/index.html，点「问 AI」再点「发送」");

const fileUrl = pathToFileURL(join(ROOT, "dist", "index.html")).href;
await send("Page.navigate", { url: fileUrl });
await sleep(1400);

// 像用户一样：先进车道页，点某条的「问 AI」开面板，写一句，点「发送」
await ev(`location.hash = "#view-lane-bug"`);
await sleep(600);
const clicked = await ev(`(function(){
  var b = document.querySelector(".view.is-active [data-ask]");
  if (b) b.click();
  return !!b;
})()`);
await sleep(900);

const state = await ev(`(function(){
  var t = function (id) { return (document.getElementById(id) || {}).textContent || ""; };
  var input = document.getElementById("ai-input");
  input.value = "现在什么情况";
  document.getElementById("ai-send").click();
  return new Promise(function (done) {
    setTimeout(function () {
      done({
        open: document.getElementById("ai-panel").classList.contains("is-open"),
        hint: t("ai-hint"),
        hasConfigBtn: !!document.getElementById("ai-config-btn"),
        hasProvider: !!document.getElementById("cfg-provider"),
        machineTalk: /NetworkError|Failed to fetch|Uncaught/i.test(document.body.innerText)
      });
    }, 700);
  });
})()`);

await check("面板能打开", state.open === true, clicked ? "" : "（这页没找到「问 AI」按钮）");
await check("不出现 NetworkError 这类机器话", state.machineTalk === false, state.machineTalk ? "正文里有" : "");
await check(
  "说清了要在 Harness 里打开",
  /要在 Harness 里打开/.test(state.hint),
  state.hint.slice(0, 46) + "…",
);
await check("没有「设置」按钮（模板不管密钥）", state.hasConfigBtn === false);
await check("没有接入点下拉框", state.hasProvider === false);
await check("全程页面脚本没抛错", crashes.length === 0, crashes[0] ? String(crashes[0]).split("\n")[0] : "");

const shot = await send("Page.captureScreenshot", { format: "png" });
const file = join(OUT, "09-bare-page.png");
writeFileSync(file, Buffer.from(shot.data, "base64"));
console.log("\n截图：\n  " + file.replace(/\\/g, "/"));

ws.close();
edge.kill();

if (problems.length) {
  console.log(`\n裸页提示验收未通过，${problems.length} 个问题：`);
  for (const p of problems) console.log("  × " + p);
  process.exit(1);
}
console.log("\n裸页提示验收通过。");
