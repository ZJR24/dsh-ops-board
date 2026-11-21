// git 基线核对（0-f / §十E.4）。
//
// 要抓的是：agent 报「我改 A」，实际改了 A 和 B。B 从没被锁过，
// 别的 agent 可能同时动它 —— 那正是漏判。
//
// 靠 agent 自报不可靠，靠 git 可靠。测试要在一个**真实临时 git 仓库**里跑，
// 不能 mock —— 因为这里的关键正是「git 输出到底长什么样」，
// 尤其是中文路径和未跟踪文件（这两点最容易出错）。
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gitBaseline, gitDiffSince, reconcileFiles, parsePorcelainZ } from "./lib/git-baseline.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

const TMP = mkdtempSync(join(tmpdir(), "gitbl-test-"));
const REPO = join(TMP, "repo");
mkdirSync(REPO, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true });
const write = (rel, text) => {
  const full = join(REPO, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, "utf8");
};

// 建一个真实仓库
git("init", "-q");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
write("utils/request.js", "// v1\n");
write("utils/data-store.js", "// v1\n");
write("README.md", "// v1\n");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");

// ── ① 基线：干净仓库 ──
console.log("[1] 干净仓库：基线为空");
{
  const b = await gitBaseline(REPO);
  ok(b.ok === true && b.tracked === true, "识别为 git 仓库", "tracked=" + b.tracked);
  ok(b.files.size === 0, "没有改动", b.files.size + " 个");
}

// ── ② 基线之后改文件 → 能被 diff 出来 ──
console.log("\n[2] 改了一个已跟踪文件 → 能算出它是新变动");
{
  const base = await gitBaseline(REPO);
  write("utils/request.js", "// v2 改了\n");
  const d = await gitDiffSince(REPO, base);
  ok(d.ok === true, "diff 成功", JSON.stringify(d.files));
  ok(d.files.length === 1 && d.files[0] === "utils/request.js",
    "**精确算出改的是 request.js**", d.files.join(","));
  ok(d.untracked === false, "是精确 diff（不是退化模式）", "untracked=" + d.untracked);
}

// ── ③ 新增未跟踪文件（git diff 看不到的那种）──
console.log("\n[3] 新增未跟踪文件 → status 能看到（diff 看不到）");
{
  const base = await gitBaseline(REPO);
  write("utils/retry.js", "// 新文件\n");
  const d = await gitDiffSince(REPO, base);
  ok(d.files.indexOf("utils/retry.js") > -1,
    "**新增文件被识别**（这是 `git diff --name-only` 会漏的）", d.files.join(","));
}

// ── ④ 中文路径 ──
console.log("\n[4] 中文路径：不能被转义成八进制");
{
  const base = await gitBaseline(REPO);
  write("文档/说明.md", "中文内容\n");
  const d = await gitDiffSince(REPO, base);
  const hit = d.files.find((f) => f.indexOf("说明") > -1);
  ok(!!hit, "**中文文件名原样保留**（没被转义）", hit || d.files.join(","));
  ok(!d.files.some((f) => /\\\d{3}/.test(f)), "没有出现 `\\346` 这种八进制转义", d.files.join(","));
}

// ── ⑤ reconcile：改了没报 ──
console.log("\n[5] 对照：抓「改了没报」和「说了没做」");
{
  const r = reconcileFiles(
    ["utils/request.js", "utils/data-store.js"],   // agent 报的
    ["utils/request.js", "utils/retry.js"]          // git 实际的
  );
  ok(r.undeclared.length === 1 && r.undeclared[0] === "utils/retry.js",
    "**抓到「改了没报」的文件**", JSON.stringify(r.undeclared));
  ok(r.unused.length === 1 && r.unused[0] === "utils/data-store.js",
    "「说了没做」也报出来（但不算错）", JSON.stringify(r.unused));
}

// ── ⑥ 路径分隔符归一 ──
console.log("\n[6] Windows 反斜杠与 ./ 前缀要归一（否则比对全错）");
{
  const r = reconcileFiles([".\\utils\\request.js"], ["utils/request.js"]);
  ok(r.undeclared.length === 0, "`\\utils\\request.js` 与 `utils/request.js` 视为同一个文件",
    JSON.stringify(r));
  const r2 = reconcileFiles(["./utils/request.js"], ["utils/request.js"]);
  ok(r2.undeclared.length === 0, "`./utils/...` 也能对上", JSON.stringify(r2));
}

// ── ⑦ 非 git 目录：明确报错，不假装没改动 ──
console.log("\n[7] 非 git 目录：明确说拿不到基线（不静默返回空）");
{
  const PLAIN = join(TMP, "plain");
  mkdirSync(PLAIN, { recursive: true });
  writeFileSync(join(PLAIN, "a.js"), "x", "utf8");
  const b = await gitBaseline(PLAIN);
  ok(b.ok === false, "基线拿不到", "ok=" + b.ok);
  ok(b.tracked === false, "标明不是 git 仓库", "tracked=" + b.tracked);
  ok(/不是 git 仓库/.test(b.error), "**给出人能看懂的原因**", b.error.slice(0, 60));
  const d = await gitDiffSince(PLAIN, b);
  ok(d.ok === false, "diff 也如实失败", "ok=" + d.ok);
  ok(d.untracked === true, "标明这是退化状态", "untracked=" + d.untracked);
}

// ── ⑧ 删除文件也算变动 ──
console.log("\n[8] 删掉文件也算「变了」");
{
  const base = await gitBaseline(REPO);
  unlinkSync(join(REPO, "README.md"));
  const d = await gitDiffSince(REPO, base);
  ok(d.files.indexOf("README.md") > -1, "删除被识别", d.files.join(","));
}

// ── ⑨ 无基线的退化行为 ──
console.log("\n[9] 没有基线时不崩，退化为「当前所有改动」并标明");
{
  const d = await gitDiffSince(REPO, null);
  ok(d.ok === true, "不抛异常", "ok=" + d.ok);
  ok(d.untracked === true, "标明是近似（不是精确 diff）", "untracked=" + d.untracked);
  ok(d.files.length > 0, "至少给出了当前改动清单", d.files.length + " 个");
}

// ── ⑩ 解析器单测 ──
console.log("\n[10] porcelain -z 解析：状态码和路径要分开");
{
  // 模拟： M utils/a.js \0 ?? utils/new.js \0
  const raw = " M utils/a.js\0?? utils/new.js\0";
  const p = parsePorcelainZ(raw);
  ok(p.length === 2, "解析出 2 条", p.length + " 条");
  ok(p[0].path === "utils/a.js" && p[0].code === " M", "第一条：修改", JSON.stringify(p[0]));
  ok(p[1].path === "utils/new.js" && p[1].code === "??", "第二条：未跟踪", JSON.stringify(p[1]));
  ok(parsePorcelainZ("").length === 0, "空输入 → 空结果");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
