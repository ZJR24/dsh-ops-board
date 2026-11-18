// 负向验收：一次拆掉一个能力，确认 float-test 里对应的断言真的会红。
// 全绿的测试如果拆了功能还是全绿，那它测的就不是功能。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "lib", "client.js");
const CSS = join(HERE, "lib", "css.mjs");
const RENDER = join(HERE, "render.mjs");
const BOARD = "D:\\WorkSpace-Tools\\ops-board-reports\\practise";

const run = (cmd, args) =>
  new Promise((res) => {
    const p = spawn(cmd, args, { cwd: HERE, shell: false });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out }));
  });

const reRender = async () => {
  const r = await run(process.execPath, [join(HERE, "render.mjs"), "--board", BOARD]);
  if (r.code !== 0) throw new Error("render 失败：\n" + r.out.slice(-600));
};
const runTest = async () => {
  await reRender();
  const r = await run(process.execPath, [join(HERE, "float-test.mjs"), "--board", BOARD]);
  const fails = r.out.split(/\r?\n/).filter((l) => l.startsWith("✗")).map((l) => l.replace(/^✗\s*/, ""));
  const tally = (r.out.match(/(\d+)\/(\d+) 项通过/) || [])[0] || "?";
  return { code: r.code, fails, tally, out: r.out };
};

const cases = [
  {
    name: "拆掉「拖标题栏移动」",
    file: CLIENT,
    find: 'headEl.addEventListener("pointerdown", function (ev) {',
    replace: 'headEl.addEventListener("pointerdown", function (ev) { if (1) return;',
    expect: ["标题栏拖动后窗口跟着走"],
  },
  {
    name: "拆掉「右上角那一个拉伸手柄」",
    file: RENDER,
    // 不带行尾：这几个源文件是 CRLF，写 "\n" 永远找不到。
    find: '<span class="ai-grip" data-dir="ne"></span>',
    replace: "",
    expect: ["八个方向的抓手都在"],
  },
  {
    name: "拆掉「拉分界改输入区高度」",
    file: CLIENT,
    find: 'splitEl.addEventListener("pointerdown", function (ev) {',
    replace: 'splitEl.addEventListener("pointerdown", function (ev) { if (1) return;',
    expect: ["往上拉，输入区变高", "往上拉的同时，回答区让出高度（不是整窗变高）", "往下拉，输入区又收回去"],
  },
  {
    name: "拆掉「置顶的层级」",
    file: CSS,
    find: '.ai-panel[data-pinned="1"]{',
    replace: '.ai-panel[data-pinned="1-x"]{',
    expect: ["置顶后层级升高", "置顶后盖得住搜索浮层"],
  },
  {
    name: "拆掉「记住窗口位置」",
    file: CLIENT,
    find: "function saveWin() {",
    replace: "function saveWin() { if (1) return;",
    expect: ["拖完记在了本机", "分界位置也存进了本机"],
  },
];

const backups = new Map();
for (const f of [CLIENT, CSS, RENDER]) {
  const b = f + ".negsave";
  copyFileSync(f, b);
  backups.set(f, b);
}

let allGood = true;
for (const c of cases) {
  const orig = readFileSync(backups.get(c.file), "utf8");
  if (!orig.includes(c.find)) {
    console.log(`✗ ${c.name}：源代码里找不到要拆的那一行 —— 这条负向验收没跑起来`);
    allGood = false;
    continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.replace), "utf8");
  const r = await runTest();
  writeFileSync(c.file, orig, "utf8");

  const missing = c.expect.filter((e) => !r.fails.some((f) => f.startsWith(e)));
  if (missing.length) {
    console.log(`✗ ${c.name}：拆了之后这些断言居然还是绿的 → ${missing.join(" / ")}`);
    allGood = false;
  } else {
    console.log(`✓ ${c.name}：如期变红（${r.tally}）→ ${r.fails.filter((f) => c.expect.some((e) => f.startsWith(e))).join(" / ")}`);
  }
}

// 还原并确认还原后还是全绿
for (const [f, b] of backups) { copyFileSync(b, f); }
const final = await runTest();
if (final.code !== 0) {
  console.log(`✗ 还原后没能回到全绿：${final.tally}`);
  final.fails.forEach((f) => console.log("   " + f));
  allGood = false;
} else {
  console.log(`✓ 还原后回到全绿（${final.tally}）`);
}

// 清掉备份
const { unlinkSync } = await import("node:fs");
for (const [, b] of backups) { try { unlinkSync(b); } catch {} }
process.exit(allGood ? 0 : 1);
