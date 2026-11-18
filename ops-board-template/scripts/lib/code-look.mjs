// scripts/lib/code-look.mjs — 「点一下证据，直接看它指的是什么」。
//
// 卡片的证据里写的是 `cloudfunctions/dailyUpdate/index.js 的 guard()`、
// `commit 0aa2787（10-30 09:24）` 这种话。在页面上它们只是纯文本：
// 想知道当年改了什么，得自己开编辑器、cd 到项目、git show 那个 commit。
//
// 这个模块把两件事做实：
//
//   file   → 给出文件里那一小段代码（并尽量定位到卡片提到的那个符号）
//   commit → 给出那次提交改了哪些文件、增删多少行、diff 原文（截断）
//
// 全部只读，且只允许读被跟踪项目目录内的文件（不允许 ../ 逃出去）。
// 行号一律现算，不缓存旧位置 —— 文件变了，行号本来就该跟着变。

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathsIn } from "./evidence-path.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 超过 2MB 的文件不读，页面也放不下
const MAX_LINES = 120;                  // 单次最多回 120 行
const MAX_DIFF = 200 * 1024;            // diff 超过 200KB 就截断

// 从「路径 的 guard()」里挖出符号名。挖不到就返回空串。
function symbolFrom(text) {
  const s = String(text || "");
  const m =
    s.match(/\b([A-Za-z_$][\w$]{1,40})\s*\(/) ||
    s.match(/的\s*([A-Za-z_$][\w$]{1,40})/) ||
    s.match(/`([A-Za-z_$][\w$]{1,40})`/);
  return m ? m[1] : "";
}

// 在源码里找符号的定义位置（不找调用点：定义才说明"它还在不在"）。
function locateSymbol(lines, sym) {
  if (!sym) return -1;
  const escaped = sym.replace(/\$/g, "\\$");
  const defs = [
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*[=:]`),
    new RegExp(`^\\s*${escaped}\\s*[=:]\\s*(?:async\\s*)?(?:function|\\()`),
    new RegExp(`^\\s*(?:export\\s+)?(?:class|interface)\\s+${escaped}\\b`),
    new RegExp(`^\\s*${escaped}\\s*\\([^)]*\\)\\s*\\{`),
  ];
  for (const re of defs) {
    const i = lines.findIndex((l) => re.test(l));
    if (i > -1) return i;
  }
  // 没有定义就退一步：找到任意一处提到它的地方，总比不定位好
  const loose = new RegExp(`\\b${escaped}\\b`);
  return lines.findIndex((l) => loose.test(l));
}

function ensureInside(projectDir, relPath) {
  const abs = resolve(projectDir, relPath);
  const root = resolve(projectDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error("路径跑到项目目录外面了，拒绝读取");
  }
  return abs;
}

/**
 * 看一个文件（可指定符号，定位到它附近）。
 *
 * @param {string} projectDir 被跟踪项目根
 * @param {string} relPath    台账证据里写的相对路径
 * @param {string} [hint]     证据原文，用来挖符号名
 * @returns {{ok:boolean, error?:string, path?:string, symbol?:string, line?:number,
 *            from?:number, to?:number, total?:number, text?:string, truncated?:boolean}}
 */
export function lookAtFile(projectDir, relPath, hint = "") {
  if (!projectDir || !existsSync(projectDir)) {
    return { ok: false, error: "找不到被跟踪的项目目录" };
  }
  // 路径可能是从证据原文里认出来的，也可能由前端直接给；两种都规范一下。
  const rel = String(relPath || "").trim() || pathsIn(hint).map((p) => p.path)[0] || "";
  if (!rel) return { ok: false, error: "没给文件路径" };

  let abs;
  try {
    abs = ensureInside(projectDir, rel);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!existsSync(abs)) return { ok: false, error: "这个文件现在已经不在了：" + rel };
  const st = statSync(abs);
  if (!st.isFile()) return { ok: false, error: "这不是一个文件：" + rel };
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, error: `文件太大（${Math.round(st.size / 1024)} KB），不在这儿展开` };
  }

  let src;
  try {
    src = readFileSync(abs, "utf8");
  } catch (e) {
    return { ok: false, error: "读不动：" + String((e && e.message) || e) };
  }

  const lines = src.split("\n");
  const sym = symbolFrom(hint);
  const at = locateSymbol(lines, sym);

  // 定位到了就露它前后各 30 行；没定位到就从头给。
  let from = 0;
  let to = Math.min(lines.length, MAX_LINES);
  if (at > -1) {
    from = Math.max(0, at - 30);
    to = Math.min(lines.length, at + 30);
  }

  const slice = lines.slice(from, to);
  const text = slice
    .map((l, i) => String(from + i + 1).padStart(5) + "│ " + l)
    .join("\n");

  return {
    ok: true,
    path: rel,
    symbol: sym || "",
    line: at > -1 ? at + 1 : 0,
    from: from + 1,
    to,
    total: lines.length,
    text,
    truncated: to < lines.length || from > 0,
  };
}

/**
 * 看一次提交：改了哪些文件、多少行、diff 原文。
 *
 * @param {string} projectDir
 * @param {string} hash 完整或短 commit
 * @returns {{ok:boolean, error?:string, hash?:string, subject?:string, at?:string,
 *            files?:object[], insertions?:number, deletions?:number, diff?:string, note?:string}}
 */
export function lookAtCommit(projectDir, hash) {
  if (!projectDir || !existsSync(projectDir)) {
    return { ok: false, error: "找不到被跟踪的项目目录" };
  }
  const h = String(hash || "").trim();
  if (!/^[0-9a-f]{6,40}$/i.test(h)) return { ok: false, error: "commit 号看着不像" };

  const git = (args, maxBuffer = MAX_DIFF * 2) => {
    return execFileSync("git", args, {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  };

  let meta;
  try {
    meta = git(["show", "-s", "--format=%H|%at|%s", h]).trim();
  } catch {
    return { ok: false, error: "仓库里找不到这个 commit：" + h };
  }
  const [full, atSec, ...rest] = meta.split("|");
  const subject = rest.join("|");

  let files = [];
  let insertions = 0;
  let deletions = 0;
  try {
    // --numstat 给出每个文件的增删行数，机器可读
    const numstat = git(["show", "--numstat", "--format=", h]);
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [add, del, ...pathBits] = line.split("\t");
      const path = pathBits.join("\t");
      if (!path) continue;
      const a = Number(add);
      const d = Number(del);
      if (Number.isFinite(a)) insertions += a;
      if (Number.isFinite(d)) deletions += d;
      files.push({ path, add: Number.isFinite(a) ? a : null, del: Number.isFinite(d) ? d : null });
    }
  } catch {
    // numstat 挂了不影响主体：diff 还能看
  }

  let diff = "";
  let note = "";
  // 拿 diff 走两步：git 先把完整 patch 写进管道，我们再截断。
  // 但 execFileSync 的 maxBuffer 是**硬上限**——超了它直接抛 ENOBUFS，
  // 缓冲区里一个字节都拿不到（不是截断，是全丢）。所以这里不能只靠上面的
  // MAX_DIFF 截断：一次删掉上万行的大提交，diff 动辄几 MB，会在 git 这一层
  // 就失败，然后被下面 catch 成「diff 取不出来」，页面正文一片空白。
  // 实测（某真实看板的一次大重构提交：51 文件 / +184 / −11081）就是这个症状。
  //
  // 对策：先按「够大但有限」的缓冲区取；真超了，再用 MAX_DIFF 兜住重取，
  // 保证**总是有内容**（哪怕只有前 200KB），而不是有无之间跳变。
  const DIFF_BUFFER = 8 * 1024 * 1024; // 8MB：足以容纳绝大多数提交的完整 patch
  try {
    diff = git(["show", "--format=", "--patch", h], DIFF_BUFFER);
    if (diff.length > MAX_DIFF) {
      diff = diff.slice(0, MAX_DIFF);
      note = `diff 太长，只给了前 ${Math.round(MAX_DIFF / 1024)} KB`;
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    const overflow = (e && e.code === "ENOBUFS") || /maxBuffer|ENOBUFS/i.test(msg);
    if (overflow) {
      // 8MB 都装不下：这次不用 execFileSync 攒，改成「边流边截」。
      diff = "";
      try {
        const r = spawnSync(
          "git",
          ["show", "--format=", "--patch", h],
          { cwd: projectDir, maxBuffer: DIFF_BUFFER, timeout: 60000 }
        );
        const buf = r && r.stdout ? r.stdout : Buffer.alloc(0);
        if (buf.length) diff = buf.subarray(0, MAX_DIFF).toString("utf8");
      } catch {
        // 兜底也失败，留空并如实说明
      }
      const mb = DIFF_BUFFER / 1024 / 1024;
      const mbText = mb >= 1 ? `${Math.round(mb)} MB` : `${Math.round(DIFF_BUFFER / 1024)} KB`;
      note = diff
        ? `diff 超过 ${mbText}，只给了前 ${Math.round(MAX_DIFF / 1024)} KB`
        : `diff 超过 ${mbText}，取不出来`;
    } else {
      note = "diff 取不出来：" + msg;
    }
  }

  const atMs = Number(atSec) * 1000;
  return {
    ok: true,
    hash: full.slice(0, 7),
    full,
    subject,
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : "",
    files,
    insertions,
    deletions,
    diff,
    note: note || undefined,
  };
}