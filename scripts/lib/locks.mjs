// 锁表（0-d / §十E.1、§十E.2）。
//
// 这份文件解决的是一条**真实竞态**：
//
//   请求 A：读锁表 → 空 → (await 让出执行权)
//   请求 B：读锁表 → 空 → (await 让出执行权)
//   请求 A：加锁成功
//   请求 B：加锁成功        ← 两个都以为自己拿到了
//
// 「查冲突」和「加锁」之间只要有一次 await（读文件、算闭包都会让出），
// 就有这个窗口。所以本模块的 `acquire()` 把「读-判-写」整个放进
// **同一个写入队列**，中间不允许有别的任务插进来。
//
// 第二个问题是进程重启（§十E.2）：
//   锁只在内存里 → 宿主重启，锁全丢，但 agent 还在跑、还占着文件
//   → 别的 agent 被放行 → 两个 agent 改同一文件
// 所以锁必须落盘，并且**启动时按 TTL 过滤**（过期的丢掉，没过的载回来）。

import { readFileSync, existsSync } from "node:fs";
import { createWriteQueue, atomicWriteJson } from "./ledger-write.mjs";

/** 默认锁有效期（§十A.2：Q3 从 1800s 收紧到 600s）。 */
export const DEFAULT_TTL_SEC = 600;

/**
 * 冲突判据（§5.1）：
 *
 *   conflict(A,B) ⟺ closure(A) ∩ (B.files ∪ B.closure) ≠ ∅
 *                 ∨ A.files ∩ B.files ≠ ∅
 *
 * 即：A 的波及面碰到 B 的任何一部分，或反之。
 * 注意是**双向**的 —— 不能只查一边，否则「新来的碰老锁」和「老锁碰新来的」只挡住一半。
 *
 * @param a  新请求 { files:[], closure:[] }
 * @param b  已有锁 { files:[], closure:[] }
 * @returns { string[] } 冲突的文件列表（空数组 = 不冲突）
 */
export function conflictFiles(a, b) {
  const af = new Set(a.files || []);
  const ac = new Set(a.closure || []);
  const bf = new Set(b.files || []);
  const bc = new Set(b.closure || []);
  const hit = new Set();
  // ① 对方的 files 碰我的 files 或我的闭包
  for (const f of bf) if (af.has(f) || ac.has(f)) hit.add(f);
  // ② 对方的闭包碰我的 files 或我的闭包
  for (const f of bc) if (af.has(f) || ac.has(f)) hit.add(f);
  // ③ 我的 files 碰对方的闭包（反向再查一遍，因为 ① 只从 bf 出发）
  for (const f of af) if (bf.has(f) || bc.has(f)) hit.add(f);
  return [...hit].sort();
}

/**
 * 建一个锁表。
 *
 * @param opts.locksPath  锁表 JSON 路径
 * @param opts.now        () => Date.now()（测试可注入时钟）
 * @param opts.ttlSec     默认 TTL
 */
export function createLockTable({ locksPath, now, ttlSec = DEFAULT_TTL_SEC }) {
  const enqueue = createWriteQueue();
  const clock = now || (() => Date.now());
  /** id -> lock */
  let locks = new Map();

  // ── 启动恢复（§十E.2）──
  // 读盘 + **按 TTL 丢掉过期的**。不丢的话，一个昨天崩掉的 agent 会永远锁着文件。
  function load() {
    locks = new Map();
    if (!existsSync(locksPath)) return { loaded: 0, expired: 0 };
    let expired = 0;
    try {
      const raw = JSON.parse(readFileSync(locksPath, "utf8"));
      const arr = Array.isArray(raw) ? raw : Array.isArray(raw.locks) ? raw.locks : [];
      const t = clock();
      for (const l of arr) {
        if (!l || !l.lockId || !Array.isArray(l.files)) continue;
        const acquired = Date.parse(l.acquiredAt);
        const ttl = Number(l.ttlSec) > 0 ? Number(l.ttlSec) : ttlSec;
        if (!Number.isFinite(acquired) || t + 0 > acquired + ttl * 1000) { expired++; continue; }
        locks.set(l.lockId, {
          lockId: l.lockId,
          owner: String(l.owner || ""),
          task: String(l.task || ""),
          files: l.files.slice(),
          closure: Array.isArray(l.closure) ? l.closure.slice() : [],
          acquiredAt: l.acquiredAt,
          ttlSec: ttl,
        });
      }
    } catch { /* 锁表坏了就当空的；宁可重新判一次，也不要卡死所有调派 */ }
    return { loaded: locks.size, expired };
  }

  function persist() {
    // 未过期的才落盘 —— 免得把一堆死锁也存回去
    const t = clock();
    const arr = [...locks.values()].filter((l) => {
      const acquired = Date.parse(l.acquiredAt);
      return Number.isFinite(acquired) && t <= acquired + l.ttlSec * 1000;
    });
    atomicWriteJson(locksPath, { version: 1, savedAt: new Date(t).toISOString(), locks: arr });
  }

  /**
   * 申请一把锁。**查冲突 + 加锁 在同一段队列内完成**（§十E.1）。
   *
   * @param req { owner, task, files:[], closure:[], ttlSec? }
   * @returns { ok:true, lock } | { ok:false, conflicts:[{lockId,owner,files:[冲突文件]}] }
   */
  function acquire(req) {
    return enqueue(async () => {
      const t = clock();
      // 先把过期的清掉（不落盘，写的时候会一起过滤）
      for (const [id, l] of locks) {
        const acquired = Date.parse(l.acquiredAt);
        if (!Number.isFinite(acquired) || t > acquired + l.ttlSec * 1000) locks.delete(id);
      }
      const want = {
        files: Array.isArray(req.files) ? req.files.slice() : [],
        closure: Array.isArray(req.closure) ? req.closure.slice() : [],
      };
      if (!want.files.length) {
        return { ok: false, error: "没声明要改哪些文件（files 为空），无法判冲突" };
      }
      // 判冲突：对所有现存锁逐个比
      const conflicts = [];
      for (const l of locks.values()) {
        if (l.owner === req.owner) continue;   // 同一个人重复申请不算冲突（幂等，见下）
        const hit = conflictFiles(want, l);
        if (hit.length) conflicts.push({ lockId: l.lockId, owner: l.owner, task: l.task, files: hit });
      }
      if (conflicts.length) return { ok: false, conflicts };

      // 同 owner + 同 files 的重复申请：返回原来那把，不新增（幂等）
      const same = [...locks.values()].find(
        (l) => l.owner === req.owner && l.files.join("\u0000") === want.files.join("\u0000")
      );
      if (same) return { ok: true, lock: same, reused: true };

      const lock = {
        lockId: "L-" + t.toString(36) + "-" + Math.random().toString(36).slice(2, 6),
        owner: String(req.owner || ""),
        task: String(req.task || ""),
        files: want.files,
        closure: want.closure,
        acquiredAt: new Date(t).toISOString(),
        ttlSec: Number(req.ttlSec) > 0 ? Number(req.ttlSec) : ttlSec,
      };
      locks.set(lock.lockId, lock);
      persist();
      return { ok: true, lock };
    });
  }

  /** 释放。只能释放自己的（防误删别人的锁）。 */
  function release(lockId, owner) {
    return enqueue(async () => {
      const l = locks.get(lockId);
      if (!l) return { ok: false, error: "没有这把锁：" + lockId };
      if (owner && l.owner !== owner) return { ok: false, error: "这把锁属于 " + l.owner + "，不能由 " + owner + " 释放" };
      locks.delete(lockId);
      persist();
      return { ok: true, released: lockId };
    });
  }

  /** 心跳续期（§十A.2 Q3 要求）。 */
  function renew(lockId, owner, extraSec) {
    return enqueue(async () => {
      const l = locks.get(lockId);
      if (!l) return { ok: false, error: "没有这把锁：" + lockId };
      if (owner && l.owner !== owner) return { ok: false, error: "不是你的锁" };
      const t = clock();
      l.acquiredAt = new Date(t).toISOString();   // 从现在起重新计时
      if (Number(extraSec) > 0) l.ttlSec = Number(extraSec);
      persist();
      return { ok: true, lock: l };
    });
  }

  /** 手动回收（§十A.2：agent 进程崩了没人来释放，要能人工清）。 */
  function forceRelease(lockId, why) {
    return enqueue(async () => {
      const l = locks.get(lockId);
      if (!l) return { ok: false, error: "没有这把锁：" + lockId };
      locks.delete(lockId);
      persist();
      return { ok: true, released: lockId, why: String(why || "手动回收") };
    });
  }

  function list() {
    const t = clock();
    return [...locks.values()].map((l) => {
      const acquired = Date.parse(l.acquiredAt);
      return { ...l, expiresInSec: Math.max(0, Math.round((acquired + l.ttlSec * 1000 - t) / 1000)) };
    });
  }

  return { load, acquire, release, renew, forceRelease, list, _count: () => locks.size };
}
