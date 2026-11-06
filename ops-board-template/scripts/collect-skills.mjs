// scripts/collect-skills.mjs — 统计这个项目相关的 Skill。
//
// 两个来源，分别落到 skills.json 的 used / produced：
//   used     Harness 会话日志里真的调用过 `skill` 工具的那些（按会话 cwd 匹配本项目）
//   produced 项目目录里自己带 SKILL.md 的（agent_created: true 的算"本项目产出的"）
//
// 用法：node scripts/collect-skills.mjs [--project <目录>] [--board <目录>] [--out <文件>]
// 会话根默认 ~/.dsh/sessions，可用 DSH_SESSIONS 覆盖。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// 看板目录（数据所在处）≠ 模板目录（脚本所在处）。默认还要读看板里的 ledger.json 取项目名。
const BOARD = resolve(arg("board", process.env.OPS_BOARD_DIR || resolve(HERE, "..")));

const PROJECT = arg("project", "");
const OUT = resolve(arg("out", join(BOARD, "skills.json")));
const SESSIONS = resolve(process.env.DSH_SESSIONS || join(homedir(), ".dsh", "sessions"));

/** 一个会话文件是「一帧一条记录」的 zstd 流，需要按 magic 切开逐帧解。 */
function decompressAll(file) {
  const buf = readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  let text = "";
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(from, to)).toString("utf8");
    } catch {}
  }
  return text;
}

function norm(p) {
  return String(p || "").replace(/[\\/]+$/, "").toLowerCase();
}

/* ───────────────────────────── used ───────────────────────────── */

/** `wantedCwds` 是这个项目相关的工作目录（项目本身 + 报文目录）。 */
function scanSessions(wantedCwds) {
  const used = new Map();
  if (!existsSync(SESSIONS)) return used;

  for (const ws of readdirSync(SESSIONS)) {
    const wsDir = join(SESSIONS, ws);
    let sessions = [];
    try {
      if (!statSync(wsDir).isDirectory()) continue;
      sessions = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const file = join(wsDir, session, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      let text;
      try {
        text = decompressAll(file);
      } catch {
        continue;
      }
      let cwd = "";
      let title = "";
      const calls = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === "session" && o.cwd) cwd = o.cwd;
        if (o.type === "session/title" && o.data && o.data.title) title = o.data.title;
        if (o.type === "tool/call" && o.data && o.data.name === "skill") {
          let args = o.data.arguments;
          try {
            args = typeof args === "string" ? JSON.parse(args) : args;
          } catch {}
          const name = (args && (args.name || args.skill)) || "";
          if (name) calls.push({ name, at: o.time });
        }
      }
      // 只统计「会话工作目录属于这个项目」的那些；没指定 project 时全收。
      if (wantedCwds.length && !wantedCwds.includes(norm(cwd))) continue;
      for (const call of calls) {
        const row = used.get(call.name) || { name: call.name, sessions: 0, total: 0, lastAt: 0, titles: [] };
        row.total += 1;
        row.lastAt = Math.max(row.lastAt, call.at || 0);
        if (title && !row.titles.includes(title)) row.titles.push(title);
        used.set(call.name, row);
      }
      // 同一会话里同一个 skill 多调几次只算一个会话
      for (const name of new Set(calls.map((c) => c.name))) used.get(name).sessions += 1;
    }
  }
  return used;
}

/* ─────────────────────────── produced ─────────────────────────── */

function readFrontmatter(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (!kv) continue;
      meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const heading = text.match(/^#\s+(.+)$/m);
  return {
    name: meta.name || "",
    description: meta.description || "",
    version: meta.version || "",
    agentCreated: String(meta.agent_created || "").toLowerCase() === "true",
    title: heading ? heading[1].trim() : "",
  };
}

function findSkillFiles(root, out = [], depth = 0) {
  if (!root || depth > 4) return out;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) findSkillFiles(full, out, depth + 1);
    else if (entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

function scanProduced(projectDir) {
  const produced = [];
  if (!projectDir || !existsSync(projectDir)) return produced;
  for (const file of findSkillFiles(projectDir)) {
    const meta = readFrontmatter(file);
    if (!meta) continue;
    produced.push({
      name: meta.name || file,
      title: meta.title,
      description: meta.description,
      version: meta.version,
      agentCreated: meta.agentCreated,
      path: file,
    });
  }
  return produced;
}

/* ─────────────────────────── related ──────────────────────────── */

// 「跟这个项目有关」的 skill：装在 skill 根里、正文提到这个项目的那些。
// 典型是运维手册——不是本项目产出的，但就是为它写的。
// 判据：说明/标题里点了项目名（目录名或台账里的中文名），或正文里反复提到。
// 只在命令示例里出现一次的不算——那只是顺手举例（如 windows-ocr 的 cap 示例）。
function scanRelated(projectDir, projectNames, producedNames) {
  const roots = [join(homedir(), ".dsh", "skills"), arg("extraSkills", "")].filter(Boolean);
  const seen = new Set(producedNames);
  const related = [];
  const names = (projectNames || []).filter(Boolean).map((n) => String(n).toLowerCase());
  if (!names.length) return related;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of findSkillFiles(root)) {
      const meta = readFrontmatter(file);
      if (!meta || seen.has(meta.name)) continue;
      let body = "";
      try {
        body = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lower = body.toLowerCase();
      // 目录路径本身包含目录名，先把路径抠掉再数名字，否则一次举例会被数成两次。
      const stripped = projectDir ? lower.split(projectDir.toLowerCase()).join(" ") : lower;
      const head = `${meta.name} ${meta.title} ${meta.description}`.toLowerCase();
      let nameHits = 0;
      let inFrontmatter = false;
      for (const n of names) {
        nameHits += stripped.split(n).length - 1;
        if (head.includes(n)) inFrontmatter = true;
      }
      if (!inFrontmatter && nameHits < 2) continue;
      seen.add(meta.name);
      related.push({
        name: meta.name || file,
        title: meta.title,
        description: meta.description,
        version: meta.version,
        agentCreated: meta.agentCreated,
        hits: nameHits,
        inFrontmatter,
        path: file,
      });
    }
  }
  return related.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
}

/* ────────────────────────────── main ─────────────────────────── */

const wanted = PROJECT ? [norm(PROJECT), norm(BOARD)] : [];
const used = [...scanSessions(wanted).values()]
  .map((row) => ({
    name: row.name,
    sessions: row.sessions,
    total: row.total,
    lastAt: row.lastAt || null,
    titles: row.titles.slice(0, 5),
  }))
  .sort((a, b) => b.sessions - a.sessions || b.total - a.total);

const produced = scanProduced(PROJECT).sort((a, b) => a.name.localeCompare(b.name));
// 目录名 + 台账项目名（中文）都算「这个项目的名字」
const dirName = PROJECT ? PROJECT.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
let ledgerName = "";
try {
  const ledger = JSON.parse(readFileSync(join(BOARD, "ledger.json"), "utf8"));
  ledgerName = (ledger.project && ledger.project.name) || "";
} catch {}
const projectNames = [...new Set([dirName, ledgerName].filter(Boolean))];
const related = scanRelated(PROJECT, projectNames, produced.map((p) => p.name));

const data = {
  updatedAt: new Date().toISOString().replace("Z", "+00:00"),
  project: PROJECT,
  projectNames,
  used,
  produced,
  related,
};

writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
console.log(
  `skills.json: used ${used.length} / produced ${produced.length} / related ${related.length} → ${OUT}`,
);
