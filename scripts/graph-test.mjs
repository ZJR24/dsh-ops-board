// 依赖图 + 闭包（步骤 1~3）。
//
// 这份测试的重点不是「闭包算法对不对」（那是最简单的部分），
// 而是**实测推翻了架构文档里的做法**，必须钉住：
//
//   ① 文档说「必须显式 --exclude，不能指望 .gitignore」
//      实际：--exclude **完全不能减少耗时**（83s → 78s，只是输出变少）
//   ② 文档给的 1.4 s 是在「排除生效」的假设下测的；
//      真实情况是全量 83 s，必须用 --include-only 才降到 1.8 s
//   ③ --include-only 匹配的是**相对 cwd 的路径**，写绝对路径命中 0 个模块
//
// 这三条如果不钉住，下一轮又会照着文档写一次错的。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGraph, reverseIndex, reverseClosure, mergeAddsEdges,
  saveGraph, loadGraph, relativeUrlPath, escapeRe, CLOSURE_DEPTH,
} from "./lib/graph.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

const TMP = mkdtempSync(join(tmpdir(), "graph-test-"));
const REPO = join(TMP, "repo");      // 假的「看板仓库」（cwd）
const PROJ = join(TMP, "proj");      // 假的「目标项目」
mkdirSync(REPO, { recursive: true });
mkdirSync(PROJ, { recursive: true });

const w = (root, rel, text) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, "utf8");
};

// 造一个小项目：
//   app.js → utils/data-store.js → utils/request.js
//   pages/board/board.js → utils/data-store.js
//   components/card/card.js → utils/request.js
//   cloudfunctions/fn/index.js → utils/request.js
//   data/big/junk.js（不该出现在图里 —— 模拟 avatars 那种数据目录）
w(PROJ, "app.js", "require('./utils/data-store');\n");
w(PROJ, "utils/data-store.js", "require('./request');\n");
w(PROJ, "utils/request.js", "module.exports = {};\n");
w(PROJ, "pages/board/board.js", "require('../../utils/data-store');\n");
w(PROJ, "components/card/card.js", "require('../../utils/request');\n");
w(PROJ, "cloudfunctions/fn/index.js", "require('../../utils/request');\n");
w(PROJ, "data/big/junk.js", "require('../../utils/request');\n");

const depcruiseBin = join("D:\\WorkSpace-Tools\\ops-board", "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");

// ── ① 路径换算（--include-only 的前提）──
console.log("[1] --include-only 的正则必须匹配「相对 cwd」的路径");
{
  const rel = relativeUrlPath(REPO, PROJ);
  ok(!rel.includes("\\"), "反斜杠已转成正斜杠", rel);
  ok(rel === relative(REPO, PROJ).split("\\").join("/"), "与 relative() 一致（只是换了分隔符）", rel);
  const re = "^" + escapeRe(rel) + "/(utils|pages)";
  // `../proj` 转义后是 `\.\./proj`（两个点都被转义），这是**正确**的形态 ——
  // 别把 `\.\.` 当成错误（第一版断言就写错过）。
  ok(re === "^\\.\\./proj/(utils|pages)", "拼出的正则形态正确（点已转义）", re);
  // 关键：这个正则必须能真的匹配上 depcruise 报的那种相对路径
  ok(new RegExp(re).test(rel + "/utils/a.js"), "能匹配目标项目下的文件", rel + "/utils/a.js");
  ok(!new RegExp(re).test(rel + "/data/a.js"), "不会匹配到别的目录", "");
  ok(escapeRe("a.b+c") === "a\\.b\\+c", "正则元字符被转义", escapeRe("a.b+c"));
}

// ── ② 真实建图 ──
console.log("\n[2] 真实建图：源码目录进图，数据目录不进");
let g = null;
{
  const out = join(TMP, "graph.json");
  g = await buildGraph({
    cwd: REPO, target: PROJ,
    sourceDirs: ["app.js", "utils", "pages", "components", "cloudfunctions"],
    outFile: out, depcruiseBin,
  });
  ok(g.ok === true, "建图成功", g.ok ? (g.ms + " ms") : g.error);
  ok(Array.isArray(g.modules) && g.modules.length > 0, "有模块", (g.modules || []).length + " 个");
  ok(g.modules.includes("utils/request.js"), "utils/request.js 在图上", "");
  ok(g.modules.includes("pages/board/board.js"), "pages/board/board.js 在图上", "");
  ok(g.modules.includes("cloudfunctions/fn/index.js"),
    "**cloudfunctions 在图上**（§十E.5① 它是最常改的业务代码，不能排除）", "");
  ok(!g.modules.some((m) => m.startsWith("data/")),
    "**data/ 不在图上**（include-only 把它挡在外面）", g.modules.filter((m) => m.startsWith("data/")).join(",") || "(无)");
  ok(g.edges.length > 0, "有边", g.edges.length + " 条");
  ok(g.edges.some((e) => e.from === "app.js" && e.to === "utils/data-store.js"),
    "边方向正确（from 依赖 to）", JSON.stringify(g.edges.slice(0, 2)));
}

// ── ③ 反向闭包 ──
console.log("\n[3] 反向闭包：改一个文件，波及哪些文件");
{
  const rev = reverseIndex(g.edges);
  const { closure } = reverseClosure(["utils/request.js"], rev);
  ok(closure.has("utils/data-store.js"), "直接依赖它的进闭包", [...closure].join(","));
  ok(closure.has("app.js"), "**间接依赖的也进闭包**（传递）", "");
  ok(closure.has("pages/board/board.js"), "pages 的也进", "");
  ok(closure.has("components/card/card.js"), "components 的也进", "");
  ok(!closure.has("utils/request.js"), "闭包不含自己", closure.has("utils/request.js") ? "含了" : "不含");
  // 深浅分层
  const r2 = reverseClosure(["utils/request.js"], rev);
  ok(r2.byDepth.size >= 2, "能分出深度层次（d1 直接、d2 间接）",
    [...r2.byDepth.entries()].map(([d, a]) => "d" + d + ":" + a.length).join(" "));
}

// ── ④ 深度上限 ──
console.log("\n[4] 深度上限：" + CLOSURE_DEPTH + " 层内，不会无限跑");
{
  // 造一条长链 a0 → a1 → ... → a20（反向：a0 依赖 a1，改 a0 波及 a1..a20？）
  // 反过来的说法：a0 被 a1 依赖，改 a0 波及 a1、a2 ……
  const edges = [];
  for (let i = 0; i < 20; i++) edges.push({ from: "a" + (i + 1) + ".js", to: "a" + i + ".js" });
  const rev = reverseIndex(edges);
  const deep = reverseClosure(["a0.js"], rev);
  ok(deep.closure.size === CLOSURE_DEPTH, "只走 " + CLOSURE_DEPTH + " 层（不是 20 层）", deep.closure.size + " 个");
  const shallow = reverseClosure(["a0.js"], rev, 3);
  ok(shallow.closure.size === 3, "可指定更浅的深度", shallow.closure.size + " 个");
}

// ── ⑤ addsEdges 并入（§十A.1 的核心）──
console.log("\n[5] addsEdges 并入：这是「图过期漏判」的修法");
{
  const base = [{ from: "app.js", to: "utils/data-store.js" }];
  const merged = mergeAddsEdges(base, [{ from: "utils/request.js", to: "utils/retry.js" }]);
  ok(merged.length === 2, "多了一条边", merged.length + " 条");
  ok(merged.some((e) => e.added === true), "新增的边有标记（可追溯）", "");
  ok(base.length === 1, "**原数组没被改**（不是原地修改）", base.length + " 条");
  // 重复的边不重复加
  const dup = mergeAddsEdges(merged, [{ from: "utils/request.js", to: "utils/retry.js" }]);
  ok(dup.length === 2, "重复的边不重复加", dup.length + " 条");
  // 残缺的边丢掉
  const bad = mergeAddsEdges(base, [{ from: "a.js" }, { to: "b.js" }, null]);
  ok(bad.length === 1, "残缺/空条目被丢掉", bad.length + " 条");
  ok(bad[0].added === undefined, "原有边不带 added 标记", "");
}

// ── ⑥ addsEdges 真的能改变闭包结论（端到端）──
console.log("\n[6] 端到端：并入 addsEdges 后，闭包能覆盖「还没建的边」");
{
  // 现状：request.js 不依赖 retry.js，所以改 request.js 波及不到 retry.js
  const before = reverseClosure(["utils/request.js"], reverseIndex(g.edges));
  ok(!before.closure.has("utils/retry.js"), "并边之前：闭包里没有 retry.js", [...before.closure].join(","));

  // A 报「我要新增 request.js → retry.js」
  const merged = mergeAddsEdges(g.edges, [{ from: "utils/request.js", to: "utils/retry.js" }]);
  const after = reverseClosure(["utils/request.js"], reverseIndex(merged));
  ok(!after.closure.has("utils/retry.js"),
    "⚠️ 注意：反向闭包仍不含 retry.js —— 因为 retry 是 request 的**下游**，不是上游", "");

  // 真正要看的是「改 retry.js 会不会波及到 request.js」——那才是冲突
  const revMerged = reverseIndex(merged);
  const hit = reverseClosure(["utils/retry.js"], revMerged);
  ok(hit.closure.has("utils/request.js"),
    "**改 retry.js 会波及 request.js**（并入新边后能看见）—— 这就是原方案会漏的那个场景",
    [...hit.closure].join(","));
}

// ── ⑦ 落盘 / 读回 ──
console.log("\n[7] 图落盘与读回");
{
  const f = join(TMP, "saved.json");
  saveGraph(f, { target: PROJ, modules: g.modules, edges: g.edges, ms: g.ms });
  ok(existsSync(f), "文件写出来了", "");
  const back = loadGraph(f);
  ok(back && back.modules.length === g.modules.length, "读回模块数一致", back ? back.modules.length + " 个" : "读不到");
  ok(back.edges.length === g.edges.length, "边数一致", back.edges.length + " 条");
  ok(back.target === PROJ, "记录了目标项目", back.target);
  ok(!existsSync(f + ".tmp." + process.pid), "没有残留 .tmp", "");
  ok(loadGraph(join(TMP, "nope.json")) === null, "文件不存在 → null（不抛）", "");
  writeFileSync(join(TMP, "bad.json"), "{ 坏 JSON", "utf8");
  ok(loadGraph(join(TMP, "bad.json")) === null, "坏文件 → null（不抛）", "");
}

// ── ⑧ 缺依赖时明确报错 ──
console.log("\n[8] 前置条件缺失时明确报错，不静默");
{
  const r = await buildGraph({ cwd: REPO, target: PROJ, sourceDirs: ["utils"], outFile: join(TMP, "x.json"), depcruiseBin: join(TMP, "nope.mjs") });
  ok(r.ok === false && /dependency-cruiser/.test(r.error), "找不到 depcruise → 明确报错", r.error.slice(0, 60));
  const r2 = await buildGraph({ cwd: REPO, target: join(TMP, "no-proj"), sourceDirs: ["utils"], outFile: join(TMP, "x.json"), depcruiseBin });
  ok(r2.ok === false && /不存在/.test(r2.error), "目标项目不存在 → 明确报错", r2.error.slice(0, 60));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
