// 台账写入通道（0-c，§十C）。
//
// 为什么需要这个模块：现在**没有任何东西**在写台账 —— `serve.mjs` 从不写，
// 唯一写入口是 agent 自己改文件。那一改就绕过了所有校验，也留不下审计。
// 一旦改成「调度台代写」，多个 agent 的回报就会并发到达，于是三个必防的问题：
//
//   ① 丢失更新：两次写入并发，后写的把先写的覆盖掉（且静默）
//   ② 过期覆盖：agent 用开工时的旧状态，盖掉别人刚改成的新状态
//   ③ 重复回报：网络重试导致同一 askId 写两遍（history 出现两条一样的）
//
// Node 单线程**救不了** ①：它只保证「同一时刻一段 JS 在跑」，
// 不保证「读-改-写」是一个整体 —— 中间的 await 就是插队点。
// （对照：serve.mjs 的 flowClaims 是安全的，因为它全程用内存 Map，
//   只在最后原子落盘。台账是磁盘 JSON，每次都要 await 读，躲不开。）
//
// 所以这里用「一个队列 + 原子落盘 + 写前重新校验 + askId 幂等」四件套。
//
// ⚠️ 落地顺序不可颠倒（§十C.9）：先让新通道跑通，**再**关掉 agent 的写权限。
//    反过来会有一段「谁也写不了台账」的窗口期，所有回报都会丢。

import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";

/**
 * 串行队列：所有写入排成一队，一次只跑一个。
 *
 * 关键点：`then(fn, fn)` —— 成功和失败都接着走。
 * 用 `then(fn).catch(...)` 只在失败时处理，但队列会**卡死**
 * （下一个任务永远不会被调起），这在「一次写入失败」之后就是灾难。
 */
export function createWriteQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const run = tail.then(fn, fn);
    // 队列本身不能因为某个任务失败而把后续任务吞掉，
    // 但也不能把失败变成 unhandledRejection。
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}

/** 原子落盘：先写 .tmp 再 rename。断电/崩溃都不会留下半个坏 JSON。 */
export function atomicWriteJson(file, obj) {
  const tmp = file + ".tmp." + process.pid + "." + Date.now().toString(36);
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, file);
}

/**
 * 给台账文件加一把「跨进程」的独占锁。
 *
 * 为什么进程内队列还不够：同一个看板可能被**两个 serve 进程**打开
 * （用户开了两个窗口、或者插件和独立窗各起了一个）。进程内队列管不到另一个进程。
 *
 * 做法：`openSync(path, "wx")` —— `wx` 是「只有不存在才能创建」，
 * 这是操作系统提供的原子操作，天然互斥。拿不到就等，等不到就超时。
 *
 * ⚠️ 这是最简实现，刻意不做「检测僵尸锁」（锁文件残留）。
 *    判据：超时就报错，让人知道，**不要自动清理** ——
 *    自动清理会把正在写的那一方锁抢走，比报错更糟。
 */
export function acquireFileLock(lockPath, { waitMs = 3000, pollMs = 20 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      // 释放 = 删掉锁文件。这里**不做 rename** —— rename 会留下 .released 垃圾，
      // 而且删不掉就说明有权限问题，rename 只是把问题藏起来。
      return () => { try { unlinkSync(lockPath); } catch {} };
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        throw new Error("台账被占用，等 " + waitMs + "ms 仍拿不到锁：" + lockPath);
      }
      // 同步忙等：这个写入器本身是同步模型，sleep 用短自旋最省事。
      const until = Date.now() + pollMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

/**
 * 校验一次「状态变更」是否合法。
 *
 * @param ledger   台账原文（{items:[]}）
 * @param config   board.config.json
 * @param change   { id, to, expectFrom?, by? }
 * @returns { ok:true, item } | { ok:false, error }
 */
export function validateChange(ledger, config, change) {
  const id = String((change && change.id) || "").trim();
  const to = String((change && change.to) || "").trim();
  if (!id) return { ok: false, error: "缺卡片 id" };
  if (!to) return { ok: false, error: "缺目标状态 to" };

  const items = (ledger && Array.isArray(ledger.items)) ? ledger.items : [];
  const item = items.find((x) => x && x.id === id);
  if (!item) return { ok: false, error: "台账里没有这张卡：" + id };

  // ① 状态名必须在该车道的合法集合里（board.config.json 的 stages[].statuses）
  const lane = (config && Array.isArray(config.lanes) ? config.lanes : []).find((l) => l.key === item.lane);
  if (!lane) return { ok: false, error: "卡片 " + id + " 的车道 " + item.lane + " 不在配置里" };
  const legal = new Set();
  for (const st of lane.stages || []) for (const s of st.statuses || []) legal.add(s);
  if (!legal.has(to)) {
    return {
      ok: false,
      error: "「" + to + "」不是车道「" + lane.label + "」的合法状态。可选：" + [...legal].join(" / "),
    };
  }

  // ② 过期检查：调用方如果声明了「我以为它现在是 X」，就必须真的是 X。
  //    这是防「agent 用开工时的旧状态覆盖别人刚改成的新状态」。
  if (change.expectFrom !== undefined && change.expectFrom !== null && change.expectFrom !== "") {
    if (item.status !== change.expectFrom) {
      return {
        ok: false,
        error: "状态已被别人改过：" + id + " 现在是「" + item.status + "」，不是你以为的「" + change.expectFrom + "」",
        stale: true,
        current: item.status,
      };
    }
  }
  return { ok: true, item, from: item.status, to };
}

/**
 * 建一个台账写入器。
 *
 * @param opts.ledgerPath  台账文件绝对路径
 * @param opts.loadConfig  () => config  （每次重新读，配置可能被改）
 * @param opts.now         () => ISO 时间串（测试可注入）
 */
export function createLedgerWriter({ ledgerPath, loadConfig, now }) {
  const enqueue = createWriteQueue();
  // askId → 已处理。用来做幂等：网络重试导致同一回报到达两次时，只写一次。
  // 只在进程内有效，够用 —— 跨进程重复由锁 + expectFrom 校验兜底。
  const seen = new Set();
  const clock = now || (() => new Date().toISOString());

  function readLedger() {
    return JSON.parse(readFileSync(ledgerPath, "utf8"));
  }

  /**
   * 应用一批变更。**单次调用内可能有多张卡**（agent 一次报几张）。
   *
   * @param changes  [{ id, to, expectFrom? }]
   * @param meta     { askId, by, note }
   * @returns { ok, applied:[], rejected:[], duplicate? }
   */
  function apply(changes, meta) {
    const m = meta || {};
    const askId = String(m.askId || "").trim();

    // 幂等：同一 askId 只处理一次。**放在队列外**判断，
    // 因为队列内并发判断会漏（两个请求都会被排进去）。
    if (askId && seen.has(askId)) {
      return Promise.resolve({ ok: true, duplicate: true, applied: [], rejected: [], askId });
    }

    return enqueue(async () => {
      const release = acquireFileLock(ledgerPath + ".lock");
      try {
        const ledger = readLedger();
        const config = loadConfig ? loadConfig() : null;
        const applied = [];
        const rejected = [];

        // 先校验**全部**，再统一写 —— 避免「一半写进去、一半被拒」的半成品状态。
        for (const ch of changes || []) {
          const v = validateChange(ledger, config, ch);
          if (!v.ok) rejected.push({ id: ch && ch.id, error: v.error, stale: !!v.stale, current: v.current });
          else applied.push({ item: v.item, from: v.from, to: v.to });
        }

        if (applied.length) {
          const at = clock();
          for (const a of applied) {
            a.item.status = a.to;
            a.item.updatedAt = at;
            // 自动补一条 history（以前是人手写的，现在写入时就有了）。
            // 注意 kind 用 `fixed` 这类会染色时间线；未知状态退化为 `ops`。
            const kind = kindOf(a.to);
            (ledger.history = ledger.history || []).push({
              at,
              kind,
              text:
                a.item.id + " 状态：" + a.from + " → " + a.to +
                (m.by ? "（" + m.by + "）" : "") +
                (m.note ? "：" + String(m.note).slice(0, 200) : ""),
            });
          }
          ledger.updatedAt = at;
          atomicWriteJson(ledgerPath, ledger);
          if (askId) seen.add(askId);
        } else if (askId) {
          // 全部被拒也记下来：同一个 askId 再来一次结果也一样，不必重算。
          seen.add(askId);
        }

        // ⚠️ 这里是**部分成功**语义，不是全有全无：
        //   · 一批里合法的卡照写，非法的那张只进 rejected 并说明原因；
        //   · 调用方拿到 applied + rejected 两边，可以精确知道哪张成了、哪张没成。
        //
        // 为什么不做「有一张不合法就整批回滚」：
        // 一次回报常常是「这 5 张我都处理了」，若其中一张状态名写错，
        // 整批回滚 = 另外 4 张真的做完的活**也不算数**，agent 得全部重做一遍。
        // 那比「4 成 1 待重说」糟得多。
        // （真正要防的「半成品」是**同一次改动的中间态**，比如 status 改了
        //   但 updatedAt 没改 —— 那是靠「先算完所有 applied 再一次性写盘」防的，
        //   不是靠回滚。）
        return { ok: rejected.length === 0, applied: applied.map((a) => ({ id: a.item.id, from: a.from, to: a.to })), rejected, askId };
      } finally {
        release();
      }
    });
  }

  return {
    apply,
    /**
     * 只更新某张卡的 `files` 字段（0-a）。
     *
     * 为什么单独一个入口、不走 `apply()`：
     *   · `apply()` 处理的是**状态变更**（要校验状态名合法性、要写 history）；
     *   · 补 files 是**元数据更新**，不改状态、不该产生 history 噪音。
     * 混在一起会让 history 里塞满「补了个文件列表」这种记录。
     *
     * @param files  字符串数组；反斜杠归一、去空项（和 gen-ledger 的 normFiles 同规则）
     */
    setFiles(id, files, meta) {
      const m = meta || {};
      const cardId = String(id || "").trim();
      if (!cardId) return Promise.resolve({ ok: false, error: "缺卡片 id" });
      return enqueue(async () => {
        const release = acquireFileLock(ledgerPath + ".lock");
        try {
          const ledger = readLedger();
          const items = (ledger && Array.isArray(ledger.items)) ? ledger.items : [];
          const item = items.find((x) => x && x.id === cardId);
          if (!item) return { ok: false, error: "台账里没有这张卡：" + cardId };
          const list = normalizeFiles(files);
          if (!list.length) return { ok: false, error: "files 为空，不覆盖原值" };
          item.files = list;
          item.updatedAt = clock();
          ledger.updatedAt = item.updatedAt;
          atomicWriteJson(ledgerPath, ledger);
          return { ok: true, id: cardId, files: list, by: m.by || "" };
        } finally {
          release();
        }
      });
    },
    /** 测试用：清空幂等表 */
    _resetSeen() { seen.clear(); },
    _seenCount() { return seen.size; },
  };
}

/**
 * 归一文件路径列表。和 `gen-ledger.mjs` 的 `normFiles` 保持同一规则 ——
 * 反斜杠转正斜杠、去 `./` 前缀、去空项。
 *
 * ⚠️ 两处**必须一致**：一处归一、另一处不归一，`utils\a.js` 和 `utils/a.js`
 * 就会被当成两个文件，冲突判定直接失效。这是跨平台最容易踩的坑。
 */
export function normalizeFiles(input) {
  if (input === undefined || input === null) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out = [];
  for (const el of arr) {
    if (el === null || el === undefined) continue;
    if (typeof el !== "string") continue;
    const p = el.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (p) out.push(p);
  }
  return out;
}

/** 状态 → history 的 kind（决定时间线小圆点颜色）。未知的退化到 ops。 */
function kindOf(status) {
  const map = {
    fixed: "fixed", closed: "fixed",
    shipped: "feature",
    resolved: "fixed", accepted: "fixed", paused: "ops",
    open: "found", doing: "ops",
  };
  return map[status] || "ops";
}
