// 验证顶栏那两个新入口：搜索（Ctrl+F）与设置。
//
// 搜索这块真正要证明的不是「面板能弹出来」，而是三件事：
//   ① 命中的是条目本身（编号 / 标题 / 正文 / 证据 / 领域），不是页面上现成的文字；
//   ② 结果按条目分组，命中处能看出是在哪个字段；
//   ③ 点结果能切到那一条所在的视图并滚过去，收起来的卡片要自动展开。
// 设置这块要证明「改完立刻生效 + 重载还在 + 恢复默认/清空真的清掉」。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const ROOT = resolve(arg("board") || join(HERE, ".."));
const OUT = join(ROOT, ".uitest");

const EDGE = [
  "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe",
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  process.exit(1);
}
const PAGE = join(ROOT, "dist", "index.html");
if (!existsSync(PAGE)) {
  console.error("没有 dist/index.html");
  process.exit(1);
}
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const profile = join(OUT, "profile-find-" + Date.now().toString(36));
mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--allow-file-access-from-files",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--window-size=1200,900", "about:blank",
  ],
  { stdio: "ignore" }
);

let port = 0;
for (let i = 0; i < 60; i++) {
  const marker = join(profile, "DevToolsActivePort");
  if (existsSync(marker)) {
    const txt = readFileSync(marker, "utf8").split(/\r?\n/);
    if (txt[0] && Number(txt[0]) > 0) { port = Number(txt[0]); break; }
  }
  await sleep(200);
}

let target;
if (port) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(250);
  }
}
if (!target) {
  edge.kill();
  console.error("连不上调试端口");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
let seq = 0;
const wait = new Map();
const crashes = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    crashes.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
  }
  if (m.id && wait.has(m.id)) {
    wait.get(m.id)(m.result);
    wait.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    wait.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

const BOARD_ID = ROOT.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__OPS_HARNESS__ = {
      id: ${JSON.stringify(BOARD_ID)},
      dir: ${JSON.stringify(ROOT.replace(/\\/g, "/"))},
      label: ${JSON.stringify(BOARD_ID)}
    };
    const rf = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/ops-board/ask') === 0) {
        try { window.__ASK_ID = JSON.parse(opts.body).askId; } catch (e) {}
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, askId: window.__ASK_ID }) });
      }
      return rf.apply(window, arguments);
    };
  `,
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

const BASE = pathToFileURL(PAGE).href;
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.querySelector('#finder') && !!document.querySelector('#settings')")) return true;
    await sleep(200);
  }
  return false;
};
const reload = async () => {
  await send("Page.navigate", { url: BASE });
  await sleep(500);
  return ready();
};

await send("Page.navigate", { url: BASE });
if (!(await ready())) {
  console.error("页面没起来：#finder / #settings 不存在");
  ws.close(); edge.kill(); process.exit(1);
}

// 清掉上一次跑留下的偏好，保证起点干净
await ev(`(() => {
  const drop = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.indexOf('ops-board-') === 0 || k.indexOf('ops-mini-') === 0)) drop.push(k);
  }
  drop.forEach((n) => localStorage.removeItem(n));
  return drop.length;
})()`);
await send("Page.navigate", { url: BASE });
await ready();

const finderOpen = () => ev(`document.querySelector('#finder').classList.contains('is-open')`);
const settingsOpen = () => ev(`document.querySelector('#settings').classList.contains('is-open')`);
const hitCtrlF = () =>
  ev(`(() => {
    const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
const typeQuery = async (q) => {
  await ev(`(() => {
    const i = document.querySelector('#finder-input');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
};
const groupCount = () => ev(`document.querySelectorAll('#finder-results .finder-group').length`);
const hitCount = () => ev(`document.querySelectorAll('#finder-results .finder-hit').length`);
const countText = () => ev(`(document.querySelector('#finder-count')||{}).textContent || ''`);

// 台账数据直接从页面上读，用来构造「一定命中 / 一定不命中」的查询词。
// 注意 sections 里带着【具体表现】这类小标题，搜索时会先把小标题剥掉，
// 所以挑词也必须先剥掉它们，不然挑出来的词是永远搜不到的。
const sample = await ev(`(() => {
  const bd = JSON.parse(document.getElementById('board-data').textContent);
  const keys = Object.keys(bd.items);
  const id = keys[0];
  const it = bd.items[id];
  const plain = String(it.title || '') + ' ' + String(it.area || '') + ' ' + String(it.evidence || '') + ' ' + id;
  const bare = String(it.sections || '').replace(/【[^】]{1,14}】/g, ' ');
  let bodyWord = '';
  const runs = bare.match(/[\\u4e00-\\u9fa5]{4,}/g) || [];
  for (const r of runs) {
    const w = r.slice(0, 4);
    if (plain.indexOf(w) < 0) { bodyWord = w; break; }
  }
  // 标题里的第一个词，用来验证「按标题搜」时标题行本身会高亮
  const tm = String(it.title || '').match(/[\\u4e00-\\u9fa5]{2,6}/);
  const titleWord = tm ? tm[0] : '';
  return { id, title: it.title || '', titleWord, bodyWord, bare: bare.slice(0, 60), total: keys.length, lane: it.laneLabel || '' };
})()`);
check("能读到台账数据", !!sample && !!sample.id, `样例 ${sample.id} · 共 ${sample.total} 条`);
check("找到正文里独有的词（用于测搜索范围）", !!sample.bodyWord, `"${sample.bodyWord}"`);

// ── 顶栏入口 ──
check("顶栏有「搜索」按钮", (await ev(`!!document.querySelector('#finder-open')`)) === true);
check("顶栏有「设置」按钮", (await ev(`!!document.querySelector('#settings-open')`)) === true);
check("初始搜索层是收起的", (await finderOpen()) === false);
check("初始设置层是收起的", (await settingsOpen()) === false);

// ── Ctrl+F ──
const prevented = await hitCtrlF();
await sleep(150);
check("Ctrl+F 唤出搜索层", (await finderOpen()) === true);
check("Ctrl+F 拦掉了浏览器自带查找", prevented === true);
check("唤出后光标在输入框里", (await ev(`document.activeElement === document.querySelector('#finder-input')`)) === true);
check("还没输入时给出提示", /条/.test(String(await ev(`(document.querySelector('#finder-results')||{}).textContent||''`))), String(await ev(`(document.querySelector('#finder-results')||{}).textContent||''`)).slice(0, 40));

await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(150);
check("Esc 收起搜索层", (await finderOpen()) === false);

// ── 按编号搜：应当正好命中那一条 ──
await ev(`document.querySelector('#finder-open').click()`);
await sleep(150);
check("点顶栏「搜索」也能打开", (await finderOpen()) === true);

await typeQuery(sample.id);
const g1 = await groupCount();
const c1 = String(await countText());
check("搜编号正好命中 1 条", g1 === 1, `命中 ${g1} 条`);
check("计数文案写着条数与命中处", /\d+\s*条/.test(c1) && /命中/.test(c1), c1);

const firstId = await ev(`(document.querySelector('#finder-results .finder-id')||{}).textContent||''`);
check("结果里显示了编号", firstId === sample.id, firstId);
const markCount = await ev(`document.querySelectorAll('#finder-results .finder-snip b, #finder-results .finder-title b').length`);
check("命中的词被高亮成 <b>", markCount > 0, `${markCount} 处`);
const whereText = await ev(`(document.querySelector('#finder-results .finder-where')||{}).textContent||''`);
check("每条命中标了所在字段", whereText.length > 0, whereText);
// 标题不单独占一行：分组头已经把标题（带高亮）显示了，
// 再来一行「标题 …同一句话」等于把标题念两遍。
const titleRows = await ev(`[...document.querySelectorAll('#finder-results .finder-where')].filter(e => e.textContent === '标题').length`);
check("标题不会在命中行里重复一遍", titleRows === 0, `${titleRows} 行`);
// 按编号搜的时候，编号本身该亮起来，否则看不出是为啥命中
const idHighlighted = await ev(`document.querySelectorAll('#finder-results .finder-id b').length`);
check("按编号搜时编号会高亮", idHighlighted > 0, `${idHighlighted} 处`);

// 改用标题里的词搜：分组头要把标题里的命中词亮出来，且仍然不重复成一行
if (sample.titleWord) {
  await typeQuery(sample.titleWord);
  const headHl = await ev(`document.querySelectorAll('#finder-results .finder-title b').length`);
  check("按标题搜时标题行高亮命中词", headHl > 0, `${headHl} 处`);
  const stillNoTitleRow = await ev(`[...document.querySelectorAll('#finder-results .finder-where')].filter(e => e.textContent === '标题').length`);
  check("按标题搜也不会多出一行「标题」", stillNoTitleRow === 0, `${stillNoTitleRow} 行`);
}

// ── 正文命中：搜正文里独有的词 ──
if (sample.bodyWord) {
  await typeQuery(sample.bodyWord);
  const g2 = await groupCount();
  check("正文里的词也能搜到", g2 >= 1, `命中 ${g2} 条`);
  const bodyWhere = await ev(`(() => {
    const w = document.querySelectorAll('#finder-results .finder-where');
    for (const el of w) {
      if (el.textContent && el.textContent.indexOf('标题') < 0 && el.textContent.indexOf('编号') < 0) return el.textContent;
    }
    return '';
  })()`);
  check("正文命中标的是正文块名而不是「标题」", bodyWhere.length > 0, bodyWhere);
}

// ── 搜不到时的提示 ──
await typeQuery("zzz-没有这个词-qqq");
check("搜不到时条数为 0", (await groupCount()) === 0);
check("搜不到时给出可操作提示", /没搜到/.test(String(await ev(`(document.querySelector('#finder-results')||{}).textContent||''`))));

// ── 回车跳转 + 收起卡片自动展开 ──
await ev(`(() => {
  const c = document.getElementById(${JSON.stringify(sample.id)});
  if (c && c.tagName === 'DETAILS' && c.open) c.open = false;
  return true;
})()`);
const collapsedBefore = await ev(`(() => { const c = document.getElementById(${JSON.stringify(sample.id)}); return c ? c.open : null; })()`);

await typeQuery(sample.id);
await ev(`(() => {
  const i = document.querySelector('#finder-input');
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(700);
check("回车后搜索层收起", (await finderOpen()) === false);
check("回车后跳到那条的锚点", (await ev(`location.hash`)) === "#" + sample.id, String(await ev(`location.hash`)));
check("路面落在了这条所在的视图里", (await ev(`(() => {
  const c = document.getElementById(${JSON.stringify(sample.id)});
  return !!(c && c.closest('.view') && c.closest('.view').classList.contains('is-active'));
})()`)) === true);
if (collapsedBefore === false) {
  check("跳到被收起的卡片会自动展开", (await ev(`document.getElementById(${JSON.stringify(sample.id)}).open`)) === true);
} else {
  console.log("（样例卡片不是 <details>，跳过自动展开一项）");
}

// ── 点结果也能跳 ──
await ev(`document.querySelector('#finder-open').click()`);
await sleep(150);
await typeQuery(sample.id);
await ev(`document.querySelector('#finder-results .finder-hit').click()`);
await sleep(600);
check("点命中行也能跳过去", (await ev(`location.hash`)) === "#" + sample.id, String(await ev(`location.hash`)));
check("点完搜索层收起", (await finderOpen()) === false);

// ── 搜索范围：只搜标题时，正文里独有的词应当搜不到 ──
if (sample.bodyWord) {
  await ev(`document.querySelector('#settings-open').click()`);
  await sleep(150);
  check("点顶栏「设置」打开设置层", (await settingsOpen()) === true);
  await ev(`(() => {
    const s = document.querySelector('#set-scope');
    s.value = 'title';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await ev(`document.querySelector('#settings-close').click()`);
  await sleep(150);
  await ev(`document.querySelector('#finder-open').click()`);
  await sleep(150);
  await typeQuery(sample.bodyWord);
  check("范围改成「只搜标题」后正文词搜不到", (await groupCount()) === 0, `命中 ${await groupCount()} 条`);
  await typeQuery(sample.id);
  check("但编号照样能搜到", (await groupCount()) === 1, `命中 ${await groupCount()} 条`);

  // 改回「全部字段」，验证设置是即时生效的，不用重启
  await ev(`(() => {
    const s = document.querySelector('#set-scope');
    s.value = 'all';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await typeQuery(sample.bodyWord);
  check("改回「全部字段」后立刻又能搜到", (await groupCount()) >= 1, `命中 ${await groupCount()} 条`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(100);
}

// ── 设置：字号 ──
const bodyFs = () => ev(`parseFloat(getComputedStyle(document.body).fontSize)`);
const fsBase = await bodyFs();
check("默认正文字号 16px", Math.abs(fsBase - 16) < 0.2, `${fsBase}px`);
await ev(`document.querySelector('#settings-open').click()`);
await sleep(150);
await ev(`document.querySelector('#set-font button[data-value="19"]').click()`);
await sleep(150);
const fsBig = await bodyFs();
check("点「特大」正文立刻变大", Math.abs(fsBig - 19) < 0.3, `${fsBase}px → ${fsBig}px`);
check("正文变大时编号字号不变", (await ev(`parseFloat(getComputedStyle(document.querySelector('.card .id') || document.querySelector('.id')).fontSize)`)) < 12);
check("「特大」按钮标记为选中", (await ev(`document.querySelector('#set-font button[data-value="19"]').classList.contains('is-active')`)) === true);

check("重载后就绪（字号）", await reload());
const fsAfter = await bodyFs();
check("重载后字号还是特大", Math.abs(fsAfter - 19) < 0.3, `${fsAfter}px`);

// ── 设置：主题 ──
await ev(`document.querySelector('#settings-open').click()`);
await sleep(150);
await ev(`document.querySelector('#set-theme button[data-value="paper"]').click()`);
await sleep(150);
check("点「纸面」立刻换主题", (await ev(`document.documentElement.getAttribute('data-theme')`)) === "paper");
check("顶栏色块也跟着变选中", (await ev(`(document.querySelector('.theme-swatch[data-theme="paper"]')||{className:''}).className.indexOf('is-active') >= 0`)) === true);
check("重载后就绪（主题）", await reload());
check("重载后主题还是纸面", (await ev(`document.documentElement.getAttribute('data-theme')`)) === "paper");

// ── 设置：侧栏 ──
await ev(`document.querySelector('#settings-open').click()`);
await sleep(150);
await ev(`document.querySelector('#set-rail button[data-value="1"]').click()`);
await sleep(200);
check("点「收起」侧栏收起来", (await ev(`document.querySelector('.page').classList.contains('rail-collapsed')`)) === true);
await ev(`document.querySelector('#set-rail button[data-value="0"]').click()`);
await sleep(200);
check("点「展开」侧栏回来", (await ev(`document.querySelector('.page').classList.contains('rail-collapsed')`)) === false);

// ── 设置：默认打开哪一页（没有停留记录时才生效）──
await ev(`(() => {
  const s = document.querySelector('#set-view');
  s.value = 'lane:bug';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await ev(`(() => {
  const drop = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf('ops-board-route:') === 0) drop.push(k);
  }
  drop.forEach((n) => localStorage.removeItem(n));
  return drop.length;
})()`);
await ev(`document.querySelector('#settings-close').click()`);
await send("Page.navigate", { url: BASE });
await sleep(600);
await ready();
check("没有停留记录时打开设置里指定的页", (await ev(`(document.querySelector('.view.is-active')||{dataset:{}}).dataset.view`)) === "lane-bug", String(await ev(`(document.querySelector('.view.is-active')||{dataset:{}}).dataset.view`)));
check("跳过去之后 URL 也带了这一页的锚点", (await ev(`location.hash`)) === "#view-lane-bug", String(await ev(`location.hash`)));

// ── 恢复默认 ──
await ev(`document.querySelector('#settings-open').click()`);
await sleep(150);
await ev(`document.querySelector('#set-reset').click()`);
await sleep(300);
check("恢复默认：字号回到 16px", Math.abs((await bodyFs()) - 16) < 0.2, `${await bodyFs()}px`);
check("恢复默认：主题回到夜晚", (await ev(`document.documentElement.getAttribute('data-theme')`)) === "night");
check("恢复默认：侧栏回到展开", (await ev(`document.querySelector('.page').classList.contains('rail-collapsed')`)) === false);
check("恢复默认：默认页回到「跟着上次」", (await ev(`document.querySelector('#set-view').value`)) === "");
check("恢复默认：搜索范围回到全部字段", (await ev(`document.querySelector('#set-scope').value`)) === "all");
const noteText = () => ev(`(document.querySelector('#set-note')||{}).textContent||''`);
check("恢复默认给了回执文案", /已恢复默认/.test(String(await noteText())), String(await noteText()).slice(0, 30));

// ── 清空本机偏好：要两次确认 ──
const lsCount = () => ev(`(() => {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.indexOf('ops-board-') === 0 || k.indexOf('ops-mini-') === 0)) n++;
  }
  return n;
})()`);
await ev(`(() => {
  localStorage.setItem('ops-board-chat:${BOARD_ID}:__global__', '[{"role":"user","text":"x"}]');
  localStorage.setItem('ops-mini-whatever', '1');
  return true;
})()`);
const beforeClear = await lsCount();
check("清空前本机确实有偏好记录", beforeClear > 0, `${beforeClear} 个键`);

await ev(`document.querySelector('#set-clear').click()`);
await sleep(150);
check("第一次点「清空」只是进入确认态", (await ev(`document.querySelector('#set-clear').textContent`)).indexOf("确认") >= 0, String(await ev(`document.querySelector('#set-clear').textContent`)));
check("确认态下什么都没删", (await lsCount()) === beforeClear, `${await lsCount()} 个键`);

await ev(`document.querySelector('#set-clear').click()`);
await sleep(300);
check("第二次点才真的清空", (await lsCount()) === 0, `剩 ${await lsCount()} 个键`);
check("清空后按钮文案复原", (await ev(`document.querySelector('#set-clear').textContent`)).indexOf("确认") < 0, String(await ev(`document.querySelector('#set-clear').textContent`)));
check("清空后字号回到默认", Math.abs((await bodyFs()) - 16) < 0.2, `${await bodyFs()}px`);
check("清空后主题回到夜晚", (await ev(`document.documentElement.getAttribute('data-theme')`)) === "night");
check("清空给了回执文案", /已清空/.test(String(await noteText())), String(await noteText()).slice(0, 30));

check("重载后就绪（清空后）", await reload());
check("清空后重载仍是默认字号", Math.abs((await bodyFs()) - 16) < 0.2, `${await bodyFs()}px`);

// ── 关掉 Ctrl+F 快捷键后，浏览器自带的查找要还回去 ──
await ev(`document.querySelector('#settings-open').click()`);
await sleep(150);
await ev(`(() => {
  const b = document.querySelector('#set-hotkey');
  b.checked = false;
  b.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#settings-close').click();
  return true;
})()`);
await sleep(150);
const prevented2 = await hitCtrlF();
await sleep(150);
check("关掉快捷键后 Ctrl+F 不再唤出搜索层", (await finderOpen()) === false);
check("关掉后也不再拦浏览器自带查找", prevented2 === false);
check("但顶栏「搜索」照旧能用", (await ev(`(() => { document.querySelector('#finder-open').click(); return document.querySelector('#finder').classList.contains('is-open'); })()`)) === true);

if (crashes.length) {
  console.log("\n页面异常：");
  for (const c of crashes.slice(0, 5)) console.log("  " + String(c).split("\n")[0]);
  check("无未捕获异常", false, `${crashes.length} 个`);
} else {
  check("无未捕获异常", true);
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${fails.length === 0 ? "自检通过" : "有 " + fails.length + " 项没过"}：${results.length} 项`);
ws.close();
edge.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fails.length === 0 ? 0 : 1);
