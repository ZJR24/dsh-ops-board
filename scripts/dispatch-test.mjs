// 调派入口（§六 / §十B.1 / §十A.1）。
//
// 这一层把前面所有东西串起来：意图校验 → 建图 → 影响面 → willUse → 图外规则 → 锁
//
// ⚠️ 术语（2026-11-21 用户指出这是通用插件）：对外一律用白话。
//    `addsEdges`（图论概念）已改成 `willUse`（「还会用到这些文件」）。
//    这个文件的**注释可以**提旧名以便追溯，但断言和报文一律用 willUse。
// → 图外规则 → 查锁加锁 → 放行/排队。
//
// 测试要覆盖六种真实情形：
//   ① 干净的任务能拿到锁
//   ② 两个任务撞同一文件 → 第二个被排队并说明冲突
//   ③ **willUse 造成的漏判** —— 不报时放行、报了才挡住
//   ④ 图外文件（.wxml）通过 R1 挡人
//   ⑤ app.json 通过 R2 挡人
//   ⑥ **拿不到图时不能当作没冲突放行**（降级要标明）
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLockTable } from "./lib/locks.mjs";
import { requestDispatch, releaseDispatch, computeClosure, describeDispatch } from "./lib/dispatch.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

const TMP = mkdtempSync(join(tmpdir(), "dispatch-test-"));
let clock = Date.parse("2026-11-21T10:00:00.000Z");
const now = () => clock;

function freshLocks() {
  const f = join(TMP, "locks-" + Math.random().toString(36).slice(2, 7) + ".json");
  const t = createLockTable({ locksPath: f, now });
  t.load();
  return t;
}

// 假图：
//   app.js → utils/data-store.js → utils/request.js
//   pages/board/board.js → utils/data-store.js
const EDGES = [
  { from: "app.js", to: "utils/data-store.js" },
  { from: "utils/data-store.js", to: "utils/request.js" },
  { from: "pages/board/board.js", to: "utils/data-store.js" },
];
const grapher = () => Promise.resolve({ ok: true, modules: [], edges: EDGES });

const mkIntent = (files, willUse) => ({ ok: true, files, willUse: willUse || [], raw: "", error: "" });

// ── ① 干净任务 ──
console.log("[1] 干净任务：拿到锁、给出波及面");
{
  const locks = freshLocks();
  const r = await requestDispatch({ locks, intent: mkIntent(["utils/request.js"]), owner: "A", task: "修超时", grapher });
  ok(r.decision === "go", "放行", describeDispatch(r));
  ok(r.lock && r.lock.lockId, "拿到锁", r.lock ? r.lock.lockId : "无");
  ok(r.closure.includes("utils/data-store.js"), "波及面含直接依赖方", r.closure.join(","));
  ok(r.closure.includes("app.js"), "波及面含间接依赖方", "");
  ok(/放行/.test(describeDispatch(r)) && /波及/.test(describeDispatch(r)), "摘要可读", describeDispatch(r));
}

// ── ② 撞车 ──
console.log("\n[2] 撞同一文件：第二个排队并说明冲突");
{
  const locks = freshLocks();
  const a = await requestDispatch({ locks, intent: mkIntent(["utils/request.js"]), owner: "A", task: "A 的活", grapher });
  const b = await requestDispatch({ locks, intent: mkIntent(["utils/request.js"]), owner: "B", task: "B 的活", grapher });
  ok(a.decision === "go", "A 放行", "");
  ok(b.decision === "queue", "**B 被排队**", describeDispatch(b));
  ok(b.conflicts && b.conflicts.length > 0, "给出冲突来源", JSON.stringify(b.conflicts));
  ok(b.conflicts[0].owner === "A", "指出和谁冲突", b.conflicts[0].owner);
}

// ── ③ willUse 造成的漏判（核心）──
console.log("\n[3] willUse：不报时放行 → 报了才挡住（漏判的核心验证）");
{
  // 场景：A 要改 request.js 并**新增**依赖 retry.js；B 要改 retry.js
  // 图中原本没有 request.js → retry.js 这条边
  const locks = freshLocks();
  const a = await requestDispatch({
    locks, owner: "A", task: "让 request 走 retry",
    intent: mkIntent(["utils/request.js"], [{ from: "utils/request.js", to: "utils/retry.js" }]),
    grapher,
  });
  ok(a.decision === "go", "A 放行", describeDispatch(a));
  ok(a.usedWillUse === 1, "记录了 1 个会额外用到的文件", a.usedWillUse + " 个");
  ok(a.closure.includes("utils/retry.js"),
    "**A 的波及面里出现了 retry.js**（并边之后才算得出来）", a.closure.join(","));

  const b = await requestDispatch({ locks, owner: "B", task: "改 retry", intent: mkIntent(["utils/retry.js"]), grapher });
  ok(b.decision === "queue", "**B 被挡住**（不并边的话这里会放行 → 漏判）", describeDispatch(b));

  // 对照：如果不报 willUse
  const locks2 = freshLocks();
  await requestDispatch({ locks: locks2, owner: "A", task: "不报新增依赖", intent: mkIntent(["utils/request.js"]), grapher });
  const b2 = await requestDispatch({ locks: locks2, owner: "B", task: "改 retry", intent: mkIntent(["utils/retry.js"]), grapher });
  ok(b2.decision === "go", "⚠️ 不报 willUse 时 B **会被放行** —— 这就是漏判", describeDispatch(b2));
}

// ── ④ 图外文件（R1）──
console.log("\n[4] 图外文件：改 .wxml 挡住改 .js（依赖图看不见的那种）");
{
  const locks = freshLocks();
  const a = await requestDispatch({ locks, owner: "A", task: "改视图", intent: mkIntent(["pages/board/board.wxml"]), grapher });
  ok(a.decision === "go", "A 放行", describeDispatch(a));
  ok(a.addedByR1.length > 0, "R1 自动补入了同组件文件", a.addedByR1.join(","));
  const b = await requestDispatch({ locks, owner: "B", task: "改逻辑", intent: mkIntent(["pages/board/board.js"]), grapher });
  ok(b.decision === "queue", "**B 被挡住**（同一组件）", describeDispatch(b));
}

// ── ⑤ app.json（R2）──
console.log("\n[5] app.json：改注册会挡住改页面");
{
  const locks = freshLocks();
  const a = await requestDispatch({ locks, owner: "A", task: "加页面", intent: mkIntent(["app.json"]), grapher });
  ok(a.decision === "go", "A 放行", describeDispatch(a));
  const b = await requestDispatch({ locks, owner: "B", task: "改页面", intent: mkIntent(["pages/board/board.js"]), grapher });
  ok(b.decision === "queue", "**B 被挡住**", describeDispatch(b));
}

// ── ⑥ 拿不到图：降级但不能当真无冲突 ──
console.log("\n[6] 拿不到依赖图：降级为弱判定，并明确标出来");
{
  const locks = freshLocks();
  const badGrapher = () => Promise.resolve({ ok: false, error: "depcruise 挂了" });
  const a = await requestDispatch({ locks, owner: "A", task: "x", intent: mkIntent(["utils/request.js"]), grapher: badGrapher });
  ok(a.decision === "go", "仍然放行（不能因为图挂了就完全停摆）", describeDispatch(a));
  ok(a.graphDegraded === "depcruise 挂了", "**明确标出这是降级判定**", a.graphDegraded);
  ok(/降级/.test(describeDispatch(a)), "摘要里也写明了", describeDispatch(a));
  ok(a.closure.length === 0, "没有闭包（只能靠文件相等/图外规则）", a.closure.length + " 个");

  // 降级时同一文件仍要挡住（文件相等不依赖图）
  const b = await requestDispatch({ locks, owner: "B", task: "y", intent: mkIntent(["utils/request.js"]), grapher: badGrapher });
  ok(b.decision === "queue", "**降级状态下同一文件仍然挡住**", describeDispatch(b));
}

// ── ⑦ 意图不合法 ──
console.log("\n[7] 意图不合法：直接拒绝，不占锁");
{
  const locks = freshLocks();
  const r = await requestDispatch({ locks, owner: "A", task: "x", intent: { ok: true, files: [], willUse: [] }, grapher });
  ok(r.decision === "reject", "空 files → 拒绝", r.reason);
  ok(locks._count() === 0, "**没有占锁**", locks._count() + " 把");
  const r2 = await requestDispatch({ locks, owner: "A", task: "x", intent: mkIntent(["C:/abs.js"]), grapher });
  ok(r2.decision === "reject", "绝对路径 → 拒绝", r2.reason);
}

// ── ⑧ 释放后别人能拿 ──
console.log("\n[8] 释放后别人能拿到");
{
  const locks = freshLocks();
  const a = await requestDispatch({ locks, owner: "A", task: "x", intent: mkIntent(["utils/request.js"]), grapher });
  const b1 = await requestDispatch({ locks, owner: "B", task: "y", intent: mkIntent(["utils/request.js"]), grapher });
  ok(b1.decision === "queue", "B 先被挡", "");
  const rel = await releaseDispatch({ locks, lockId: a.lock.lockId, owner: "A" });
  ok(rel.ok === true, "A 释放成功", "");
  const b2 = await requestDispatch({ locks, owner: "B", task: "y", intent: mkIntent(["utils/request.js"]), grapher });
  ok(b2.decision === "go", "**B 现在能拿到了**", describeDispatch(b2));
}

// ── ⑨ 不相干的任务能并行 ──
console.log("\n[9] 不相干的任务：可以同时进行");
{
  const locks = freshLocks();
  const a = await requestDispatch({ locks, owner: "A", task: "x", intent: mkIntent(["utils/request.js"]), grapher });
  const b = await requestDispatch({ locks, owner: "B", task: "y", intent: mkIntent(["docs/readme.md"]), grapher });
  ok(a.decision === "go" && b.decision === "go", "两个都放行", a.decision + " / " + b.decision);
  ok(locks._count() === 2, "两把锁", locks._count() + " 把");
}

// ── ⑩ computeClosure 单测 ──
console.log("\n[10] computeClosure：willUse 直接算进影响面");
{
  const c1 = computeClosure({ files: ["utils/request.js"], willUse: [], edges: EDGES });
  ok(!c1.closure.has("utils/retry.js"), "不报 willUse：影响面里没有 retry", "");
  ok(c1.closure.has("utils/data-store.js"), "但依赖图里真实存在的上游仍算进来", [...c1.closure].join(","));
  const c2 = computeClosure({ files: ["utils/request.js"], willUse: ["utils/retry.js"], edges: EDGES });
  ok(c2.usedWillUse === 1, "记录了 1 个会额外用到的文件", c2.usedWillUse + " 个");
  ok(c2.closure.has("utils/retry.js"),
    "**willUse 直接进了影响面**（不用伪造方向边）", [...c2.closure].join(","));
  // 防御：旧格式（对象数组）不该让调派崩掉
  const c3 = computeClosure({ files: ["utils/request.js"], willUse: [{ from: "x", to: "utils/retry.js" }], edges: EDGES });
  ok(c3.closure.has("utils/retry.js"), "旧格式 {from,to} 也认（不让一个格式问题搞崩调度）", [...c3.closure].join(","));
  // node_modules 不该进影响面（那是依赖，不是项目文件）
  const c4 = computeClosure({ files: ["utils/request.js"], willUse: ["node_modules/x/y.js"], edges: EDGES });
  ok(!c4.closure.has("node_modules/x/y.js"), "node_modules 不进来", "");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);