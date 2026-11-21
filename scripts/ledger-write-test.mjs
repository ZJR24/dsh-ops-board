// 台账写入通道（0-c / §十C）。
//
// 这个模块存在的理由：以前**没有任何东西**写台账 —— serve.mjs 从不写，
// 唯一写入口是 agent 自己改文件。改成「调度台代写」后，多个 agent 的回报
// 会并发到达，于是有三个必防的问题：
//
//   ① 丢失更新：两次写入并发，后写的覆盖先写的
//   ② 过期覆盖：用开工时的旧状态，盖掉别人刚改成的
//   ③ 重复回报：同一 askId 写两遍
//
// 测试要**真的制造并发**，不能只按顺序调一遍 —— 顺序调用本来就不会暴露 ①，
// 那样的测试是自欺欺人。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLedgerWriter, createWriteQueue, validateChange, atomicWriteJson, acquireFileLock }
  from "./lib/ledger-write.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = mkdtempSync(join(tmpdir(), "lw-test-"));
const LEDGER = join(TMP, "ledger.json");

const CONFIG = {
  lanes: [
    { key: "bug", label: "问题", stages: [
      { key: "todo", label: "待解决", open: true, statuses: ["open"] },
      { key: "closed", label: "已解决", open: false, statuses: ["fixed", "closed"] },
    ]},
    { key: "feature", label: "需求", stages: [
      { key: "planned", label: "计划中", open: true, statuses: ["planned"] },
      { key: "shipped", label: "已上线", open: false, statuses: ["shipped"] },
    ]},
  ],
};

function seed(n = 6) {
  const items = [];
  for (let i = 1; i <= n; i++) {
    items.push({
      id: "OPS-" + String(i).padStart(3, "0"),
      lane: "bug",
      title: "测试卡 " + i,
      status: "open",
      area: "区" + i,
      evidence: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const led = { project: { name: "t" }, updatedAt: "2026-01-01T00:00:00.000Z", items, history: [] };
  writeFileSync(LEDGER, JSON.stringify(led, null, 2), "utf8");
  return led;
}
const read = () => JSON.parse(readFileSync(LEDGER, "utf8"));

// ── ① 队列本身 ──
console.log("[1] 写入队列：串行执行，且一个失败不卡死后续");
{
  const enq = createWriteQueue();
  const order = [];
  const p1 = enq(async () => { order.push("a-start"); await wait(40); order.push("a-end"); });
  const p2 = enq(async () => { order.push("b-start"); await wait(10); order.push("b-end"); });
  await Promise.all([p1, p2]);
  ok(order.join(",") === "a-start,a-end,b-start,b-end",
    "任务不交错（a 跑完 b 才开始）", order.join(" → "));

  const enq2 = createWriteQueue();
  const done = [];
  const bad = enq2(async () => { throw new Error("故意失败"); });
  const good = enq2(async () => { done.push("后续任务跑了"); });
  await bad.catch(() => {});
  await good.catch(() => {});
  ok(done.length === 1, "前一个任务抛错，后续任务仍然执行（队列没卡死）", done.join(","));
}

// ── ② 丢失更新（真实并发）──
console.log("\n[2] 丢失更新：多个 agent 同时回报不同卡片，改动一个都不能丢");
{
  seed(6);
  const writer = createLedgerWriter({ ledgerPath: LEDGER, loadConfig: () => CONFIG });
  // 6 个并发请求，各自改不同的卡 —— 这正是「多 agent 同时交结果」的形状
  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((i) =>
      writer.apply([{ id: "OPS-" + String(i).padStart(3, "0"), to: "fixed", expectFrom: "open" }],
        { askId: "ask-" + i, by: "agent-" + i })
    )
  );
  const led = read();
  const fixed = led.items.filter((x) => x.status === "fixed").map((x) => x.id);
  ok(results.every((r) => r.ok), "6 个请求都成功", results.map((r) => r.applied.length).join(","));
  ok(fixed.length === 6, "**6 张卡全部变成 fixed**（一个都没被覆盖掉）", fixed.join(","));
  ok(led.history.length === 6, "history 正好 6 条（不多不少）", led.history.length + " 条");
  const kinds = new Set(led.history.map((h) => h.kind));
  ok(kinds.has("fixed"), "history 自动补上了 kind（时间线能染色）", [...kinds].join(","));
}

// ── ③ 过期覆盖 ──
console.log("\n[3] 过期覆盖：用旧状态回报 → 拒收，不覆盖");
{
  seed(2);
  const writer = createLedgerWriter({ ledgerPath: LEDGER, loadConfig: () => CONFIG });
  // 模拟：agent A 把 001 改成 fixed
  await writer.apply([{ id: "OPS-001", to: "fixed", expectFrom: "open" }], { askId: "a1" });
  // 模拟：agent B 还以为是 open（它开工时是 open），也要改
  const r = await writer.apply([{ id: "OPS-001", to: "closed", expectFrom: "open" }], { askId: "b1" });
  const led = read();
  ok(r.ok === false, "被拒", JSON.stringify(r.rejected));
  ok(r.rejected[0] && r.rejected[0].stale === true, "标明是 stale（状态已别人改过）", JSON.stringify(r.rejected[0]));
  ok(led.items.find((x) => x.id === "OPS-001").status === "fixed",
    "**原状态没被覆盖**（仍是 A 改的 fixed）", led.items.find((x) => x.id === "OPS-001").status);
}

// ── ④ 幂等 ──
console.log("\n[4] 幂等：同一 askId 回报两次 → 只写一次");
{
  seed(1);
  const writer = createLedgerWriter({ ledgerPath: LEDGER, loadConfig: () => CONFIG });
  const r1 = await writer.apply([{ id: "OPS-001", to: "fixed" }], { askId: "same-ask" });
  const r2 = await writer.apply([{ id: "OPS-001", to: "fixed" }], { askId: "same-ask" });
  const led = read();
  ok(r1.ok === true && r1.applied.length === 1, "第一次正常写入", JSON.stringify(r1.applied));
  ok(r2.duplicate === true, "第二次被识别为重复", JSON.stringify({ dup: r2.duplicate }));
  ok(led.history.length === 1, "**history 只有 1 条**（没有写两遍）", led.history.length + " 条");
}

// ── ⑤ 校验 ──
console.log("\n[5] 校验：非法状态 / 不存在的卡 / 车道不匹配都要拒");
{
  seed(2);
  const led = read();
  const bad1 = validateChange(led, CONFIG, { id: "OPS-001", to: "done" });   // 没有这个状态
  ok(bad1.ok === false && /不是车道/.test(bad1.error), "「done」不是合法状态 → 拒", bad1.error);
  const bad2 = validateChange(led, CONFIG, { id: "OPS-999", to: "fixed" });  // 卡不存在
  ok(bad2.ok === false && /没有这张卡/.test(bad2.error), "卡不存在 → 拒", bad2.error);
  const bad3 = validateChange(led, CONFIG, { id: "OPS-001", to: "shipped" }); // 车道不匹配
  ok(bad3.ok === false, "bug 车道的卡不能改成 feature 的状态 → 拒", bad3.error);
  const good = validateChange(led, CONFIG, { id: "OPS-001", to: "fixed" });
  ok(good.ok === true && good.from === "open" && good.to === "fixed", "合法变更通过", JSON.stringify({ from: good.from, to: good.to }));
  // 错误信息要能让人知道该填什么
  ok(/可选：/.test(bad1.error), "拒绝时列出可选状态（人能看懂怎么改）", bad1.error.slice(0, 80));
}

// ── ⑥ 部分失败：合法的照写，非法的拒收（部分成功语义）──
console.log("\n[6] 一批里有一张不合法 → 合法的照写、非法的拒收（不回滚整批）");
{
  seed(2);
  const writer = createLedgerWriter({ ledgerPath: LEDGER, loadConfig: () => CONFIG });
  const r = await writer.apply([
    { id: "OPS-001", to: "fixed" },      // 合法
    { id: "OPS-002", to: "不存在的状态" }, // 非法
  ], { askId: "mixed" });
  const led = read();
  ok(r.applied.length === 1 && r.rejected.length === 1, "分别报告成了 1 张、拒了 1 张",
    "applied=" + r.applied.length + " rejected=" + r.rejected.length);
  ok(r.ok === false, "整体 ok=false（有被拒的，调用方要能看出来）", "ok=" + r.ok);
  ok(led.items.find((x) => x.id === "OPS-001").status === "fixed",
    "合法那张**写进去了**（真的做完的活不能不算数）", led.items.find((x) => x.id === "OPS-001").status);
  ok(led.items.find((x) => x.id === "OPS-002").status === "open",
    "非法那张**没被改**（保持原状等重说）", led.items.find((x) => x.id === "OPS-002").status);
  ok(led.history.length === 1, "只记了 1 条 history（没给被拒的那张乱记）", led.history.length + " 条");
  // 关键：不能出现「status 改了但 updatedAt 没改」这种半成品
  const it1 = led.items.find((x) => x.id === "OPS-001");
  ok(it1.updatedAt && it1.updatedAt !== "2026-01-01T00:00:00.000Z",
    "写进去的那张 updatedAt 也一起更新了（没有半成品）", it1.updatedAt);
}

// ── ⑦ 原子落盘 ──
console.log("\n[7] 原子落盘：不会留下半截 JSON");
{
  const f = join(TMP, "atomic.json");
  atomicWriteJson(f, { a: 1, b: "中文", c: [1, 2, 3] });
  const back = JSON.parse(readFileSync(f, "utf8"));
  ok(back.a === 1 && back.b === "中文", "写进去能原样读回", JSON.stringify(back));
  // 目录里不该留 .tmp
  const leftovers = readdirSync(TMP).filter((n) => n.includes(".tmp."));
  ok(leftovers.length === 0, "没有残留 .tmp 文件", leftovers.join(",") || "(无)");
}

// ── ⑧ 跨进程文件锁 ──
console.log("\n[8] 文件锁：拿不到锁就等，超时要报错（不能静默继续）");
{
  const lp = join(TMP, "x.lock");
  const release = acquireFileLock(lp);
  ok(existsSync(lp), "锁文件已创建");
  let threw = null;
  try {
    acquireFileLock(lp, { waitMs: 80, pollMs: 10 });
  } catch (e) { threw = e; }
  ok(!!threw && /被占用/.test(threw.message), "第二次拿锁超时报错（不静默继续）", threw ? threw.message.slice(0, 60) : "(没报错)");
  release();
  ok(!existsSync(lp), "释放后锁文件消失");
  const again = acquireFileLock(lp, { waitMs: 100 });
  ok(typeof again === "function", "释放后能重新拿到");
  again();
}

// ── ⑨ 并发 + 过期 + 幂等 混合 ──
console.log("\n[9] 混合压力：并发写入 + 重复 askId + 过期期望，最终状态必须自洽");
{
  seed(4);
  const writer = createLedgerWriter({ ledgerPath: LEDGER, loadConfig: () => CONFIG });
  const jobs = [];
  for (let i = 1; i <= 4; i++) {
    const id = "OPS-" + String(i).padStart(3, "0");
    // 每个卡两个请求：一个正常、一个重复 askId（模拟重试）
    jobs.push(writer.apply([{ id, to: "fixed", expectFrom: "open" }], { askId: "x-" + i }));
    jobs.push(writer.apply([{ id, to: "closed", expectFrom: "open" }], { askId: "y-" + i }));  // 会过期或被覆盖
  }
  const rs = await Promise.all(jobs);
  const led = read();
  const changed = led.items.filter((x) => x.status !== "open").length;
  ok(changed === 4, "4 张卡都变成了某个收口状态（没有一张还停在 open）", changed + "/4");
  // 每张卡在 history 里最多一条「从 open 出发」的记录 —— 双写就会变两条
  const perCard = {};
  for (const h of led.history) {
    const id = String(h.text).split(" ")[0];
    perCard[id] = (perCard[id] || 0) + 1;
  }
  ok(Object.values(perCard).every((n) => n === 1), "每张卡只有 1 条 history（没被写两遍）", JSON.stringify(perCard));
}

// ── ⑩ setFiles：补 files 字段（0-a）──
console.log("\n[10] setFiles：补文件清单，不产生 history 噪音");
{
  seed(2);
  const writer = createLedgerWriter({ ledgerPath: LEDGER, loadConfig: () => CONFIG });
  const r = await writer.setFiles("OPS-001", [".\\utils\\a.js", " b.js ", ""]);
  const led = read();
  const it = led.items.find((x) => x.id === "OPS-001");
  ok(r.ok === true, "写入成功", JSON.stringify(r.files));
  ok(it.files.join(",") === "utils/a.js,b.js", "归一后写进台账（反斜杠/空项处理）", JSON.stringify(it.files));
  ok(led.history.length === 0, "**没产生 history**（元数据更新不该污染时间线）", led.history.length + " 条");
  ok(it.status === "open", "状态没被改", it.status);
  const bad = await writer.setFiles("OPS-999", ["a.js"]);
  ok(bad.ok === false && /没有这张卡/.test(bad.error), "卡不存在 → 拒", bad.error);
  const empty = await writer.setFiles("OPS-001", []);
  ok(empty.ok === false && /为空/.test(empty.error), "空清单不覆盖原值", empty.error);
  const still = read().items.find((x) => x.id === "OPS-001");
  ok(still.files.join(",") === "utils/a.js,b.js", "原值还在（没被空清单清掉）", JSON.stringify(still.files));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
