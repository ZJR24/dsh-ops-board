// scripts/lib/evidence.mjs — 卡片证据的「新鲜度」核算。
//
// 解决的问题：卡片写着「已修好」，证据指向 `cloudfunctions/x/index.js`。
// 但那个文件后来又被人改了 21 天。这条结论还成立吗？没人知道。
//
// 台账里没有任何字段能回答这个 —— 卡片记录的是"当时的判断"，
// 而代码是会继续变的。所以只能拿 git 的提交时间去比对：
//
//   卡片 updatedAt  vs  证据文件最后一次改动时间
//
// 文件在卡片之后被改过 ⇒ 标记 stale，提示"这条结论要重新看一眼"。
// 这不是说结论一定错了，而是说**它已经没人复核过了**。
//
// 只用 `git log -1 -- <path>`，一次一个文件，按路径缓存。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { firstPath } from "./evidence-path.mjs";

// 证据里写的路径常常带尾巴（「的 guard()」「（同口径分支）」），由 evidence-path 统一认。

// 只查「声称已经完事」的卡片。还在处理中的卡片本来就该继续变，不算过期。
const DONE_STATUS = new Set(["fixed", "shipped", "closed"]);

function gitLastChange(projectDir, relPath, cache) {
  if (cache.has(relPath)) return cache.get(relPath);
  let out = null;
  try {
    const s = execFileSync(
      "git",
      ["log", "-1", "--format=%H|%at", "--", relPath],
      { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }
    ).trim();
    if (s) {
      const [hash, at] = s.split("|");
      const ms = Number(at) * 1000;
      if (hash && Number.isFinite(ms)) out = { hash: hash.slice(0, 7), at: ms };
    }
  } catch {
    // 不是 git 仓库 / 文件没进过版本库 / git 不在 PATH —— 都当"查不到"，
    // 不抛错。查不到只是少一个提示，不该让整块看板打不开。
  }
  cache.set(relPath, out);
  return out;
}

function refsOf(item) {
  const out = [];
  for (const e of item.evidence || []) {
    if (!e) continue;
    const kind = typeof e === "string" ? "value" : e.kind || "value";
    if (kind !== "file") continue;
    const text = typeof e === "string" ? e : e.text || "";
    const p = firstPath(text);
    if (p) out.push({ path: p, text });
  }
  return out;
}

/**
 * 核算一块看板的证据新鲜度。
 *
 * @param {string} projectDir 被跟踪的项目根（git 仓库所在）
 * @param {object} ledger     ledger.json 的内容
 * @param {object} [opts]
 * @param {number} [opts.minDays] 至少隔几天才算过期（默认 1，挡掉同日改动）
 * @returns {{ok:boolean, available:boolean, reason?:string, items:object[], summary:object}}
 */
export function evidenceFreshness(projectDir, ledger, opts = {}) {
  const minDays = Number.isFinite(opts.minDays) ? opts.minDays : 1;

  if (!projectDir || !existsSync(projectDir)) {
    return { ok: true, available: false, reason: "找不到被跟踪的项目目录", items: [], summary: {} };
  }
  if (!existsSync(join(projectDir, ".git"))) {
    return { ok: true, available: false, reason: "被跟踪的项目不是 git 仓库，没有提交时间可比", items: [], summary: {} };
  }

  const cache = new Map();
  const perItem = new Map();
  let checked = 0;
  let unverifiable = 0;

  for (const item of ledger.items || []) {
    if (!DONE_STATUS.has(item.status)) continue;
    const cardAt = Date.parse(item.updatedAt || "");
    if (!Number.isFinite(cardAt)) continue;

    for (const ref of refsOf(item)) {
      if (!existsSync(join(projectDir, ref.path))) {
        unverifiable += 1;
        continue;
      }
      const lc = gitLastChange(projectDir, ref.path, cache);
      checked += 1;
      if (!lc) {
        unverifiable += 1;
        continue;
      }
      const days = Math.floor((lc.at - cardAt) / 86400000);
      if (days < minDays) continue;

      const cur = perItem.get(item.id) || {
        id: item.id,
        title: item.title || "",
        status: item.status,
        statusLabel: item.statusLabel || item.status,
        area: item.area || "",
        cardAt: item.updatedAt,
        refs: [],
        maxDays: 0,
      };
      cur.refs.push({ path: ref.path, commit: lc.hash, at: new Date(lc.at).toISOString(), days });
      if (days > cur.maxDays) cur.maxDays = days;
      perItem.set(item.id, cur);
    }
  }

  const items = [...perItem.values()].sort((a, b) => b.maxDays - a.maxDays);
  for (const it of items) it.refs.sort((a, b) => b.days - a.days);

  return {
    ok: true,
    available: true,
    items,
    summary: {
      cards: items.length,
      refs: items.reduce((n, it) => n + it.refs.length, 0),
      checked,
      unverifiable,
      worstDays: items.length ? items[0].maxDays : 0,
      projectDir,
    },
  };
}
