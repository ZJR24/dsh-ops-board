// 图外耦合规则 R1/R2/R3（架构文档 §七 / §十E.5③）。
//
// 为什么需要：depcruise **只认 .js/.mjs/.cjs/.jsx/.ts/.tsx**。
// 而目标小程序项目里有：
//
//   14 个 .wxml、19 个 .wxss   ← 图里完全看不见
//   app.json 的页面注册        ← 不在 import 图里
//
// 于是「A 改 pages/x/x.wxml、B 改 pages/x/x.js」在图里是**两个无关文件**，
// 实际却是**强耦合**（同一个页面组件的视图与逻辑）。
//
// 实测确认（2026-11-21）：
//   pages/about    : .js .json .wxml .wxss
//   pages/board    : .js .json .wxml .wxss
//   components/egg-toast : .js .json .wxml .wxss   ← 文档 §七 只写了 pages/，
//   components/navbar    : .js .json .wxml .wxss      实际 components/ 也是四件套
//
// 这三条规则是**买不到的部分**（depcruise 不做），属中控自己的逻辑。

/**
 * 小程序「同主干四件套」的扩展名。
 * 同一个 basename 的这些文件是**同一个组件**，必须锁成一把。
 */
export const STEM_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".wxml", ".wxss", ".wxs", ".axml", ".acss"]);

/** 图能看见的扩展名（depcruise 支持的那些）。 */
export const GRAPH_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

/** 项目根的小程序配置：改它与改任意页面冲突（R2）。 */
export const PAGE_REGISTRY_FILES = new Set(["app.json", "app.js", "app.wxss", "project.config.json"]);

/** 取路径的扩展名（小写，含点）。 */
function extOf(p) {
  const s = String(p || "");
  const i = s.lastIndexOf(".");
  const j = s.lastIndexOf("/");
  if (i < 0 || i < j) return "";
  return s.slice(i).toLowerCase();
}

/** 取路径的目录部分（不含文件名，不含末尾 /）。 */
function dirOf(p) {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i < 0 ? "" : s.slice(0, i);
}

/** 取路径的文件主干（去扩展名）。 */
function stemOf(p) {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  const base = i < 0 ? s : s.slice(i + 1);
  const k = base.lastIndexOf(".");
  return k <= 0 ? base : base.slice(0, k);
}

/**
 * R1 同主干锁：把一批文件扩展成「同一组件的所有兄弟文件」。
 *
 * 给定 `pages/board/board.wxml`，返回它那一组：
 *   pages/board/board.js / .json / .wxml / .wxss
 *
 * ⚠️ 这是**保守扩张**：只要改了其中一个，整组都算被改。
 * 因为它们是同一个组件，改视图往往要同步改逻辑。
 *
 * ⚠️ **只扩张「小程序组件扩展名」那一圈，不扩张到 .mjs/.ts**。
 * 早期版本把 STEM_EXTS 里所有扩展名都补一遍，结果 `utils/a.js` 会凭空多出
 * `utils/a.wxml`、`utils/a.wxss` —— 那些文件**根本不存在**，但会让 R3 把
 * `utils/a.js` 误判成「图外文件」，进而让同目录两个普通 .js 互相冲突，
 * 并行度直接归零。
 *
 * 现在的规则：只补 `COMPONENT_EXTS` 里的兄弟（.js/.json/.wxml/.wxss/.wxs），
 * 且**仅当本条路径的扩展名本身也在 COMPONENT_EXTS 内**。
 * 这样 `utils/a.js` 仍会补 `utils/a.json`（真存在的情况多），
 * 但不会补 `.wxml`（小程序组件才有的那种）。
 */
export const COMPONENT_EXTS = new Set([".js", ".json", ".wxml", ".wxss", ".wxs"]);

export function expandStemGroup(files) {
  const src = new Set((files || []).map(String));
  const expanded = new Set(src);
  const added = new Set();
  for (const f of src) {
    const ext = extOf(f);
    if (!COMPONENT_EXTS.has(ext)) continue;   // 不认识的扩展名不扩张
    const d = dirOf(f);
    const stem = stemOf(f);
    for (const other of COMPONENT_EXTS) {
      if (other === ext) continue;
      // ← 关键：只补「同属组件四件套」的扩展名，不碰 .mjs/.ts/.cjs
      const cand = (d ? d + "/" : "") + stem + other;
      if (!expanded.has(cand)) {
        expanded.add(cand);
        added.add(cand);
      }
    }
  }
  return { expanded, added };
}

/**
 * R2 页面注册：改 `app.json` 与改任意 `pages/**` 冲突。
 *
 * 为什么：`app.json` 里登记了页面清单，加/删页面必须改它；
 * 而改任意页面文件时，页面注册关系可能也要同步。两者同时改会互相覆盖。
 *
 * 实现方式：把 app.json 的「影响面」标成整个 pages 目录，
 * 由 dispatch 用「目录前缀」而不是「文件相等」去判。
 *
 * @returns { registryTouched:boolean, touchesPages:boolean }
 */
export function pageRegistryImpact(files) {
  const list = (files || []).map(String);
  const registryTouched = list.some((f) => PAGE_REGISTRY_FILES.has(f));
  const touchesPages = list.some((f) => f === "pages" || f.startsWith("pages/"));
  return { registryTouched, touchesPages };
}

/**
 * R3 兜底：图覆盖不到的文件，退化为「同目录即冲突」。
 *
 * 适用：`.wxml` / `.wxss` / `.png` / `.md` / `.py` …… depcruise 看不见的那些。
 *
 * ⚠️ 这条规则**很粗**（同目录就冲突），所以有两道闸：
 *   ① 只统计**原本就被报出来的**图外文件，**不统计 R1 凭空补出来的兄弟** ——
 *      否则 `utils/a.js` 经 R1 补出 `utils/a.wxml`，就凭空多了一个"图外文件"，
 *      两个同目录普通 .js 会被误判冲突，并行度归零。
 *   ② 图里看得见的扩展名（.js/.ts/...）不参与，交给依赖图判。
 *
 * @param files    原始报上来的文件（**未经 R1 扩张**）
 * @returns { dirs:Set }  图外文件涉及的目录集合
 */
export function fallbackDirs(files) {
  const out = new Set();
  for (const f of files || []) {
    if (GRAPH_EXTS.has(extOf(f))) continue;   // 图里看得见的不走兜底
    out.add(dirOf(String(f)));
  }
  return out;
}

/**
 * 把「要改的文件」补全成「实际会冲突的文件集合」。
 *
 * 这是 R1/R2/R3 的统一入口，dispatch 判冲突前先过一遍这个。
 *
 * @param files         agent 报的 files
 * @returns {
 *   files:Set,        R1 扩张后的文件集合
 *   addedByR1:Set,    R1 额外纳入的
 *   dirs:Set,         R3：图外文件涉及的目录
 *   registry:boolean, R2：是否动了页面注册文件
 *   touchesPages:boolean,
 *   graphFiles:string[]   其中图能看见的那部分（交给闭包）
 * }
 */
export function applyOffGraphRules(files) {
  const raw = (files || []).map(String);
  const { expanded, added } = expandStemGroup(raw);
  const list = [...expanded];
  const { registryTouched, touchesPages } = pageRegistryImpact(list);
  return {
    files: expanded,
    addedByR1: added,
    // ⚠️ R3 只看**原本报上来的**文件，不看 R1 补出来的兄弟（见 fallbackDirs 注释）
    dirs: fallbackDirs(raw),
    registry: registryTouched,
    touchesPages,
    graphFiles: list.filter((f) => GRAPH_EXTS.has(extOf(f))),
  };
}

/**
 * 用 R1/R2/R3 判断两组文件是否冲突（不依赖依赖图）。
 *
 * dispatch 的完整判据是「图闭包 ∪ 这三条规则」，这里只负责规则部分。
 *
 * @returns { string[] } 冲突原因（空数组 = 不冲突）
 */
export function offGraphConflict(a, b) {
  const A = applyOffGraphRules(a);
  const B = applyOffGraphRules(b);
  const why = [];

  // R1：文件集合相交（已经过 R1 扩张）
  for (const f of A.files) if (B.files.has(f)) why.push("同一组件的文件：" + f);
  if (why.length) return why;   // 已经能判定了，不必再走粗规则

  // R2：一方动了页面注册，另一方动了 pages/
  if (A.registry && B.touchesPages) why.push("改 app.json 会牵动整个 pages/（对方正在改页面）");
  if (B.registry && A.touchesPages) why.push("对方改 app.json 会牵动整个 pages/（你在改页面）");

  // R3：双方都有图外文件、且落在同一目录
  for (const d of A.dirs) {
    if (B.dirs.has(d)) why.push("同目录的图外文件（.wxml/.wxss 等依赖图看不见）：" + (d || "(根目录)"));
  }
  return why;
}
