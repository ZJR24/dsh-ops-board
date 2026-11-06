// scripts/lib/parts.mjs — 把台账数据变成 HTML 片段。
// 这里只做"翻译"，不做业务判断；所有可变的部分都从 board.config.json 读。
// 类名与 css.mjs 一一对应（照报纸体例）。

const EV_KIND_LABEL = {
  command: "命令",
  file: "文件",
  value: "实测值",
  url: "链接",
  commit: "提交",
};

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 「问 AI」有没有被关掉。关掉时面板不渲染，所有入口按钮也不该渲染 ——
// 留一个点了没反应的按钮比没有按钮更糟。
export function askOff(config) {
  return Boolean(config && config.ask && config.ask.enabled === false);
}

export function viewId(key) {
  return "view-" + String(key).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

// ── 派生查询 ──

export function laneByKey(config, key) {
  return config.lanes.find((l) => l.key === key) || null;
}

export function stageOfStatus(lane, status) {
  return lane.stages.find((s) => s.statuses.includes(status)) || null;
}

export function itemsOfLane(ledger, laneKey) {
  return ledger.items.filter((i) => i.lane === laneKey);
}

export function severityOf(lane, item) {
  if (!lane.severity || !item.severity) return null;
  return lane.severity.levels.find((l) => l.key === item.severity) || null;
}

export function sevRank(lane, item) {
  if (!lane.severity) return 99;
  const i = lane.severity.levels.findIndex((l) => l.key === item.severity);
  return i === -1 ? 99 : i;
}

export function sortItems(lane, items) {
  const arr = [...items];
  if (lane.rankBySeverity) {
    arr.sort((a, b) => {
      const d = sevRank(lane, a) - sevRank(lane, b);
      if (d !== 0) return d;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
  } else {
    arr.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }
  return arr;
}

export function countOfLane(lane, items) {
  const out = {};
  for (const st of lane.stages) {
    out[st.key] = items.filter((i) => st.statuses.includes(i.status)).length;
  }
  return out;
}

export function openCountOfLane(lane, items) {
  const openStages = lane.stages.filter((s) => s.open);
  return items.filter((i) => openStages.some((s) => s.statuses.includes(i.status))).length;
}

export function isClosedLaneItem(lane, item) {
  const st = stageOfStatus(lane, item.status);
  return st ? !st.open : false;
}

export function priorityItems(config, ledger, limit) {
  const all = [];
  for (const lane of config.lanes) {
    const openStages = lane.stages.filter((s) => s.open);
    for (const item of itemsOfLane(ledger, lane.key)) {
      if (!openStages.some((s) => s.statuses.includes(item.status))) continue;
      all.push({ lane, item, rank: sevRank(lane, item) });
    }
  }
  all.sort((a, b) => a.rank - b.rank);
  return all.slice(0, limit);
}

// ── 小片段 ──

export function chip(text, tone, solid) {
  return `<span class="chip${solid ? " chip-solid" : ""} t-${tone || "muted"}">${esc(text)}</span>`;
}

function statusChip(lane, item) {
  const st = stageOfStatus(lane, item);
  const label = (lane.statusLabels && lane.statusLabels[item.status]) || item.status;
  return chip(label, st ? st.tone : "muted");
}

function severityChip(lane, item) {
  const sev = severityOf(lane, item);
  if (!sev) return "";
  return chip(sev.label, sev.tone, true);
}

function toneOfItem(lane, item) {
  const sev = severityOf(lane, item);
  if (sev) return sev.tone;
  const st = stageOfStatus(lane, item);
  return st ? st.tone : "muted";
}

function fmtDate(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 16).replace("T", " ");
}

// ── 侧栏 ──

// 原版每节标题左边有个小箭头（.rail-fold），点它把这一节正文折起来，
// 标题留在吸顶堆里；标题文字本身也带一个跳转按钮（.rail-head-jump）。
function railFold(bodyId, title) {
  return `<button class="rail-fold" type="button" aria-expanded="true" aria-controls="${esc(bodyId)}" aria-label="收起 ${esc(title)}" title="收起这一节"></button>`;
}

// 标题 + 计数放进同一个 flex 容器里，并允许换行：窄侧栏时计数掉到第二行，
// 而不是把标题挤成一个字（原版的 .rail-head-jump 就是这个作用）。
function railHead(titleHtml, countsLine) {
  return `<div class="rail-head-jump"><span class="rail-title">${titleHtml}</span><span class="rail-counts">（${countsLine}）</span></div>`;
}

// 原版的那个「收起明细」：在被收起的明细列表上方那一行
// （左「最近 N 条」，右一个下划线文字按钮），只收这一块里的明细列表，
// 阶段格子和统计数字还留着。文案与 aria 都跟原版一致。
function miniToggle(listId) {
  return `<button class="rail-mini-toggle" type="button" aria-expanded="true" aria-controls="${esc(listId)}">收起明细</button>`;
}

export function railLanePanel(config, ledger, lane) {
  const items = itemsOfLane(ledger, lane.key);
  const counts = countOfLane(lane, items);
  const openN = openCountOfLane(lane, items);
  const total = items.length;

  const countsLine = lane.stages
    .map((s) => `${esc(s.label)} <b>${counts[s.key]}</b>`)
    .join(" | ");
  const grid = lane.stages
    .map(
      (s) =>
        `<a href="#stage-${lane.key}-${s.key}" title="跳到 ${esc(s.label)} 分节"><span class="stage-num">${counts[s.key]}</span><span class="stage-label">${esc(s.label)}</span></a>`
    )
    .join("");

  const openStages = lane.stages.filter((s) => s.open);
  const top = sortItems(
    lane,
    items.filter((i) => openStages.some((s) => s.statuses.includes(i.status)))
  ).slice(0, 3);

  const miniId = `rail-${lane.key}-mini`;
  const mini =
    top.length === 0
      ? `<div class="rail-mini-head"><span class="rail-note">当前没有未收口的${esc(lane.countNoun)}。</span></div>`
      : `<div class="rail-mini-head">
      <span class="rail-note">共 ${total} 个${esc(lane.countNoun)} · 优先看这 ${top.length} 条</span>
      ${miniToggle(miniId)}
    </div>
    <ul class="mini-list" id="${esc(miniId)}">${top
      .map((i) => `<li><a href="#${esc(i.id)}">${esc(i.title)}</a>${statusChip(lane, i)}</li>`)
      .join("")}</ul>`;

  // 侧栏这块标题可以点，直接打开对应车道那一页 —— 侧栏是索引，不该只能看不能进
  const laneView = (config.views || []).find((v) => v.kind === "lane" && v.lane === lane.key);
  const titleHtml = laneView
    ? `<a class="rail-title-link" href="#${viewId(laneView.key)}" title="打开「${esc(lane.label)}」页">${esc(lane.label)}</a>`
    : esc(lane.label);

  const bodyId = `rail-${lane.key}-body`;
  return `<section class="panel" data-panel="${esc("lane-" + lane.key)}">
  <h3>${railFold(bodyId, lane.label)}${railHead(titleHtml, countsLine)}</h3>
  <div class="panel-body" id="${esc(bodyId)}">
    <div class="stage-total"><span class="stage-total-num">${openN}</span><span class="stage-total-label">${esc(lane.openNoun)}</span></div>
    <div class="stage-table" style="grid-template-columns:repeat(${lane.stages.length},1fr)">${grid}</div>
    ${mini}
  </div>
</section>`;
}

export function railPriorityPanel(config, ledger) {
  const limit = (config.priority && config.priority.limit) || 3;
  const top = priorityItems(config, ledger, limit);
  const bodyId = "rail-priority-body";
  if (!top.length) {
    return `<section class="panel" data-panel="priority"><h3>${railFold(bodyId, config.priority.label)}${railHead(esc(config.priority.label), "没有未收口的条目")}</h3><div class="panel-body" id="${esc(bodyId)}"><p class="rail-note">没有未收口的条目。</p></div></section>`;
  }
  const list = top
    .map(
      ({ lane, item }) =>
        `<li><a href="#${esc(item.id)}">${esc(item.title)}</a>${severityChip(lane, item) || statusChip(lane, item)}</li>`
    )
    .join("");
  const miniId = "rail-priority-mini";
  return `<section class="panel" data-panel="priority"><h3>${railFold(bodyId, config.priority.label)}${railHead(esc(config.priority.label), `前 ${top.length} 条`)}</h3><div class="panel-body" id="${esc(bodyId)}">
    <div class="rail-mini-head"><span class="rail-note">优先看这 ${top.length} 条</span>${miniToggle(miniId)}</div>
    <ul class="mini-list" id="${esc(miniId)}">${list}</ul>
  </div></section>`;
}

export function railMetricsPanel(config, ledger) {
  const ms = ledger.metrics || [];
  if (!ms.length) return "";
  // 合法 status 由 board.config.json 的 metricStatuses 声明（默认四档）。
  // 台账里写了表外的值就回落到 muted，别让一个笔误把配色拼成不存在的 class。
  const allowed = Array.isArray(config.metricStatuses) && config.metricStatuses.length
    ? config.metricStatuses
    : ["ok", "warn", "danger", "muted"];
  const statusOf = (m) => {
    const s = String(m.status || "").trim();
    return allowed.includes(s) ? s : "muted";
  };
  const list = ms
    .map(
      (m) => `<li class="metric metric-${esc(statusOf(m))}">
      <span class="metric-label">${esc(m.label)}</span><span class="metric-value">${esc(m.value)}</span>
      <span class="metric-note">${esc(m.note || "")}</span>
    </li>`
    )
    .join("");
  const miniId = "rail-metrics-mini";
  const bodyId = "rail-metrics-body";
  return `<section class="panel" data-panel="metrics"><h3>${railFold(bodyId, config.labels.metricsTitle)}${railHead(esc(config.labels.metricsTitle), `${ms.length} 项`)}</h3><div class="panel-body" id="${esc(bodyId)}">
    <div class="rail-mini-head"><span class="rail-note">共 ${ms.length} 项</span>${miniToggle(miniId)}</div>
    <ul class="metrics" id="${esc(miniId)}">${list}</ul>
  </div></section>`;
}

export function railSnapshotPanel(config, ledger) {
  const s = ledger.snapshot;
  if (!s) return "";
  const rows = [
    ["分支", s.branch],
    ["提交", s.commit],
    ["线上包", s.onlinePackage],
    ["部署", s.deploy ? fmtDate(s.deploy) : ""],
    ["测试", s.tests],
  ].filter(([, v]) => v);
  const list = rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("");
  const miniId = "rail-snapshot-mini";
  const bodyId = "rail-snapshot-body";
  return `<section class="panel" data-panel="snapshot"><h3>${railFold(bodyId, config.labels.snapshotTitle)}${railHead(esc(config.labels.snapshotTitle), `${rows.length} 项`)}</h3><div class="panel-body" id="${esc(bodyId)}">
    <div class="rail-mini-head"><span class="rail-note">共 ${rows.length} 项</span>${miniToggle(miniId)}</div>
    <ul class="snapshot" id="${esc(miniId)}">${list}</ul>
  </div></section>`;
}

// ── 条目卡片 ──

export function itemCard(config, lane, item) {
  const tone = toneOfItem(lane, item);
  const sections = (item.sections || [])
    .map((s) => `<section><h4>${esc(s.label)}</h4><p>${esc(s.text)}</p></section>`)
    .join("");

  const ev = (item.evidence || [])
    .map((e) => {
      const kind = typeof e === "string" ? "value" : e.kind || "value";
      const text = typeof e === "string" ? e : e.text;
      return `<li><span class="ev-kind">${esc(EV_KIND_LABEL[kind] || kind)}</span><span class="ev-text">${esc(text)}</span></li>`;
    })
    .join("");

  const metaBits = [item.area, fmtDate(item.updatedAt)].filter(Boolean).map(esc).join(" · ");

  return `<article class="card lv-${tone}" id="${esc(item.id)}">
  <div class="card-head">
    <span class="id">${esc(item.id)} ${severityChip(lane, item)} ${statusChip(lane, item)}</span>
    <span class="meta">${metaBits}</span>
  </div>
  <h3>${esc(item.title)}</h3>
  <div class="sections">${sections}</div>
  ${ev ? `<div class="evidence"><b>证据</b><ul>${ev}</ul></div>` : ""}
  <div class="card-acts">
    ${askOff(config) ? "" : `<button class="btn btn-ask" type="button" data-ask="${esc(item.id)}">问 AI</button>`}
    <button class="btn" type="button" data-copy="${esc(item.id)}">${esc(config.labels.copyButton)}</button>
  </div>
</article>`;
}

// ── 表格 ──

export function itemTable(config, lane, items) {
  const h = config.labels.tableHeaders;
  const hasSev = !!lane.severity;
  const rows = items
    .map((i) => {
      const sev = severityChip(lane, i);
      return `<tr>
      <td class="id-cell">${esc(i.id)}</td>
      ${hasSev ? `<td>${sev || '<span class="muted">—</span>'}</td>` : ""}
      <td class="title-cell"><a href="#${esc(i.id)}">${esc(i.title)}</a></td>
      <td>${statusChip(lane, i)}</td>
      <td class="muted">${esc(i.area || "")}</td>
      <td class="muted">${esc(fmtDate(i.updatedAt))}</td>
    </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table>
  <thead><tr>
    <th>${esc(h.id)}</th>${hasSev ? `<th>${esc(h.severity)}</th>` : ""}<th>${esc(h.title)}</th><th>${esc(h.status)}</th><th>${esc(h.area)}</th><th>${esc(h.updated)}</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

// ── 分节 ──

export function stageBlock(config, lane, stage, items) {
  const list = sortItems(lane, items.filter((i) => stage.statuses.includes(i.status)));

  // 已收口的阶段只留一行摘要并给个跳转，卡片在「已修复 / 已关闭 / 暂停」页渲染。
  // 这样两页内容不重叠，同一个条目 id 在整页里只出现一次，hash 跳转不会撞车。
  let body;
  if (!stage.open && list.length) {
    body = `<p class="stage-tail">这 ${list.length} 项已收口，卡片都在 <a href="#${viewId("closed")}">已修复 / 已关闭 / 暂停</a> 页。</p>`;
  } else if (!list.length) {
    body = `<p class="stage-empty">这一阶段暂时没有${esc(lane.countNoun)}。</p>`;
  } else {
    body = list.map((i) => itemCard(config, lane, i)).join("");
  }

  return `<section class="detail-group" id="stage-${lane.key}-${stage.key}">
  <div class="section-head"><h2>${esc(stage.label)}</h2><span>${list.length} 项</span></div>
  ${body}
</section>`;
}

export function stageBoard(lane, items) {
  const counts = countOfLane(lane, items);
  const openN = openCountOfLane(lane, items);
  const cells = lane.stages
    .map(
      (s) =>
        `<a class="stage-board-cell" href="#stage-${lane.key}-${s.key}"><b>${counts[s.key]}</b><span>${esc(s.label)}</span></a>`
    )
    .join("");
  return `<div class="stage-board">
  <div class="stage-board-total"><span class="stage-board-num">${openN}</span><span class="stage-board-label">${esc(lane.openNoun)}</span></div>
  <div class="stage-board-table" style="grid-template-columns:repeat(${lane.stages.length},1fr)">${cells}</div>
</div>`;
}

export function legend(config, lane) {
  const lanes = lane ? [lane] : config.lanes;
  const seen = new Map();
  for (const l of lanes) {
    for (const st of l.stages) {
      for (const status of st.statuses) {
        if (seen.has(status)) continue;
        const label = (l.statusLabels && l.statusLabels[status]) || status;
        seen.set(status, chip(label, st.tone));
      }
    }
  }
  if (!seen.size) return "";
  return `<div class="legend-line"><span>状态：</span>${[...seen.values()].join("")}</div>`;
}

// ── 处理记录 ──

// 记录类型：文案与配色跟原版 render-report.mjs 的 HISTORY_KINDS 一致。
const HISTORY_KINDS = {
  found: { label: "发现", tone: "danger" },
  fixed: { label: "修复", tone: "ok" },
  feature: { label: "功能", tone: "info" },
  ops: { label: "运维", tone: "warn" },
  deploy: { label: "部署", tone: "indigo" },
};
const KIND_OTHER = { label: "记录", tone: "muted" };

function kindMeta(kind) {
  return HISTORY_KINDS[kind] || KIND_OTHER;
}

export function historyList(entries, onlyPrefixes, options = {}) {
  let list = entries;
  if (onlyPrefixes && onlyPrefixes.length) {
    list = entries.filter((h) => onlyPrefixes.some((p) => String(h.text || "").includes(p + "-")));
  }
  if (!list.length) return `<p class="stage-empty">还没有相关记录。</p>`;

  const showKind = options.showKind !== false;
  const sorted = list
    .slice()
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));

  // 类型计数按出现顺序排；未知类型归到「记录」。
  const counts = {};
  for (const h of sorted) {
    const key = HISTORY_KINDS[h.kind] ? h.kind : "other";
    counts[key] = (counts[key] || 0) + 1;
  }
  const order = [
    ...Object.keys(HISTORY_KINDS).filter((k) => counts[k]),
    ...(counts.other ? ["other"] : []),
  ];
  // 只有一个类型时不值得给筛选条（原版 also 只在 > 1 时可筛）。
  const filterable = showKind && order.length > 1;

  const legend = filterable
    ? `<div class="legend-line history-kinds" data-history-filter>
      <span>类型：</span>
      <button class="kind-chip is-active" type="button" data-kind="all" aria-pressed="true">全部 <b>${sorted.length}</b></button>
      ${order
        .map((key) => {
          const meta = kindMeta(key);
          return `<button class="kind-chip t-${meta.tone}" type="button" data-kind="${esc(key)}" aria-pressed="false">${esc(meta.label)} <b>${counts[key]}</b></button>`;
        })
        .join("")}
    </div>`
    : "";

  const items = sorted
    .map((h) => {
      const key = HISTORY_KINDS[h.kind] ? h.kind : "other";
      const meta = kindMeta(key);
      return `<li class="tl-${esc(key)}" data-kind="${esc(key)}">
      <time>${esc(fmtDate(h.at))}${showKind ? ` <span class="kind-chip t-${meta.tone}">${esc(meta.label)}</span>` : ""}</time>
      <p>${esc(h.text)}</p>
    </li>`;
    })
    .join("");

  return `${legend}<ol class="timeline">${items}</ol>`;
}

export function highlights(ledger) {
  const hl = ledger.highlights || [];
  if (!hl.length) return "";
  const KIND_LABEL = { feature: "功能", fixed: "修复", watch: "观察", risk: "风险", ops: "运维" };
  const list = hl
    .map((h) => {
      const tone = { feature: "info", fixed: "ok", watch: "warn", risk: "danger", ops: "warn" }[h.kind] || "muted";
      return `<li>${chip(KIND_LABEL[h.kind] || h.kind || "记录", tone)}<span>${esc(h.text)}</span></li>`;
    })
    .join("");
  return `<ul class="highlight-list">${list}</ul>`;
}

export function actionsList(config, ledger) {
  const limit = (config.priority && config.priority.limit) || 3;
  const top = priorityItems(config, ledger, limit);
  if (!top.length) return `<p class="stage-empty">当前没有需要立刻处理的事项。</p>`;
  return `<ol class="actions">${top
    .map(
      ({ lane, item }) =>
        `<li><a href="#${esc(item.id)}">${esc(item.title)}</a> ${severityChip(lane, item) || chip(lane.label, "muted")}</li>`
    )
    .join("")}</ol>`;
}

// ── 侧栏待办迷你清单（供 AI 全局上下文复用） ──

export function openIndexLines(config, ledger) {
  const lines = [];
  for (const lane of config.lanes) {
    const openStages = lane.stages.filter((s) => s.open);
    const items = sortItems(
      lane,
      itemsOfLane(ledger, lane.key).filter((i) =>
        openStages.some((s) => s.statuses.includes(i.status))
      )
    );
    for (const i of items) {
      const sev = severityOf(lane, i);
      lines.push({
        id: i.id,
        lane: lane.label,
        status: (lane.statusLabels && lane.statusLabels[i.status]) || i.status,
        sev: sev ? sev.label : "",
        area: i.area || "",
        title: i.title,
      });
    }
  }
  return lines;
}
