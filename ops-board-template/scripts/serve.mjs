#!/usr/bin/env node
// scripts/serve.mjs — 本地预览。
//
//   node scripts/serve.mjs           # http://127.0.0.1:8790
//   node scripts/serve.mjs 9000      # 换端口
//   node scripts/serve.mjs --board <看板目录>
//
// 这一层只做两件事：改完台账自动重渲染、把 dist/ 静态发出去。
//
// 「问 AI」不走这里：页面把问题交给 Harness（`/ops-board/ask`），
// 由 Harness 开会话、选模型、执行。所以这套东西里没有接口密钥、
// 没有接入点、没有模型名 —— 那些都归 Harness 管，模板不碰。
//
// 只监听 127.0.0.1，不对外。

import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, "..");

// 看板目录：数据在这儿，脚本在模板那儿。优先级同 render.mjs。
function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
const BOARD_DIR = resolve(
  argValue("board") || process.env.OPS_BOARD_DIR || TEMPLATE_ROOT,
);
const ROOT = BOARD_DIR;
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "index.html");
const LEDGER = join(ROOT, "ledger.json");
const CONFIG = join(ROOT, "board.config.json");
const RENDER = join(HERE, "render.mjs");
const SKILLS = join(ROOT, "skills.json");
const COLLECT = join(HERE, "collect-skills.mjs");

// 端口：优先 --port，其次第一个纯数字参数（老用法 `serve.mjs 8790`）
const port = Number(argValue("port") || process.argv.find((a) => /^\d+$/.test(a)) || 8790);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ── 重渲染 ──

// Skill 统计：有 skills.json 就用它；会话日志比它新时先重新统计一次。
// 统计失败不挡渲染——只是这块显示上次的数据。
function refreshSkills() {
  if (!existsSync(COLLECT)) return;
  let project = "";
  try {
    project = JSON.parse(readFileSync(join(ROOT, "project.json"), "utf8")).projectDir || "";
  } catch {}
  const stale = mtime(SKILLS) < mtime(LEDGER) || !existsSync(SKILLS);
  if (!stale) return;
  try {
    execFileSync(process.execPath, [COLLECT, "--project", project, "--out", SKILLS], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (e) {
    console.error("skill 统计失败：" + ((e && e.stderr) || (e && e.message) || e));
  }
}

function ensureFresh() {
  refreshSkills();
  const newest = Math.max(mtime(LEDGER), mtime(CONFIG), mtime(SKILLS));
  const built = mtime(OUT);
  if (built && built >= newest) return { rebuilt: false };
  try {
    execFileSync(process.execPath, [RENDER, "--board", ROOT], { cwd: ROOT, encoding: "utf8" });
    return { rebuilt: true };
  } catch (e) {
    const msg = (e.stdout || "") + (e.stderr || "");
    console.error("\n渲染失败：\n" + msg);
    return { rebuilt: false, error: msg };
  }
}

// ── HTTP 小工具 ──

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

// ── 请求分发 ──

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${port}`);
  const path = decodeURIComponent(url.pathname);

  // 这页不一定是从 8790 打开的：双击 html 是 file://（源是 null），
  // 被别的预览服务托管时源是别人的地址。两种情况都得让请求能进来。
  // 请求里不带 cookie、不带凭据，所以用 * 就够，不用回显 Origin。
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    // 只回答「我在不在」。页面一打开就探一下，好在用户点按钮之前把话说清楚。
    if (path === "/api/ping" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, app: "ops-board", port });
    }

    if (path === "/api/board" && req.method === "GET") {
      return send(res, 200, readFileSync(LEDGER), MIME[".json"]);
    }

    if (path === "/" || path === "/index.html") {
      const r = ensureFresh();
      if (r.error) return send(res, 500, "渲染失败，看终端输出的报错。");
      return send(res, 200, readFileSync(OUT), MIME[".html"]);
    }

    const file = join(DIST, path.replace(/^\/+/, ""));
    if (!file.startsWith(DIST) || !existsSync(file)) return send(res, 404, "没有这个文件");
    return send(res, 200, readFileSync(file), MIME[extname(file)] || "application/octet-stream");
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

ensureFresh();

server.listen(port, HOST, () => {
  console.log(`\n工作台：http://${HOST}:${port}`);
  console.log(`台账：${LEDGER}`);
  console.log(`问 AI：交给 Harness（模板里不含接入点与密钥）。`);
  console.log(`改完台账刷新浏览器即可。Ctrl+C 停止。\n`);
});
