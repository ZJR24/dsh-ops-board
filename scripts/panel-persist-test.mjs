// 验证「从看板跳去 Harness 会话窗、再回来，对话面板还在」。
//
// 关键：跳转会让 iframe 整体重建 = 页面重载。所以真正要测的不是「内存里 class 还挂着」，
// 而是「重载之后靠 localStorage 把面板重新摆回来，并且回到同一个作用域」。
// 因此这里必须真的 Page.reload()，而不是在同一个 document 里改 class。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
// 必须绝对路径：--user-data-dir 传相对路径时，Edge 会按自己的 CWD 解析，
// 于是 DevToolsActivePort 不落在我们找的地方（表现为「连不上调试端口」），
// 而且两次运行可能落到同一个 profile 上，把上一轮的 localStorage 带进下一轮。
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const PORT = 9230;

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  process.exit(1);
}
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) {
  console.error("没有 dist/index.html");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
// 每次跑用独立的 profile 目录。
//
// 为什么不用固定名字 + 先删：Edge 退出是异步的，上一轮的进程可能还攥着目录里的文件，
// rmSync 删不干净（try/catch 一吞就看不出问题），下一轮于是读到上一轮写的 localStorage，
// 表现成「初始没有面板状态记录」这种莫名其妙的失败。唯一名字从根上避开这场竞争。
const profile = join(OUT, "profile-panel-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 端口交给系统分配，再从 DevToolsActivePort 读回来。
//
// 原来写死 9230，踩过一个很隐蔽的坑：上一轮 Edge 没退干净时端口还占着，
// 新进程开不了监听，但 fetch(/json) 照样有响应 —— 连的是**上一轮的浏览器**，
// 里面还留着上一轮写的 localStorage，于是「初始没有面板状态记录」这项莫名失败。
// 动态端口 + 读 DevToolsActivePort，保证接连的一定是本次拉起的那个实例。
const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--window-size=1200,900", "about:blank",
  ],
  { stdio: "ignore" }
);

let port = 0;
for (let i = 0; i < 60; i++) {
  const marker = join(profile, "DevToolsActivePort");
  if (existsSync(marker)) {
    const txt = readFileSync(marker, "utf8").split(/\r?\n/);
    if (txt[0] && Number(txt[0]) > 0) { port = Number(txt[0]); break; }
  }
  await sleep(200);
}

let target;
if (port) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(250);
  }
}
if (!target) {
  edge.kill();
  console.error("连不上调试端口");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const r = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__OPS_HARNESS__ = {
      id: ${JSON.stringify(BOARD_ID)},
      dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))},
      label: ${JSON.stringify(BOARD_ID)}
    };
    const rf = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/ops-board/ask') === 0) {
        try { window.__ASK_ID = JSON.parse(opts.body).askId; } catch (e) {}
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, askId: window.__ASK_ID }) });
      }
      return rf.apply(window, arguments);
    };
  `,
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

const ready = async () => {
  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.querySelector('#ai-panel')")) return true;
    await sleep(200);
  }
  return false;
};
const reload = async () => {
  await send("Page.reload", { ignoreCache: false });
  await sleep(500);
  return ready();
};

await send("Page.navigate", { url: pathToFileURL(PAGE).href });
await ready();

const isOpen = () => ev(`document.querySelector('#ai-panel').classList.contains('is-open')`);
const ctxLabel = () => ev(`(document.querySelector('#ai-ctx')||{}).textContent || ''`);
const stored = () => ev(`window.localStorage.getItem('ops-board-panel:' + window.__OPS_HARNESS__.id)`);

// ① 初始应为关闭
check("初始面板是关闭的", (await isOpen()) === false);
check("初始没有面板状态记录", (await stored()) === null, String(await stored()));

// ② 打开「整本台账」入口
await ev(`(() => {
  const b = document.querySelector('[data-ask-global]') || document.querySelector('[data-ask]');
  b.click(); return true;
})()`);
await sleep(400);
check("点入口后面板打开", (await isOpen()) === true);
const savedAfterOpen = await stored();
check("打开后写下了面板状态", !!savedAfterOpen, String(savedAfterOpen));
check("状态里标了 open:true", /"open"\s*:\s*true/.test(savedAfterOpen || ""), savedAfterOpen);

// ③ 真的重载页面 —— 模拟「跳去 Harness 再回来」
check("重载后页面就绪", await reload());
check("重载后面板仍然是打开的", (await isOpen()) === true);

// ④ 作用域也要回到同一处
const ctxAfter = await ctxLabel();
check("重载后仍在一开始的作用域", ctxAfter && ctxAfter.trim().length > 0, `#ai-ctx = "${ctxAfter}"`);

// ⑤ 关闭后重载，不应再自动打开
await ev(`document.querySelector('#ai-close').click()`);
await sleep(200);
check("点关闭后面板收起", (await isOpen()) === false);
check("关闭后状态记为 open:false", /"open"\s*:\s*false/.test((await stored()) || ""), String(await stored()));
check("重载后页面就绪（关闭态）", await reload());
check("关闭后重载不会自己弹开", (await isOpen()) === false);

// ⑥ 单条台账的作用域也要能恢复
const itemId = await ev(`(() => {
  const b = document.querySelector('[data-ask]');
  return b ? (b.getAttribute('data-ask') || '') : '';
})()`);
if (itemId) {
  await ev(`(() => { document.querySelector('[data-ask="${itemId}"]').click(); return true; })()`);
  await sleep(400);
  const ctxItem = await ctxLabel();
  check("打开单条台账面板", (await isOpen()) === true, `ctx="${ctxItem}"`);
  check("重载后页面就绪（单条）", await reload());
  check("重载后单条台账面板仍打开", (await isOpen()) === true);
  const ctxAfterItem = await ctxLabel();
  check("重载后作用域仍是同一条台账", ctxAfterItem === ctxItem, `"${ctxItem}" → "${ctxAfterItem}"`);
} else {
  console.log("（本板没有单条 data-ask，跳过单条作用域）");
}

// ⑦ 「风险审核」是独立作用域：重载后要回到风险作用域，不能退回整本台账。
//    两者头部文案不同（「风险审核 · 只审风险车道」/「整本台账」），按文案判就够。
const riskBtn = await ev(`(() => {
  const b = document.querySelector('[data-ask-risks]');
  return b ? b.textContent.trim() : '';
})()`);
if (riskBtn) {
  await ev(`(() => { document.querySelector('[data-ask-risks]').click(); return true; })()`);
  await sleep(500);
  const ctxRisk = await ctxLabel();
  check("点「风险审核」开面板", (await isOpen()) === true, `ctx="${ctxRisk}"`);
  check("作用域是风险审核", /^风险审核/.test(String(ctxRisk || "")), `ctx="${ctxRisk}"`);
  check("重载后页面就绪（风险审核）", await reload());
  check("重载后风险面板仍打开", (await isOpen()) === true);
  const ctxAfterRisk = await ctxLabel();
  check("重载后作用域仍是风险审核", /^风险审核/.test(String(ctxAfterRisk || "")), `ctx="${ctxAfterRisk}"`);
  check("重载后没有退回整本台账", String(ctxAfterRisk || "").indexOf("整本台账") !== 0, `ctx="${ctxAfterRisk}"`);
} else {
  console.log("（本板没有 data-ask-risks，跳过风险作用域恢复）");
}

// ⑧ 本地缓存坏了不能把页面搞崩
await ev(`window.localStorage.setItem('ops-board-panel:' + window.__OPS_HARNESS__.id, '{{{坏数据')`);
check("坏数据下重载仍就绪", await reload());
check("坏数据下不生硬报错、面板保持关闭", (await isOpen()) === false);

if (crashes.length) {
  console.log("\n页面异常：");
  for (const c of crashes.slice(0, 5)) console.log("  " + String(c).split("\n")[0]);
  check("无未捕获异常", false, `${crashes.length} 个`);
} else {
  check("无未捕获异常", true);
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${fails.length === 0 ? "自检通过" : "有 " + fails.length + " 项没过"}：${results.length} 项`);
ws.close();
edge.kill();
process.exit(fails.length === 0 ? 0 : 1);
