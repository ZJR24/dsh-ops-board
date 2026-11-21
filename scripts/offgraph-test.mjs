// 图外规则 R1/R2/R3（§七 / §十E.5③）。
//
// 要防的：depcruise 只认 .js/.ts，而小程序的 .wxml/.wxss 在图里**完全看不见**。
// 「A 改 pages/x/x.wxml、B 改 pages/x/x.js」在图里是两个无关文件，
// 实际是同一个组件的视图与逻辑 —— 必须判冲突。
//
// 实测确认的目标项目结构（2026-11-21）：
//   pages/about          : .js .json .wxml .wxss
//   pages/board          : .js .json .wxml .wxss
//   components/egg-toast : .js .json .wxml .wxss   ← 文档只写了 pages/，components 也是四件套
import {
  expandStemGroup, pageRegistryImpact, fallbackDirs,
  applyOffGraphRules, offGraphConflict, STEM_EXTS, GRAPH_EXTS, PAGE_REGISTRY_FILES,
} from "./lib/offgraph.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

// ── ① R1 同主干扩张 ──
console.log("[1] R1 同主干锁：改一个，整组都算被改");
{
  const r = expandStemGroup(["pages/board/board.wxml"]);
  const got = [...r.expanded].sort();
  ok(got.includes("pages/board/board.js"), "补入了同组件的 .js", got.join(" "));
  ok(got.includes("pages/board/board.json"), "补入了 .json", "");
  ok(got.includes("pages/board/board.wxss"), "补入了 .wxss", "");
  // 四件套 + .wxs = 5 个（.mjs/.ts/.cjs **不该**被补，见 expandStemGroup 注释）
  ok(got.length === 5, "整组 5 个文件（.js/.json/.wxml/.wxss/.wxs）", got.join(" ") + " = " + got.length + " 个");
  ok(!got.some((f) => /\\.(mjs|cjs|ts|tsx)$/.test(f)), "**不补 .mjs/.ts**（否则会造出不存在的文件）", got.join(" "));
  ok(r.added.size === 4, "额外纳入 4 个（原报的 1 个不算额外）", r.added.size + " 个");
}

// ── ② components 也要覆盖（文档只写了 pages/）──
console.log("\n[2] R1 覆盖 components/（实测发现文档只写了 pages/）");
{
  const r = expandStemGroup(["components/egg-toast/egg-toast.wxml"]);
  ok(r.expanded.has("components/egg-toast/egg-toast.js"),
    "**components 下的同主干也扩张**", [...r.expanded].sort().join(" "));
  const r2 = expandStemGroup(["custom-tab-bar/index.wxml"]);
  ok(r2.expanded.has("custom-tab-bar/index.js"), "custom-tab-bar 也覆盖", [...r2.expanded].sort().join(" "));
}

// ── ③ 不该扩张的 ──
console.log("\n[3] 不认识的扩展名不扩张（.png/.md 不是组件的一部分）");
{
  const r = expandStemGroup(["assets/logo.png"]);
  ok(r.expanded.size === 1, ".png 不扩张", r.expanded.size + " 个");
  const r2 = expandStemGroup(["docs/README.md"]);
  ok(r2.expanded.size === 1, ".md 不扩张", r2.expanded.size + " 个");
  const r3 = expandStemGroup(["utils/a.js"]);
  ok(r3.expanded.has("utils/a.json"), ".js 会扩张到 .json（同主干）", [...r3.expanded].sort().join(" "));
}

// ── ④ 目录隔离 ──
console.log("\n[4] 同主干只在同目录内扩张（不同目录同名不串）");
{
  const r = expandStemGroup(["pages/about/about.wxml"]);
  ok(!r.expanded.has("pages/board/about.js"), "不会串到别的目录", "");
  ok(r.expanded.has("pages/about/about.js"), "只在自己目录内", "");
}

// ── ⑤ R2 页面注册 ──
console.log("\n[5] R2 页面注册：改 app.json 牵动整个 pages/");
{
  const a = pageRegistryImpact(["app.json"]);
  ok(a.registryTouched === true, "识别出改了 app.json", "");
  ok(a.touchesPages === false, "app.json 自己不算 pages/ 下的文件", "");
  const b = pageRegistryImpact(["pages/board/board.js"]);
  ok(b.registryTouched === false, "页面文件不算动了注册", "");
  ok(b.touchesPages === true, "识别出是 pages/ 下的", "");
  ok(PAGE_REGISTRY_FILES.has("app.json"), "app.json 在注册文件清单里", "");
}

// ── ⑥ R3 兜底 ──
console.log("\n[6] R3 兜底：图外文件按「同目录即冲突」");
{
  const d = fallbackDirs(["pages/board/board.wxml", "utils/a.js"]);
  ok(d.has("pages/board"), "图外文件目录被收进来", [...d].join(","));
  ok(!d.has("utils"), "**图里看得见的 .js 不走兜底**（否则并行度归零）", "");
  const d2 = fallbackDirs(["pages/a/a.wxml", "pages/a/a.wxss"]);
  ok(d2.size === 1, "同目录两个图外文件 → 一个目录", d2.size + " 个");
}

// ── ⑦ 冲突判定：R1 ──
console.log("\n[7] 判冲突：R1（同一组件）");
{
  const why = offGraphConflict(["pages/board/board.wxml"], ["pages/board/board.js"]);
  ok(why.length > 0, "**改视图 vs 改逻辑 → 冲突**（图里看不见的那种）", why.join(" / "));
  ok(/同一组件/.test(why[0]), "说明了原因", why[0]);
  const why2 = offGraphConflict(["pages/a/a.js"], ["pages/b/b.js"]);
  ok(why2.length === 0, "不同页面 → 不冲突", why2.join(" / ") || "(无)");
}

// ── ⑧ 判冲突：R2 ──
console.log("\n[8] 判冲突：R2（app.json vs pages/）");
{
  const why = offGraphConflict(["app.json"], ["pages/board/board.js"]);
  ok(why.length > 0, "**改 app.json vs 改页面 → 冲突**", why.join(" / "));
  ok(/app\.json/.test(why[0]), "说明了原因", why[0]);
  const rev = offGraphConflict(["pages/board/board.js"], ["app.json"]);
  ok(rev.length > 0, "反向也冲突（对称）", rev.join(" / "));
  const why2 = offGraphConflict(["app.json"], ["utils/a.js"]);
  ok(why2.length === 0, "app.json vs 非 pages 文件 → 不冲突", why2.join(" / ") || "(无)");
}

// ── ⑨ 判冲突：R3 ──
console.log("\n[9] 判冲突：R3（同目录的图外文件）");
{
  const why = offGraphConflict(["pages/x/a.wxml"], ["pages/x/b.wxss"]);
  ok(why.length > 0, "**同目录两个图外文件 → 冲突**", why.join(" / "));
  const why2 = offGraphConflict(["pages/x/a.wxml"], ["pages/y/b.wxss"]);
  ok(why2.length === 0, "不同目录 → 不冲突", why2.join(" / ") || "(无)");
  // .js 不参与 R3
  const why3 = offGraphConflict(["utils/a.js"], ["utils/b.js"]);
  ok(why3.length === 0, "两个 .js 同目录 → **不**按 R3 判（交给依赖图）",
    why3.join(" / ") || "(无，正确)");
}

// ── ⑩ 综合 ──
console.log("\n[10] applyOffGraphRules 一次给出全部信息");
{
  const r = applyOffGraphRules(["pages/board/board.wxml", "app.json"]);
  ok(r.files.has("pages/board/board.js"), "R1 扩张了", "");
  ok(r.registry === true, "R2 识别出动了注册", "");
  ok(r.touchesPages === true, "R2 识别出动了 pages/", "");
  ok(r.graphFiles.length >= 2, "给出了交给闭包的文件（.js/.json）", r.graphFiles.join(","));
  ok(!r.graphFiles.includes("pages/board/board.wxml"), "图外文件不进 graphFiles", "");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
