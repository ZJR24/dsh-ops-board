// scripts/lib/workbench.mjs — 工作台编排（纯计算，不碰状态）
//
// 工作台要解决的是「从选中的未收口条目里，编排出一条能跑的顺序」。
// 两条路线：
//   并行（parallel）：优先把不同区域（area 前缀）的活同时铺开，
//                    同区域仍互斥、排队 —— 机器不越过 flow.mjs 的约束。
//   串行（serial）： 把选中件排成一条确定执行的顺序，给出「为什么这样
//                    排」的建议。
//
// ⚠️ 核心判据和 flow.mjs 完全同源：同 area 前缀 = 抢同一块地 = 必须串行。
// 这里不再另写一套「什么是冲突」，直接复用 flow.mjs 的 areaPrefix。
// 排序对某一块地内部的先后沿用 flow.mjs 的规则（阶段步序 → id），
// 这样「图怎么说、工作台怎么排」不会打架。

import { areaPrefix } from "./flow.mjs";

/** stageIndex 拉平：状态 → (阶段序, 阶段对象)。和 flow.mjs 同一逻辑。 */
function stageIndex(lane) {
  const m = new Map();
  lane.stages.forEach((st, i) => {
    for (const s of st.statuses) m.set(s, { index: i, stage: st });
  });
  return m;
}

/**
 * 分析选中、且未收口的条目，返回「串行 / 并行」两种编排建议。
 *
 * @param {object} config       看板配置
 * @param {object} ledger       台账
 * @param {Set<string>} selected 选中的条目 id（未收口）
 * @param {string[]} [ordered]  人工给出的顺序（拖动排列）。
 *        提供时，串行在**同区域仍保持链序**的前提下（同块地不能跳着做），
 *        跨区域的交错顺序采纳调用方拖的顺序；不提供时回落成旧的自动分组。
 * @returns {{ ok, error?, serial: [{id,title,prefix,why}], parallel: [{id,title,prefix,round,why}] }}
 */
export function planWorkbench(config, ledger, selected, ordered) {
  const sel = selected instanceof Set ? selected : new Set(selected || []);
  const items = (ledger.items || []).filter((i) => sel.has(i.id));
  if (!items.length) return { ok: false, error: "没有选中条目" };

  // ── 规整：给每条补上前缀 / 阶段序（和 buildFlow 用的同源规则）──
  const nodes = items.map((it) => {
    const lane = (config.lanes || []).find((l) => l.key === it.lane);
    const idx = lane ? stageIndex(lane) : new Map();
    const si = idx.get(it.status) || { index: -1, stage: null };
    return {
      id: it.id,
      title: it.title,
      laneKey: it.lane,
      laneLabel: lane ? lane.label : it.lane,
      status: it.status,
      statusLabel: (lane && lane.statusLabels && lane.statusLabels[it.status]) || it.status,
      step: si.index,
      stepLabel: si.stage ? si.stage.label : "未分类",
      area: it.area || "",
      prefix: areaPrefix(it.area),
    };
  });

  // 同区域内部排序：阶段步序在前 → id；与 flow 定头一致
  const byPrefix = new Map();
  for (const n of nodes) {
    if (!byPrefix.has(n.prefix)) byPrefix.set(n.prefix, []);
    byPrefix.get(n.prefix).push(n);
  }
  for (const [, g] of byPrefix) g.sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));

  // ── 串行建议 ──
  // 给了 ordered：按人拖的顺序，但每块区域内部保持链序（同块地不能跳着做）；
  // 没给：回落成旧的分块自动排序。
  const serial = Array.isArray(ordered) && ordered.length
    ? serialByDrag(nodes, byPrefix, ordered)
    : serialAuto(byPrefix);

  // ── 并行建议：分「轮」，同一轮里的活互不抢地 ──
  // 做法：每轮从「还没排完的区域」里各取它当前的第一件 —— 直到全部排完。
  // 严格保证同一轮里没有两个同前缀条目（并行互斥）。这是贪心，足以给出
  // 一个「能同时开几路」的序列；它不试图当最优调度器（那超出看板范围）。
  const parallel = [];
  const pending = [...byPrefix.entries()].map(([prefix, group]) => ({ prefix, idx: 0, group }));
  let round = 1;
  while (pending.length) {
    const thisRound = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const n = p.group[p.idx];
      thisRound.push({
        id: n.id,
        title: n.title,
        prefix: n.prefix,
        round,
        why: p.idx === 0 ? `「${n.prefix}」的头一件` : `「${n.prefix}」队列第 ${p.idx + 1} 件（等同区域前件）`,
      });
      p.idx += 1;
      if (p.idx >= p.group.length) pending.splice(i, 1);
    }
    parallel.push(...thisRound);
    round += 1;
  }

  return {
    ok: true,
    total: nodes.length,
    prefixes: byPrefix.size,
    maxParallel: byPrefix.size, // 同轮最多能开几路
    serial,
    parallel,
  };
}

/**
 * 按「看板手动分批」出批次：调用方已经把 dragPool 切成若干批（每批=可并行的一组），
 * 这里只负责给每批里的每张卡补齐元数据（title/prefix/status/stepLabel/reason），
 * 不做自动拆串/并行——批次是用户（看板）定的，引擎只执行、不越权重排。
 *
 * @param {object} config   看板配置
 * @param {object} ledger   台账
 * @param {string[][]} batches 手动分的批，每批是一组卡 id（保持用户拖的顺序）
 * @returns {{ ok, total, batches:[{reason, cards:[{id,title,prefix,status,stepLabel}]}] }}
 */
export function planBatches(config, ledger, batches) {
  const items = (ledger.items || []).filter(Boolean);
  const byId = new Map(items.map((i) => [i.id, i]));
  const outBatches = [];
  let total = 0;
  batches.forEach((ids, bi) => {
    const cards = [];
    for (const id of (ids || [])) {
      const it = byId.get(id);
      if (!it) continue; // 不在台账里的卡（已被收口/删除）跳过
      const lane = (config.lanes || []).find((l) => l.key === it.lane);
      const idx = lane ? stageIndex(lane) : new Map();
      const si = idx.get(it.status) || { index: -1, stage: null };
      cards.push({
        id: it.id,
        title: it.title,
        prefix: it.area ? areaPrefix(it.area) : "",
        status: it.status,
        statusLabel: (lane && lane.statusLabels && lane.statusLabels[it.status]) || it.status,
        stepLabel: si.stage ? si.stage.label : "未分类",
      });
    }
    if (!cards.length) return;
    outBatches.push({
      index: bi,
      // reason 只描述「这是用户分的第几批」，不再让引擎猜语义
      reason: cards.length > 1 ? "看板手动分为一批（可并行，Agent 自主规划批内）" : "看板手动分为一批（单卡）",
      cards,
    });
    total += cards.length;
  });
  return { ok: total > 0, total, batches: outBatches };
}

/** 旧的自动分组串行：同区域排成连着的一段，段按步序排序。 */
function serialAuto(byPrefix) {
  const serial = [];
  const groups = [...byPrefix.entries()].sort(
    (a, b) => a[1][0].step - b[1][0].step || a[0].localeCompare(b[0])
  );
  for (const [prefix, group] of groups) {
    group.forEach((n, i) => {
      const prev = i > 0 ? group[i - 1].id : null;
      serial.push({
        id: n.id,
        title: n.title,
        prefix,
        why: prev
          ? `同区域「${prefix}」须先做 ${prev}`
          : group.length > 1
            ? `这是「${prefix}」的第一步`
            : `独立区域「${prefix}」`,
      });
    });
  }
  return serial;
}

/**
 * 按「人拖的顺序」出串行，但绝不越过区域链序：
 * 每块区域的条目，内部必须保持 chain 序（step → id）——即使有人把后件拖到前件前面，
 * 步到那里时也先把挡住它的同区前件排出来（真实执行时同块地就是要等前件做完）。
 * 跨区域则完全采纳拖动顺序（那是可以自由调的调度自由度）。
 */
function serialByDrag(nodes, byPrefix, ordered) {
  const selected = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const used = new Set();
  const result = [];

  function push(n) {
    const prev = result.length ? result[result.length - 1] : null;
    result.push({
      id: n.id,
      title: n.title,
      prefix: n.prefix,
      why: prev && prev.prefix === n.prefix
        ? `同区域「${n.prefix}」须先做 ${prev.id}`
        : prev
          ? `按你拖的顺序，接着 ${prev.id} 之后`
          : `你排的第一件（区域「${n.prefix}」）`,
    });
    used.add(n.id);
  }

  for (const oid of ordered) {
    if (!byId.has(oid) || used.has(oid) || !selected.has(oid)) continue;
    const n = byId.get(oid);
    const chain = byPrefix.get(n.prefix);
    // 把该区域里「排在 n 之前、还没排、且挡住了 n」的前件先排掉（链序约束）。
    // 只推 oid 自己之前的那些，不能把后面的也提前。
    for (const c of chain) {
      if (c.id === oid) break;
      if (used.has(c.id) || !selected.has(c.id)) continue;
      push(c); // 同区前件，必须先于它
    }
    push(n);
  }
  // 兜底：ordered 没覆盖到的已选项（理论上不会）按链序追加
  for (const [, chain] of byPrefix) {
    for (const c of chain) if (selected.has(c.id) && !used.has(c.id)) push(c);
  }
  return result;
}