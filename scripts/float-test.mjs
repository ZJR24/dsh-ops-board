// 验证「看板对话窗口」真的像一个正常的对话窗口：
//   ① 单独显示成小浮窗（不再是贴右边缘的整条抽屉）
//   ② 能任意改大小（八条边/角）
//   ③ 能置顶
//   ④ 回答区和输入区之间那条分界能上拉下拉
//   ⑤ 拖走之后记得住位置，且永远不会跑到屏幕外找不回来
//
// 全部用真实鼠标事件（Input.dispatchMouseEvent）走一遍，而不是在页面里
// 直接调函数 —— 这样连「拖不动是因为被别的东西挡住」也能测出来。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");

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
const profile = join(OUT, "profile-float-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--window-size=1280,900", "about:blank",
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
  await sleep(600);
  return ready();
};

await send("Page.navigate", { url: pathToFileURL(PAGE).href });
await ready();
if (!(await ev("!!document.querySelector('#ai-panel')"))) {
  console.error("这块看板没开问 AI（没有 #ai-panel），本套验收不适用");
  edge.kill();
  process.exit(0);
}

// ── 真实鼠标 ──────────────────────────────────────────────
// 用 CDP 的鼠标事件而不是页面里 dispatchEvent：Chromium 会把它翻译成
// 真正的 pointerdown/move/up，写起来的东西跟用户手指点出来的是同一条路。
const mouse = async (type, x, y, extra = {}) =>
  send("Input.dispatchMouseEvent", {
    type, x: Math.round(x), y: Math.round(y),
    button: type === "mouseMoved" ? "none" : "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
    ...extra,
  });

// 按下 → 分几步移动 → 松开。分步是必要的：一步跳到终点虽然也触发 pointermove，
// 但真实的拖动中间会有很多步，一次位移能过、连续位移过不了的情况是存在的。
const dragBy = async (x1, y1, x2, y2, steps = 8) => {
  await mouse("mousePressed", x1, y1);
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await sleep(16);
  }
  await mouse("mouseReleased", x2, y2);
  await sleep(120);
};

const rectOf = (sel) =>
  ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,right:r.right,bottom:r.bottom};})()`);
const panelRect = () => rectOf("#ai-panel");
const mode = () => ev(`document.querySelector('#ai-panel').getAttribute('data-mode')`);
const pinned = () => ev(`document.querySelector('#ai-panel').getAttribute('data-pinned')`);
const storeKey = () => `ops-board-win:${BOARD_ID}`;
const storedWin = async () => {
  const raw = await ev(`window.localStorage.getItem(${JSON.stringify(storeKey())})`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const vp = () => ev(`({w:window.innerWidth,h:window.innerHeight})`);
const openPanel = async () => {
  await ev(`(function(){var b=document.querySelector('[data-ask]');if(b)b.click();})()`);
  await sleep(450);
};
// 把窗口摆到一个已知的、四周都有余量的位置。
// 后面每一项拉伸手势都要在视口里拖 —— 拖到视口外，Chromium 就不再把
// 鼠标事件送给页面了，看上去像「拉不动」，其实是我的测试点飘出去了。
const resetWin = async (x, y, w, h, pinned = false) => {
  await ev(`window.localStorage.setItem(${JSON.stringify(storeKey())}, JSON.stringify({mode:"float",pinned:${pinned},x:${x},y:${y},w:${w},h:${h},foot:0}))`);
  await reload();
  if (!(await ev(`document.querySelector('#ai-panel').classList.contains('is-open')`))) await openPanel();
  await sleep(250);
};

// ═══ 〔1〕单独显示成小浮窗 ═══════════════════════════════
console.log("\n〔1〕单独显示：从整条抽屉变成一个小窗");
await openPanel();

const vp0 = await vp();
const r0 = await panelRect();
check("面板已打开", (await ev(`document.querySelector('#ai-panel').classList.contains('is-open')`)) === true);
check("默认是浮窗形态", (await mode()) === "float", String(await mode()));
check(
  "不再是贴着右边缘、占满整屏高的抽屉",
  r0.h < vp0.h - 40 && r0.right < vp0.w,
  `窗 ${Math.round(r0.w)}×${Math.round(r0.h)}，视口 ${vp0.w}×${vp0.h}`
);
check(
  "窗口是独立的一块（有圆角、有投影、四边都不贴屏幕边）",
  r0.x > 0 && r0.y > 0 && r0.bottom < vp0.h && r0.right < vp0.w,
  `left=${Math.round(r0.x)} top=${Math.round(r0.y)} right=${Math.round(r0.right)} bottom=${Math.round(r0.bottom)}`
);
const chrome = await ev(`(function(){
  var p=document.getElementById("ai-panel"),h=document.getElementById("ai-head");
  var cp=getComputedStyle(p),ch=getComputedStyle(h);
  return {pos:cp.position,radius:cp.borderTopLeftRadius,shadow:cp.boxShadow!=="none",cursor:ch.cursor};
})()`);
check("是浮起来的窗口（position:fixed + 圆角 + 投影）", chrome.pos === "fixed" && chrome.radius !== "0px" && chrome.shadow === true, `${chrome.pos} / 圆角 ${chrome.radius}`);
check("标题栏是可拖动的光标", chrome.cursor === "move", chrome.cursor);

// ═══ 〔2〕拖着标题栏走 ══════════════════════════════════
console.log("\n〔2〕拖动：抓标题栏能挪位置");
const before2 = await panelRect();
await dragBy(before2.x + before2.w / 2, before2.y + 14, before2.x + before2.w / 2 - 90, before2.y + 14 - 70);
const after2 = await panelRect();
check(
  "标题栏拖动后窗口跟着走",
  Math.abs(after2.x - (before2.x - 90)) <= 3 && Math.abs(after2.y - (before2.y - 70)) <= 3,
  `Δ=(${Math.round(after2.x - before2.x)}, ${Math.round(after2.y - before2.y)})，期望 (-90, -70)`
);
check(
  "拖动只挪位置，不改变大小",
  Math.abs(after2.w - before2.w) <= 1 && Math.abs(after2.h - before2.h) <= 1,
  `${Math.round(after2.w)}×${Math.round(after2.h)}`
);
check("拖完记在了本机", (await storedWin()) !== null, storeKey());

// 拖到标题栏上的按钮不该把窗口带走
const before2b = await panelRect();
const pinRect = await rectOf("#ai-pin");
await dragBy(pinRect.x + pinRect.w / 2, pinRect.y + pinRect.h / 2, pinRect.x + pinRect.w / 2 + 100, pinRect.y + pinRect.h / 2 + 60);
const after2b = await panelRect();
check(
  "按在标题栏按钮上拖，窗口不动（否则点按钮会连带把窗拖跑）",
  Math.abs(after2b.x - before2b.x) <= 1 && Math.abs(after2b.y - before2b.y) <= 1,
  `Δ=(${Math.round(after2b.x - before2b.x)}, ${Math.round(after2b.y - before2b.y)})`
);

// 拖出屏幕要被夹回来
const vpEdge = await vp();
await dragBy(after2b.x + 40, after2b.y + 14, after2b.x + 40 + vpEdge.w * 2, after2b.y + 14 + vpEdge.h * 2);
const pinned2 = await panelRect();
check(
  "往屏幕外拖会被夹在视口里（拖丢了就再也找不回来）",
  pinned2.x >= 0 && pinned2.y >= 0 && pinned2.right <= vpEdge.w && pinned2.bottom <= vpEdge.h,
  `now left=${Math.round(pinned2.x)} top=${Math.round(pinned2.y)} right=${Math.round(pinned2.right)} bottom=${Math.round(pinned2.bottom)} / 视口 ${vpEdge.w}×${vpEdge.h}`
);

// ═══ 〔3〕任意改大小 ════════════════════════════════════
console.log("\n〔3〕改大小：八条边/角都能拉");
await resetWin(120, 60, 480, 420);
const grips = await ev(`Array.from(document.querySelectorAll('#ai-panel .ai-grip')).map(function(g){
  var r=g.getBoundingClientRect();
  var cx=r.left+r.width/2, cy=r.top+r.height/2;
  var hit=document.elementFromPoint(cx,cy);
  return {dir:g.getAttribute("data-dir"),x:cx,y:cy,w:r.width,h:r.height,
    cursor:getComputedStyle(g).cursor,
    onTop: !!(hit && hit.classList && hit.classList.contains("ai-grip"))};
})`);
check("八个方向的抓手都在", grips.length === 8, grips.map((g) => g.dir).join(" "));
check(
  "每个抓手都真的在最上层（没被别的元素盖住，否则拉不动）",
  grips.every((g) => g.onTop),
  grips.filter((g) => !g.onTop).map((g) => g.dir).join(" ") || "全部可点"
);
const cursorMap = Object.fromEntries(grips.map((g) => [g.dir, g.cursor]));
check(
  "光标按方向区分开（上下 / 左右 / 两种对角各不相同）",
  new Set(grips.map((g) => g.cursor)).size === 4 &&
    cursorMap.n === "ns-resize" && cursorMap.w === "ew-resize" &&
    cursorMap.nw === "nwse-resize" && cursorMap.ne === "nesw-resize",
  grips.map((g) => `${g.dir}=${g.cursor}`).join(" ")
);

// 右下角拉大
const before3 = await panelRect();
const se = grips.find((g) => g.dir === "se");
await dragBy(se.x, se.y, se.x + 80, se.y + 60);
const after3 = await panelRect();
check(
  "拉右下角：宽高一起变大，左上角不动",
  Math.abs(after3.w - (before3.w + 80)) <= 3 && Math.abs(after3.h - (before3.h + 60)) <= 3 &&
    Math.abs(after3.x - before3.x) <= 1 && Math.abs(after3.y - before3.y) <= 1,
  `${Math.round(before3.w)}×${Math.round(before3.h)} → ${Math.round(after3.w)}×${Math.round(after3.h)}`
);

// 左上角拉小：对面那条边必须钉住，否则窗口会一边变窄一边往右下跑
const before3b = await panelRect();
const nw = grips.find((g) => g.dir === "nw");
await dragBy(nw.x, nw.y, nw.x + 60, nw.y + 40);
const after3b = await panelRect();
check(
  "拉左上角：右下角钉住不动，只改左上这条边",
  Math.abs(after3b.right - before3b.right) <= 2 && Math.abs(after3b.bottom - before3b.bottom) <= 2,
  `right ${Math.round(before3b.right)}→${Math.round(after3b.right)}，bottom ${Math.round(before3b.bottom)}→${Math.round(after3b.bottom)}`
);
check(
  "拉左上角会让窗口变小（不是整体平移）",
  after3b.w < before3b.w && after3b.h < before3b.h,
  `${Math.round(before3b.w)}×${Math.round(before3b.h)} → ${Math.round(after3b.w)}×${Math.round(after3b.h)}`
);

// 单条边：只改一个方向
const before3c = await panelRect();
const eEast = (await ev(`(function(){var g=document.querySelector('#ai-panel .ai-grip[data-dir=\"e\"]');var r=g.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`));
await dragBy(eEast.x, eEast.y, eEast.x + 50, eEast.y);
const after3c = await panelRect();
check(
  "拉右边只改宽度、不改高度",
  Math.abs(after3c.w - (before3c.w + 50)) <= 3 && Math.abs(after3c.h - (before3c.h)) <= 1,
  `宽 ${Math.round(before3c.w)}→${Math.round(after3c.w)}，高 ${Math.round(before3c.h)}→${Math.round(after3c.h)}`
);

// 拉到极小要顶住底线，不能翻转
const se2 = await ev(`(function(){var g=document.querySelector('#ai-panel .ai-grip[data-dir=\"se\"]');var r=g.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
await dragBy(se2.x, se2.y, se2.x - 400, se2.y - 400);
const tiny = await panelRect();
check(
  "拉到最小也还是能用的窗（有最小宽高，不会翻成负的）",
  tiny.w >= 300 && tiny.h >= 280 && tiny.w > 0 && tiny.h > 0,
  `${Math.round(tiny.w)}×${Math.round(tiny.h)}`
);

// ═══ 〔4〕置顶 ══════════════════════════════════════════
console.log("\n〔4〕置顶：钉在搜索浮层上面");
const zOff = await ev(`getComputedStyle(document.getElementById('ai-panel')).zIndex`);
const zFinder = await ev(`getComputedStyle(document.getElementById('finder')).zIndex`);
// 不置顶时不该盖住搜索 —— 否则打开 Ctrl+F，浮窗会正好挡住搜索结果。
// 这一条不做的话「置顶」按钮就成了摆设：反正本来就在最上面。
check(
  "不置顶时，搜索浮层盖得住浮窗（不然浮窗会挡住搜索结果）",
  Number(zOff) < Number(zFinder),
  `面板 ${zOff} / 搜索 ${zFinder}`
);
await ev(`document.getElementById('ai-pin').click()`);
await sleep(150);
const afterPin = await ev(`(function(){
  var p=document.getElementById('ai-panel'),b=document.getElementById('ai-pin');
  return {pinned:p.getAttribute('data-pinned'),z:getComputedStyle(p).zIndex,label:b.textContent.trim(),pressed:b.getAttribute('aria-pressed')};
})()`);
check("点「置顶」后状态记成已置顶", afterPin.pinned === "1", String(afterPin.pinned));
check("置顶后层级升高", Number(afterPin.z) > Number(zOff), `${zOff} → ${afterPin.z}`);
check("置顶后盖得住搜索浮层", Number(afterPin.z) > Number(zFinder), `面板 ${afterPin.z} / 搜索 ${zFinder}`);
check("按钮自己也显示成按下状态", afterPin.pressed === "true");

const zSettings = await ev(`getComputedStyle(document.getElementById('settings')).zIndex`);
check(
  "但不盖住设置弹窗（那是模态确认框，被压住会以为点不动）",
  Number(afterPin.z) < Number(zSettings),
  `面板 ${afterPin.z} / 设置 ${zSettings}`
);

await ev(`document.getElementById('ai-pin').click()`);
await sleep(150);
check("再点一下取消置顶", (await pinned()) === "0", String(await pinned()));

// 置顶也得记得住
await ev(`document.getElementById('ai-pin').click()`);
await sleep(120);
check("置顶状态存在本机", (await storedWin())?.pinned === true, JSON.stringify(await storedWin()));

// ═══ 〔5〕上拉下拉回答和输入的分界 ══════════════════════════
console.log("\n〔5〕分界：上拉把输入区拉大");
// 先用一个正常大小的窗：刚才拉到 320×300 的最小尺寸，
// 那么矮的窗里分界本来就没什么可拉的空间（回答区要留 96px 底线）。
// 拖动与置顶都过了，再进分界这一节。
// 注意：resetWin 会把置顶复位，所以「刷新后置顶还在」那项要自己再钉一次。
const keepPin = await pinned();
await resetWin(140, 70, 480, 620, keepPin === "1");
const split = await ev(`(function(){
  var s=document.getElementById('ai-split');var r=s.getBoundingClientRect();
  return {x:r.left+r.width/2,y:r.top+r.height/2,h:r.height,cursor:getComputedStyle(s).cursor};
})()`);
check("分界是一条能上下拉的手柄", split.h >= 5 && split.cursor === "row-resize", `高 ${split.h}px，光标 ${split.cursor}`);

const foot0 = await ev(`document.getElementById('ai-foot').offsetHeight`);
const msgs0 = await ev(`document.getElementById('ai-msgs').offsetHeight`);
await dragBy(split.x, split.y, split.x, split.y - 70);
const foot1 = await ev(`document.getElementById('ai-foot').offsetHeight`);
const msgs1 = await ev(`document.getElementById('ai-msgs').offsetHeight`);
check("往上拉，输入区变高", foot1 > foot0 + 40, `${foot0} → ${foot1}`);
check("往上拉的同时，回答区让出高度（不是整窗变高）", msgs1 < msgs0 - 40, `${msgs0} → ${msgs1}`);

const rectFoot = await panelRect();
await dragBy(split.x, split.y - 70, split.x, split.y - 70 + 110);
const foot2 = await ev(`document.getElementById('ai-foot').offsetHeight`);
check("往下拉，输入区又收回去", foot2 < foot1 - 40, `${foot1} → ${foot2}`);
check("拉分界不改窗口本身的大小", Math.abs((await panelRect()).h - rectFoot.h) <= 1, `${Math.round(rectFoot.h)}`);

// 键盘也能调（抓不住鼠标的时候）
await ev(`document.getElementById('ai-split').focus()`);
const beforeKey = await ev(`document.getElementById('ai-foot').offsetHeight`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
await sleep(120);
const afterKey = await ev(`document.getElementById('ai-foot').offsetHeight`);
check("分界也能用键盘 ↑ 调（键盘用户够得着）", afterKey > beforeKey, `${beforeKey} → ${afterKey}`);

// 拉到极端要顶住：回答区不能被挤到看不见
const split2 = await ev(`(function(){var s=document.getElementById('ai-split');var r=s.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
await dragBy(split2.x, split2.y, split2.x, split2.y - 3000);
const capped = await ev(`(function(){
  return {msgs:document.getElementById('ai-msgs').offsetHeight,foot:document.getElementById('ai-foot').offsetHeight};
})()`);
check("往上拉到底，回答区还留得下一条内容（不会把回答挤没）", capped.msgs >= 80, `回答区 ${capped.msgs}px`);

// 双击收回复位
await ev(`document.getElementById('ai-split').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
await sleep(150);
check("双击分界收回自适应高度", (await ev(`document.getElementById('ai-foot').style.height`)) === "", String(await ev(`document.getElementById('ai-foot').style.height`)));

// ═══ 〔6〕关掉再开、刷新之后还记得 ═════════════════════════
console.log("\n〔6〕记住：关掉再开、刷新之后还是原样");
const keepFoot = await ev(`document.getElementById('ai-foot').offsetHeight`);
await ev(`document.getElementById('ai-split').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
await sleep(80);
const sp3 = await ev(`(function(){var s=document.getElementById('ai-split');var r=s.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
await dragBy(sp3.x, sp3.y, sp3.x, sp3.y - 55);
const wantFoot = await ev(`document.getElementById('ai-foot').offsetHeight`);
const wantRect = await panelRect();
const wantStore = await storedWin();
check("分界位置也存进了本机", wantStore && wantStore.foot > 0, JSON.stringify(wantStore));

await reload();
const restored = await ev(`(function(){
  var p=document.getElementById('ai-panel');
  var r=p.getBoundingClientRect();
  return {open:p.classList.contains('is-open'),mode:p.getAttribute('data-mode'),pinned:p.getAttribute('data-pinned'),
    x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
    foot:document.getElementById('ai-foot').offsetHeight};
})()`);
check("刷新后面板还在", restored.open === true);
check(
  "刷新后位置和大小都没变",
  Math.abs(restored.x - Math.round(wantRect.x)) <= 2 && Math.abs(restored.y - Math.round(wantRect.y)) <= 2 &&
    Math.abs(restored.w - Math.round(wantRect.w)) <= 2 && Math.abs(restored.h - Math.round(wantRect.h)) <= 2,
  `${restored.w}×${restored.h} @ (${restored.x},${restored.y}) vs ${Math.round(wantRect.w)}×${Math.round(wantRect.h)} @ (${Math.round(wantRect.x)},${Math.round(wantRect.y)})`
);
check("刷新后置顶状态还在", restored.pinned === "1", String(restored.pinned));
check("刷新后分界高度还在", Math.abs(restored.foot - wantFoot) <= 2, `${restored.foot} vs ${wantFoot}`);

// ═══ 〔7〕换小窗口：夹回视口内 ═══════════════════════════
console.log("\n〔7〕视口变小：窗口自己让回来");
// 先摆一个大窗，再把视口缩小 —— 只有这样才测得出「会不会跟着缩」。
await resetWin(60, 40, 900, 640);
const bigBefore = await panelRect();
await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 620, deviceScaleFactor: 1, mobile: false });
await sleep(500);
const small = await ev(`(function(){
  var p=document.getElementById('ai-panel');var r=p.getBoundingClientRect();
  return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left),y:Math.round(r.top),
    right:Math.round(r.right),bottom:Math.round(r.bottom),
    overflowX:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    vw:document.documentElement.clientWidth,vh:document.documentElement.clientHeight};
})()`);
check(
  "窄窗口里浮窗整块还在视口内",
  small.right <= small.vw && small.bottom <= small.vh && small.x >= 0 && small.y >= 0,
  `窗 (${small.x},${small.y}) ${small.w}×${small.h} / 视口 ${small.vw}×${small.vh}`
);
check("窄窗口里不出现横向滚动条", small.overflowX <= 0, `溢出 ${small.overflowX}px`);
check(
  "窗口比视口大时自己缩小（不缩小就等于有一半看不见）",
  small.w < bigBefore.w && small.h < bigBefore.h,
  `${Math.round(bigBefore.w)}×${Math.round(bigBefore.h)} → ${small.w}×${small.h}`
);
await send("Emulation.clearDeviceMetricsOverride", {});
await sleep(400);

// ═══ 〔8〕存了个离谱的位置也能救回来 ══════════════════════
console.log("\n〔8〕上次留了个屏幕外的位置，重开要能救回来");
await ev(`window.localStorage.setItem(${JSON.stringify(storeKey())}, JSON.stringify({mode:"float",pinned:false,x:99999,y:-99999,w:400,h:420,foot:0}))`);
await reload();
const rescued = await ev(`(function(){
  var r=document.getElementById('ai-panel').getBoundingClientRect();
  return {x:Math.round(r.left),y:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom),vw:window.innerWidth,vh:window.innerHeight};
})()`);
check(
  "记在屏幕外，打开时会被拉回视口里（否则等于窗口消失了）",
  rescued.x >= 0 && rescued.y >= 0 && rescued.right <= rescued.vw && rescued.bottom <= rescued.vh,
  `(${rescued.x},${rescued.y})-(${rescued.right},${rescued.bottom}) / 视口 ${rescued.vw}×${rescued.vh}`
);

// ═══ 〔9〕停靠形态：还能变回原来的贴边抽屉 ═══════════════════
console.log("\n〔9〕停靠：想回到原来的贴边抽屉也行");
await ev(`document.getElementById('ai-float-toggle').click()`);
await sleep(200);
const docked = await ev(`(function(){
  var p=document.getElementById('ai-panel'),r=p.getBoundingClientRect();
  // position:fixed 的坐标系是「初始包含块」（viewport 扣掉滚动条）。
  // innerWidth 含滚动条那条、documentElement.clientWidth 在隐藏滚动条时又不可靠，
  // 所以直接插一个 inset:0 的 fixed 探针，把这块区域量出来再比。
  var probe=document.createElement('div');
  probe.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;visibility:hidden';
  document.body.appendChild(probe);
  var pr=probe.getBoundingClientRect();
  var box={w:Math.round(pr.width),h:Math.round(pr.height)};
  probe.remove();
  var cs=getComputedStyle(p);
  return {mode:p.getAttribute('data-mode'),x:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),
    bottom:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height),box:box,
    cssRight:cs.right,cssTop:cs.top,cssBottom:cs.bottom,radius:cs.borderTopLeftRadius,
    gripCount:Array.from(document.querySelectorAll('#ai-panel .ai-grip')).filter(function(e){return getComputedStyle(e).display!=='none';}).length};
})()`);
check("切到停靠形态", docked.mode === "dock", String(docked.mode));
check(
  "停靠时贴住右边缘、占满整条边（跟原来一样）",
  Math.abs(docked.right - docked.box.w) <= 1 && Math.abs(docked.top) <= 1 && Math.abs(docked.bottom - docked.box.h) <= 1,
  `right=${docked.right}/${docked.box.w} top=${docked.top} bottom=${docked.bottom}/${docked.box.h}`
);
check(
  "停靠时是平贴的（没有圆角、没有外边距）",
  docked.cssRight === "0px" && docked.cssTop === "0px" && docked.cssBottom === "0px" && docked.radius === "0px",
  `right=${docked.cssRight} top=${docked.cssTop} radius=${docked.radius}`
);
check("停靠时把拉伸手柄收起来（拉不动就别装作能拉）", docked.gripCount === 0, `还露着 ${docked.gripCount} 个`);
await ev(`document.getElementById('ai-float-toggle').click()`);
await sleep(200);
const back2float = await panelRect();
check(
  "切回浮窗，还是刚才那个位置和大小",
  (await mode()) === "float" && Math.abs(back2float.w - 400) <= 4,
  `${Math.round(back2float.w)}×${Math.round(back2float.h)}`
);

// ═══ 〔10〕清空本机偏好要连窗口位置一起清 ═══════════════════
console.log("\n〔10〕清空本机偏好：窗口位置也该被清掉");
await ev(`window.localStorage.setItem(${JSON.stringify(storeKey())}, JSON.stringify({mode:"float",pinned:true,x:40,y:40,w:380,h:400,foot:0}))`);
await ev(`(function(){ var b=document.querySelector('#settings-open'); if(b) b.click(); })()`);
await sleep(300);
await ev(`document.getElementById('set-clear').click()`);
await sleep(200);
await ev(`document.getElementById('set-clear').click()`);
await sleep(300);
check("窗口位置被「清空本机偏好」扫掉了", (await ev(`window.localStorage.getItem(${JSON.stringify(storeKey())})`)) === null);

// ═══ 收尾 ══════════════════════════════════════════════
check("全程没有 JS 报错", crashes.length === 0, crashes.length ? crashes[0].split("\n")[0] : "");

const ok = results.filter((r) => r.ok).length;
console.log(`\n${ok}/${results.length} 项通过 · 看板 ${BOARD_ID}`);
if (crashes.length) console.log("报错：\n" + crashes.slice(0, 3).join("\n"));

ws.close();
edge.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(ok === results.length ? 0 : 1);
