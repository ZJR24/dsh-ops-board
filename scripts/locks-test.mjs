// 锁表（0-d / §十E.1、§十E.2）。
//
// 两条真实故障要防：
//   ① 竞态：两个请求都「读到空 → 都加锁成功」。只要「查冲突」和「加锁」之间
//      有一次 await，就有这个窗口。→ 测试必须**真并发**（Promise.all），
//      顺序 await 一遍是测不出来的。
//   ② 重启丢锁：锁只在内存里，宿主重启后 agent 还在跑却没人知道它占了文件
//      → 别的 agent 被放行 → 两个 agent 改同一文件。
//      → 测试必须「建锁 → 换一个实例 load() → 锁还在」。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLockTable, conflictFiles, DEFAULT_TTL_SEC } from "./lib/locks.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

const TMP = mkdtempSync(join(tmpdir(), "locks-test-"));
const LOCKS = join(TMP, "locks.json");

// 可控时钟
let clockNow = Date.parse("2026-11-21T10:00:00.000Z");
const now = () => clockNow;

function freshTable() {
  rmSync(LOCKS, { force: true });
  const t = createLockTable({ locksPath: LOCKS, now });
  t.load();
  return t;
}

// ── ① 冲突判据 ──
console.log("[1] 冲突判据（§5.1）：双向都要查");
{
  const A = { files: ["utils/request.js"], closure: ["app.js", "utils/data-store.js"] };
  // B 改的东西**在 A 的闭包里** → 冲突
  const B = { files: ["app.js"], closure: [] };
  ok(conflictFiles(B, A).length === 1,
    "B 改的文件在 A 的闭包里 → 冲突", JSON.stringify(conflictFiles(B, A)));
  // C 改的东西**波及到 A 的文件** → 也要冲突（反向）
  const C = { files: ["pages/x/x.js"], closure: ["utils/request.js"] };
  ok(conflictFiles(C, A).length > 0,
    "C 的**闭包**碰到 A 的文件 → 反向也冲突（只查一边会漏）", JSON.stringify(conflictFiles(C, A)));
  // D 完全不沾边
  const D = { files: ["README.md"], closure: [] };
  ok(conflictFiles(D, A).length === 0, "完全不沾边 → 不冲突", JSON.stringify(conflictFiles(D, A)));
  // 同一文件直接撞
  const E = { files: ["utils/request.js"], closure: [] };
  ok(conflictFiles(E, A).length === 1, "同一个文件 → 冲突", JSON.stringify(conflictFiles(E, A)));
}

// ── ② 并发申请（真并发）──
console.log("\n[2] 并发申请同一块地：**只能有一个成功**（§十E.1 原子性）");
{
  const t = freshTable();
  const files = ["utils/request.js"];
  // 10 个同时抢 —— 如果「查」和「加」之间有窗口，会有多个成功
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      t.acquire({ owner: "agent-" + i, task: "改 request", files: files.slice(), closure: [] })
    )
  );
  const winners = results.filter((r) => r.ok);
  ok(winners.length === 1, "**10 个并发只成功 1 个**", winners.length + " 个成功");
  ok(t._count() === 1, "锁表里只有 1 把锁", t._count() + " 把");
  const losers = results.filter((r) => !r.ok);
  ok(losers.every((r) => r.conflicts && r.conflicts.length), "失败的都带冲突说明", JSON.stringify(losers[0]).slice(0, 100));
}

// ── ③ 不同区域可以并行 ──
console.log("\n[3] 不相干的文件：可以同时拿锁");
{
  const t = freshTable();
  const rs = await Promise.all([
    t.acquire({ owner: "a", task: "改 request", files: ["utils/request.js"], closure: ["app.js"] }),
    t.acquire({ owner: "b", task: "改页面", files: ["pages/x/x.js"], closure: [] }),
    t.acquire({ owner: "c", task: "改文档", files: ["docs/a.md"], closure: [] }),
  ]);
  ok(rs.every((r) => r.ok), "3 个不相干的都拿到了", rs.map((r) => r.ok).join(","));
  ok(t._count() === 3, "锁表 3 把", t._count() + " 把");
}

// ── ④ 重启恢复（§十E.2）──
console.log("\n[4] 重启恢复：换一个实例 load() 锁还在，仍能挡住别人");
{
  const t1 = freshTable();
  const r = await t1.acquire({ owner: "agent-A", task: "改 request", files: ["utils/request.js"], closure: ["app.js"] });
  ok(r.ok, "先拿到锁");
  // 模拟宿主重启：新实例，不共享内存
  const t2 = createLockTable({ locksPath: LOCKS, now });
  const { loaded, expired } = t2.load();
  ok(loaded === 1 && expired === 0, "新实例从磁盘恢复了 1 把锁", "loaded=" + loaded + " expired=" + expired);
  // 重启后别人**仍然被挡**
  const r2 = await t2.acquire({ owner: "agent-B", task: "也改 request", files: ["utils/request.js"], closure: [] });
  ok(r2.ok === false, "**重启后别人依然被挡**（锁没丢）", r2.ok ? "被放行了！" : JSON.stringify(r2.conflicts));
}

// ── ⑤ TTL 过期 ──
console.log("\n[5] TTL：过期的锁自动失效，不会永远占着");
{
  const t = freshTable();
  await t.acquire({ owner: "A", task: "x", files: ["f.js"], closure: [], ttlSec: 60 });
  // 时间过 61 秒
  clockNow += 61 * 1000;
  const r = await t.acquire({ owner: "B", task: "y", files: ["f.js"], closure: [] });
  ok(r.ok === true, "过了 TTL 后别人能拿到", r.ok ? "拿到了" : JSON.stringify(r.conflicts));
  ok(t._count() === 1, "过期的被清掉，只剩新的那把", t._count() + " 把");
}

// ── ⑥ 重启时丢弃过期锁 ──
console.log("\n[6] 启动恢复会丢掉过期锁（昨天的死锁不该锁到今天）");
{
  rmSync(LOCKS, { force: true });
  // 手写一份锁表：一把有效期 60s、acquiredAt 是 1 小时前
  const old = new Date(clockNow - 3600 * 1000).toISOString();
  writeFileSync(LOCKS, JSON.stringify({
    version: 1,
    locks: [
      { lockId: "L-old", owner: "dead-agent", task: "早崩了", files: ["f.js"], closure: [], acquiredAt: old, ttlSec: 60 },
    ],
  }), "utf8");
  const t = createLockTable({ locksPath: LOCKS, now });
  const { loaded, expired } = t.load();
  ok(loaded === 0 && expired === 1, "过期的被丢弃", "loaded=" + loaded + " expired=" + expired);
  ok(t._count() === 0, "锁表为空", t._count() + " 把");
  const r = await t.acquire({ owner: "B", task: "y", files: ["f.js"], closure: [] });
  ok(r.ok === true, "于是别人能正常开工", r.ok ? "可以" : "被死锁挡住了");
}

// ── ⑦ 释放与越权 ──
console.log("\n[7] 释放：只能释放自己的锁");
{
  const t = freshTable();
  const r = await t.acquire({ owner: "A", task: "x", files: ["f.js"], closure: [] });
  const bad = await t.release(r.lock.lockId, "B");
  ok(bad.ok === false && /属于/.test(bad.error), "B 不能释放 A 的锁", bad.error);
  ok(t._count() === 1, "锁还在", t._count() + " 把");
  const good = await t.release(r.lock.lockId, "A");
  ok(good.ok === true, "A 能释放自己的", JSON.stringify(good));
  ok(t._count() === 0, "释放后锁表空", t._count() + " 把");
}

// ── ⑧ 心跳续期 ──
console.log("\n[8] 心跳续期：长任务不会因为 TTL 到期被抢");
{
  const t = freshTable();
  const r = await t.acquire({ owner: "A", task: "长活", files: ["f.js"], closure: [], ttlSec: 60 });
  clockNow += 50 * 1000;               // 快到期了
  const rn = await t.renew(r.lock.lockId, "A");
  ok(rn.ok === true, "续期成功", "新到期时间=" + rn.lock.acquiredAt);
  clockNow += 50 * 1000;               // 如果不续期，现在已经过期了
  const blocked = await t.acquire({ owner: "B", task: "y", files: ["f.js"], closure: [] });
  ok(blocked.ok === false, "**续期后别人还是拿不到**（这就是心跳的意义）", blocked.ok ? "被抢了！" : "仍被挡");
}

// ── ⑨ 手动回收 ──
console.log("\n[9] 手动回收：agent 崩了，人能清掉锁");
{
  const t = freshTable();
  const r = await t.acquire({ owner: "A", task: "x", files: ["f.js"], closure: [], ttlSec: 9999 });
  const forced = await t.forceRelease(r.lock.lockId, "确认 agent 已死");
  ok(forced.ok === true, "手动回收成功", JSON.stringify(forced));
  ok(t._count() === 0, "锁没了", t._count() + " 把");
  const r2 = await t.acquire({ owner: "B", task: "y", files: ["f.js"], closure: [] });
  ok(r2.ok === true, "别人能接着干", "可以");
}

// ── ⑩ 幂等 + 空 files ──
console.log("\n[10] 幂等与防御：同人重复申请复用、空 files 拒绝");
{
  const t = freshTable();
  const a1 = await t.acquire({ owner: "A", task: "x", files: ["f.js"], closure: [] });
  const a2 = await t.acquire({ owner: "A", task: "x", files: ["f.js"], closure: [] });
  ok(a2.reused === true && a2.lock.lockId === a1.lock.lockId, "同人同文件重复申请 → 复用原锁", a2.lock.lockId);
  ok(t._count() === 1, "没有多出锁", t._count() + " 把");

  const empty = await t.acquire({ owner: "B", task: "y", files: [], closure: [] });
  ok(empty.ok === false && /没声明/.test(empty.error), "files 为空 → 拒绝（无法判冲突就不放行）", empty.error);
}

// ── ⑪ 落盘内容不含过期锁 ──
console.log("\n[11] 落盘过滤：磁盘上不该留过期锁");
{
  const t = freshTable();
  await t.acquire({ owner: "A", task: "x", files: ["a.js"], closure: [], ttlSec: 60 });
  await t.acquire({ owner: "B", task: "y", files: ["b.js"], closure: [], ttlSec: 9999 });
  clockNow += 61 * 1000;
  // 触发一次落盘（释放 B 会 persist）
  const listNow = t.list();
  ok(listNow.length === 2, "list() 里两把都还在（未主动清理）", listNow.length + " 把");
  // 但 acquire 会清过期 + persist
  await t.acquire({ owner: "C", task: "z", files: ["c.js"], closure: [] });
  const onDisk = JSON.parse(readFileSync(LOCKS, "utf8"));
  ok(onDisk.locks.length === 2, "磁盘上只剩 2 把（过期的那把没被写回去）",
    onDisk.locks.map((l) => l.owner).join(","));
  ok(!onDisk.locks.some((l) => l.owner === "A"), "过期的 A 不在了", onDisk.locks.map((l) => l.owner).join(","));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
