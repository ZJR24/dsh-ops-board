#!/usr/bin/env node
// scripts/verify-board.mjs — 生成之后的自检。
// 页面是脚本生成的，人眼看不出的错（重复 id、孤儿样式、没闭合的标签）必须靠它拦。
//
// 用法：node scripts/verify-board.mjs [dist/index.html]
// 退出码 0 = 通过，1 = 有问题。

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, "..");

// 看板目录：数据（dist/ledger/config）在这儿，脚本在模板那儿。
function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
const ROOT = resolve(argValue("board") || process.env.OPS_BOARD_DIR || TEMPLATE_ROOT);
// 位置参数只认「以 .html 结尾且存在的文件」：
// 转发器会在最前面塞 --board <dir>，而目录也「存在」，不能拿它当目标。
const positional = process.argv
  .slice(2)
  .find((a) => !a.startsWith("--") && /\.html?$/i.test(a) && existsSync(resolve(a)));
const target = resolve(argValue("target") || positional || join(ROOT, "dist", "index.html"));

if (!existsSync(target)) {
  console.error(`找不到文件：${target}\n先跑 node scripts/render.mjs`);
  process.exit(1);
}

// 配置读一份，用来判断「问 AI 这块到底有没有开」——
// 关掉之后页面本来就不该有面板和按钮，不能用「必须有按钮」去套。
const cfgPath = join(ROOT, "board.config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
const askOff = cfg.ask && cfg.ask.enabled === false;

const html = readFileSync(target, "utf8");
const problems = [];
const notes = [];

// 配置里不该再有没人读的字段。留着它比删掉更糟：改了没效果，还不报错，
// 人会以为是渲染 bug，而不是配置写错了地方。逐个点名，说清去改哪边才有效。
const DEAD_CONFIG_FIELDS = [
  ["sections.defaultLabels", "四段标题来自 ledger.json 每条的 sections[].label，改那边才有用"],
  ["priority.rule", '优先序列固定按 lane.rankBySeverity/severity 排，rule 字段没人读；想改排序改 lane 的 rankBySeverity'],
];
for (const [name, hint] of DEAD_CONFIG_FIELDS) {
  const [a, b] = name.split(".");
  const val = b ? cfg[a] && cfg[a][b] : cfg[a];
  if (val !== undefined) problems.push(`board.config.json 里还有没人读的 ${name}：改了不会有任何效果（${hint}）`);
}

// 1. 结构骨架
for (const needle of [
  'class="page"',
  'class="topbar"',
  'class="masthead"',
  'class="nav"',
  'class="rail"',
  'id="board-data"',
  // 'id="ai-panel"' 不在这个清单里：ask.enabled=false 时它本来就不该有，
  // 由下面第 4 条按开关分开验。
]) {
  if (!html.includes(needle)) problems.push(`缺少关键结构：${needle}`);
}

const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) problems.push("没有内联样式");
const css = styleMatch ? styleMatch[1] : "";
const body = html.slice(html.indexOf("</style>"));

// 2. 报纸体例的关键特征不能丢
for (const [needle, why] of [
  ["4px double", "报头双线"],
  ["repeating-linear-gradient", "纸面纹理"],
  ["4px solid var(--rule2)", "卡片左边框"],
]) {
  if (!css.includes(needle)) problems.push(`报纸体例丢了：${why}（找不到 ${needle}）`);
}

// 3. id 唯一（hash 跳转全靠它）
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const idCount = {};
for (const id of ids) idCount[id] = (idCount[id] || 0) + 1;
const dupIds = Object.entries(idCount).filter(([, n]) => n > 1);
if (dupIds.length) problems.push(`id 重复：${dupIds.map(([k, n]) => `${k}×${n}`).join(", ")}`);

// 4. AI 面板控件齐全（缺一个按钮就点不动）
//    面板只管「选动作 / 写问题 / 发送」；接入点、密钥、模型、体检都不在模板里了。
//    ask.enabled=false 时面板整个不渲染，这条自然跳过。
if (askOff) {
  if (html.includes('id="ai-panel"')) problems.push("ask.enabled 是 false，但页面还渲染了 AI 面板");
} else {
  for (const id of [
    "ai-ctx",
    "ai-msgs",
    "ai-quick",
    "ai-input",
    "ai-send",
    "ai-close",
    // 会话选择：两个单选 + 一个下拉，缺一个面板就没法选新旧会话
    "ai-mode-new",
    "ai-mode-reuse",
    "ai-pick",
    // 浮窗：标题栏（拖着走）、置顶、停靠、问答分界、上下两块容器。
    // 缺任何一个，要么拖不动、要么分界拉不了，而且不会有别的地方报错。
    "ai-head",
    "ai-pin",
    "ai-float-toggle",
    // 弹窗：把它弹到 Harness 外壳层（整个应用窗口）上
    "ai-detach",
    "ai-body",
    "ai-split",
    "ai-foot",
  ]) {
    if (!html.includes(`id="${id}"`)) problems.push(`AI 面板缺控件：#${id}`);
  }
}
// 模板里不应再出现任何「自带 AI 接入」的痕迹：那些归 Harness 管。
for (const gone of ["ai-config", "cfg-provider", "cfg-key", "detect-list", "ai-model", "cfg-detect"]) {
  if (html.includes(`id="${gone}"`)) problems.push(`AI 面板还留着 Cloud 接入控件：#${gone}`);
}

// 5. 主题切换要三套
const swatches = [...html.matchAll(/class="theme-swatch" type="button" data-theme="([^"]+)"/g)].map((m) => m[1]);
if (swatches.length !== 3) problems.push(`主题按钮应该 3 个，实际 ${swatches.length} 个`);

// 5a. 顶栏的搜索 / 设置入口，以及它们各自那层浮窗的控件。
//     浮窗是 fixed 定位、盖在页面上的，所以控件缺一个就是「点了没东西」，
//     不会有别的地方报错，只能在这里盯。
for (const id of [
  "finder-open",
  "settings-open",
  "finder",
  "finder-input",
  "finder-count",
  "finder-close",
  "finder-hint",
  "finder-results",
  "settings",
  "settings-close",
  "set-theme",
  "set-font",
  "set-rail",
  "set-view",
  "set-scope",
  "set-evidence",
  "set-hotkey",
  "set-reset",
  "set-clear",
]) {
  if (!html.includes(`id="${id}"`)) problems.push(`搜索 / 设置缺控件：#${id}`);
}
// 设置里「打开哪一页」必须把 config.views 一页不落地列出来，
// 否则用户切了默认页却发现某一页根本选不到。
const viewOptions = [...html.matchAll(/<select class="settings-select" id="set-view">([\s\S]*?)<\/select>/g)]
  .map((m) => m[1])
  .join("");
for (const v of cfg.views || []) {
  if (!viewOptions.includes(`value="${v.key}"`)) {
    problems.push(`设置里「打开哪一页」少了「${v.label}」这个选项`);
  }
}

// 5b. 侧栏开关：必须是原版那个「竖排在侧栏右边缘、垂直居中」的按钮，
//     收起后原地变「展开」，侧栏留 50px 窄条。位置参数写死在这里，谁挪都会红。
if (!/<aside class="rail"><button class="rail-toggle"[^>]*id="rail-toggle"/.test(html)) {
  problems.push("收起按钮必须是 aside.rail 的第一个子元素（原版就是这么放的）");
}
if (!/\.rail-toggle\{position:absolute;top:50%;right:0;width:28px;min-height:104px/.test(css)) {
  problems.push("收起按钮的定位参数跟原版不一致（应为 absolute / top:50% / right:0 / 28×104）");
}
if (!css.includes("writing-mode:vertical-rl")) problems.push("收起按钮不是竖排文字，跟原版不一致");
if (!css.includes('.page.rail-collapsed .rail-body{display:none}')) {
  problems.push("没有收起态：.page.rail-collapsed 下 rail-body 该隐藏");
}
if (!css.includes(".page.rail-collapsed .layout{grid-template-columns:50px")) {
  problems.push("收起后侧栏应留 50px 窄条（按钮就站在这条上），现在是整栏拿掉");
}
if (!css.includes('.page.rail-collapsed .rail-toggle::before{content:"展开"}')) {
  problems.push("收起后按钮文字没有翻成「展开」");
}
// 5c. 每块侧栏的「收起明细」：跟原版一样是明细列表上方的下划线文字按钮，
//     只收明细列表（aria-controls 指向的那个 ul），不是把整块藏起来。
const miniToggles = [...html.matchAll(/class="rail-mini-toggle"[^>]*aria-controls="([^"]+)"/g)].map((m) => m[1]);
if (miniToggles.length === 0) {
  problems.push("侧栏没有任何「收起明细」按钮（折叠交互不该一个都没有）");
}
for (const id of miniToggles) {
  if (!html.includes(`id="${id}"`)) problems.push(`「收起明细」指向的列表不存在：#${id}`);
}
if (!html.includes("收起明细")) problems.push("侧栏没有「收起明细」按钮（原版的文案就是这个）");
if (html.includes("panel-toggle")) problems.push("还留着上一版的面板箭头（.panel-toggle），原版只有「收起明细」");
for (const need of [".rail-mini-toggle{", ".rail-mini-toggle:hover"]) {
  if (!css.includes(need)) problems.push(`「收起明细」缺样式：${need}`);
}
if (!css.includes("[hidden]{display:none!important}")) {
  problems.push("缺 [hidden] 规则，收起明细后列表不会真的隐藏");
}

// 5c-2. 侧栏标题不能被计数挤成一列：标题和计数得同时在场，且容器可换行
const headJumps = (html.match(/class="rail-head-jump"/g) || []).length;
const railFoldBtns = (html.match(/class="rail-fold"/g) || []).length;
if (railFoldBtns < 3) problems.push(`侧栏整节折叠按钮太少（${railFoldBtns} 个），原版每节一个`);
if (headJumps < 3) problems.push(`侧栏标题容器太少（${headJumps} 个），标题会被计数挤扁`);
if (html.includes('class="rail-title"') === false) problems.push("侧栏标题缺 .rail-title");
if (!css.includes(".rail-head-jump{") || !css.includes("flex-wrap:wrap")) {
  problems.push("侧栏标题容器没有 flex-wrap，窄侧栏时标题会被挤成一列");
}
if (!css.includes(".panel.is-collapsed .panel-body{display:none}")) {
  problems.push("侧栏整节折叠缺样式：.panel.is-collapsed .panel-body{display:none}");
}
if (!css.includes(".rail-fold::before")) problems.push("侧栏整节折叠箭头缺样式 .rail-fold::before");

// 5d. 处理记录的「按类型筛选」：原版有，别漏。
//     记录里只有一种类型时不该给筛选条（原版也只在 >1 个类型时才可筛）。
const ledgerKinds = new Set();
try {
  const ledgerRaw = html.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/);
  const boardData = ledgerRaw ? JSON.parse(ledgerRaw[1]) : null;
  if (boardData && boardData.history) {
    for (const h of [].concat(boardData.history)) {
      const k = String((h && h.kind) || "ops");
      ledgerKinds.add(["found", "fixed", "feature", "ops", "deploy"].includes(k) ? k : "other");
    }
  }
} catch {}
const expectFilter = ledgerKinds.size > 1;
const kindChips = [...html.matchAll(/class="kind-chip[^"]*" type="button" data-kind="([^"]+)"/g)].map((m) => m[1]);
const tlKinds = [...html.matchAll(/<li class="tl-[^"]*" data-kind="([^"]+)"/g)].map((m) => m[1]);
if (expectFilter) {
  if (!kindChips.includes("all")) problems.push("处理记录没有「全部」类型标签");
  if (kindChips.length < 2) problems.push(`处理记录的类型筛选标签太少（${kindChips.length} 个）`);
  if (!html.includes("data-history-filter")) problems.push("处理记录的筛选条缺 data-history-filter");
  if (!html.includes("data-history-section")) problems.push("处理记录区块缺 data-history-section");
  if (!tlKinds.length) problems.push("处理记录的时间线没有 data-kind，筛选会失灵");
  for (const k of kindChips.filter((c) => c !== "all")) {
    if (!tlKinds.includes(k)) problems.push(`类型标签 ${k} 在时间线里没有任何记录，点了会是空的`);
  }
  if (!css.includes(".timeline li.is-hidden{display:none}")) {
    problems.push("缺 .timeline li.is-hidden 规则，筛选后记录不会隐藏");
  }
  for (const need of [".history-kinds .kind-chip.is-active", ".history-kinds .kind-chip{"]) {
    if (!css.includes(need)) problems.push(`处理记录筛选条缺样式：${need}`);
  }
}
// 原版就有的交互类名，白名单放行；其余「临时开关」一律不许出现
for (const bad of ["rail-open", 'class="nav-rail"', 'class="tb-btn"']) {
  if (html.includes(bad)) problems.push(`还留着 ${bad}：收起按钮只应该有原版那一个，别再叠别的开关`);
}
for (const bad of [".rail-open{", ".nav-rail{", ".tb-btn{"]) {
  if (css.includes(bad)) problems.push(`样式里还留着 ${bad}，是临时方案的残留`);
}
for (const t of ["night", "eye", "paper"]) {
  if (!css.includes(`data-theme="${t}"`)) problems.push(`样式里没有 ${t} 主题的配色`);
}

// 6. 卡片与锚点
// 普通卡片是 <article class="card">；已收口页的折叠卡片是 <details class="card card-collapsed">，
// 两者都算「一张卡片」——只数 article 会把折叠卡漏掉，导致与「问 AI」按钮数对不上。
const cards = [
  ...html.matchAll(/<(?:article|details) class="card[^"]*" id="([^"]+)"/g),
].map((m) => m[1]);
const cardCount = {};
for (const c of cards) cardCount[c] = (cardCount[c] || 0) + 1;
const dupCards = Object.entries(cardCount).filter(([, n]) => n > 1);
if (dupCards.length) problems.push(`同一张卡片渲染了多次：${dupCards.map(([k, n]) => `${k}×${n}`).join(", ")}`);

// ask.enabled=false 时整块「问 AI」都不该出现：面板不渲染，按钮也不渲染。
// 这两种状态要分开验，不能拿「必须有按钮」去套一个明确关掉它的看板。
// （askOff 在上面读配置时已经算好。）
const askBtns = (html.match(/data-ask="/g) || []).length;
// 只看 HTML 元素的属性，不看脚本里的选择器字符串 ——
// client.js 里满是 querySelector("[data-ask]") 这类字样，按子串找必然误报。
const htmlOnly = html.replace(/<script[\s\S]*?<\/script>/g, "");
if (askOff) {
  const anyAsk =
    /\bdata-ask(-skill|-skills|-global|-risks|-feature)?\s*=/.test(htmlOnly) || /\bid="ai-(panel|send|close|new|input)"/.test(htmlOnly);
  if (anyAsk) problems.push("ask.enabled 是 false，但页面上还留着「问 AI」面板或按钮");
} else if (askBtns !== cards.length) {
  problems.push(`卡片 ${cards.length} 张，「问 AI」按钮 ${askBtns} 个，数量不一致`);
}

// 「待处理问题」和「待处理风险」两块头部各有一个入口按钮，左右对称：
// 问题块 → 总结项目状态（整本台账），风险块 → 风险审核（只审风险车道）。
// 少了任何一个都是开着 ask 却没给入口，和「按钮比卡片少」一样属于渲染缺件。
// 两块都已经搬到各自的车道页（问题修复 / 风险），所以这里按整份 HTML 找，
// 不限定在总览页 —— 它们本来就不在总览了。
if (!askOff) {
  if (!/\bdata-ask-global\b/.test(htmlOnly)) problems.push("「待处理问题」右侧缺「总结项目状态」按钮");
  if (!/\bdata-ask-risks\b/.test(htmlOnly)) problems.push("「待处理风险」右侧缺「风险审核」按钮");
  // 需求车道「计划中」右侧的入口：跟 AI 谈还要加什么功能。
  if (!/\bdata-ask-feature\b/.test(htmlOnly)) problems.push("需求车道「计划中」右侧缺「和 AI 谈谈要加什么」按钮");
}

// 6c. Skill 统计是独立一页（不是塞在总览里），三组固定都在。
//     （navLabels 在 6b 里定义，判断放到 6b 之后。）
const skillsView = /<section class="view" data-view="skills" id="view-skills">/.test(html);
if (!skillsView) {
  problems.push('缺 Skill 统计页（data-view="skills"），它应该是导航里的独立一页');
}
for (const label of ["会话里用过的", "项目产出的", "为它写的"]) {
  if (!html.includes(label)) problems.push(`Skill 统计页缺分组「${label}」`);
}
for (const anchor of ["skill-group-used", "skill-group-produced", "skill-group-related"]) {
  if (!html.includes(`id="${anchor}"`)) problems.push(`Skill 统计页缺分组锚点 #${anchor}`);
}
if (!css.includes(".skill-row{")) problems.push("Skill 统计缺样式 .skill-row");
// Skill 页的问 AI：每条一个 + 整页一个。关掉 ask 时这两个也不该出现。
// 一律看 htmlOnly（已剥掉 <script>），否则会被 client.js 里的选择器字样误判。
if (askOff) {
  if (/data-ask-skills?\b/.test(htmlOnly)) {
    problems.push("ask.enabled 是 false，但 Skill 页还留着「问 AI」按钮");
  }
} else {
  if (!htmlOnly.includes("data-ask-skills")) problems.push("Skill 统计页缺「问整页 Skill」按钮");
  const skillAskBtns = (htmlOnly.match(/data-ask-skill="/g) || []).length;
  const skillRows = (htmlOnly.match(/class="skill-row"/g) || []).length;
  if (skillRows > 0 && skillAskBtns !== skillRows) {
    problems.push(`Skill 行 ${skillRows} 条，但每条的问 AI 按钮只有 ${skillAskBtns} 个`);
  }
}

// 6b. 导航顺序要跟配置里的 views 顺序一致。
// 早先这里写死成「总览 → 新增功能 → 问题修复 → 风险 → 已修复 → Skill 统计」，
// 结果是每加一个新视图就误报一次 —— 它检查的是「有没有按原版排」，
// 而真正该检查的是「渲染顺序有没有跟着配置走」。改成按配置比对，
// 既不会因为加视图误报，又能抓到「配置改了但渲染没跟上」这种真错。
const navLabels = [...html.matchAll(/<nav class="nav">([\s\S]*?)<\/nav>/g)]
  .flatMap((m) => [...m[1].matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((a) => a[1].trim()));
if (!navLabels.length) {
  problems.push("找不到导航");
} else {
  const cfgViews = Array.isArray(cfg.views) ? cfg.views : [];
  if (cfgViews.length) {
    const want = cfgViews.map((v) => String(v.label || "").trim());
    if (JSON.stringify(navLabels) !== JSON.stringify(want)) {
      problems.push(`导航顺序和 board.config.json 的 views 不一致：实际 ${navLabels.join(" → ")}；配置 ${want.join(" → ")}`);
    }
  }
  // 这三条跟顺序无关，是「必须存在 / 必须叫这个名」的硬约束，保留。
  if (!navLabels.some((l) => l.indexOf("已修复") === 0)) {
    problems.push("收口页的标签应跟原版一样叫「已修复 / 已关闭 / 暂停」");
  }
  if (navLabels.includes("已收口")) {
    problems.push("还留着「已收口」这个自造的名字，原版叫「已修复 / 已关闭 / 暂停」");
  }
  if (navLabels.indexOf("Skill 统计") === -1) {
    problems.push("导航里没有「Skill 统计」这一页");
  }
}

// 7. 所有 hash 链接都要有落点
const links = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((l) => l && l !== "#");
const targets = new Set(ids);
const dead = [...new Set(links)].filter((l) => !targets.has(l));
if (dead.length) problems.push(`这些 #链接 找不到落点：${dead.join(", ")}`);

// 8. HTML 用到的 class 必须有样式
const usedClasses = new Set();
for (const m of body.matchAll(/class=["']([^"']+)["']/g)) {
  for (const c of m[1].split(/\s+/)) if (c) usedClasses.add(c);
}
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
// 伪类/伪元素、属性选择器里的词不是类名；.a.b 里的 b 是修饰类，仍算类名。
// 上面那条正则足够宽，但会把 :not(.x) / [data-x=".y"] 里的点也抓进来，
// 因此这里再剔一遍：只保留「出现在选择器主体里」的。
const selectorHeads = [...css.matchAll(/(^|})([^{}@]+)\{/g)].map((m) => m[2]);
const selectorClasses = new Set();
for (const head of selectorHeads) {
  // 去掉伪类与属性选择器部分，避免从里面抓到词
  const cleaned = head.replace(/\[[^\]]*\]/g, "").replace(/::?[\w-]+(\([^)]*\))?/g, "");
  for (const m of cleaned.matchAll(/\.([a-zA-Z][\w-]*)/g)) selectorClasses.add(m[1]);
}
const dynamic = /^(is-open|is-active|on|open|is-collapsed|is-stage-filter|ok|bad)$/;
const noStyle = [...usedClasses].filter((c) => !definedClasses.has(c) && !dynamic.test(c));
if (noStyle.length) problems.push(`这些 class 在 CSS 里没有规则：${noStyle.join(", ")}`);

// 8b. 反过来：CSS 里定义了、页面结构与脚本里一个字节都没提到的，就是删功能后留下的死样式。
// （.lead-copy 就这样躺了很久，因为以前只查单向。）
//
// 判据刻意放到最宽：只要类名在 HTML 结构或内联脚本里出现过一次，就放过。
// 类名常常是运行时拼出来的（"msg msg-" + role）或作为参数传入（paintHistory(x,"is-history")），
// 静态分析分不清它活没活；宁可漏报，也不能让一条永远误报的检查变成噪声。
// ⚠️ 必须把 <style> 块排除掉——否则每个类名都能在 CSS 里匹配到自己，检查永远不报。
const everything = html.slice(html.indexOf("</style>") + "</style>".length);
// 前缀族：类名由变量拼出，静态只能看到前缀。
//   msg-    ← "msg msg-" + role（role 取 user / ai）
//   lv-     ← `lv-${tone}`（tone 由 severity/status 配置给出，合法值随配置变）
const dynamicPrefixes = ["msg-", "lv-"];
// 服务于「当前看板没走到的合法出口」的样式，不报。
//   card-head     ← itemCard 的非折叠形态（两块看板都走 <details>，这个出口暂时没调用者，
//                   但它是 itemCard 的合法返回分支，不是删功能留下的残骸）
//   metric-xxx    ← 合法 status 档位由 metricStatuses 声明（默认 ok/warn/danger/muted），
//                   某块看板没用到的档位仍需保留样式，否则换个看板就会掉配色；
//                   下面第 8c 条已单独检查「声明的档位都有样式」，这里不重复报。
const CONDITIONAL = new Set(["card-head", "metric-danger", "metric-muted", "metric-ok", "metric-warn"]);
// 判活的语料 = 本看板的成品 + 渲染器源码。
// 只查成品会大量误报：小看板只有十来张卡、走不到 timeline / skill 那些分支，
// 于是它们全被当成死样式。真正该问的是「还有没有代码会拼出这个类名」，
// 而渲染器是各看板共用的，所以源码必须一起搜。
const rendererSources = (() => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "lib");
  const files = ["parts.mjs", "client.js", "render.mjs", "css.mjs"];
  let all = "";
  for (const f of files) {
    const p = join(dir, f);
    if (existsSync(p)) all += readFileSync(p, "utf8");
  }
  return all;
})();
const corpus = everything + "\n" + rendererSources;
const orphanClasses = [...selectorClasses].filter((c) => {
  if (usedClasses.has(c) || dynamic.test(c) || CONDITIONAL.has(c)) return false;
  if (dynamicPrefixes.some((p) => c.startsWith(p))) return false;
  // 成品结构与渲染器源码里搜一次：类名作为独立标识出现即视为活
  const re = new RegExp("(?<![\\w-])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])");
  return !re.test(corpus);
});
if (orphanClasses.length) problems.push(`这些样式没有任何元素在用（孤儿样式）：${orphanClasses.join(", ")}`);

// 9. 占位符不能漏到成品里（内联数据里的模板变量是留给前端的，不算）
const withoutData = html.replace(/<script type="application\/json" id="board-data">[\s\S]*?<\/script>/, "");
const leftover = withoutData.match(/\{\{[a-zA-Z]+\}\}/g);
if (leftover) problems.push(`有未替换的占位符：${[...new Set(leftover)].join(", ")}`);
if (withoutData.includes("${")) problems.push("成品里残留了模板表达式 ${");

// 10. CSS 括号平衡
const ob = (css.match(/{/g) || []).length;
const cb = (css.match(/}/g) || []).length;
if (ob !== cb) problems.push(`CSS 花括号不平衡：{ ${ob} 个，} ${cb} 个`);

// 11. 标签闭合与嵌套
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function checkTagBalance(src) {
  const s = src
    .replace(/<script[\s\S]*?<\/script>/gi, "<script></script>")
    .replace(/<style[\s\S]*?<\/style>/gi, "<style></style>")
    .replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const [, close, tag, , selfClose] = m;
    const name = tag.toLowerCase();
    if (VOID_TAGS.has(name) || selfClose) continue;
    if (!close) stack.push(name);
    else if (stack[stack.length - 1] === name) stack.pop();
    else return { close: name, open: stack[stack.length - 1] || "(无)" };
  }
  return stack.length ? { unclosed: stack } : null;
}
const imbalance = checkTagBalance(html);
if (imbalance && imbalance.unclosed) problems.push(`标签没有闭合：${imbalance.unclosed.join(" > ")}`);
else if (imbalance) problems.push(`标签嵌套错位：遇到 </${imbalance.close}>，当前开着的是 <${imbalance.open}>`);

// 12. 内联数据能解析、字段齐全
const dataMatch = html.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/);
if (!dataMatch) {
  problems.push("找不到 board-data 内联数据");
} else {
  try {
    const d = JSON.parse(dataMatch[1]);
    const itemCount = Object.keys(d.items || {}).length;
    // 空看板（0 条目）是合法状态：刚建的骨架就是要往里填的。空的时候
    // openList / index 渲染成空串，不拦；有条目时才严格要求字段齐全。
    for (const f of ["project", "updatedAt", "totalCount", "openCount", "systemPrompt"]) {
      if (d[f] === undefined || d[f] === "") problems.push(`board-data 缺字段：${f}`);
    }
    if (itemCount > 0) {
      for (const f of ["openList", "index"]) {
        if (d[f] === undefined || d[f] === "") problems.push(`board-data 缺字段：${f}`);
      }
    }
    for (const [id, v] of Object.entries(d.items || {})) {
      if (!v.copyText) problems.push(`board-data 里 ${id} 缺 copyText`);
      if (!v.sections) problems.push(`board-data 里 ${id} 缺 sections`);
    }
    if (!(d.itemQuick || []).length) problems.push("没有单条台账的快捷问题（ask.itemQuick）");

    // metric 的 status 是「配置 ↔ 渲染 ↔ 样式」三方的契约：
    // 台账里写了一个表外的值，渲染会拼出 .metric-xxx，而 CSS 里没这条规则 ——
    // 页面不报错，只是那条指标悄悄没配色。插件建板时写过 muted，正好踩中这个坑，
    // 所以这里主动查，而不是等「class 没有 CSS 规则」那条间接报出来。
    //
    // 注意：metrics 不在 board-data 里（它由渲染器直接从 ledger 读），
    // 所以这里得单独把 ledger.json 读一遍。
    const metricStatuses = Array.isArray(cfg.metricStatuses) && cfg.metricStatuses.length
      ? cfg.metricStatuses
      : ["ok", "warn", "danger", "muted"];
    const ledgerPath = join(ROOT, "ledger.json");
    if (existsSync(ledgerPath)) {
      let ledgerMetrics = [];
      try {
        ledgerMetrics = JSON.parse(readFileSync(ledgerPath, "utf8")).metrics || [];
      } catch (e) {
        problems.push(`ledger.json 不是合法 JSON：${e.message}`);
      }
      const badMetrics = [];
      for (const m of ledgerMetrics) {
        if (!m || m.status === undefined || m.status === "") continue;
        if (!metricStatuses.includes(m.status)) badMetrics.push(`${m.label || "(无标签)"}=${m.status}`);
      }
      if (badMetrics.length) {
        problems.push(
          `ledger.json 里的指标 status 不在 board.config.json 的 metricStatuses 里：${badMetrics.join(", ")}` +
            `（可用 ${metricStatuses.join(" / ")}）`,
        );
      }
    }
    // 配置声明了 status，CSS 就得给每一档配一条规则，否则渲染出来没有颜色。
    const missingMetricCss = metricStatuses.filter((s) => !css.includes(`.metric-${s} `) && !css.includes(`.metric-${s}{`));
    if (missingMetricCss.length) {
      problems.push(`metricStatuses 声明了 ${missingMetricCss.join(" / ")}，但样式里没有对应规则（.metric-xxx）`);
    }
    // 只有单条台账的动作走配置。整本、整页 skill、单条 skill 的动作在 client.js 里，
    // 因为它们的 prompt 必须点名作用域，让项目配置覆盖会把作用域改坏。
    // 配置里留着这些字段只会让人以为改了有用 —— 所以这里拦下来。
    for (const dead of ["quick", "globalQuick", "skillQuick"]) {
      if (d[dead] !== undefined) {
        problems.push(
          `board-data 里还有没人读的 ${dead}：改了不会有任何效果` +
            (dead === "quick" ? "（单条那套已改名 itemQuick）" : ""),
        );
      }
    }
    notes.push(
      `上下文：${d.totalCount} 条 / 未收口 ${d.openCount} 条 · 索引 ${d.index.split("\n").length} 行 · 系统提示 ${
        (d.systemPrompt || "").length
      } 字`
    );
  } catch (e) {
    problems.push(`board-data 不是合法 JSON：${e.message}`);
  }
}

// 13. 前端脚本语法 + 关键函数存在
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const js = scripts[scripts.length - 1] || "";
if (!js) {
  problems.push("没有前端脚本，路由和 AI 面板都跑不起来");
} else {
  try {
    new Function(js);
  } catch (e) {
    problems.push(`前端脚本有语法错误：${e.message}`);
  }
  for (const fn of ["function route", "function send", "function openPanel", "function ctxLabel"]) {
    if (!js.includes(fn)) problems.push(`前端脚本里没有 ${fn}，功能不完整`);
  }
  // 发送只有一条路：交给 Harness。模板里不该再有「页面直连模型」的代码 ——
  // 那段代码意味着每个项目副本都要管密钥和模型，而那是 Harness 的职责。
  for (const fn of ["function sendHarness", "function harnessPost", "function harnessContext", "/ops-board/ask"]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，「问 AI」交不到 Harness`);
  }
  for (const gone of ["/api/chat", "/api/config", "/api/health", "/api/detect", 'var BACKEND = "http://127.0.0.1:8790"', "function apiFetch(", "function buildSystem("]) {
    if (js.includes(gone)) problems.push(`前端还留着 Cloud 接入：${gone}（已归 Harness 管）`);
  }
  // 裸页（没经过 Harness 注入）不能崩，要给一句人看得懂的话。
  // 判据是「运行时读环境」而不是某个变量名：抓一次存起来的写法在 iframe 先加载、
  // 插件后注入时会一直读到 null，那才是真的把裸页判断做坏了。
  for (const fn of ["harnessEnv()", "要在 Harness 里打开"]) {
    if (!js.includes(fn)) problems.push(`前端没有处理裸页：${fn}`);
  }
  // 侧栏能收起 / 能记住状态 / 有快捷键
  for (const fn of ["RAIL_KEY", "function setRail", "rail-collapsed", 'e.key !== "["']) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，侧栏收起功能会失效`);
  }
  // 侧栏每一块的「收起明细」也要记住上次状态（键名沿用原版 ops-mini-）
  for (const fn of ["rail-mini-toggle", "ops-mini-", "展开明细", "收起明细"]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，侧栏「收起明细」会失效`);
  }
  // 侧栏整节折叠 + 阶段格子筛选
  for (const fn of ["function setFold", "rail-fold", "function applyStageFilter", "is-stage-filtered", "is-stage-keep"]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，侧栏整节折叠或阶段筛选会失效`);
  }
  // 处理记录按类型筛选（原版就有）
  for (const fn of ["data-history-filter", "data-history-section", "is-hidden", "显示 "]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，处理记录的类型筛选会失效`);
  }
  // Skill 页的问 AI：单条一套 + 整页一套，作用域不能混
  for (const fn of [
    "HARNESS_SKILL_ONE_QUICK",
    "HARNESS_SKILL_QUICK",
    "总结并更新这一个",
    "更新所有 Skill",
    "检查 Skill 冲突",
    "function openSkillPanel",
    "data-ask-skill",
    "作用域限制",
  ]) {
    if (!js.includes(fn)) problems.push(`前端缺 ${fn}，Skill 页的「问 AI」会失效`);
  }
  // 单条的动作不能出现"全部/每个"这种越界说法
  const oneBlock = (js.match(/HARNESS_SKILL_ONE_QUICK = \[([\s\S]*?)\n  \];/) || [])[1] || "";
  for (const bad of ["全部 SKILL.md", "每个 skill", "这些 skill"]) {
    if (oneBlock.includes(bad)) {
      problems.push(`单条 skill 的动作里出现了越界说法「${bad}」：它只该处理这一个文件`);
    }
  }
  // 锚点跳转要能切到它所在的视图：路由缺这层兜底，Skill 页的格子会掉回总览
  if (!js.includes("function viewOfId")) {
    problems.push("前端缺 viewOfId：未登记的锚点（如 #skill-group-*）会掉回总览页");
  }
  // 跳转：跨视图要等帧再量位置，落点要高亮，同一锚点连点也要有反应
  for (const fn of ["function nextFrame", "function flashEl", 'closest(\'a[href^="#"]\')']) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，跳转会落不准或点了没反应`);
  }
  // 搜索：自己写一层，不用浏览器自带查找（自带查找会命中隐藏视图和 AI 面板里的字，
  // 也没法按条目跳）。这里盯住「按条目搜 + 分组 + 跳转」这条链不能断。
  for (const fn of [
    "function splitBlocks",
    "function evidenceLines",
    "function searchItems",
    "function markInto",
    "function goItem",
    "function openFinder",
    "function closeFinder",
    "function initFinder",
    "data-jump",
  ]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，顶栏「搜索」会失效`);
  }
  // Ctrl+F 必须能关掉，且关掉后不再拦浏览器自带查找
  if (!js.includes("prefsNow().hotkey")) {
    problems.push("前端没有读 hotkey 偏好：Ctrl+F 关不掉，会一直顶着浏览器自带查找");
  }
  // 设置：改完立刻生效 + 记得住 + 能恢复默认 / 清空
  for (const fn of [
    "function loadPrefs",
    "function savePrefs",
    "function applyFont",
    "function applyTheme",
    "function paintSettings",
    "function openSettings",
    "function closeSettings",
    "function resetPrefs",
    "function clearPrefs",
    "function initSettings",
    "ops-board-set",
  ]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，顶栏「设置」会失效`);
  }
  // 字号只走倍率这一条路：直接改 body 的 px 会把编号、时间、按钮一起撑开，
  // 密排的索引行就散了。判据是「写的是变量」而不是写死某个字号。
  if (!js.includes("--fs-scale")) {
    problems.push("前端字号没有走 --fs-scale 倍率：正文一放大，编号与按钮也会跟着变大");
  }

  // 13a-2. 浮窗：五件事各要有一条真代码兜着 —— 拖动、拉角、分界、置顶、记住位置。
  //        这些都是「不报错但用不了」的交互，静态检查必须点名到函数。
  for (const fn of ["function initFloat", "function applyWin", "function winClamp", "function dragOnce"]) {
    if (!js.includes(fn)) problems.push(`前端没有 ${fn}，浮窗拖不动 / 记不住位置`);
  }
  // 八个方向都得有把手，少一个就有条边拉不了
  for (const dir of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
    if (!html.includes(`data-dir="${dir}"`)) problems.push(`浮窗少了 ${dir} 方向的拉伸手柄`);
  }
  // 置顶与停靠的按钮必须真的绑了事件，且状态写在 data-* 上
  if (!js.includes('setAttribute("data-pinned"')) problems.push("置顶状态没写到 data-pinned 上，钉不住");
  if (!js.includes('setAttribute("data-mode"')) problems.push("浮窗 / 停靠形态没写到 data-mode 上");
  if (!css.includes('.ai-panel[data-pinned="1"]')) problems.push("CSS 没有置顶态的层级规则，置顶点了没反应");
  if (!css.includes('.ai-panel[data-mode="dock"]')) problems.push("CSS 没有停靠态的规则，切了不会变回贴边抽屉");
  // 位置要记在本机，且键名必须在 ops-board- 前缀下，否则「清空本机偏好」扫不掉它
  if (!js.includes('"ops-board-win:"')) {
    problems.push("浮窗位置没记在本机（键名应为 ops-board-win:…），关掉再开就回原位了");
  }
  if (!js.includes("window.localStorage.setItem(winStoreKey()")) {
    problems.push("浮窗位置没有落盘");
  }
  // 夹回视口的逻辑不能省：拖出屏幕再刷新就再也找不回来了，而且会顶出横向滚动条
  if (!js.includes("window.innerWidth") || !js.includes("MIN_W")) {
    problems.push("浮窗没有按视口夹边（拖出屏幕会找不回来）");
  }
  // 分界必须能拖，且拖的是输入区高度
  if (!js.includes("applyFoot")) problems.push("问答分界没有实际调整高度的逻辑");
  if (!css.includes(".ai-split{") || !css.includes("cursor:row-resize")) {
    problems.push("问答分界没有可拖的光标，用户看不出来能拉");
  }
  if (!css.includes(".ai-grip{")) problems.push("浮窗没有拉伸手柄的样式，八个角是隐形的");

  // 13a-3. 独立窗口形态（?chat=1）：这一份页面被当成「只剩对话框」加载时，
  //         必须自己把整页骨架收起来、把面板铺满，否则弹出去的窗口里还套着一整页看板。
  if (!js.includes("initSplit")) {
    problems.push("分界线逻辑没有抽成 initSplit：独立窗口里没人调 initFloat，分界会拉不动");
  }
  // 独立窗口不能再走整页启动流程：finder/settings/路由这些一旦跑起来，
  // 会把一个空骨架的搜索框、设置页也一起拉起来，而且会覆盖主看板的本机状态。
  if (!js.includes("CHAT_ONLY")) problems.push("前端没有识别独立窗口形态（缺 CHAT_ONLY 判断）");
  if (!js.includes('data-chat') && !css.includes('html[data-chat="1"]')) {
    problems.push("没有 data-chat 标记，页面认不出自己是被当成独立窗口加载的");
  }
  // 骨架必须真的藏掉，而且要 !important —— 各段自己的 display 会把它顶回来
  for (const sel of [".topbar", ".masthead", ".nav", ".layout"]) {
    if (!css.includes(`html[data-chat="1"] ${sel}`)) {
      problems.push(`独立窗口形态没有藏掉 ${sel}，窗口里会多出一截看板骨架`);
    }
  }
  if (!/html\[data-chat="1"\][^{]*\{[^}]*display:none!important/.test(css)) {
    problems.push("独立窗口形态藏骨架时没加 !important，会被各段自身的 display 顶回来");
  }
  if (!css.includes('html[data-chat="1"] .ai-panel')) {
    problems.push("独立窗口形态没有让对话框铺满：窗口里会留一圈空白");
  }
  // 铺满必须同时关掉滚动条槽，否则右侧会永远缺一条滚动条的宽度
  if (!css.includes("scrollbar-gutter:auto")) {
    problems.push("独立窗口形态没关 scrollbar-gutter，对话框右侧会缺 15px");
  }
  // 拉角/置顶/停靠/弹窗在独立窗口里都要收起来：这些是外层窗口的事，
  // 里面再留一套就是两套定位互相打架。
  for (const id of ["#ai-pin", "#ai-detach", "#ai-float-toggle"]) {
    if (!css.includes(`html[data-chat="1"] ${id}`)) {
      problems.push(`独立窗口里没有收起 ${id}（那是外层窗口的活）`);
    }
  }
  if (!/html\[data-chat="1"\] \.ai-grip[\s\S]{0,200}display:none/.test(css)) {
    problems.push("独立窗口里没有收起八个拉角");
  }
  // 独立窗口里标题栏不能再拖 —— 拖动是外层窗口的职责
  if (!css.includes('html[data-chat="1"] .ai-head')) {
    problems.push("独立窗口里标题栏还是可拖的，会和外层窗口的拖动打架");
  }
  // 关窗必须走对外通知，不能把面板自己藏掉（它藏了外层窗口还在）
  if (!js.includes("ops-board/chat-close")) {
    problems.push("独立窗口的关闭按钮没有通知外层，点了关不掉窗口");
  }
  // 弹窗按钮要把「哪一份页面 + 哪一条对话」一起带出去
  if (!js.includes("ops-board/chat-open")) {
    problems.push("没有把「弹窗」请求发给外壳层，按钮点了没反应");
  }
  if (!js.includes("location.pathname")) {
    problems.push("弹窗没有带上当前页面的路径，外层不知道要加载哪一块看板");
  }
  // 独立窗口里不许写主看板的本机状态：两个 iframe 同源共用同一批键
  if (!/if \(!CHAT_ONLY\)\s*savePanelState\(true\)/.test(js)) {
    problems.push("独立窗口会把面板状态写回本机，覆盖主看板正在聊的作用域");
  }
  if (!/if \(!CHAT_ONLY\)\s*saveWin\(\)/.test(js)) {
    problems.push("独立窗口会把浮窗几何写回本机，覆盖主看板的窗口位置");
  }
}

// 13b. 服务端：只剩「重渲染 + 静态服务」
// 脚本现在只有模板一份（项目里是转发入口），所以要去模板目录找真身。
const servePath = join(TEMPLATE_ROOT, "scripts", "serve.mjs");
const serveSrc = existsSync(servePath) ? readFileSync(servePath, "utf8") : "";
if (serveSrc) {
  // 该在的：渲染刷新、静态服务、探活
  for (const fn of ["function ensureFresh", "function refreshSkills", 'path === "/api/ping"', "function sendJson"]) {
    if (!serveSrc.includes(fn)) {
      problems.push(`服务端缺 ${fn}，预览或自动重渲染会失效`);
    }
  }
  // 不该在的：任何 AI 接入、密钥、模型探测
  for (const gone of [
    "ai.config",
    "readAiConfig",
    "saveAiConfig",
    "chatOpenAI",
    "chatCli",
    "detectAgents",
    "probeProvider",
    "atRestBlocked",
    "NOKEY_TAIL",
    "/api/config",
    "/api/chat",
    "/api/health",
    "/api/detect",
  ]) {
    if (serveSrc.includes(gone)) {
      problems.push(`服务端还留着 Cloud 接入：${gone}（已归 Harness 管）`);
    }
  }
  // 跨源：页面可能被别的预览服务托管（源不是 8790），请求得放得进来
  for (const fn of ["Access-Control-Allow-Origin", 'req.method === "OPTIONS"', 'path === "/api/ping"']) {
    if (!serveSrc.includes(fn)) {
      problems.push(`服务端没有 ${fn}，从预览面板打开时面板会连不上后端`);
    }
  }
}

// ── 输出 ──
const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);

if (problems.length) {
  console.error(`\n自检未通过，${problems.length} 个问题：`);
  for (const p of problems) console.error("  × " + p);
  process.exit(1);
}

console.log(`\n自检通过：${target}`);
console.log(`  · ${sizeKb} KB · 卡片 ${cards.length} 张 · 视图 ${(html.match(/data-view="/g) || []).length} 个 · id ${ids.length} 个全部唯一`);
console.log(`  · 报纸体例（双线报头/纸纹/双栏/卡片边框）齐全，三套主题就位`);
console.log(`  · ${askOff ? "问 AI 已关闭（面板与按钮都不渲染）" : "AI 面板控件齐全"}，无孤儿样式，无死链，标签闭合`);
for (const n of notes) console.log(`  · ${n}`);
console.log("");
