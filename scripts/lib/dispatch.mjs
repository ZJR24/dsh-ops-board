// 调派入口（架构文档步骤 4 / §六、§十B.1）。
//
// 一次调派的完整链路：
//
//   agent 报意图（files + addsEdges）
//        ↓
//   ① 校验意图（0-b 的 validateIntent）
//        ↓
//   ② 建图 / 复用图 → 算反向闭包
//   ③ 把 addsEdges 并入图再算一遍（§十A.1：防「新加的边」漏判）
//        ↓
//   ④ R1/R2/R3 图外规则（.wxml/.wxss/app.json）
//        ↓
//   ⑤ 查锁表 + 加锁（**必须在同一段队列内**，§十E.1）
//        ↓
//   放行 / 排队（带冲突说明）
//
// 这个模块**只做判定与占锁**，不负责跑 agent —— 跑 agent 是工作台的事。
// 这样它能被单独测，不依赖浏览器/SSE。

import { buildGraph, reverseIndex, reverseClosure, mergeAddsEdges } from "./graph.mjs";
import { applyOffGraphRules, offGraphConflict, GRAPH_EXTS } from "./offgraph.mjs";
import { validateIntent } from "./intent.mjs";
import { conflictFiles } from "./locks.mjs";

/**
 * 算出「改这些文件会波及哪些文件」（含 addsEdges 的影响）。
 *
 * ⚠️ 方向很关键，这里踩过一次坑（2026-11-21）：
 *
 *   反向闭包 closure(f) = 「谁依赖 f」= 改 f 会波及谁。
 *
 *   所以：
 *     · 闭包(A) 里有 X  →  改 A 会影响 X     → B 要改 X 就冲突 ✅
 *     · 闭包(A) 里没有 X，但 A 依赖 X（正向下游）→ 改 A 碰不到 X，
 *       可是**改 X 会碰到 A** —— 这要靠「闭包(X) 含 A」来表达，
 *       不是靠「闭包(A) 含 X」。
 *
 *   把 addsEdges 并进图只是让**边变多**；真正起作用的机制是：
 *   并入 `A → retry` 之后，`闭包(retry)` 里就多了 A（以及 A 的上游），
 *   于是 B 要改 retry 时，它自己的闭包会与 A 的 files 相交 → 挡住。
 *
 * 这里的 `closure` 返回值只表示「A 的波及面」，**不承担**上面那条判据 ——
 * 那条由 `locks.conflictFiles` 的双向比对负责。
 */
export function computeClosure({ files, addsEdges, edges }) {
  const merged = mergeAddsEdges(edges || [], addsEdges || []);
  const added = (merged.length - (edges || []).length);
  const rev = reverseIndex(merged);
  // 只拿图里存在的文件当 seed（.wxml 这类不在图里，交给 R3）
  const seeds = (files || []).filter((f) => GRAPH_EXTS.has(extOf(f)));
  const { closure } = reverseClosure(seeds, rev);
  return { closure, edges: merged, usedAdds: added };
}

function extOf(p) {
  const s = String(p || "");
  const i = s.lastIndexOf(".");
  const j = s.lastIndexOf("/");
  if (i < 0 || i < j) return "";
  return s.slice(i).toLowerCase();
}

/**
 * 申请一次调派。
 *
 * @param opts.locks        createLockTable() 的实例
 * @param opts.intent       extractIntent() 的结果
 * @param opts.owner        agent 标识
 * @param opts.task         任务描述（给人看）
 * @param opts.grapher      () => Promise<{ok, modules, edges}>  取图（可缓存，由调用方决定）
 * @param opts.ttlSec       锁 TTL
 * @returns { ok, decision:"go"|"queue"|"reject", lock?, conflicts?, closure?, reason? }
 */
export async function requestDispatch({ locks, intent, owner, task, grapher, ttlSec }) {
  // ① 校验意图
  const v = validateIntent(intent);
  if (!v.ok) {
    return { ok: false, decision: "reject", reason: v.error, stage: "intent" };
  }

  // ④ 图外规则先算（它不需要图，且能提前挡掉「同一组件的文件」）
  const off = applyOffGraphRules(intent.files);

  // ② / ③ 算闭包（含 addsEdges）
  let closure = new Set();
  let graphErr = "";
  let mergedEdges = null;
  if (off.graphFiles.length) {
    const g = await grapher();
    if (g && g.ok) {
      const c = computeClosure({ files: off.graphFiles, addsEdges: intent.addsEdges, edges: g.edges });
      closure = c.closure;
      mergedEdges = c.edges;
    } else {
      // ⚠️ 拿不到图时**不能当作没冲突放行**。降级为「只靠 R1/R2/R3 + 文件相等」，
      //    并把原因带出去，让人知道这次判定是弱化的。
      graphErr = (g && g.error) || "拿不到依赖图";
    }
  }

  // ⚠️ 关键一步（2026-11-21 踩过）：`addsEdges` 的效果**不在「A 的闭包变大」**上。
  //
  //   并边 A→retry 之后，闭包(A) 仍然不含 retry（retry 是 A 的下游，不是上游）。
  //   真正发生变化的是**闭包(retry)** —— 它现在含 A 及其上游。
  //
  //   所以 A 占锁时，闭包里必须**额外把 addsEdges 的 to 端算进去**，
  //   否则 B 要改 retry 时，B 的闭包虽然含 A，但 A 锁里既没有 retry 也没有
  //   一条「我在用 retry」的痕迹 —— 比对只能靠 B.closure ∩ A.files，
  //   而 A.files 里也没有 retry。
  //
  //   把 to 端加入 A 的闭包，判据立刻成立：
  //     B.files(retry) ∩ A.closure(含 retry) ≠ ∅ → 挡住。
  if (mergedEdges && intent.addsEdges && intent.addsEdges.length) {
    for (const e of intent.addsEdges) {
      if (e && e.to && !e.to.startsWith("node_modules")) closure.add(e.to);
    }
  }

  // ⑤ 申请锁：查冲突 + 加锁 在同一段队列内（由 locks.acquire 保证）
  //
  // ⚠️ 但锁表只懂「文件/闭包相交」，不懂 R2 的**目录语义**
  //   （改 app.json 会牵动整个 pages/）。那层语义在这里补：
  //   先拿现存锁里的 files 做一次 R1/R2/R3 比对，有冲突就直接排队，
  //   不占用新锁。
  const existing = locks.list();
  for (const l of existing) {
    if (l.owner === owner) continue;
    const why = offGraphConflict(intent.files, l.files || []);
    if (why.length) {
      return {
        ok: false,
        decision: "queue",
        reason: why[0],
        conflicts: [{ lockId: l.lockId, owner: l.owner, task: l.task, files: why }],
        closure: [...closure].sort(),
        graphDegraded: graphErr || null,
      };
    }
  }

  const want = {
    files: [...off.files],
    closure: [...closure],
  };
  const got = await locks.acquire({
    owner,
    task: task || "",
    files: want.files,
    closure: want.closure,
    ttlSec,
  });

  if (got.ok) {
    return {
      ok: true,
      decision: "go",
      lock: got.lock,
      closure: [...closure].sort(),
      // 让调用方能看到「这次是因为什么被放行」——图外规则补进来的文件也要交代
      addedByR1: [...off.addedByR1].sort(),
      usedAddsEdges: (intent.addsEdges || []).length,
      graphDegraded: graphErr || null,
    };
  }

  // 锁表说冲突 —— 但锁表只知道「files/closure 相交」，不知道 R2 的目录语义。
  // 所以冲突说明要补一层：如果对方动了 app.json、你动的是 pages/，要说清楚。
  return {
    ok: false,
    decision: "queue",
    reason: "与正在进行的任务冲突",
    conflicts: got.conflicts || [],
    closure: [...closure].sort(),
    graphDegraded: graphErr || null,
  };
}

/**
 * 释放一次调派占的锁。
 */
export async function releaseDispatch({ locks, lockId, owner }) {
  return locks.release(lockId, owner);
}

/**
 * 把「意图」转成给人看的摘要（放到界面/日志里）。
 */
export function describeDispatch(result) {
  if (!result) return "";
  if (result.decision === "go") {
    const parts = ["放行"];
    if (result.closure && result.closure.length) parts.push("波及 " + result.closure.length + " 个文件");
    if (result.addedByR1 && result.addedByR1.length) parts.push("同组件补入 " + result.addedByR1.length);
    if (result.usedAddsEdges) parts.push("含 " + result.usedAddsEdges + " 条新增依赖");
    if (result.graphDegraded) parts.push("⚠️ 降级：" + result.graphDegraded);
    return parts.join(" · ");
  }
  if (result.decision === "queue") {
    const n = (result.conflicts || []).length;
    return "排队（与 " + n + " 个任务冲突）";
  }
  return "拒绝：" + (result.reason || "");
}
