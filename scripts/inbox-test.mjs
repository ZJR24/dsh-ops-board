// 回报 inbox（0-e / §十E.3）。
//
// 要防的故障：中控挂掉/重启时，agent 已经干完活的回报**直接丢失**。
// 这是数据丢失级别 —— agent 花 5 分钟做完，回报发出去，
// 中控那一瞬间在重启，活白干了，而且没人知道。
//
// 核心判据：**「收下」必须比「处理完」先落盘**。
// 所以测试的重点是：
//   ① put() 之后文件真的在磁盘上（不是只在内存）
//   ② 处理函数抛错时**不删文件**（下次还能重试）
//   ③ 重启后（新实例）能继续消费上次没处理完的
//   ④ 同一 askId 重复 put 不覆盖
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInbox } from "./lib/inbox.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

const TMP = mkdtempSync(join(tmpdir(), "inbox-test-"));
const DIR = join(TMP, "inbox");
const files = () => existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith(".json")) : [];

// ── ① 收下 = 落盘 ──
console.log("[1] 收下即落盘：put() 之后文件必须在磁盘上");
{
  rmSync(DIR, { recursive: true, force: true });
  const box = createInbox({ dir: DIR, handle: async () => ({ ok: true }) });
  const r = box.put("ask-1", { changes: [{ id: "OPS-001", to: "fixed" }] });
  ok(r.accepted === true, "收下了", JSON.stringify(r));
  ok(files().length === 1, "**磁盘上真的有这个文件**（不是只在内存）", files().join(","));
  const raw = JSON.parse(readFileSync(join(DIR, "ask-1.json"), "utf8"));
  ok(raw.askId === "ask-1" && raw.receivedAt, "文件内容完整（askId + 收到时间）", raw.receivedAt);
  ok(raw.payload.changes[0].id === "OPS-001", "payload 原样保存（重启后还能重放）", JSON.stringify(raw.payload));
}

// ── ② 重复 put 不覆盖 ──
console.log("\n[2] 同一 askId 重复收：不覆盖（防旧内容盖新内容）");
{
  const box = createInbox({ dir: DIR, handle: async () => ({ ok: true }) });
  const r2 = box.put("ask-1", { changes: [{ id: "OPS-999", to: "closed" }] });
  ok(r2.duplicate === true, "识别为重复", JSON.stringify(r2));
  const raw = JSON.parse(readFileSync(join(DIR, "ask-1.json"), "utf8"));
  ok(raw.payload.changes[0].id === "OPS-001", "**原内容没被覆盖**", raw.payload.changes[0].id);
  ok(files().length === 1, "没有多出文件", files().length + " 个");
}

// ── ③ 消费成功才删 ──
console.log("\n[3] 处理成功 → 删除；处理失败 → 留着等重试");
{
  rmSync(DIR, { recursive: true, force: true });
  const handled = [];
  const box = createInbox({
    dir: DIR,
    handle: async (p) => { handled.push(p.tag); if (p.tag === "boom") throw new Error("处理失败"); return { ok: true }; },
  });
  box.put("a-ok", { tag: "ok1" });
  box.put("a-boom", { tag: "boom" });
  box.put("a-ok2", { tag: "ok2" });
  const r = await box.drain();
  ok(r.processed === 2, "2 条处理成功", JSON.stringify(r));
  ok(r.failed === 1, "1 条失败", "failed=" + r.failed);
  ok(files().length === 1 && files()[0] === "a-boom.json",
    "**失败的那条文件还在**（下次还能重试）", files().join(","));
  ok(handled.length === 3, "三条都尝试过", handled.join(","));
}

// ── ④ 重试成功 ──
console.log("\n[4] 失败的那条，下一轮能补上");
{
  let secondTimeOk = false;
  const box = createInbox({
    dir: DIR,
    handle: async (p) => { if (p.tag === "boom" && !secondTimeOk) throw new Error("还是失败"); return { ok: true }; },
  });
  const r0 = await box.drain();
  ok(r0.failed === 1, "第一次还是失败", "failed=" + r0.failed);
  secondTimeOk = true;
  const r1 = await box.drain();
  ok(r1.processed === 1, "第二次成功了", JSON.stringify(r1));
  ok(files().length === 0, "处理完的文件删掉了", files().length + " 个");
}

// ── ⑤ 重启恢复（关键）──
console.log("\n[5] 重启恢复：中控挂了，重启后能把没处理完的回报补上");
{
  rmSync(DIR, { recursive: true, force: true });
  // 第一个实例：只收，不处理（模拟「刚收下就崩了」）
  const box1 = createInbox({ dir: DIR, handle: async () => ({ ok: true }) });
  box1.put("crash-1", { changes: [{ id: "OPS-001", to: "fixed" }] });
  box1.put("crash-2", { changes: [{ id: "OPS-002", to: "fixed" }] });
  ok(files().length === 2, "收下 2 条，还没处理就「崩」了", files().length + " 个");

  // 第二个实例：全新对象，不共享内存 —— 这就是重启
  const applied = [];
  const box2 = createInbox({
    dir: DIR,
    handle: async (p) => { applied.push(...p.changes.map((c) => c.id)); return { ok: true }; },
  });
  const pendingBefore = box2.pending();
  ok(pendingBefore.length === 2, "**新实例看到了那 2 条**（没丢）", pendingBefore.map((p) => p.askId).join(","));
  const r = await box2.drain();
  ok(r.processed === 2, "全部补处理了", JSON.stringify(r));
  ok(applied.join(",") === "OPS-001,OPS-002", "内容正确、顺序按收到时间", applied.join(","));
  ok(files().length === 0, "清空了", files().length + " 个");
}

// ── ⑥ 按收到时间排序 ──
console.log("\n[6] 处理顺序 = 收到顺序（先到先处理）");
{
  rmSync(DIR, { recursive: true, force: true });
  let t = Date.parse("2026-11-21T10:00:00.000Z");
  const box = createInbox({
    dir: DIR,
    now: () => new Date(t += 1000).toISOString(),
    handle: async () => ({ ok: true }),
  });
  // 故意不按顺序收
  box.put("m-2", { tag: "第二" });
  box.put("m-1", { tag: "第一" });
  box.put("m-3", { tag: "第三" });
  const order = box.pending().map((p) => p.payload.tag);
  ok(order.join(",") === "第二,第一,第三", "按 receivedAt 排序（不是按文件名）", order.join(","));
}

// ── ⑦ 幂等：handle 被重复调用也安全 ──
console.log("\n[7] 同一 askId 不会被本进程处理两遍");
{
  rmSync(DIR, { recursive: true, force: true });
  let calls = 0;
  const box = createInbox({ dir: DIR, handle: async () => { calls++; return { ok: true }; } });
  box.put("dup-1", {});
  await box.drain();
  await box.drain();     // 再 drain 一次，不该再处理
  ok(calls === 1, "handle 只被调用 1 次", calls + " 次");
}

// ── ⑧ 坏文件不静默删 ──
console.log("\n[8] 坏掉的回报文件：不静默删除，报出来");
{
  rmSync(DIR, { recursive: true, force: true });
  const box = createInbox({ dir: DIR, handle: async () => ({ ok: true }) });
  writeFileSync(join(DIR, "broken.json"), "{ 这不是合法 JSON", "utf8");
  const p = box.pending();
  ok(p.length === 1 && p[0].broken === true, "识别为坏文件", JSON.stringify(p[0]).slice(0, 80));
  const r = await box.drain();
  ok(r.failed === 1, "算作失败（不会假装处理成功）", JSON.stringify(r));
  ok(existsSync(join(DIR, "broken.json")), "**文件还在**（留给人看，不悄悄删掉）", "还在");
}

// ── ⑨ 缺 askId 直接拒绝 ──
console.log("\n[9] 缺 askId → 直接拒绝（无法做幂等）");
{
  const box = createInbox({ dir: DIR, handle: async () => ({ ok: true }) });
  let threw = null;
  try { box.put("", {}); } catch (e) { threw = e; }
  ok(!!threw && /askId/.test(threw.message), "抛出明确错误", threw ? threw.message : "(没抛)");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
