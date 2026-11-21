// 调派入口（架构文档步骤 4 / §六、§十B.1）。
//
// 一次调派的完整链路：
//
//   agent 报意图（files + willUse）
//        ↓
//   ① 校验意图（0-b 的 validateIntent）
//        ↓
//   ② 建图 / 复用图 → 算反向影响面
//   ③ 把 willUse 算进影响面（防「这次会牵动的新文件」漏判）
//        ↓
//   ④ R1/R2/R3 图外规则（.wxml/.wxss/app.json）
//        ↓
//   ⑤ 查锁表 + 加锁（**必须在同一段队列内**，§十E.1）
//        ↓
//   放行 / 排队（带冲突说明）
//
// 这个模块**只做判定与占锁**，不负责跑 agent —— 跑 agent 是工作台的事。
// 这样它能被单独测，不依赖浏览器/SSE。

import { buildGraph, reverseIndex, reverseClosure } from "./graph.mjs";
import { applyOffGraphRules, offGraphConflict, GRAPH_EXTS } from "./offgraph.mjs";
import { validateIntent } from "./intent.mjs";
import { conflictFiles } from "./locks.mjs";

/**
 * 算出「改这些文件会牵动哪些文件」（含 `willUse` 带来的额外影响）。
 *
 * ⚠️ 语义（2026-11-21 从 `addsEdges` 改成 `willUse` 后简化了）：
 *
 *   `willUse` 就是「这次动手还会用到这些文件」。
 *   把它直接**并进我的影响面**即可 —— 不需要再伪造一条带方向的边。
 *
 *   初版用的是 `addsEdges: [{from,to}]`，然后费劲去算「并边后闭包怎么变」，
 *   还因为方向搞反踩过一次坑（见架构文档 §A.3）。改成 `willUse` 之后，
 *   那段绕路整个消失了 —— **因为它本来就是「我的影响面包含这些」的意思**。
 */
export function computeClosure({ files, willUse, edges }) {
  const rev = reverseIndex(edges || []);
  // 只拿图里存在的文件当种子（.wxml 这类不在图里，交给 R3）
  const seeds = (files || []).filter((f) => GRAPH_EXTS.has(extOf(f)));
  const { closure } = reverseClosure(seeds, rev);
  // willUse 直接算进影响面
  //
  // ⚠️ 加一层形态防御：`willUse` 应该是**字符串数组**，但旧调用方可能还传
  //    `[{from,to}]`（`addsEdges` 的形状）。直接 `f.startsWith` 会抛 TypeError，
  //    而这种错会整条调派链崩掉 —— 一个格式问题不该让调度停摆。
  for (const raw of willUse || []) {
    if (!raw) continue;
    const f = typeof raw === "string" ? raw : (raw.to || raw.file || raw.path || "");
    if (f && !f.startsWith("node_modules")) closure.add(f);
  }
  return { closure, usedWillUse: (willUse || []).length };
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

  // ② / ③ 算影响面（含 willUse）
  let closure = new Set();
  let graphErr = "";
  if (off.graphFiles.length) {
    const g = await grapher();
    if (g && g.ok) {
      const c = computeClosure({ files: off.graphFiles, willUse: intent.willUse, edges: g.edges });
      closure = c.closure;
    } else {
      // ⚠️ 拿不到图时**不能当作没冲突放行**。降级为「只靠 R1/R2/R3 + 文件相等」，
      //    并把原因带出去，让人知道这次判定是弱化的。
      graphErr = (g && g.error) || "拿不到依赖图";
    }
  } else if (intent.willUse && intent.willUse.length) {
    // 没有 .js 要算、连图都不用建时，willUse 仍然要算进影响面
    for (const f of intent.willUse) if (f) closure.add(f);
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
      usedWillUse: (intent.willUse || []).length,
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
    if (result.usedWillUse) parts.push("还会用到 " + result.usedWillUse + " 个别的文件");
    if (result.graphDegraded) parts.push("⚠️ 降级：" + result.graphDegraded);
    return parts.join(" · ");
  }
  if (result.decision === "queue") {
    const n = (result.conflicts || []).length;
    return "排队（与 " + n + " 个任务冲突）";
  }
  return "拒绝：" + (result.reason || "");
}
