// scripts/lib/context.mjs — 喂给 AI 的上下文。
// 渲染器要把这份数据内联进页面，命令行工具也要用它生成可粘贴的文本。
// 只有一份实现，避免两处逻辑漂移。

import { esc, laneByKey, openIndexLines, severityOf } from "./parts.mjs";

const EV_KIND_LABEL = {
  command: "命令",
  file: "文件",
  value: "实测值",
  url: "链接",
  commit: "提交",
};

function fmtDate(iso) {
  return iso ? String(iso).slice(0, 16).replace("T", " ") : "";
}

function fmtSections(item) {
  return (item.sections || []).map((s) => `【${s.label}】${s.text}`).join("\n\n");
}

function fmtEvidence(item) {
  const ev = item.evidence || [];
  if (!ev.length) return "（这条没有留下证据线索）";
  return ev
    .map((e) => {
      if (typeof e === "string") return `- ${e}`;
      const kind = EV_KIND_LABEL[e.kind] || e.kind || "说明";
      return `- ${kind}：${e.text}`;
    })
    .join("\n");
}

// 单条条目的变量表：页面和命令行共用
export function itemVars(config, ledger, item) {
  const lane = laneByKey(config, item.lane);
  const sev = severityOf(lane, item);
  return {
    project: ledger.project.name,
    id: item.id,
    title: item.title,
    laneLabel: lane.label,
    statusLabel: (lane.statusLabels && lane.statusLabels[item.status]) || item.status,
    severityText: sev ? `（严重度：${sev.label}）` : "",
    area: item.area || "未标注",
    updatedAt: fmtDate(item.updatedAt),
    sections: fmtSections(item),
    evidence: fmtEvidence(item),
  };
}

// 整本台账的索引与未收口清单
export function boardContext(config, ledger, skills) {
  const items = {};
  for (const item of ledger.items) {
    const v = itemVars(config, ledger, item);
    v.copyText = `【${v.id}】${v.title}\n状态：${v.statusLabel}${v.severityText}\n区域：${v.area}\n更新：${v.updatedAt}\n\n${v.sections}\n\n证据：\n${v.evidence}`;
    items[item.id] = v;
  }

  const openLines = openIndexLines(config, ledger);
  const openList = openLines
    .map(
      (l) =>
        `- ${l.id}（${[l.sev, l.status].filter(Boolean).join("·")}）${l.title}${l.area ? " —— " + l.area : ""}`
    )
    .join("\n");

  const index = ledger.items
    .map((i) => {
      const lane = laneByKey(config, i.lane);
      const st = (lane.statusLabels && lane.statusLabels[i.status]) || i.status;
      return `- ${i.id}｜${lane.label}｜${st}｜${i.area || "-"}｜${i.title}`;
    })
    .join("\n");

  // Skill 页的「问 AI」要用：三组 skill 的精简信息（名 / 版本 / 路径 / 说明头一句）。
  // 说明只留第一句，整段描述太长，会淹掉真正的任务。
  const brief = (s) => ({
    name: s.name,
    version: s.version || "",
    agentCreated: Boolean(s.agentCreated),
    title: s.title || "",
    path: s.path || "",
    desc: String(s.description || "").split(/[。.！!\n]/)[0].slice(0, 120),
    sessions: s.sessions || 0,
    total: s.total || 0,
    lastAt: s.lastAt || null,
    hits: s.hits || 0,
    inFrontmatter: Boolean(s.inFrontmatter),
  });
  const skillCtx = skills
    ? {
        project: skills.project || "",
        projectNames: skills.projectNames || [],
        updatedAt: skills.updatedAt || "",
        used: (skills.used || []).map(brief),
        produced: (skills.produced || []).map(brief),
        related: (skills.related || []).map(brief),
      }
    : { project: "", projectNames: [], updatedAt: "", used: [], produced: [], related: [] };

  return {
    project: ledger.project.name,
    updatedAt: fmtDate(ledger.updatedAt),
    totalCount: ledger.items.length,
    openCount: openLines.length,
    openList: openList || "（没有未收口的条目）",
    index,
    systemPrompt: (config.ask && config.ask.systemPrompt) || "",
    // 只有「单条台账」这套动作走配置，所以名字里带 item。
    // 整本台账、整页 skill、单条 skill 的动作都写在 client.js 里，因为它们的
    // prompt 必须点名作用域（只改这一个文件 / 总结整本并写回台账），
    // 让项目配置去覆盖只会把作用域改坏。
    //
    // 旧名字叫 quick，看着像「所有快捷动作都归它管」，实际只作用于单条——
    // 改名就是为了让这件事在字段名上就能看出来。
    itemQuick: (config.ask && config.ask.itemQuick) || [],
    skills: skillCtx,
    items,
  };
}

// 把 systemPrompt 模板填满。focusItemId 为空表示"在看整本台账"。
export function buildSystemPrompt(ctx, focusItemId) {
  let focus;
  if (!focusItemId) {
    focus = "用户在看整本台账，没有指定某一条。回答时可以点出具体编号。";
  } else {
    const it = ctx.items[focusItemId];
    if (!it) {
      focus = "用户在看整本台账，没有指定某一条。";
    } else {
      focus =
        "用户正在看这一条，回答优先围绕它：\n\n" +
        `编号：${it.id}\n标题：${it.title}\n车道：${it.laneLabel}　状态：${it.statusLabel}${it.severityText}\n区域：${it.area}\n最近更新：${it.updatedAt}\n\n` +
        `四段记录：\n${it.sections}\n\n留下的证据：\n${it.evidence}`;
    }
  }
  return String(ctx.systemPrompt)
    .replace(/\{\{project\}\}/g, ctx.project)
    .replace(/\{\{updatedAt\}\}/g, ctx.updatedAt)
    .replace(/\{\{totalCount\}\}/g, ctx.totalCount)
    .replace(/\{\{openCount\}\}/g, ctx.openCount)
    .replace(/\{\{openList\}\}/g, ctx.openList)
    .replace(/\{\{index\}\}/g, ctx.index)
    .replace(/\{\{focus\}\}/g, focus);
}
