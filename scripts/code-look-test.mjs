// code-look 的取数边界测试：大提交也必须给出 diff，不能静默变空。
//
// 为什么单独写这一条：evidence-look-test.mjs 是走浏览器的端到端测试，
// 它点的提交是「页面上第一个 commit 证据」—— 具体是哪一个取决于台账数据。
// 碰巧点到大提交时就红，碰到小提交就绿，**同样的代码两种结果**。
// 这类「靠数据碰运气」的测试不能用来守边界，所以这里直接调 lookAtCommit()，
// 用构造出来的 extreme 情况把边界钉死。
//
// 被钉住的具体 bug（2026-11-18 发现）：
//   code-look 用 execFileSync 取 diff，maxBuffer 只给 MAX_DIFF*2 = 400KB。
//   一次删掉上万行的大提交 diff 有几 MB，git 在写管道时就超限抛 ENOBUFS，
//   缓冲区里一个字节都拿不到 → catch 成「diff 取不出来」→ 页面正文空白。
//   注意这**不是**截断逻辑失效：截断在 git 之后，而失败发生在 git 之内。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lookAtCommit } from "./lib/code-look.mjs";

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}

// 造一个临时 git 仓库：一个「小提交」和一个「巨大提交」。
// 不依赖这台机器上的任何真实项目，换台机器照样能跑。
const dir = mkdtempSync(join(tmpdir(), "codelook-"));
// 注意：这个辅助函数自己也要给足 maxBuffer。默认 1MB，而下面要造的「巨大提交」
// patch 有 6MB 左右 —— 不给够就会在**测试脚手架**这一层先抛 ENOBUFS，
// 看起来像被测代码坏了，其实是量具自己崩了（这个坑本轮踩过一次）。
const git = (...args) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

try {
  git("init", "-q");
  git("config", "commit.gpgsign", "false");

  // 小提交
  writeFileSync(join(dir, "small.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "小提交");
  const smallHash = git("rev-parse", "HEAD").trim();

  // 巨大提交：一个约 6MB 的文件 —— diff 远超 400KB，但没到 8MB
  const line = "x".repeat(200);
  const big = Array.from({ length: 30000 }, (_, i) => `${i} ${line}`).join("\n") + "\n";
  writeFileSync(join(dir, "big.txt"), big);
  git("add", "-A");
  git("commit", "-q", "-m", "巨大提交");
  const bigHash = git("rev-parse", "HEAD").trim();
  const bigBytes = Buffer.byteLength(git("show", "--format=", "--patch", bigHash), "utf8");

  console.log("[1] 小提交照旧");
  const small = lookAtCommit(dir, smallHash.slice(0, 7));
  ok(small.ok === true, "取得到", small.ok ? "" : small.error);
  ok(typeof small.diff === "string" && small.diff.length > 0, "diff 非空", `${small.diff ? small.diff.length : 0} 字符`);
  ok(small.diff.includes("diff --git"), "diff 是 git 原文");
  ok(!small.note, "没说被截断", small.note || "无 note");

  console.log("\n[2] 巨大提交（旧代码在这里返回空 diff）");
  console.log(`    这个提交的完整 patch 约 ${(bigBytes / 1024).toFixed(0)} KB，旧上限 400 KB`);
  const huge = lookAtCommit(dir, bigHash.slice(0, 7));
  ok(huge.ok === true, "取得到", huge.ok ? "" : huge.error);
  ok(
    typeof huge.diff === "string" && huge.diff.length > 0,
    "diff **不是空的**（这正是被修的 bug）",
    `${huge.diff ? huge.diff.length : 0} 字符`
  );
  ok(huge.diff.includes("diff --git"), "给了 git 原文而不是错误文案");
  ok(huge.diff.length <= 200 * 1024, "确实按 200KB 上限截断了", `${huge.diff.length} ≤ ${200 * 1024}`);
  ok(!!huge.note && /只给了前/.test(huge.note), "如实说明了截断", huge.note || "无 note");
  ok(!/取不出来/.test(huge.note || ""), "note 里没有「取不出来」这种失败字样");

  console.log("\n[3] 元信息仍然可用（不能因为 diff 大就丢掉文件清单）");
  ok(Array.isArray(huge.files) && huge.files.length > 0, "有文件清单", `${huge.files ? huge.files.length : 0} 个文件`);
  ok(typeof huge.insertions === "number", "有增行数", String(huge.insertions));
  ok(typeof huge.deletions === "number", "有删行数", String(huge.deletions));
  ok(!!huge.at && /^\d{4}-\d\d-\d\dT/.test(huge.at), "有时间", huge.at);
  ok(!!huge.subject, "有提交说明", huge.subject);

  console.log("\n[4] 坏输入仍然被挡住");
  const bad = lookAtCommit(dir, "not-a-hash");
  ok(bad.ok === false, "非 hash 被拒", bad.error || "");
  const missing = lookAtCommit(dir, "deadbeef");
  ok(missing.ok === false, "不存在的 hash 被拒", missing.error || "");
  const noDir = lookAtCommit("", "abcdef1");
  ok(noDir.ok === false, "空目录被拒", noDir.error || "");
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
