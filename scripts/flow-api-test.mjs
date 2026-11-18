// 并行执行接口的生命周期测试：领取 → 冲突 → 队列前进 → 交还
// 以及领取状态的**落盘持久化**（重启服务后不能丢）
//
// ⚠️ 这个测试**不写死卡号**。
// 曾经的写法把台账当时的快照当断言（「未收口 7 件」「能并行 5 路」「OPS-022 可开工」），
// 台账一推进就整片变红 —— 红的不是代码坏了，是测试把数据当成了契约。
// 现在所有断言都从**当前 plan 反推**：先问接口「现在谁是头、谁在排队」，再用这份
// 实时结果去验「领取 / 互斥 / 交还 / 落盘」这些**不会随数据变化的行为**。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";

const BOARD = "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
const PORT = 8797;
const B = `http://127.0.0.1:${PORT}`;
// 领取状态落盘到这里 —— 用临时目录，跑完自动清，不碰真的 flow-claims.json
const CLAIMS_DIR = mkdtempSync(joinPath(tmpdir(), "flowclaims-"));
const CLAIMS = joinPath(CLAIMS_DIR, "flow-claims.json");

// 读取落盘文件（同步，测试里够用）
function readClaimsFile() {
  try { return JSON.parse(readFileSync(CLAIMS, "utf8")); } catch (e) { return { claims: [] }; }
}

let stderr = "";
function startSrv() {
  const p = spawn("node", [
    "scripts/serve.mjs",
    "--board", BOARD,
    "--port", String(PORT),
    "--claims", CLAIMS,
  ], {
    cwd: "D:\\WorkSpace-Tools\\ops-board",
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stderr.on("data", (d) => (stderr += d));
  return p;
}

let p = startSrv();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 40; i++) {
  await wait(250);
  try {
    const r = await fetch(B + "/api/ping");
    if (r.ok) { ready = true; break; }
  } catch {}
}
if (!ready) { console.error("服务没起来\n" + stderr); p.kill(); process.exit(1); }

// 重启服务（同一个 claims 文件），用于验证落盘。返回新进程。
async function restartSrv() {
  p.kill();
  await wait(400);
  stderr = "";
  p = startSrv();
  let up = false;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    try { if ((await fetch(B + "/api/ping")).ok) { up = true; break; } } catch {}
  }
  if (!up) { console.error("重启后服务没起来\n" + stderr); p.kill(); process.exit(1); }
}

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log("  ✓ " + msg + (extra ? " — " + extra : "")); }
  else { fail++; console.log("  ✗ " + msg + (extra ? " — " + extra : "")); }
};
const plan = () => fetch(B + "/api/flow/plan").then((r) => r.json());
const post = async (path, body) => {
  const r = await fetch(B + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

console.log("[1] 初始计划：内部账目自洽");
let P = await plan();
ok(P.ok === true, "plan 返回 ok");
ok(P.running === 0, "新起的服务没有残留领取", "实际 " + P.running);
// 未收口总数 = 能开工的 + 排队的（这两组必须覆盖全部，不能有既不可开工也不排队的幽灵）
ok(P.total === P.runnable.length + P.waiting.length,
  "未收口数 = 可开工 + 排队（没有漏算的卡）",
  `${P.total} = ${P.runnable.length} + ${P.waiting.length}`);
ok(P.parallelNow === P.runnable.filter((r) => r.state === "ready").length,
  "parallelNow = ready 的件数", "parallelNow=" + P.parallelNow);
ok(P.queued === P.waiting.length, "queued = 排队件数", "queued=" + P.queued);
// 每块地最多只有一个「头」：同一 prefix 下不允许两件同时 ready
const readyByPrefix = {};
for (const r of P.runnable.filter((x) => x.state === "ready")) {
  readyByPrefix[r.prefix] = (readyByPrefix[r.prefix] || 0) + 1;
}
ok(Object.values(readyByPrefix).every((n) => n === 1),
  "同一块地同时只有一个可开工（并行上限的根）",
  Object.entries(readyByPrefix).map(([k, v]) => `${k}×${v}`).join(" "));
// 排队项必须指向「同一块地」的某件，且不是自己（箭头要落在同一条链上）
const waitsOk = P.waiting.every((w) => w.waitsFor && w.waitsFor !== w.id &&
  P.runnable.some((r) => r.id === w.waitsFor && r.prefix === w.prefix));
ok(waitsOk, "排队关系指向同区域的紧邻前驱",
  P.waiting.map((w) => `${w.id}→${w.waitsFor}`).join(" ") || "(无排队)");

const readyList = P.runnable.filter((r) => r.state === "ready");
const target = readyList[0];
const otherArea = readyList.find((r) => r.prefix !== target.prefix);
const sameAreaWaiter = P.waiting.find((w) => w.prefix === target.prefix);
console.log(`     本轮用卡：${target.id}（${target.prefix}）` +
  (otherArea ? ` / 跨区 ${otherArea.id}（${otherArea.prefix}）` : " / 无可用的跨区卡") +
  (sameAreaWaiter ? ` / 同区排队 ${sameAreaWaiter.id}` : " / 同区无排队"));

console.log("\n[2] 领取可开工的");
let R = await post("/api/flow/claim", { id: target.id, by: "agent-A" });
ok(R.status === 200 && R.data.ok, `领 ${target.id} 成功`, JSON.stringify(R.data));
ok(!R.data.nextInSameArea || R.data.nextInSameArea === (sameAreaWaiter && sameAreaWaiter.id),
  "返回的同区下一件与排队清单一致", "next=" + R.data.nextInSameArea);

console.log("\n[3] 领取状态要持久（这是之前真正的 bug）");
P = await plan();
ok(P.running === 1, "plan 里看到 1 件在执行", "实际 " + P.running);
let running = P.runnable.find((r) => r.state === "running");
ok(running && running.id === target.id && running.by === "agent-A",
  "该卡标为 running 且记着是谁", JSON.stringify(running && { id: running.id, by: running.by }));
// 领走队首后，同区域应有一件顶上来（或该区域就此清空），不能两条都卡着
const samePrefixNow = P.runnable.filter((r) => r.prefix === target.prefix && r.state === "ready");
ok(samePrefixNow.length <= 1, "同区域顶上来至多一件（不会两条都卡着）",
  samePrefixNow.map((r) => r.id).join(",") || "(该区已清空)");

console.log("\n[4] 同区域互斥");
// ① 同一张卡再领一次必须被拒（已被持有）
R = await post("/api/flow/claim", { id: target.id, by: "agent-B" });
ok(R.status === 409, "已在执行的卡不能再被别人领", "status=" + R.status);
// ② 同区域排队的下一件也必须被拒
if (sameAreaWaiter) {
  R = await post("/api/flow/claim", { id: sameAreaWaiter.id, by: "agent-B" });
  ok(R.status === 409, `同区域的 ${sameAreaWaiter.id} 被拒`, "status=" + R.status);
} else {
  console.log("  · 该区域没有排队件，跳过「同区排队被拒」这一条");
}

console.log("\n[5] 跨区域可以同时领");
let crossClaimed = null;
if (otherArea) {
  R = await post("/api/flow/claim", { id: otherArea.id, by: "agent-B" });
  ok(R.status === 200 && R.data.ok, `跨区域领 ${otherArea.id} 成功`, JSON.stringify(R.data));
  crossClaimed = R.status === 200 && R.data.ok ? otherArea.id : null;
  P = await plan();
  ok(P.running === (crossClaimed ? 2 : 1), "两件同时在执行", "实际 " + P.running);
  if (crossClaimed) {
    const bys = P.runnable.filter((r) => r.state === "running").map((r) => r.by).sort();
    ok(JSON.stringify(bys) === JSON.stringify(["agent-A", "agent-B"]), "两个不同的执行者", bys.join(","));
  }
} else {
  console.log("  · 当前只有一个区域有可开工卡，跳过跨区域并行");
}

console.log("\n[6] 交还只认领取人");
R = await post("/api/flow/release", { id: target.id, by: "agent-B" });
ok(R.status === 409, "agent-B 不能交还 agent-A 的活", "status=" + R.status);
R = await post("/api/flow/release", { id: target.id, by: "agent-A" });
ok(R.status === 200 && R.data.ok, "agent-A 自己交还成功", JSON.stringify(R.data));
P = await plan();
ok(P.running === (crossClaimed ? 1 : 0), "交还后只剩跨区那件在执行", "实际 " + P.running);

console.log("\n[7] 领不存在的 / 排队的");
R = await post("/api/flow/claim", { id: "OPS-999", by: "x" });
ok(R.status === 409, "不存在的 id 被拒", "status=" + R.status);
R = await post("/api/flow/claim", { id: "", by: "x" });
ok(R.status === 400, "空 id 被拒", "status=" + R.status);
if (P.waiting.length) {
  const w = P.waiting[0];
  R = await post("/api/flow/claim", { id: w.id, by: "x" });
  ok(R.status === 409, `排队的 ${w.id} 不能直接领`, "status=" + R.status);
}

console.log("\n[8] 图与接口用同一套推导");
// 图里说谁是头，接口就必须说谁能开工 —— 两套编码是之前的真 bug。
// 注意：接口把「已被领走的」算 running（不算 ready），而流程图不知道领取状态、
// 会把它算成头。比对时要把「正在执行的」补回去。
const { buildFlow } = await import("file:///D:/WorkSpace-Tools/ops-board/scripts/lib/flow.mjs");
const fs = await import("node:fs");
const cfg = JSON.parse(fs.readFileSync(joinPath(BOARD, "board.config.json"), "utf8"));
const led = JSON.parse(fs.readFileSync(joinPath(BOARD, "ledger.json"), "utf8"));
const flow = buildFlow(cfg, led);
const graphHeads = [];
for (const lane of flow.lanes) for (const t of lane.tracks) for (const n of t.items) if (n.isHead) graphHeads.push(n.id);
const Pnow = await plan();
const apiHeads = Pnow.runnable.filter((r) => r.state === "ready" || r.state === "running").map((r) => r.id);
ok(JSON.stringify(graphHeads.slice().sort()) === JSON.stringify(apiHeads.slice().sort()),
  "流程图与接口的可开工清单完全一致", `图=${graphHeads.slice().sort().join(",")} 接口=${apiHeads.slice().sort().join(",")}`);

console.log("\n[9] 领取状态落盘：重启服务后不丢（D22）");
if (crossClaimed) {
  // 此刻跨区那件仍被 agent-B 持有，正好用来验证：重启前 running，重启后必须还是
  // running，领取人和前缀都不能丢。
  await restartSrv();
  P = await plan();
  ok(P.ok === true, "重启后 plan 正常", "actual ok=" + P.ok);
  ok(P.running === 1, "重启后仍有 1 件在执行", "实际 " + P.running);
  const pers = P.runnable.find((r) => r.state === "running");
  ok(pers && pers.id === crossClaimed && pers.by === "agent-B" && pers.prefix === otherArea.prefix,
    "重启后仍记为 agent-B / 原前缀",
    JSON.stringify(pers && { id: pers.id, by: pers.by, prefix: pers.prefix }));
  // 落盘互斥仍然有效
  const persConflict = await post("/api/flow/claim", { id: crossClaimed, by: "agent-C" });
  ok(persConflict.status === 409, "重启后互斥仍生效", "status=" + persConflict.status);
} else {
  console.log("  · 没有跨区持有者，跳过重启持久化验证");
}

console.log("\n[10] 交还后落盘清空");
if (crossClaimed) {
  R = await post("/api/flow/release", { id: crossClaimed, by: "agent-B" });
  ok(R.status === 200 && R.data.ok, "交还成功", JSON.stringify(R.data));
}
P = await plan();
ok(P.running === 0, "交还后无在执行", "实际 " + P.running);
const diskAfter = readClaimsFile();
const diskClaims = Array.isArray(diskAfter) ? diskAfter : diskAfter.claims || [];
ok(diskClaims.length === 0, "落盘文件也清空了", "残留 " + diskClaims.length);

console.log("\n[11] 服务全程没崩");
ok(p.exitCode === null, "进程仍在运行", "exitCode=" + p.exitCode);
ok(!/Error|throw/.test(stderr), "stderr 没有报错", stderr.slice(0, 200) || "(空)");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
p.kill();
// 清掉临时 claims 目录
rmSync(CLAIMS_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);