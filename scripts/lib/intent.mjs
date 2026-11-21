// Agent 意图回执的解析（0-b / §十B.1、§十A.1）。
//
// 为什么需要「报意图」这一步：中控要判「两个任务会不会抢同一块地」，
// 必须知道它们**要改哪些文件**。而 agent 接活时只知道卡片标题 ——
// 它得先读代码才知道改哪些文件，读了代码就已经在干活了。
//
// 这是个死结：判冲突要文件清单 → 清单要读代码 → 读代码就是执行。
// 解法：让 agent **先看、先报，报了才许动手**。报文就是下面这个格式。
//
// 为什么还要 `addsEdges`（本次新增哪些依赖）：
// 图是「动手之前」建的。如果 agent 本次要**新加一条 import**，那条边在图里
// 还不存在，别的 agent 改那个被依赖的文件时**不会被挡住** —— 这是最典型的
// 冲突形态（一个加耦合、一个改被耦合的那方），而原方案会漏判它。
//
//   { "files": ["utils/request.js"],
//     "addsEdges": [{ "from": "utils/request.js", "to": "utils/retry.js" }] }
//
// 这个信息 agent 本来就知道 —— 它要写的就是那行 require/import。

import { normalizeFiles } from "./ledger-write.mjs";

/** 意图报文里的文件名归一（与台账同规则）。 */
export { normalizeFiles };

/**
 * 从 agent 的回复里抠出意图报文。
 *
 * 容忍三种常见写法（模型很爱这么写，不该因此判它不合格）：
 *   ① 带语言标记的围栏：```json ... ``` / ```agent-ops-board ... ```
 *   ② 不带标记的围栏：``` ... ```
 *   ③ 裸 JSON（整段就是 JSON，没有围栏）
 *
 * @returns { ok, files, addsEdges, raw, error }
 */
export function extractIntent(text) {
  const src = String(text || "");
  const candidates = [];

  // ① 显式标记的围栏优先
  const tagged = /```[ \t]*(?:json|agent-ops-board|agent-autoloop)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let m;
  while ((m = tagged.exec(src))) candidates.push(m[1]);

  // ② 裸 JSON：从第一个 { 到最后一个 }（容忍前后有说明文字）
  const first = src.indexOf("{");
  const last = src.lastIndexOf("}");
  if (first > -1 && last > first) candidates.push(src.slice(first, last + 1));

  let parsed = null;
  let parseError = "";
  for (const c of candidates) {
    const t = String(c).trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      // 认它是「意图报文」的最低要求：有 files 字段
      if (obj && typeof obj === "object" && ("files" in obj || "addsEdges" in obj)) { parsed = obj; break; }
    } catch (e) {
      parseError = String((e && e.message) || e);
    }
  }
  if (!parsed) {
    return {
      ok: false,
      files: [],
      addsEdges: [],
      raw: src,
      error: parseError ? "报文不是合法 JSON：" + parseError : "没找到意图报文（要含 files 字段）",
    };
  }

  const files = normalizeFiles(parsed.files);
  const addsEdges = [];
  if (Array.isArray(parsed.addsEdges)) {
    for (const e of parsed.addsEdges) {
      if (!e || typeof e !== "object") continue;
      const from = normalizeFiles([e.from])[0] || "";
      const to = normalizeFiles([e.to])[0] || "";
      if (from && to) addsEdges.push({ from, to });
    }
  }
  return { ok: true, files, addsEdges, raw: src, error: "" };
}

/**
 * 校验一份意图是否可接受。
 *
 * @param intent  extractIntent 的结果
 * @returns { ok, error }
 *
 * 判据：
 *   · 必须报 files（空的没法判冲突 —— 拒绝而不是「当作没冲突放行」）；
 *   · 路径不能是绝对路径或跳出项目（`../`）—— 那是要改别人仓库；
 *   · 数量上限防「报一个 node_modules 全量」这种把锁表撑爆的写法。
 */
export function validateIntent(intent, { maxFiles = 200 } = {}) {
  if (!intent || !intent.ok) return { ok: false, error: (intent && intent.error) || "意图为空" };
  if (!intent.files.length) return { ok: false, error: "没报要改哪些文件（files 为空），无法判冲突" };
  if (intent.files.length > maxFiles) {
    return { ok: false, error: "报的文件太多（" + intent.files.length + " 个 > " + maxFiles + "），请缩小到本次真正会改的范围" };
  }
  for (const f of intent.files) {
    if (/^[A-Za-z]:\//.test(f) || f.startsWith("//") || f.startsWith("/")) {
      return { ok: false, error: "文件路径必须是项目内相对路径，不能是绝对路径：" + f };
    }
    if (f.split("/").includes("..")) {
      return { ok: false, error: "文件路径不能跳出项目（含 ..）：" + f };
    }
    if (f.split("/").includes("node_modules")) {
      return { ok: false, error: "不该改 node_modules 里的文件：" + f };
    }
  }
  return { ok: true, error: "" };
}

/**
 * 拼「先报意图」的提示词片段。
 *
 * ⚠️ 必须明确「**先别动手**」：模型看到任务就会直接开始改文件，
 * 那样锁就来不及加了。所以这段话要放在显眼位置，并且说清「报完等指令」。
 */
export function buildIntentPrompt() {
  return [
    "【第一步：先报计划，不要动手】",
    "这一轮**不要修改任何文件**，也不要跑任何会改文件的命令。",
    "先读代码、把要改的地方看清楚，然后只回一份计划（JSON），等下一步指令再动手。",
    "",
    "计划格式（最后一条消息里附一个 ```json 代码块）：",
    "```json",
    '{"files":["utils/request.js"],',
    ' "addsEdges":[{"from":"utils/request.js","to":"utils/retry.js"}],',
    ' "plan":"一句话说明打算怎么改"}',
    "```",
    "- `files`：本次**会改**的项目内相对路径（必须如实、只报真正要动的）；",
    "- `addsEdges`：本次会**新增**的 import/require 关系（没有就写空数组）——",
    "  这个必须报，否则别的窗口正在改那个文件时，看板会误判为「不冲突」而放行；",
    "- 路径用正斜杠、相对项目根；不要报 node_modules，不要用绝对路径。",
    "",
    "如果读完代码发现这张卡**不需要改任何文件**（比如已经修好了），",
    "就直接回一行结论（`无需处理：原因`），不要编一份假的文件清单。",
  ].join("\n");
}
