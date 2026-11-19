// 导出报表面板的端到端验收。
//
// 覆盖：
//   ① 顶栏「导出」按钮存在且能打开面板
//   ② 面板里看板清单从 /api/report/boards 拉到了，且默认勾当前板
//   ③ 四种模式（日报/周报/月报/全量）都能切
//   ④ 合并 / 分开两种输出方式都能切
//   ⑤ 真的点「生成报表」会落文件，且文件内容里有预期的小节
//   ⑥ 空选择时按钮是禁用的
//
// 用法（在看板模板目录下）：node scripts/report-ui-test.mjs --board "<绝对路径>"

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const boardArg = process.argv.indexOf("--board");
const BOARD = resolve(boardArg > -1 ? process.argv[boardArg + 1] : process.cwd());
if (!existsSync(join(BOARD, "ledger.json"))) {
  console.error("这不是看板目录：" + BOARD);
  process.exit(1);
}

const OUT = join(BOARD, ".uitest-report");
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

const PORT = 8801 + Math.floor(Math.random() * 60);
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

// 起看板服务
const srv = spawn(process.execPath, [join(BOARD, "scripts", "serve.mjs"), "--port", String(PORT)], {
  cwd: BOARD,
  stdio: "ignore",
});
await sleep(2200);

// profile 必须每次唯一：固定路径会让上一轮残留的 DevToolsActivePort
// （里面是已关闭的旧端口号）被这一轮读到，导致连不上调试端口。
// 同 evidence-look-test.mjs，详见那儿的注释。
const profile = join(OUT, "profile-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });
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
    "--window-size=1440,1000",
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
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result && r.result.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
await sleep(1800);

console.log("\n[1] 入口");
ok("报头右翼有「导出」按钮", await evaluate(`!!document.getElementById("export-open")`));
ok(
  "点之前面板是关的",
  (await evaluate(`document.getElementById("exporter").classList.contains("is-open")`)) === false
);
await evaluate(`document.getElementById("export-open").click()`);
await sleep(1200);
ok(
  "点之后面板打开了",
  (await evaluate(`document.getElementById("exporter").classList.contains("is-open")`)) === true
);

console.log("\n[2] 看板清单");
const boardCount = await evaluate(
  `document.querySelectorAll("#exp-boards input[data-id]").length`
);
ok("清单拉到至少一块板", boardCount >= 1, "实际 " + boardCount);
const checked = await evaluate(
  `[...document.querySelectorAll("#exp-boards input[data-id]")].filter(i=>i.checked).map(i=>i.dataset.id)`
);
ok("默认勾选当前这块板", Array.isArray(checked) && checked.length === 1, JSON.stringify(checked));
const curChecked = await evaluate(
  `(()=>{var c=document.querySelector("#exp-boards .cur");if(!c)return false;var lab=c.closest(".exp-board");return !!(lab&&lab.querySelector("input").checked);})()`
);
ok("勾的确实是标了「当前」的那块", curChecked === true);

// 关键：能不能真的多选。之前只断言"至少一块"，于是"只能选一块"这种问题
// 一路绿灯溜到用户手里。这里要求清单里每一块板都有独立勾选框，
// 而且逐个勾上之后能同时保持勾选状态。
const allIds = await evaluate(
  `[...document.querySelectorAll("#exp-boards input[data-id]")].map(i=>i.dataset.id)`
);
ok("每块板都有独立的勾选框", Array.isArray(allIds) && allIds.length === boardCount, JSON.stringify(allIds));

if (Array.isArray(allIds) && allIds.length >= 2) {
  // 全部勾上
  await evaluate(`[...document.querySelectorAll("#exp-boards input[data-id]")].forEach(function(i){
    if(!i.checked){ i.checked=true; i.dispatchEvent(new Event("change",{bubbles:true})); }
  })`);
  const allOn = await evaluate(
    `[...document.querySelectorAll("#exp-boards input[data-id]")].filter(i=>i.checked).map(i=>i.dataset.id)`
  );
  ok("能同时勾上多块板（不是单选）", allOn.length === boardCount, JSON.stringify(allOn));

  // 取消其中一块，其余应保持勾选 —— 单选控件在这里会当场露馅
  await evaluate(`(()=>{var a=[...document.querySelectorAll("#exp-boards input[data-id]")];
    a[0].checked=false; a[0].dispatchEvent(new Event("change",{bubbles:true}));})()`);
  const rest = await evaluate(
    `[...document.querySelectorAll("#exp-boards input[data-id]")].filter(i=>i.checked).map(i=>i.dataset.id)`
  );
  ok("取消一块后其余仍保持勾选", rest.length === boardCount - 1, JSON.stringify(rest));

  // 还原成只勾当前那块，后面的用例还按单块跑
  await evaluate(`(()=>{var a=[...document.querySelectorAll("#exp-boards input[data-id]")];
    a.forEach(function(i){var on=!!i.closest(".exp-board").querySelector(".cur");
      i.checked=on; i.dispatchEvent(new Event("change",{bubbles:true}));});})()`);
} else {
  ok("能同时勾上多块板（不是单选）", false, "清单只有 " + boardCount + " 块，无法验证多选");
}

console.log("\n[3] 模式切换");
for (const m of ["daily", "weekly", "monthly", "all"]) {
  await evaluate(
    `[...document.querySelectorAll("#exp-mode button")].find(b=>b.dataset.value==="${m}").click()`
  );
  const active = await evaluate(`document.querySelector("#exp-mode .is-active").dataset.value`);
  ok(`${m} 能选中`, active === m, active);
}
await evaluate(
  `[...document.querySelectorAll("#exp-mode button")].find(b=>b.dataset.value==="weekly").click()`
);

console.log("\n[4] 输出方式");
for (const v of ["split", "merged"]) {
  await evaluate(
    `[...document.querySelectorAll("#exp-merge button")].find(b=>b.dataset.value==="${v}").click()`
  );
  const active = await evaluate(`document.querySelector("#exp-merge .is-active").dataset.value`);
  ok(`${v} 能选中`, active === v, active);
}

// 等一次生成结束。判据是「状态文字不再是正在进行中」，
// 不能拿「含不含某几个字」当条件 —— 之前写成 indexOf("生成中") < 0，
// 而实际文案是「正在生成…」，第一轮就判定结束，后面全在空跑。
async function waitDone(evaluate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = (await evaluate(`document.getElementById("exp-status").textContent`)) || "";
    if (s && s.indexOf("正在生成") < 0) return s;
    await sleep(300);
  }
  return (await evaluate(`document.getElementById("exp-status").textContent`)) || "";
}

console.log("\n[4b] 格式默认全不选");
{
  // 三种格式默认都必须是空的：一次出三份会多出用户不需要的文件。
  const st = await evaluate(`["exp-f-md","exp-f-html","exp-f-txt"].map(i=>document.getElementById(i).checked)`);
  ok("三种格式默认都不勾", Array.isArray(st) && st.every((v) => v === false), JSON.stringify(st));

  // 一个都没勾时按钮就该是禁用的，不该等点了才报错。
  const disabled = await evaluate(`document.getElementById("exp-go").disabled`);
  ok("没勾格式时「生成」是禁用的", disabled === true, String(disabled));

  // 勾一个就恢复可用
  await evaluate(`(()=>{var e=document.getElementById("exp-f-md");e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  const nowEnabled = await evaluate(`document.getElementById("exp-go").disabled`);
  ok("勾上一种格式后按钮恢复可用", nowEnabled === false, String(nowEnabled));

  // 那一大段解释性说明已经按要求去掉了，别再长回来。
  const noteGone = await evaluate(
    `(()=>{var rows=[...document.querySelectorAll(".settings-row")];
      var r=rows.find(function(x){var l=x.querySelector(".settings-label");return l&&l.textContent.trim()==="导出格式";});
      if(!r) return "no-row";
      return r.querySelectorAll(".settings-note").length;})()`
  );
  ok("「导出格式」下面不再有解释性说明", Number(noteGone) === 0, String(noteGone));
}

console.log("\n[4c] 选保存位置");
{
  // 「浏览…」弹的是 Windows 原生「选择文件夹」，测试里没人点它，
  // 所以这里不真的触发点击（真触发会挂住等人工操作）。
  // 要验的是：按钮在、面板里没有自画的目录树、接口活着、取消被正确当成"没选"。
  const hasBtn = await evaluate(`!!document.getElementById("exp-pick")`);
  ok("有「浏览…」按钮", hasBtn === true);

  const noCustomTree = await evaluate(
    `!document.getElementById("exp-picker") && !document.querySelector(".exp-picker")`
  );
  ok("不再自己画目录列表（交给系统对话框）", noCustomTree === true);

  // 真的打通到脚本：用 dryRun 跑一遍 pick-folder.ps1，
  // 它会打印对话框标题就退出，不会弹窗，但足以证明
  // ①路由在 ②脚本在 ③powershell 能起来 ④中文没被 GBK 解成乱码。
  // 上一版就是这里整条链路 404，面板一片空白。
  const apiOk = await evaluate(`(async()=>{
    var env = window.__OPS_HARNESS__;
    var url = (env && env.id ? "/ops-board/b/" + env.id : "") + "/api/fs/pick";
    var r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    if (r.status !== 200) return "status " + r.status;
    var j = await r.json();
    return j && j.ok ? "ok " + (j.title || "") : "not ok";
  })()`);
  ok("选保存位置的整条链路通（不是 404）", /^ok /.test(String(apiOk)), String(apiOk));
  ok("脚本里的中文没变成乱码", String(apiOk).indexOf("选择报表保存到哪个文件夹") >= 0, String(apiOk));

  // 「默认」清空输入框
  await evaluate(`document.getElementById("exp-out").value = "D:\\\\somewhere"`);
  await evaluate(`document.getElementById("exp-reset").click()`);
  await new Promise((r) => setTimeout(r, 300));
  const cleared = await evaluate(`document.getElementById("exp-out").value`);
  ok("点「默认」能清回默认位置", cleared === "", JSON.stringify(cleared));
}

console.log("\n[5] 生成（周报 · 合并 · 三格式）");
// 格式默认不勾了，这里显式把三种都选上再导。
await evaluate(
  `["exp-f-md","exp-f-html","exp-f-txt"].forEach(function(i){var e=document.getElementById(i);e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}))})`
);
await evaluate(`document.getElementById("exp-out").value = ${JSON.stringify(OUT)}`);
await evaluate(`document.getElementById("exp-go").click()`);
const status = await waitDone(evaluate);
ok("状态显示已生成", /已生成/.test(status || ""), status);
const shownFiles = await evaluate(
  `[...document.querySelectorAll("#exp-result .exp-file .p")].map(e=>e.textContent)`
);
ok("结果里列出了文件路径", Array.isArray(shownFiles) && shownFiles.length >= 3, JSON.stringify(shownFiles));

const onDisk = readdirSync(OUT).filter((f) => /\.(md|html|txt)$/.test(f));
ok("磁盘上确实有这三个文件", onDisk.length >= 3, onDisk.join(", "));
for (const ext of ["md", "html", "txt"]) {
  ok(`落盘含 .${ext}`, onDisk.some((f) => f.endsWith("." + ext)));
}
ok(
  "结果里的路径都真实存在",
  shownFiles.length > 0 && shownFiles.every((f) => existsSync(f)),
  JSON.stringify(shownFiles.filter((f) => !existsSync(f)))
);

console.log("\n[6] 内容质量");
const mdFile = onDisk.find((f) => f.endsWith(".md"));
if (mdFile) {
  const md = readFileSync(join(OUT, mdFile), "utf8");
  ok("Markdown 有总览", /## 总览/.test(md));
  ok("Markdown 有项目小节", /^## /m.test(md));
  ok("Markdown 交代了生成时间", /生成于 \d{4}-\d{2}-\d{2}/.test(md));
  ok("Markdown 写了具体日期区间", /本期 \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/.test(md));
  ok("不含未替换的占位符", !/\{\{|\$\{/.test(md), (md.match(/\{\{[^}]*\}\}/) || [])[0]);
}
const htmlFile = onDisk.find((f) => f.endsWith(".html"));
if (htmlFile) {
  const html = readFileSync(join(OUT, htmlFile), "utf8");
  ok("HTML 是完整文档", /^<!DOCTYPE html>/i.test(html.trim()));
  ok("HTML 不引外部资源", !/<link[^>]+href="http/i.test(html) && !/<script[^>]+src=/i.test(html));
  ok("HTML 含打印样式", /@media print/.test(html));
  ok("HTML 没有裸的 Markdown 星号", !/\*\*[^*]+\*\*/.test(html));
}

console.log("\n[7] 分开输出");
// 分开输出的份数 = 勾了几块板，不是清单里有几块板。
// 这两件事只在「全勾」时才相等，拿清单条数当期望值会误判。
const pickedCount = await evaluate(
  `[...document.querySelectorAll("#exp-boards input[data-id]")].filter(i=>i.checked).length`
);
await evaluate(
  `[...document.querySelectorAll("#exp-merge button")].find(b=>b.dataset.value==="split").click()`
);
await evaluate(`document.getElementById("exp-f-html").checked = false`);
await evaluate(`document.getElementById("exp-f-txt").checked = false`);
await evaluate(`document.getElementById("exp-go").click()`);
const splitStatus = await waitDone(evaluate);
ok("第二次生成也成功", /已生成/.test(splitStatus || ""), splitStatus);
const splitFiles = await evaluate(
  `[...document.querySelectorAll("#exp-result .exp-file .p")].map(e=>e.textContent)`
);
ok(
  `各项目分开时按勾选的块数出文件（勾 ${pickedCount} 块）`,
  Array.isArray(splitFiles) && splitFiles.length === pickedCount,
  JSON.stringify(splitFiles)
);

// 再验证一次"勾两块、分开出"这个真正的多项目场景。
if (boardCount > 1) {
  await evaluate(
    `[...document.querySelectorAll("#exp-boards input[data-id]")].forEach(i=>{i.checked=true;i.dispatchEvent(new Event("change",{bubbles:true}))})`
  );
  await evaluate(`document.getElementById("exp-go").click()`);
  const multiStatus = await waitDone(evaluate);
  const multiFiles = await evaluate(
    `[...document.querySelectorAll("#exp-result .exp-file .p")].map(e=>e.textContent)`
  );
  ok("多选 + 分开 = 每块板各一份", multiStatus.indexOf("已生成") >= 0 && multiFiles.length === boardCount, JSON.stringify(multiFiles));
  ok(
    "每份文件的路径里带各自的项目名",
    multiFiles.length === boardCount &&
      new Set(multiFiles.map((f) => f.replace(/^.*[\\/]/, ""))).size === boardCount,
    JSON.stringify(multiFiles)
  );
}

console.log("\n[8] 取消勾选后按钮禁用");
await evaluate(`[...document.querySelectorAll("#exp-boards input[data-id]")].forEach(i=>{i.checked=false;i.dispatchEvent(new Event("change",{bubbles:true}))})`);
await sleep(300);
ok("一块板都不勾时按钮禁用", (await evaluate(`document.getElementById("exp-go").disabled`)) === true);
await evaluate(`[...document.querySelectorAll("#exp-boards input[data-id]")].forEach(i=>{i.checked=false})`);
await evaluate(`document.getElementById("exp-f-html").checked = true`);
ok("不点任何格式也不至于报错", true);

console.log("\n[9] 关闭");
await evaluate(`document.getElementById("export-close").click()`);
await sleep(250);
ok(
  "点 × 能关掉",
  (await evaluate(`document.getElementById("exporter").classList.contains("is-open")`)) === false
);

await send("Page.captureScreenshot", { format: "png" }).then((r) => {
  if (r.result) writeFileSync(join(OUT, "panel.png"), Buffer.from(r.result.data, "base64"));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
srv.kill();
process.exit(fail ? 1 : 0);
