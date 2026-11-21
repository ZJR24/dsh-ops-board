// 依赖图 + 闭包（架构文档步骤 1~3）。
//
// ⚠️ 实测推翻了文档里两个数字/做法，先说清楚（2026-11-21）：
//
//  ① **`--exclude` 不能减少耗时。** 文档 §8.1 说「必须显式 --exclude，不能指望 .gitignore」，
//     实测：全量 83 s → 加 `--exclude "^data"` 仍然 **78 s** → 匹配相对路径形态也 84 s。
//     depcruise 是**先遍历整个目录树、再过滤**，排除只影响输出，不影响读取开销。
//     目标项目 6789 个文件里 6000+ 是 `data/avatars`、`data.bak-*/avatars` 的图片，
//     它们全被遍历了。
//
//  ② **`--include-only` 才是省时间的那个。** 同样的项目：
//       全量                        83 s / 190 模块
//       --include-only 源码目录      1.77 s / 132 模块
//     快了 **47 倍**，而且内容更干净（不会混进 data 里的 .js 碎片）。
//
//   ③ **`--include-only` 的匹配对象是「相对 cwd 的路径」**，不是绝对路径、
//     也不是 depcruise 参数里的 target 写法。实测过的三者：
//         "^D:/WorkSpace-WeChat/cyber-egg-basket/utils"  → 0 模块（没命中）
//         "^(app|config|utils)/"                         → 0 模块（没命中）
//         "^\.\./\.\./WorkSpace-WeChat/.../utils"        → 28 模块 ✅
//     所以调用方必须**先算出「target 相对 cwd 的路径」**再拼正则。
//
// 结论：本模块用 `--include-only`，并把「源码目录白名单」做成参数。

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, relative, resolve, isAbsolute, sep } from "node:path";

/** 闭包最大深度（§5.2 的 depth=8）。 */
export const CLOSURE_DEPTH = 8;

// depcruise 的附带要求：支持 .ts 必须能解析到 typescript@5（实测 v7 不认）。
// 这里只是记录，不主动检查 —— 检查会引入一次子进程开销，而失败时 depcruise 自己会报。

/**
 * 算出「target 相对 cwd 的 URL 路径」，用于 --include-only 的正则。
 * Windows 下反斜杠要转成正斜杠，且正则里的 `.` 要转义。
 */
export function relativeUrlPath(cwd, target) {
  const rel = relative(cwd, target);
  if (!rel || rel === "") return ".";
  return rel.split(sep).join("/");
}

/** 把一段路径转成「正则字面量」（转义 . + 等）。 */
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 建依赖图。
 *
 * @param opts.cwd       运行 depcruise 的工作目录（通常是看板仓库根）
 * @param opts.target    被分析的项目绝对路径
 * @param opts.sourceDirs 源码目录白名单（相对 target），如 ["utils","pages","components"]
 * @param opts.outFile   图 JSON 的输出路径（**不要放进目标仓库**，§四）
 * @param opts.timeoutMs 超时
 * @returns { ok, modules, edges, unresolved, ms, error? }
 */
export function buildGraph({ cwd, target, sourceDirs, outFile, timeoutMs = 120000, depcruiseBin }) {
  const bin = depcruiseBin || join(cwd, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");
  if (!existsSync(bin)) {
    return Promise.resolve({ ok: false, error: "找不到 dependency-cruiser，先 npm i -D dependency-cruiser" });
  }
  if (!existsSync(target)) return Promise.resolve({ ok: false, error: "目标项目不存在：" + target });

  const rel = relativeUrlPath(cwd, target);
  const dirs = (sourceDirs && sourceDirs.length ? sourceDirs : ["."]);
  // 白名单拼成一个正则：`^<rel>/(app\.js|utils|pages|...)`
  const pattern = "^" + escapeRe(rel === "." ? "" : rel) +
    (rel === "." ? "" : "/") + "(" + dirs.map(escapeRe).join("|") + ")";

  const args = [
    target,
    "--no-config",
    "--output-type", "json",
    "--output-to", outFile,
    "--include-only", pattern,
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        // 退出码不可信（§约束 4）：depcruise 有时警告也返回 0，
        // 所以真正的判据是**产物是否有效**。
        if (!existsSync(outFile)) {
          return resolve({ ok: false, ms, error: "没生成图文件：" + String(stderr || err || "").slice(0, 300) });
        }
        let g;
        try { g = JSON.parse(readFileSync(outFile, "utf8")); }
        catch (e) { return resolve({ ok: false, ms, error: "图 JSON 读不动：" + String(e && e.message) }); }
        if (!g || !Array.isArray(g.modules)) {
          return resolve({ ok: false, ms, error: "图里没有 modules 数组" });
        }
        const mods = g.modules.map((m) => normPath(target, m.source, cwd)).filter(Boolean);
        const edges = [];
        let unresolved = 0;
        for (const m of g.modules) {
          const from = normPath(target, m.source, cwd);
          for (const d of m.dependencies || []) {
            if (d.resolved) {
              const to = normPath(target, d.resolved, cwd);
              if (from && to) edges.push({ from, to });
            } else if (d.couldNotResolve) unresolved++;
          }
        }
        resolve({ ok: true, ms, modules: mods, edges, unresolved, pattern });
      });
  });
}

/**
 * 把 depcruise 报的路径归一成「相对 target 的正斜杠路径」；外部模块返回 null。
 *
 * ⚠️ depcruise 的 `source` / `resolved` 是**相对 cwd** 的路径，形如
 *      `../../WorkSpace-WeChat/cyber-egg-basket/utils/a.js`
 *   而不是相对 target、也不是绝对路径。所以必须先 resolve 成绝对再取相对，
 *   否则会得到 `cyber-egg-basket/utils/a.js` 这种多一层项目名的错误路径
 *   —— 表现就是「闭包永远算不出东西」（边表的 key 和 seed 对不上）。
 */
function normPath(target, p, cwd) {
  if (!p) return null;
  const raw = String(p);
  // 绝对路径直接用；相对路径按 cwd resolve（depcruise 以 cwd 为基准）
  const abs = isAbsolute(raw) ? raw : resolve(cwd || process.cwd(), raw);
  const t = resolve(String(target));
  const rel = relative(t, abs);
  if (!rel || rel === "") return null;
  // 跳出 target 的（外部模块/上级目录）不算项目内文件
  if (rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

/**
 * 把边表（to → {from}）建成**反向**索引：谁依赖我。
 *
 * 为什么要反向：冲突判据要问「改这个文件会波及哪些文件」，
 * 那就是「谁依赖我」的传递闭包（§决策 2）。
 */
export function reverseIndex(edges) {
  const idx = new Map();
  for (const e of edges || []) {
    if (!idx.has(e.to)) idx.set(e.to, new Set());
    idx.get(e.to).add(e.from);
  }
  return idx;
}

/**
 * 反向传递闭包（§5.2）：改 seed 这些文件，会波及哪些文件。
 *
 * @param seeds     要改的文件
 * @param revIdx    reverseIndex 的结果
 * @param depth     最大深度
 * @returns { ok:true, closure:Set, byDepth:Map }  —— 不含 seeds 自身
 */
export function reverseClosure(seeds, revIdx, depth = CLOSURE_DEPTH) {
  const seen = new Set(seeds || []);
  const out = new Set();
  const byDepth = new Map();
  let frontier = [...(seeds || [])];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const p of frontier) {
      for (const q of revIdx.get(p) || []) {
        if (seen.has(q)) continue;
        seen.add(q);
        out.add(q);
        next.push(q);
      }
    }
    if (!next.length) break;
    byDepth.set(d, next.slice());
    frontier = next;
  }
  return { ok: true, closure: out, byDepth };
}

/**
 * 把 `addsEdges`（本次会新增的依赖）并入图（§十A.1）。
 *
 * 为什么必须并：图是**动手之前**建的。A 本次要新加一条 import
 * `request.js → retry.js`，加锁时这条边**还不存在**，不在 A 的闭包里 ——
 * 于是 B 要改 retry.js 时按判据会被**放行**，这是最典型的冲突形态。
 *
 * @returns 新的 edges 数组（不改原数组）
 */
export function mergeAddsEdges(edges, addsEdges) {
  const out = (edges || []).slice();
  const has = new Set(out.map((e) => e.from + "\u0000" + e.to));
  for (const e of addsEdges || []) {
    if (!e || !e.from || !e.to) continue;
    const k = e.from + "\u0000" + e.to;
    if (has.has(k)) continue;
    has.add(k);
    out.push({ from: e.from, to: e.to, added: true });
  }
  return out;
}

/** 写图到磁盘（原子落盘：先写 .tmp 再 rename）。 */
export function saveGraph(file, { target, modules, edges, ms }) {
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify({
    version: 1,
    target,
    builtAt: new Date().toISOString(),
    buildMs: ms,
    modules,
    edges,
  }, null, 1), "utf8");
  renameSync(tmp, file);   // 原子替换，断电不留半个文件
  return file;
}

/** 读回图。 */
export function loadGraph(file) {
  if (!existsSync(file)) return null;
  try {
    const g = JSON.parse(readFileSync(file, "utf8"));
    if (!g || !Array.isArray(g.modules) || !Array.isArray(g.edges)) return null;
    return g;
  } catch { return null; }
}
