// 负向验收（独立窗口形态）：一次拆掉一个能力，确认 chatwin-test 里对应的断言真的会红。
//
// 全绿的测试如果拆了功能还是全绿，那它测的就不是功能 —— 这一条对
// 「?chat=1 只剩对话框」尤其重要：它的失败方式是「窗口里多出一整页看板」
// 或者「铺满但右边缺 15px」，两种都不会报错，只能靠断言抓。
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const r = await run(process.execPath, [join(HERE, "chatwin-test.mjs"), "--board", BOARD]);
  const fails = r.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("✗"))
    .map((l) => l.replace(/^✗\s*/, ""));
  const tally = (r.out.match(/(\d+) 项通过/) || [])[0] || "?";
  return { code: r.code, fails, tally };
};

const cases = [
  {
    // 拆法要选真能改变行为的：只去掉 !important 未必会红（其它规则可能已经把
    // display 定成 none），那测出来的就不是这条规则。这里直接把整条规则删掉。
    name: "拆掉「骨架藏起来」",
    file: CSS,
    find: 'html[data-chat="1"] .topbar,',
    replace: 'html[data-chat="1"] .topbar-x,',
    expect: ["顶栏/报头/导航/正文/搜索/设置全部不显示"],
  },
  {
    name: "拆掉「关滚动条槽」（铺满会缺 15px）",
    file: CSS,
    find: "scrollbar-gutter:auto}",
    replace: "scrollbar-gutter:stable}",
    expect: ["宽度铺满"],
  },
  {
    name: "拆掉「独立窗口里收起拉角」",
    file: CSS,
    find: 'html[data-chat="1"] .ai-grip,',
    replace: 'html[data-chat="1"] .ai-grip-x,',
    expect: ["八个拉角都不显示"],
  },
  {
    name: "拆掉「独立窗口里收起置顶按钮」",
    file: CSS,
    find: 'html[data-chat="1"] #ai-pin,',
    replace: 'html[data-chat="1"] #ai-pin-x,',
    expect: ["置顶/停靠/弹窗按钮都不显示"],
  },
  {
    name: "拆掉「独立窗口里静音面板状态回写」",
    file: CLIENT,
    find: "if (!CHAT_ONLY) savePanelState(true);",
    replace: "savePanelState(true);",
    expect: ["没有写面板状态键（不去覆盖主看板）"],
  },
  {
    name: "拆掉「记住分界高度」的独立窗口分支",
    file: CLIENT,
    find: 'if (!CHAT_ONLY) saveWin();',
    replace: "saveWin();",
    expect: ["没有写浮窗几何键（几何归外层窗口）"],
  },
  {
    name: "拆掉「data-chat 标记」",
    file: RENDER,
    find: 'document.documentElement.setAttribute("data-chat","1")',
    replace: 'void 0',
    expect: ["URL 带 ?chat=1 时 <html> 上被打了 data-chat"],
  },
];

const backups = new Map();
for (const f of [CLIENT, CSS, RENDER]) {
  const b = f + ".chatnegsave";
  copyFileSync(f, b);
  backups.set(f, b);
}
const restore = () => {
  for (const [f, b] of backups) {
    try {
      copyFileSync(b, f);
    } catch {}
  }
};

let allGood = true;
for (const c of cases) {
  const orig = readFileSync(backups.get(c.file), "utf8");
  if (!orig.includes(c.find)) {
    console.log(`✗ ${c.name}：源代码里找不到要拆的那一段 —— 这条负向验收没跑起来`);
    allGood = false;
    continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.replace), "utf8");
  const r = await runTest();
  writeFileSync(c.file, orig, "utf8");

  const missing = c.expect.filter((e) => !r.fails.some((f) => f.startsWith(e)));
  if (missing.length) {
    console.log(`✗ ${c.name}：拆了之后这些断言居然还是绿的 → ${missing.join(" / ")}`);
    console.log(`   实际变红：${r.fails.join(" / ") || "（一条都没红）"}`);
    allGood = false;
  } else {
    console.log(`✓ ${c.name}：如期变红（${r.tally}）→ ${r.fails.join(" / ")}`);
  }
}

restore();
const final = await runTest();
if (final.code !== 0) {
  console.log(`✗ 还原后没能回到全绿：${final.tally}`);
  final.fails.forEach((f) => console.log("   " + f));
  allGood = false;
} else {
  console.log(`✓ 还原后回到全绿（${final.tally}）`);
}

for (const [, b] of backups) {
  try {
    if (existsSync(b)) unlinkSync(b);
  } catch {}
}
process.exit(allGood ? 0 : 1);