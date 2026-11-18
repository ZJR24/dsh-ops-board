#!/usr/bin/env node
/**
 * 外壳层对话窗的「接线」验收（不需要浏览器、不需要真 React）。
 *
 * 为什么要这一份：插件那半边只有重启 Harness 才会被加载，而重启会打断会话。
 * 但接线错误（函数名打错、消息类型对不上、几何算法算错）是完全可以在 Node 里
 * 用假的 React / 假的 DOM 跑出来的 —— 这一份就是干这个。
 *
 * 它验的是「逻辑对不对」，不是「画出来好不好看」。后者归 chatwin-test.mjs。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "..", "dsh-ops-board", "client.js"), "utf8");

let pass = 0;
let fail = 0;
const fails = [];
const ok = (n, d) => {
  pass += 1;
  console.log(`✓ ${n}${d ? " — " + d : ""}`);
};
const bad = (n, d) => {
  fail += 1;
  fails.push(n);
  console.log(`✗ ${n}${d ? " — " + d : ""}`);
};
const eq = (n, a, b) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) ok(n, x);
  else bad(n, `${x} ≠ ${y}`);
};
const near = (n, a, b, tol = 1) =>
  Math.abs(a - b) <= tol ? ok(n, `${a} ≈ ${b}`) : bad(n, `${a} ≠ ${b}`);

// ── 假 DOM ────────────────────────────────────────────────────────
const created = [];
const listeners = new Map();
const storage = new Map();
const bodyChildren = [];

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    children: [],
    style: {},
    parentNode: null,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(child) { this.children.push(child); child.parentNode = this; if (this === doc.body) bodyChildren.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    click() {},
  };
  return el;
}

const doc = {
  body: makeEl("body"),
  documentElement: makeEl("html"),
  head: makeEl("head"),
  createElement: (tag) => {
    const el = makeEl(tag);
    created.push(el);
    return el;
  },
  querySelector: () => null,
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener: () => {},
  getElementById: () => null,
  querySelectorAll: () => [],
};

const win = {
  innerWidth: 1280,
  innerHeight: 800,
  location: { origin: "http://127.0.0.1:1534", href: "http://127.0.0.1:1534/", pathname: "/", search: "" },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener: () => {},
  setTimeout: (fn) => { try { fn(); } catch {} return 0; },
  clearTimeout: () => {},
};

// ── 假 React：记录元素树，不渲染 ─────────────────────────────────
const renderCalls = [];
let hookState = [];
let hookIndex = 0;
const React = {
  createElement: (type, props, ...children) => {
    if (typeof type === "function") {
      renderCalls.push({ type: type.name, props: props || {} });
      // 函数组件不展开：我们只关心外层窗口有没有被挂起来
      return { __component: type.name, props: props || {} };
    }
    return { type, props: props || {}, children: children.flat() };
  },
  useState: (init) => {
    const i = hookIndex++;
    if (hookState[i] === undefined) hookState[i] = typeof init === "function" ? init() : init;
    return [hookState[i], (v) => { hookState[i] = typeof v === "function" ? v(hookState[i]) : v; }];
  },
  useEffect: () => { hookIndex += 1; },
  useRef: (init) => {
    const i = hookIndex++;
    if (hookState[i] === undefined) hookState[i] = { current: init };
    return hookState[i];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  createContext: () => ({ Provider: null, Consumer: null }),
  Fragment: "Fragment",
};
React.useLayoutEffect = React.useEffect;
React.useReducer = (r, init) => [init, () => {}];

const roots = [];
const ReactDOMClient = {
  createRoot: (container) => {
    const root = {
      container,
      rendered: null,
      unmounted: false,
      render(node) { this.rendered = node; renderCalls.push({ type: "ROOT_RENDER", props: { node } }); },
      unmount() { this.unmounted = true; },
    };
    roots.push(root);
    return root;
  },
};

const moduleCache = new Map();
const requireFn = (name) => {
  if (name === "react") return React;
  if (name === "react-dom/client") return ReactDOMClient;
  if (name === "react-dom") return { createPortal: (n) => n };
  if (moduleCache.has(name)) return moduleCache.get(name);
  throw new Error("假 require 不认识：" + name);
};

// ── 假 Harness：跑 factory ───────────────────────────────────────
let loaded = null;
globalThis.window = win;
globalThis.document = doc;
globalThis.localStorage = win.localStorage;
globalThis.setTimeout = win.setTimeout;
globalThis.clearTimeout = win.clearTimeout;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, boards: [], last: "" }) });
globalThis.EventSource = undefined;
// 源码读的是 window.__ModuleLoader__，所以假 window 上也必须有
win.__ModuleLoader__ = { load: (mod) => { loaded = mod; } };
globalThis.__ModuleLoader__ = win.__ModuleLoader__;

// client.js 是浏览器脚本，按原样求值：它只做一件事 —— 往 ModuleLoader 注册
eval(SRC);

if (!loaded || typeof loaded.factory !== "function") {
  bad("插件通过 __ModuleLoader__.load 注册了 factory");
  process.exit(1);
}
ok("插件通过 __ModuleLoader__.load 注册了 factory", loaded.id);

const exportsObj = loaded.factory(requireFn);
eq("factory 返回的插件名", exportsObj.name, "dsh-ops-board");
eq("声明要注入的服务", exportsObj.inject, ["slots", "locale", "layout", "sessions"]);

// ── 跑 apply，拿到注册的消息处理器 ───────────────────────────────
const effects = [];
const slotRegs = [];
const ctx = {
  effect: (fn, label) => {
    const dispose = fn();
    effects.push({ label, dispose });
    return dispose;
  },
  locale: Object.assign((key) => String(key), { register: () => () => {} }),
  get: () => null,
  slots: {
    inject: (name, fn) => fn(),
    register: (options, component) => {
      slotRegs.push({ options, component });
      return () => {};
    },
  },
};

let applied = null;
try {
  applied = exportsObj.apply(ctx);
} catch (error) {
  bad("apply() 能跑起来", String(error && error.message));
}
if (!applied) ok("apply() 能跑起来", "无异常");

const overlayEffect = effects.find((e) => e.label === "dsh-ops-board: detached chat window");
if (!overlayEffect) bad("注册了「独立对话窗」的 effect");
else ok("注册了「独立对话窗」的 effect", overlayEffect.label);

const handlers = listeners.get("message") || [];
const onChat = handlers[handlers.length - 1];
if (typeof onChat !== "function") bad("挂上了 message 监听");
else ok("挂上了 message 监听", `${handlers.length} 个`);

// ── 用消息把窗口打开 ─────────────────────────────────────────────
const before = doc.body.children.length;
onChat({
  origin: "http://127.0.0.1:1534",
  data: {
    type: "ops-board/chat-open",
    board: "practise",
    proxy: "/ops-board/b/practise/",
    scope: "item-7",
  },
});

const host = doc.body.children.find((el) => el.dataset && el.dataset.chatwin === "host");
if (!host) bad("收到 chat-open 后在 body 上建了宿主节点");
else ok("收到 chat-open 后在 body 上建了宿主节点", `${before} → ${doc.body.children.length}`);

if (roots.length !== 1) bad("在宿主上开了一个 React 根", `${roots.length} 个`);
else ok("在宿主上开了一个 React 根", roots[0].container === host ? "挂在宿主上" : "挂错地方");

const rendered = renderCalls.find((c) => c.type === "OpsBoardChatWindow");
if (!rendered) bad("渲染的是 OpsBoardChatWindow");
else {
  ok("渲染的是 OpsBoardChatWindow");
  eq("传进去的页面路径", rendered.props.proxy, "/ops-board/b/practise/");
  eq("传进去的对话作用域", rendered.props.scope, "item-7");
  eq("标题里带上看板名", rendered.props.title.includes("practise"), true);
  eq("带了关闭回调", typeof rendered.props.onClose, "function");
  eq("带了翻译函数", typeof rendered.props.t, "function");
}

// 不认的 proxy 要拒绝：只接相对路径，避免被塞进外站地址
const hostsBefore = doc.body.children.filter((e) => e.dataset && e.dataset.chatwin === "host").length;
onChat({
  origin: "http://127.0.0.1:1534",
  data: { type: "ops-board/chat-open", proxy: "https://evil.example/x", scope: "" },
});
const hostsAfter = doc.body.children.filter((e) => e.dataset && e.dataset.chatwin === "host").length;
// 注意：close() 会先执行，所以老窗口被拆掉、新窗口没建 → 数量应归零
eq("外站地址被拒绝（窗口被关掉而不是加载外站）", hostsAfter, 0);

// 再开一次，用于测关闭
onChat({
  origin: "http://127.0.0.1:1534",
  data: { type: "ops-board/chat-open", proxy: "/ops-board/b/practise/", scope: "" },
});
const rootsBeforeClose = roots.length;
onChat({ origin: "http://127.0.0.1:1534", data: { type: "ops-board/chat-close" } });
const alive = roots.filter((r) => !r.unmounted).length;
eq("收到 chat-close 后把根卸掉", alive, 0);
eq("收到 chat-close 后把宿主节点摘掉", doc.body.children.filter((e) => e.dataset && e.dataset.chatwin === "host").length, 0);

// 关掉之后还能再打开：不能因为上次关过就再也开不出来
onChat({
  origin: "http://127.0.0.1:1534",
  data: { type: "ops-board/chat-open", proxy: "/ops-board/b/practise/", scope: "" },
});
if (roots.length > rootsBeforeClose) ok("关掉之后再开会新建一个根", `${rootsBeforeClose} → ${roots.length}`);
else bad("关掉之后再开会新建一个根", `${rootsBeforeClose} → ${roots.length}`);
eq("关掉之后再开，宿主节点回来了", doc.body.children.filter((e) => e.dataset && e.dataset.chatwin === "host").length, 1);

// 别的 origin 的消息一律不理
const rootsBefore = roots.length;
onChat({ origin: "https://evil.example", data: { type: "ops-board/chat-open", proxy: "/x/" } });
eq("跨源消息被忽略", roots.length, rootsBefore);

// ── 几何算法：纯函数，单独抠出来测 ───────────────────────────────
// 直接跑源码里的函数体不方便（它们在闭包里），这里按同样的契约验行为：
// 用 chatwin-test 里已经确认过的语义 —— 完全落在视口内、不小于最小值、对边钉住。
const geomSrc = SRC.slice(
  SRC.indexOf("const CHAT_GEOM_KEY"),
  SRC.indexOf("function readChatGeom"),
);
// nextChatGeom 在 readChatGeom 之后，得单独接上
const nextSrc = SRC.slice(
  SRC.indexOf("function nextChatGeom"),
  SRC.indexOf("function OpsBoardChatWindow"),
);
if (!geomSrc || !nextSrc) bad("源码里能找到 clampChatGeom / nextChatGeom");
else ok("源码里能找到 clampChatGeom / nextChatGeom");

const geomFns = new Function(
  "window",
  geomSrc + nextSrc + "; return { clampChatGeom, nextChatGeom, defaultChatGeom, chatViewport, CHAT_EDGE, CHAT_MIN_W, CHAT_MIN_H };",
)(win);

const c1 = geomFns.clampChatGeom({ x: -500, y: -500, w: 400, h: 300 });
if (c1.x >= 0 && c1.y >= 0) ok("夹边：负坐标被拉回视口内", `(${c1.x},${c1.y})`);
else bad("夹边：负坐标被拉回视口内", JSON.stringify(c1));

const c2 = geomFns.clampChatGeom({ x: 5000, y: 5000, w: 400, h: 300 });
const vp = geomFns.chatViewport();
if (c2.x + c2.w <= vp.vw && c2.y + c2.h <= vp.vh) ok("夹边：右下角也不许出界", `${c2.x + c2.w}≤${vp.vw}, ${c2.y + c2.h}≤${vp.vh}`);
else bad("夹边：右下角也不许出界", JSON.stringify(c2));

const c3 = geomFns.clampChatGeom({ x: 10, y: 10, w: 10, h: 10 });
if (c3.w >= 120 && c3.h >= 120) ok("夹边：太小会被撑到可用下限", `${c3.w}×${c3.h}`);
else bad("夹边：太小会被撑到可用下限", JSON.stringify(c3));

const d = geomFns.defaultChatGeom();
if (d.x + d.w <= vp.vw && d.y + d.h <= vp.vh && d.x >= 0 && d.y >= 0) ok("默认位置在视口内", `${d.x},${d.y} ${d.w}×${d.h}`);
else bad("默认位置在视口内", JSON.stringify(d));

// 拖左边：右边必须钉住（x+w 不变）；拖上边：底边钉住
const start = { x: 200, y: 200, w: 500, h: 400 };
const west = geomFns.nextChatGeom(start, "resize", "w", -60, 0);
near("拉左边：右边钉住不动", west.x + west.w, start.x + start.w);
near("拉左边：宽度增加同样的量", west.w, start.w + 60);
near("拉左边：高度不变", west.h, start.h);

const north = geomFns.nextChatGeom(start, "resize", "n", 0, -50);
near("拉上边：底边钉住不动", north.y + north.h, start.y + start.h);
near("拉上边：高度增加同样的量", north.h, start.h + 50);

const se = geomFns.nextChatGeom(start, "resize", "se", 40, 30);
near("拉右下角：宽加对应的量", se.w, start.w + 40);
near("拉右下角：高加对应的量", se.h, start.h + 30);
near("拉右下角：左上角不动", se.x, start.x);
near("拉右下角：上边缘不动", se.y, start.y);

const moved = geomFns.nextChatGeom(start, "move", "", 30, 20);
near("整体拖动：宽不变", moved.w, start.w);
near("整体拖动：高不变", moved.h, start.h);
near("整体拖动：横坐标跟着走", moved.x, start.x + 30);
near("整体拖动：纵坐标跟着走", moved.y, start.y + 20);

// 拖出边界要被夹回来，不能"拖出屏幕就找不回来"
const wild = geomFns.nextChatGeom(start, "move", "", 99999, 99999);
if (wild.x + wild.w <= vp.vw && wild.y + wild.h <= vp.vh) ok("拖出屏幕会被夹回视口", `${wild.x},${wild.y}`);
else bad("拖出屏幕会被夹回视口", JSON.stringify(wild));

// 拉到比最小尺寸还小，要停在最小尺寸上，且不能翻面
const tiny = geomFns.nextChatGeom(start, "resize", "e", -9999, 0);
if (tiny.w >= 120 && tiny.x >= 0) ok("往内拉到极限也不会翻面", `${tiny.w}×${tiny.h}`);
else bad("往内拉到极限也不会翻面", JSON.stringify(tiny));

// ── 持久化：几何要落在 ops-board- 前缀下，且能读回来 ─────────────
const geomKey = (SRC.match(/CHAT_GEOM_KEY = '([^']+)'/) || [])[1];
const pinKey = (SRC.match(/CHAT_PIN_KEY = '([^']+)'/) || [])[1];
eq("几何键在有 ops-board- 前缀下（「清空本机偏好」能扫到）", geomKey, "ops-board-chatwin");
eq("置顶键在 ops-board- 前缀下", pinKey, "ops-board-chatwin-pin");

// 默认几何不该写盘（第一次打开就写会把「没设置过」变成「设置过」）
if (storage.size === 0) ok("打开窗口本身不写盘（写盘只发生在真正动过之后）", `${storage.size} 个键`);
else bad("打开窗口本身不写盘", [...storage.keys()].join(","));

console.log("");
if (fail === 0) console.log(`自检通过：${pass} 项 · 外壳层对话窗接线`);
else {
  console.log(`${pass} 项通过 · ${fail} 项失败`);
  for (const n of fails) console.log("  ✗ " + n);
  process.exitCode = 1;
}