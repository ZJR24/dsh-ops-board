#!/usr/bin/env node
// 项目 scripts/ 下的入口转发（由模板在创建看板时复制，文件名按需改）。
//
// 真正的脚本只有一份，在模板目录里。这个文件只做一件事：
// 找到模板 → 把参数原样转给模板里的同名脚本 → 退出码透传。
//
// 为什么要子进程而不是 import：serve / verify / uitest 都是命令行工具，
// 自己读写 process.argv、自己 process.exit；用子进程最不容易互相干扰，
// 而且 stdio 继承给终端，报错和进度能原样看到。
//
// 升级脚本时只改模板那一份，所有项目立即生效，不需要重新拷贝。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = resolve(HERE, "..");
const SELF = basename(fileURLToPath(import.meta.url));

// 模板位置：project.json 的 templateDir > OPS_TEMPLATE_DIR > 看板目录旁边的兄弟目录
//
// 最后一档故意不写死绝对路径：写死了换机器就指向一个不存在的地方，
// 而报错信息只会说「找不到模板脚本」，看不出是兜底路径过期。
// 判据用 scripts/lib/ —— 真脚本都在这儿，看板里的 scripts/ 只有几个转发器，没有 lib。
// 找法是扫父目录（以及祖父目录）下的各个子目录，不是拿父目录本身当模板。
function looksLikeTemplate(dir) {
  return (
    existsSync(join(dir, "scripts", "entry.mjs")) &&
    existsSync(join(dir, "scripts", "lib")) &&
    existsSync(join(dir, "board.config.json"))
  );
}
function findTemplate() {
  try {
    const meta = JSON.parse(readFileSync(join(BOARD, "project.json"), "utf8"));
    if (meta.templateDir) return resolve(BOARD, meta.templateDir);
  } catch {}
  if (process.env.OPS_TEMPLATE_DIR) return resolve(process.env.OPS_TEMPLATE_DIR);
  for (const up of ["..", "../.."]) {
    const base = resolve(BOARD, up);
    if (looksLikeTemplate(base)) return base;
    let kids = [];
    try {
      kids = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const k of kids) {
      if (!k.isDirectory()) continue;
      const cand = join(base, k.name);
      if (looksLikeTemplate(cand)) return cand;
    }
  }
  return "";
}

const template = findTemplate();

// 模板为空时必须立刻失败：join("", "scripts", SELF) 会得到相对路径
// "scripts/render.mjs"，恰好指向看板自己的转发器 —— 那会变成无限自调用，
// 表现为刷屏的报错/卡死，而不是「找不到模板」。
if (!template) {
  const metaPath = join(BOARD, "project.json");
  console.error(
    `找不到模板目录，无法转发 ${SELF}。\n\n` +
      `这个看板的 scripts/${SELF} 只是入口转发，真正的脚本在模板目录。\n` +
      `已经试过：${metaPath} 里的 templateDir、环境变量 OPS_TEMPLATE_DIR、` +
      `以及看板目录旁边的兄弟目录（../ 和 ../../）。\n\n` +
      `换机器后最容易失效的就是这两处 —— 它们记的都是旧机器上的绝对路径。\n` +
      `改 ${metaPath} 里的 templateDir 指向模板目录，或设置环境变量 OPS_TEMPLATE_DIR。`,
  );
  process.exit(1);
}

const entry = join(template, "scripts", SELF);

if (!existsSync(entry)) {
  const metaPath = join(BOARD, "project.json");
  console.error(
    `找不到模板脚本：\n  ${entry}\n\n` +
      `定位到的模板目录是 ${template}，但那里没有 scripts/${SELF}。\n` +
      `检查模板是否完整（scripts/ 下应该有 ${SELF}），或改 ${metaPath} 里的 templateDir。`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
// 已经有 --board 就不再补（让调用方可以显式指定别的看板）
const hasBoard = args.includes("--board");
const forwarded = hasBoard ? args : ["--board", BOARD, ...args];

const result = spawnSync(process.execPath, [entry, ...forwarded], {
  stdio: "inherit",
  cwd: BOARD,
  env: { ...process.env, OPS_BOARD_DIR: BOARD },
});

if (result.error) {
  console.error(`转发失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
