// 用 Edge 的调试协议驱动页面，做真实的交互验收。
// 用法：node scripts/uitest.mjs
// 前置：服务已经在 8790 跑着（脚本自己会起 Edge）。

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(HERE, "..");

// 看板目录：数据（dist/ledger）在这儿，脚本在模板那儿（项目里是转发入口）。
function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
const ROOT = argValue("board") || process.env.OPS_BOARD_DIR || TEMPLATE_ROOT;
const OUT = join(ROOT, ".uitest");
const PORT = 9222;
const URL_BASE = process.env.OPS_BOARD_URL || "http://127.0.0.1:8790/";

// ask.enabled=false 的看板没有面板、没有入口按钮，涉及「问 AI」的几十条断言
// 全部无从谈起。读一次配置，关闭时只验「页面不崩、按钮不残留」那几条，
// 其余整段跳过 —— 否则关掉问 AI 的看板根本跑不了自检。
const CONFIG_PATH = join(ROOT, "board.config.json");
const ASK_OFF = (() => {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return Boolean(c.ask && c.ask.enabled === false);
  } catch {
    return false;
  }
})();

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));

if (!EDGE) {
  console.error("找不到 msedge.exe，没法做交互验收。");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const profile = join(OUT, "profile");
try {
  rmSync(profile, { recursive: true, force: true });
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
    `--remote-debugging-port=${PORT}`,
    "--window-size=1500,1200",
    "about:blank",
  ],
  { stdio: "ignore", detached: false }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("连不上 Edge 的调试端口");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.wait = new Map();
    this.errors = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.errors.push(d?.exception?.description || d?.text || "未知异常");
      }
      if (msg.id && this.wait.has(msg.id)) {
        const { resolve, reject } = this.wait.get(msg.id);
        this.wait.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.wait.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.wait.has(id)) {
          this.wait.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "页面脚本报错");
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, name + ".png");
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
const cdp = new Cdp(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

// 注入 Harness 上下文，模拟「在 Harness 里打开这块板」。
//
// 不注入的话页面的 HARNESS 是 null，点「发送」会走「要在 Harness 里打开」那条
// 分支直接 return —— 于是所有真正发出去的内容（上下文拼得对不对）从来没被验证过，
// 条目上下文丢失那个 bug 就是这么一直没被发现的。
//
// 必须在 Page.navigate 之前注册，因为 client.js 第 10 行在脚本加载时就读取它。
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__OPS_HARNESS__ = {
    id: "uitest-board",
    label: "交互验收",
    dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))},
    projectDir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))}
  };`,
});

const problems = [];
const shots = [];

async function goto(url, wait = 900) {
  await cdp.send("Page.navigate", { url });
  await sleep(wait);
}

async function check(label, ok, detail) {
  if (!ok) problems.push(`${label}${detail ? " — " + detail : ""}`);
  console.log(`  ${ok ? "✓" : "×"} ${label}${detail ? "  " + detail : ""}`);
}

console.log("\n〔1〕首屏");
await goto(URL_BASE, 1400);

const boot = await cdp.eval(`(function(){
  var active = document.querySelector(".view.is-active");
  return {
    activeView: active ? active.dataset.view : null,
    viewCount: document.querySelectorAll(".view").length,
    cardCount: document.querySelectorAll(".card").length,
    hasRail: !!document.querySelector(".rail"),
    hasToggle: !!document.querySelector(".rail > #rail-toggle"),
    navActive: (document.querySelector(".nav a.active")||{}).textContent || null,
    title: document.title
  };
})()`);
await check("首屏自动落到总览", boot.activeView === "overview", `当前=${boot.activeView}`);
await check("导航高亮跟上了", boot.navActive === "总览", `高亮=${boot.navActive}`);
await check("收起按钮是侧栏的第一个子元素", boot.hasToggle === true);
shots.push(await cdp.shot("01-first"));

console.log("\n〔2〕侧栏收起 / 展开");
const before = await cdp.eval(
  `getComputedStyle(document.querySelector(".rail")).display`
);
await cdp.eval(`document.getElementById("rail-toggle").click()`);
await sleep(400);
const collapsed = await cdp.eval(`(function(){
  var r=document.querySelector(".rail");
  var b=document.getElementById("rail-toggle");
  var body=document.getElementById("rail-body");
  var rb=b.getBoundingClientRect();
  var rr=r.getBoundingClientRect();
  return {
    bodyDisplay: getComputedStyle(body).display,
    expanded: b.getAttribute("aria-expanded"),
    label: (getComputedStyle(b,"::before").content||"").replace(/["']/g,""),
    cols: getComputedStyle(document.querySelector(".layout")).gridTemplateColumns,
    btnW: Math.round(rb.width),
    btnH: Math.round(rb.height),
    gapRight: Math.round(rr.right - rb.right),
    centerOfRail: Math.round((rb.top + rb.height/2) - (rr.top + rr.height/2)),
    railH: Math.round(rr.height),
    extraBtn: !!document.querySelector(".topbar [data-rail-toggle], .nav [data-rail-toggle]"),
    saved: localStorage.getItem("ops-board-rail")
  };
})()`);
await check("收起后索引内容隐藏", collapsed.bodyDisplay === "none", `rail-body display=${collapsed.bodyDisplay}`);
await check("按钮没跟着一起消失", collapsed.btnW > 0 && collapsed.btnH > 0, `${collapsed.btnW}×${collapsed.btnH}`);
await check("按钮文字翻成「展开」", collapsed.label.indexOf("展开") > -1, `“${collapsed.label}”`);
await check("侧栏留 50px 窄条给按钮站", collapsed.cols.indexOf("50px") > -1, collapsed.cols);
await check("按钮贴在侧栏右边缘（跟原版同位置）", Math.abs(collapsed.gapRight) <= 1, `差 ${collapsed.gapRight}px`);
await check(
  "按钮在侧栏这一列里垂直居中（原版 top:50%）",
  Math.abs(collapsed.centerOfRail) <= 2,
  `偏离本列中线 ${collapsed.centerOfRail}px · 列高 ${collapsed.railH}px`
);
await check("顶栏 / 导航没有额外开关", collapsed.extraBtn === false);
await check("状态写进本机", collapsed.saved === "1");
shots.push(await cdp.shot("02-rail-collapsed"));

// 刷新后应该记得
await goto(URL_BASE, 1200);
const remembered = await cdp.eval(`document.querySelector(".page").classList.contains("rail-collapsed")`);
await check("刷新后记得上次的状态", remembered === true);

// 滚到页面中部：按钮跟侧栏一起 sticky，应该还在原处
await cdp.eval(`window.scrollTo(0, 600)`);
await sleep(300);
const stillThere = await cdp.eval(`(function(){
  var b=document.getElementById("rail-toggle");
  var r=b.getBoundingClientRect();
  return r.width>0 && r.top>0 && r.bottom<innerHeight && Math.abs((r.top+r.height/2)-innerHeight/2)<80;
})()`);
await check("滚到中间，按钮还在中间那条线上", stillThere === true);
await cdp.eval(`document.getElementById("rail-toggle").click()`);
await sleep(400);
const expanded = await cdp.eval(`(function(){
  var b=document.getElementById("rail-toggle");
  return {
    body:getComputedStyle(document.getElementById("rail-body")).display,
    label:(getComputedStyle(b,"::before").content||"").replace(/["']/g,""),
    saved:localStorage.getItem("ops-board-rail")
  };
})()`);
await check("在页面中部也能展开", expanded.body !== "none" && expanded.label.indexOf("收起") > -1 && expanded.saved === "0", `索引=${expanded.body} 按钮=“${expanded.label}”`);
await cdp.eval(`window.scrollTo(0,0)`);
await sleep(300);
shots.push(await cdp.shot("03-rail-expanded"));

console.log("\n〔2b〕侧栏「收起明细」");
const railHeight = await cdp.eval(`(function(){
  var body=document.getElementById("rail-body");
  var rb=body.getBoundingClientRect();
  var st=getComputedStyle(body);
  return {h:Math.round(rb.height), viewport:innerHeight, css:st.height, overflow:st.overflowY};
})()`);
await check(
  "侧栏可视高度吃满一屏（减掉的只有顶栏 + 导航）",
  railHeight.h > railHeight.viewport - 130,
  `侧栏 ${railHeight.h}px / 视口 ${railHeight.viewport}px（css=${railHeight.css}）`
);
await check("侧栏仍然是内部滚动，不撑高整页", railHeight.overflow === "auto");

const miniState = await cdp.eval(`(function(){
  var btns = Array.from(document.querySelectorAll(".rail-mini-toggle"));
  return btns.map(function(b){
    var list=document.getElementById(b.getAttribute("aria-controls"));
    return {
      text: b.textContent,
      controls: b.getAttribute("aria-controls"),
      hasList: !!list,
      visible: list ? !list.hasAttribute("hidden") : false
    };
  });
})()`);
await check(
  "每块明细都有一个「收起明细」按钮，且指向真实列表",
  miniState.length >= 2 && miniState.every((m) => m.hasList && m.text === "收起明细"),
  miniState.map((m) => m.controls).join(", ")
);
await check("默认是展开的", miniState.every((m) => m.visible === true));

const foldOne = await cdp.eval(`(function(){
  var b = document.querySelector(".rail-mini-toggle");
  var list = document.getElementById(b.getAttribute("aria-controls"));
  var id = list.id;
  var before = !list.hasAttribute("hidden");
  b.click();
  var st = getComputedStyle(list);
  return {
    id: id,
    before: before,
    hidden: list.hasAttribute("hidden"),
    display: st.display,
    text: b.textContent,
    expanded: b.getAttribute("aria-expanded"),
    saved: localStorage.getItem("ops-mini-" + id)
  };
})()`);
await check(
  "点一下只收明细列表，阶段格子还在",
  foldOne.before === true && foldOne.hidden === true && foldOne.display === "none",
  `${foldOne.id} display=${foldOne.display}`
);
await check(
  "文案翻成「展开明细」",
  foldOne.text === "展开明细" && foldOne.expanded === "false",
  `按钮=“${foldOne.text}”`
);
await check("收起状态按原版键名写进本机", foldOne.saved === "1", `ops-mini-${foldOne.id}=${foldOne.saved}`);
shots.push(await cdp.shot("03b-rail-folded"));

await goto(URL_BASE, 1200);
const foldRemembered = await cdp.eval(`(function(){
  var b = document.querySelector(".rail-mini-toggle");
  var list = document.getElementById(b.getAttribute("aria-controls"));
  return {hidden: list.hasAttribute("hidden"), text: b.textContent};
})()`);
await check(
  "刷新后那块明细还是收着的",
  foldRemembered.hidden === true && foldRemembered.text === "展开明细",
  `hidden=${foldRemembered.hidden} 按钮=“${foldRemembered.text}”`
);

const unfold = await cdp.eval(`(function(){
  var b = document.querySelector(".rail-mini-toggle");
  var list = document.getElementById(b.getAttribute("aria-controls"));
  b.click();
  return {
    hidden: list.hasAttribute("hidden"),
    display: getComputedStyle(list).display,
    text: b.textContent,
    saved: localStorage.getItem("ops-mini-" + list.id)
  };
})()`);
await check(
  "再点一下能展开",
  unfold.hidden === false && unfold.display !== "none" && unfold.text === "收起明细" && unfold.saved === "0"
);

console.log("\n〔2c〕处理记录按类型筛选");
await cdp.eval(`location.hash = "#view-overview"`);
await sleep(500);
const filterBar = await cdp.eval(`(function(){
  var bar = document.querySelector("[data-history-filter]");
  if (!bar) return {ok:false};
  var chips = Array.from(bar.querySelectorAll(".kind-chip"));
  return {
    ok: true,
    chips: chips.map(function(c){ return {kind:c.getAttribute("data-kind"), text:c.textContent.trim(), active:c.classList.contains("is-active")} }),
    total: document.querySelectorAll("[data-history-section] .timeline > li").length
  };
})()`);
await check("总览的处理记录有类型筛选条", filterBar.ok === true && filterBar.chips.length > 1, filterBar.ok ? filterBar.chips.map((c) => c.kind).join(", ") : "没有");
await check("「全部」默认选中", filterBar.chips[0] && filterBar.chips[0].kind === "all" && filterBar.chips[0].active === true);

const oneKind = filterBar.chips.find((c) => c.kind !== "all");
const filtered = await cdp.eval(`(function(){
  var bar = document.querySelector("[data-history-filter]");
  var chip = bar.querySelector('[data-kind="${oneKind && oneKind.kind}"]');
  chip.click();
  var sec = document.querySelector("[data-history-section]");
  var items = Array.from(sec.querySelectorAll(".timeline > li"));
  var visible = items.filter(function(li){ return getComputedStyle(li).display !== "none"; });
  return {
    visible: visible.length,
    total: items.length,
    allSameKind: visible.every(function(li){ return li.getAttribute("data-kind") === "${oneKind && oneKind.kind}"; }),
    active: chip.classList.contains("is-active"),
    othersOff: Array.from(bar.querySelectorAll(".kind-chip")).filter(function(c){ return c!==chip; }).every(function(c){ return !c.classList.contains("is-active"); }),
    sub: (sec.querySelector(".history-sub")||{}).textContent || ""
  };
})()`);
await check(
  `点「${oneKind && oneKind.kind}」只留该类记录`,
  filtered.visible > 0 && filtered.visible < filtered.total && filtered.allSameKind === true,
  `显示 ${filtered.visible} / ${filtered.total}`
);
await check("被点的标签高亮、其它熄灭", filtered.active === true && filtered.othersOff === true);
await check("标题右侧改成「显示 N / M 条」", /显示 \d+ \/ \d+ 条/.test(filtered.sub), `“${filtered.sub}”`);
shots.push(await cdp.shot("03c-history-filter"));

const restored = await cdp.eval(`(function(){
  var bar = document.querySelector("[data-history-filter]");
  var all = bar.querySelector('[data-kind="all"]');
  all.click();
  var sec = document.querySelector("[data-history-section]");
  var items = Array.from(sec.querySelectorAll(".timeline > li"));
  return {
    visible: items.filter(function(li){ return getComputedStyle(li).display !== "none"; }).length,
    total: items.length,
    sub: (sec.querySelector(".history-sub")||{}).textContent || "",
    def: (sec.querySelector(".history-sub")||{}).getAttribute("data-default") || ""
  };
})()`);
await check(
  "点「全部」恢复所有记录，说明文字回到原文",
  restored.visible === restored.total && restored.sub === restored.def,
  `${restored.visible} / ${restored.total}`
);

console.log("\n〔2d〕阶段格子当筛选器");
await cdp.eval(`location.hash = "#view-lane-bug"`);
await sleep(600);
const stageFilter = await cdp.eval(`(function(){
  var cells = Array.from(document.querySelectorAll(".view.is-active .stage-board-cell"));
  if (!cells.length) return {ok:false};
  var cell = cells[0];
  var href = cell.getAttribute("href");
  cell.click();
  var main = document.querySelector(".view.is-active .details-main");
  var kept = main.querySelectorAll(".detail-group.is-stage-keep").length;
  var hiddenBlocks = Array.from(main.children).filter(function(c){
    return getComputedStyle(c).display === "none";
  }).length;
  var hint = (main.querySelector(".stage-filter-hint")||{}).textContent || "";
  var lit = document.querySelectorAll(".is-stage-filter").length;
  return {ok:true, href:href, kept:kept, hiddenBlocks:hiddenBlocks, hint:hint, lit:lit};
})()`);
await check("点阶段格子只留这一阶段", stageFilter.ok && stageFilter.kept === 1 && stageFilter.hiddenBlocks > 0, `保留 ${stageFilter.kept} 组 · 收起 ${stageFilter.hiddenBlocks} 块`);
await check("格子点亮并给出提示", stageFilter.lit > 0 && /只看「.+」· 再点这一格恢复全部/.test(stageFilter.hint), `“${stageFilter.hint}”`);
shots.push(await cdp.shot("03d-stage-filter"));

const stageRestored = await cdp.eval(`(function(){
  var cell = document.querySelector(".view.is-active .stage-board-cell.is-stage-filter") || document.querySelector(".view.is-active .stage-board-cell");
  cell.click();
  var main = document.querySelector(".view.is-active .details-main");
  return {
    filtered: main.classList.contains("is-stage-filtered"),
    kept: main.querySelectorAll(".detail-group.is-stage-keep").length,
    hint: !!main.querySelector(".stage-filter-hint")
  };
})()`);
await check("再点同一格恢复全部", stageRestored.filtered === false && stageRestored.kept === 0 && stageRestored.hint === false);

console.log("\n〔2e〕侧栏整节折叠");
const foldState = await cdp.eval(`(function(){
  var fold = document.querySelector(".rail-fold");
  if (!fold) return {ok:false};
  var panel = fold.closest(".panel");
  var body = document.getElementById(fold.getAttribute("aria-controls"));
  var before = getComputedStyle(body).display;
  fold.click();
  return {
    ok: true,
    before: before,
    after: getComputedStyle(body).display,
    collapsed: panel.classList.contains("is-collapsed"),
    expanded: fold.getAttribute("aria-expanded"),
    label: fold.getAttribute("aria-label")
  };
})()`);
await check("点标题左侧箭头折叠整节", foldState.ok && foldState.before !== "none" && foldState.after === "none" && foldState.collapsed === true);
await check("箭头 aria 翻成「展开」", foldState.expanded === "false" && /^展开 /.test(foldState.label || ""), `“${foldState.label}”`);

const foldBack = await cdp.eval(`(function(){
  var fold = document.querySelector(".rail-fold");
  var panel = fold.closest(".panel");
  var body = document.getElementById(fold.getAttribute("aria-controls"));
  fold.click();
  return {display: getComputedStyle(body).display, collapsed: panel.classList.contains("is-collapsed")};
})()`);
await check("再点一下展开回来", foldBack.display !== "none" && foldBack.collapsed === false);

console.log("\n〔2f〕侧栏标题排版（不被计数挤扁）");
const heads = await cdp.eval(`(function(){
  var list = Array.from(document.querySelectorAll(".rail .panel > h3"));
  return list.map(function(h){
    var jump=h.querySelector(".rail-head-jump");
    var title=h.querySelector(".rail-title");
    var counts=h.querySelector(".rail-counts");
    var hr=h.getBoundingClientRect();
    var tr=title?title.getBoundingClientRect():null;
    var cr=counts?counts.getBoundingClientRect():null;
    return {
      text:(title?title.textContent:"").trim(),
      headW:Math.round(hr.width), headH:Math.round(hr.height),
      titleW:tr?Math.round(tr.width):0,
      titleH:tr?Math.round(tr.height):0,
      countsW:cr?Math.round(cr.width):0,
      wrap: jump ? getComputedStyle(jump).flexWrap : "none"
    };
  });
})()`);
const badHeads = heads.filter((h) => h.titleW < 20 || h.titleH > 44 || h.countsW < 20);
await check(
  "每个标题都占得住宽度（没被挤成一列字）",
  heads.length >= 3 && badHeads.length === 0,
  badHeads.length ? badHeads.map((h) => `${h.text}:${h.titleW}×${h.titleH}`).join(" · ") : `${heads.length} 个标题`
);
await check(
  "标题容器允许换行（窄侧栏时计数掉到下一行）",
  heads.every((h) => h.wrap === "wrap"),
  heads[0] ? heads[0].wrap : "-"
);

console.log("\n〔2g〕Skill 统计是独立一页");
const hasSkillsLink = await cdp.eval(`(function(){
  var link = Array.from(document.querySelectorAll(".nav a[data-view]")).find(function(a){ return a.textContent.indexOf("Skill") > -1; });
  if (!link) return null;
  link.click();
  return link.getAttribute("href");
})()`);
await sleep(600); // hashchange 是异步的，等一帧再读状态
const skillsPage = await cdp.eval(`(function(){
  var view = document.querySelector('.view[data-view="skills"]');
  var groups = Array.from(view ? view.querySelectorAll('section[data-skill-group]') : []);
  var inOverview = document.querySelector('.view[data-view="overview"] .skill-row');
  var active = document.querySelector(".view.is-active");
  return {
    active: active && active.dataset ? active.dataset.view : null,
    hash: location.hash,
    groups: groups.length,
    anchors: groups.map(function(g){ return g.id; }),
    rows: document.querySelectorAll('section[data-skill-group] .skill-row').length,
    inOverview: !!inOverview,
    visible: view ? getComputedStyle(view).display !== "none" : false
  };
})()`);
await check(
  "导航能进 Skill 统计页",
  Boolean(hasSkillsLink) && skillsPage.active === "skills" && skillsPage.hash === "#view-skills" && skillsPage.visible === true,
  `视图=${skillsPage.active} hash=${skillsPage.hash}`,
);
await check("三组都在（会话里用过的 / 项目产出的 / 为它写的）", skillsPage.groups === 3, skillsPage.anchors.join(", "));
await check("总览页里不再有 skill 条目", skillsPage.inOverview === false);
shots.push(await cdp.shot("03e-skills-page"));

// 三个统计格子点进去必须还留在 Skill 页（以前会掉回总览）
const groupJumps = [];
for (const anchor of ["skill-group-used", "skill-group-produced", "skill-group-related"]) {
  await cdp.eval(`location.hash = "#view-skills"`);
  await sleep(400);
  const jump = await cdp.eval(`(function(){
    var a = document.querySelector('.view[data-view="skills"] a[href="#${anchor}"]');
    if (!a) return {ok:false};
    a.click();
    return {ok:true, hash: location.hash};
  })()`);
  await sleep(600);
  const landed = await cdp.eval(`(function(){
    var active = document.querySelector('.view.is-active');
    var el = document.getElementById('${anchor}');
    var r = el ? el.getBoundingClientRect() : null;
    return {
      hash: location.hash,
      active: active && active.dataset ? active.dataset.view : null,
      top: r ? Math.round(r.top) : null,
      visible: r ? (r.top > -120 && r.top < 900) : false
    };
  })()`);
  groupJumps.push({ anchor, jump, landed });
}
const badJumps = groupJumps.filter((g) => !g.jump.ok || g.landed.active !== "skills" || g.landed.visible !== true);
await check(
  "Skill 页三个格子点进去还留在 Skill 页",
  badJumps.length === 0,
  badJumps.length
    ? badJumps.map((g) => `${g.anchor}→${g.landed.active}@${g.landed.top}`).join(" · ")
    : groupJumps.map((g) => `${g.anchor}@${g.landed.top}`).join(" · "),
);

console.log("\n〔2h〕Skill 页的「问 AI」");
if (ASK_OFF) {
  console.log("  （这块看板关掉了问 AI，本节跳过）");
} else {
await cdp.eval(`location.hash = "#view-skills"`);
await sleep(600);
const skillAskOne = await cdp.eval(`(function(){
  var btn = document.querySelector("[data-ask-skill]");
  if (!btn) return {ok:false};
  var name = btn.getAttribute("data-ask-skill");
  btn.click();
  var first = document.querySelector("#ai-quick button");
  return {
    ok: true,
    name: name,
    open: document.getElementById("ai-panel").classList.contains("is-open"),
    ctx: (document.getElementById("ai-ctx")||{}).textContent || "",
    quick: Array.from(document.querySelectorAll("#ai-quick button")).map(function(b){ return b.textContent; }),
    firstPrompt: first ? first.title : "",
    empty: (document.querySelector(".ai-empty")||{}).textContent || ""
  };
})()`);

// 有些看板本来就没有 skill（比如模板自己）：这不算失败，跳过这一段。
// 但「整页 skill」那套动作仍然要能验 —— 它在没 skill 时也渲染得出来。
if (!skillAskOne.ok) {
  console.log("  – 这块板没有 skill 条目，跳过单条 skill 的检查");
} else {
  await check("每条 skill 都有「问 AI」，点了能打开面板", skillAskOne.ok && skillAskOne.open === true, `skill=${skillAskOne.name}`);
  await check("面板上下文是这条 skill", String(skillAskOne.ctx).indexOf("Skill · ") === 0, `“${skillAskOne.ctx}”`);
  for (const label of ["总结并更新这一个", "只总结，不改文件", "查它和其它 skill 的冲突", "查它缺什么", "查它有没有该删的"]) {
    if (skillAskOne.quick.indexOf(label) === -1) {
      await check(`单条 skill 的动作「${label}」`, false, skillAskOne.quick.join(" / "));
    }
  }
  await check("单条 skill 用自己那套动作（不是整页那套）", skillAskOne.quick.length === 5 && skillAskOne.quick.indexOf("更新所有 Skill") === -1, skillAskOne.quick.join(" / "));
  await check(
    "单条 skill 的 prompt 明确限定只改这一个文件",
    /只处理这一个 SKILL\.md/.test(skillAskOne.firstPrompt) && /不要读改同目录的其它 skill/.test(skillAskOne.firstPrompt),
    skillAskOne.firstPrompt.slice(0, 40) + "…",
  );
}

const wholeSkills = await cdp.eval(`(function(){
  document.getElementById("ai-close").click();
  var btn = document.querySelector("[data-ask-skills]");
  if (!btn) return {ok:false};
  btn.click();
  var first = document.querySelector("#ai-quick button");
  return {
    ok: true,
    ctx: (document.getElementById("ai-ctx")||{}).textContent || "",
    quick: Array.from(document.querySelectorAll("#ai-quick button")).map(function(b){ return b.textContent; }),
    firstPrompt: first ? first.title : ""
  };
})()`);
await check("整页也有入口，上下文是「整页 Skill」", wholeSkills.ok && wholeSkills.ctx === "整页 Skill", `“${wholeSkills.ctx}”`);
await check(
  "整页用自己那套动作（含「更新所有 Skill」）",
  wholeSkills.quick.indexOf("更新所有 Skill") === 0 && wholeSkills.quick.indexOf("总结并更新这一个") === -1,
  wholeSkills.quick.join(" / "),
);
await check(
  "整页的第一个动作确实是",
  /全部 SKILL\.md/.test(wholeSkills.firstPrompt),
  wholeSkills.firstPrompt.slice(0, 32) + "…",
);
if (skillAskOne.ok) {
  await check(
    "两套动作不共用：单条有「总结并更新这一个」，整页有「更新所有 Skill」",
    skillAskOne.quick.indexOf("总结并更新这一个") > -1 &&
      skillAskOne.quick.indexOf("更新所有 Skill") === -1 &&
      wholeSkills.quick.indexOf("更新所有 Skill") > -1 &&
      wholeSkills.quick.indexOf("总结并更新这一个") === -1,
  );
} else {
  console.log("  – 没有单条 skill，跳过「两套动作不共用」的交叉检查");
}

const picked = await cdp.eval(`(function(){
  var b = Array.from(document.querySelectorAll("#ai-quick button")).find(function(x){ return x.textContent.indexOf("冲突") > -1; });
  b.click();
  return { input: document.getElementById("ai-input").value, hint: (document.getElementById("ai-hint")||{}).textContent || "" };
})()`);
await check("点动作只填进输入框，不自动发送", picked.input.indexOf("冲突") > -1 && /点「发送」/.test(picked.hint), `hint=“${picked.hint}”`);

// 回到台账条目：作用域不能串味
const backToItem = await cdp.eval(`(function(){
  document.getElementById("ai-close").click();
  location.hash = "#view-overview";
  return true;
})()`);
await sleep(600);
const itemScope = await cdp.eval(`(function(){
  var b = document.querySelector("[data-ask]");
  b.click();
  return {
    ctx: (document.getElementById("ai-ctx")||{}).textContent || "",
    quick: Array.from(document.querySelectorAll("#ai-quick button")).map(function(x){ return x.textContent; })
  };
})()`);
await check(
  "切回台账条目后，快捷动作回到条目那套（没被 skill 污染）",
  itemScope.quick.indexOf("现在什么情况") > -1 &&
    (!skillAskOne.ok || skillAskOne.quick.indexOf("现在什么情况") === -1),
  itemScope.quick.join(" / ")
);

// 真发一次，拦住「发出去的上下文里没有这一条」这种事。
// 之前点某条的「问 AI」，发出去的是「范围：本页全部 Skill（共 0 个）」加一句
// 「skill 文件是 SKILL.md」，那条台账的编号、标题、四段、证据一个字都没带上 ——
// 而这里以前只验了快捷动作的标签，所以一直没被发现。
//
// 拦截和读取放在同一次 eval 里，因为跨 eval 拿不到闭包里的变量。
const wired = await cdp.eval(`(function(){
  var D = JSON.parse(document.getElementById("board-data").textContent);
  // 用页面上真实存在的第一个按钮，别拿 items 的键去猜 —— 两者顺序不一定一致
  var btn = document.querySelector("[data-ask]");
  var itemId = btn ? btn.getAttribute("data-ask") : null;
  var it = itemId ? D.items[itemId] : null;
  var sent = null;
  var orig = window.fetch;
  window.fetch = function(u, o){
    if (String(u).indexOf("/ops-board/ask") > -1) {
      try { sent = JSON.parse(o.body).question; } catch (e) { sent = ""; }
      window.__opsSent = sent;
      window.fetch = orig;
      return Promise.resolve({ json: function(){ return Promise.resolve({ ok: true }); } });
    }
    return orig.apply(this, arguments);
  };
  if (btn) btn.click();
  var input = document.getElementById("ai-input");
  if (input) input.value = "这条现在什么情况";
  var sendBtn = document.getElementById("ai-send");
  if (sendBtn) sendBtn.click();
  return { id: itemId, title: it ? it.title : "" };
})()`);
// send() 里 fetch 是同步发起的（拦截器同步拿到 body），所以等一拍就够。
await sleep(700);
const sentText = await cdp.eval(`(function(){ return window.__opsSent || ""; })()`);
await check(
  "点条目「问 AI」时，发出去的上下文带上了这一条的编号和标题",
  Boolean(wired.id) && sentText.indexOf("【" + wired.id + "】" + wired.title) > -1,
  sentText ? "发出 " + sentText.length + " 字" : "没拦到 /ops-board/ask 的请求"
);
await check(
  "点条目「问 AI」时，上下文不再说「本页全部 Skill」",
  sentText.indexOf("本页全部 Skill") === -1,
  sentText ? "（已带条目内容）" : "没拦到请求"
);
await check(
  "点条目「问 AI」时，带上了四段记录和证据",
  sentText.indexOf("四段记录") > -1 && sentText.indexOf("留下的证据") > -1,
  sentText ? "" : "没拦到请求"
);
await check(
  "点条目「问 AI」时，带上了回答规则（ask.systemPrompt 不是摆设）",
  sentText.indexOf("【回答规则】") > -1 && sentText.indexOf("不要编造数字") > -1,
  sentText ? "" : "没拦到请求"
);
}

console.log("\n〔3〕导航跳转");
const navViews = await cdp.eval(`Array.from(document.querySelectorAll(".nav a[data-view]")).map(function(a){return {label:a.textContent, href:a.getAttribute("href")}})`);
for (const nv of navViews) {
  await cdp.eval(`document.querySelector('.nav a[href="${nv.href}"]').click()`);
  await sleep(450);
  const got = await cdp.eval(`(function(){
    var v=document.querySelector(".view.is-active");
    var a=document.querySelector(".nav a.active");
    return {view: v?v.dataset.view:null, nav: a?a.textContent:null, hash: location.hash};
  })()`);
  const wantId = nv.href.slice(1);
  await check(`导航「${nv.label}」`, got.hash === nv.href, `hash=${got.hash} 视图=${got.view} 高亮=${got.nav}`);
}
shots.push(await cdp.shot("04-nav-closed"));

console.log("\n〔4〕跨视图跳转（总览表格里的编号 → 车道页的卡片）");
await cdp.eval(`location.hash = "#view-overview"`);
await sleep(500);
const jump = await cdp.eval(`(function(){
  var a = document.querySelector('.view.is-active td.title-cell a');
  if (!a) return {skip:true};
  var target = a.getAttribute("href").slice(1);
  a.click();
  return {target: target};
})()`);
await sleep(800);
const landed = await cdp.eval(`(function(){
  var el = document.getElementById(${JSON.stringify(jump.target || "")});
  var v = document.querySelector(".view.is-active");
  var r = el ? el.getBoundingClientRect() : null;
  return {
    view: v?v.dataset.view:null,
    inViewport: !!r && r.top > -80 && r.top < window.innerHeight,
    top: r ? Math.round(r.top) : null,
    scrolled: Math.round(window.scrollY)
  };
})()`);
await check(`点编号 ${jump.target} 跳到对应车道`, landed.view && landed.view !== "overview", `落到=${landed.view}`);
await check("落在可视范围内", landed.inViewport === true, `距顶 ${landed.top}px，滚动 ${landed.scrolled}px`);
shots.push(await cdp.shot("05-jump-to-card"));

console.log("\n〔5〕侧栏标题点进车道页");
await cdp.eval(`location.hash = "#view-overview"; window.scrollTo(0,0)`);
await sleep(500);
const railNav = await cdp.eval(`(function(){
  var a = document.querySelector(".rail-title-link");
  if (!a) return {skip:true};
  var href = a.getAttribute("href");
  a.click();
  return {href: href, text: a.textContent.trim()};
})()`);
await sleep(600);
const railLanded = await cdp.eval(`location.hash`);
await check(`侧栏标题「${railNav.text || "-"}」→ ${railNav.href}`, railLanded === railNav.href, `实际=${railLanded}`);

console.log("\n〔6〕浏览器后退");
await cdp.eval(`history.back()`);
await sleep(700);
const backed = await cdp.eval(`(function(){
  var v=document.querySelector(".view.is-active");
  var a=document.querySelector(".nav a.active");
  return {view: v?v.dataset.view:null, nav: a?a.textContent:null};
})()`);
await check("后退能回到上一页", !!backed.view, `回到=${backed.view} 高亮=${backed.nav}`);

console.log("\n〔7〕同一锚点连点两次");
await cdp.eval(`location.hash = "#view-lane-bug"`);
await sleep(600);
const stageHref = await cdp.eval(
  `(function(){var a=document.querySelector('.view.is-active a[href^="#stage-"]');return a?a.getAttribute("href"):null})()`
);
if (!stageHref) {
  await check("车道页有分节锚点", false, "找不到 #stage- 链接");
} else {
  await cdp.eval(`document.querySelector('.view.is-active a[href="${stageHref}"]').click()`);
  await sleep(700);
  const first = await cdp.eval(`Math.round(window.scrollY)`);
  await cdp.eval(`window.scrollTo(0,0)`);
  await sleep(250);
  await cdp.eval(`document.querySelector('.view.is-active a[href="${stageHref}"]').click()`);
  await sleep(800);
  const twice = await cdp.eval(`Math.round(window.scrollY)`);
  await check("第一次点分节能滚过去", first > 30, `滚动 ${first}px（${stageHref}）`);
  await check("第二次点同一锚点仍然滚过去", twice > 30, `滚动 ${twice}px`);
}

console.log("\n〔8〕三套主题");
await cdp.eval(`window.scrollTo(0,0)`);
await sleep(300);
for (const t of ["paper", "eye", "night"]) {
  await cdp.eval(`document.querySelector('.theme-swatch[data-theme="${t}"]').click()`);
  await sleep(300);
  const got = await cdp.eval(`document.documentElement.getAttribute("data-theme") || "night"`);
  await check(`主题「${t}」`, got === t, got === t ? "" : `实际=${got}`);
  shots.push(await cdp.shot(`06-theme-${t}`));
}

console.log("\n〔10〕卡片的「问 AI」能打开面板");
if (ASK_OFF) {
  // 关掉问 AI 时，页面上不该留任何入口，点也不该炸。
  const off = await cdp.eval(`(function(){
    return {
      panel: !!document.getElementById("ai-panel"),
      btns: document.querySelectorAll("[data-ask],[data-ask-skill],[data-ask-skills],[data-ask-global]").length
    };
  })()`);
  await check("关掉问 AI 后，页面上没有面板", off.panel === false);
  await check("关掉问 AI 后，页面上没有入口按钮", off.btns === 0, `还剩 ${off.btns} 个`);
  await check("关掉问 AI 后，页面不抛错", cdp.errors.length === 0, cdp.errors.length ? cdp.errors[0].split("\n")[0] : "");
} else {
await cdp.eval(`location.hash = "#view-lane-bug"`);
await sleep(600);
const opened = await cdp.eval(`(function(){
  var b=document.querySelector('.view.is-active [data-ask]');
  if(!b) return {skip:true};
  b.click();
  return {id: b.getAttribute("data-ask")};
})()`);
await sleep(700);
const panelState = await cdp.eval(`(function(){
  var p=document.getElementById("ai-panel");
  return {open: p ? p.classList.contains("is-open") : false, ctx: (document.getElementById("ai-ctx")||{}).textContent || ""};
})()`);
await check(`点「问 AI」打开面板（${opened.id || "-"}）`, panelState.open === true, panelState.open ? `上下文=${panelState.ctx}` : "面板没打开");
await cdp.eval(`document.getElementById("ai-close").click()`);
await sleep(300);
}

console.log("\n〔11〕窄窗口（900px）");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 900,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await cdp.eval(`location.hash = "#view-overview"; window.scrollTo(0,0)`);
await sleep(800);
const narrow = await cdp.eval(`(function(){
  var nav=document.querySelector(".nav");
  var links=document.querySelectorAll(".nav a[data-view]");
  var navRects=Array.from(links).map(function(a){return Math.round(a.getBoundingClientRect().top)});
  var sameRow = new Set(navRects).size === 1;
  return {
    sameRow: sameRow,
    toggleHidden: getComputedStyle(document.getElementById("rail-toggle")).display === "none",
    railBodyShown: getComputedStyle(document.getElementById("rail-body")).display !== "none",
    railShown: getComputedStyle(document.querySelector(".rail")).display !== "none",
    cols: getComputedStyle(document.querySelector(".layout")).gridTemplateColumns,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  };
})()`);
await check("导航没被挤成两行", narrow.sameRow === true);
await check("窄屏不出现横向滚动条", narrow.overflowX <= 0, `溢出 ${narrow.overflowX}px`);
await check("窄屏布局转单列", !narrow.cols.includes("270px"), narrow.cols);
await check("窄屏不出现收起按钮", narrow.toggleHidden === true);
await check("窄屏索引始终可见（不被上次的收起状态带走）", narrow.railShown === true && narrow.railBodyShown === true);
shots.push(await cdp.shot("07-narrow"));
await cdp.send("Emulation.clearDeviceMetricsOverride", {});

console.log("\n〔12〕换个源打开（模拟被别的预览服务托管）");
if (ASK_OFF) {
  console.log("  （这块看板关掉了问 AI，本节跳过）");
} else {
// 用户可能是从预览面板打开这页的 —— 那时源不是 8790，/api/* 在那台服务器上根本不存在。
// 以前的表现是一句 NetworkError；现在应该自动改走本机 8790。
const OTHER = createServer((req, res) => {
  // 像个真的静态预览服务：页面给，接口一律 404
  if (String(req.url).startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(join(ROOT, "dist", "index.html")));
});
await new Promise((r) => OTHER.listen(8799, "127.0.0.1", r));

await goto("http://127.0.0.1:8799/", 1500);
// 像用户一样把面板点开，截图才有说服力。
// 这一节测的是「页面被别的静态服务托管时还能不能用」——那种服务器没有 /api/*，
// 也没有 Harness 注入，所以只断言页面本身活着，不假设它认得 Harness。
await cdp.eval(`location.hash = "#view-lane-bug"`);
await sleep(600);
await cdp.eval(`(function(){ var b=document.querySelector(".view.is-active [data-ask]"); if(b) b.click(); return !!b; })()`);
await sleep(900);

const cross = await cdp.eval(`(function(){
  var hint = (document.getElementById("ai-hint") || {}).textContent || "";
  return {
    port: location.port,
    panelOpen: document.getElementById("ai-panel").classList.contains("is-open"),
    quick: Array.from(document.querySelectorAll("#ai-quick button")).map(function(b){ return b.textContent; }),
    ctx: (document.getElementById("ai-ctx")||{}).textContent || "",
    cardCount: document.querySelectorAll(".view.is-active .card").length,
    hint: hint,
    machineTalk: /NetworkError|Failed to fetch/i.test(document.body.innerText)
  };
})()`);
await check("换源打开时页面照常渲染出卡片", cross.cardCount > 0, `端口 ${cross.port} · ${cross.cardCount} 张`);
await check("跨源打开面板照样能打开，不是空壳", cross.panelOpen === true);
await check("跨源打开也有快捷动作", cross.quick.length > 0, cross.quick.join(" / "));
await check("上下文落在点的那一条上", cross.ctx.length > 0 && cross.ctx !== "整本台账", `“${cross.ctx}”`);
await check("页面上不再抛 NetworkError 这类机器话", cross.machineTalk === false, cross.hint);
shots.push(await cdp.shot("08-cross-origin"));
OTHER.close();
}

console.log("\n〔9〕控制台有没有报错");
await check("全程页面脚本没抛错", cdp.errors.length === 0, cdp.errors.length ? cdp.errors[0].split("\n")[0] : "");

ws.close();
edge.kill();

console.log("\n截图：");
for (const s of shots) console.log("  " + s.replace(/\\/g, "/"));

if (problems.length) {
  console.log(`\n交互验收未通过，${problems.length} 个问题：`);
  for (const p of problems) console.log("  × " + p);
  process.exit(1);
}
console.log("\n交互验收通过。");
