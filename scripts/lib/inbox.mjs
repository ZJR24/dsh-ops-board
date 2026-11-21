// 回报 inbox（0-e / §十E.3）。
//
// 问题：中控把「判冲突」和「写台账」都集中在宿主进程。它一旦挂掉/重启：
//
//   锁在内存    → 丢了（已由 locks.mjs 的落盘 + TTL 恢复解决）
//   agent 回报  → **没人接收，直接丢失**   ← 本模块解决的就是这条
//
// 这是数据丢失级别的故障：agent 花了 5 分钟干完活，回报发出去，
// 中控那一瞬间在重启 —— 活白干了，而且**没人知道**。
//
// 做法：把「收下」和「处理完」分成两个状态。
//
//   agent POST 回报
//       ↓
//   ① 立刻原子写入 inbox/<askId>.json     ← 收下了，落盘了
//   ② 回 202（收下 ≠ 处理完）
//       ↓
//   ③ 队列消费 inbox → 校验 → 写台账 → 删除该文件
//       ↓
//   重启 → 扫 inbox → 继续消费（靠 askId 幂等，重复处理也安全）
//
// ⚠️ 关键判据：**「收下」必须比「处理完」先落盘**。
//    如果先处理再落盘，处理到一半崩了，这条回报就两头都没有。

import { existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createWriteQueue, atomicWriteJson } from "./ledger-write.mjs";

/**
 * 建一个 inbox。
 *
 * @param opts.dir        inbox 目录（不存在会自动建）
 * @param opts.now        () => ISO 时间串
 * @param opts.handle     处理一条回报的异步函数 (payload) => result
 *                        **必须是幂等的**（同一 askId 重复调用结果一致）
 */
export function createInbox({ dir, now, handle }) {
  const clock = now || (() => new Date().toISOString());
  mkdirSync(dir, { recursive: true });
  const enqueue = createWriteQueue();
  const consumed = new Set();

  const fileOf = (askId) => join(dir, encodeURIComponent(String(askId)) + ".json");

  /**
   * 收下一条回报（**只落盘，不处理**）。
   * 返回得很快 —— 调用方（agent）不该等台账写完。
   */
  function put(askId, payload) {
    const id = String(askId || "").trim();
    if (!id) throw new Error("回报缺 askId（无法做幂等去重）");
    const file = fileOf(id);
    // 同一个 askId 已经收过了：不再覆盖（避免后到的旧内容盖掉新内容）
    if (existsSync(file)) return { accepted: true, duplicate: true, askId: id };
    atomicWriteJson(file, {
      askId: id,
      receivedAt: clock(),
      payload: payload || {},
    });
    return { accepted: true, duplicate: false, askId: id };
  }

  /** 待处理的回报（按收到时间排，先到先处理）。 */
  function pending() {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        try {
          const raw = JSON.parse(readFileSync(join(dir, n), "utf8"));
          return { file: join(dir, n), askId: raw.askId, receivedAt: raw.receivedAt || "", payload: raw.payload || {} };
        } catch {
          // 坏文件：不要静默删掉（可能是写到一半），留给人工看
          return { file: join(dir, n), askId: "", receivedAt: "", payload: {}, broken: true };
        }
      })
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  }

  /**
   * 消费所有待处理回报。**只删处理成功的**；处理失败就留在原地等重试。
   *
   * @returns { processed, failed, skipped }
   */
  function drain() {
    return enqueue(async () => {
      const list = pending();
      let processed = 0, failed = 0, skipped = 0;
      for (const item of list) {
        if (item.broken || !item.askId) { failed++; continue; }
        if (consumed.has(item.askId)) {           // 本进程已处理过（防重入）
          try { unlinkSync(item.file); } catch {}
          skipped++;
          continue;
        }
        let res;
        try {
          res = await handle(item.payload);
        } catch (e) {
          // 处理失败：**不删文件**，下次 drain 再来一次（handle 必须幂等）
          failed++;
          continue;
        }
        consumed.add(item.askId);
        processed++;
        try { unlinkSync(item.file); } catch {}
        void res;
      }
      return { processed, failed, skipped, remaining: pending().length };
    });
  }

  return { put, pending, drain, _dir: dir };
}
