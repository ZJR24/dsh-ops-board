// 全量门禁：一条命令跑完「渲染 → 自检 → 全部测试」，任何一项失败就整体失败。
//
// 为什么需要它：这 20 个测试脚本此前**没有任何登记处**，谁记得就手敲 node scripts/xxx.mjs。
// 结果是「改了一处，跑了三个测试就以为没坏」。门禁的价值不在多跑几个断言，
// 而在**把"要跑哪些"这件事从人的记性里挪到代码里** —— 新增测试只需在这里加一行。
//
// 用法：
//   node scripts/gate.mjs              全量（含需要浏览器的 DOM 测试，较慢）
//   node scripts/gate.mjs --fast       只跑纯静态/纯 Node 的，不启浏览器
//   node scripts/gate.mjs --list       列出会跑哪些，不执行
//   node scripts/gate.mjs --only flow  只跑名字里含 flow 的
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i > -1 ? argv[i + 1] : "";
};

const CYBER = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
const PRACTISE = "D:\\WorkSpace-Tools\\ops-board-reports\\practise";

// 每个测试都自带独立端口（8797/8799/8801/9222-9233/9333…），串行跑不会互相踩。
// 并行反而危险：几个测试会同时抢同一块浏览器 profile 与 CDP 端口。
const SUITES = [
  // ── 纯 Node，不起浏览器 ──
  { name: "status-consistency", file: "status-consistency-test.mjs", args: [], static: true, why: "两份 OPEN_STATUSES 不许漂移" },
  { name: "code-look", file: "code-look-test.mjs", args: [], static: true, why: "大提交也必须给出 diff（ENOBUFS 边界）" },
  { name: "flow-api", file: "flow-api-test.mjs", args: [], static: false, why: "flow 接口契约" },

  // ── 需要浏览器的 DOM 测试 ──
  { name: "flow", file: "flow-test.mjs", args: ["--board", CYBER], why: "页面路由与死画布已移除" },
  { name: "flow-workbench", file: "flow-workbench-test.mjs", args: [], why: "工作台候选池 / 分批 / 排队标记" },
  { name: "flow-workbench-run", file: "flow-workbench-run-test.mjs", args: [], why: "真正跑一遍串行与并行" },
  { name: "wb-mount", file: "wb-mount-test.mjs", args: [], why: "工作台单实例挂载" },
  { name: "wb-overview-live", file: "wb-overview-live-test.mjs", args: [], why: "总览页活数据" },
  { name: "stale-route", file: "stale-route-test.mjs", args: [], why: "坏落点不许白屏" },
  { name: "card-fold-cyber", file: "card-fold-test.mjs", args: ["--board", CYBER], why: "卡片收起/展开（大看板）" },
  { name: "card-fold-practise", file: "card-fold-test.mjs", args: ["--board", PRACTISE], why: "卡片收起/展开（小看板）" },
  { name: "stage-ask-cyber", file: "stage-ask-test.mjs", args: ["--board", CYBER], why: "「计划中」AI 入口 + 待处理表已搬到车道页" },
  { name: "stage-ask-practise", file: "stage-ask-test.mjs", args: ["--board", PRACTISE], why: "同上（小看板，计划中同样是 0 项）" },

  // ── 界面细节（较慢，--fast 时跳过） ──
  { name: "evidence-look", file: "evidence-look-test.mjs", args: ["--board", CYBER], slow: true, why: "证据路径识别与展示" },
  { name: "msg-align", file: "msg-align-test.mjs", args: [], slow: true, why: "对话气泡对齐" },
  { name: "panel-persist", file: "panel-persist-test.mjs", args: [], slow: true, why: "面板状态持久化" },
  { name: "report-ui", file: "report-ui-test.mjs", args: ["--board", CYBER], slow: true, why: "报告导出面板" },
  { name: "roundtrip", file: "roundtrip-test.mjs", args: [], slow: true, why: "台账读写往返" },
  { name: "session-pick", file: "session-pick-test.mjs", args: [], slow: true, why: "会话选择" },
  { name: "finder-settings", file: "finder-settings-test.mjs", args: [], slow: true, why: "取景器设置" },
  { name: "float", file: "float-test.mjs", args: [], slow: true, why: "浮窗" },
  { name: "chatwin", file: "chatwin-test.mjs", args: [], slow: true, why: "独立对话窗口" },
  { name: "chat-persist", file: "chat-persist-test.mjs", args: [], slow: true, why: "对话持久化" },

  // ── 不走 Harness / 走 file:// 的两条特殊路径 ──
  { name: "offline", file: "offline-test.mjs", args: [], slow: true, why: "裸页（无 Harness 注入）时面板说人话" },
  { name: "chatwin-wiring", file: "chatwin-wiring.mjs", args: [], why: "外壳对话窗接线（假 React，纯 Node）" },
];

// 故意不进这里的两条：float-negative.mjs / chatwin-negative.mjs。
// 它们是**负向验收**——会临时改坏 client.js / css.mjs 来确认对应断言真的会红，
// 跑完自己还原。放进 CI 式的门禁里，一旦中途被打断就会留下改坏的源码，
// 所以只作为人工按需执行（npm run uitest:float-negative / uitest:chatwin-negative）。

const only = val("--only");
let todo = SUITES.filter((s) => existsSync(join(here, s.file)));
const missing = SUITES.filter((s) => !existsSync(join(here, s.file)));

if (only) todo = todo.filter((s) => s.name.includes(only) || s.file.includes(only));
if (has("--fast")) todo = todo.filter((s) => !s.slow);

if (has("--list")) {
  console.log("会跑的测试：");
  for (const s of todo) console.log(`  ${s.name.padEnd(20)} ${s.file}${s.args.length ? " " + s.args.join(" ") : ""}`);
  if (missing.length) {
    console.log("\n⚠ 以下登记在册但文件不存在（已跳过）：");
    for (const s of missing) console.log(`  ${s.name} -> ${s.file}`);
  }
  process.exit(0);
}

// ── 第 0 步：渲染两块看板。不先渲染，后面测的是旧产物。 ──
function runNode(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), status: r.status, label };
}

const t0 = Date.now();
console.log("=== 第 1 步：渲染两块看板 ===");
const boards = [CYBER, PRACTISE].filter((b) => existsSync(b));
for (const b of boards) {
  const r = runNode(["scripts/render.mjs", "--board", b], "render");
  const line = r.out.split(/\r?\n/).find((l) => l.includes("体积")) || "";
  console.log(`  ${r.ok ? "✓" : "✗"} ${b.split("\\").pop()} ${line.trim()}`);
  if (!r.ok) {
    console.error(r.out);
    process.exit(1);
  }
}

console.log("\n=== 第 2 步：产物自检 ===");
for (const b of boards) {
  const html = join(b, "dist", "index.html");
  const r = runNode(["scripts/verify-board.mjs", html], "verify");
  const line = r.out.split(/\r?\n/).find((l) => l.includes("KB ·")) || "";
  console.log(`  ${r.ok ? "✓" : "✗"} ${b.split("\\").pop()} ${line.trim()}`);
  if (!r.ok) {
    console.error(r.out);
    process.exit(1);
  }
}

// ── 第 3 步：逐个跑测试 ──
console.log(`\n=== 第 3 步：${todo.length} 项测试 ===`);
const results = [];
let i = 0;
for (const s of todo) {
  i++;
  const started = Date.now();
  process.stdout.write(`  [${String(i).padStart(2)}/${todo.length}] ${s.name.padEnd(20)} `);
  const r = runNode([join("scripts", s.file), ...s.args], s.name);
  const ms = Date.now() - started;
  // 各测试的汇总行格式不一（"结果：N 通过" / "自检通过：N 项"），取最后一条含通过/失败的行
  const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
  const summary = [...lines].reverse().find((l) => /结果：|自检通过|通过 \/|通过\s*\/\s*失败|项$/.test(l)) || "";
  console.log(`${r.ok ? "✓" : "✗"} ${(ms / 1000).toFixed(1)}s  ${summary.trim().slice(0, 60)}`);
  results.push({ ...s, ok: r.ok, ms, out: r.out, summary });
  if (!r.ok) {
    console.log("\n--- 失败详情 ---");
    console.log(r.out.split(/\r?\n/).slice(-40).join("\n"));
  }
}

// ── 汇总 ──
const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok);
const totalMs = Date.now() - t0;
console.log("\n" + "=".repeat(60));
console.log(`门禁结果：${passed.length} 通过 / ${failed.length} 失败（共 ${results.length} 项，${(totalMs / 1000).toFixed(1)}s）`);
if (failed.length) {
  console.log("\n失败的：");
  for (const f of failed) console.log(`  ✗ ${f.name} (${f.file}) — ${f.why}`);
}
if (missing.length) {
  console.log("\n登记但文件缺失（未计入结果，请清理清单）：");
  for (const m of missing) console.log(`  ? ${m.name} -> ${m.file}`);
}
process.exit(failed.length === 0 && missing.length === 0 ? 0 : 1);
