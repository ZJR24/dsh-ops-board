#!/usr/bin/env node
// scripts/ask.mjs — 不开浏览器，直接把「上下文 + 问题位」打到终端。
//
// 用途：临时想用别的 AI（网页版、手机上的、同事的）时，把这一段完整复制过去。
// 页面里的 AI 面板会自动带上这些内容，不需要走这个脚本。
//
// 用法：
//   node scripts/ask.mjs                # 整本台账
//   node scripts/ask.mjs BUG-021        # 只围绕某一条
//   node scripts/ask.mjs --list         # 看有哪些编号
//
// 配剪贴板：node scripts/ask.mjs BUG-021 | clip

import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardContext, buildSystemPrompt } from "./lib/context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 看板目录：数据在这儿，脚本在模板那儿。优先级同 render.mjs / serve.mjs。
// 少了这一段，从项目里跑 ask 读到的是模板自己的 ledger，条目数对不上。
function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
const ROOT = resolve(argValue("board") || process.env.OPS_BOARD_DIR || resolve(HERE, ".."));
const ledger = JSON.parse(readFileSync(join(ROOT, "ledger.json"), "utf8"));
const config = JSON.parse(readFileSync(join(ROOT, "board.config.json"), "utf8"));

// 位置参数里排掉 --board 的值，否则它会被当成条目 id。
const boardValue = argValue("board");
const args = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--") && a !== boardValue);
const ctx = boardContext(config, ledger);

if (process.argv.includes("--list")) {
  console.log(`共 ${ctx.totalCount} 条，未收口 ${ctx.openCount} 条：\n`);
  for (const [id, v] of Object.entries(ctx.items)) {
    console.log(`  ${id.padEnd(10)} ${v.statusLabel.padEnd(6)} ${v.title}`);
  }
  process.exit(0);
}

const id = args[0];
if (id && !ctx.items[id]) {
  console.error(`台账里没有 ${id}。用 --list 看现有编号。`);
  process.exit(1);
}

process.stdout.write(buildSystemPrompt(ctx, id || null));
process.stdout.write("\n\n【我的问题】\n<<<在这里写你的问题>>>\n");
