// Agent 意图报文（0-b / §十B.1、§十A.1）。
//
// 要防两件事：
//   ① 解析太脆：模型写 ```json、```agent-ops-board、裸 JSON、前后带说明文字，
//      都要认得出来 —— 不能因为格式五花八门就判它没报。
//   ② 放行了坏意图：空 files、绝对路径、`../` 跳出项目、node_modules 全量，
//      这些都必须**拒**而不是「当作没冲突放行」。
//
// 尤其 `addsEdges`：漏报会让别的窗口改那个文件时**不被挡住**，
// 这是最典型的冲突形态（一个加耦合、一个改被耦合那方）。
import { extractIntent, validateIntent, buildIntentPrompt, normalizeFiles } from "./lib/intent.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

// ── ① 各种围栏写法都要认 ──
console.log("[1] 解析：四种常见写法都要认出来");
{
  const bodies = [
    ["```json 围栏", '我看了代码。\n```json\n{"files":["utils/request.js"]}\n```'],
    ["无语言标记围栏", '计划：\n```\n{"files":["utils/request.js"]}\n```'],
    ["自定义标记围栏", '```agent-ops-board\n{"files":["utils/request.js"]}\n```'],
    ["裸 JSON", '{"files":["utils/request.js"]}'],
    ["裸 JSON 前后有说明", '好的，我的计划是 {"files":["utils/request.js"]} 请确认。'],
  ];
  for (const [name, text] of bodies) {
    const r = extractIntent(text);
    ok(r.ok === true && r.files[0] === "utils/request.js", name + " → 解析成功", r.ok ? r.files.join(",") : r.error);
  }
}

// ── ② 路径归一 ──
console.log("\n[2] 解析：路径归一（反斜杠、./ 前缀、空白）");
{
  const r = extractIntent('{"files":[" .\\\\utils\\\\request.js ","utils/a.js"]}');
  ok(r.files[0] === ".utils/request.js" || r.files[0] === "utils/request.js",
    "反斜杠转正斜杠", JSON.stringify(r.files));
  ok(!r.files.some((f) => f.includes("\\")), "结果里没有反斜杠", JSON.stringify(r.files));
  const r2 = extractIntent('{"files":["./utils/b.js"]}');
  ok(r2.files[0] === "utils/b.js", "去掉 ./ 前缀", r2.files[0]);
}

// ── ③ willUse（原来叫 addsEdges，2026-11-21 改成白话）──
console.log("\n[3] willUse：这次动手还会用到哪些文件");
{
  const r = extractIntent(JSON.stringify({
    files: ["utils/request.js"],
    willUse: ["utils/retry.js"],
  }));
  ok(r.ok && r.willUse.length === 1, "解析出 1 个会额外用到的文件", JSON.stringify(r.willUse));
  ok(r.willUse[0] === "utils/retry.js", "路径正确（就是文件名，不需要方向）", r.willUse[0]);
  // 一个文件列表，不认残缺/非字符串
  const r2 = extractIntent('{"files":["a.js"],"willUse":["b.js",null,"",123]}');
  ok(r2.willUse.length === 1, "非字符串/空项被丢掉", JSON.stringify(r2.willUse));
  // 兼容旧写法：模型还可能回 addsEdges，把 to 端收下来（不报错，意思是对的）
  const r3 = extractIntent('{"files":["a.js"],"addsEdges":[{"from":"a.js","to":"b.js"}]}');
  ok(r3.ok && r3.willUse.join(",") === "b.js", "旧写法 addsEdges 也能认（收 to 端）", JSON.stringify(r3.willUse));
}

// ── ④ 校验：该拒的都要拒 ──
console.log("\n[4] 校验：放行坏意图 = 让调度失明");
{
  const cases = [
    ["空 files", { ok: true, files: [], willUse: [] }, /没报要改哪些文件/],
    ["绝对路径 C:", { ok: true, files: ["C:/x/y.js"], willUse: [] }, /相对路径/],
    ["绝对路径 /", { ok: true, files: ["/etc/passwd"], willUse: [] }, /相对路径/],
    ["跳出项目 ..", { ok: true, files: ["../other/x.js"], willUse: [] }, /跳出项目/],
    ["node_modules", { ok: true, files: ["node_modules/x/y.js"], willUse: [] }, /node_modules/],
    ["文件太多", { ok: true, files: Array.from({ length: 300 }, (_, i) => "f" + i + ".js"), willUse: [] }, /太多/],
    ["解析失败", { ok: false, files: [], willUse: [], error: "没找到意图报文" }, /意图报文/],
  ];
  for (const [name, intent, re] of cases) {
    const v = validateIntent(intent);
    ok(v.ok === false && re.test(v.error), name + " → 拒收", v.error.slice(0, 50));
  }
  const good = validateIntent({ ok: true, files: ["utils/request.js"], willUse: [] });
  ok(good.ok === true, "正常意图通过", "ok");
}

// ── ⑤ 提示词 ──
console.log("\n[5] 提示词：必须明确「先别动手」，且**不出现专业术语**");
{
  const p = buildIntentPrompt();
  ok(/不要修改任何文件/.test(p), "明确禁止本轮改文件", "");
  ok(/先报计划/.test(p), "说清这一步是报计划", "");
  ok(/willUse/.test(p), "用了白话字段名 willUse", "");
  // ⚠️ 2026-11-21 用户指出：这是通用插件，不许把图论/构建工具的术语漏给使用者
  const jargon = ["addsEdges", "闭包", "依赖图", "边", "closure", "depcruise", "dependency"];
  const hit = jargon.filter((w) => p.indexOf(w) > -1);
  ok(hit.length === 0, "**提示词里没有专业术语**（用户/agent 都不该看到）", hit.join(",") || "(无)");
  ok(/无需处理/.test(p), "允许「不需要改文件」的诚实时（不逼它编清单）", "");
}

// ── ⑥ 与台账字段一致性 ──
console.log("\n[6] 和台账的 files 字段用同一套归一规则");
{
  const a = normalizeFiles([".\\utils\\a.js", " b.js ", ""]);
  ok(a.join(",") === "utils/a.js,b.js", "归一去空 + 反斜杠", JSON.stringify(a));
  // 意图解析后的 files 应该能直接喂给台账
  const r = extractIntent('{"files":[".\\\\utils\\\\a.js"]}');
  ok(r.files.join(",") === "utils/a.js", "解析结果可直接写进台账（同规则）", r.files.join(","));
}

// ── ⑦ 不该被误认 ──
console.log("\n[7] 不该把普通回复误认成意图报文");
{
  const r = extractIntent("我把 request.js 改好了，测试通过。");
  ok(r.ok === false, "纯文字回复 → 判为没报（而不是瞎猜）", r.error.slice(0, 40));
  // 有 JSON 但不是意图报文
  const r2 = extractIntent('```json\n{"result":"ok","count":3}\n```');
  ok(r2.ok === false, "没有 files 字段的 JSON → 不认", r2.error.slice(0, 40));
  // 但带 other 字段 + files 的要认
  const r3 = extractIntent('{"files":["a.js"],"extra":123}');
  ok(r3.ok === true, "有 files 就认（允许附加字段）", r3.files.join(","));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);