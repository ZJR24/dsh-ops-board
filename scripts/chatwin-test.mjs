#!/usr/bin/env node
/**
 * 独立对话窗验收（?chat=1 这一半）。
 *
 * 这一份只管「被当成独立窗口加载时，那个页面是否只剩对话框」：
 * 骨架藏掉了没、面板是不是铺满整个 iframe、置顶/停靠/弹窗/拉角这些
 * 交给外层窗口的控件是不是收起来了、分界线还能不能拉、关窗有没有走对外通知。
 *
 * 外层那个 Harness 窗口（document.body 上的 .ob-chatwin）由插件渲染，
 * CDP 打开的是看板页面本身，够不到 Harness 外壳，所以不在这一份里断言。
 *
 * 用法：node scripts/chatwin-test.mjs --board "<看板绝对路径>"
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const PAGE = join(ROOT, "dist", "index.html");
const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();

if (!existsSync(PAGE)) {
  console.error("没有 dist/index.html：" + PAGE);
  process.exit(2);
}

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  process.exit(2);
}

const OUT = join(ROOT, ".uitest");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-chatwin-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });

let pass = 0;
let fail = 0;
const fails = [];
const ok = (name, detail) => {
  pass += 1;
  console.log(`✓ ${name}${detail ? " — " + detail : ""}`);
};
const bad = (name, detail) => {
  fail += 1;
  fails.push(name);
  console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
};
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) ok(name, a);
  else bad(name, `实际 ${a} ≠ 期望 ${b}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--window-size=1280,900", "about:blank",
  ],
  { stdio: "ignore" },
);

let port = 0;
for (let i = 0; i < 60; i += 1) {
  const marker = join(profile, "DevToolsActivePort");
  if (existsSync(marker)) {
    const txt = readFileSync(marker, "utf8").split(/\r?\n/);
    if (txt[0] && Number(txt[0]) > 0) {
      port = Number(txt[0]);
      break;
    }
  }
  await sleep(200);
}

let target = null;
if (port) {
  for (let i = 0; i < 40; i += 1) {
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
const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(
      m.params?.exceptionDetails?.exception?.description ||
        m.params?.exceptionDetails?.text ||
        "exception",
    );
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
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

const FILE_URL = "file:///" + PAGE.replace(/\\/g, "/");
const goto = async (url, ms = 1400) => {
  await send("Page.navigate", { url });
  await sleep(ms);
};

try {
  // ── 独立窗口形态 ────────────────────────────────────────────────
  await goto(FILE_URL + "?chat=1");
  eq("URL 带 ?chat=1 时 <html> 上被打了 data-chat", await ev(
    `document.documentElement.getAttribute("data-chat")`,
  ), "1");

  // 〔1〕整页骨架确实不显示了
  const chrome = await ev(`(() => {
    const sels = [".topbar", ".masthead", ".nav", ".layout", ".finder", ".settings"];
    return sels.filter((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    });
  })()`);
  eq("顶栏/报头/导航/正文/搜索/设置全部不显示", chrome, []);

  // 〔2〕对话框铺满整个窗口
  const fill = await ev(`(() => {
    const p = document.getElementById("ai-panel");
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      vw: innerWidth, vh: innerHeight,
      opacity: cs.opacity, pointer: cs.pointerEvents,
      radius: cs.borderTopLeftRadius,
    };
  })()`);
  eq("左边缘贴住窗口", fill.x, 0);
  eq("上边缘贴住窗口", fill.y, 0);
  if (Math.abs(fill.w - fill.vw) <= 1) ok("宽度铺满", `${fill.w}/${fill.vw}`);
  else bad("宽度铺满", `${fill.w}/${fill.vw}`);
  if (Math.abs(fill.h - fill.vh) <= 1) ok("高度铺满", `${fill.h}/${fill.vh}`);
  else bad("高度铺满", `${fill.h}/${fill.vh}`);
  eq("可见可点", `${fill.opacity}/${fill.pointer}`, "1/auto");
  eq("不再画自己的圆角（圆角归外层窗口）", fill.radius, "0px");

  // 〔3〕归外层窗口管的控件都收起来了
  const hidden = await ev(`(() => {
    const ids = ["ai-pin", "ai-float-toggle", "ai-detach"];
    return {
      shownIds: ids.filter((id) => {
        const el = document.getElementById(id);
        return el && getComputedStyle(el).display !== "none";
      }),
      grips: [...document.querySelectorAll(".ai-grip")]
        .filter((el) => getComputedStyle(el).display !== "none").length,
    };
  })()`);
  eq("置顶/停靠/弹窗按钮都不显示", hidden.shownIds, []);
  eq("八个拉角都不显示", hidden.grips, 0);

  // 〔4〕标题栏不能再拖（拖动归外层窗口，里面再拖就是两套定位打架）
  const cursor = await ev(`getComputedStyle(document.getElementById("ai-head")).cursor`);
  if (cursor !== "move") ok("标题栏光标不是 move", cursor);
  else bad("标题栏光标不是 move", cursor);

  // 〔5〕真正用得上的东西都还在
  const usable = await ev(`(() => {
    const q = (sel) => !!document.querySelector(sel);
    return {
      msgs: q("#ai-msgs"), input: q("#ai-input"), send: q("#ai-send"),
      split: q("#ai-split"), session: q("#ai-session"),
      open: document.getElementById("ai-panel").classList.contains("is-open"),
    };
  })()`);
  eq("消息区在", usable.msgs, true);
  eq("输入框在", usable.input, true);
  eq("发送按钮在", usable.send, true);
  eq("分界线在", usable.split, true);
  eq("会话选择在", usable.session, true);
  eq("面板处于打开状态", usable.open, true);

  // 〔6〕分界线还能拉
  const footBefore = await ev(`document.getElementById("ai-foot").offsetHeight`);
  await ev(`(() => {
    const s = document.getElementById("ai-split");
    const r = s.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const fire = (type, cy) => s.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: cy,
    }));
    fire("pointerdown", y);
    fire("pointermove", y - 90);
    fire("pointerup", y - 90);
  })()`);
  await sleep(250);
  const footAfter = await ev(`document.getElementById("ai-foot").offsetHeight`);
  if (footAfter > footBefore + 40) ok("往上拉分界线，输入区变高", `${footBefore} → ${footAfter}`);
  else bad("往上拉分界线，输入区变高", `${footBefore} → ${footAfter}`);
  eq("拉过之后高度被钉住", await ev(
    `document.getElementById("ai-foot").getAttribute("data-locked")`,
  ), "1");

  await ev(`document.getElementById("ai-split").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await sleep(250);
  eq("双击分界线收回自适应", await ev(
    `document.getElementById("ai-foot").getAttribute("data-locked")`,
  ), null);

  // 〔7〕关键：不写主看板的键。
  // 这个 iframe 和主看板同源、共用 localStorage，写一次就会把主看板
  // 正在聊的作用域 / 浮窗位置覆盖掉，关掉窗口回去就发现串台了。
  const keys = await ev(
    `Object.keys(localStorage).filter((k) => k.indexOf("ops-board-") === 0)`,
  );
  eq("没有写面板状态键（不去覆盖主看板）", keys.filter((k) => k.indexOf("ops-board-panel:") === 0), []);
  eq("没有写浮窗几何键（几何归外层窗口）", keys.filter((k) => k.indexOf("ops-board-win:") === 0), []);

  // 〔7b〕回答问题时的「各收各的」。
  // 回答是广播给所有 iframe 的，认不出来源就会两边串台：独立窗收不到、
  // 整页那边多补一条「迟到」气泡。这里**故意模拟旧版 Host** —— 发回来的
  // 回答里 surface 被落成默认的 'page'（旧 Host 就是这样丢字段的），
  // 只剩 askId 里那一位能说明来源。独立窗必须仍然认得出来。
  const mux = await ev(`(() => {
    const before = document.querySelectorAll("#ai-msgs .msg").length;
    // 旧 Host 丢字段的样子：surface 变成 'page'
    window.postMessage({
      type: "ops-board/answer", surface: "page",
      askId: "ask-c-legacy-123", text: "独立窗该收到这一条",
    }, location.origin);
    // 整页（p）那份不该进这个窗口
    window.postMessage({
      type: "ops-board/answer", surface: "page",
      askId: "ask-p-other-456", text: "整页那份，不该出现在这里",
    }, location.origin);
    return new Promise((resolve) => setTimeout(() => {
      const texts = [...document.querySelectorAll("#ai-msgs .msg")].map((n) => n.textContent);
      resolve({
        grew: document.querySelectorAll("#ai-msgs .msg").length - before,
        gotChat: texts.some((t) => t.indexOf("独立窗该收到这一条") >= 0),
        gotPage: texts.some((t) => t.indexOf("整页那份") >= 0),
      });
    }, 400));
  })()`);
  eq("旧 Host 丢了 surface，独立窗仍认得自己那份（靠 askId）", mux.gotChat, true);
  eq("整页那份不会被塞进独立窗", mux.gotPage, false);

  // 〔8〕关窗按钮走对外通知，不把面板自己藏掉
  const stillOpen = await ev(`(() => {
    document.getElementById("ai-close").click();
    return new Promise((resolve) => setTimeout(
      () => resolve(document.getElementById("ai-panel").classList.contains("is-open")), 320,
    ));
  })()`);
  eq("关窗按钮不把面板自己藏掉（关窗是外层的事）", stillOpen, true);

  // 〔9〕对照：不带参数时仍然是整页
  await goto(FILE_URL);
  const page = await ev(`(() => {
    const nav = document.querySelector(".nav");
    const p = document.getElementById("ai-panel").getBoundingClientRect();
    return {
      marker: document.documentElement.getAttribute("data-chat"),
      nav: nav ? getComputedStyle(nav).display : "missing",
      width: Math.round(p.width), vw: innerWidth,
    };
  })()`);
  eq("不带参数时没有 data-chat", page.marker, null);
  if (page.nav !== "none" && page.nav !== "missing") ok("导航还在（整页模式）", page.nav);
  else bad("导航还在（整页模式）", page.nav);
  if (page.width < page.vw * 0.9) ok("对话框不是铺满（仍是浮窗）", `${page.width} < ${page.vw}`);
  else bad("对话框不是铺满（仍是浮窗）", `${page.width} vs ${page.vw}`);

  // 〔10〕整页模式下该有的控件都还在
  const pageCtl = await ev(`(() => {
    const ids = ["ai-pin", "ai-float-toggle", "ai-detach"];
    return {
      btns: ids.filter((id) => {
        const el = document.getElementById(id);
        return el && getComputedStyle(el).display !== "none";
      }),
      grips: [...document.querySelectorAll(".ai-grip")]
        .filter((el) => getComputedStyle(el).display !== "none").length,
    };
  })()`);
  eq("置顶/停靠/弹窗三个按钮都在", pageCtl.btns.length, 3);
  eq("八个拉角都在", pageCtl.grips, 8);

  // 〔11〕带 scope 进来时要接着同一条对话
  await goto(FILE_URL + "?chat=1&scope=__risks__");
  const riskScope = await ev(`(() => {
    const el = document.getElementById("ai-ctx");
    return { ctx: el ? el.textContent.trim() : "", open: document.getElementById("ai-panel").classList.contains("is-open") };
  })()`);
  eq("带 __risks__ 进来时落在风险审核作用域", riskScope.ctx.indexOf("风险") >= 0, true);

  await goto(FILE_URL + "?chat=1&scope=no-such-item");
  const fallback = await ev(`(() => {
    const el = document.getElementById("ai-ctx");
    return el ? el.textContent.trim() : "";
  })()`);
  if (fallback.length > 0 && fallback.indexOf("null") < 0) ok("认不出的 scope 退回整本台账", fallback);
  else bad("认不出的 scope 退回整本台账", fallback);

  await sleep(200);
  eq("全程没有 JS 报错", errors.slice(0, 3), []);
} catch (error) {
  bad("测试执行中断", String((error && error.message) || error));
} finally {
  try {
    ws.close();
  } catch {}
  try {
    edge.kill();
  } catch {}
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

console.log("");
if (fail === 0) console.log(`自检通过：${pass} 项 · 看板 ${BOARD_ID}`);
else {
  console.log(`${pass} 项通过 · ${fail} 项失败`);
  for (const name of fails) console.log("  ✗ " + name);
  process.exitCode = 1;
}