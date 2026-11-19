// 分析窗口（planner）返回的「派活计划」：解析 → 校验 → 回退。
//
// 背景：原来「怎么分批、哪些卡会不会打架」是这里用 areaPrefix 硬算的
// （workbench.mjs planBatches）。现在改成先让一个对话窗口去判断，它回一段 JSON。
// 但**模型的输出不可信**，所以这一层是安全底线：
//   · 校验不过就整份丢弃、回退到确定性分组，绝不「部分采用」——
//     半对半错的计划比没有计划更危险（漏掉的卡会被静默不执行）。
//   · 唯一有安全含义的不变量是第 4 条：同一区域的卡可以被合进一个窗口（那就是串行，
//     安全），但绝不能拆进两个窗口——那会让两个窗口抢同一块地，靠 serve.mjs 的
//     claim 互斥硬挡，表现为某条路一直重试。必须在客户端就拦掉。
//
// 纯函数，不碰 DOM / 不碰网络，方便直接单测。

/** 从模型的回复里把 JSON 抠出来。容忍 ```json 围栏、前后说明文字。 */
export function extractPlanJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  // ① 优先找 ```json ... ``` 围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = planTryParse(fence[1]);
    if (parsed) return parsed;
  }
  // ② 整体就是 JSON
  const direct = planTryParse(raw);
  if (direct) return direct;
  // ③ 从第一个 { 到最后一个 } 之间抠（模型常在 JSON 前后加解释）
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const parsed = planTryParse(raw.slice(first, last + 1));
    if (parsed) return parsed;
  }
  return null;
}

function planTryParse(s) {
  try {
    const v = JSON.parse(String(s || "").trim());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 校验计划。
 * @param {object|null} plan       extractPlanJson 的结果
 * @param {string[]} selectedIds   用户勾选的卡 id（本次必须被完整覆盖）
 * @param {Map<string,string>} prefixOf  卡 id → area 前缀（用来查第 4 条）
 * @returns {{ok:boolean, lanes?:Array, note?:string, error?:string}}
 */
export function validatePlan(plan, selectedIds, prefixOf) {
  const ids = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
  if (!plan) return { ok: false, error: "分析窗口没有回可解析的 JSON 计划" };
  if (!Array.isArray(plan.lanes) || !plan.lanes.length) {
    return { ok: false, error: "计划里没有 lanes（或不是非空数组）" };
  }

  const want = new Set(ids);
  const seen = new Set();
  const keys = new Set();
  const lanes = [];

  for (let i = 0; i < plan.lanes.length; i++) {
    const la = plan.lanes[i];
    if (!la || typeof la !== "object") return { ok: false, error: "第 " + (i + 1) + " 条 lane 不是对象" };
    const key = String(la.key || "").trim();
    if (!key) return { ok: false, error: "第 " + (i + 1) + " 条 lane 没有 key（复用键）" };
    if (keys.has(key)) return { ok: false, error: "lane key 重复：「" + key + "」" };
    keys.add(key);

    const cardIds = Array.isArray(la.cardIds) ? la.cardIds.map(String).filter(Boolean) : [];
    if (!cardIds.length) return { ok: false, error: "lane「" + key + "」没有 cardIds" };

    const cards = [];
    for (const id of cardIds) {
      // 第 6 条：防 AI 编造 id
      if (!want.has(id)) return { ok: false, error: "lane「" + key + "」里有不存在的卡：" + id };
      // 第 3 条：不重复
      if (seen.has(id)) return { ok: false, error: "卡 " + id + " 被放进了多条 lane" };
      seen.add(id);
      cards.push(id);
    }

    lanes.push({
      key,
      prefix: String(la.prefix || key).trim() || key,
      cardIds,
      cards,
      why: String(la.why || "").trim().slice(0, 200),
    });
  }

  // 第 3 条：全覆盖
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) {
    return { ok: false, error: "计划漏了 " + missing.length + " 张卡：" + missing.slice(0, 5).join("、") };
  }

  // 第 4 条：同一区域不得拆进两条 lane（唯一有安全含义的规则）
  const where = new Map(); // prefix -> lane key
  for (const la of lanes) {
    for (const id of la.cardIds) {
      const p = prefixOf && prefixOf.get ? prefixOf.get(id) : "";
      if (!p) continue;
      const prev = where.get(p);
      if (prev !== undefined && prev !== la.key) {
        return {
          ok: false,
          error: "同一区域「" + p + "」被拆进了两个窗口（" + prev + " / " + la.key + "）——那会抢同一块地",
        };
      }
      where.set(p, la.key);
    }
  }

  return { ok: true, lanes, note: String(plan.note || "").trim().slice(0, 300) };
}

/**
 * 确定性回退：按 area 前缀分组，一行一个窗口。
 * 与 workbench.mjs planBatches 的 lanes 语义保持一致（那边是服务端算的路）。
 * @param {string[][]} batches 手动分批（可为空：并行不分批时传 [[...ids]]）
 * @param {Map<string,string>} prefixOf
 */
export function fallbackLanes(selectedIds, prefixOf) {
  const order = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
  const map = new Map();
  const lanes = [];
  for (const id of order) {
    const p = (prefixOf && prefixOf.get ? prefixOf.get(id) : "") || "(未分区域)";
    if (!map.has(p)) {
      map.set(p, []);
      lanes.push({ key: p, prefix: p, cardIds: map.get(p), why: "按区域前缀分组（回退）" });
    }
    map.get(p).push(id);
  }
  return lanes;
}

/**
 * 一步到位：解析 → 校验 → 失败则回退。返回真正要用的 lanes + 诊断信息。
 * @returns {{lanes:Array, source:'ai'|'fallback', reason:string, rawSnippet:string}}
 */
export function resolvePlan(text, selectedIds, prefixOf) {
  const ids = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
  const rawSnippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const plan = extractPlanJson(text);
  const v = validatePlan(plan, ids, prefixOf);
  if (v.ok) {
    return { lanes: v.lanes, source: "ai", reason: v.note || "", rawSnippet };
  }
  return {
    lanes: fallbackLanes(ids, prefixOf),
    source: "fallback",
    reason: v.error || "计划不合法",
    rawSnippet,
  };
}

/**
 * 拼给分析窗口的提示词。
 * @param {Array<{id,title,prefix,lane,status,step}>} cards 本次选的卡
 * @param {Array<{key,lastCard,lastAt}>} knownWindows 现有窗口（供它决定复用）
 * @param {number} batchSize 用户选的「一次喂几张」（它要据此判断批是否合理）
 */
export function buildPlannerPrompt(cards, knownWindows, batchSize) {
  const list = (cards || []).map((c) =>
    "- " + c.id + "｜区域：" + (c.prefix || "(未分区域)") +
    "｜车道：" + (c.lane || "?") + "｜阶段：" + (c.step || "?") +
    "｜" + (c.title || "")
  ).join("\n");
  const known = (knownWindows || []).length
    ? knownWindows.map((w) => "- " + w.key + "（最近：" + (w.lastCard || "无") + "，" + (w.lastAt || "无记录") + "）").join("\n")
    : "（还没有已知窗口，请起新名字）";
  return (
    "你是这个看板工作台的**调度员**。下面是一批待办的卡，请判断怎么把它们分给几个**对话窗口**。\n\n" +
    "硬约束（必须遵守，否则计划会被丢弃）：\n" +
    "1) 同一个「区域」的卡**不能**拆到两个窗口 —— 它们抢同一块地，同时做会互相冲突。同区域的卡放进同一个窗口即可（那个窗口会依次做）。\n" +
    "2) 每张卡都必须被分到某个窗口，不能漏、不能重复。\n" +
    "3) 不同区域可以合并到一个窗口（等于串行），如果你判断合并更合适就这么做，并在 why 里说明。\n" +
    "4) 用户希望「一次喂 " + (batchSize || 1) + " 张」，请判断这个粒度对你分出来的每个窗口是否合理；不合理就在 note 里说明建议。\n\n" +
    "窗口复用：尽量把卡派回**已经在做同类事**的窗口（见下面清单），让上下文能接着用；确实没有合适的再起新名字。\n" +
    "现有窗口：\n" + known + "\n\n" +
    "待分配的卡：\n" + list + "\n\n" +
    "只输出一个 JSON（不要别的内容）：\n" +
    '{"lanes":[{"key":"窗口名(跨轮次稳定)","prefix":"显示名","cardIds":["OPS-001"],"why":"为什么这样分"}],"note":"一句话总结"}\n'
  );
}
