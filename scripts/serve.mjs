#!/usr/bin/env node
// scripts/serve.mjs — 本地预览。
//
//   node scripts/serve.mjs           # http://127.0.0.1:8790
//   node scripts/serve.mjs 9000      # 换端口
//   node scripts/serve.mjs --board <看板目录>
//
// 这一层做三件事：改完台账自动重渲染、把 dist/ 静态发出去、
// 以及给「独立对话窗」当回答中转（见下面 /api/relay/* 那段）。
//
// 「问 AI」本身不走这里：页面把问题交给 Harness（`/ops-board/ask`），
// 由 Harness 开会话、选模型、执行。所以这套东西里没有接口密钥、
// 没有接入点、没有模型名 —— 那些都归 Harness 管，模板不碰。
//
// 中转只是过路：回答的正文由 Harness 产出，这里不解析、不落库（只在
// .relay.ndjson 里记一行「谁在什么时刻递了一条」，用于排查）。
//
// 只监听 127.0.0.1，不对外。

import { createServer } from "node:http";
import {
  readFileSync,
  appendFileSync,
  statSync,
  existsSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { evidenceFreshness } from "./lib/evidence.mjs";
import { lookAtFile, lookAtCommit } from "./lib/code-look.mjs";
import { buildFlow } from "./lib/flow.mjs";
import { planWorkbench, planBatches } from "./lib/workbench.mjs";
// 中控化（2026-11-21）：文件锁 + 依赖图 + 调派判定
import { createLockTable } from "./lib/locks.mjs";
import { buildGraph } from "./lib/graph.mjs";
import { requestDispatch, describeDispatch } from "./lib/dispatch.mjs";
import { extractIntent } from "./lib/intent.mjs";
import { createLedgerWriter, atomicWriteJson } from "./lib/ledger-write.mjs";

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
const REPORT = join(HERE, "report.mjs");
const SKILLS = join(ROOT, "skills.json");
const COLLECT = join(HERE, "collect-skills.mjs");
// 渲染出的 index.html 会把 scripts/lib/client.js 内联进去（render.mjs 里 readFileSync 读它）。
// 所以 index.html 的新旧不只取决于台账/配置 —— client.js / render.mjs 动过就必须重渲染，
// 否则改完前端逻辑页面还是旧的（「改了没反应」的经典源头）。
const CLIENT_JS = join(HERE, "lib", "client.js");

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

// ── 回答中转 ─────────────────────────────────────────────────────────
//
// 为什么这一层要管「回答」：
//
// 独立对话窗是**系统浏览器里的一个窗口**，源是 http://127.0.0.1:<宿主端口>。
// 插件跑在 Harness 外壳里，源是 dsh-app://app。两者不同源，postMessage 和
// BroadcastChannel 都过不去（不同源就是不同的世界），回答没法直接投回来。
//
// 这一层正好在两者中间：它已经在跑、允许跨源（Access-Control-Allow-Origin: *）、
// 而且能单独重启 —— 所以回答借它过河，不用去改 Harness 宿主插件
// （改宿主等于要重启整个应用）。
//
//   插件 ──POST /api/relay/answer──> 这里 ──SSE /api/relay/answers──> 独立窗
//   独立窗 ──POST /api/relay/req───> 这里 ──SSE /api/relay/reqs─────> 插件
//   插件 ──POST /api/relay/reply───> 这里 ──SSE /api/relay/answers──> 独立窗
//
// 只有本机回环在用，不落任何凭据。
const RELAY_KEEP = 60;
const RELAY_LOG = join(ROOT, ".relay.ndjson");
const relayAnswers = [];
const relayReqs = [];
const relayAnswerClients = new Set();
const relayReqClients = new Set();

// 中转往来记一行到文件。排查「窗口收不到回答」时，第一个要回答的问题是
// 「插件到底发出来没有」—— 发出来了就是这一层或窗口的问题，没发出来就是
// 插件那边没跑到。光看界面分不清这两件事。
function relayLog(entry) {
  try {
    appendFileSync(RELAY_LOG, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {}
}

function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolveBody({});
      try {
        resolveBody(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

// 一条 SSE 长连接。手写而不是引用依赖，是因为这一层刻意只有 node 内置模块。
function relaySubscribe(req, res, clients, hello) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  for (const item of hello) res.write(`data: ${JSON.stringify(item)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 20000);
  ping.unref?.();
  const done = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on("close", done);
  res.on("close", done);
}

function relayPush(clients, payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {}
  }
}

function relayRemember(list, payload) {
  list.push(payload);
  if (list.length > RELAY_KEEP) list.splice(0, list.length - RELAY_KEEP);
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
  const newest = Math.max(mtime(LEDGER), mtime(CONFIG), mtime(SKILLS), mtime(CLIENT_JS), mtime(RENDER));
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

// ── 并行执行计划 ──
//
//   GET  /api/flow/plan      现在能同时开工哪几件？谁在等谁？
//   POST /api/flow/claim     领一件（同区域互斥）
//   POST /api/flow/release   交还一件
//
// 为什么要有这个接口，而不是只画张图：
// 图只是「看」。真正并行要解决的是「两件活同时改同一块地方」——
// 台账里 area 的前缀就是那块地的名字。同一个前缀同一时刻只放行一件。
//
// ⚠️ 领取状态必须**落盘**（调研笔记 D22：并行状态必须持久化）。
// 曾经：状态只在模块内存里，重启服务就清空 —— 服务异常退出时所有人的
// 领取状态一起丢，正在执行的人一重启就得重新领。
// 现在：每次 claim / release 都写回看板目录下的 `flow-claims.json`，
// 启动时若有文件就加载。停服不丢、多进程各读同一份文件（写入用临时文件+
// 原子改名，避免读到半截）。旧的内存 Map 语义（本进程内同区域互斥）不变。
//
// 文件路径：默认在每块看板自己的目录，`--claims <文件>` 可覆盖（测试用它
// 指向临时文件，隔离每次运行）。
const claimsPath = resolve(
  argValue("claims") || join(ROOT, "flow-claims.json")
);

/** 从磁盘读回领取状态；文件损坏 / 读不动就当没有（启动不能被状态卡死）。 */
function loadClaims() {
  const map = new Map();
  try {
    if (!existsSync(claimsPath)) return map;
    const raw = JSON.parse(readFileSync(claimsPath, "utf8"));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw.claims) ? raw.claims : [];
    for (const c of arr) {
      if (c && c.id && c.prefix && c.by && c.at) map.set(c.id, { id: c.id, by: c.by, at: c.at, prefix: c.prefix });
    }
  } catch (e) {
    console.error("flow-claims 读取失败（按空状态启动）：" + String((e && e.message) || e));
  }
  return map;
}

/** 写回磁盘：先写临时文件再原子改名，绝不留下半截 JSON。 */
function persistClaims() {
  const arr = [...flowClaims.values()].sort((a, b) => a.id.localeCompare(b.id));
  const tmp = claimsPath + ".tmp." + process.pid;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), claims: arr }, null, 2));
    renameSync(tmp, claimsPath);
  } catch (e) {
    console.error("flow-claims 落盘失败：" + String((e && e.message) || e));
    try { if (existsSync(tmp)) renameSync(tmp, claimsPath); } catch {}
  }
}

const flowClaims = loadClaims(); // id -> { by, at, prefix }

// ── 文件锁表（中控化步骤 4/6，2026-11-21）────────────────────────
//
// 和 `flowClaims` 的分工要说清楚，别混：
//
//   flowClaims  = 「这张**卡**被谁领走了」 —— 业务层互斥，按卡 id + 区域前缀
//   fileLocks   = 「这些**文件**被谁占着」 —— 物理层互斥，按文件 + 依赖闭包
//
// 两层都需要：卡级互斥挡的是「同一张卡被两个人做」，
// 文件级互斥挡的是「两张不同的卡改了同一个文件」—— 后者是 `flowClaims` 看不见的。
//
// 锁表默认落在看板目录，`--locks <文件>` 可覆盖（测试指向临时文件）。
const locksPath = resolve(argValue("locks") || join(ROOT, "file-locks.json"));
const fileLocks = createLockTable({ locksPath });
const locksLoaded = fileLocks.load();

// 依赖图缓存。**不是**「常驻 watcher」（架构文档 §三决策 3 明确不做），
// 只是「同一次 serve 进程里、同一块板，30 秒内复用」——
// 避免一次调派里被问好几遍都要重建。
// 超过 30 秒就重建，所以图不会长期滞后。
const GRAPH_TTL_MS = 30 * 1000;
const graphCache = new Map();   // board key -> { at, graph }
let graphSeq = 0;               // 记录重建次数，便于测试断言「真的复用了」

/** 取图（带 30 秒缓存）。 */
async function getGraph({ force }) {
  const boardKey = ROOT;
  const hit = graphCache.get(boardKey);
  if (!force && hit && Date.now() - hit.at < GRAPH_TTL_MS) return hit.graph;
  const target = targetProjectDir();
  if (!target) return { ok: false, error: "这块板没配 projectDir，不知道该给哪个项目建图" };
  const outFile = resolve(argValue("graph") || join(ROOT, ".graph-cache.json"));
  const g = await buildGraph({
    cwd: resolve(import.meta.dirname, ".."),
    target,
    sourceDirs: sourceDirsOf(target),
    outFile,
  });
  graphSeq++;
  if (g.ok) graphCache.set(boardKey, { at: Date.now(), graph: g });
  return g;
}

/** 读 project.json 拿被管控项目目录。 */
function targetProjectDir() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "project.json"), "utf8")).projectDir || "";
  } catch { return ""; }
}

/**
 * 源码目录白名单（`--include-only` 用，见架构文档 §十F）。
 *
 * ⚠️ 为什么不是「扫全项目再排除」：实测 `--exclude` 完全不能省时间
 * （83 s → 78 s），必须用白名单才能降到 1.8 s。
 * 白名单固定这几项 + 项目里实际存在的一级目录（自动探测），
 * 避免换项目就漏扫。
 */
function sourceDirsOf(target) {
  const fixed = ["app.js", "app.json", "config.js", "utils", "pages", "components",
    "custom-tab-bar", "cloudfunctions", "scripts", "sim", "pkg"];
  const out = fixed.filter((d) => existsSync(join(target, d)));
  // 兜底：如果白名单一个都不存在（不是小程序项目），退化为扫根
  return out.length ? out : ["."];
}


// 推导只有一个来源：flow.mjs。这里不再另写一套排序 ——
// 曾经这里按 id 字母序挑「同区域第一个」，而 flow.mjs 按阶段步序挑，
// 结果接口说 FEAT-014 能开工、图说 OPS-022 先做，同一个事实两套编码。
function buildPlan() {
  let ledger, config;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch (e) {
    return { ok: false, error: "台账读不动：" + String((e && e.message) || e) };
  }
  try {
    config = JSON.parse(readFileSync(join(ROOT, "board.config.json"), "utf8"));
  } catch (e) {
    return { ok: false, error: "配置读不动：" + String((e && e.message) || e) };
  }

  // 已领走的 id 交给 flow.mjs 参与定头：被领走的不再是头，
  // 同区域下一件顶上来 —— 否则串行泳道永远卡在第一件。
  const flow = buildFlow(config, ledger, new Set(flowClaims.keys()));
  const runnable = [];
  const waiting = [];
  for (const lane of flow.lanes) {
    for (const track of lane.tracks) {
      for (const n of track.items) {
        const held = flowClaims.get(n.id);
        if (held) {
          // 已在执行：列进 runnable 但标成 running，不计入「还能再开几路」
          runnable.push({
            id: n.id,
            title: n.title,
            prefix: n.prefix,
            area: n.area,
            status: n.status,
            lane: lane.key,
            state: "running",
            by: held.by,
          });
        } else if (n.isHead) {
          runnable.push({
            id: n.id,
            title: n.title,
            prefix: n.prefix,
            area: n.area,
            status: n.status,
            lane: lane.key,
            state: "ready",
            by: "",
          });
        } else {
          const holder = flowClaims.get(n.waitFor);
          waiting.push({
            id: n.id,
            title: n.title,
            prefix: n.prefix,
            lane: lane.key,
            waitsFor: n.waitFor,
            reason: holder ? `「${n.prefix}」正由 ${holder.by} 处理` : `同区域「${n.prefix}」要排队`,
          });
        }
      }
    }
  }

  return {
    ok: true,
    updatedAt: ledger.updatedAt || "",
    total: flow.totals.open,
    // 「还能再开几路」只算 ready 的；running 的是已经在跑的
    parallelNow: runnable.filter((r) => r.state === "ready").length,
    running: runnable.filter((r) => r.state === "running").length,
    queued: waiting.length,
    lanes: new Set(runnable.filter((r) => r.state === "ready").map((r) => r.prefix)).size,
    runnable,
    waiting,
  };
}

// ── 请求分发 ──

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${port}`);
  let path = decodeURIComponent(url.pathname);
  // 插件侧把板子挂在 /ops-board/b/<boardId>/… 底下代理到这里（flowUrl 在
  // Harness 里就拼这种前缀）。这里把前缀剥掉，让同一套 /api/flow、/api/workbench
  // 路由在「Harness 里」和「浏览器裸开」下都能应答 —— 服务端只认看板目录本身。
  const bMatch = path.match(/^\/ops-board\/b\/[^/]+\/(api\/.*)$/);
  if (bMatch) path = "/" + bMatch[1];

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

    // ── 回答中转 ──
    //
    // 三个入口，都只服务本机的两个窗口（Harness 外壳 / 独立浏览器窗）：
    //   POST /api/relay/answer  插件把某一轮回答交给这里
    //   GET  /api/relay/answers 独立窗订阅「回答」
    //   POST /api/relay/req     独立窗要问会话列表之类，转给插件
    //   GET  /api/relay/reqs    插件订阅「请求」
    //   POST /api/relay/reply   插件把请求的结果回给这里
    //
    // 为什么请求也要绕一圈：会话列表只有插件能读（它有 sessions 服务），
    // 而独立窗不是插件的一部分，够不到那个服务。
    if (path === "/api/relay/answer" && req.method === "POST") {
      const payload = await readJson(req);
      relayLog({ dir: "answer", askId: payload.askId, surface: payload.surface, len: String(payload.text || "").length });
      relayRemember(relayAnswers, payload);
      relayPush(relayAnswerClients, payload);
      return sendJson(res, 200, { ok: true, listeners: relayAnswerClients.size });
    }

    if (path === "/api/relay/answers" && req.method === "GET") {
      return relaySubscribe(req, res, relayAnswerClients, relayAnswers.slice(-8));
    }

    if (path === "/api/relay/req" && req.method === "POST") {
      const payload = await readJson(req);
      relayLog({ dir: "req", reqId: payload.reqId, kind: payload.kind });
      relayRemember(relayReqs, payload);
      relayPush(relayReqClients, payload);
      // 插件没开着就把话说清楚，别让窗口干等。
      return sendJson(res, 200, { ok: true, listeners: relayReqClients.size });
    }

    if (path === "/api/relay/reqs" && req.method === "GET") {
      return relaySubscribe(req, res, relayReqClients, []);
    }

    if (path === "/api/relay/reply" && req.method === "POST") {
      const payload = await readJson(req);
      relayLog({ dir: "reply", reqId: payload.reqId, ok: payload.ok });
      relayRemember(relayAnswers, payload);
      relayPush(relayAnswerClients, payload);
      return sendJson(res, 200, { ok: true, listeners: relayAnswerClients.size });
    }

    // 自检：谁连在这儿、最近过了哪些消息。排查的时候直接看这个。
    if (path === "/api/relay/status" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        answerClients: relayAnswerClients.size,
        reqClients: relayReqClients.size,
        answers: relayAnswers.slice(-5),
        reqs: relayReqs.slice(-5),
      });
    }

    // ── 报表导出 ──
    //
    //   GET  /api/report/boards   可导出的看板清单（供前端勾选）
    //   GET  /api/fs/stat?path=   回读某个位置还在不在
    //   POST /api/fs/pick         弹系统原生「选择文件夹」，返回绝对路径
    //   POST /api/report/export   按 { mode, boards, formats, split, out } 生成
    //
    // 为什么放在看板服务里而不是插件 host 半：host 半一改就得重启整个应用，
    // 而这件事纯粹是"读几份 json、写几个文件"，放在这儿改完刷新页面即可。

    // 给「浏览…」用：弹出 Windows 原生的「选择文件夹」对话框。
    //
    // 为什么不是网页里自己画一个目录树：那个东西能选，但不是"打开文件夹选择"，
    // 用户要一层一层点，还看不到磁盘上的真实结构，等于白做。
    // 浏览器侧的 <input webkitdirectory> 也解决不了 —— 新版 Electron 不再暴露
    // File.path，webUtils 也没挂到 window 上，选完拿不到绝对路径。
    // 而本服务就跑在用户自己机器上，直接叫系统对话框是唯一能拿到真路径的办法。
    if (path === "/api/fs/pick" && req.method === "POST") {
      if (process.platform !== "win32") {
        return sendJson(res, 400, { ok: false, error: "这个功能目前只在 Windows 上可用" });
      }
      const body = await readJson(req);
      const start = String(body.start || "");
      const script = join(HERE, "pick-folder.ps1");
      if (!existsSync(script)) {
        return sendJson(res, 500, { ok: false, error: "找不到 pick-folder.ps1" });
      }
      // dryRun：只跑脚本的 -DryRun 分支（打印标题就退），不弹窗。
      // 给自动化测试用 —— 否则测一次就得有人在弹窗上点一下。
      const extra = body.dryRun ? ["-DryRun"] : ["-Start", start];
      try {
        // 用异步而不是 execFileSync：对话框会一直开着直到用户点确定或取消，
        // 同步执行会把整个服务（包括看板自己的轮询）卡死几十秒。
        //
        // -STA 必需：Shell.Application 的 BrowseForFolder 是 COM 组件，MTA 上弹不出来。
        // windowsHide 必须为 false：true 会把弹出的对话框一起藏掉，
        // 用户那边表现就是"点了浏览，什么都没发生" —— 这正是上一版最糟的地方。
        const picked = await new Promise((resolveDone, rejectDone) => {
          execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, ...extra],
            { encoding: "utf8", timeout: 600000, windowsHide: false, maxBuffer: 1 << 20 },
            (err, stdout) => {
              if (err) rejectDone(err);
              else resolveDone(String(stdout || "").trim());
            }
          );
        });
        if (body.dryRun) {
          // 回显脚本里那句标题，用来证明中文没被 GBK 解成乱码。
          return sendJson(res, 200, { ok: true, dryRun: true, title: picked });
        }
        // 空字符串 = 用户点了取消，这不是错误。
        return sendJson(res, 200, { ok: true, path: picked, canceled: !picked });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "弹不出文件夹对话框：" + String((e && e.message) || e) });
      }
    }

    // 证据新鲜度：卡片说「已修好」，但它引用的文件后来又被改过几次？
    //
    //   GET /api/evidence/stale
    //   GET /api/evidence/file?path=&hint=      看证据里那个文件的当前代码
    //   GET /api/evidence/commit?hash=          看证据里那个 commit 改了什么
    //
    // 为什么要这个：台账记录的是「当时怎么判断的」，代码却会继续变。
    // OPS-001 的结论写在 10-22，而它引用的 index.js 在 11-12 又改了 3 次 ——
    // 「已修复」这三个字还是不是真的，只能靠人去复核，而页面上原本连提都不提。
    //
    // 时间全部取自 git 提交时间（真实发生过的时刻），不用 Date.now()。
    function projectDirOf() {
      try {
        return JSON.parse(readFileSync(join(ROOT, "project.json"), "utf8")).projectDir || "";
      } catch {
        return "";
      }
    }

    if (path === "/api/flow/plan" && req.method === "GET") {
      return sendJson(res, 200, buildPlan());
    }

    if (path === "/api/flow/claim" && req.method === "POST") {
      const payload = await readJson(req);
      const id = String(payload.id || "").trim();
      const by = String(payload.by || "unknown").trim();
      if (!id) return sendJson(res, 400, { ok: false, error: "缺 id" });

      const plan = buildPlan();
      if (!plan.ok) return sendJson(res, 500, plan);
      const target = plan.runnable.find((r) => r.id === id);
      if (!target) {
        const why = plan.waiting.find((w) => w.id === id);
        return sendJson(res, 409, {
          ok: false,
          error: why ? `这件在排队：${why.reason}（等 ${why.waitsFor}）` : "这件不在可开工清单里",
          waiting: why || null,
        });
      }
      // 已在执行的不许再领：无论是同一个人点重了，还是别人想接手，
      // 同一件活同一时刻只能有一个人认领。否则会静默覆盖持有者。
      if (target.state === "running") {
        return sendJson(res, 409, {
          ok: false,
          error: `这件（${id}）正在执行，不能重复领取`,
          holder: target.by,
        });
      }
      // 同区域已有人持有时拒绝 —— 并行的核心保护
      const conflict = [...flowClaims.values()].find((c) => c.prefix === target.prefix && c.id !== id);
      if (conflict) {
        return sendJson(res, 409, {
          ok: false,
          error: `同区域「${target.prefix}」已由 ${conflict.by} 持有 ${conflict.id}`,
        });
      }
      flowClaims.set(id, { id, by, prefix: target.prefix, at: new Date().toISOString() });
      persistClaims();
      // 领完之后立刻给出「下一件是谁」，让执行者不用自己算队列
      const after = buildPlan();
      const nextSame = after.waiting.find((w) => w.prefix === target.prefix) || null;
      return sendJson(res, 200, {
        ok: true,
        claimed: id,
        by,
        prefix: target.prefix,
        holders: flowClaims.size,
        nextInSameArea: nextSame ? nextSame.id : null,
      });
    }

    if (path === "/api/flow/release" && req.method === "POST") {
      const payload = await readJson(req);
      const id = String(payload.id || "").trim();
      const by = String(payload.by || "").trim();
      const held = flowClaims.get(id);
      if (!held) return sendJson(res, 404, { ok: false, error: "这件没被领走" });
      // 只认领取人交还：否则谁都能把别人的活放了
      if (by && held.by !== by) {
        return sendJson(res, 409, { ok: false, error: `这件是 ${held.by} 领的，${by} 不能交还` });
      }
      flowClaims.delete(id);
      persistClaims();
      const after = buildPlan();
      const nextSame = after.runnable.find((r) => r.prefix === held.prefix) || null;
      return sendJson(res, 200, {
        ok: true,
        released: id,
        holders: flowClaims.size,
        nextInSameArea: nextSame ? nextSame.id : null,
      });
    }

    // ── 文件锁与调派（中控化，2026-11-21）────────────────────────
    //
    //   GET  /api/locks          当前占着哪些文件
    //   GET  /api/graph          依赖图概况（模块/边/耗时/是否新鲜）
    //   POST /api/dispatch       报意图 → 判冲突 → 放行/排队
    //   POST /api/dispatch/release  交还
    //
    // 为什么 GET /api/locks 要能把「为什么冲突」也带出来：
    // 用户看到「排队中」时第一个问题就是「跟谁撞了、撞在哪个文件上」。
    // 只回一个布尔值等于让人自己猜（那正是 `flowClaims` 那套的短板）。

    if (path === "/api/locks" && req.method === "GET") {
      const list = fileLocks.list();
      // 顺带把「每条锁对应哪张卡」标出来（按 files 反查台账里的卡）
      let items = [];
      try {
        const led = JSON.parse(readFileSync(LEDGER, "utf8"));
        items = (led.items || []).filter((i) => Array.isArray(i.files) && i.files.length);
      } catch {}
      // 把文件锁翻译成**卡片编号** —— 用户认的是 OPS-903，不是 utils/a.js。
      //
      // 匹配规则要宽一点：锁里的 `files` 已经被 R1 扩张过（一个 .js 会带出
      // .json/.wxml/.wxss 兄弟），而卡片 `files` 里通常只写真正要改的那一个。
      // 所以**用「去掉扩展名的主干」比对**，否则永远对不上。
      const stemOf = (p) => String(p || "").replace(/\.[^./]+$/, "").split("\\").join("/");
      const enriched = list.map((l) => {
        const lockStems = new Set((l.files || []).map(stemOf));
        const cards = items
          .filter((i) => (i.files || []).some((f) => lockStems.has(stemOf(f))))
          .map((i) => i.id);
        return { ...l, cards };
      });
      return sendJson(res, 200, {
        ok: true,
        count: enriched.length,
        loadedAtStart: locksLoaded,
        locks: enriched,
      });
    }

    if (path === "/api/graph" && req.method === "GET") {
      const force = /[?&]force=1/.test(req.url || "");
      const g = await getGraph({ force });
      if (!g.ok) return sendJson(res, 200, { ok: false, error: g.error });
      const cached = graphCache.get(ROOT);
      const ageMs = cached ? Date.now() - cached.at : 0;
      return sendJson(res, 200, {
        ok: true,
        modules: g.modules.length,
        edges: g.edges.length,
        unresolved: g.unresolved || 0,
        buildMs: g.ms,
        // 「图是不是新鲜」要显式给出来：30 秒缓存意味着**可能滞后**，
        // 界面得能说明这一点，不能让用户以为永远是实时图。
        ageMs,
        stale: ageMs > GRAPH_TTL_MS,
        rebuilds: graphSeq,
      });
    }

    if (path === "/api/dispatch" && req.method === "POST") {
      const body = await readJson(req);
      const owner = String(body.owner || body.by || "").trim();
      if (!owner) return sendJson(res, 400, { ok: false, error: "缺 owner（谁在申请）" });
      // 允许直接给意图对象，也允许给一坨文本让中控自己解析（agent 的原话）
      const intent = body.intent && typeof body.intent === "object"
        ? { ok: true, files: body.intent.files || [], addsEdges: body.intent.addsEdges || [], raw: "", error: "" }
        : extractIntent(body.text || "");
      const r = await requestDispatch({
        locks: fileLocks,
        intent,
        owner,
        task: String(body.task || ""),
        grapher: () => getGraph({ force: !!body.forceGraph }),
        ttlSec: Number(body.ttlSec) > 0 ? Number(body.ttlSec) : undefined,
      });
      const code = r.decision === "go" ? 200 : r.decision === "queue" ? 409 : 400;
      return sendJson(res, code, { ...r, summary: describeDispatch(r) });
    }

    if (path === "/api/dispatch/release" && req.method === "POST") {
      const body = await readJson(req);
      const lockId = String(body.lockId || "").trim();
      const owner = String(body.owner || body.by || "").trim();
      const r = await fileLocks.release(lockId, owner);
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (path === "/api/dispatch/renew" && req.method === "POST") {
      const body = await readJson(req);
      const r = await fileLocks.renew(String(body.lockId || ""), String(body.owner || ""), Number(body.ttlSec) || 0);
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (path === "/api/dispatch/reclaim" && req.method === "POST") {
      // 手动回收：agent 进程崩了没人来释放，人点一下清掉。
      // 为什么必须有这个：TTL 到期前同区域会被一直挡着，而「确认它死了」只有人能做。
      const body = await readJson(req);
      const r = await fileLocks.forceRelease(String(body.lockId || ""), String(body.why || "手动回收"));
      return sendJson(res, r.ok ? 200 : 404, r);
    }

    // 把 agent 报的「要改哪些文件」写回台账（2026-11-22）。
    //
    // 这是 `files` 字段的**唯一实际来源** —— 在此之前台账里 66 条卡一条都没有它，
    // 于是依赖图那套永远没有输入。让每次报意图都顺手写回去，
    // 数据才会越攒越多，自动分组才有依据。
    if (path === "/api/intent/files" && req.method === "POST") {
      const body = await readJson(req);
      const id = String(body.id || "").trim();
      if (!id) return sendJson(res, 400, { ok: false, error: "缺卡片 id" });
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return sendJson(res, 400, { ok: false, error: "files 为空，不写（免得把已有清单清掉）" });
      const w = createLedgerWriter({
        ledgerPath: LEDGER,
        loadConfig: () => JSON.parse(readFileSync(join(ROOT, "board.config.json"), "utf8")),
      });
      const r = await w.setFiles(id, files, { by: String(body.by || "") });
      // 顺带把 willUse 也记进台账：下次判冲突能用上，不用再问 agent 一遍
      if (r.ok && Array.isArray(body.willUse) && body.willUse.length) {
        try {
          const led = JSON.parse(readFileSync(LEDGER, "utf8"));
          const it = (led.items || []).find((x) => x && x.id === id);
          if (it) {
            it.willUse = body.willUse.map((x) => String(x).trim().replace(/\\/g, "/")).filter(Boolean);
            atomicWriteJson(LEDGER, led);
          }
        } catch { /* willUse 只是锦上添花，写不进去不影响主流程 */ }
      }
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // 工作台：分析选中条目，给出串行 / 并行两种编排建议。
    // 纯计算（planWorkbench），不领活、不改状态 —— 用户确认后才开始真跑。
    if (path === "/api/workbench/analyze" && req.method === "POST") {
      const payload = await readJson(req);
      const ids = Array.isArray(payload.ids) ? payload.ids.map((x) => String(x).trim()).filter(Boolean) : [];
      const order = Array.isArray(payload.order)
        ? payload.order.map((x) => String(x).trim()).filter(Boolean)
        : [];
      // 看板手动分批（整批交给 Agent 自主）：批次是用户定的，引擎不自动拆串/并行。
      const batches = Array.isArray(payload.batches) ? payload.batches : null;
      if (!ids.length) return sendJson(res, 400, { ok: false, error: "请至少选中一件" });
      let ledger, config;
      try {
        ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
        config = JSON.parse(readFileSync(join(ROOT, "board.config.json"), "utf8"));
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "台账/配置读不动：" + String((e && e.message) || e) });
      }
      if (batches && batches.length) {
        // 分批模式：直接返回批次的元数据，不再产出 serial/parallel 自动建议。
        return sendJson(res, 200, planBatches(config, ledger, batches));
      }
      return sendJson(res, 200, planWorkbench(config, ledger, new Set(ids), order));
    }

    if (path === "/api/evidence/stale" && req.method === "GET") {
      let ledger = null;
      try {
        ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "台账读不动：" + String((e && e.message) || e) });
      }
      return sendJson(res, 200, evidenceFreshness(projectDirOf(), ledger));
    }

    if (path === "/api/evidence/file" && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const r = lookAtFile(projectDirOf(), u.searchParams.get("path") || "", u.searchParams.get("hint") || "");
      return sendJson(res, r.ok ? 200 : 404, r);
    }

    if (path === "/api/evidence/commit" && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const r = lookAtCommit(projectDirOf(), u.searchParams.get("hash") || "");
      return sendJson(res, r.ok ? 200 : 404, r);
    }

    if (path === "/api/report/boards" && req.method === "GET") {
      // 注册表是唯一真相源（插件的「看板管理」维护它）。三处按权威度依次试。
      const home = process.env.DSH_HOME || "";
      const candidates = [
        process.env.OPS_BOARDS_JSON || "",
        home ? join(home, "ops-board", "boards.json") : "",
        join(TEMPLATE_ROOT, "data", "boards.json"),
      ].filter(Boolean);

      let raw = null;
      let registry = "";
      for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
          const j = JSON.parse(readFileSync(p, "utf8"));
          if (Array.isArray(j.boards) && j.boards.length) {
            raw = j.boards;
            registry = p;
            break;
          }
        } catch {
          // 这份坏了就试下一份，别让整个列表不可用
        }
      }

      const list = (raw || [])
        .filter((b) => b && b.dir && existsSync(join(b.dir, "ledger.json")))
        .map((b) => {
          let label = b.label || b.id;
          let updatedAt = "";
          let items = 0;
          try {
            const l = JSON.parse(readFileSync(join(b.dir, "ledger.json"), "utf8"));
            label = (l.project && l.project.name) || label;
            updatedAt = l.updatedAt || "";
            items = (l.items || []).length;
          } catch {
            // 台账读不动就退回注册表里的名字
          }
          return { id: b.id, label, dir: b.dir, updatedAt, items, current: b.dir === ROOT };
        });

      // 注册表读不到（换了机器、DSH_HOME 没传下来、文件被移走）时，
      // 退一步扫同级目录：只要有 ledger.json 就当一块板。
      // 不这么做的话列表里只剩当前这一块，用户会以为「只能导一块」——
      // 实际是注册表没读到，而不是别人的板不存在。
      if (!list.length) {
        const parent = dirname(ROOT);
        let kids = [];
        try {
          kids = readdirSync(parent, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          // 父目录读不了就保持空
        }
        for (const name of kids) {
          const dir = join(parent, name);
          if (!existsSync(join(dir, "ledger.json"))) continue;
          if (dir === ROOT) continue;
          let label = name;
          let updatedAt = "";
          let items = 0;
          try {
            const l = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
            label = (l.project && l.project.name) || label;
            updatedAt = l.updatedAt || "";
            items = (l.items || []).length;
          } catch {
            // 读不动就用目录名
          }
          list.push({ id: name, label, dir, updatedAt, items, current: false });
        }
      }

      // 当前板一律补进来 —— 它是"眼前这块"，不管注册表有没有收录都得能导。
      if (!list.some((b) => b.current)) {
        let label = basename(ROOT);
        let updatedAt = "";
        let items = 0;
        try {
          const l = JSON.parse(readFileSync(LEDGER, "utf8"));
          label = (l.project && l.project.name) || label;
          updatedAt = l.updatedAt || "";
          items = (l.items || []).length;
        } catch {
          // 名字取不到就用目录名
        }
        list.unshift({ id: basename(ROOT), label, dir: ROOT, updatedAt, items, current: true });
      }

      return sendJson(res, 200, {
        ok: true,
        boards: list,
        current: basename(ROOT),
        registry,
        error: list.length ? undefined : "没找到看板注册表",
      });
    }

    if (path === "/api/report/export" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const mode = ["daily", "weekly", "monthly", "all"].includes(body.mode) ? body.mode : "weekly";
        const boards = Array.isArray(body.boards) ? body.boards.filter(Boolean) : [];
        const formats = (
          Array.isArray(body.formats) && body.formats.length ? body.formats : ["md", "html", "txt"]
        ).filter((f) => ["md", "html", "txt"].includes(f));
        if (!boards.length) return sendJson(res, 400, { ok: false, error: "请至少选一个看板" });
        if (!formats.length) return sendJson(res, 400, { ok: false, error: "请至少选一种格式" });

        const args = [REPORT, "--" + mode, "--boards", boards.join(","), "--format", formats.join(",")];
        if (body.out) args.push("--out", String(body.out));
        if (body.split) args.push("--split");

        // 报表脚本把机器可读回执打在 stdout 第一行，这里原样收下来解析。
        const out = execFileSync(process.execPath, args, {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });

        const firstLine = String(out).split(/\r?\n/)[0] || "";
        const marker = firstLine.startsWith("REPORT_OK ") ? firstLine.slice("REPORT_OK ".length) : "";
        let result = null;
        try {
          result = marker ? JSON.parse(marker) : null;
        } catch {
          result = null;
        }
        return sendJson(res, 200, { ok: true, result, log: String(out) });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.stderr || e.message || e).slice(0, 2000) });
      }
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
