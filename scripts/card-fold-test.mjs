// 本轮两件事的回归测试：
//   ① 已收口页卡片右侧的元信息（区域 · 日期）字号要跟开发中卡片一致，
//      之前是继承 body 的 16px，比左边的编号/状态大一倍，还把日期挤断了。
//   ② 「新增功能 / 问题修复 / 风险」三个车道页的卡片要能收起，但默认展开。
//      默认开是重点：这三页是干活的地方，进来必须看见正文。
//
// 用真实 Edge + CDP：字号要读 computedStyle，收起要真的点一下，静态读 HTML 都不算数。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");
const PORT = 9233;

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
const profile = join(OUT, "profile-fold");
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1280,900", "about:blank",
  ],
  { stdio: "ignore" }
);

let target;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const pageUrl = (hash) => `file:///${PAGE.replace(/\\/g, "/")}${hash || ""}`;

// ① 字号：已收口页的元信息必须和开发中卡片一致
await send("Page.navigate", { url: pageUrl("#view-closed") });
await sleep(1600);

const fonts = await ev(`(() => {
  const g = (e, p) => (e ? getComputedStyle(e)[p] : null);
  const px = (v) => (v ? parseFloat(v) : null);
  const closedMeta = document.querySelector('.card-collapsed > summary .meta');
  const closedId = document.querySelector('.card-collapsed > summary .id');
  // 基准：开发中卡片（总览的待处理表里没有卡片，用车道页的 card-open）
  const openMeta = document.querySelector('.card-open > summary .meta');
  const openId = document.querySelector('.card-open > summary .id');
  return {
    closedMeta: px(g(closedMeta, 'fontSize')),
    closedId: px(g(closedId, 'fontSize')),
    openMeta: px(g(openMeta, 'fontSize')),
    openId: px(g(openId, 'fontSize')),
    bodyFont: px(g(document.body, 'fontSize')),
    sample: closedMeta ? closedMeta.textContent.trim() : null,
  };
})()`);

const closedCount = await ev(`document.querySelectorAll('.card-collapsed').length`);
if (!closedCount) {
  // 这个看板一条都没收口，「已修复 / 已关闭 / 暂停」页本来就是空的
  // （页面上写的是「还没有已收口的条目」）。字号无从量起，跳过而不是记失败。
  console.log("（本板没有已收口条目，跳过字号三项）");
} else {
  check("已收口页有右侧元信息", !!fonts.sample, fonts.sample || "(没找到)");
  check(
    "元信息字号与开发中一致",
    fonts.openMeta !== null && fonts.closedMeta === fonts.openMeta,
    `已收口=${fonts.closedMeta}px，开发中=${fonts.openMeta}px`
  );
  check(
    "编号字号与开发中一致",
    fonts.openId !== null && fonts.closedId === fonts.openId,
    `已收口=${fonts.closedId}px，开发中=${fonts.openId}px`
  );
  check(
    "元信息不再继承正文的 16px",
    fonts.closedMeta !== null && fonts.closedMeta < fonts.bodyFont,
    `${fonts.closedMeta}px < 正文 ${fonts.bodyFont}px`
  );
}

// ② 三个车道页的卡片都要能收、且默认展开
const laneViews = await ev(`(() => {
  return Array.from(document.querySelectorAll('.view[data-view^="lane-"]')).map(v => {
    const cards = v.querySelectorAll('.card');
    const details = v.querySelectorAll('details.card');
    const open = v.querySelectorAll('details.card[open]');
    return {
      view: v.getAttribute('data-view'),
      title: (v.querySelector('.kicker') || {}).textContent || '',
      cards: cards.length,
      details: details.length,
      open: open.length,
    };
  });
})()`);

check("找到三个车道页", (laneViews || []).length === 3, (laneViews || []).map((v) => v.view).join(", "));

for (const v of laneViews || []) {
  check(
    `${v.title}页卡片都能收起`,
    v.cards > 0 && v.details === v.cards,
    `${v.cards} 张卡，其中可收起 ${v.details} 张`
  );
  check(
    `${v.title}页卡片默认展开`,
    v.cards > 0 && v.open === v.cards,
    `${v.open}/${v.cards} 默认展开`
  );
}

// ③ 真的点一下要能收起来；再点一下要能展开
await send("Page.navigate", { url: pageUrl("#view-lane-bug") });
await sleep(1500);

const folded = await ev(`(() => {
  const d = document.querySelector('.view.is-active details.card');
  if (!d) return null;
  const h0 = Math.round(d.getBoundingClientRect().height);
  d.querySelector('summary').click();
  const h1 = Math.round(d.getBoundingClientRect().height);
  const closedNow = !d.open;
  d.querySelector('summary').click();
  const h2 = Math.round(d.getBoundingClientRect().height);
  return { h0, h1, h2, closedNow, reopened: d.open };
})()`);

check("点标题行能把卡片收起来", !!folded && folded.closedNow, folded ? `高度 ${folded.h0} → ${folded.h1}` : "没找到卡片");
check(
  "收起后确实变矮（正文真的藏了）",
  !!folded && folded.h1 < folded.h0,
  folded ? `${folded.h0}px → ${folded.h1}px` : ""
);
check("再点一下能展开回去", !!folded && folded.reopened, folded ? `高度回到 ${folded.h2}px` : "");

// ④ 从表格点条目标题跳过来时，被收起的卡片要自动展开
//    否则跳过去只看到一行，看不到正文 —— 等于跳了个寂寞。
await send("Page.navigate", { url: pageUrl("#view-lane-bug") });
await sleep(1500);

const jump = await ev(`(() => {
  const d = document.querySelector('.view.is-active details.card');
  if (!d) return null;
  // 先收起来，模拟用户手动收起过
  d.open = false;
  const id = d.id;
  // 走看板自己的锚点跳转逻辑
  location.hash = '#' + id;
  return new Promise(resolve => setTimeout(() => resolve({ id, open: d.open }), 600));
})()`);

check("跳到被收起的卡片会自动展开", !!jump && jump.open === true, jump ? `${jump.id} open=${jump.open}` : "没找到卡片");

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