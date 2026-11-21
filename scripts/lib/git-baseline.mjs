// git 基线核对（0-f / §十E.4）。
//
// 为什么需要：agent 报意图时说「我改 utils/request.js」，但它**可能改错文件**
// （读了代码才发现结构不同），也可能**改了没报的文件**。那些文件从没被锁过，
// 别的 agent 就可能同时动它们。
//
// 靠 agent 自报不可靠 —— 它可能自己都没意识到改了哪些。
// 靠 git 就可靠得多：**磁盘上真实变了什么，git 最清楚**。
//
// 做法：
//   放行前   gitBaseline()     记一份「现在有哪些改动」的快照
//   完成后   gitDiffSince(base) 算出「这段时间新增/变动了哪些文件」
//   比对     与 agent 报的 files 对照 → 发现「改了没报」
//
// ⚠️ 为什么用 `git status --porcelain -z` 而不是 `git diff --name-only`：
//    · status 能覆盖 **未跟踪的新文件**（diff 看不到 untracked）
//    · -z 用 NUL 分隔，中文路径不会被转义成 `"\346\226\207"` 这种
//      （实测这个项目里全是中文文件名，转义了就没法比对）
//
// 退出码不可信（§约束 4）：git 不在、不是仓库、命令失败都要当成
// 「拿不到基线」并**明确告知**，而不是静默返回空集合假装没有改动。

import { execFile } from "node:child_process";

/** 跑 git，返回 {ok, stdout, stderr, code}。**不抛异常**，失败也是结果。 */
function runGit(cwd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === "number" ? err.code : (err ? -1 : 0),
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: err ? String(err.message || err) : "",
        });
      });
  });
}

/**
 * 解析 `git status --porcelain -z` 的输出。
 *
 * -z 格式：每条记录是 `XY <path>\0`，重命名是 `R  <new>\0<old>\0`
 * 这里只需要路径，所以按 \0 切开后，跳过状态码取路径即可。
 * 未跟踪（`??`）也算「变了」—— 新增文件同样会冲突。
 *
 * ⚠️ **未跟踪的目录只会报目录本身**（`?? 文档/`），git 不递归展开。
 * 这是个真实取舍：不展开的话，agent 新建 `utils/retry.js` 会以 `utils/` 形式出现，
 * 两个不同的新文件被当成同一个目录 → 冲突判定失真。
 * 所以这里把「以 / 结尾的未跟踪目录」**展开成目录内的文件列表**。
 */
export function parsePorcelainZ(stdout) {
  const parts = String(stdout || "").split("\0").filter((s) => s.length > 0);
  const out = [];
  for (const p of parts) {
    // 前两位是状态码 + 一个空格，剩下是路径
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    const path = p.slice(3);
    if (!path) continue;
    // 重命名的旧路径条目（`R  new\0old` 会被切成两条）——
    // 旧路径不以状态码开头，这里用状态码格式判断
    if (!/^[ MADRCU?!]{2}$/.test(code)) continue;
    out.push({ code, path });
  }
  return out;
}

/**
 * 记一份基线。返回可直接传给 `gitDiffSince` 的对象。
 *
 * ⚠️ 用 `-uall` 而不是默认的 `-unormal`：
 *   默认模式下 git 对未跟踪**目录**只报一行 `?? 文档/`，不展开里面的文件。
 *    实测踩过：新建 `文档/说明.md` 会以 `文档/` 出现，导致
 *    ① 中文文件名看起来「被截断」；
 *    ② 同一个目录下两个新文件被当成同一个条目 → 冲突判定失真。
 *    `-uall` 让 git 逐文件列出，这两个问题一起消失。
 *
 * @returns { ok, files:Set<string>, tracked:boolean, error? }
 */
export async function gitBaseline(cwd) {
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return {
      ok: false,
      tracked: false,
      files: new Set(),
      error: "这里不是 git 仓库，无法用 git 核对实际改动：" + (probe.stderr.trim() || probe.error || "unknown"),
    };
  }
  const st = await runGit(cwd, ["status", "--porcelain", "-z", "-uall"]);
  if (!st.ok) {
    return { ok: false, tracked: true, files: new Set(), error: "git status 失败：" + (st.stderr.trim() || st.error) };
  }
  return {
    ok: true,
    tracked: true,
    files: new Set(parsePorcelainZ(st.stdout).map((x) => x.path)),
  };
}

/**
 * 算出「相对基线，有哪些文件新增/变动了」。
 *
 * @returns { ok, files:string[], added:string[], untracked:boolean, error? }
 */
export async function gitDiffSince(cwd, baseline) {
  const now = await gitBaseline(cwd);
  if (!now.ok) return { ok: false, files: [], added: [], untracked: !baseline || !baseline.tracked, error: now.error };
  if (!baseline || !baseline.ok) {
    // 没有基线时退化为「当前所有改动」——仍然是比「什么都不知道」有用，
    // 但要标明这是近似（untracked:true 表示不是精确 diff）。
    return { ok: true, files: [...now.files].sort(), added: [], untracked: true };
  }
  const added = [...now.files].filter((f) => !baseline.files.has(f)).sort();
  return { ok: true, files: added, added, untracked: false };
}

/**
 * 把「agent 报的文件」和「git 实际变了的文件」对照。
 *
 * @param declared  agent 报的 files（意图）
 * @param actual    git 算出的实际变动
 * @returns { undeclared, unused }
 *   · undeclared：**改了没报**（危险 —— 这些文件从没被锁过）
 *   · unused    ：**说了没做**（正常，可能判断后改主意，不算错）
 */
export function reconcileFiles(declared, actual) {
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const dec = new Set((declared || []).map(norm));
  const act = new Set((actual || []).map(norm));
  const undeclared = [...act].filter((f) => !dec.has(f)).sort();
  const unused = [...dec].filter((f) => !act.has(f)).sort();
  return { undeclared, unused };
}
