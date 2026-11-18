// scripts/lib/flow.mjs — 把台账推导成「可视化工作流」需要的图数据
//
// 设计要点（依据 docs/research-notes.md §11–§13）：
//   1. 不引入任何画布库。ops-board 是零依赖字符串拼 HTML，加 React Flow 等于前端重写。
//   2. 并行度不靠人工声明，从 area 前缀推导：同前缀 = 改同一块东西 = 必须串行。
//   3. **冲突与并行度必须按全台账算，不能按 lane 各算一套**（见下方 buildFlow 注释）。
//   4. 状态只读台账，不推导第二套（amux 通病 5 的教训）。
//
// 这张图回答三个问题：
//   · 现在能同时开工的有几件？（并行度）
//   · 哪几件抢同一块地，只能排队？（冲突组）
//   · 每件卡在哪一步、下一步是什么？（阶段与出边）

/** 哪些状态算「还在手上」 */
const OPEN_STATUSES = new Set([
  "open",
  "doing",
  "verify",
  "watch",
  "planned",
  "review",
  "watching",
  "mitigating",
]);

/** area 的第一个层级，作为「并行通道」的判据 */
export function areaPrefix(area) {
  return String(area || "").split("/")[0].trim() || "(未分区域)";
}

/** 这条是否未收口 */
export function isOpenItem(item) {
  return OPEN_STATUSES.has(item.status);
}

/** 把 lane 的阶段表拉平成一个线性步序，用来算「处在第几步」 */
function stageIndex(lane) {
  const m = new Map();
  lane.stages.forEach((st, i) => {
    for (const s of st.statuses) m.set(s, { index: i, stage: st });
  });
  return m;
}

/**
 * 构建流程图数据。
 *
 * ⚠️ 核心不变量：**同 area 前缀的未收口条目，无论属于哪个车道，都抢同一块地。**
 * 实测某看板：OPS-022 / OPS-025（问题）与 FEAT-014（需求）
 * 前缀都是「免费额度」，改的是同一条数据链路。
 * 若按 lane 各算一套，会得出「bug 2 路 + feature 1 路 = 3 路并行」，
 * 实际这 3 件只能 1 件先跑 —— 高估并行度会让真的并行时互相踩。
 * 所以：全局建节点 → 全局定头 → 再按 lane 分组渲染。
 *
 * @param {object} config  看板配置
 * @param {object} ledger  台账
 * @param {Set<string>} [claimed] 已被领走的 id。被领走的不再是「头」，
 *        它的位置让给同区域的下一件 —— 否则串行泳道永远卡在第一件上。
 */
export function buildFlow(config, ledger, claimed) {
  const held = claimed instanceof Set ? claimed : new Set();
  const out = { lanes: [], totals: { open: 0, parallelNow: 0, serialized: 0 } };
  const items = ledger.items || [];
  const allOpen = items.filter(isOpenItem);

  // ── 第一步：全局建节点（跨车道一起建，才能正确判冲突）──
  const nodes = allOpen.map((it) => {
    const lane = (config.lanes || []).find((l) => l.key === it.lane);
    const idx = lane ? stageIndex(lane) : new Map();
    const si = idx.get(it.status) || { index: -1, stage: null };
    return {
      id: it.id,
      laneKey: it.lane,
      laneLabel: lane ? lane.label : it.lane,
      title: it.title,
      status: it.status,
      statusLabel: (lane && lane.statusLabels && lane.statusLabels[it.status]) || it.status,
      tone: si.stage ? si.stage.tone : "muted",
      step: si.index,
      stepLabel: si.stage ? si.stage.label : "未分类",
      area: it.area || "",
      prefix: areaPrefix(it.area),
      severity: it.severity || "",
    };
  });

  // ── 第二步：全局分组与定头 ──
  const byPrefix = new Map();
  for (const n of nodes) {
    if (!byPrefix.has(n.prefix)) byPrefix.set(n.prefix, []);
    byPrefix.get(n.prefix).push(n);
  }

  for (const [, group] of byPrefix) {
    // 排序规则：阶段步序靠前的先做；同序按 id 稳定排，避免每次渲染顺序漂移。
    group.sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));
    // 已经被领走的排到队尾：它们的「头」身份已经用掉了，
    // 同区域下一件要能顶上来，否则一条泳道只能做一件。
    const live = group.filter((n) => !held.has(n.id));
    const taken = group.filter((n) => held.has(n.id));
    const queue = [...live, ...taken];
    queue.forEach((n, i) => {
      // 冲突：同前缀的其他未收口条目（跨车道）
      n.blocks = group.filter((o) => o.id !== n.id).map((o) => o.id);
      // 可并行：前缀不同的所有未收口条目（跨车道）
      n.parallelWith = nodes
        .filter((o) => o.id !== n.id && o.prefix !== n.prefix)
        .map((o) => o.id);
      n.isClaimed = held.has(n.id);
      // 全局只有一个头：该前缀里还没被领走的、排第一的那件
      n.isHead = i === 0 && !n.isClaimed;
      // ⚠️ 等的是**紧邻的前一件**，不是队首。
      // 说「等队首」在语义上不算错（整条链都得等它），但图上画的是
      // 上一件指向下一件的箭头，文字和箭头指向不同目标会让人以为图错了。
      n.waitFor = i === 0 ? "" : queue[i - 1].id;
      // 队首单独记一份：UI 想显示「整条链在等谁」时用得到
      n.chainHead = queue[0].id;
    });
  }

  // ── 第三步：按车道组装视图 ──
  for (const lane of config.lanes || []) {
    const laneItems = items.filter((i) => i.lane === lane.key);
    const laneNodes = nodes.filter((n) => n.laneKey === lane.key);

    // 本车道的轨道：每个前缀一条
    const laneByPrefix = new Map();
    for (const n of laneNodes) {
      if (!laneByPrefix.has(n.prefix)) laneByPrefix.set(n.prefix, []);
      laneByPrefix.get(n.prefix).push(n);
    }

    const tracks = [...laneByPrefix.entries()]
      .map(([prefix, group]) => {
        const globalN = (byPrefix.get(prefix) || []).length;
        // ⚠️ 必须按和定头相同的规则排序（阶段步序 → id），
        // 否则画出来的第一行不是「头」，用户会看到「排在前面的是排队中、
        // 排在后面的才可开工」，跟判定逻辑对不上。
        group.sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));
        return {
          prefix,
          items: group,
          openCount: group.length,
          // 全局同前缀数量：决定「串行」标记与标签上的件数
          globalCount: globalN,
          serial: globalN > 1,
          // 本车道在这条轨道上有几件是头（跨车道同前缀只有一件是头）
          headHere: group.filter((n) => n.isHead).length,
        };
      })
      .sort((a, b) => b.openCount - a.openCount || a.prefix.localeCompare(b.prefix));

    const steps = lane.stages.map((st) => ({
      key: st.key,
      label: st.label,
      tone: st.tone,
      open: !!st.open,
      count: laneItems.filter((i) => st.statuses.includes(i.status)).length,
      openCount: laneNodes.filter((n) => st.statuses.includes(n.status)).length,
    }));

    const headCount = laneNodes.filter((n) => n.isHead).length;

    out.lanes.push({
      key: lane.key,
      label: lane.label,
      total: laneItems.length,
      open: laneNodes.length,
      steps,
      tracks,
      parallelism: {
        // 并行上限 = 本车道有几条不同的地；现在能动的 = 有几件是全局头
        max: tracks.length,
        now: headCount,
        serialized: tracks.filter((t) => t.serial).length,
        waiting: laneNodes.length - headCount,
      },
    });

    out.totals.open += laneNodes.length;
    out.totals.parallelNow += headCount;
  }

  // 需要排队的泳道按**前缀去重**：同一块地在多条车道各出现一次，只算一条
  out.totals.serialized = [...byPrefix.values()].filter((g) => g.length > 1).length;

  // ── 第四步：算节点图的像素坐标 ──
  out.graph = layoutGraph(byPrefix);

  // ── 第五步：大画布规划条的顺序 ──
  // 用户要「一块大规划区，自由拖卡片排流程」。这里给出**默认顺序**：
  // 同一块地的链保持连在一起（串行安全），前缀之间按块名排 —— 一个扁平的
  // 有序卡列表，界面不按区域分行。顺序即工作台执行顺序的初值。
  const canvas = [];
  [...byPrefix.keys()]
    .sort((a, b) => a.localeCompare(b))
    .forEach((prefix) => {
      // 沿用第二步的链序（阶段步序 → id），被领走的排到队尾
      const g = [...byPrefix.get(prefix)];
      g.sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));
      const live = g.filter((n) => !n.isClaimed);
      const taken = g.filter((n) => n.isClaimed);
      [...live, ...taken].forEach((n) => canvas.push({ id: n.id, title: n.title, status: n.status, statusLabel: n.statusLabel, state: n.isClaimed ? "claimed" : n.isHead ? "head" : "wait", waitFor: n.waitFor, tone: n.tone, stepLabel: n.stepLabel, prefix: n.prefix }));
    });
  out.canvas = canvas;
  return out;
}

// ── 节点图布局 ──
//
// **一行 = 一块地**（area 前缀）。行内箭头 = 「必须等前一件做完」。
// 行与行之间没有箭头 = 可以同时做。这就是「并行」的全部含义。
//
// 为什么行按前缀而不是按车道分组：同一块地可能横跨两条车道
// （实测「免费额度」同时有问题的 OPS-022/025 和需求的 FEAT-014）。
// 按车道分行会把一条串行链劈成两半，看起来像两条并行的路 —— 那是假的。
const NODE_W = 188;
const NODE_H = 88;
const GAP_X = 52; // 留给箭头的横向空隙
const ROW_GAP = 26;
const LABEL_H = 26; // 行标题占位
const PAD = 4;
// 顶部要留出行标题的高度：标题是 translateY(-100%) 浮在行上方的，
// 第一行的标题会跑到 y=0 以上，不给边距就被容器切掉。
const PAD_TOP = LABEL_H + 6;
// 长链收窄：链越长，单节点越窄，尽量让整条链一屏能看全。
// 实测某看板 tools 车道有 6 件，固定 188px 会宽到 1396px，必须横向拖动才能看全，
// 而「看全」正是这张图的全部价值。收到 140px 时 6 件约 1100px，配合滚动也够用。
const NODE_W_MIN = 132;
const WIDTH_BUDGET = 1120; // 期望一屏能容纳的宽度

/** 按最长链决定节点宽度：宁可窄一点，也别让人必须横向拖才能看懂 */
function nodeWidthFor(maxCount) {
  if (maxCount <= 1) return NODE_W;
  // 反解：maxCount * (w + GAP_X) - GAP_X <= WIDTH_BUDGET
  const fit = Math.floor((WIDTH_BUDGET + GAP_X) / maxCount) - GAP_X;
  return Math.max(NODE_W_MIN, Math.min(NODE_W, fit));
}

function layoutGraph(byPrefix) {
  // 行按「件数多的在前」排：最需要排队的冲突一眼就落在最上面
  const groups = [...byPrefix.entries()]
    .map(([prefix, group]) => ({ prefix, group }))
    .sort((a, b) => b.group.length - a.group.length || a.prefix.localeCompare(b.prefix));

  // 按最长链统一节点宽度：所有行用同一个宽度，看起来才整齐
  const maxCount = groups.reduce((m, g) => Math.max(m, g.group.length), 0);
  const w = nodeWidthFor(maxCount);

  const rows = [];
  let y = PAD_TOP;
  let maxRight = 0;

  for (const { prefix, group } of groups) {
    // group 在第二步已经按（阶段步序 → id）排好，这里直接按顺序摆
    const rowNodes = group.map((n, i) => ({
      ...n,
      x: PAD + i * (w + GAP_X),
      y: 0, // 相对行：行本身已经定位到 y
      w,
      h: NODE_H,
    }));

    const edges = [];
    for (let i = 0; i + 1 < rowNodes.length; i++) {
      edges.push({
        from: rowNodes[i].id,
        to: rowNodes[i + 1].id,
        // 箭头也是行内相对坐标；渲染时整条 SVG 按行平移
        x1: rowNodes[i].x + w,
        y1: NODE_H / 2,
        x2: rowNodes[i + 1].x,
        y2: NODE_H / 2,
      });
    }

    const lanes = [...new Set(rowNodes.map((n) => n.laneLabel))];
    rows.push({
      prefix,
      labelX: PAD,
      // 行标题浮在行的上方，所以这里只记「行首 y」
      startY: y + LABEL_H,
      nodes: rowNodes,
      edges,
      lanes,
      count: rowNodes.length,
      serial: rowNodes.length > 1,
      crossLane: lanes.length > 1,
    });

    const right = PAD + rowNodes.length * (w + GAP_X) - GAP_X;
    if (right > maxRight) maxRight = right;
    y += LABEL_H + NODE_H + ROW_GAP;
  }

  return {
    rows,
    width: maxRight + PAD,
    // 底部也要留边：最后一行没有额外间距，直接贴边会显得被切断。
    // 卡片高度自适应内容（标题再长也完整显示），底部多留缓冲，避免最后一行
    // 长标题的卡超出画布下缘被裁。
    height: Math.max(y - ROW_GAP + PAD, NODE_H + LABEL_H) + NODE_H,
    nodeW: w,
    nodeH: NODE_H,
    gapX: GAP_X,
  };
}
