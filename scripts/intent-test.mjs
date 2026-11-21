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

// ── ③ addsEdges（§十A.1 的关键）──
console.log("\n[3] addsEdges：本次新增的依赖必须解析出来");
{
  const r = extractIntent(JSON.stringify({
    files: ["utils/request.js"],
    addsEdges: [{ from: "utils/request.js", to: "utils/retry.js" }],
  }));
  ok(r.ok && r.addsEdges.length === 1, "解析出 1 条新增依赖", JSON.stringify(r.addsEdges));
  ok(r.addsEdges[0].from === "utils/request.js" && r.addsEdges[0].to === "utils/retry.js",
    "from/to 都对", JSON.stringify(r.addsEdges[0]));
  // 缺字段的条目要丢掉，不能产生半个边
  const r2 = extractIntent('{"files":["a.js"],"addsEdges":[{"from":"a.js"},{"to":"b.js"},{"from":"x.js","to":"y.js"}]}');
  ok(r2.addsEdges.length === 1, "残缺的边被丢掉（只留完整的）", JSON.stringify(r2.addsEdges));
}

// ── ④ 校验：该拒的都要拒 ──
console.log("\n[4] 校验：放行坏意图 = 让调度失明");
{
  const cases = [
    ["空 files", { ok: true, files: [], addsEdges: [] }, /没报要改哪些文件/],
    ["绝对路径 C:", { ok: true, files: ["C:/x/y.js"], addsEdges: [] }, /相对路径/],
    ["绝对路径 /", { ok: true, files: ["/etc/passwd"], addsEdges: [] }, /相对路径/],
    ["跳出项目 ..", { ok: true, files: ["../other/x.js"], addsEdges: [] }, /跳出项目/],
    ["node_modules", { ok: true, files: ["node_modules/x/y.js"], addsEdges: [] }, /node_modules/],
    ["文件太多", { ok: true, files: Array.from({ length: 300 }, (_, i) => "f" + i + ".js"), addsEdges: [] }, /太多/],
    ["解析失败", { ok: false, files: [], addsEdges: [], error: "没找到意图报文" }, /意图报文/],
  ];
  for (const [name, intent, re] of cases) {
    const v = validateIntent(intent);
    ok(v.ok === false && re.test(v.error), name + " → 拒收", v.error.slice(0, 50));
  }
  const good = validateIntent({ ok: true, files: ["utils/request.js"], addsEdges: [] });
  ok(good.ok === true, "正常意图通过", "ok");
}

// ── ⑤ 提示词 ──
console.log("\n[5] 提示词：必须明确「先别动手」和「要报 addsEdges」");
{
  const p = buildIntentPrompt();
  ok(/不要修改任何文件/.test(p), "明确禁止本轮改文件", "");
  ok(/先报计划/.test(p), "说清这一步是报计划", "");
  ok(/addsEdges/.test(p), "要求报新增依赖", "");
  ok(/误判为「不冲突」/.test(p), "**解释了为什么要报 addsEdges**（模型才愿意报）", "");
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
