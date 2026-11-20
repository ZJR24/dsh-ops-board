// scripts/lib/client.js — 页面里的全部交互。由 render.mjs 原样内联进 HTML。
// 说明：这个文件不经过模板求值，所以可以放心用模板字符串。

(function () {
  "use strict";

  var D = JSON.parse(document.getElementById("board-data").textContent);

  // 同一个页面有两种活法：
  //   ① 看板整页（默认）—— 顶栏、导航、台账、对话框都在里面；
  //   ② 只当对话框（?chat=1）—— 被 Harness 用一个独立的小 iframe 单独加载，
  //      只留对话框本身，位置/大小/置顶由外面那层窗口管。
  // 判据写在 <html data-chat> 上，由 render.mjs 在 <head> 里最早设好，
  // 这样 CSS 首帧就生效，不会先闪一下整页再变成对话框。
  // 用途见 css.mjs 末尾那段 html[data-chat="1"] 规则。
  var CHAT_ONLY = document.documentElement.getAttribute("data-chat") === "1";

  // 这一份页面是哪个「窗口」。回答是广播回来的（插件那边拿不到发问窗口的引用，
  // 只能朝所有 iframe 投），所以必须自报家门才能各收各的。
  // 不区分的话：从独立对话窗提问，主看板那边会因为认不出 askId 而补一条
  // 「迟到」气泡，同一轮问答在两个窗口各留一份、还各写一遍本地记录。
  var SURFACE = CHAT_ONLY ? "chat" : "page";

  // 独立窗口里要接着聊哪一条。看板点「弹窗」时把当前作用域一起带过来
  // （通过 ?scope=），这样窗口里显示的是同一条对话，而不是从空白开始。
  var CHAT_SCOPE = "";
  if (CHAT_ONLY) {
    try {
      CHAT_SCOPE = new URLSearchParams(location.search).get("scope") || "";
    } catch (e) {
      CHAT_SCOPE = "";
    }
  }
  // 由 dsh-ops-board 注入：看板 id / 目录 / 项目目录，发送时一并发过去。
  // 这块板的「问 AI」只有一条路 —— 交给 Harness 会话。
  //
  // 必须每次现读，不能抓一次存起来：脚本可能在 __OPS_HARNESS__ 注入之前就跑完了
  // （iframe 先加载、插件后注入），那样存下来的是 null，之后永远读不到，
  // 面板会一直说「这块板要在 Harness 里打开才能问 AI」。
  function harnessEnv() {
    return window.__OPS_HARNESS__ || null;
  }

  // ── 这个页面现在活在哪儿 ──────────────────────────────────────────
  //
  //   ① Harness 面板的 iframe 里：插件是父窗口，postMessage 直连就够；
  //   ② 系统浏览器窗口里（脱离 Harness 窗口）：源是 http://127.0.0.1:<端口>，
  //      和插件外壳 dsh-app://app 不同源，postMessage / BroadcastChannel 都过不去。
  //
  // ② 这种情况只能借看板自己的 HTTP 服务过河 —— 见 serve.mjs 的 /api/relay/*。
  // 判断依据是「有没有父窗口」：同一份页面被 iframe 加载时一定有。
  function inFrame() {
    try {
      return !!(window.parent && window.parent !== window);
    } catch (e) {
      return false;
    }
  }

  // 中转的绝对路径。
  //
  // 为什么不写相对的 "api/relay/answers"：EventSource 不经过宿主注入的 fetch 改写
  // （那条改写只认 fetch，且只认 "/api/" 开头），相对路径会解析到错误的地方。
  // 经 Harness 代理打开时 __OPS_HARNESS__ 里带着看板 id，据此拼出代理前缀；
  // 由看板服务直接托管时没有这个对象，用根路径。
  function relayUrl(name) {
    var env = harnessEnv();
    if (env && env.id) return "/ops-board/b/" + env.id + "/api/relay/" + name;
    return "/api/relay/" + name;
  }

  function relayPost(name, payload) {
    try {
      fetch(relayUrl(name), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(function () {});
    } catch (e) {}
  }

  // 把一条请求交给插件。
  //
  // 在 iframe 里就是 postMessage（老路，最快）；在独立窗口里没有父窗口，
  // 改成 POST 到中转，插件从 /api/relay/reqs 那侧收。
  function postToHost(payload) {
    if (inFrame()) {
      try {
        window.parent.postMessage(payload, window.location.origin);
        return true;
      } catch (e) {
        // 跨源被拒（理论上不会）时退回中转。
      }
    }
    relayPost("req", payload);
    return true;
  }

  // 独立窗口：订阅中转回来的回答 / 回包。
  //
  // 收到之后不另写一套分发，直接丢回本页的 message 事件 —— 下面那些
  // HISTORY_WAIT、会话列表的监听本来就按 message 写，一行都不用改，
  // 也不会出现「iframe 一套逻辑、独立窗另一套」的分裂。
  var RELAY_SEEN = {};
  function startRelay() {
    if (inFrame()) return;
    if (typeof EventSource === "undefined") return;
    var source = new EventSource(relayUrl("answers"));
    source.onmessage = function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!data || !data.type) return;
      // 服务端在订阅时会重放最近几条，别把上一轮的回答当新回答再画一遍。
      var key = String(data.askId || data.reqId || "");
      if (key) {
        if (RELAY_SEEN[key]) return;
        RELAY_SEEN[key] = 1;
      }
      try {
        window.postMessage(data, window.location.origin);
      } catch (e) {}
    };
    // 断开（看板重启、插件重载）时 EventSource 自己会重连，这里不插手。
    source.onerror = function () {};
  }

  // ── 浏览器能打开的源 ────────────────────────────────────────────
  //
  // 在 Harness 面板里，本页的源是 dsh-app://app —— Electron 的自定义协议，
  // 只有 Harness 自己认识。拿它去 window.open，系统浏览器打不开。
  // 真正能交给浏览器的是 Harness 的 HTTP 源，/ops-board/state 的 origin 字段就是。
  //
  // 结果要缓存：window.open 必须落在点击的手势里，否则会被当弹窗拦掉；
  // 而问 origin 是异步的。所以进页面就先把这一问发出去，点的时候直接拿。
  var HTTP_ORIGIN = "";

  function originUsable(origin) {
    return /^https?:\/\/[^/]+$/i.test(String(origin || ""));
  }

  function fetchHttpOrigin(done) {
    if (HTTP_ORIGIN) return done(HTTP_ORIGIN);
    // 由看板服务直接托管时（http://127.0.0.1:<端口>/），本页的源本身就能开。
    if (originUsable(location.origin)) {
      HTTP_ORIGIN = location.origin;
      return done(HTTP_ORIGIN);
    }
    var settled = false;
    var finish = function (value) {
      if (settled) return;
      settled = true;
      if (originUsable(value)) HTTP_ORIGIN = String(value).replace(/\/+$/, "");
      done(HTTP_ORIGIN);
    };
    try {
      fetch("/ops-board/state", { cache: "no-store" })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          finish(j && j.origin);
        })
        .catch(function () {
          finish("");
        });
      setTimeout(function () {
        finish("");
      }, 4000);
    } catch (e) {
      finish("");
    }
  }

  // ─────────────────────── 工具 ───────────────────────

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 极简渲染：只认粗体、行内代码、换行。够用，且不会把模型输出当 HTML 执行。
  function renderText(s) {
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    return out;
  }

  function $(id) {
    return document.getElementById(id);
  }

  // ─────────────────────── 路由 ───────────────────────

  // 记住「上次停在哪」，供页面重新加载时恢复。
  //
  // 为什么需要：Harness 面板里的 iframe 会在切走/切回时被整个销毁重建
  // （React key 变化 + 面板卸载），重挂载时 src 不带 hash。这时 route() 看到
  // 空 hash 就 show("overview")，用户点了「问 AI」跳去会话、再返回看板，
  // 就落回总览——明明刚才在看某条 bug。
  //
  // 所以把当前视图存进 localStorage，hash 为空时用它兜底。
  // 存的是 hash 原文（view-xxx / stage-lane / 条目 id 都按原样存），
  // 恢复时走同一条 route 逻辑，行为与正常点击一致。
  // 键要按看板分开：所有看板都同源（都走 /ops-board/b/<id>/ 代理），
  // 共用一个键的话，A 看板的落点会被恢复进 B 看板。用 pathname 做前缀。
  function routeKey() {
    var path = "/";
    try {
      path = location.pathname || "/";
    } catch {}
    return "ops-board-route:" + path;
  }

  function saveRoute(hash) {
    try {
      var clean = String(hash || "").replace(/^#/, "");
      if (!clean) return; // 空 hash 不覆盖上一次的落点
      window.localStorage.setItem(routeKey(), clean);
    } catch {}
  }

  function restoreRoute() {
    try {
      return window.localStorage.getItem(routeKey()) || "";
    } catch {
      return "";
    }
  }

  function forgetRoute() {
    try {
      window.localStorage.removeItem(routeKey());
    } catch {}
  }

  var ITEM_VIEW = {};
  Array.prototype.forEach.call(document.querySelectorAll(".card[id]"), function (c) {
    var view = c.closest(".view");
    if (view) ITEM_VIEW[c.id] = view.dataset.view;
  });

  // 工作台是单实例节点：整站只有一份，切视图时搬到当前视图的挂载点。
  // 为什么搬而不是各页复制一份：工作台带运行状态（WB.run / order / 进度），
  // 复制出第二份就成了永远不动的死壳，且 querySelector 会取到先出现的那份。
  // 搬家 = 同一个 DOM 节点 appendChild，事件与状态都不丢。
  function mountWorkbench(viewEl) {
    var wb = document.querySelector("[data-workbench]") || WB_NODE;
    if (!wb) return;
    WB_NODE = wb;
    var target = viewEl ? viewEl.querySelector("[data-wb-mount]") : null;
    if (!target) {
      // 当前视图没有挂载点（如问题页 / Skill 页）：把工作台收进隐藏暂存区，
      // 别让它挂在别人页面里。⚠️ 不能从文档里摘掉——摘了之后 querySelector 找不到它，
      // 切回来就再也挂不上了。暂存区是挂在 body 下的隐藏节点，节点本身不掉线、状态全在。
      target = parkEl();
      if (!target) return;
    }
    if (wb.parentNode !== target) target.appendChild(wb);
  }

  var WB_NODE = null;
  function parkEl() {
    var p = document.getElementById("wb-park");
    if (!p) {
      p = document.createElement("div");
      p.id = "wb-park";
      p.hidden = true;
      p.setAttribute("aria-hidden", "true");
      document.body.appendChild(p);
    }
    return p;
  }

  function show(viewKey, scrollTop) {
    var id = "view-" + String(viewKey).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    var target = document.getElementById(id);
    if (!target) return false;
    Array.prototype.forEach.call(document.querySelectorAll(".view"), function (v) {
      v.classList.remove("is-active");
    });
    target.classList.add("is-active");
    Array.prototype.forEach.call(document.querySelectorAll(".nav a[data-view]"), function (a) {
      a.classList.toggle("active", a.getAttribute("href") === "#" + id);
    });
    // 宽视图：把左侧索引栏让出来，内容占满整宽。
    // 判据写在 DOM 上（data-wide-view），不在这里硬编码视图名 ——
    // 以后再加宽视图不用改这段。
    // 2026-11-18：原先是给工作流页用的（画布要横向铺开看链条），那个页面已删除；
    // 这套机制保留，任何需要整宽的视图只要在模板里加 data-wide-view 即可。
    var layout = document.querySelector(".layout");
    if (layout) {
      layout.classList.toggle("is-wide", target.hasAttribute("data-wide-view"));
    }
    mountWorkbench(target);
    if (scrollTop) window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  // 视图刚切过来时元素还没排完版，立刻量位置会量到 display:none 时的 0。
  // 等两帧再量，跨视图跳转才落得准。
  function nextFrame(fn) {
    requestAnimationFrame(function () {
      requestAnimationFrame(fn);
    });
  }

  // 跳过去的那个落点要看得出来，否则用户不知道视线该放哪
  function flashEl(el) {
    if (!el || !el.classList) return;
    el.classList.remove("is-landed");
    void el.offsetWidth; // 强制回流，同一个目标连点两次也能重播
    el.classList.add("is-landed");
    setTimeout(function () {
      el.classList.remove("is-landed");
    }, 1200);
  }

  function scrollToEl(hash) {
    var el = document.getElementById(hash);
    if (!el) return false;
    // 从表格点条目标题跳过来时，目标卡片可能被用户收起来了。
    // 不展开的话跳过去只有一行、看不到正文，等于跳了个寂寞。
    if (el.tagName === "DETAILS" && !el.open) el.open = true;
    // 同理：目标所在的**大标题模块**也可能被收起了（数据折叠），先展开它，
    // 否则跳过去只能看到标题栏。这一步必须在量位置之前。
    unfoldForTarget(el);
    var nav = document.querySelector(".nav");
    var top = el.getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 0) - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    if (el.classList.contains("card")) flashEl(el);
    return true;
  }

  // 这个锚点在哪个视图里？返回 view 的 data-view 键，找不到返回 null。
  // 用于「锚点没有登记在 ITEM_VIEW 里」的情况（例如 Skill 页的分组锚点）。
  function viewOfId(id) {
    var el = document.getElementById(id);
    if (!el || !el.closest) return null;
    var owner = el.closest(".view");
    if (!owner) return null;
    return owner.getAttribute("data-view") || (owner.id || "").replace(/^view-/, "") || null;
  }

  function route() {
    var raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) {
      // 没有 hash 不代表用户想回总览：多半是 iframe 重建后重挂载。
      // 用上次记住的落点恢复；没有记录才用设置里指定的默认页（默认仍是总览）。
      var remembered = restoreRoute();
      if (!remembered) remembered = defaultView();
      if (remembered) {
        // 用 replaceState 而不是 location.hash = ...：
        // 后者会异步再触发一次 hashchange，中间先渲染总览、再跳回来，闪一下。
        // 这里把 URL 写好，然后就地继续往下走，一次到位。
        try {
          history.replaceState(null, "", "#" + remembered);
        } catch {}
        raw = remembered;
      } else {
        show("overview");
        return;
      }
    }
    if (raw.indexOf("stage-") === 0) {
      var laneKey = raw.split("-").slice(1, -1).join("-");
      if (show("lane-" + laneKey)) nextFrame(function () {
        scrollToEl(raw);
      });
      return;
    }
    if (raw.indexOf("view-") === 0) {
      // 目标页可能已经不存在了（例如「工作流」页被删掉，而本机 localStorage
      // 或旧书签里还记着 #view-flow）。show() 找不到就直接掉回总览，
      // 否则这里 return 之后整页没有任何 is-active 的视图 —— 用户看到的是空白。
      if (!show(raw.slice(5), true)) {
        forgetRoute();
        show("overview");
      }
      return;
    }
    var view = ITEM_VIEW[raw];
    if (view) {
      show(view);
      nextFrame(function () {
        scrollToEl(raw);
      });
      return;
    }
    // 兜底：锚点在某个视图里就切到那个视图再滚过去。
    // 少了这一步，Skill 页那三个格子（#skill-group-*）会被当成未知锚点，直接掉回总览。
    var owner = viewOfId(raw);
    if (owner) {
      show(owner);
      nextFrame(function () {
        scrollToEl(raw);
      });
      return;
    }
    show("overview");
  }

  // 同一页里再点同一个锚点不会触发 hashchange，兜一层，
  // 否则用户点第二次会觉得"点了没反应"
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    // 阶段格子优先当筛选器；不是阶段格子才落回普通锚点跳转。
    if (applyStageFilter(a)) {
      e.preventDefault();
      nextFrame(function () {
        var board = document.querySelector(".view.is-active .stage-board");
        if (board) {
          var nav = document.querySelector(".nav");
          var top = board.getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 0) - 12;
          window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      });
      return;
    }
    var href = a.getAttribute("href") || "";
    if (href.length < 2 || location.hash !== href) return;
    var target = decodeURIComponent(href.slice(1));
    if (target.indexOf("view-") === 0) return; // 导航自己处理
    e.preventDefault();
    var v = ITEM_VIEW[target];
    if (v) show(v);
    else if (target.indexOf("stage-") === 0) show("lane-" + target.split("-").slice(1, -1).join("-"));
    nextFrame(function () {
      scrollToEl(target);
    });
  });

  // 每次 hash 变化都记下落点：切视图、点导航、点卡片都算。
  // 放在 hashchange 里而不是各点击处，是为了不漏掉任何一条改 hash 的路径
  // （导航链接、卡片锚点、阶段筛选、以及脚本里直接改 location.hash 的地方）。
  window.addEventListener("hashchange", function () {
    saveRoute(location.hash);
    route();
  });

  // ─────────────────────── 主题 ───────────────────────

  var THEMES = ["night", "eye", "paper"];
  var savedTheme = localStorage.getItem("ops-board-theme");
  if (savedTheme && THEMES.indexOf(savedTheme) > -1) {
    document.documentElement.setAttribute("data-theme", savedTheme);
  }

  function paintThemeButtons() {
    var cur = document.documentElement.getAttribute("data-theme") || "night";
    Array.prototype.forEach.call(document.querySelectorAll(".theme-swatch"), function (b) {
      b.classList.toggle("is-active", b.dataset.theme === cur);
    });
  }

  // 换主题只此一处。顶栏小色块和设置浮窗里的「主题」都走它，
  // 免得两边各写一遍、哪天只改了一边。
  function applyTheme(t) {
    if (!t) return;
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("ops-board-theme", t);
    } catch (e) {}
    paintThemeButtons();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".theme-swatch"), function (b) {
    b.addEventListener("click", function () {
      applyTheme(b.dataset.theme);
    });
  });
  paintThemeButtons();

  // ─────────────────────── 侧栏收起 ───────────────────────

  // 侧栏是索引，正文是内容。看内容时它挡路就收起来，回来查索引再展开。
  // 状态记在本机，下次打开还是你上次的样子。
  var RAIL_KEY = "ops-board-rail";
  var pageEl = document.querySelector(".page");
  var railBtns = document.querySelectorAll("[data-rail-toggle], #rail-toggle");

  function railHiddenNow() {
    return !!(pageEl && pageEl.classList.contains("rail-collapsed"));
  }

  function setRail(hidden) {
    if (!pageEl) return;
    // 跟原版同一套：收起态记在 .page 上，样式那边留 50px 窄条给按钮，
    // 所以按钮原地不动、只是文字从「收起」翻成「展开」。
    pageEl.classList.toggle("rail-collapsed", !!hidden);
    Array.prototype.forEach.call(railBtns, function (b) {
      b.setAttribute("aria-expanded", hidden ? "false" : "true");
      b.setAttribute("aria-label", hidden ? "展开侧栏" : "收起侧栏");
      b.title = (hidden ? "展开" : "收起") + " / 展开侧栏（快捷键 [ ）";
    });
    try {
      localStorage.setItem(RAIL_KEY, hidden ? "1" : "0");
    } catch (e) {}
  }

  var railSaved = "0";
  try {
    railSaved = localStorage.getItem(RAIL_KEY) || "0";
  } catch (e) {}
  setRail(railSaved === "1");

  Array.prototype.forEach.call(railBtns, function (b) {
    b.addEventListener("click", function () {
      setRail(!railHiddenNow());
    });
  });

  // 快捷键 [ ：在输入框里打字时不要抢
  document.addEventListener("keydown", function (e) {
    if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    setRail(!railHiddenNow());
  });

  // ─────────────────────── 本机偏好 ───────────────────────

  // 主题和侧栏本来就各有自己的键（顶栏色块、侧栏按钮直接写它们），
  // 这里不搬家，只把剩下几项攒在一个键里。两套键都算「本机偏好」，
  // 「清空」时一起清。
  var PREF_KEY = "ops-board-set";
  var PREF_DEF = { font: 16, view: "", scope: "all", evidence: true, hotkey: true };
  var FONT_CHOICES = [15, 16, 17.5, 19];
  var prefs = null;

  function loadPrefs() {
    var out = {};
    var k;
    for (k in PREF_DEF) out[k] = PREF_DEF[k];
    try {
      var raw = localStorage.getItem(PREF_KEY);
      var got = raw ? JSON.parse(raw) : null;
      if (got && typeof got === "object") {
        for (k in PREF_DEF) {
          if (Object.prototype.hasOwnProperty.call(got, k)) out[k] = got[k];
        }
      }
    } catch (e) {}
    // 存进来的值可能是手改过的 / 旧版本留下的，读的时候一律收一遍，
    // 免得一个坏值让整页字号变成 0。
    if (FONT_CHOICES.indexOf(Number(out.font)) < 0) out.font = PREF_DEF.font;
    else out.font = Number(out.font);
    if (["all", "title", "body"].indexOf(out.scope) < 0) out.scope = PREF_DEF.scope;
    out.evidence = !!out.evidence;
    out.hotkey = !!out.hotkey;
    out.view = out.view ? String(out.view) : "";
    return out;
  }

  function prefsNow() {
    if (!prefs) prefs = loadPrefs();
    return prefs;
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefsNow()));
    } catch (e) {}
  }

  // 字号只有一个出口：把 px 换算成倍率写到 :root 上。
  // CSS 那边正文各段都乘这个倍率，编号 / 时间 / 按钮不乘。
  function applyFont(px) {
    var v = Number(px);
    if (!(v > 0)) v = PREF_DEF.font;
    try {
      document.documentElement.style.setProperty("--fs-scale", String(v / 16));
    } catch (e) {}
  }

  // 空 hash 且没有上次落点时要打开的那一页。
  // 返回值按 hash 的写法给（view-xxx），route() 里那几条分支都是这么比的。
  function defaultView() {
    var v = prefsNow().view;
    if (!v) return "overview";
    return "view-" + String(v).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  }

  applyFont(prefsNow().font);

  // ──────────────── 每个大标题模块都能收起 ────────────────

  // 2026-11-20 用户定：「每个页面每个大标题模块，我觉得都应该是可以被收起的」。
  //
  // 结构约定（render.mjs / parts.mjs 的 sectionHead 生成）：
  //   标题栏 .section-head.is-foldable 里一个 .section-fold[data-fold="<key>"]
  //   正文   紧跟其后的 [data-fold-body="<key>"]；没有这个节点就退回「下一个兄弟」。
  //
  // 为什么不把正文按 id 找：id 是给锚点跳转用的，标题栏自己也常带着同一个 id 的
  // group（如 .detail-group），按 id 找会摸到外层容器，一收连标题一起没了。
  // 按 data-fold-body 找是精确的。
  //
  // 状态记本机 ops-fold-<key>，默认**全部展开**（干活的地方，进来要看见内容）。
  var FOLD_SEL = ".section-fold[data-fold]";

  function foldBodyOf(btn) {
    var key = btn.getAttribute("data-fold") || "";
    if (!key) return null;
    var head = btn.closest(".section-head") || btn.closest(".workbench-head");
    // 优先找**同一个容器里**的 data-fold-body，避免跨块串到别人的正文
    var scope = head ? head.parentNode : document;
    var body = scope ? scope.querySelector('[data-fold-body="' + key + '"]') : null;
    if (body) return body;
    // 兜底：标题栏的直接下一个兄弟（老结构没有包一层 data-fold-body 时）
    var next = head && head.nextElementSibling;
    if (next && next.getAttribute && next.getAttribute("data-fold-body") === key) return next;
    // 最后才按 aria-controls / id
    var cid = btn.getAttribute("aria-controls") || "";
    return cid ? document.getElementById(cid) : null;
  }

  function setSectionFold(btn, collapsed) {
    if (!btn) return;
    var body = foldBodyOf(btn);
    if (body) {
      if (collapsed) body.setAttribute("hidden", "");
      else body.removeAttribute("hidden");
    }
    var head = btn.closest(".section-head");
    if (head) head.classList.toggle("is-collapsed", !!collapsed);
    var wbHead = btn.closest(".workbench-head");
    if (wbHead) wbHead.classList.toggle("is-collapsed", !!collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var label = btn.getAttribute("aria-label") || "这一块";
    var name = label.replace(/^(收起|展开)[「"]?/, "").replace(/[」"]$/, "") || "这一块";
    btn.setAttribute("aria-label", (collapsed ? "展开" : "收起") + "「" + name + "」");
    btn.title = collapsed ? "展开这一块" : "收起这一块";
  }

  Array.prototype.forEach.call(document.querySelectorAll(FOLD_SEL), function (btn) {
    var key = btn.getAttribute("data-fold") || "";
    var saved = false;
    try {
      saved = localStorage.getItem("ops-fold-" + key) === "1";
    } catch (e) {}
    // 一进来就按上次的状态摆好（不等点击），否则刷新后会闪一下再收起来
    setSectionFold(btn, saved);
    btn.addEventListener("click", function (e) {
      // 这个按钮可能落在 summary 里或别的可点容器里，别让外层把手势吃掉
      e.preventDefault();
      e.stopPropagation();
      var collapsed = btn.getAttribute("aria-expanded") !== "false";
      setSectionFold(btn, collapsed);
      try {
        localStorage.setItem("ops-fold-" + key, collapsed ? "1" : "0");
      } catch (e) {}
    });
  });

  // 跳到被收起的模块里的锚点（表格点条目标题、阶段格子点进来）时，
  // 目标正文得先展开，否则跳过去只看到一行标题 —— 和卡片那条同一个道理。
  function unfoldForTarget(el) {
    if (!el || !el.closest) return;
    var body = el.closest("[data-fold-body]");
    if (!body || !body.hasAttribute("hidden")) return;
    var key = body.getAttribute("data-fold-body") || "";
    var btn = document.querySelector('.section-fold[data-fold="' + key + '"]');
    if (btn) setSectionFold(btn, false);
    else body.removeAttribute("hidden");
  }

  // ──────────────── 侧栏每块的「收起明细」 ────────────────

  // 原版就是这个交互：待办 / 新增功能 / bug 修复每块明细列表上方有一行
  // 「最近 N 条 …… 收起明细」，点它只把**明细列表**收起来，阶段格子和
  // 统计数字留着。按钮文案在「收起明细 / 展开明细」之间翻。
  // 状态记在本机，键名沿用原版的 ops-mini-<listId>。
  var miniBtns = document.querySelectorAll(".rail-mini-toggle");

  Array.prototype.forEach.call(miniBtns, function (btn) {
    var list = document.getElementById(btn.getAttribute("aria-controls") || "");
    if (!list) return;
    var key = "ops-mini-" + list.id;

    function apply(hide) {
      if (hide) list.setAttribute("hidden", "");
      else list.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", hide ? "false" : "true");
      btn.textContent = hide ? "展开明细" : "收起明细";
    }

    try {
      apply(localStorage.getItem(key) === "1");
    } catch (e) {}

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var hide = !list.hasAttribute("hidden");
      apply(hide);
      try {
        localStorage.setItem(key, hide ? "1" : "0");
      } catch (e) {}
    });
  });

  // ──────────────── 处理记录：按类型标签筛选 ────────────────

  // 跟原版一致：点某个类型只留该类，点「全部」恢复；标题右侧那行字改成
  // 「显示 N / M 条」。按下时不让浏览器起选区，否则连点会把正文整段选中。
  document.addEventListener("mousedown", function (e) {
    var chip = e.target && e.target.closest ? e.target.closest("[data-history-filter] .kind-chip") : null;
    if (!chip) return;
    e.preventDefault();
    chip.focus();
  });

  document.addEventListener("click", function (e) {
    var chip = e.target && e.target.closest ? e.target.closest("[data-history-filter] .kind-chip") : null;
    if (!chip) return;
    var bar = chip.parentNode;
    var key = chip.getAttribute("data-kind");
    var sec = chip.closest("[data-history-section]");
    if (!sec) return;

    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();

    var shown = 0;
    Array.prototype.forEach.call(bar.querySelectorAll(".kind-chip"), function (c) {
      var on = c === chip;
      c.classList.toggle("is-active", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });

    var items = sec.querySelectorAll(".timeline > li");
    Array.prototype.forEach.call(items, function (li) {
      var hide = key !== "all" && li.getAttribute("data-kind") !== key;
      li.classList.toggle("is-hidden", hide);
      if (!hide) shown += 1;
    });

    var out = sec.querySelector(".history-sub");
    if (out) {
      out.textContent =
        key === "all" ? out.getAttribute("data-default") || "" : "显示 " + shown + " / " + items.length + " 条";
    }
  });

  // ──────────────── 阶段格子当筛选器 ────────────────

  // 原版行为：点阶段板（或侧栏阶段表）里的一格，整页只留这一阶段 ——
  // 其他阶段标题和卡片、汇总条、处理记录全收起；再点同一格恢复。
  // 格子指向别的视图（问题修复页的「已解决」去收口页）时不筛，照旧跳转。
  function clearStageFilter() {
    Array.prototype.forEach.call(document.querySelectorAll(".details-main.is-stage-filtered"), function (main) {
      main.classList.remove("is-stage-filtered");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".detail-group.is-stage-keep"), function (sec) {
      sec.classList.remove("is-stage-keep");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".is-stage-filter"), function (cell) {
      cell.classList.remove("is-stage-filter");
      cell.removeAttribute("aria-current");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".stage-filter-hint"), function (hint) {
      if (hint.parentNode) hint.parentNode.removeChild(hint);
    });
  }

  function applyStageFilter(cell) {
    var board = cell.closest ? cell.closest(".stage-board") : null;
    var table = cell.closest ? cell.closest(".stage-table") : null;
    if (!board && !table) return false;

    var target = null;
    try {
      target = document.getElementById(decodeURIComponent(cell.getAttribute("href").slice(1)));
    } catch (e) {
      target = null;
    }
    if (!target || !target.classList.contains("detail-group")) return false;
    var main = target.closest(".details-main");
    if (!main) return false;

    var key = cell.getAttribute("href");
    var current = document.querySelector(".is-stage-filter");
    var wasActive = Boolean(current && current.getAttribute("href") === key);
    clearStageFilter();
    if (wasActive) return true;

    var anchor = board || main.querySelector(".stage-board");
    main.classList.add("is-stage-filtered");
    target.classList.add("is-stage-keep");

    // 左栏和阶段板上同一阶段的格子一起点亮，两处都能再点一下恢复。
    Array.prototype.forEach.call(document.querySelectorAll('.stage-board a[href="' + key + '"]'), function (c) {
      c.classList.add("is-stage-filter");
      c.setAttribute("aria-current", "true");
    });
    Array.prototype.forEach.call(document.querySelectorAll('.rail .stage-table a[href="' + key + '"]'), function (c) {
      c.classList.add("is-stage-filter");
      c.setAttribute("aria-current", "true");
    });

    if (anchor) {
      var label = anchor.querySelector('a[href="' + key + '"] span') || cell.querySelector("span");
      var hint = document.createElement("p");
      hint.className = "stage-filter-hint";
      hint.textContent = "只看「" + (label ? label.textContent.trim() : "") + "」· 再点这一格恢复全部";
      anchor.appendChild(hint);
    }

    // 总览页左栏点某个阶段：先切到它所在的那一页，再筛。
    var view = main.closest(".view");
    if (view) {
      var viewKey = view.getAttribute("data-view");
      if (viewKey && !view.classList.contains("is-active")) show(viewKey);
    }
    return true;
  }

  // ──────────────── 侧栏整节折叠（标题左侧箭头） ────────────────

  // 原版每节标题左边有一个小箭头，点它把这一节正文折起来，标题留在吸顶堆里。
  function setFold(panel, collapsed) {
    if (!panel) return;
    panel.classList.toggle("is-collapsed", !!collapsed);
    var fold = panel.querySelector(".rail-fold");
    if (!fold) return;
    var bodyId = fold.getAttribute("aria-controls") || "";
    var body = bodyId ? document.getElementById(bodyId) : null;
    if (body) {
      if (collapsed) body.setAttribute("hidden", "");
      else body.removeAttribute("hidden");
    }
    fold.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var name = (panel.querySelector(".rail-title") || {}).textContent || "";
    fold.setAttribute("aria-label", (collapsed ? "展开 " : "收起 ") + name.trim());
    fold.title = collapsed ? "展开这一节" : "收起这一节";
  }

  Array.prototype.forEach.call(document.querySelectorAll(".rail-fold"), function (b) {
    var panel = b.closest(".panel");
    var bodyId = b.getAttribute("aria-controls") || "";
    var was = bodyId ? localStorage.getItem("ops-fold-" + bodyId) === "1" : false;
    setFold(panel, was);
    b.addEventListener("click", function () {
      var on = !(panel && panel.classList.contains("is-collapsed"));
      setFold(panel, on);
      try {
        localStorage.setItem("ops-fold-" + bodyId, on ? "1" : "0");
      } catch (e) {}
    });
  });

  // ─────────────────────── 复制 ───────────────────────

  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function () {
        btn.textContent = old;
      }, 1400);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text;
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {}
      document.body.removeChild(t);
    }
  }

  document.addEventListener("click", function (e) {
    var copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      var id = copyBtn.getAttribute("data-copy");
      var item = D.items[id];
      if (item) copyText(item.copyText, copyBtn);
      return;
    }
    var askBtn = e.target.closest("[data-ask]");
    if (askBtn) {
      e.preventDefault();
      openPanel(askBtn.getAttribute("data-ask"));
      return;
    }
    // 单个 skill 的「问 AI」
    var skillBtn = e.target.closest("[data-ask-skill]");
    if (skillBtn) {
      e.preventDefault();
      openSkillPanel(skillBtn.getAttribute("data-ask-skill"));
      return;
    }
    // Skill 页顶部：针对整页
    var skillsBtn = e.target.closest("[data-ask-skills]");
    if (skillsBtn) {
      e.preventDefault();
      openSkillPanel(null);
      return;
    }
    // 工作台按钮（选卡 → 分析 → 开始 → 停止）
    var wbAnalyze = e.target.closest("[data-wb-analyze]");
    if (wbAnalyze) { e.preventDefault(); workbenchAnalyze(); return; }
    var wbStart = e.target.closest("[data-wb-start]");
    if (wbStart) { e.preventDefault(); workbenchStart(); return; }
    var wbStop = e.target.closest("[data-wb-stop]");
    if (wbStop) { e.preventDefault(); workbenchStop(); return; }
    var wbClear = e.target.closest("[data-wb-clear]");
    if (wbClear) { e.preventDefault(); workbenchClear(); return; }
    // 工作流页已于 2026-11-18 删除，[data-flow-release]/[data-flow-claim] 不再存在于任何页面，
    // 原来的这两个分支与 claimFlowItem / releaseFlowItem 已一并清除（2026-11-18 画布清理）。
    // 领取语义仍然活着，但在工作台侧：claimForWorkbench / releaseForWorkbench 直接打
    // /api/flow/{claim,release}，不依赖任何 DOM 节点。
  });

  // ─────────────────── 工作流：领取 / 交还 ───────────────────

  // 本页的执行者名字。用一个稳定的随机串，刷新后不变（存在 localStorage），
  // 这样「谁领的」在页面重载后还能对得上。
  function flowActor() {
    var k = "ops-board-flow-actor";
    try {
      var v = localStorage.getItem(k);
      if (v) return v;
      var n = "win-" + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(k, n);
      return n;
    } catch (e) {
      return "win-unknown";
    }
  }

  function flowUrl(name) {
    var env = harnessEnv();
    if (env && env.id) return "/ops-board/b/" + env.id + "/api/flow/" + name;
    return "/api/flow/" + name;
  }

  // 工作台的 API（/api/... 而不是 /api/flow/...）。在 Harness 里同样要带板前缀。
  function wbUrl(path) {
    var env = harnessEnv();
    var p = String(path || "api/workbench/analyze");
    if (!/^\//.test(p)) p = "/" + p;
    var api = p.indexOf("/api/") === 0 ? p.slice(1) : p;
    if (env && env.id) return "/ops-board/b/" + env.id + "/" + api;
    return "/" + api;
  }

  function postJson(url, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
      done(j, xhr.status);
    };
    xhr.send(JSON.stringify(body || {}));
  }

  // ─────────────────────── 工作台（自动执行） ───────────────────────
  //
  // 从「看图 → 手动点领」到「让机器自动跑一段」，这一步的核心是**编排**：
  // 用户勾选要处理的卡 → 选串行/并行 → 机器守着 flow 的约束逐张
  // claim → 交给 Harness 分析（复用 harnessPost）→ 取回回答 → 记下结论
  // → release 让同区域下一件顶上。全程在页面上能看到每一张卡走到哪了。
  //
  // ⚠️ 为什么不放在 serve.mjs：真正「执行一张卡」= 把卡喂给 Harness 并
  // 取回答，这条路只存在于看板页（harnessPost → /ops-board/ask → session）。
  // serve.mjs 没有问模型的入口，所以编排器放这里，serve 只提供纯计算的
  // analyze 建议（见 lib/workbench.mjs）。

  var WB = {
    el: document.querySelector("[data-workbench]"),
    selected: [],           // (保留，dragPool 取代) 旧勾选
    dragPool: [],           // 拖动排列的卡 id（顺序即执行顺序）
    seedOnce: false,        // 候选池首刷是否已铺过（防清空后刷新又全塞回）
    candidate: [],          // 全部候选（ready/wait/running）
    plan: [],
    steps: null,            // serve 分析的 serial/parallel 结果
    batteries: null,        // 看板手动分批：[{index, reason, cards:[{id,title,...}]}]
    order: [],              // 实际执行顺序：{id, title, prefix, why}
    knownWindows: [],       // 上轮用过的对话窗口（{key,lastCard,lastAt}），作为分析窗口的复用线索
    run: false,             // 是否正在跑
    stop: false,            // 用户点了停止
    mode: "serial",         // serial | parallel
    index: -1,              // order 里当前执行到第几步
    busy: false,            // 正在 claim 或等 Harness 回答
    execOrder: [],          // 按 claim 成功先后记的执行顺序（留给报告/调试）
    batchSize: 1,           // 分批粒度：每批几张卡（默认串行=每批 1 张）
    batchMode: false,       // true = 走「看板分批→整批交给 Agent」新执行模型
    shelved: [],            // 搁置的卡 id（用户明确不想看到它出现在备选里），存本机
  };
  // 暴露给测试/扩展：只读探针，不会在正常页面干扰任何东西。
  try { window.__wb = WB; } catch (e) {}
  // 刷新候选池 / 重画池子的两个探针。平时没有任何代码读它们，只有测试用
  // （要复现「别人先领走了这张卡」这种状态，必须能自己触发一次刷新）。
  try { window.__wbRefresh = workbenchRefresh; window.__wbRenderPool = renderWorkbenchPool; } catch (e) {}

  function wbPresent() { return !!WB.el; }

  // ──────────────── 搁置队列（用户不想在备选里看到的卡） ────────────────
  //
  // 2026-11-20 用户原话：「有的任务，我是不想他出现在备选的，所以，我觉得有必要在卡片上
  // 增加一个按钮（搁置），可以让这个卡片不在备选显示，增加一行搁置队列。搁置队列中的
  // 卡片显示备选按钮，点击备选后，回到备选队列。」
  //
  // 三个要点：
  //   ① 搁置是**用户的意愿**，不是台账状态 —— 所以存 localStorage，不写 ledger.json。
  //      台账里那些卡的 status 一点没变，机器仍然认为它们可开工；变的只是「我不看它」。
  //   ② 搁置的卡**不进队列、不进备选**，只出现在「搁置」那一行。
  //   ③ 搁置里的卡点「备选」就回来 —— 回到备选，不是直接进执行队列
  //      （用户说的是「回到备选队列」，那就得是备选）。
  //
  // 为什么要按板分开存：同一个浏览器里可能开着好几块看板，A 板的搁置不该影响 B 板。
  var SHELF_KEY_BASE = "ops-board-wb-shelved";

  // 搁置清单按**看板**分开存：同一个浏览器里可能开着好几块板，A 板的搁置不该影响 B 板。
  //
  // 取哪个标识：优先 Harness 注入的 board.id（在面板里就是这个）；
  // 没有的时候（直接用 serve.mjs 打开、或 file:// 打开）退回 D.project（台账里的项目名）。
  // ⚠️ 不要用 harnessEnv().dir —— 那在裸页里是 null，会让所有板共用一个键。
  function shelfKey() {
    var env = harnessEnv();
    var id = (env && env.id) || D.project || "board";
    return SHELF_KEY_BASE + ":" + id;
  }

  function loadShelf() {
    try {
      var raw = localStorage.getItem(shelfKey());
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === "string" && x; });
    } catch (e) {
      return [];
    }
  }

  function saveShelf() {
    try {
      localStorage.setItem(shelfKey(), JSON.stringify(WB.shelved || []));
    } catch (e) {}
  }

  // 搁置 / 取消搁置。搁置时顺手把它从执行队列里摘出来 ——
  // 「搁置」的语义就是「现在别管它」，留着它在队列里等会儿还会被执行，自相矛盾。
  function wbSetShelved(id, on) {
    if (!id) return;
    var list = (WB.shelved || []).slice();
    var i = list.indexOf(id);
    if (on && i === -1) list.push(id);
    if (!on && i > -1) list.splice(i, 1);
    WB.shelved = list;
    saveShelf();
    if (on) {
      var q = WB.dragPool.indexOf(id);
      if (q > -1) WB.dragPool.splice(q, 1);
    }
    var pool = WB.el && WB.el.querySelector("[data-wb-pool]");
    if (pool) renderWorkbenchPool(pool);
    workbenchRefreshModeBtn();
    workbenchLog(on ? "已搁置「" + id + "」——它不会出现在备选里了，在「搁置」那一行可以取回。"
                    : "「" + id + "」已放回备选队列。");
  }

  // 这张卡现在归哪一组？running 优先（在跑的就是在跑），再判搁置，最后备选。
  function wbWhere(c) {
    if (c.state === "running") return "queue";
    if ((WB.shelved || []).indexOf(c.id) > -1) return "shelf";
    if (WB.dragPool.indexOf(c.id) > -1) return "queue";
    return "standby";
  }

  // 用 plan 铺候选池。ready=可开工，running=已被领走（只读显示），
  // waiting=排队（规划用；执行时等到它可领才真跑）。
  // 池 = 一张可拖拽排序的队列：拖动排顺序，顺序即执行顺序；每张可点 ✕ 移出。
  function workbenchRefresh() {
    if (!wbPresent()) return;
    getJson(flowUrl("plan"), function (res, status) {
      if (status !== 200 || !res || !res.ok) return;
      WB.plan = res;
      var pool = WB.el.querySelector("[data-wb-pool]");
      if (!pool) return;
      // 候选 = ready（可开工）+ waiting（排队）+ running（显示占用但不进队列）
      var cand = [];
      (res.runnable || []).forEach(function (r) {
        if (r.state === "running") cand.push({ id: r.id, title: r.title, prefix: r.prefix, state: "running", by: r.by || "" });
        else cand.push({ id: r.id, title: r.title, prefix: r.prefix, state: "ready", by: "" });
      });
      (res.waiting || []).forEach(function (w) {
        cand.push({ id: w.id, title: w.title, prefix: w.prefix, state: "wait", by: "", waitsFor: w.waitsFor || "" });
      });
      if (!res.runnable && !res.waiting) cand = cand; // noop
      // 首次铺开：**执行队列初始为空**、所有卡都在备选区，用户自己把想做的
      // 点/拖进队列（用户要「一进页面全空、全在备选」）。之后刷新只做增量合并，
      // 保留用户已排的顺序与移出状态。
      var firstRun = !WB.seedOnce;
      WB.seedOnce = true;
      if (firstRun) {
        // 一进页面执行队列为空（卡都由用户自己挑）——**正在处理中的卡例外**：
        // 它已经在跑了，本来就属于「待执行队列里的活」，不该躺在备选区当候选。
        WB.dragPool = cand.filter(function (c) { return c.state === "running"; })
          .map(function (c) { return c.id; });
      } else {
        // 保留用户已排的顺序与移出状态，仅合并新出现的卡
        var known = WB.dragPool.slice();
        // running 的卡**必须留在队列里**：以前这里写成 `c.state !== "running"`，
        // 于是别人一领走（或上一轮还在跑），这张卡就被踢出队列、掉回备选区，
        // 界面上表现为「正在处理的任务不在处理队列里，还在备选里」。
        var kept = known.filter(function (id) { return cand.some(function (c) { return c.id === id; }); });
        // 搁置的卡不自动进队列 —— 用户搁置它就是不想让它参与排队。
        cand.filter(function (c) {
          return kept.indexOf(c.id) === -1 && (WB.shelved || []).indexOf(c.id) === -1;
        }).forEach(function (c) { kept.push(c.id); });
        WB.dragPool = kept;
      }
      WB.candidate = cand;
      renderWorkbenchPool(pool);
      workbenchRefreshModeBtn();
    });
  }

  // 一键清空：把执行队列（要做的卡）全部退掉，回到「还没选」的状态。
  // 不清 running（机器正在跑的归它），只清可排的候选；同时收起已铺开的
  // 步骤区与分析结果，让工作台回到干净的初始态。
  function workbenchClear() {
    if (!wbPresent()) return;
    if (WB.run) { workbenchLog("正在执行，先停止再清空。"); workbenchStop(); }
    WB.dragPool = [];
    WB.plan = [];
    WB.steps = null;
    WB.batches = null;
    WB.order = [];
    WB.index = -1;
    WB.execOrder = [];
    WB.mode = "serial";
    var pool = WB.el.querySelector("[data-wb-pool]");
    if (pool) renderWorkbenchPool(pool);
    // 收起执行区、回复位按钮
    var runEl = WB.el.querySelector("[data-wb-run]");
    if (runEl) runEl.setAttribute("hidden", "");
    var stepsEl = WB.el.querySelector("[data-wb-steps]");
    if (stepsEl) stepsEl.innerHTML = "";
    var start = WB.el.querySelector("[data-wb-start]");
    var analyze = WB.el.querySelector("[data-wb-analyze]");
    var stopBtn = WB.el.querySelector("[data-wb-stop]");
    if (analyze) analyze.disabled = true;
    if (start) start.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    workbenchRefreshModeBtn();
    workbenchLog("工作台已清空，执行队列全部退掉。回到起始状态。");
  }

  function renderWorkbenchPool(pool) {
    if (!WB.candidate.length) {
      pool.innerHTML = '<p class="workbench-empty">没有可开工的卡。排队的卡要等前面那件领走并做完才能进池。</p>';
      return;
    }
    var byId = {};
    WB.candidate.forEach(function (c) { byId[c.id] = c; });
    // 队列里的卡（要做的）横向铺开；未进队列的备选卡单独成一组（虚线框、点一下加入）。
    var queued = WB.dragPool.map(function (id) {
      var c = byId[id];
      if (!c) return "";
      // 搁置的卡不该出现在队列里（wbSetShelved 已经把它摘了，这里再兜一次，
      // 免得别处直接改 dragPool 时把它们带进来）。
      if ((WB.shelved || []).indexOf(c.id) > -1 && c.state !== "running") return "";
      var label = esc(c.title);
      if (c.state === "wait") label += ' <span class="wb-queued">· 等 ' + esc(c.waitsFor) + "</span>";
      else if (c.state === "running") label += ' <span class="wb-occupied">· ' + esc(c.by) + " 正在做</span>";
      // 正在处理的卡留在队列里，但它已经交出去了：不能拖、不能 ✕、点本体也不撤回。
      // 只作为「这件在谁手上」的占位，免得进度看着像凭空消失。
      if (c.state === "running") {
        return (
          '<div class="wb-pick wb-occupied" data-wb-id="' + esc(c.id) + '" title="' +
          esc((c.by || "他人") + " 正在处理，处理完自动回到备选") + '">' +
          '<span class="wb-pick-row">' +
          '<span class="wb-pick-id">' + esc(c.id) + "</span></span>" +
          // 区域标签跟在标题右侧（2026-11-20 用户定），不再压在卡片底部。
          '<span class="wb-pick-main"><span class="wb-pick-title">' + label + "</span>" +
          '<span class="wb-pick-prefix">' + esc(c.prefix) + "</span></span>" +
          '<span class="wb-pick-foot">' +
          '<span class="wb-state-tag">处理中</span></span>' +
          "</div>"
        );
      }
      return (
        '<div class="wb-pick" draggable="true" data-wb-id="' + esc(c.id) + '">' +
        '<span class="wb-pick-row"><span class="wb-pick-grip" title="拖动排序">⠿</span>' +
        '<span class="wb-pick-id">' + esc(c.id) + "</span></span>" +
        '<span class="wb-pick-main"><span class="wb-pick-title">' + label + "</span>" +
        '<span class="wb-pick-prefix">' + esc(c.prefix) + "</span></span>" +
        '<span class="wb-pick-foot">' +
        '<button type="button" class="wb-pick-x" data-wb-x="' + esc(c.id) + '" title="移出队列">✕</button></span>' +
        "</div>"
      );
    }).join("");
    // 备选 = 没进队列、**没在处理中**、也**没被搁置**的卡（可点加入）。
    // 以前这里写成 `c.state === "running" || 不在队列`，于是正在处理的卡被硬塞进备选区，
    // 界面上就成了「正在处理的任务不在处理队列里，还在备选里」。
    var standby = WB.candidate.filter(function (c) {
      return wbWhere(c) === "standby";
    }).map(function (c) {
      return (
        '<div class="wb-pick wb-standby" data-wb-id="' + esc(c.id) + '" data-wb-add="' + esc(c.id) + '" title="点一下加入队列">' +
        '<span class="wb-pick-row"><span class="wb-pick-id">' + esc(c.id) + "</span></span>" +
        '<span class="wb-pick-main"><span class="wb-pick-title">' + esc(c.title) + "</span>" +
        '<span class="wb-pick-prefix">' + esc(c.prefix) + "</span></span>" +
        '<span class="wb-pick-foot">' +
        // 每张备选卡都能搁置：搁置 = 「以后别在备选里给我看了」。
        // 2026-11-20 用户定：卡片上**不显示「备选」两个字** —— 这一组本身就是备选区，
        // 每张卡再挂个「备选」标签是重复的噪声。分组标题已经说明了它是什么。
        '<button type="button" class="wb-pick-shelf" data-wb-shelf="' + esc(c.id) + '" title="搁置：不要出现在备选里">搁置</button>' +
        "</span>" +
        "</div>"
      );
    }).join("");
    // 搁置队列：用户明确不想在备选里看到的卡。点「备选」回到备选（不是直接进执行队列）。
    var shelved = (WB.shelved || []).map(function (id) {
      var c = byId[id];
      if (!c) return "";
      // 正在跑的卡不显示在搁置里 —— 机器还在用它，摆在「搁置」会让人以为它没在跑。
      if (c.state === "running") return "";
      return (
        '<div class="wb-pick wb-shelved" data-wb-id="' + esc(c.id) + '" title="已搁置：不会出现在备选里">' +
        '<span class="wb-pick-row"><span class="wb-pick-id">' + esc(c.id) + "</span></span>" +
        '<span class="wb-pick-main"><span class="wb-pick-title">' + esc(c.title) + "</span>" +
        '<span class="wb-pick-prefix">' + esc(c.prefix) + "</span></span>" +
        '<span class="wb-pick-foot">' +
        '<button type="button" class="wb-pick-unshelf" data-wb-unshelf="' + esc(c.id) + '" title="放回备选队列">备选</button>' +
        "</span>" +
        "</div>"
      );
    }).join("");
    var group = '<div class="wb-group"><span class="wb-group-label">待执行队列（点卡片撤回备选 / 拖动排序）</span>' +
      (queued || '<span class="workbench-empty">尚未排卡，点下方备选卡加入</span>') + "</div>";
    if (standby) group += '<div class="wb-group"><span class="wb-group-label">备选（点卡片加入队列 / 点「搁置」收起）</span>' + standby +
      '<span class="wb-pool-foot"><span>全部未排队</span>' +
      '<button type="button" class="btn" data-wb-addall>全部加入</button></span></div>';
    if (shelved) group += '<div class="wb-group wb-group-shelf"><span class="wb-group-label">搁置（点「备选」放回备选队列）</span>' + shelved + "</div>";
    pool.innerHTML = group;
    // 拖动排序 + 移出
    bindWbDrag(pool);
    Array.prototype.forEach.call(pool.querySelectorAll("[data-wb-x]"), function (x) {
      x.addEventListener("click", function () {
        var id = x.getAttribute("data-wb-x");
        var i = WB.dragPool.indexOf(id);
        if (i > -1) WB.dragPool.splice(i, 1);
        renderWorkbenchPool(pool);
        workbenchRefreshModeBtn();
      });
    });
    // 执行队列卡：点卡片本体回到备选（✕ 与拖把是分开的，不冲突）。
    // 判定：点在卡片上、但不是 ✕/拖把；且没发生拖动（指针没位移）。
    var wbClickedFrom = null, wbClickDidDrag = false;
    Array.prototype.forEach.call(pool.querySelectorAll("[data-wb-x]"), function (x) {
      var card = x.closest(".wb-pick");
      if (!card) return;
      card.addEventListener("mousedown", function () { wbClickedFrom = { x: 0, y: 0 }; wbClickDidDrag = false; });
      card.addEventListener("dragstart", function () { wbClickDidDrag = true; });
      card.addEventListener("click", function (e) {
        if (wbClickDidDrag) return;                       // 刚拖过，不是点
        if (e.target && (e.target.closest(".wb-pick-x") || e.target.closest(".wb-pick-grip"))) return; // 交给 ✕/拖把
        var id = x.getAttribute("data-wb-x");
        var i = WB.dragPool.indexOf(id);
        if (i > -1) WB.dragPool.splice(i, 1);
        renderWorkbenchPool(pool);
        workbenchRefreshModeBtn();
      });
    });
    // 备选卡点一下加入队列
    Array.prototype.forEach.call(pool.querySelectorAll("[data-wb-add]"), function (add) {
      add.addEventListener("click", function (e) {
        // 点「搁置」按钮不是「加入队列」——两个动作在同一张卡上，别让它冒泡到卡片。
        if (e.target && e.target.closest("[data-wb-shelf]")) return;
        var id = add.getAttribute("data-wb-add");
        if (WB.dragPool.indexOf(id) === -1) WB.dragPool.push(id);
        renderWorkbenchPool(pool);
        workbenchRefreshModeBtn();
      });
    });
    // 备选卡上的「搁置」：从备选里收起来，进「搁置」那一行。
    Array.prototype.forEach.call(pool.querySelectorAll("[data-wb-shelf]"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        wbSetShelved(btn.getAttribute("data-wb-shelf"), true);
      });
    });
    // 搁置卡上的「备选」：放回备选队列。
    Array.prototype.forEach.call(pool.querySelectorAll("[data-wb-unshelf]"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        wbSetShelved(btn.getAttribute("data-wb-unshelf"), false);
      });
    });
    // 全部加入：把备选里所有卡一次收进队列。
    // 正在处理中的卡本来就该在队列里（refresh 会保住），这里不能把它们再过滤掉；
    // 搁置的卡**绝不带进来** —— 用户搁置它就是不想让它参与排队。
    var addAll = pool.querySelector("[data-wb-addall]");
    if (addAll) {
      addAll.addEventListener("click", function () {
        var kept = WB.candidate
          .filter(function (c) { return c.state === "running"; })
          .map(function (c) { return c.id; });
        WB.dragPool = kept.concat(
          WB.candidate
            .filter(function (c) {
              return c.state !== "running" &&
                kept.indexOf(c.id) === -1 &&
                (WB.shelved || []).indexOf(c.id) === -1;
            })
            .map(function (c) { return c.id; })
        );
        renderWorkbenchPool(pool);
        workbenchRefreshModeBtn();
      });
    }
  }

  // HTML5 鼠标拖动给 .wb-pick 排序：拖到哪张上面就把哪张的位置让给它。
  var wbDragEl = null;
  function bindWbDrag(pool) {
    Array.prototype.forEach.call(pool.querySelectorAll(".wb-pick[draggable=true]"), function (card) {
      card.addEventListener("dragstart", function (e) {
        wbDragEl = card;
        card.classList.add("wb-dragging");
        e.dataTransfer && e.dataTransfer.effectAllowed && (e.dataTransfer.effectAllowed = "move");
        try { e.dataTransfer.setData("text/plain", card.getAttribute("data-wb-id")); } catch (err) {}
      });
      card.addEventListener("dragend", function () {
        wbDragEl = null;
        card.classList.remove("wb-dragging");
        Array.prototype.forEach.call(pool.querySelectorAll(".wb-drop-target"), function (t) { t.classList.remove("wb-drop-target"); });
      });
      card.addEventListener("dragover", function (e) {
        e.preventDefault();
        if (wbDragEl === card) return;
        Array.prototype.forEach.call(pool.querySelectorAll(".wb-drop-target"), function (t) { t.classList.remove("wb-drop-target"); });
        card.classList.add("wb-drop-target");
        e.dataTransfer && e.dataTransfer.dropEffect && (e.dataTransfer.dropEffect = "move");
      });
      card.addEventListener("drop", function (e) {
        var fromEl = wbDragEl;
        if (!fromEl || fromEl === card) { card.classList.remove("wb-drop-target"); return; }
        var fromId = fromEl.getAttribute("data-wb-id");
        var toId = card.getAttribute("data-wb-id");
        var fi = WB.dragPool.indexOf(fromId);
        var ti = WB.dragPool.indexOf(toId);
        if (fi > -1 && ti > -1 && fi !== ti) {
          // 前/后都支持：来源卡原来在目标**前**（往后/下拉）→ 插到目标**后**；
          // 来源卡原来在目标**后**（往前/上拉）→ 插到目标**前**。
          var before = fi < ti;
          WB.dragPool.splice(fi, 1);
          ti = WB.dragPool.indexOf(toId); // 移除后再定位，避免索引漂移
          WB.dragPool.splice(before ? ti + 1 : ti, 0, fromId);
          renderWorkbenchPool(pool);
          workbenchRefreshModeBtn();
        }
        card.classList.remove("wb-drop-target");
      });
    });
  }

  // 「开始执行」仅在队列非空且未在跑时可点。
  function workbenchRefreshModeBtn() {
    var start = WB.el && WB.el.querySelector("[data-wb-start]");
    if (!start) return;
    start.disabled = !WB.dragPool.length || WB.run;
    // 「分析」同理：队列非空且在跑前可点（清空后重新加卡也能再分析）
    var analyze = WB.el && WB.el.querySelector("[data-wb-analyze]");
    if (analyze) analyze.disabled = !WB.dragPool.length || WB.run;
    var sz = WB.el.querySelector("[data-wb-pool]");
    if (sz) sz.setAttribute("data-count", WB.dragPool.length);
  }

    // 并行时统一走这里：判定 lanes（整批全交 / 分析窗口 / 回退），然后铺出去。
  // 分批与不分批共用同一套判断，避免两条路径两套逻辑。
  function workbenchPlanAndRender(runEl, stepsEl) {
    // 「整批全交」按定义就是一个窗口装全部，不问分析窗口、也不按区域拆。
    if (WB.batchMode) {
      WB.lanes = [{ key: "整批全交", prefix: "整批全交", cards: WB.order.slice(), why: "全部卡交给同一个窗口" }];
      workbenchRenderLanes(runEl, stepsEl, WB.lanes, null);
      workbenchFinishAnalyze(true);
      return;
    }

    var reusePlanner = wbPlannerReuseOn();
    var selCards = WB.order.map(function (o) {
      var cand = (WB.candidate || []).filter(function (c) { return c.id === o.id; })[0] || {};
      return {
        id: o.id, title: o.title, prefix: o.prefix || cand.prefix || "",
        lane: cand.lane || "", status: cand.status || "", step: cand.step || "",
      };
    });

    var prefixOf = {};
    selCards.forEach(function (c) { prefixOf[c.id] = c.prefix || ""; });
    var orderIds = WB.order.map(function (o) { return o.id; });

    // 回退用：按区域前缀分组（与服务端一致的确定性规则）。
    function fallback() {
      var P = wbPlanner();
      if (P) {
        return P.fallbackLanes(orderIds, {
          get: function (k) { return prefixOf[k] || ""; },
          has: function (k) { return Object.prototype.hasOwnProperty.call(prefixOf, k); },
        }).map(function (la) {
          return {
            key: la.key, prefix: la.prefix, why: la.why,
            cards: la.cardIds.map(function (id) {
              return WB.order.filter(function (o) { return o.id === id; })[0];
            }).filter(Boolean),
          };
        }).filter(function (la) { return la.cards.length; });
      }
      // 连校验器都没有：退到最朴素的分组
      var byPrefix = {}, lanes = [];
      WB.order.forEach(function (o) {
        var p = o.prefix || "(未分区域)";
        if (!byPrefix[p]) { byPrefix[p] = []; lanes.push({ key: p, prefix: p, cards: byPrefix[p] }); }
        byPrefix[p].push(o);
      });
      return lanes;
    }

    function apply(lanes, decided) {
      WB.lanes = lanes;
      workbenchRememberLanes(lanes);
      workbenchRenderLanes(runEl, stepsEl, lanes, decided);
      workbenchFinishAnalyze(true);
    }

    // 先把确定性分组**立刻**铺出来，再异步问分析窗口。
    // 为什么不等它：分析窗口是一次真实的 LLM 往返，可能几十秒；让用户盯着空面板等
    // 是完全没必要的——按区域分组本来就是合法的保底答案。
    // 所以顺序是「先给能用的，再换成更好的」：AI 计划回来了且合法就重铺，不合法就保持现状。
    apply(fallback(), {
      source: "pending",
      reason: wbPlanAskEnabled()
        ? "先按区域分组铺出来，正在请分析窗口复核…"
        : "当前页面没有可用的对话窗口（不在 Harness 面板里），已按区域分组。",
    });
    if (!wbPlanAskEnabled()) return;

    wbSetAnalyzeBusy(true);
    var askSeq = (WB.planSeq = (WB.planSeq || 0) + 1);
    wbAskPlanner(selCards, WB.batchSize || 1, reusePlanner, function (text, err) {
      wbSetAnalyzeBusy(false);
      // 期间用户又点了一次分析 / 已经开跑：这一轮的结果作废，别把面板改回去。
      if (askSeq !== WB.planSeq || WB.run) return;
      var decided = err
        ? { lanes: null, source: "fallback", reason: "分析窗口没答上来：" + err }
        : wbResolvePlan(text, orderIds, prefixOf);
      if (decided.source === "ai" && decided.lanes && decided.lanes.length) {
        var lanes = decided.lanes.map(function (la) {
          return {
            key: la.key, prefix: la.prefix, why: la.why || "",
            cards: la.cardIds.map(function (id) {
              return WB.order.filter(function (o) { return o.id === id; })[0];
            }).filter(Boolean),
          };
        }).filter(function (la) { return la.cards.length; });
        if (lanes.length) {
          workbenchLog("分析窗口已复核：" + lanes.length + " 个窗口。");
          apply(lanes, decided);
          return;
        }
        decided = { lanes: null, source: "fallback", reason: "计划映射回卡失败了" };
      }
      // 回退：确定性分组已经在面板上了，只需要把原因说清楚（不重铺，避免闪一下）。
      workbenchRenderLanes(runEl, stepsEl, WB.lanes, decided);
      workbenchLog("分析窗口的计划没采用（" + (decided.reason || "不合法") + "），保持按区域分组。");
    });
  }

// 分析窗口的全部落地细节在下面这几个 helper 里，主流程只管「问 → 判 → 铺」。

  function wbPlanner() { return window.__WB_PLANNER__ || null; }

  // 「分析窗口」开关：默认勾上（= 复用一个固定的调度窗口）。
  function wbPlannerReuseOn() {
    var box = WB.el && WB.el.querySelector("[data-wb-planner-reuse]");
    return box ? !!box.checked : true;
  }

  // 演练模式：勾上之后，交给对话窗口的话术变成「只回一句话、不要动台账」。
  //
  // 为什么要有这个：工作台是真的会改台账的（prompt 里明确要求把 status 收到
  // 收口阶段）。想单纯看「窗口怎么接活、怎么复用、名字长什么样、多路怎么并发」
  // 的时候，用真数据跑一遍会把卡全收口掉 —— 试一次废一次数据。
  // 这个开关让同一套链路照跑（claim / 派活 / 等回答 / release 全都一样），
  // 只有 prompt 里那句「真的去做」被换成「只回话」。
  //
  // 默认**关**（= 真执行）。演练是偶尔的需求，真执行是日常；
  // 默认开着迟早会有人以为机器在干活、其实什么都没做。
  function wbRehearsalOn() {
    var box = WB.el && WB.el.querySelector("[data-wb-rehearsal]");
    return box ? !!box.checked : false;
  }

  // 拼「请只做个回应、别动台账」那一段。三个执行入口（逐张 / 整批 / 路批量）共用，
  // 免得三处话术各写一份、改一处漏两处。
  function wbRehearsalNote(ids, ledgerPath) {
    var list = (ids && ids.length ? ids : []).join("、") || "（本批）";
    return (
      "【演练模式：只回应，不要真执行】\n" +
      "这一轮是看板在测试对话窗口的接活表现，**不要修改任何文件**，尤其不要动 ledger.json。\n" +
      "请只做一件事：用两三句话回应你收到了哪些卡（" + list + "），" +
      "并说说你打算怎么处理它们（顺序 / 会不会互相冲突）。\n" +
      "说完就结束，不要读改台账、不要跑命令、不要声称已经把状态改好了 ——\n" +
      "这次要验的是「窗口有没有接住活、回没回话」，不是「卡有没有被收口」。\n" +
      (ledgerPath ? "（台账在 " + ledgerPath + "\\ledger.json，本轮不用碰它。）\n" : "")
    );
  }

  // 有没有条件问分析窗口：得有 Harness 环境，且校验器已就位。
  function wbPlanAskEnabled() {
    return !!harnessEnv() && !!wbPlanner();
  }

  function wbSetAnalyzeBusy(on) {
    var btn = WB.el && WB.el.querySelector("[data-wb-analyze]");
    if (!btn) return;
    btn.textContent = on ? "分析中…" : "分析";
    if (on) btn.disabled = true;
    else workbenchRefreshModeBtn();
  }

  // 调「分析窗口」：一次真实的 LLM 往返，让它回一段 JSON 计划。
  // reuse=true → fresh:false（宿主接回映射表里那条会话，即「复用分析窗口」）；
  // reuse=false → fresh:true（每次新开，结论不受上一轮影响）。
  // 分析窗口的会话键。**必须与 planner.mjs 的 PLANNER_WINDOW_KEY 一致** ——
  // 校验器用它拒绝「lane.key 撞上分析窗口」的计划（撞了会让干活窗口接进分析窗口的会话）。
  var WB_PLANNER_KEY = (wbPlanner() && wbPlanner().PLANNER_WINDOW_KEY) || "调度台";
  // 串行执行的固定窗口名。串行没有「路」可分，但也不该每张卡新开一个窗口 ——
  // 用户要的是「一个固定窗口，所有卡都交给它」：N 张卡 → 1 条会话，接着上下文做。
  // 名字同时充当**复用键**（宿主按它查映射表）和**显示名**，两处必须是同一个字符串，
  // 否则映射表会随会话漂移、窗口越开越多。
  // 它和分析窗口一样是保留名：planner.mjs 的 RESERVED_KEYS 里也列了「执行台」，
  // 免得 AI 把某条 lane 也起名叫「执行台」，让干活窗口接进这条串行会话。
  var WB_EXEC_KEY = (wbPlanner() && wbPlanner().EXEC_WINDOW_KEY) || "执行台";
  function wbAskPlanner(cards, batchSize, reuse, done) {
    var P = wbPlanner();
    if (!P) { done("", "没有计划校验器"); return; }
    var known = (WB.knownWindows || []).map(function (w) {
      return { key: w.key, lastCard: w.lastCard || "", lastAt: w.lastAt || "" };
    });
    var text = P.buildPlannerPrompt(cards, known, batchSize);
    var finished = false;
    harnessPostWithCapture(WB_PLANNER_KEY, text, !reuse, function (result) {
      if (finished) return;
      finished = true;
      if (!result || !result.ok) { done("", (result && result.error) || "发送失败"); return; }
      var askId = result.askId || "";
      WP_ANSWERS[askId] = {
        text: function (payload) {
          if (finished) return;
          finished = true;
          delete WP_ANSWERS[askId];
          if (payload.error) { done("", payload.error); return; }
          done(payload.text || "", "");
        },
      };
      setTimeout(function () {
        if (!finished) { finished = true; delete WP_ANSWERS[askId]; done("", "等分析窗口回答超时"); }
      }, 180000);
    }, null, true, "", false, { sessionTitle: WB_PLANNER_KEY, kind: "分批分析" });
  }

  // 把计划判成可用的 lanes（校验不过就回退）。
  function wbResolvePlan(text, ids, prefixOf) {
    var P = wbPlanner();
    if (!P) return { lanes: null, source: "fallback", reason: "没有计划校验器" };
    var map = {
      get: function (k) { return prefixOf[k] || ""; },
      has: function (k) { return Object.prototype.hasOwnProperty.call(prefixOf, k); },
    };
    return P.resolvePlan(text, ids, map);
  }

  // 记住这次用到的窗口名，下一轮分析时把它们作为「可复用的窗口」告诉 AI。
  function workbenchRememberLanes(lanes) {
    WB.knownWindows = (lanes || []).map(function (la) {
      var last = la.cards && la.cards.length ? la.cards[la.cards.length - 1].id : "";
      return { key: la.key || la.prefix || "", lastCard: last, lastAt: "刚刚" };
    });
  }

  // 铺「多行队列」：一行 = 一路 = 一个对话窗口。
  // 「一次喂几张」只影响同一路内第几张起要排队：这一路的第一批是要一起交给
  // 这个窗口的，所以不标排队；从第二批起标「排队中 · 等 <它前面那一批的同位卡>」。
  function workbenchRenderLanes(runEl, stepsEl, lanes, decided) {
    var perBatch = WB.batchMode ? Number.MAX_VALUE : Math.max(1, WB.batchSize || 1);
    var head = "";
    if (decided) {
      var isFb = decided.source !== "ai";
      var label = decided.source === "pending"
        ? "按区域分组 · 复核中"
        : (isFb ? "回退 · 按区域分组" : "分析窗口分的");
      var why = decided.reason ? "：" + esc(decided.reason) : "";
      head = '<p class="wb-plan-note' + (isFb ? " is-fallback" : "") + '"><b>' + esc(label) + "</b>" +
        why + "（共 " + (lanes || []).length + " 个窗口）</p>";
    }
    stepsEl.innerHTML = head + '<div class="wb-lanes">' + (lanes || []).map(function (la, li) {
      return '<div class="wb-lane" data-wb-lane="' + li + '" data-wb-lane-key="' + esc(la.key || la.prefix || "") + '">' +
        '<div class="wb-lane-name">' + esc(la.prefix || la.key || "") +
        (la.why ? '<span class="wb-lane-why">' + esc(la.why) + "</span>" : "") + '</div>' +
        '<ol class="wb-lane-cards">' + la.cards.map(function (o, i) {
          var queued = i >= perBatch;
          var st = queued ? "wb-step-queued" : "wb-step-pending";
          var waitNote = queued
            ? '<span class="wb-step-why">排队中 · 等 ' + esc(la.cards[i - perBatch].id) + '</span>'
            : "";
          return '<li class="wb-step ' + st + '" data-wb-step="' + esc(o.id) + '"' +
            (queued ? ' data-wb-queued="1"' : '') + '>' +
            '<span class="wb-step-i">' + (i + 1) + '</span>' +
            '<span class="wb-step-id">' + esc(o.id) + '</span>' +
            '<span class="wb-step-title">' + esc(o.title) + '</span>' + waitNote + '</li>';
        }).join("") + '</ol></div>';
    }).join("") + '</div>';
  }

  // 分析收尾：把 order 同步回 dragPool（保持用户手动摆的卡位不变）→ 记日志 → 放开「开始执行」。
  function workbenchFinishAnalyze(useBatches) {
    try {
      var analyzedIds = (WB.order || []).map(function (o) { return o.id; });
      if (analyzedIds.length) {
        (WB.dragPool || []).length = 0;
        analyzedIds.forEach(function (x) { if (WB.dragPool.indexOf(x) === -1) WB.dragPool.push(x); });
      }
    } catch (err) { /* 不影响执行 */ }
    var laneN = (WB.lanes || []).length;
    workbenchLog("分析完成。" + (useBatches
      ? "卡已分成 " + laneN + " 条队列（每条一个对话窗口），每条队列一次交给它 " +
        (WB.batchMode ? "全部卡" : (WB.batchSize || 1) + " 张") + "。"
      : "串行 / 并行两种建议已排好，确认后点「开始执行」。"));
    var start = WB.el.querySelector("[data-wb-start]");
    if (start) start.disabled = !(WB.order || []).length;
    workbenchRefreshModeBtn();
  }

  // 分析：先让一个「分析窗口」判断怎么分（并行时），再按它的计划铺队列。
  // 串行不需要判断，直接走服务端的确定性排序。
  function workbenchAnalyze() {
    if (!wbPresent()) return;
    var ids = WB.dragPool || [];
    if (!ids.length) { workbenchLog("请先把卡拖进队列。"); return; }
    // 看板分批模式：把 dragPool 切成若干批，整批交给 Agent 自主处理。
    // 分批是「并行」下的开关（界面只在并行时显示）——串行不叠加分批。
    // 「每批 1 张」不退回旧并行：旧并行 cap=maxParallel 会同时放多张（用户选
    // 「一张一张来」却看到两张）。1 走「多行队列 + 执行限速 cap=1」（见 workbenchPump）。
    var viewMode = (WB.el.querySelector("input[name=wb-mode]:checked") || {}).value || "serial";
    var useBatches = viewMode === "parallel" && (WB.batchMode || WB.batchSize > 1);
    var body;
    if (useBatches) {
      var batches = [];
      var bs = Math.max(1, WB.batchSize || 1);
      for (var bi = 0; bi < ids.length; bi += bs) batches.push(ids.slice(bi, bi + bs));
      body = { ids: ids.slice(), order: ids.slice(), batches: batches };
    } else {
      body = { ids: ids.slice(), order: ids.slice() };
    }
    postJson(wbUrl("api/workbench/analyze"), body, function (res, status) {
      if (status !== 200 || !res || !res.ok) {
        workbenchLog((res && res.error) || "分析失败");
        return;
      }
      var stepsEl = WB.el.querySelector("[data-wb-steps]");
      var runEl = WB.el.querySelector("[data-wb-run]");
      if (!stepsEl || !runEl) return;
      if (useBatches && res.batches) {
        WB.batches = res.batches;
        WB.mode = "parallel"; // 分批=批内可并行（Agent 自主规划批内）
        // 把批拍平成 order，每张带 batch 序号；显示时按批分组。
        WB.order = [];
        res.batches.forEach(function (b, bi) {
          b.cards.forEach(function (c, ci) {
            WB.order.push({
              id: c.id, title: c.title, prefix: c.prefix || "",
              why: b.reason || "", batch: bi, batchPos: ci, batchN: b.cards.length,
              active: false, done: false,
            });
          });
        });
        // 「路」= area 前缀。一路一个会话窗口，路与路同时推进（与服务端 lanes 对齐）。
        // 分批只决定「一次喂几张」，不决定窗口数 —— 这是用户报「选了并行却只有一个窗口」的根因修复。
        // 注意：这里**不预设** WB.lanes，交给下面「整批全交 / 分析窗口 / 回退」三条路各自定。
        runEl.hidden = false;
        runEl.classList.add("wb-run-parallel");
        // 并行/分批下 phase、progress 那行整体隐藏（与「每批 1 张」一致）
        runEl.querySelector("[data-wb-phase]").textContent = "";
        runEl.querySelector("[data-wb-progress]").textContent = "";

        // 「整批全交 / 分析窗口 / 回退」三条路统一在 workbenchPlanAndRender 里决定，
        // 分批与不分批共用同一套判断，避免两条路径两套逻辑。
        workbenchPlanAndRender(runEl, stepsEl);
      } else {
        // 旧模式：服务端给 serial/parallel，串/并行择一
        WB.batches = null;
        var mode = (WB.el.querySelector("input[name=wb-mode]:checked") || {}).value || "serial";
        WB.mode = mode === "parallel" ? "parallel" : "serial";
        var seq = WB.mode === "parallel" ? res.parallel : res.serial;
        var order = seq.map(function (s) {
          return { id: s.id, title: s.title, prefix: s.prefix, why: s.why || "", round: s.round || 0, active: false, done: false };
        });
        WB.order = order;
        runEl.hidden = false;
        if (WB.mode === "parallel") {
          // 并行 = 多个任务队列：一路一行。卡在**行内横向**排（左→右=该路执行顺序），
          // 多路队列**从上往下叠**。这段说明文字模块（phase/progress）整行隐藏。
          runEl.classList.add("wb-run-parallel");
          runEl.querySelector("[data-wb-phase]").textContent = "";
          runEl.querySelector("[data-wb-progress]").textContent = "";
          // 没分批的并行也走分析窗口：分批与否只影响「一次喂几张」，
          // 「怎么分窗口、会不会冲突」都该由同一个判断方决定，不能两条路径两套逻辑。
          workbenchPlanAndRender(runEl, stepsEl);
          return;
        }
        {
          runEl.classList.remove("wb-run-parallel");
          runEl.querySelector("[data-wb-phase]").textContent = "串行执行";
          runEl.querySelector("[data-wb-progress]").textContent = "已选 " + res.total + " 件 · 待开始";
          // 串行没有「路」：必须把上一轮并行留下的 lanes 清掉。
          // 留着的话 wbConvKey 会拿旧 lane.key 当会话键 —— 串行的卡就接进上轮
          // 某个并行窗口的会话里，而「执行台」那条永远建不起来（窗口复用错位）。
          WB.lanes = [];
          stepsEl.innerHTML = order.map(function (s, i) {
            return '<li class="wb-step" data-wb-step="' + esc(s.id) + '"><span class="wb-step-i">' +
              (i + 1) + "</span><span class=\"wb-step-id\">" + esc(s.id) + "</span>" +
              '<span class="wb-step-title">' + esc(s.title) + "</span>" +
              '<span class="wb-step-why">' + esc(s.why || "") + "</span></li>";
          }).join("");
        }
      }
      // 串行分支直接走到这里收尾；并行/分批分支在上面各自 return 时已自行收尾。
      // 分析完成 → 更新工作台顺序，并重画「右缘→下一张左缘」的顺序箭头。
      // **不改动用户手动摆放的卡片位置**——画布顺序跟随工作台排好箭头即可。
      workbenchFinishAnalyze(false);
    });
  }

  // 开始执行：串行一次一件；并行则「一路一个对话窗口、多路同时推进」。
  // 并行下「一次喂几张」只是同一路内一批的张数，不改变窗口数。
  function workbenchStart() {
    if (!wbPresent() || WB.run) return;
    if (!WB.order.length) { workbenchAnalyze(); return; }
    // 并行（含分批）一律走按路并发的执行器：路数 = 窗口数。
    if (WB.mode === "parallel") { workbenchStartLanes(); return; }
    WB.run = true;
    WB.stop = false;
    var start = WB.el.querySelector("[data-wb-start]");
    var stopBtn = WB.el.querySelector("[data-wb-stop]");
    var analyze = WB.el.querySelector("[data-wb-analyze]");
    if (start) start.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (analyze) analyze.disabled = true;
    WB.inflight = {};
    WB.doneCount = 0;
    WB.execOrder = [];
    workbenchLog("开始" + (WB.mode === "parallel" ? "并行" : "串行") + "执行。");
    workbenchPump();
  }

  // 并行执行主循环（分批 / 不分批共用）。
  //
  // ⚠️ 核心语义（2026-11-19 修「选了并行却只有一个窗口」）：
  //   · 「路」= area 前缀，**一路一个对话窗口**（会话键 = wbConvKey → 「路N · 前缀」）；
  //   · 路与路**同时推进**，这才叫并行；窗口数 = 路数，不由「一次喂几张」决定；
  //   · 「一次喂几张」（每批 N 张）= **同一路内**一次 ask 交给 Agent 的卡数。
  //     同路第二批起必须等前一批回来（它们抢同一块地，本就不能同时做）。
  //   旧实现把「一次喂几张」错当成「窗口怎么分」，整批塞进一个固定会话键
  //   （「本批 N 卡」）——于是 4 张卡按每批 2 张分成 2 批时，两批都叫「本批 2 卡」，
  //   撞进同一个窗口；换任何卡数都只有一个窗口。下面按路分发即修掉这个根因。
  function workbenchStartLanes() {
    if (!wbPresent() || WB.run) return;
    WB.run = true;
    WB.stop = false;
    WB.inflight = {};
    WB.doneCount = 0;
    WB.execOrder = [];
    WB.laneCursor = {};
    var start = WB.el.querySelector("[data-wb-start]");
    var stopBtn = WB.el.querySelector("[data-wb-stop]");
    var analyze = WB.el.querySelector("[data-wb-analyze]");
    if (start) start.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (analyze) analyze.disabled = true;
    var nLanes = (WB.lanes || []).length || 1;
    workbenchLog("开始并行执行：" + nLanes + " 条队列 → " + nLanes + " 个对话窗口同时推进。");
    // 每条路各起一条独立推进链；它们互不等待。
    workbenchLaneStep(0);
    for (var li = 1; li < nLanes; li++) workbenchLaneStep(li);
  }

  // 推进某一路（laneIndex）：取该路当前这一批 → claim 全批 → 一次 ask（携整批清单）
  // → release 全批 → 该路进下一批。**只推进这一条路**，不等别的路。
  function workbenchLaneStep(laneIndex) {
    if (!WB.run) return;
    if (WB.stop) { workbenchFinish("已停止"); return; }
    var lane = (WB.lanes || [])[laneIndex];
    if (!lane) { workbenchCheckDone(); return; }
    var perBatch = Math.max(1, WB.batchSize || 1);
    if (WB.batchMode) perBatch = lane.cards.length || 1; // 整批全交：一路一次全给
    var cursor = WB.laneCursor[laneIndex] || 0;
    var batchCards = lane.cards.slice(cursor, cursor + perBatch);
    if (!batchCards.length) { workbenchCheckDone(); return; } // 这条路跑完了

    var claimed = [];
    var stepEls = {};
    batchCards.forEach(function (o) {
      o.active = true;
      WB.inflight[o.id] = o;
      stepEls[o.id] = findWbStep(o.id);
    });

    // 逐张 claim（同路内必须都领到才能整批交给 Agent）
    function claimNext(k) {
      if (!WB.run) return;
      if (WB.stop) { workbenchFinish("已停止"); return; }
      if (k >= batchCards.length) { askLaneBatch(); return; }
      var o = batchCards[k];
      claimForWorkbench(o.id, function (ok, status, why) {
        if (!WB.run) return;
        if (!ok) {
          // 领不到（同区域被占 / 别人抢走）：撤回本批已领的，等一会重试这条路。
          batchCards.forEach(function (x) {
            x.active = false;
            delete WB.inflight[x.id];
          });
          workbenchMark(stepEls[o.id], "wait", "未开工（" + ((why || "").slice(0, 40)) + "）");
          if (o.badTries === undefined) o.badTries = 0;
          o.badTries += 1;
          var by = WB.by || flowActor();
          var rel = claimed.slice();
          (function releaseThen(k2) {
            if (k2 >= rel.length) {
              if (o.badTries <= 8) {
                workbenchLog("路「" + lane.prefix + "」的「" + o.id + "」还没就绪（" + (why || status) + "），稍后重试。");
                setTimeout(function () { if (WB.run) workbenchLaneStep(laneIndex); }, 1500);
              } else {
                // 搁置也要把这些卡从「未完成」里摘出去，否则 WB.run 永远复位不了。
                workbenchLog("路「" + lane.prefix + "」多次领不到（" + (why || status) + "），先搁置这条路剩下的 " + batchCards.length + " 张。");
                batchCards.forEach(function (x) {
                  x.active = false;
                  x.done = true;
                  x.skipped = true;
                  delete WB.inflight[x.id];
                  workbenchMark(stepEls[x.id], "skip", "搁置：" + ((why || status || "").slice(0, 40)));
                });
                WB.doneCount = WB.order.filter(function (o) { return o.done; }).length;
                WB.laneCursor[laneIndex] = cursor + batchCards.length;
                workbenchCheckDone();
              }
              return;
            }
            releaseForWorkbench(rel[k2].id, by, function () { releaseThen(k2 + 1); });
          })(0);
          return;
        }
        claimed.push(o);
        workbenchMark(stepEls[o.id], "asking", "已领·待交窗口");
        claimNext(k + 1);
      });
    }
    claimNext(0);

    // 整批 claim 完 → 一次 ask 携整批清单，会话键 = 这一路（一个窗口）
    function askLaneBatch() {
      if (!WB.run) return;
      var listText = batchCards.map(function (c) {
        return "- " + c.id + " " + (c.title || "");
      }).join("\n");
      var ledgerPath = harnessEnv() ? harnessEnv().dir : "";
      var rehearsal = wbRehearsalOn();
      var text = rehearsal
        ? wbRehearsalNote(batchCards.map(function (c) { return c.id; }), ledgerPath) +
          "\n本条队列是「" + (lane.prefix || "未分区域") + "」，共 " + lane.cards.length +
          " 张，本次交给你 " + batchCards.length + " 张：\n" + listText
        : "自动工作台正在并行推进你负责看板的多条队列之一——本条队列是「" + (lane.prefix || "未分区域") +
        "」（同一条数据链路/同一块地），共 " + lane.cards.length + " 张卡，本次交给你 " + batchCards.length + " 张。\n" +
        "你可以自主决定这 " + batchCards.length + " 张的处理顺序（也可以按你的判断同时推进）。\n" +
        "其它队列由别的窗口同时在做，你**只管这一条队列**，不要去动其它队列的卡。\n\n" +
        "要求：逐张真的去处理，并在台账 ledger.json 里收口（从 board.config.json 车道 stages 取收口状态，\n" +
        "bug→fixed/closed、feature→shipped、risk→resolved/accepted，或至少推进到靠后阶段），让队列能往下走。\n\n" +
        "台账文件在：" + (ledgerPath || "（当前看板目录）") + "\\ledger.json\n" +
        "本次交给你的卡片清单：\n" + listText + "\n\n" +
        "这是真实执行，不是分析建议：请实际处理并更新台账，处理完简要回报你动过的每张卡和它现在的状态。";
      // fresh:false = 复用这条队列已有的对话窗口（窗口复用）。
      // 以前这里是 true，意味着**每批都新开一个会话**——一条路里 3 张卡、每批 1 张，
      // 就是 3 个窗口，而不是「一个窗口接三次活」。那正是用户说的
      // 「应该按分类复用窗口」没做到的地方。
      // 复用键就是计划给的 lane.key（见 wbConvKey），所以同类任务会回到同一个窗口。
      // 宿主侧对「映射表里的会话已被删」有兜底（会自动新建），这里不必自己防。
      var fresh = false, inline = true;
      var finished = false;
      // 窗口名 = 这一路的复用键（计划给的 lane.key）**本身**，不再拼「路 · 前缀」那种
      // 第二段 —— 左侧只该看到一个窗口名，而不是「名称 · 名称」。
      var laneKey = wbConvKey(batchCards[0].id) || ("路 · " + (lane.prefix || ""));
      harnessPostWithCapture(laneKey, text, fresh, function (result) {
        if (finished) return;
        if (!result.ok) {
          finished = true;
          workbenchLog("路「" + lane.prefix + "」发送失败：" + ((result && result.error) || "未知错误"));
          finishLaneBatch({ ok: false, error: (result && result.error) || "发送失败" });
          return;
        }
        var askId = result.askId || "";
        WP_ANSWERS[askId] = {
          by: WB.by || flowActor(),
          resolve: function (payload) {
            if (finished) return;
            finished = true;
            delete WP_ANSWERS[askId];
            finishLaneBatch({ ok: !payload.error, text: payload.text || "", error: payload.error || "" });
          },
        };
        setTimeout(function () {
          if (!finished) { finished = true; delete WP_ANSWERS[askId]; finishLaneBatch({ ok: false, error: "等 Harness 回答超时" }); }
        }, 300000);
      }, null, inline, "", fresh, { sessionTitle: laneKey, kind: lane.prefix || "" });

      // 本批收尾：逐张 release → 记 done → 该路进下一批（不碰别的路）
      function finishLaneBatch(res) {
        if (!WB.run) return;
        var okAsk = res.ok;
        var verdict = okAsk ? (res.text || "（无文字结论）") : (res.error || "处理未成功");
        batchCards.forEach(function (c) {
          workbenchMark(stepEls[c.id], okAsk ? "done" : "wait", verdict.slice(0, 90));
          c.active = false;
        });
        workbenchLog("路「" + lane.prefix + "」第 " + (Math.floor(cursor / perBatch) + 1) + " 批：" +
          (okAsk ? "窗口处理完成" : "处理失败——" + verdict.slice(0, 60)));
        var rel = claimed.slice();
        (function releaseAll(k) {
          if (!WB.run) return;
          if (k >= rel.length) {
            rel.forEach(function (c) {
              c.done = true;
              delete WB.inflight[c.id];
            });
            WB.doneCount = WB.order.filter(function (o) { return o.done; }).length;
            updateWbProgress();
            if (!WB.run) return;
            WB.laneCursor[laneIndex] = cursor + batchCards.length;
            setTimeout(function () { if (WB.run) workbenchLaneStep(laneIndex); }, 400);
            return;
          }
          releaseForWorkbench(rel[k].id, WB.by || flowActor(), function () { releaseAll(k + 1); });
        })(0);
      }
    }
  }

  // 所有路都跑完了 → 收尾。
  function workbenchCheckDone() {
    if (!WB.run) return;
    if (WB.order.every(function (o) { return o.done; })) workbenchFinish("全部执行完成");
  }

  // 推进一步 / 若干步。
  //
  // 核心循环：只要还没停、没到上限（并行模式下同时放行到 maxParallel 路），
  // 就挑「还没跑、且现在可领」的卡 launch：claim → 交给 Harness → release。
  // 串行 cap=1 一次一件；并行 cap=maxParallel 一次放多件（不同区域）。
  //
  // ⚠️ 关键语义：flow.mjs 里一张卡要真的「做完」才能让同区域下一件顶上 ——
  // 这个「做完」= 它在台账里的状态收口（离开未收口集合），不是 release。
  // 所以工作台交给 Harness 的 prompt 会要求它「处理并更新台账（收口/推进状态）」。
  // 单张卡 release 只是把占用还给系统；链能否继续，取决于卡是否真的被收口。
  function workbenchPump() {
    if (!WB.run) return;
    if (WB.stop) { workbenchFinish("已停止"); return; }

    // 上限 = 同时放行几张：
    //   · 串行 → 1
    //   · 并行 + 「一次喂几张 = 每批 1 张（含默认/不分批）」→ 1（真正一张一张来，绝不两张同时）
    //   · 并行 + 每批 >1 或整批 → 不进这里（workbenchStart 走分批执行）
    var cap = 1;
    if (WB.mode === "parallel" && (WB.batchSize === undefined || WB.batchSize <= 1)) cap = 1;
    else if (WB.mode === "parallel") cap = (WB.steps && WB.steps.maxParallel) || 3;

    // 发起一张卡：claim → 交给 Harness → release。
    function launch(next) {
      var id = next.o.id;
      var stepEl = findWbStep(id);
      next.o.active = true;
      next.o.orderN = (WB.execOrder || []).length;
      if (WB.execOrder) WB.execOrder.push(id);
      WB.inflight[id] = next.o;
      claimForWorkbench(id, function (ok, status, why) {
        if (!WB.run) return;
        if (!ok) {
          // 409（在排队 / 同区域被占 / 被人抢走）：此刻不能开工。
          next.o.active = false;
          delete WB.inflight[id];
          if (next.o.badTries === undefined) next.o.badTries = 0;
          next.o.badTries += 1;
          workbenchMark(stepEl, "wait", "未开工（第 " + next.o.badTries + " 次）：" + ((why || "").slice(0, 40)));
          if (next.o.badTries <= 8) {
            workbenchLog("「" + id + "」还没就绪（" + (why || status) + "），稍后重试。");
            setTimeout(function () { if (WB.run) workbenchPump(); }, 1500);
          } else {
            workbenchLog("「" + id + "」多次领不到（" + (why || status) + "），先搁置。");
          }
          return;
        }
        workbenchMark(stepEl, "asking", "处理中");
        var beforeStatus = (D.items[id] && D.items[id].status) || "";
        workbenchAsk(itemTitle(id), function (res) {
          var okAsk = res && res.ok;
          var verdict = okAsk ? (res.text || "（无文字结论）") : (res && res.error) || "拿不到回答";
          // 问完后回读台账，确认这张卡有没有真的收口/推进 —— 只拿到回答不算数，
          // 同区域下一张卡能不能接上取决于状态是否动过（flow.mjs 只认「离开未收口集合」）。
          var prev = beforeStatus;
          function finishVerdict(afterStatus, note) {
            var moved = afterStatus !== prev;
            var closed = moved && !isOpenWbStatus(afterStatus);
            var tail = closed ? " · 已收口" : (moved ? " · 状态：'" + prev + "'→'" + afterStatus + "'" : " · 仍在 " + (afterStatus || prev) + "，未收口");
            workbenchMark(stepEl, okAsk ? "done" : "wait", (verdict.slice(0, 90) + tail).slice(0, 140));
            workbenchLog("「" + id + "」" + (okAsk ? "处理完成" : "处理未成功") + tail + "：" + verdict.slice(0, 60));
            if (okAsk && moved && !closed) workbenchLog("「" + id + "」推进到 " + afterStatus + "，同区域下一张应可接上。");
            if (okAsk && !moved && note) workbenchLog(note);
          }
          getLedgerBoard(function (lr, lstatus) {
            var afterStatus = (lr && lr.items && lr.items[id] && lr.items[id].status) || "";
            finishVerdict(afterStatus, "");
          });
          var by = (res && res.by) || WB.by || flowActor();
          releaseForWorkbench(id, by, function (releaseOk) {
            next.o.done = true;
            next.o.result = verdict;
            next.o.active = false;
            delete WB.inflight[id];
            WB.doneCount += 1;
            updateWbProgress();
            if (!WB.run) return;
            setTimeout(function () { if (WB.run) workbenchPump(); }, 400);
          });
        }, wbConvKey(id), id);
      });
    }

    // 每一轮把「现在可开工」的卡尽量放满 cap：
    // 串行 = 每轮一件、按 order；并行 = 每轮多件、不同前缀、按 round 交错。
    // 互斥仍由 serve 的 claim 保证；这里尽量少撞 409。
    for (;;) {
      var activeCount = WB.order.filter(function (o) { return o.active; }).length;
      if (activeCount >= cap) break;                    // 满了，等回收
      var rest = WB.order.map(function (o, idx) { return { o: o, idx: idx }; })
        .filter(function (x) { return !x.o.done && !x.o.active; });
      if (!rest.length) {
        if (WB.order.every(function (o) { return o.done; })) workbenchFinish("全部执行完成");
        else if (activeCount === 0) workbenchFinish("没更多可开工的卡");
        break;
      }
      rest.sort(function (a, b) { return (a.o.round || 0) - (b.o.round || 0) || a.idx - b.idx; });
      var next = null;
      for (var i = 0; i < rest.length; i++) {
        var cand = rest[i];
        if (WB.mode === "serial") { next = cand; break; }
        var blocker = WB.order.some(function (o) {
          return o.prefix === cand.o.prefix && o.id !== cand.o.id && !o.done && (o.round || 0) < (cand.o.round || 0);
        });
        if (!blocker) { next = cand; break; }
      }
      if (!next) {
        if (activeCount === 0) workbenchFinish("同轮互斥，暂无法推进");
        break;
      }
      launch(next);
    }
  }

  // 领一件（复用 /api/flow/claim）。记录 WB.by 供交还用。
  function isOpenWbStatus(status) {
    // 与 flow.mjs 的 OPEN_STATUSES 保持一致：这些状态视为「未收口」。
    var open = ["open", "doing", "verify", "watch", "planned", "review", "watching", "mitigating"];
    return open.indexOf(String(status || "")) > -1;
  }

  function getLedgerBoard(done) {
    // /api/board 返回当前 ledger.json 原文（{items,history,...}）。
    getJson(wbUrl("api/board"), function (res, status) {
      done(res && res.items ? res : null, status);
    });
  }

  function claimForWorkbench(id, done) {
    postJson(flowUrl("claim"), { id: id, by: flowActor() }, function (res, status) {
      if (status === 200 && res && res.ok) { WB.by = res.by || flowActor(); done(true, status); return; }
      done(false, status, (res && res.error) || "");
    });
  }

  function releaseForWorkbench(id, by, done) {
    postJson(flowUrl("release"), { id: id, by: by }, function (res, status) {
      done && done(status === 200);
    });
  }

  // 把一张卡交给 Harness，按 askId 收回答。支持并发：多个 ask 同时挂着，
  // 谁回来谁触发自己的回调 —— 用 WP_ANSWERS[askId] 对应每一个。
  var WP_ANSWERS = {};
  // 并行「路」模式下，每张卡归属哪一路 → 会话键=该路。
  // 同一路的卡都复用同一个会话键，所以左侧会话列表一条路一条对话；非并行（无 lanes）返回空。
  //
  // ⚠️ 会话键必须用**计划给的 key**（跨轮次稳定），不能用「路N · 前缀」这种按位置拼的：
  // 位置会随这次分析的顺序变（AI 可能把重构成了 路1、数据源 路2），
  // 位置一变键就变，窗口复用就永远接不上，等于每轮全新开窗口。
  function wbConvKey(id) {
    if (!WB.lanes || !WB.lanes.length) return "";
    for (var i = 0; i < WB.lanes.length; i++) {
      var la = WB.lanes[i];
      for (var j = 0; j < la.cards.length; j++) {
        if (la.cards[j].id === id) return la.key || la.prefix || ("路" + (i + 1));
      }
    }
    return "";
  }
  // 同 __wb：只给测试/扩展用，正常页面不读它。
  try { window.__wbConvKey = wbConvKey; } catch (e) {}
  // convKey：并行按「路」执行时，同一路的卡共用同一个会话键（左侧会话列表就
  // 是每路一条对话）。串行没有「路」，一律落到固定的「执行台」那条会话 ——
  // 以前缺省空 → 回落成卡 id，于是串行跑 N 张卡就新开 N 个窗口，
  // 用户问「除了调度台，其他对话会复用吗」时的答案就是「不会」，这正是要修的。
  // itemTitle：卡片标题（不带 id）。
  // cardId    ：真正的卡片编号。以前这里没有这个参数，只靠
  //             `itemTitle.split("·")[0]` 去猜 —— 而 itemTitle() 返回的**就是标题**，
  //             标题里没有「·」时 cleanId 等于整条标题，prompt 里就写成
  //             「卡片 id：FileCopy2 复制目录必定失败…」，窗口拿这个去 ledger.json
  //             里根本定位不到卡。现在由调用方把 id 明确传进来。
  function workbenchAsk(itemTitle, done, convKey, cardId) {
    if (!harnessEnv()) { done({ ok: false, error: "要在 Harness 里打开才能问 AI" }); return; }
    var env = harnessEnv();
    var ledgerPath = env && env.dir ? env.dir : "";
    // 会话键：有 convKey 就用它（并行=每路一条独立对话）；串行=固定「执行台」。
    var convTitle = convKey || WB_EXEC_KEY;
    var cleanId = String(cardId || "").trim() || String(itemTitle || "").split("·")[0].trim() || "";
    var rehearsal = wbRehearsalOn();
    var text = rehearsal
      ? wbRehearsalNote([cleanId], ledgerPath) + "\n这张卡是：【" + itemTitle + "】"
      : "自动工作台正在逐张处理队列你负责的看板卡【" + itemTitle + "】。\n" +
      "这是真实执行，不是分析建议：请实际去处理这条卡并更新台账，让队列能往下走。\n\n" +
      "台账文件在：" + (ledgerPath || "（当前看板目录）") + "\\ledger.json（卡片 id：" + cleanId + "）。\n" +
      "要求：\n" +
      "1) 先读 ledger.json，定位 " + cleanId + " 这条卡（也在 board.config.json 里确认它的车道 lane 与阶段 stages）；\n" +
      "2) 实际动手解决它（排查/修改/清理/更新），拿真实证据，不要只给空泛建议；\n" +
      "3) 处理完把这条卡在 ledger.json 里的状态收口：从 board.config.json 里该车道的 stages 取一个「未列在 stages 的收口状态」（如 bug 车道 fixed/closed、feature 车道 shipped、risk 车道 resolved/accepted），把 status 改成它，或至少推进到相对靠后的阶段；\n" +
      "4) 简要回报你做了什么、改动了什么、这条卡现在的状态。\n" +
      "不要跳过处理直接写建议 —— 队列里同区域的下一张卡正等这一张真正收口才能开工。";
    // fresh:false = 复用固定「执行台」那条会话。
    // 以前这里是 true：每张卡新开一个窗口，串行跑 10 张就建 10 条会话，
    // 用户问「除了调度台，其他对话会复用吗」时的答案是「不会」—— 这就是那条根因。
    // 串行本来就是一张接一张，交给同一个窗口接着做，上下文还是热的。
    var fresh = false;
    var inline = true;
    var askId = "";
    var finished = false;
    var by = WB.by || flowActor();
    harnessPostWithCapture(convTitle, text, fresh, function (result) {
      if (!result.ok) {
        if (!finished) { finished = true; done({ ok: false, error: result.error || "发送失败" }); }
        return;
      }
      askId = result.askId || "";
      // 注册这个 askId 的回答回调
      WP_ANSWERS[askId] = {
        by: by,
        resolve: function (payload) {
          if (finished) return;
          finished = true;
          delete WP_ANSWERS[askId];
          done({ ok: !payload.error, text: payload.text || "", error: payload.error || "", by: by });
        },
      };
      // 兜底超时
      setTimeout(function () {
        if (!finished) { finished = true; delete WP_ANSWERS[askId]; done({ ok: false, error: "等 Harness 回答超时", by: by }); }
      }, 240000);
    }, null, inline, "", fresh, { sessionTitle: convTitle, kind: "逐张执行" });
  }

  function workbenchAskListener(event) {    if (event.origin !== window.location.origin) return;
    var d = event.data;
    if (!d || d.type !== "ops-board/answer") return;
    var rec = WP_ANSWERS[d.askId];
    if (rec) rec.resolve(d);
  }
  window.addEventListener("message", workbenchAskListener);

  // 简化版 harnessPost：直接构造 payload 调 /ops-board/ask，不碰 AI 面板状态。
  //
  // item / title / sessionTitle 三个字段的分工（以前 item 和 title 传的是同一个字符串，
  // 宿主按「item · title」拼标题，于是左侧会话名全是「名称 · 名称」）：
  //   item        = **复用键**（宿主拿它在映射表里找会话），必须是稳定的窗口名；
  //   title       = 显示用的补充说明，**不能等于 item**，否则又拼成重复的两段；
  //   sessionTitle= 完整的会话名。宿主有它就**优先用**（index.js askInHarness），
  //                 于是左侧只显示窗口名本身，不再有「· 后面那半截」。
  function harnessPostWithCapture(itemTitle, text, fresh, done, skillName, inline, reuseSessionId, withContext, opts) {
    var env = harnessEnv();
    // 没有 __OPS_HARNESS__ 说明这页不是被 Harness 面板加载的（直接开 dist/index.html、
    // 或 serve.mjs 的裸地址）。此时 /ops-board/ask 根本不存在，env 是 null —— 原来直接读
    // env.id 会抛 TypeError，界面上表现为「点了开始执行什么都没发生」，连日志都没有。
    // 这里改成明确报错交回调用方，让工作台把原因写进日志。
    if (!env) {
      done({
        ok: false,
        error: "当前页面不在 Harness 面板里（没有 __OPS_HARNESS__），工作台无法把卡交给对话窗口。请从 Harness 左侧栏打开这块看板再执行。",
      });
      return;
    }
    var askId = "ask-w-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    // 三个字段各司其职，缺一就会退化成「名称 · 名称」：
    //   item        复用键（宿主拿它查映射表，必须稳定）
    //   title       旧宿主的兜底后缀（它按「item · title」拼），绝不能等于 item
    //   sessionTitle 新宿主直接拿来当会话名 → 左侧只显示窗口名本身
    var opt = opts || {};
    var keyName = String(itemTitle || "").trim() || "整本台账";
    var wantName = String(opt.sessionTitle || "").trim() || keyName;
    var kind = String(opt.kind || "").trim();
    // 兜底后缀：**任何情况下都不许等于 item**，否则旧宿主拼出来又是重复的两段
    // （「整批全交 · 整批全交」这种，因为整批全交的 prefix 和 key 本来就是同一个词）。
    // 新宿主有 sessionTitle 会直接用，这一截只在旧宿主（还没转发 sessionTitle）时兜底。
    if (!kind || kind === keyName || kind === wantName) kind = "执行窗口";
    var payload = {
      board: env.id,
      dir: env.dir,
      label: env.label,
      item: keyName,
      title: kind,
      sessionTitle: wantName,
      fresh: !!fresh,
      askId: askId,
      reuseSessionId: reuseSessionId || "",
      inline: !!inline,
      surface: "page",
      question: harnessContext(itemTitle, text, skillName, withContext),
    };
    fetch("/ops-board/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        done({ ok: !!(j && j.ok), askId: askId, error: (j && j.error) || "" });
      })
      .catch(function (e) {
        done({ ok: false, error: String((e && e.message) || e) });
      });
  }

  function updateWbProgress() {
    var prog = WB.el && WB.el.querySelector("[data-wb-progress]");
    if (!prog) return;
    var doneN = WB.order.filter(function (o) { return o.done; }).length;
    var totalN = WB.order.length;
    var activeN = WB.order.filter(function (o) { return o.active; }).length;
    prog.textContent = doneN + " / " + totalN + " 已完成" + (activeN ? " · " + activeN + " 在跑" : "");
  }

  function workbenchMark(stepEl, cls, note) {
    if (!stepEl) return;
    // 也清掉「排队中」：这张卡一旦真的轮到它跑，虚线边和「等 XXX」就不再成立。
    stepEl.classList.remove("wb-step-pending", "wb-step-running", "wb-step-asking", "wb-step-done", "wb-step-skip", "wb-step-wait", "wb-step-queued");
    if (stepEl.getAttribute("data-wb-queued")) stepEl.removeAttribute("data-wb-queued");
    stepEl.classList.add("wb-step-" + cls);
    if (note) {
      var why = stepEl.querySelector(".wb-step-why");
      if (why) why.textContent = note;
    }
    var prog = WB.el && WB.el.querySelector("[data-wb-progress]");
    var doneN = WB.order.filter(function (o) { return o.done; }).length;
    var totalN = WB.order.length;
    if (prog) prog.textContent = doneN + " / " + totalN + " 已完成";
  }

  function workbenchFinish(reason) {
    WB.run = false;
    var stopBtn = WB.el && WB.el.querySelector("[data-wb-stop]");
    var start = WB.el && WB.el.querySelector("[data-wb-start]");
    var analyze = WB.el && WB.el.querySelector("[data-wb-analyze]");
    if (stopBtn) stopBtn.disabled = true;
    var prog = WB.el && WB.el.querySelector("[data-wb-progress]");
    if (prog) prog.textContent = reason;
    if (start) start.disabled = true;
    if (analyze) analyze.disabled = false;
    workbenchLog("工作台：" + reason);
  }

  function workbenchStop() {
    WB.stop = true;
    workbenchLog("停止请求已发，将在当前这张卡跑完后停下。");
  }

  function workbenchLog(msg) {
    // 落到步骤区顶部的一行「状态日志」，不弹窗
    var head = WB.el && WB.el.querySelector("[data-wb-phase]");
    if (head && typeof msg === "string") {
      var span = document.createElement("span");
      span.className = "wb-log";
      span.textContent = msg;
      head.appendChild(span);
    }
  }

  function findWbStep(id) {
    return WB.el && WB.el.querySelector('[data-wb-step="' + id + '"]');
  }

  function itemTitle(id) {
    var it = D.items && D.items[id];
    return it ? (it.title || id) : id;
  }

  // 初始化：铺一次候选池；radio 切换刷新按钮态。
  if (wbPresent()) {
    // 搁置清单要在第一次铺池**之前**读回来，否则刷新时会先按「全部在备选」画一帧，
    // 再跳成搁置态 —— 视觉上闪一下，且那一帧里搁置的卡是能被拖走的。
    WB.shelved = loadShelf();
    workbenchRefresh();
    var wbModes = WB.el.querySelectorAll("input[name=wb-mode]");
    Array.prototype.forEach.call(wbModes, function (r) {
      r.addEventListener("change", function () {
        workbenchRefreshModeBtn();
      });
    });
    // 分批粒度：用户选 <select data-wb-batch-size> → 写入 WB.batchSize/batchMode。
    var wbBatchSel = WB.el.querySelector("[data-wb-batch-size]");
    if (wbBatchSel) {
      wbBatchSel.addEventListener("change", function () {
        var v = Number(wbBatchSel.value);
        WB.batchSize = v === -1 ? 99999 : (v || 1);
        WB.batchMode = v === -1;
        workbenchLog("分批已设：" + (v === -1 ? "整批全交（一条队列的全部卡一次交给它的窗口）" : v === 1 ? "每批 1 张（每个窗口一次拿一张，同路排队推进）" : "每批 " + WB.batchSize + " 张（每个窗口一次拿这么多，同路分批推进）。"));
      });
    }
  }

  // 流程画布已于 2026-11-18 删除，bindFlowDrag / flowReorderCanvas 一并清除。
  // 执行顺序现在只由工作台候选池决定（WB.dragPool），不再有第二处可拖拽的图。

  // ─────────────────────── AI 面板 ───────────────────────

  var panel = $("ai-panel");
  var msgsEl = $("ai-msgs");
  var inputEl = $("ai-input");
  var quickEl = $("ai-quick");
  var ctxEl = $("ai-ctx");
  var hintEl = $("ai-hint");
  var sendBtn = $("ai-send");

  var AI = {
    ctx: null,
    skill: null, // 点了某个 skill 的「问 AI」时，这里放 skill 名
    skillScope: false, // 是不是在 Skill 页打开的面板（整页 skill，未指定单条）
    // 风险审核：作用域是「风险车道」，和整本台账不是一回事。
    // 光靠 ctx 表达不了 —— 风险审核的 ctx 是空的，会和整本台账撞同一个
    // 会话键（chatStoreKey / sessionKey 都按 ctx || "__global__" 算），
    // 两边的历史会串在一起。所以单独记一个标记。
    riskScope: false,
    // 需求车道的「和 AI 谈谈要加什么」：同理，ctx 是空的，不单记一个标记
    // 就会和整本台账共用会话键，两边的对话串到一起。
    featureScope: false,
    busy: false,
    fresh: false, // 是否新开会话（由面板上的单选决定，不再靠隐含状态）
    reuseId: "", // 选中的旧会话 id；空表示没选
    sessions: [], // 当前作用域下可继续的会话列表
    shownId: "", // 屏幕上这批消息来自哪条会话（未知时为空）
  };

  // 内联回答：哪些 askId 还在等回答，以及它们对应哪条「正在回答」气泡。
  // 值是该气泡的 body 元素，收到回答时直接往里写。
  var PENDING = {};
  // 等 Harness 回历史请求的回调：reqId -> fn(payload)
  var HISTORY_WAIT = {};
  // 历史请求的「代数」。开面板时会先按映射表要一次，随后认领到本条目自己的
  // 会话又要一次；两次都在飞的时候，先发的那次可能后回来，把后发的正确内容冲掉。
  // 每次发请求 +1，回调里只认最后一次，早于它的一律丢弃。
  var HISTORY_GEN = 0;

  function ctxLabel() {
    if (AI.skill) return "Skill · " + AI.skill;
    if (AI.skillScope) return "整页 Skill";
    if (AI.riskScope) return "风险审核 · 只审风险车道";
    if (AI.featureScope) return "新增功能 · 只谈需求车道";
    if (!AI.ctx) return "整本台账";
    var it = D.items[AI.ctx];
    return it ? AI.ctx + " · " + it.title : "整本台账";
  }

  // ── Harness 专属模式：面板只负责「选动作 / 写问题」，发送后交给 Harness 会话 ──
  // 不打开板子自带的 Cloud 配置：真正的对话和记录都在 Harness 里
  // （由 dsh-ops-board 的 SSE 桥接，按条目复用会话）。

  // 工作台里的「总结项目状态」：动作围绕"总结 + 把变化写回台账"，
  // 不再只是问一句"现在什么情况"。
  var HARNESS_GLOBAL_QUICK = [
    {
      label: "总结并更新台账",
      prompt:
        "先读项目目录和 ledger.json、board.config.json，总结项目当前状态；把确认的变化按原 schema 更新进 ledger.json（条目状态、四段、证据、history、updatedAt、headline/metrics），不要改项目源码。写完后在看板目录里依次跑 node scripts/render.mjs 和 node scripts/verify-board.mjs，确认能渲染，并说明改了哪些条目和文件。",
    },
    {
      label: "只总结，不改台账",
      prompt:
        "先读项目目录和 ledger.json、board.config.json，总结项目当前状态、未收口的问题和风险；这次不要修改 ledger.json。",
    },
    {
      label: "检查台账是否过期",
      prompt:
        "对照项目当前代码、文档和线上状态，检查 ledger.json 里哪些条目或结论已经过期；列出需要更新的条目、证据和建议，不要直接改。",
    },
    {
      label: "更新台账",
      prompt:
        "读项目目录和 ledger.json，把已经确认的变化按原 schema 写回 ledger.json（状态、四段、证据、history、updatedAt、headline/metrics），不要改项目源码；写完后在看板目录里依次跑 node scripts/render.mjs 和 node scripts/verify-board.mjs，并说明改了哪些条目。",
    },
  ];

  // 单个 skill 的快捷动作：作用域严格限定在这一个 SKILL.md 上。
  // 每条 prompt 都点名"只改这一个文件"，因为 agent 看到上下文里的路径很容易
  // 顺手去改同目录的其它 skill —— 那是用户点单个 skill 时没授权的事。
  var HARNESS_SKILL_ONE_QUICK = [
    {
      label: "总结并更新这一个",
      prompt:
        "只处理这一个 SKILL.md（上面给了路径），不要读改同目录的其它 skill。先读它和项目当前代码/文档，判断它现在还能不能用；把确认过期的地方（坐标路径变了、命令改了、描述与现状不符）在本文件内按原格式更新，并逐条列出改了什么。只改这一个文件。",
    },
    {
      label: "只总结，不改文件",
      prompt:
        "只读这一个 SKILL.md（上面给了路径），不要动其它 skill。总结它讲什么、还准不准、有哪些地方已经和现状对不上；这一轮不要修改任何文件。",
    },
    {
      label: "查它和其它 skill 的冲突",
      prompt:
        "以这一个 SKILL.md 为主体，去找它和其它 skill 说法冲突的地方（同一操作两条不同命令、路径或阈值不一致、该做 vs 别做）。逐条列：和哪个 skill 冲突、两边原文、哪个对、依据。只报告，先不要改文件。",
    },
    {
      label: "查它缺什么",
      prompt:
        "只针对这一个 SKILL.md：对照项目最近的实际改动和反复踩的坑，看它漏了什么该写进去的内容。列出建议新增的条目，不要直接改。",
    },
    {
      label: "查它有没有该删的",
      prompt:
        "只针对这一个 SKILL.md：找出里面冗余、重复、已经没人会看的段落，以及更适合放到别处的内容。给出删减建议并说明删了会丢什么，不要直接改。",
    },
  ];

  // 整页 Skill 的快捷动作：跨 skill 的全局检查，作用域是所有 skill。
  var HARNESS_SKILL_QUICK = [
    {
      label: "更新所有 Skill",
      prompt:
        "先读这个项目相关的全部 SKILL.md（含 skill 根里为它写的那些）和项目当前代码/文档，总结每个 skill 现在还能不能用；把确认过期的地方（坐标路径变了、命令改了、描述与现状不符）按 SKILL.md 原格式更新，改完把每个文件改了什么逐条列出来。",
    },
    {
      label: "检查 Skill 冲突",
      prompt:
        "把这些 skill 放在一起比对：哪些讲的是同一件事但说法相反（比如同一个操作给了两条不同命令、路径或阈值不一致、一个说必须做另一个说别做）。按冲突点逐条列：涉及哪几个 skill、各自的原文、哪个是对的、依据是什么。",
    },
    {
      label: "检查冗余重叠",
      prompt:
        "检查这些 skill 之间有没有重复或重叠：同一段知识被写了两遍、一个 skill 的某节完全被另一个覆盖、或者某条内容更适合放在别处。给出合并/拆分建议，说明能删掉多少、删了会不会丢信息。",
    },
    {
      label: "检查该补没补的",
      prompt:
        "对照项目最近的实际改动（代码、发布、运维操作），找出这些 skill 里没写、但已经反复踩坑或必须知道的东西；列出建议新增的条目和该写进哪个 skill。不要直接改文件，先给清单。",
    },
    {
      label: "只报告，不改文件",
      prompt:
        "通读这些 skill，报告它们现在的问题：过期、冲突、冗余、缺漏各有多少，按严重度排序；这一轮不要修改任何 SKILL.md。",
    },
  ];

  // 风险审核：作用域是「风险车道」的这几个条目。
  // 动作围绕"审"——判断还成不成立、要不要提前处置，而不是笼统总结项目。
  var HARNESS_RISK_QUICK = [
    {
      label: "审核这些风险",
      prompt:
        "只审这本台账里还没收口的风险条目：逐条判断它现在是否仍然成立、有没有被新的进展改变、严重度和时点判断是否还准。每条给一句结论（成立 / 已缓解 / 已过期 / 需要升级处理），并说明依据。不要改 ledger.json。",
    },
    {
      label: "哪条最该先处理",
      prompt:
        "在这些未收口的风险里排出处理优先级：按「真出问题的损失 × 现在还剩多少时间」排序，说清每条为什么排在这个位置、最晚什么时候必须动手。只给判断和依据，不要直接改台账。",
    },
    {
      label: "找出没记进来的风险",
      prompt:
        "对照项目当前的实际状态（代码、依赖、线上配置、到期时间、额度、外部依赖），找出这本台账的风险条目里没有记、但确实存在的风险；逐条说明是什么、为什么会出事、现在有什么迹象。不要直接写进 ledger.json，先给清单。",
    },
    {
      label: "只报告，不改台账",
      prompt:
        "通读未收口的风险条目，报告它们的现状：哪些还有效、哪些已经过期、哪些描述得不够具体到能判断。这一轮不要修改任何文件。",
    },
  ];

  // 需求车道「和 AI 谈谈要加什么」：动作围绕"凭空想功能"—— 不是审、也不是总结，
  // 所以既不复用风险那套话术，也不给「更新台账」这类整本动作。
  var HARNESS_FEATURE_QUICK = [
    {
      label: "这个项目还缺什么功能",
      prompt:
        "先读项目目录、ledger.json 和 board.config.json，看清项目现在已经有什么、需求车道上已经排了哪些。然后指出它真正还缺的功能：按「用户会不会真用 × 现在缺了会怎样」排序，每条说清解决什么问题、为什么现在缺。不要提板上已经有的东西。不要改任何文件。",
    },
    {
      label: "下一批做哪几个",
      prompt:
        "基于需求车道里还没有上线的条目（计划中 / 开发中），排出下一批该做的 3 个：说清先后顺序、每个的价值、以及为什么把别的排在后面。只给建议和依据，不要动 ledger.json。",
    },
    {
      label: "把想法拆成需求条目",
      prompt:
        "我把想加的功能写在下面。请把它拆成可以直接进需求车道的条目：每条给标题、要解决的问题、验收标准、以及建议放在哪个阶段（计划中 / 开发中）。先给清单，不要直接改 ledger.json，等我确认。",
    },
    {
      label: "先看看现状，别急着加",
      prompt:
        "通读需求车道的全部条目和它们的状态，报告现状：哪些在做、哪些排着没动、哪些说法含糊到无法判断做没做。这一轮不要提新功能，也不要改任何文件。",
    },
  ];

  // 四个作用域各自拼自己的上下文，不再共用一个 else 分支。
  // 之前条目和整本共用 else，而那个 else 只写了 skill 的话术：点某条台账的
  // 「问 AI」，发出去的是「范围：本页全部 Skill（共 0 个）」加一句「skill 文件是
  // SKILL.md」，那条台账的四段和证据一个字都没带上，连编号都没有。
  //
  // 拼「这一轮要发给 AI 的文本」。
  // withContext=false 时只返回用户这句话本身：会话里已经有上下文了，再重发一遍
  // 只是把真正的问题淹掉。真正需要交代背景的只有「会话的第一句」——那一次要把
  // 看板位置、作用域、条目原文、回答规则都讲清楚，后面几轮 AI 还记得。
  //
  // 风险车道里还没收口的条目。
  // board-data 里的 items 每项带 laneLabel / statusLabel，够筛了，不用另开字段。
  // 「收口」的判据按状态文案认：已修复 / 已关闭 / 暂停 这三种在台账里是收口态，
  // 其余（观察中 / 缓解中 / 待评估…）都还算没处理完。
  // 这样不依赖某个项目配置里 stage 的具体写法，换项目也不会筛错。
  var CLOSED_STATUS = ["已修复", "已关闭", "暂停", "已解决", "已上线"];

  function isClosedStatus(label) {
    var s = String(label || "");
    for (var i = 0; i < CLOSED_STATUS.length; i += 1) {
      if (s.indexOf(CLOSED_STATUS[i]) === 0) return true;
    }
    return false;
  }

  function riskItems() {
    var out = [];
    var items = D.items || {};
    for (var id in items) {
      if (!Object.prototype.hasOwnProperty.call(items, id)) continue;
      var it = items[id];
      if (!it || it.laneLabel !== "风险") continue;
      if (isClosedStatus(it.statusLabel)) continue;
      out.push(it);
    }
    return out;
  }

  // 需求车道里已有的条目，收口的也在内。
  // 「和 AI 谈谈要加什么」最怕的不是信息少，而是它建议一个板上早就有的功能 ——
  // 所以连「已上线 / 暂停」的也一并带上，让它先看清哪些已经做过、哪些还在排。
  // 状态文案原样给出（计划中 / 开发中 / 已上线 / 暂停），它自己按状态判断。
  function featureItems() {
    var out = [];
    var items = D.items || {};
    for (var id in items) {
      if (!Object.prototype.hasOwnProperty.call(items, id)) continue;
      var it = items[id];
      if (!it || it.laneLabel !== "需求") continue;
      out.push(it);
    }
    return out;
  }

  function harnessContext(itemId, actionText, skillName, withContext) {
    var it = itemId ? D.items[itemId] : null;
    var skills = D.skills || { used: [], produced: [], related: [] };

    // 只有第一句才带背景。后续提问原样发出，不加任何前缀。
    if (!withContext) return actionText;

    // 看板位置：dir 与 projectDir 常常是同一个目录，同值就只写一行，别把同一串路径写两遍。
    var dir = harnessEnv().dir;
    var projectDir = harnessEnv().projectDir;
    var head = ["看板：" + D.project + "（" + dir + "）"];
    if (projectDir && projectDir !== dir) head.push("项目目录：" + projectDir);

    var lines;
    if (skillName) {
      // 单条 skill：把这条的路径和元信息带上，agent 不用自己猜是哪个文件，
      // 也不用去翻别的 skill —— 作用域就是这一个文件。
      lines = head.slice();
      var all = [].concat(skills.used || [], skills.produced || [], skills.related || []);
      var found = null;
      for (var i = 0; i < all.length; i += 1) {
        if (all[i] && all[i].name === skillName) {
          found = all[i];
          break;
        }
      }
      lines.push("范围：只有这一个 Skill ——「" + skillName + "」");
      lines.push("作用域限制：只读、只改这一个 SKILL.md；不要读改同目录或 skill 根里的其它 skill（这一轮用户只授权了这一个）。");
      if (found) {
        if (found.path) lines.push("文件：" + found.path);
        if (found.title) lines.push("标题：" + found.title);
        if (found.version) lines.push("版本：v" + found.version);
        if (found.agentCreated) lines.push("来源：agent 生成");
        if (found.sessions) lines.push("使用情况：" + found.sessions + " 个会话调过，共 " + found.total + " 次");
        if (found.desc) lines.push("说明：" + found.desc);
      }
      lines.push("", "需要对照别的 skill 判断冲突时，可以读它们，但结论只针对这一个文件，且不要修改它们。");
    } else if (it) {
      // 单条台账：把这一条原样带上。用户点的是这一条，agent 就该看着这一条答，
      // 而不是收到一句「本页全部 Skill」再自己去 ledger.json 里翻。
      lines = head.slice();
      lines.push("范围：只有这一条台账记录 ——「" + it.id + "」，不用管别的条目。");
      lines.push("", "【" + it.id + "】" + it.title);
      lines.push(
        "车道：" + it.laneLabel + "　状态：" + it.statusLabel + (it.severityText ? "　" + it.severityText : "")
      );
      if (it.area) lines.push("区域：" + it.area);
      if (it.updatedAt) lines.push("最近更新：" + it.updatedAt);
      if (it.sections) lines.push("", "四段记录：", it.sections);
      if (it.evidence) lines.push("", "留下的证据：", it.evidence);
    } else if (itemId === "__risks__") {
      // 风险审核：作用域是风险车道里还没收口的几条，把它们的原文直接摆出来。
      // 只给一句「审一下风险」的话，agent 还得自己去 ledger.json 里翻，
      // 翻漏了也不会有人知道。这里给全，它才能逐条判。
      lines = head.slice();
      var risks = riskItems();
      lines.push("范围：只审这本台账里未收口的风险条目，共 " + risks.length + " 条；其它车道（问题、需求）不在这次范围内。");
      lines.push("", "未收口的风险：");
      for (var r = 0; r < risks.length; r += 1) {
        var ri = risks[r];
        lines.push(
          "",
          "【" + ri.id + "】" + ri.title,
          "状态：" + ri.statusLabel + (ri.severityText ? "　" + ri.severityText : "") + (ri.area ? "　区域：" + ri.area : ""),
          ri.sections || "",
          ri.evidence ? "证据：\n" + ri.evidence : ""
        );
      }
      lines.push("", "要核对细节或看已收口的风险，读 " + dir + "/ledger.json。");
    } else if (itemId === "__feature__") {
      // 需求车道：把「已经排上 / 已经做过」的功能摆出来，再说这次要谈的是「要加什么」。
      // 只给一句「聊聊要加什么」，agent 会建议一堆板上已有的东西；先给它看现状，
      // 它才会往「还缺什么」上想。
      lines = head.slice();
      var feats = featureItems();
      lines.push(
        "范围：只谈这本台账的需求（功能）车道，共 " + feats.length + " 条；问题和风险不在这次范围内。",
        "这次的目标是「还要加什么功能」——先看下面已有的，避免建议重复的东西。"
      );
      lines.push("", "需求车道现有条目：");
      for (var f = 0; f < feats.length; f += 1) {
        var fi = feats[f];
        lines.push(
          "",
          "【" + fi.id + "】" + fi.title,
          "状态：" + fi.statusLabel + (fi.area ? "　区域：" + fi.area : ""),
          fi.sections || "",
          fi.evidence ? "证据：\n" + fi.evidence : ""
        );
      }
      lines.push("", "要核对细节或看历史，读 " + dir + "/ledger.json 和 board.config.json。");
    } else {
      // 整本台账：没有具体条目，说清是整本。
      lines = head.slice();
      lines.push("范围：整本台账，共 " + (D.totalCount || 0) + " 条，未收口 " + (D.openCount || 0) + " 条。");
      lines.push("用户没有指定某一条，回答时可以点出具体编号；需要细节就读 " + dir + "/ledger.json。");
    }

    // 回答规则来自 board.config.json 的 ask.systemPrompt，项目自己定。
    // 这段是「怎么写答案」的规矩，跟作用域无关，三个分支都带，放在问题前面。
    //
    // 模板里的【台账现状】和【当前关注】两段不带：上面已经按作用域给了更准的
    // 内容，重复一遍只会更啰嗦；【当前关注】那段的占位符更是会留下一个空标题。
    // 规则本身留着。
    var rules = String(D.systemPrompt || "")
      .replace(/【台账现状】[\s\S]*?(?=\n【)/g, "")
      .replace(/【当前关注】[\s\S]*?(?=\n【|$)/g, "")
      .replace(/\{\{project\}\}/g, D.project)
      .replace(/\{\{updatedAt\}\}/g, D.updatedAt || "")
      .replace(/\{\{totalCount\}\}/g, String(D.totalCount || 0))
      .replace(/\{\{openCount\}\}/g, String(D.openCount || 0))
      .replace(/\{\{openList\}\}/g, D.openList || "")
      .replace(/\{\{index\}\}/g, D.index || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (rules) lines.push("", rules);

    lines.push("", "这次要你做的事：" + actionText);

    return lines
      .filter(function (line) {
        return line !== null;
      })
      .join("\n");
  }

  function harnessPost(itemId, actionText, fresh, done, skillName, inline, reuseSessionId, withContext) {
    var it = itemId ? D.items[itemId] : null;
    var skillKey = skillName || null;
    // askId 用来把「这次提问」和「回来的回答」对上。
    // 面板可能连着问好几次，回答是异步回来的，没有这个 id 就分不清谁是谁。
    //
    // 中间那一位 c/p 是「哪个窗口问的」：c = 独立对话窗，p = 整页看板。
    // 为什么要塞进 id 里，而不是只靠 surface 字段：surface 要在 Host 的
    // /ops-board/ask 里过一道手（发给所有打开的 Harness 页），而 Host 那半边
    // 是插件代码，改完必须重启应用才生效。把来源编进 askId 之后，
    // 即使 Host 还是旧版、把 surface 丢了，插件也能从 id 里读回来 ——
    // 刷新一下页面就够，不用为了一个字段重启。
    var tag = SURFACE === "chat" ? "c" : "p";
    var askId = "ask-" + tag + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    // 直接开在看板端口上的页面没有这个对象 —— 那种页面本来也问不了 AI，
    // 给一条能读懂的话，别让它炸成 TypeError 卡住整个面板。
    var env = harnessEnv();
    if (!env) {
      done({ ok: false, error: "这块板要在 Harness 里打开才能问 AI（侧栏「项目看板」）。" });
      return;
    }
    var payload = {
      board: env.id,
      dir: env.dir,
      label: env.label,
      // skill 用独立前缀，避免和台账条目 id 撞车（条目是 OPS-030 这种）
      item: skillKey ? "skill:" + skillKey : itemId || "",
      title: skillKey
        ? "Skill · " + skillKey
        : itemId === "__risks__"
          ? "风险审核"
          : itemId === "__feature__"
            ? "新增功能"
            : it
              ? it.title
              : "整本台账",
      fresh: !!fresh,
      askId: askId,
      // 指定了旧会话就带着走；插件端优先用它，不再查映射表。
      reuseSessionId: reuseSessionId || "",
      // inline：这次回答要回到看板里显示，而不是跳去 Harness 会话窗。
      inline: !!inline,
      // 哪个窗口问的。回答广播回来时各窗口据此只收自己那份。
      surface: SURFACE,
      question: harnessContext(itemId, actionText, skillKey, withContext),
    };

    // 投递路有三条，按「这一份页面被谁托管」分流：
    //
    //   ① Harness 面板的 iframe 里 —— POST /ops-board/ask，同源直达 + SSE 广播；
    //   ② 系统浏览器窗口，地址是 Harness 的 http 源（…/ops-board/b/<id>/?chat=1）
    //      —— 一样同源，①照走，只是没有父窗口可以 postMessage；
    //   ③ 系统浏览器窗口，直接开在看板自己的端口上
    //      —— /ops-board/ask 在那边不存在，只能走 /api/relay/req 让插件接住。
    //
    // 关键：①② 和 ③ 分不出来 —— inFrame() 对三者里的后两者都是 false，
    // 而 ② 明明同源可用。所以不预判，先照旧打一次，没成才换中转（见下）。
    fetch("/ops-board/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok) {
          done({ ok: true, askId: askId });
          return;
        }
        // 旧版 client 没有 SSE：退回 postMessage，至少能把问题送过去。
        var target = window.parent && window.parent !== window ? window.parent : window.opener;
        if (target) {
          try {
            target.postMessage(
              {
                type: "ops-board/ask",
                board: payload.board,
                dir: payload.dir,
                label: payload.label,
                item: payload.item,
                title: payload.title,
                fresh: payload.fresh,
                askId: askId,
                inline: payload.inline,
                reuseSessionId: payload.reuseSessionId,
                question: payload.question,
              },
              window.location.origin
            );
            target.focus();
            done({ ok: true, fallback: true, askId: askId });
            return;
          } catch (e) {}
        }
        done({ ok: false, error: (j && j.error) || "Harness 没接住这个问题" });
      })
      .catch(function (e) {
        done({ ok: false, error: String((e && e.message) || e) });
      });
  }


  // 工具名 → 看得懂的说法。
  // 面板里要让人一眼看出「它在干什么」，而不是看一串 read / apply_patch。
  //
  // 键是真实出现过的名字：对着会话日志（session.v4.jsonl.zstd 里的 tool/call）
  // 核过，实际用的是 read / grep / write / edit 这一套短名，不是 read_file。
  // 长名一并留着，换个 provider 可能就叫法不同。
  var TOOL_LABEL = {
    read: "读文件",
    read_file: "读文件",
    read_image: "看图",
    write: "写文件",
    write_file: "写文件",
    edit: "改文件",
    edit_file: "改文件",
    apply_patch: "改文件",
    multi_edit: "改文件",
    ls: "列目录",
    list_dir: "列目录",
    list_files: "列目录",
    glob: "找文件",
    grep: "搜索",
    search_files: "搜索",
    run: "跑命令",
    run_command: "跑命令",
    shell: "跑命令",
    bash: "跑命令",
    pwsh: "跑命令",
    web_search: "联网搜",
    web_fetch: "抓网页",
    todo_write: "记待办",
    task: "派子任务",
  };

  function toolLabel(name) {
    return TOOL_LABEL[name] || name || "工具";
  }

  // 从工具参数里挑一个最能说明「动的是哪儿」的值。
  // 不同工具的参数名不一样，按常见优先级找，找不到就退回工具名。
  var ARG_KEYS = ["path", "file_path", "filePath", "pattern", "query", "command", "cmd", "url", "prompt"];

  function toolDetail(args) {
    if (!args) return "";
    var obj = null;
    try {
      obj = typeof args === "string" ? JSON.parse(args) : args;
    } catch (e) {
      // 参数不一定是合法 JSON（截断 / 流式未完成），直接当文本看
      return String(args).slice(0, 80);
    }
    if (!obj || typeof obj !== "object") return "";
    for (var i = 0; i < ARG_KEYS.length; i += 1) {
      var v = obj[ARG_KEYS[i]];
      if (typeof v === "string" && v.trim()) {
        var s = v.trim().replace(/\s+/g, " ");
        return s.length > 80 ? s.slice(0, 79) + "…" : s;
      }
    }
    return "";
  }

  // 把这一轮的工具调用画成一条可折叠的过程清单。
  function renderSteps(steps) {
    if (!steps || !steps.length) return null;
    var box = document.createElement("div");
    box.className = "msg-steps";
    var head = document.createElement("div");
    head.className = "msg-steps-head";
    head.textContent = "过程 · " + steps.length + " 步";
    box.appendChild(head);
    for (var i = 0; i < steps.length; i += 1) {
      var s = steps[i];
      var row = document.createElement("div");
      row.className = "msg-step" + (s.failed ? " is-failed" : "") + (s.settled ? "" : " is-pending");
      var name = document.createElement("span");
      name.className = "msg-step-name";
      name.textContent = toolLabel(s.name);
      row.appendChild(name);
      var detail = toolDetail(s.args);
      if (detail) {
        var d = document.createElement("span");
        d.className = "msg-step-detail";
        d.textContent = detail;
        row.appendChild(d);
      }
      box.appendChild(row);
    }
    return box;
  }

  function addMsg(role, text, extraClass) {
    var wrap = document.createElement("div");
    wrap.className = "msg msg-" + role + (extraClass ? " " + extraClass : "");
    var roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = role === "user" ? "你" : "助手";
    var body = document.createElement("div");
    body.className = "msg-body";
    if (role === "user") {
      body.textContent = text;
    } else {
      body.innerHTML = renderText(text);
    }
    wrap.appendChild(roleEl);
    wrap.appendChild(body);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return body;
  }

  function paintQuick() {
    var list;
    if (AI.skill) {
      // 单个 skill：只给它一个文件的动作，别让 agent 顺手改全部。
      // 这里不看 HARNESS —— 作用域是「这条 skill」的语义，不该因为
      // 在 Harness 里还是独立浏览器里打开而变一套动作。
      list = HARNESS_SKILL_ONE_QUICK;
    } else if (AI.skillScope) {
      // 整页 skill（顶上那个入口）：跨 skill 的全局动作
      list = HARNESS_SKILL_QUICK;
    } else if (AI.riskScope) {
      // 风险审核：动作只围绕风险车道，不给「更新台账」这类整本动作
      list = HARNESS_RISK_QUICK;
    } else if (AI.featureScope) {
      // 需求车道「要加什么」：动作只围绕需求车道
      list = HARNESS_FEATURE_QUICK;
    } else if (AI.ctx) {
      // 单条台账：这套动作归项目配置管（board.config.json 的 ask.itemQuick），
      // 因为「问这一条什么」因项目而异。
      list = D.itemQuick;
    } else {
      list = HARNESS_GLOBAL_QUICK;
    }
    quickEl.innerHTML = "";
    (list || []).forEach(function (q) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = q.label;
      b.title = q.prompt;
      b.addEventListener("click", function () {
        // 点动作只填进输入框，发不发由人按「发送」决定 ——
        // 这条对所有模式一致（以前非 Harness 下会直接发送，等于替人做选择）。
        inputEl.value = q.prompt;
        inputEl.focus();
        setHint("已填入动作；点「发送」交给 AI。");
      });
      quickEl.appendChild(b);
    });
  }

  function paintCtx() {
    ctxEl.textContent = ctxLabel();
    ctxEl.title = ctxLabel(); // 头部太窄会截断，鼠标停一下看全称
    paintQuick();
  }

  // 「新会话」= 下一条发送不复用旧会话，改在 Harness 里新开一个。
  // 会话本身存在 Harness 那边，这里不需要维护历史。
  // ── 对话记录持久化 ────────────────────────────────────────────────
  //
  // 为什么需要：跳去 Harness 会话窗看完整对话时，看板 iframe 会被卸载；回来时
  // 页面重新加载，之前聊过的内容全在内存里（DOM 节点 + PENDING），一次都不剩。
  // 所以按「作用域」把对话存进 localStorage，重开面板时原样恢复。
  //
  // 作用域口径必须和 sessionKey() 一致：条目 id / skill:<name> / __global__，
  // 这样「点 OPS-029 问过的话」不会被灌到别的条目面板里。
  var CHAT_KEY_PREFIX = "ops-board-chat:";
  var CHAT_MAX = 40; // 单个作用域最多留 40 条，免得 localStorage 无限涨

  function chatStoreKey() {
    return CHAT_KEY_PREFIX + (harnessEnv() && harnessEnv().id ? harnessEnv().id + ":" : "") + scopeId();
  }

  // 「用户点了新对话」的标记，按作用域记。
  //
  // 为什么不能只清 DOM：面板一重载（去看 Harness 会话再回来就会重载），
  // resetChat 又会去 Harness 把上一次的对话拉回来，看起来就是"清了个寂寞"。
  // 所以清空时留一个标记：这个作用域下次开面板就是空的，直到用户真的发出新提问。
  function clearedKey() {
    return "ops-board-cleared:" + chatStoreKey().slice(CHAT_KEY_PREFIX.length);
  }

  function isClearedScope() {
    try {
      return window.localStorage.getItem(clearedKey()) === "1";
    } catch (e) {
      return false;
    }
  }

  function markCleared(on) {
    try {
      if (on) window.localStorage.setItem(clearedKey(), "1");
      else window.localStorage.removeItem(clearedKey());
    } catch (e) {}
  }

  function readChatLog() {
    try {
      var raw = window.localStorage.getItem(chatStoreKey());
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function writeChatLog(list) {
    try {
      window.localStorage.setItem(chatStoreKey(), JSON.stringify(list.slice(-CHAT_MAX)));
    } catch (e) {}
  }

  // 记一条进当前作用域的对话记录。steps 只留「名字 + 简述」，够回看过程用了。
  function pushChatLog(entry) {
    var list = readChatLog();
    list.push(entry);
    writeChatLog(list);
  }

  // 把一组 {role, text, steps} 摆进消息区。本地缓存和 Harness 历史共用这一段。
  function paintHistory(rows, extraClass) {
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || !row.text) continue;
      var isAi = row.role !== "user";
      var b = addMsg(isAi ? "ai" : "user", row.text, isAi ? extraClass || "" : "");
      // 过程清单也恢复，否则「答了什么」在、「做了什么」没了。
      if (isAi && row.steps && row.steps.length) {
        var stepsEl = renderSteps(row.steps);
        var wrap = b && b.parentNode;
        if (stepsEl && wrap) {
          var details = document.createElement("details");
          details.className = "msg-steps-wrap";
          var summary = document.createElement("summary");
          summary.textContent = "过程 · " + row.steps.length + " 步";
          details.appendChild(summary);
          details.appendChild(stepsEl);
          wrap.appendChild(details);
        }
      }
    }
  }

  function paintEmpty() {
    var it = AI.ctx ? D.items[AI.ctx] : null;
    var empty = document.createElement("div");
    empty.className = "ai-empty";
    // skill 的说明只跟作用域有关，不跟「在哪打开」有关
    if (AI.skill || AI.skillScope) {
      var sk = AI.skill;
      var total = 0;
      if (D.skills) {
        total = (D.skills.used || []).length + (D.skills.produced || []).length + (D.skills.related || []).length;
      }
      empty.innerHTML =
        "<b>" + (sk ? "Skill · " + esc(sk) : "整页 Skill（共 " + total + " 个）") + "</b>" +
        (sk
          ? "作用范围只有这一个 skill；动作（总结更新 / 查冲突 / 查缺漏 / 查该删的）都只针对它。也可以直接写要问的。"
          : "作用范围是本页全部 skill；动作会跨 skill 比对。想只处理某一个，去它那一行点「问 AI」。");
    } else {
      empty.innerHTML =
        "<b>" + (it ? esc(it.title) : "整本台账") + "</b>" +
        (it
          ? "选一个动作，或直接写你要它做的事；回答和过程都留在这个面板里。"
          : "共 " + D.totalCount + " 条，" + D.openCount + " 条未收口。选一个动作或直接问；回答和过程都留在这个面板里。");
    }
    msgsEl.appendChild(empty);
  }

  // ── 从 Harness 拉这个作用域的既有对话 ──────────────────────────────
  //
  // Harness 会话是唯一权威来源：里面是真正发生过的事（包括在别处接着聊的内容）。
  // 本机 localStorage 只是「上次看到的样子」，用来让面板先有东西显示、不至于白屏。
  // 所以策略是：先用缓存铺上，再向 Harness 要一次真实历史，拿到了就整体替换。
  function loadHistoryFromHarness(done, opts) {
    if (!harnessEnv()) return done && done(false);
    var key = scopeId();
    var reqId = "hist-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    // 只让最新一次请求上屏（见 HISTORY_GEN 的注释）。
    HISTORY_GEN += 1;
    var gen = HISTORY_GEN;
    HISTORY_WAIT[reqId] = function (payload) {
      if (gen !== HISTORY_GEN) return done && done(false);
      if (!payload || !payload.ok || !payload.messages || !payload.messages.length) {
        // 静默失败最难查：这里留一条可看的日志，说明是「插件没回 / 回了空 / 插件报错」哪一种。
        if (!payload) console.log("[ops-board] 历史请求无响应（插件未加载或版本过旧）");
        else if (payload.error) console.log("[ops-board] 历史请求失败：" + payload.error);
        else console.log("[ops-board] 该作用域在 Harness 里没有可回显的消息（entries=" + payload.entries + "）");
        // 明确知道读的是哪条、但它没有可显示的消息时，记下来，
        // 免得下一次认领又对同一条再拉一遍、再清一次屏。
        if (payload && payload.sessionId) AI.shownId = String(payload.sessionId);
        // 风险审核读到空（第一次用，或那条会话里只有工具调用）：这就是新对话，
        // 下一句必须带背景，否则发出去的只是一句「审一下这些风险」。
        if (AI.riskScope || AI.featureScope) AI.fresh = true;
        return done && done(false);
      }
      // 只在面板还没聊开时替换，避免把用户刚问的话冲掉。
      if (AI.busy || PENDING && Object.keys(PENDING).length) return done && done(false);
      var empty = msgsEl.querySelector(".ai-empty");
      if (empty) empty.remove();
      // 已经有了本地恢复的内容就先清掉，用 Harness 的为准，不出现两套。
      if (msgsEl.querySelector(".msg.is-restored")) {
        Array.prototype.forEach.call(msgsEl.querySelectorAll(".msg.is-restored"), function (n) {
          n.parentNode && n.parentNode.removeChild(n);
        });
      }
      if (!msgsEl.querySelector(".msg")) paintEmpty();
      paintHistory(payload.messages, "is-history");
      // 把「屏幕上显示的是哪条会话」写回控件。
      //
      // 插件回包里带着它实际读的 sessionId。以前前端不看这个字段，于是
      // 下拉可能指着 A、屏幕显示的是 B —— 用户以为接错了对话，其实是显示没对上。
      // 这里统一以「真正读到的会话」为准，下拉跟着内容走。
      if (payload.sessionId) {
        AI.shownId = String(payload.sessionId);
        syncPickedSession(String(payload.sessionId));
      }
      writeChatLog(
        payload.messages.map(function (m) {
          return { role: m.role === "user" ? "user" : "ai", text: m.text };
        })
      );
      AI.fresh = false;
      msgsEl.scrollTop = msgsEl.scrollHeight;
      done && done(true);
    };
    try {
      postToHost({
          type: "ops-board/history",
          board: harnessEnv().id,
          key: key,
          reqId: reqId,
          // 这里不需要 surface 判别：历史回包靠 reqId 认领（一次请求一个随机 id），
          // 另一个窗口的 HISTORY_WAIT 里没有这个 id，收到也不理。
          // 需要 surface 的是「回答」那条路 —— 回答是随会话推送下来的，
          // 没有请求 id 可以认领，只能靠发问时带上的 surface 分辨。
          // 指定就读那一条（「选择对话」选中的那个）；不带就按映射表取上次的。
          sessionId: opts && opts.sessionId ? opts.sessionId : "",
      });
    } catch (e) {
      delete HISTORY_WAIT[reqId];
      return done && done(false);
    }
    // 插件不在（比如裸页打开）就别一直等。这个上限必须大于插件端等事件窗口的
    // 时间（2.5s），否则插件还在轮询、这边已经超时放弃，等于白等 —— 之前就是这样。
    setTimeout(function () {
      if (HISTORY_WAIT[reqId]) {
        delete HISTORY_WAIT[reqId];
        done && done(false);
      }
    }, 6000);
  }

  function resetChat(itemId) {
    if (itemId !== undefined) AI.ctx = itemId || null;
    // 哨兵 ctx 只用来把面板打开；重置后不能把它当条目 id 留着（D.items 里没有）
    if (AI.ctx === "__skills__" || AI.ctx === "__risks__" || AI.ctx === "__feature__") AI.ctx = null;
    // 换了作用域，屏幕上就还没有任何会话的内容，别把上一条的记录带过来。
    AI.shownId = "";
    msgsEl.innerHTML = "";
    paintCtx();

    // 用户明确点过「新对话」的作用域：窗口就该是空的。
    // 不能再去 Harness 把上一次的对话拉回来 —— 那正是"清了又回来"的原因。
    if (isClearedScope()) {
      AI.fresh = true;
      paintEmpty();
      return;
    }

    // 先用本地缓存铺上，面板不至于白屏；随后再向 Harness 要真实历史替换它。
    var log = readChatLog();
    // 记录回来了就不算「第一句」，后续提问只发原话；空作用域才要交代背景。
    AI.fresh = log.length === 0;
    if (log.length) {
      paintHistory(log, "is-restored");
      setHint("");
      msgsEl.scrollTop = msgsEl.scrollHeight;
    } else {
      paintEmpty();
    }
    loadHistoryFromHarness();
  }

  // ── 会话选择控件 ──────────────────────────────────────────────────
  //
  // 面板上两个单选 + 一个下拉：新对话 / 选择对话（下拉里列出聊过的会话）。
  // 之前只有一个「新会话」按钮，默认行为是复用，但复用失败时会静默新建，
  // 用户看不出到底接进了哪个会话。现在把选择显式化：
  //   · 单选决定 fresh
  //   · 下拉列出该作用域下真正存在的旧会话，选中即复用
  //   · 旧会话已失效时明确提示，不再静默新建

  var modeNewEl = null;
  var modeReuseEl = null;
  var pickEl = null;

  // 作用域标识：会话映射表、对话缓存、清空标记三处必须用同一个口径，
  // 否则同一个作用域在三个地方算出三个 key，历史就各存各的。
  function scopeId() {
    if (AI.skill) return "skill:" + AI.skill;
    // 风险审核要独立成一个作用域。它的 ctx 是空的，若不特判就会和
    // 整本台账共用 "__global__"，两个入口的对话会串到一起。
    if (AI.riskScope) return "__risks__";
    if (AI.featureScope) return "__feature__";
    return AI.ctx || "__global__";
  }

  function sessionKey() {
    // 与插件端 boardKey/itemKey 的算法保持一致，否则查不到旧会话
    return {
      item: scopeId(),
    };
  }

  function selectedMode() {
    if (modeReuseEl && modeReuseEl.checked) return "reuse";
    return "new";
  }

  function syncModeUi(opts) {
    // 没有可继续的会话时，「选择对话」是空选项：直接退回「新对话」，
    // 不能让单选停在「选择对话」上——那会让人以为接进了旧对话，实际却是新开。
    if (modeReuseEl && modeReuseEl.checked && AI.sessions.length === 0 && modeNewEl) {
      modeNewEl.checked = true;
    }
    var reuse = selectedMode() === "reuse";
    if (pickEl) {
      pickEl.disabled = reuse ? AI.sessions.length === 0 : true;
      // 只有在「选择对话」模式下才把下拉露出来，否则那一行只剩个灰框没意义
      pickEl.hidden = !reuse;
    }
    // 记住「接进哪条对话」。下拉还没铺开时（value 为空）别把已有的选择清掉：
    // 那样一来一回 syncModeUi 就会把用户刚选的那条弄丢，发送时又变成新开会话。
    if (reuse) {
      if (pickEl && pickEl.value) AI.reuseId = pickEl.value;
    } else {
      AI.reuseId = "";
    }
    // 注意：这里不再改 AI.fresh。它只表示「这个作用域在本机上还没聊过」，
    // 与「新对话 / 选择对话」是两个维度 —— 恢复出旧记录的会话也不该再灌背景。
    if (reuse && AI.sessions.length === 0) {
      setHint("还没有聊过的对话，这次会新开一个。");
    }
    // 真正切模式时才动消息区；openPanel/初始化时传 quiet，避免自己把刚铺好的记录抹掉。
    if (!opts || !opts.quiet) showModeMessages(reuse);
  }

  // 切换「新对话 / 选择对话」时，把消息区换成对应的那一份。
  //
  // 这是本次要修的核心：以前切到「新对话」，消息区照旧显示着上一轮聊的内容，
  // 看起来像「新对话还带着旧记录」。新对话就该是空的 —— 只清这个面板的显示，
  // 不动 Harness 里的会话，也不删已经存下的记录（切回去还能看到）。
  function showModeMessages(reuse) {
    if (!msgsEl) return;
    // 有提问在途时别抹屏，否则回答回来会找不到气泡
    if (AI.busy || (PENDING && Object.keys(PENDING).length)) return;
    msgsEl.innerHTML = "";
    if (!reuse) {
      // 新对话：清空当前窗口。缓存也要清，否则重载后又"复活"成旧内容；
      // 再留个标记，避免重开面板时又从 Harness 把旧对话拉回来。
      writeChatLog([]);
      markCleared(true);
      AI.fresh = true;
      paintEmpty();
      return;
    }
    // 选择对话：这次是"要看旧的"，把清空标记撤掉。
    markCleared(false);
    // 下拉里已经选定了某一条（默认就是最近那条）：直接按它取，
    // 不要再走一遍「不指定 sessionId」的取法 —— 两条请求会各画一遍，屏幕上就出现两份。
    if (pickEl && pickEl.value) {
      loadChosenSessionHistory();
      return;
    }
    // 没有可选的对话：先把本地缓存铺上，再从 Harness 要一次。
    var log = readChatLog();
    if (log.length) paintHistory(log, "is-restored");
    else paintEmpty();
    loadHistoryFromHarness();
  }

  // 用户在下拉里选了某一条对话：把窗口换成那一条的内容。
  function loadChosenSessionHistory() {
    if (!msgsEl) return;
    var sid = (pickEl && pickEl.value) || "";
    if (!sid) return;
    AI.reuseId = sid;
    if (AI.busy || (PENDING && Object.keys(PENDING).length)) return;
    // 换对话时不能留着上一条的内容，否则两条对话会混在一屏里。
    msgsEl.innerHTML = "";
    paintEmpty();
    setHint("正在读这条对话…");
    loadHistoryFromHarness(function (ok) {
      if (ok) {
        setHint("接着这条对话聊，回答会留在看板里。");
      } else {
        setHint("这条对话里没有可显示的消息。", true);
      }
    }, { sessionId: sid });
  }

  // 拉取当前作用域可继续的旧会话。
  //
  // 两条来源，优先级不同：
  //   1. 插件按工作区目录列出的 Harness 会话（真正完整的清单，下拉能选的就是这些）
  //   2. /ops-board/sessions 映射表（只记「这个作用域上次用了哪条」，通常就一条）
  //
  // 以前只用第 2 条，于是「选择对话」里往往只有一项 —— 看着像选择，其实没得选。
  // 现在先问插件要完整列表，拿不到（例如脱离 Harness 单独打开看板）再退回映射表。
  function loadSessions(done) {
    var key = sessionKey();
    // 映射表虽然「只有一条」，但那一条正是**这个作用域上次用的会话** ——
    // 对「从某个问题点进来」来说，它是比标题匹配更硬的证据。
    // 所以两份都要：清单给选择范围，映射表给"哪条属于本条"。
    fetch("/ops-board/sessions", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("no route");
        return r.json();
      })
      .then(function (map) {
        var live = harnessEnv();
        var board = (live && live.id) || "";
        var perBoard = (map && map[board]) || {};
        var rec = perBoard[key.item] || {};
        return typeof rec === "object" && rec !== null ? rec.id : rec;
      })
      .catch(function () {
        return "";
      })
      .then(function (ownSid) {
        listHarnessSessions(function (items) {
          if (items && items.length) {
            applySessionList(items, done, ownSid);
            return;
          }
          loadSessionsFromMap(key, done);
        });
      });
  }

  // 向插件要「这个看板目录下的 Harness 会话」。
  //
  // 走 postMessage 而不是 fetch：会话清单在 Harness 的客户端服务里，
  // host 那边的路由看不到它。插件收到后按目录过滤，再用广播回给看板。
  function listHarnessSessions(done) {
    var live = harnessEnv();
    if (!live || !live.dir) {
      done(null);
      return;
    }
    var reqId = "ls-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    var settled = false;
    function finish(items) {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      done(items);
    }
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      var data = event.data;
      if (!data || data.type !== "ops-board/sessions-list") return;
      if (String(data.reqId || "") !== reqId) return;
      finish(Array.isArray(data.items) ? data.items : null);
    }
    window.addEventListener("message", onMessage);
    try {
      postToHost({
          type: "ops-board/list-sessions",
          reqId: reqId,
          board: live.id || "",
          dir: live.dir || "",
      });
    } catch (e) {
      finish(null);
      return;
    }
    // 脱离 Harness 时没人应答，别把面板卡在等状态上。
    setTimeout(function () {
      finish(null);
    }, 3000);
  }

  // 把插件给的会话清单铺进下拉。清单已按目录过滤、按最近更新排序。
  //
  // 「默认选中哪条」是有讲究的：用户从某条问题点进来时，想看的是**这条问题**
  // 的对话，不是「这个目录里最近谁聊过」。所以先按本条目作用域去认领会话，
  // 认到了就选它；认不到才退回「最近更新的那条」。
  function applySessionList(items, done, ownSid) {
    var out = [];
    var seen = {};
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i] || {};
      var id = String(it.id || "");
      if (!id || seen[id]) continue;
      // 空会话没有任何内容，接进去也只是白屏，不列出来。
      if (it.blank) continue;
      seen[id] = true;
      var label = it.title ? String(it.title) : "对话 · " + shortId(id);
      out.push({
        id: id,
        label: label,
        at: Number(it.at) || 0,
        // 两级认领：映射表点名的优先（硬证据），其次看标题里的条目 id。
        // 风险审核没有条目 id，它自己的会话标题是「风险审核 · …」，按这个认；
        // 需求车道同理，标题是「新增功能 · …」。
        own: ownSid
          ? id === String(ownSid)
          : titleBelongsToItem(label, AI.riskScope ? "风险审核" : AI.featureScope ? "新增功能" : AI.ctx),
      });
    }
    AI.sessions = out;
    // 风险审核 / 需求车道都是「按车道聚合」的作用域，它们的会话标题是
    // 「风险审核 · …」「新增功能 · …」。清单里其它会话（整本台账、各条台账）
    // 都不属于它们，先收窄再认领 —— 否则会被"最近更新"那条抢走，
    // 把风险审核接进无关对话。
    var scopeTitle = AI.riskScope ? "风险审核" : AI.featureScope ? "新增功能" : "";
    if (scopeTitle) {
      out = out.filter(function (o) {
        return titleBelongsToItem(o.label, scopeTitle);
      });
      AI.sessions = out;
    }
    // 先认领本条目自己的对话；认不到再退回最近那条。
    var own = null;
    for (var j = 0; j < out.length; j += 1) {
      if (out[j].own) {
        own = out[j];
        break;
      }
    }
    if (own) {
      // 把它挪到最前面，下拉第一项就是「这个问题的对话」，看着也对得上。
      out.splice(out.indexOf(own), 1);
      out.unshift(own);
    }
    if (out.length && !isClearedScope() && modeReuseEl && modeNewEl) {
      modeReuseEl.checked = true;
      modeNewEl.checked = false;
    }
    fillPicker(true);
    // 风险审核 / 需求车道还没有自己的对话（第一次点进去就是这种情况）：
    // 保持「新对话」，并且明确把 AI.fresh 置真 —— 下一次发送必须带上
    // 那些条目的原文。不置的话会沿用上一个作用域留下的 false，只发一句
    // 「审一下这些风险」，agent 还得自己去翻台账。
    if ((AI.riskScope || AI.featureScope) && !out.length) {
      if (modeNewEl) modeNewEl.checked = true;
      if (modeReuseEl) modeReuseEl.checked = false;
      AI.reuseId = "";
      AI.fresh = true;
    }
    // 认领到的那条要立刻置为选中：fillPicker 只会选第一项，
    // 而第一项在上面已经换成了本条的对话，两者一致；这里再显式兜一次，
    // 免得将来调换顺序时又悄悄退回「最近更新」。
    if (own && pickEl) {
      pickEl.value = own.id;
      AI.reuseId = own.id;
      // 用户明确点过「新对话」的作用域，窗口就该是空的 —— 认领到会话也不能
      // 把内容拉回来，那正是"清了又回来"那种毛病。所以清空状态下只更新
      // 下拉指向（下次手动切「选择对话」能直接看到这一条），不动单选、
      // 不动消息区，也不发历史请求。
      var cleared = isClearedScope();
      if (cleared) {
        if (modeNewEl) modeNewEl.checked = true;
        if (modeReuseEl) modeReuseEl.checked = false;
        pickEl.disabled = true;
        setHint("");
      } else if (AI.shownId !== own.id && !AI.busy && !(PENDING && Object.keys(PENDING).length)) {
        setHint("正在读这条问题的对话…");
        loadHistoryFromHarness(function (ok) {
          if (ok) {
            setHint("接着这条问题的对话聊，回答会留在看板里。");
          } else {
            // 标题认到了，但里面没有可显示的消息（例如只有工具调用）。
            paintEmpty();
            setHint("这条对话里没有可显示的消息。", true);
          }
        }, { sessionId: own.id });
      } else if (AI.shownId === own.id) {
        setHint("接着这条问题的对话聊，回答会留在看板里。");
      }
    }
    if (done) done();
  }

  // 标题是否属于这个条目。
  //
  // 插件给会话起名时用的是「条目 id · 时间 · 标题」，中间以「 · 」分隔，
  // 所以按「开头就是条目 id + 分隔符」判最稳，不能用 indexOf ——
  // OPS-03 会在 OPS-030 里命中，把别人的对话认成自己的。
  // （这里刻意不写模板占位符的字面量，成品校验会把它当作未解析的表达式。）
  function titleBelongsToItem(title, itemId) {
    var t = String(title || "");
    var id = String(itemId || "");
    if (!t || !id) return false;
    if (t.indexOf(id) !== 0) return false;
    var next = t.charAt(id.length);
    return next === "" || next === " " || next === "·" || next === "-" || next === "_";
  }

  // 让控件跟上「屏幕上实际显示的是哪条会话」。
  //
  // 下拉里不一定有它（清单可能还没回来、或那条不在本目录）：那就补一个选项进去，
  // 而不是让下拉空着 —— 空着会让下一次发送把 reuseSessionId 丢掉，退回新会话，
  // 正是上一轮"选了却不接入"那种错。补进去也保证用户能看见自己在跟谁聊。
  function syncPickedSession(sid) {
    var id = String(sid || "");
    if (!id || !pickEl) return;
    var found = false;
    for (var i = 0; i < pickEl.options.length; i++) {
      if (pickEl.options[i].value === id) {
        found = true;
        break;
      }
    }
    if (!found) {
      var row = null;
      for (var k = 0; k < AI.sessions.length; k++) {
        if (AI.sessions[k].id === id) {
          row = AI.sessions[k];
          break;
        }
      }
      var label = row ? row.label : "对话 · " + shortId(id);
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      // 插在最前面：它是"当前正在看的这条"，不是随便一条历史。
      if (pickEl.options.length) pickEl.insertBefore(opt, pickEl.options[0]);
      else pickEl.appendChild(opt);
      AI.sessions.unshift({ id: id, label: label, at: 0 });
    }
    pickEl.value = id;
    AI.reuseId = id;
    pickEl.disabled = selectedMode() !== "reuse";
    if (modeReuseEl) modeReuseEl.disabled = false;
    // 有内容可接，就该停在「选择对话」上，别让单选还指着新对话。
    if (!isClearedScope() && modeReuseEl && modeNewEl) {
      modeReuseEl.checked = true;
      modeNewEl.checked = false;
      pickEl.disabled = false;
    }
  }

  function loadSessionsFromMap(key, done) {
    fetch("/ops-board/sessions", { cache: "no-store" })

      .then(function (r) {
        if (!r.ok) throw new Error("no route");
        return r.json();
      })
      .then(function (map) {
        // HARNESS 是脚本加载时抓的快照（那时可能是 null），
        // 所以这里再读一次 window.__OPS_HARNESS__，谁后设都能拿到。
        var live = harnessEnv();
        var board = (live && live.id) || "";
        var perBoard = (map && map[board]) || {};
        var rec = perBoard[key.item] || {};
        var sid = typeof rec === "object" && rec !== null ? rec.id : rec;
        AI.sessions = buildSessionOptions(rec, sid);
        // quiet：resetChat 刚把记录铺好，这里只同步控件状态，别再动消息区。
        fillPicker(true);
        // 有旧会话就默认接进上次那个，而不是无脑新开。
        // 用户想换话题时仍可手动切回「新对话」，但那不应是每次点开的默认行为。
        //
        // 例外：用户刚点过「新对话」（此作用域带着清空标记），那就保持新对话。
        // 否则一重开面板又被自动拨回「选择对话」，等于把清空动作撤销了。
        if (sid && modeReuseEl && modeNewEl && !isClearedScope()) {
          modeReuseEl.checked = true;
          modeNewEl.checked = false;
        }
        syncModeUi({ quiet: true });
        if (done) done();
      })
      .catch(function () {
        // 脱离 Harness 时没有这个路由：当作「没有旧会话」，不是错误。
        AI.sessions = [];
        fillPicker(true);
        if (done) done();
      });
  }

  // 把映射表里一个作用域的记录整理成下拉选项。
  //
  // 以前只认 rec.id 一条，于是「选择对话」根本没得选。现在优先用 rec.history
  // （宿主按最近顺序记着的会话列表）；老记录没有 history 就退回单条。
  function buildSessionOptions(rec, sid) {
    var obj = rec && typeof rec === "object" ? rec : null;
    var rows = obj && Array.isArray(obj.history) ? obj.history : [];
    var out = [];
    var seen = {};
    function push(id, title, at) {
      var s = String(id || "");
      if (!s || seen[s]) return;
      seen[s] = true;
      // 标题能看懂就用标题；只有 id 时给个短 id，别让所有行都叫「对话」。
      var label = title ? title : "对话 · " + shortId(s);
      out.push({ id: s, label: label, at: Number(at) || 0 });
    }
    // 最近用的那条排最前，这样默认选中就是「上次那个」
    if (sid) push(sid, obj && obj.title, obj && obj.at);
    for (var i = 0; i < rows.length; i += 1) {
      var h = rows[i];
      if (!h) continue;
      push(h.id, h.title, h.at);
    }
    return out;
  }

  function shortId(id) {
    var s = String(id || "");
    return s.length > 10 ? s.slice(0, 6) + "…" + s.slice(-3) : s;
  }

  function fillPicker(quiet) {
    if (!pickEl) return;
    while (pickEl.firstChild) pickEl.removeChild(pickEl.firstChild);
    if (AI.sessions.length === 0) {
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（还没有聊过的对话）";
      pickEl.appendChild(opt);
      pickEl.disabled = true;
      if (modeReuseEl) modeReuseEl.disabled = true;
      // 没有旧会话就别让用户停在「选择对话」上，自动回到新对话
      if (modeReuseEl && modeReuseEl.checked && modeNewEl) modeNewEl.checked = true;
    } else {
      for (var i = 0; i < AI.sessions.length; i++) {
        var o = document.createElement("option");
        o.value = AI.sessions[i].id;
        o.textContent = AI.sessions[i].label;
        pickEl.appendChild(o);
      }
      pickEl.disabled = selectedMode() !== "reuse";
      if (modeReuseEl) modeReuseEl.disabled = false;
    }
    syncModeUi({ quiet: !!quiet });
  }

  function initSessionUi() {
    modeNewEl = $("ai-mode-new");
    modeReuseEl = $("ai-mode-reuse");
    pickEl = $("ai-pick");
    if (!modeNewEl || !modeReuseEl) return;
    // 切「新对话」→ 清空当前窗口；切「选择对话」→ 换回对应的那份记录。
    // 两种都由 syncModeUi → showModeMessages 统一处理，别在这里再补一次取历史，
    // 否则一次切换会发两个请求、画两遍内容。
    modeNewEl.addEventListener("change", function () {
      syncModeUi();
    });
    modeReuseEl.addEventListener("change", function () {
      syncModeUi();
    });
    if (pickEl) {
      pickEl.addEventListener("change", function () {
        // 换了一条对话：这时才需要单独取那一条（showModeMessages 只按当前选中项走）
        AI.reuseId = pickEl.value;
        loadChosenSessionHistory();
      });
    }
  }

  function openPanel(itemId, silentFocus) {
    // 从台账条目进来时清掉 skill / 风险作用域；对应入口在下面各自设回来
    if (itemId !== "__skills__") {
      AI.skill = null;
      AI.skillScope = false;
    }
    if (itemId !== "__risks__") AI.riskScope = false;
    if (itemId !== "__feature__") AI.featureScope = false;
    AI.busy = false;
    AI.reuseId = "";
    sendBtn.disabled = false;
    resetChat(itemId || null);
    inputEl.value = "";
    panel.classList.add("is-open");
    panel.classList.add("is-harness");

    // 默认新会话；再按当前作用域看看有没有旧会话可继续
    if (modeNewEl) modeNewEl.checked = true;
    if (modeReuseEl) modeReuseEl.checked = false;
    AI.sessions = [];
    // quiet：resetChat 刚铺好记录，这里别让控件同步把消息区清掉
    fillPicker(true);
    loadSessions();
    inputEl.placeholder = "选一个动作，或直接写你要它做的事";
    setHint("回答和过程都在这里显示");
    setTimeout(function () {
      // 自动恢复（页面重载）时不抢焦点：用户可能正在看别的，
      // 光标被拽进输入框会打断滚动和选中。
      if (!silentFocus) inputEl.focus();
    }, 260);
    // 记住「开着」和「在跟谁聊」，重载回来照原样恢复。
    // 只当对话框时不能记：那个 iframe 和主看板共用同一个键，它写一次就会把
    // 主看板正在聊的作用域覆盖成空，关掉窗口回到看板就发现串台了。
    if (!CHAT_ONLY) savePanelState(true);
  }

  // Skill 页专用的打开入口：skillName 为空表示"整页 skill"。
  // 用哨兵 ctx（__skills__）让 openPanel 照常走初始化流程；AI.skill / AI.skillScope
  // 记录真正的作用域，resetChat 会把哨兵清掉。
  function openSkillPanel(skillName, silentFocus) {
    AI.skill = skillName || null;
    AI.skillScope = true;
    AI.riskScope = false;
    AI.featureScope = false;
    openPanel("__skills__", silentFocus);
  }

  // 总览页「待处理风险」右侧的入口：只审风险车道。
  // 和「总结项目状态」的区别就在作用域 —— 那个是整本台账，这个是风险这一类，
  // 两者各有自己的会话，不会互相串。
  function openRiskPanel(silentFocus) {
    AI.skill = null;
    AI.skillScope = false;
    AI.riskScope = true;
    AI.featureScope = false;
    openPanel("__risks__", silentFocus);
  }

  // 需求车道「计划中」右侧的入口：只谈需求车道要加什么功能。
  // 和风险审核同一套机制，只是作用域换成需求 —— 两边的会话各走各的，
  // 不会和整本台账或风险审核串。
  function openFeaturePanel(silentFocus) {
    AI.skill = null;
    AI.skillScope = false;
    AI.riskScope = false;
    AI.featureScope = true;
    openPanel("__feature__", silentFocus);
  }

  function closePanel() {
    // 只当对话框时，这一层没有「关掉」这个动作 —— 关窗是外面那个窗口的事。
    if (CHAT_ONLY) {
      // 独立浏览器窗：本页就是那个窗口，关它就是关窗。
      // 注意只能关脚本自己开的窗（window.open 出来的），否则浏览器不理。
      if (!inFrame()) {
        try {
          window.close();
        } catch (e) {}
        return;
      }
      // Harness 外壳层的窗口：本 iframe 随后会整个被卸载，告诉外面收起来。
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "ops-board/chat-close" }, window.location.origin);
        }
      } catch (e) {}
      return;
    }
    panel.classList.remove("is-open");
    savePanelState(false);
  }

  // ── 面板开关状态 ────────────────────────────────────────────────
  //
  // 去 Harness 会话窗看一眼再回来，看板 iframe 会被整体卸载重建，页面一重载
  // 面板就是「关着」的样子 —— 明明刚才还在聊，回来却要重新点开。
  // 所以把「开着没开、在跟谁聊」记在 localStorage，加载时照原样摆回来。
  //
  // 只记作用域标识，不记消息内容：内容是 chatLog 和 Harness 会话的事。
  var PANEL_KEY = "ops-board-panel:";

  function panelStoreKey() {
    return PANEL_KEY + ((harnessEnv() && harnessEnv().id) || "default");
  }

  function savePanelState(open) {
    try {
      window.localStorage.setItem(
        panelStoreKey(),
        JSON.stringify({
          open: !!open,
          // 作用域：单条台账 / 单个 skill / 整页 skill / 风险审核 / 需求车道 / 整本台账。
          // 用 scopeId() 统一口径，否则风险审核会被记成""（=整本台账），
          // 重载后从风险入口回来的面板会显示成整本台账。
          scope: AI.skillScope
            ? (AI.skill ? "skill:" + AI.skill : "__skills__")
            : AI.riskScope
              ? "__risks__"
              : AI.featureScope
                ? "__feature__"
                : AI.ctx || "",
        })
      );
    } catch (e) {}
  }

  function readPanelState() {
    try {
      var raw = window.localStorage.getItem(panelStoreKey());
      if (!raw) return null;
      var v = JSON.parse(raw);
      return v && typeof v === "object" ? v : null;
    } catch (e) {
      return null;
    }
  }

  // 页面加载后，如果上次是开着的，就把它重新打开、并回到同一个作用域。
  function restorePanelState() {
    var st = readPanelState();
    if (!st || !st.open) return;
    var scope = String(st.scope || "");
    if (scope === "__risks__") {
      openRiskPanel(true);
    } else if (scope === "__feature__") {
      openFeaturePanel(true);
    } else if (scope === "__skills__") {
      openSkillPanel(null, true);
    } else if (scope.indexOf("skill:") === 0) {
      openSkillPanel(scope.slice(6), true);
    } else if (scope && D.items && D.items[scope]) {
      // 条目可能已经不在了（被关掉/改名），那就退回整本台账，别开一个空壳
      openPanel(scope, true);
    } else {
      openPanel("", true);
    }
    // 打开动作会把各控件重置成默认值，这里补一句把状态写回「开着」
    savePanelState(true);
  }

  // ── 浮窗化：拖位置、拉大小、钉在最上层、拉问答分界 ──────────────
  //
  // 以前这块是贴右边缘的整条抽屉：占满一屏高、盖掉半页台账，想边看条目边问
  // 就只能来回关。现在做成一个正常的对话小窗 —— 标题栏拖着走，八个边角拉大小，
  // 中间那条分界线上下拽，可以钉在最上层。
  //
  // 几何位置记在 localStorage，键名照样挂在 ops-board- 前缀下，
  // 这样设置里那句「清空本机偏好」按前缀扫的时候不会漏掉它。
  var WIN_KEY = "ops-board-win:";
  var MIN_W = 320;
  var MIN_H = 300;
  var WIN_EDGE = 8; // 离视口边至少留这么多，别贴着屏幕边画

  // mode: "float" 浮窗 / "dock" 贴右停靠（老样子）
  // foot: 输入区高度（像素）。0 表示没收手拉过，按内容自适应。
  var WIN = { mode: "float", pinned: false, x: 0, y: 0, w: 0, h: 0, foot: 0 };

  var headEl = $("ai-head");
  var bodyEl = $("ai-body");
  var footEl = $("ai-foot");
  var splitEl = $("ai-split");
  var pinBtn = $("ai-pin");
  var floatBtn = $("ai-float-toggle");
  var detachBtn = $("ai-detach");

  function winStoreKey() {
    return WIN_KEY + ((harnessEnv() && harnessEnv().id) || "default");
  }

  function winDefault() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(456, vw - 32);
    var h = Math.min(640, vh - 120);
    // 默认落在右下角：跟原来的位置一致，用户不用重新找它。
    return {
      mode: "float",
      pinned: false,
      x: Math.max(WIN_EDGE, vw - w - 26),
      y: Math.max(WIN_EDGE, vh - h - 26),
      w: w,
      h: h,
      foot: 0,
    };
  }

  // 把几何值夹回视口内。
  // 不夹的后果很实在：把窗口拖出屏幕再刷新，它就永远回不来了；
  // 而且超出视口的 fixed 元素会让整页多出一条横向滚动条。
  // 所以宁可让它「顶住」不动，也不许整块跑到屏幕外。
  function winClamp(g) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var out = {};
    out.w = Math.min(Math.max(g.w, MIN_W), Math.max(MIN_W, vw - WIN_EDGE * 2));
    out.h = Math.min(Math.max(g.h, MIN_H), Math.max(MIN_H, vh - WIN_EDGE * 2));
    var xHi = Math.max(WIN_EDGE, vw - WIN_EDGE - out.w);
    var yHi = Math.max(WIN_EDGE, vh - WIN_EDGE - out.h);
    out.x = Math.min(Math.max(g.x, WIN_EDGE), xHi);
    out.y = Math.min(Math.max(g.y, WIN_EDGE), yHi);
    return out;
  }

  // 分界线动的是「输入区多高」，消息区把剩下的吃掉。
  // 上下都留底线：上面至少留 96px 能看见一条回答，下面至少 96px 能写字。
  function applyFoot() {
    if (!footEl || !bodyEl) return;
    if (!WIN.foot) {
      footEl.style.height = "";
      footEl.removeAttribute("data-locked");
      markSplitCap(false);
      return;
    }
    var total = bodyEl.clientHeight;
    if (!total) return;
    // 只当对话框时没有「不拉过就自适应」这回事：那是整页浮窗的默认值。
    // 这里要的是「把当前高度钉住」，所以上下限都按实际可用高度算，
    // 不能沿用 96px 那条给浮窗留白用的底线 —— 窗口本来就小的时候，
    // 96px 会让输入区反而被撑大。
    if (CHAT_ONLY) {
      var capTo = Math.max(60, total - 60 - (splitEl ? splitEl.offsetHeight : 0));
      var want = Math.min(Math.max(WIN.foot, 60), capTo);
      WIN.foot = Math.round(want);
      footEl.style.height = WIN.foot + "px";
      footEl.setAttribute("data-locked", "1");
      markSplitCap(WIN.foot >= capTo - 1);
      return;
    }
    var hi = Math.max(96, total - 96 - (splitEl ? splitEl.offsetHeight : 0));
    var h = Math.min(Math.max(WIN.foot, 96), hi);
    WIN.foot = Math.round(h);
    // data-locked 让输入区不再被 flex 压缩：既然用户亲手定了高度，
    // 就该按他定的来，压缩交给回答区（它本来就会滚）。
    footEl.style.height = h + "px";
    footEl.setAttribute("data-locked", "1");
    markSplitCap(WIN.foot >= hi - 1);
  }

  // 拉到顶了就把手柄画灰：再往上拽不会有任何变化，不提示会以为坏了。
  function markSplitCap(atTop) {
    if (!splitEl) return;
    if (atTop) splitEl.classList.add("is-capped");
    else splitEl.classList.remove("is-capped");
  }

  function applyWin() {
    if (!panel) return;
    panel.setAttribute("data-mode", WIN.mode);
    panel.setAttribute("data-pinned", WIN.pinned ? "1" : "0");
    if (pinBtn) {
      pinBtn.setAttribute("aria-pressed", WIN.pinned ? "true" : "false");
      pinBtn.title = WIN.pinned ? "置顶中：盖在搜索和设置上面，点一下取消" : "置顶：盖在搜索和设置上面";
    }
    if (floatBtn) {
      floatBtn.textContent = WIN.mode === "dock" ? "浮窗" : "停靠";
      floatBtn.title =
        WIN.mode === "dock" ? "切回可拖动的小浮窗" : "贴到右边缘，跟原来一样占满整条边";
    }
    if (WIN.mode === "dock") {
      // 停靠形态全靠 CSS：内联几何留着会跟 top/bottom 打架，必须清掉。
      panel.style.left = "";
      panel.style.top = "";
      panel.style.width = "";
      panel.style.height = "";
    } else {
      var g = winClamp(WIN);
      WIN.x = Math.round(g.x);
      WIN.y = Math.round(g.y);
      WIN.w = Math.round(g.w);
      WIN.h = Math.round(g.h);
      panel.style.left = WIN.x + "px";
      panel.style.top = WIN.y + "px";
      panel.style.width = WIN.w + "px";
      panel.style.height = WIN.h + "px";
    }
    applyFoot();
  }

  function saveWin() {
    try {
      window.localStorage.setItem(winStoreKey(), JSON.stringify(WIN));
    } catch (e) {}
  }

  function loadWin() {
    var d = winDefault();
    try {
      var raw = window.localStorage.getItem(winStoreKey());
      if (raw) {
        var v = JSON.parse(raw);
        if (v && typeof v === "object") {
          if (v.mode === "dock" || v.mode === "float") d.mode = v.mode;
          d.pinned = !!v.pinned;
          if (typeof v.x === "number" && isFinite(v.x)) d.x = v.x;
          if (typeof v.y === "number" && isFinite(v.y)) d.y = v.y;
          if (typeof v.w === "number" && isFinite(v.w) && v.w > 0) d.w = v.w;
          if (typeof v.h === "number" && isFinite(v.h) && v.h > 0) d.h = v.h;
          if (typeof v.foot === "number" && isFinite(v.foot) && v.foot > 0) d.foot = v.foot;
        }
      }
    } catch (e) {}
    WIN = d;
  }

  // 一次拖拽的公共壳子：指针捕获 + 面板上那个 is-moving（禁选中、换光标）。
  // 用 pointer 事件而不是 mouse：触屏和手写笔都能用，不用写两套。
  function dragOnce(startEv, onMove, onDone) {
    var moved = false;
    var sx = startEv.clientX;
    var sy = startEv.clientY;
    var pid = startEv.pointerId;
    function move(ev) {
      if (ev.pointerId !== pid) return;
      moved = true;
      onMove(ev.clientX - sx, ev.clientY - sy, ev);
    }
    function up(ev) {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      panel.classList.remove("is-moving");
      if (splitEl) splitEl.classList.remove("is-moving");
      if (onDone) onDone(moved);
    }
    startEv.preventDefault();
    panel.classList.add("is-moving");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // 问答区 / 输入区之间的那条分界。单独拎出来是因为「只当对话框」那种活法
  // 也要它 —— 窗口大小归外面的 Harness 管，但「消息区多高、输入区多高」
  // 仍然该由用户在这儿拉。两种活法的差别只在存不存：整页时记住高度，
  // 只当对话框时不记（那个 iframe 关掉就卸载了，记了也没人读，还会跟
  // 主看板抢同一个键）。
  function initSplit() {
    if (!splitEl) return;

    splitEl.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      var foot0 = footEl ? footEl.offsetHeight : 0;
      splitEl.classList.add("is-moving");
      dragOnce(
        ev,
        function (dx, dy) {
          WIN.foot = foot0 - dy;
          applyFoot();
        },
        function () {
          if (!WIN.foot) applyFoot();
          if (!CHAT_ONLY) saveWin();
        }
      );
    });

    // 键盘也能调：抓不住鼠标的时候（或者就想精确一点）用上下键。
    splitEl.addEventListener("keydown", function (ev) {
      var step = ev.shiftKey ? 40 : 12;
      if (ev.key === "ArrowUp") {
        WIN.foot = (WIN.foot || (footEl ? footEl.offsetHeight : 0)) + step;
      } else if (ev.key === "ArrowDown") {
        WIN.foot = (WIN.foot || (footEl ? footEl.offsetHeight : 0)) - step;
      } else if (ev.key === "Enter" || ev.key === "Home") {
        WIN.foot = 0;
      } else {
        return;
      }
      ev.preventDefault();
      applyFoot();
      if (!CHAT_ONLY) saveWin();
    });

    // 双击分界 = 收回自适应高度，跟大多数编辑器一个手感。
    splitEl.addEventListener("dblclick", function () {
      WIN.foot = 0;
      applyFoot();
      if (!CHAT_ONLY) saveWin();
    });
  }

  function initFloat() {
    if (!panel) return;
    loadWin();

    // 标题栏拖动。按钮和下拉自己要用点击，不能顺带把窗口拖走。
    if (headEl) {
      headEl.addEventListener("pointerdown", function (ev) {
        if (WIN.mode !== "float") return;
        if (ev.button !== 0) return;
        var t = ev.target;
        if (t && t.closest && t.closest("button,select,input,textarea,a")) return;
        var x0 = WIN.x;
        var y0 = WIN.y;
        dragOnce(
          ev,
          function (dx, dy) {
            WIN.x = x0 + dx;
            WIN.y = y0 + dy;
            var g = winClamp(WIN);
            WIN.x = Math.round(g.x);
            WIN.y = Math.round(g.y);
            panel.style.left = WIN.x + "px";
            panel.style.top = WIN.y + "px";
          },
          function () {
            saveWin();
          }
        );
      });
    }

    // 八条边/角拉大小。宽高都有底线，所以拉到最小时是「顶住」而不是翻转。
    Array.prototype.forEach.call(panel.querySelectorAll(".ai-grip"), function (grip) {
      grip.addEventListener("pointerdown", function (ev) {
        if (WIN.mode !== "float") return;
        if (ev.button !== 0) return;
        var dir = grip.getAttribute("data-dir") || "";
        var r = panel.getBoundingClientRect();
        var left = r.left;
        var top = r.top;
        var right = r.left + r.width;
        var bottom = r.top + r.height;
        dragOnce(
          ev,
          function (dx, dy) {
            var l = left;
            var t = top;
            var rt = right;
            var bt = bottom;
            if (dir.indexOf("e") > -1) rt = right + dx;
            if (dir.indexOf("w") > -1) l = left + dx;
            if (dir.indexOf("s") > -1) bt = bottom + dy;
            if (dir.indexOf("n") > -1) t = top + dy;
            var w = Math.max(MIN_W, rt - l);
            var h = Math.max(MIN_H, bt - t);
            // 从左边/上边拉的时候，对面那条边是不动的，位置要跟着回算，
            // 否则窗口会一边变宽一边往右跑。
            if (dir.indexOf("w") > -1) l = rt - w;
            if (dir.indexOf("n") > -1) t = bt - h;
            WIN.x = l;
            WIN.y = t;
            WIN.w = w;
            WIN.h = h;
            var g = winClamp(WIN);
            WIN.x = Math.round(g.x);
            WIN.y = Math.round(g.y);
            WIN.w = Math.round(g.w);
            WIN.h = Math.round(g.h);
            panel.style.left = WIN.x + "px";
            panel.style.top = WIN.y + "px";
            panel.style.width = WIN.w + "px";
            panel.style.height = WIN.h + "px";
            applyFoot();
          },
          function () {
            saveWin();
          }
        );
      });
    });

    // 问答区 / 输入区之间的那条分界。
    initSplit();

    if (pinBtn) {
      pinBtn.addEventListener("click", function () {
        WIN.pinned = !WIN.pinned;
        applyWin();
        saveWin();
      });
    }

    if (floatBtn) {
      floatBtn.addEventListener("click", function () {
        WIN.mode = WIN.mode === "dock" ? "float" : "dock";
        applyWin();
        saveWin();
      });
    }

    // 「弹窗」：把这条对话拿到系统浏览器的一个独立窗口里。
    if (detachBtn) detachBtn.addEventListener("click", function () { detachChat(); });

    // 视口变小（切窗口、拉窄、投屏）时把窗口夹回来，
    // 不然它会飘到看不见的地方，下次打开就跟丢了一样。
    window.addEventListener("resize", function () {
      if (WIN.mode !== "float") {
        applyFoot();
        return;
      }
      applyWin();
      saveWin();
    });

    applyWin();
  }

  // 「弹窗」：把这条对话拿到一个真正独立的窗口里。
  //
  // 这里说的「独立」是字面意思 —— 一个系统浏览器窗口，Harness 的主窗口
  // 最小化、被别的窗口盖住，它都还在那儿。之前两版都不算：
  //   · 第一版在面板里画了个 position:fixed 的浮层，出不了 iframe 那个矩形；
  //   · 第二版由插件画在 Harness 外壳层，看着像窗口，实际还是 Harness 窗口
  //     里面的一个子区域，Harness 一关它就没了。
  //
  // 现在直接 window.open 一个 http 地址。在 Harness 里，Electron 的
  // setWindowOpenHandler 会把 http 链接交给系统浏览器（deny + openExternal），
  // 所以落地就是系统浏览器的一个新窗口。
  //
  // 关键在地址：本页在面板里时源是 dsh-app://app，那是 Electron 的私有协议，
  // 浏览器打不开；必须换成 Harness 的 http 源（/ops-board/state 的 origin），
  // 再拼上本页路径 —— 那条路径本来就是 Harness 的看板代理，能直接把这份页面
  // 再托管一遍，顺带注入 __OPS_HARNESS__，独立窗才知道自己属于哪块板。
  //
  // 独立窗和插件不同源，问/答都走看板服务的中转（见上面的 relay*）。
  function detachChat() {
    // 没有 __OPS_HARNESS__ 说明这一份页面不是经 Harness 打开的（直接双击 html、
    // 或者停在裸看板服务端口上）。那种页面本来就问不了 AI，弹出来只会是个
    // 「要在 Harness 里打开」的空壳 —— 不如当场说清楚。
    if (!harnessEnv()) {
      setHint("这块板要在 Harness 里打开才能问 AI（侧栏「项目看板」），弹窗也是。", true);
      return;
    }
    var scope = scopeId();
    var path = location.pathname;
    var url = "";
    var query = "chat=1" + (scope ? "&scope=" + encodeURIComponent(scope) : "");

    var launch = function (origin) {
      if (!originUsable(origin)) {
        // 拿不到 http 源 —— 退回到 Harness 外壳层那个窗口。
        // 它不是真独立窗，但至少这条对话还能接着聊，不留一个点不动的按钮。
        fallbackToShellWindow(scope);
        return;
      }
      url = String(origin).replace(/\/+$/, "") + path + (path.indexOf("?") >= 0 ? "&" : "?") + query;
      var opened = null;
      try {
        // 不加 noopener：Electron 的 setWindowOpenHandler 已经 deny + openExternal，
        // 交出去的是系统浏览器里一个干净的新窗口，本来就没有 opener 关系。
        opened = window.open(url, "_blank");
      } catch (e) {
        opened = null;
      }
      if (opened) {
        try {
          opened.opener = null;
        } catch (e) {}
        setHint("已经在系统浏览器的独立窗口里打开了。关掉它不影响看板，Harness 开着就能接着问。");
        return;
      }
      // 在 Harness 里返回 null 是**正常**的：setWindowOpenHandler 的动作是 deny，
      // 窗口被交给了系统浏览器。所以这里不报错，只把地址带上 —— 万一是被弹窗
      // 拦了（例如这份页面已经不在 Harness 里），人还能照着它自己开。
      setHint("已交给系统浏览器打开：" + url);
    };

    // 进页面时就开始问 origin，点的时候大概率已经在手里 —— window.open
    // 必须落在点击的手势里，异步拿到的源会被当成弹窗拦掉。
    if (HTTP_ORIGIN) launch(HTTP_ORIGIN);
    else fetchHttpOrigin(launch);
  }

  // 兜底：老路 —— 让插件在 Harness 外壳层画一个窗口。
  // 只有拿不到 http 源时才走这里。它不是真独立窗，别在别处也调它。
  function fallbackToShellWindow(scope) {
    var payload = {
      type: "ops-board/chat-open",
      board: (harnessEnv() && harnessEnv().id) || "",
      // 插件拼上 ?chat=1 即可。只取 pathname：查询串里可能已经有调试参数。
      proxy: location.pathname,
      scope: scope,
      skill: AI.skill || "",
      skillScope: !!AI.skillScope,
      riskScope: !!AI.riskScope,
      featureScope: !!AI.featureScope,
      ctx: AI.ctx || "",
    };
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, window.location.origin);
        setHint("已经在 Harness 的独立窗口里打开了，拖它、拉大小、置顶都可以。");
        return;
      }
    } catch (e) {}
    setHint("没能打开独立窗口：这块看板不是在 Harness 里打开的。", true);
  }

  function setHint(text, warn) {
    hintEl.textContent = text || "";
    hintEl.style.color = warn ? "var(--red)" : "";
  }

  // ── 发送 ──

  // 以前这里按关键词猜「要不要跳去 Harness 会话窗」：
  // 命中「动手 / 更新 / 解决一下」就跳，理由是「改动要让人看着」。
  // 实际效果是点一下就跳走，面板里的对话当场断掉，这个窗口形同虚设。
  //
  // 现在一律留在面板里：回答 + 工具调用过程都回来，想看完整会话时
  // 点每条回答下面的「去 Harness 看完整会话」。
  // 函数留着是因为 harnessPost 的 inline 参数还在用（决定要不要等回答）。
  function shouldInline() {
    return true;
  }

  function sendHarness(text) {
    if (!text) {
      setHint("先选一个动作，或写一句要问的。", true);
      return;
    }
    var inline = shouldInline(text);
    AI.busy = true;
    sendBtn.disabled = true;
    // 接进哪条对话：以 AI.reuseId 为准（它就是下拉选中项，openPanel/切模式时同步过），
    // 只在它为空时退回读控件。判定「是否有可选对话」不能只看 pickEl.value ——
    // 下拉在没铺开（还没拿到列表）时是空值，那会把用户的选择丢掉、变成新开会话。
    var reuse = "";
    if (selectedMode() === "reuse") {
      reuse = AI.reuseId || (pickEl ? pickEl.value : "") || "";
    }
    setHint(reuse ? "正在接进上次的会话…" : "正在回答，过程也会显示在这里…");
    var fresh = !reuse;
    var skillKey = AI.skill || null;
    // 只有会话第一句带背景（作用域/条目原文/回答规则）。后续提问只发原话——
    // 会话本身已经记得上下文，重发一遍只会把真正的问题淹掉。
    // AI.fresh 是「这个面板还没问过话」的标记：openPanel 置 true，首次发送成功置 false。
    //
    // 接进已有会话时一律不带背景：那条会话已经聊过，它自己就记得上下文；
    // 再灌一遍等于把看板模板的背景插进别人正在进行的话题里，把真问题挤走。
    var withContext = reuse ? false : AI.fresh;
    // 作用域键用 scopeId()，不能传 AI.ctx —— 风险审核 / 需求车道的 ctx 都是空的，
    // 传空会让插件端按 "__global__" 记账，和整本台账的会话串成一条。
    harnessPost(
      AI.riskScope ? "__risks__" : AI.featureScope ? "__feature__" : AI.ctx || null,
      text,
      fresh,
      function (result) {
      AI.busy = false;
      sendBtn.disabled = false;
      if (!result.ok) {
        setHint(result.error || "发送失败", true);
        return;
      }
      AI.fresh = false;
      // 这个作用域已经重新开始聊了，「刚清空」的标记作废：
      // 之后再开面板应该看到这次的新对话，而不是又回到空白。
      markCleared(false);
      inputEl.value = "";
      var empty = msgsEl.querySelector(".ai-empty");
      if (empty) empty.remove();
      addMsg("user", text);
      // 立刻落库：哪怕回答还没回来、用户中途跳走，回来也还看得见自己问过什么。
      pushChatLog({ role: "user", text: text });
      // 一律 inline：挂一条「正在回答」，等回答回来时替换掉它。
      // 挂在这里而不是 harnessPost 里，是因为要拿到气泡元素才能后续填充。
      var body = addMsg("ai", "正在回答…", "is-pending");
      if (result.askId) PENDING[result.askId] = body;
      setHint(reuse ? "接进上次的会话，回答会留在看板里。" : "回答会留在看板里，过程也会显示出来。");
    }, skillKey, inline, reuse, withContext);
  }

  // 只有一条发送路径：交给 Harness。
  // 模板里不再有「页面直连模型」这回事 —— 密钥、模型、重试都归 Harness 管。
  function send() {
    if (AI.busy) return;
    var text = inputEl.value.trim();
    if (!text) {
      setHint("先选一个动作，或写一句要问的。", true);
      return;
    }
    if (!harnessEnv()) {
      // 裸页（没经过 Harness 注入）没有可以接收问题的地方。
      // 说清楚该从哪进，别让人对着按不动的按钮猜。
      setHint("这块板要在 Harness 里打开才能问 AI（侧栏「项目看板」）。", true);
      return;
    }
    sendHarness(text);
  }

  // ask.enabled=false 时 render.mjs 不输出面板，这里所有 $("ai-xxx") 都是 null。
  // 以前直接 addEventListener 会抛 TypeError，把后面 32 行一起带走 ——
  // 包括全局快捷键和总览页入口，连路由绑定之后的逻辑都受影响。
  // 所以先问一句面板在不在，不在就把「问 AI」按钮收掉，别留一个点了没反应的壳。
  if (!panel) {
    Array.prototype.forEach.call(
      document.querySelectorAll(
        "[data-ask], [data-ask-skill], [data-ask-skills], [data-ask-global], [data-ask-risks], [data-ask-feature]"
      ),
      function (b) {
        b.parentNode && b.parentNode.removeChild(b);
      }
    );
    route();
    return;
  }

  $("ai-send").addEventListener("click", send);
  $("ai-close").addEventListener("click", closePanel);
  initSessionUi();

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (finder && finder.classList.contains("is-open")) {
      closeFinder();
      return;
    }
    if (settingsEl && settingsEl.classList.contains("is-open")) {
      closeSettings();
      return;
    }
    if (panel.classList.contains("is-open")) closePanel();
  });

  // 接住插件回过来的历史。
  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || data.type !== "ops-board/history") return;
    var waiter = HISTORY_WAIT[data.reqId];
    if (!waiter) return;
    delete HISTORY_WAIT[data.reqId];
    waiter(data);
  });

  // 接住插件投回来的回答。
  //
  // 链路：看板 POST /ops-board/ask（带 inline + askId）→ 插件建/复用会话 →
  // session.prompt → 插件轮询事件窗口读到这一轮的正文 →
  // postMessage 回来看板的 iframe。
  //
  // 回答是异步的，可能这一轮还没回、人就点了别的动作，所以按 askId 找气泡，
  // 找不到就说明那条气泡已经不在了（面板被重开过），直接丢弃，不报错。
  window.addEventListener("message", function (event) {
    // 同源校验：插件是父窗口，看板在 iframe 里，origin 一致。
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || data.type !== "ops-board/answer") return;
    // 只收自己那一份。回答是广播的（插件拿不到发问窗口的引用），所以
    // 带上 surface 自报家门；没带的老版本插件按「整页」处理 —— 那时候
    // 还只有整页这一种窗口，行为不变。
    //
    // 但 surface 要过 Host 的 /ops-board/ask 一道手，Host 是插件代码，
    // 改完得重启应用才生效。旧版 Host 会把 surface 落成默认的 'page' 再发出去 ——
    // 那是个「错误但非空」的值，光看字段就会被它骗过去：独立窗收不到回答，
    // 整页那边反而多补一条气泡。
    //
    // 所以判定改成「askId 优先」：askId 中间那一位 c/p 是发问方自己写的，
    // 不经过 Host 的任何判断，原样绕回来了。只有老看板发的 id 没有这一位，
    // 那时再退回 surface 字段（也就退回「只有整页」那个年代的行为）。
    var idTag = /^ask-([cp])-/.exec(String(data.askId || ""));
    var src = idTag ? (idTag[1] === "c" ? "chat" : "page") : data.surface || "page";
    if (src !== SURFACE) return;
    var body = PENDING[data.askId];
    // 气泡不在了（页面被重载过：跳去 Harness 再回来、或者面板被重开），
    // 但回答是真实发生过的，不能就这样丢掉 —— 补一条新气泡把它显示出来，
    // 下面照常落库，这样「关掉再回来」也不会丢东西。
    if (!body) {
      var emptyNow = msgsEl.querySelector(".ai-empty");
      if (emptyNow) emptyNow.remove();
      body = addMsg("ai", "正在回答…", "is-pending is-late");
    } else {
      delete PENDING[data.askId];
    }
    var wrap = body.parentNode;
    if (wrap) wrap.className = wrap.className.replace(/\s*is-pending\b/, "");
    // 复用旧会话时，这次回答会带上该会话的既有历史。把它渲染在面板顶部（正好
    // 顶替掉 resetChat 留下的「当前还空着」的占位），让「选择对话」真的能
    // 看见之前聊过什么，而不是一个空窗口。只在面板还是空占位时才插入，避免
    // 对话框里已经聊开之后重复刷历史。
    if (data.history && data.history.length) {
      var empty = msgsEl.querySelector(".ai-empty");
      if (empty) {
        empty.remove();
        var divider = document.createElement("div");
        divider.className = "msg-divider";
        divider.textContent = "── 上次对话 ──────────────";
        msgsEl.insertBefore(divider, msgsEl.firstChild);
        for (var hi = data.history.length - 1; hi >= 0; hi--) {
          var hmsg = data.history[hi];
          if (!hmsg || !hmsg.text) continue;
          var hb = addMsg(hmsg.role === "user" ? "user" : "ai", hmsg.text, "is-history");
          // addMsg 会 append 到末尾；要按顺序回插到最前面，需显式移动到开头。
          if (hb && hb.parentNode) msgsEl.insertBefore(hb.parentNode, divider);
        }
      }
    }
    if (data.error) {
      body.innerHTML = renderText("没拿到回答：" + data.error);
      body.className = "msg-body msg-error";
    } else {
      var hasSteps = data.steps && data.steps.length;
      if (data.text) {
        body.innerHTML = renderText(data.text);
        body.className = "msg-body";
      } else if (hasSteps) {
        // 只有动作、没有解释：别再说「去会话里看」，过程就在下面。
        body.innerHTML = renderText("这一轮没有文字回答，做了下面这些事：");
        body.className = "msg-body";
      } else {
        body.innerHTML = renderText("这一轮没有文字回答，也没看到动作。");
        body.className = "msg-body";
      }
      // 过程清单挂在正文下面；折叠起来，想看的再点开。
      var stepsEl = renderSteps(data.steps);
      if (stepsEl && wrap) {
        var details = document.createElement("details");
        details.className = "msg-steps-wrap";
        var summary = document.createElement("summary");
        summary.textContent = "过程 · " + data.steps.length + " 步";
        details.appendChild(summary);
        details.appendChild(stepsEl);
        wrap.appendChild(details);
      }
      // 想看完整会话（含思考、原始输出）时，给一个跳转入口。
      if (wrap && data.sessionId) {
        var link = document.createElement("button");
        link.type = "button";
        link.className = "msg-goto";
        link.textContent = "去 Harness 看完整会话";
        link.addEventListener("click", function () {
          // 独立窗口里够不着插件（不同源），postToHost 会改走 HTTP 中转。
          try {
            postToHost({ type: "ops-board/open-session", sessionId: data.sessionId });
          } catch (e) {}
        });
        wrap.appendChild(link);
      }
    }
    // 把这一轮的回答也落库，这样跳去 Harness 看完整会话再回来，问答都还在。
    // 只存文字和步骤摘要；「去 Harness」那个按钮是临时的，不存。
    pushChatLog({
      role: "ai",
      text: data.error
        ? "没拿到回答：" + data.error
        : data.text || (data.steps && data.steps.length ? "这一轮没有文字回答，做了下面这些事：" : "这一轮没有文字回答，也没看到动作。"),
      steps: data.steps || [],
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  // 总览页的入口：把整本台账交给 Harness（总结 + 更新）。
  var globalAsk = document.querySelector("[data-ask-global]");
  if (globalAsk) {
    globalAsk.textContent = "总结项目状态";
    globalAsk.addEventListener("click", function (e) {
      e.preventDefault();
      openPanel(null);
    });
  }

  // 「待处理风险」右侧的入口：只审风险车道，和整本台账各用一条会话。
  var riskAsk = document.querySelector("[data-ask-risks]");
  if (riskAsk) {
    riskAsk.textContent = "风险审核";
    riskAsk.addEventListener("click", function (e) {
      e.preventDefault();
      openRiskPanel();
    });
  }

  // 需求车道「计划中」右侧的入口：跟 AI 谈还要加什么功能，作用域是需求车道。
  var featureAsk = document.querySelector("[data-ask-feature]");
  if (featureAsk) {
    featureAsk.textContent = "和 AI 谈谈要加什么";
    featureAsk.addEventListener("click", function (e) {
      e.preventDefault();
      openFeaturePanel();
    });
  }

  // ─────────────────────── 搜索 ───────────────────────

  // 为什么自己写一层，不用浏览器自带的 Ctrl+F：
  // 整本台账是一个文件里的 6 个视图，没激活的视图、收起来的卡片、AI 面板里的字
  // 全都还在 DOM 里，自带查找会命中一堆当前根本看不到的东西，而且它只能滚到文字，
  // 没法「按条目跳过去」。这层只搜条目本身，命中点按条目分组列出来。
  var finder = $("finder");
  var finderInput = $("finder-input");
  var finderResults = $("finder-results");
  var finderCount = $("finder-count");
  var finderRows = [];
  var finderCursor = -1;
  var MAX_HIT = 5;

  // sections 进到前端时已经是「【具体表现】…\n\n【影响】…」拼好的一整串，
  // 所以按空行切块、按 【标签】 认位置，不去猜它的内部结构。
  function splitBlocks(sections) {
    var out = [];
    if (!sections) return out;
    String(sections)
      .split(/\n{2,}/)
      .forEach(function (chunk) {
        var t = chunk.replace(/\s+$/, "");
        if (!t) return;
        var m = /^【([^】]{1,14})】\s*/.exec(t);
        out.push({
          where: m ? m[1] : "正文",
          text: m ? t.slice(m[0].length) : t,
        });
      });
    return out;
  }

  // evidence 是「- 提交：commit 0aa2787（10-30 09:24）」一行一条。
  // 「- 提交：」里的「提交」正好是给人看的位置名，直接拿来用。
  function evidenceLines(evidence) {
    var out = [];
    if (!evidence) return out;
    String(evidence)
      .split(/\n/)
      .forEach(function (line) {
        var t = line.replace(/^\s*-\s*/, "").replace(/\s+$/, "");
        if (!t || t.indexOf("（这条没有留下证据线索）") === 0) return;
        var m = /^([^：]{1,10})：([\s\S]*)$/.exec(t);
        out.push({
          where: m ? "证据·" + m[1] : "证据",
          text: m ? m[2] : t,
        });
      });
    return out;
  }

  function searchItems(q) {
    var p = prefsNow();
    var ql = q.toLowerCase();
    var groups = [];
    var total = 0;
    Object.keys(D.items || {}).forEach(function (key) {
      var item = D.items[key] || {};
      var id = item.id || key;
      var fields = [
        { where: "编号", text: id },
        { where: "标题", text: item.title || "" },
      ];
      if (p.scope !== "title") fields = fields.concat(splitBlocks(item.sections));
      if (p.scope === "all") {
        if (p.evidence) fields = fields.concat(evidenceLines(item.evidence));
        if (item.area) fields.push({ where: "领域", text: item.area });
        if (item.statusLabel) fields.push({ where: "状态", text: item.statusLabel });
      }
      var hits = [];
      fields.forEach(function (f) {
        var t = f.text || "";
        if (!t) return;
        if (t.toLowerCase().indexOf(ql) >= 0) hits.push({ where: f.where, text: t });
      });
      if (!hits.length) return;
      total += hits.length;
      groups.push({
        id: id,
        title: item.title || "",
        lane: item.laneLabel || "",
        hits: hits,
      });
    });
    return { groups: groups, hits: total };
  }

  // 把一段文字里的命中词包成 <b>。用 indexOf 逐段切，不拼 HTML 字符串，
  // 台账正文里有引号、尖括号，走 innerHTML 迟早点坑。
  function markInto(el, text, q) {
    if (!q) {
      el.textContent = text;
      return;
    }
    var low = text.toLowerCase();
    var ql = q.toLowerCase();
    var from = 0;
    var i = low.indexOf(ql, from);
    if (i < 0) {
      el.textContent = text;
      return;
    }
    while (i >= 0) {
      if (i > from) el.appendChild(document.createTextNode(text.slice(from, i)));
      var b = document.createElement("b");
      b.textContent = text.slice(i, i + ql.length);
      el.appendChild(b);
      from = i + ql.length;
      i = low.indexOf(ql, from);
    }
    if (from < text.length) el.appendChild(document.createTextNode(text.slice(from)));
  }

  // 命中那一行只留一截上下文，长了看不出命中在哪、短了没信息。
  function snippet(text, q, before, after) {
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    var body = text.replace(/\s+/g, " ");
    if (i < 0) return body.slice(0, before + after);
    var start = Math.max(0, i - before);
    var end = Math.min(text.length, i + q.length + after);
    var out = text.slice(start, end).replace(/\s+/g, " ");
    if (start > 0) out = "…" + out;
    if (end < text.length) out = out + "…";
    return out;
  }

  function paintCursor() {
    finderRows.forEach(function (b, i) {
      b.classList.toggle("is-active", i === finderCursor);
    });
  }

  function paintResults(q) {
    if (!finderResults) return;
    finderResults.textContent = "";
    finderRows = [];
    finderCursor = -1;
    if (finderCount) finderCount.textContent = "";

    var total = Object.keys(D.items || {}).length;
    if (!q) {
      var tip = document.createElement("p");
      tip.className = "finder-empty";
      tip.textContent = "这板现在有 " + total + " 条，输入关键词开始搜。";
      finderResults.appendChild(tip);
      return;
    }

    var found = searchItems(q);
    // 标题那一条不单独列：分组头已经把标题连同高亮一起显示了，
    // 再补一行「标题 …同一句话」只是把同一句话念两遍。
    // 但计数还是要算上它 —— 分组头那行本身就是一处命中。
    var shownHits = 0;
    found.groups.forEach(function (g) {
      var titleHit = false;
      g.shown = g.hits.filter(function (h) {
        if (h.where === "标题") {
          titleHit = true;
          return false;
        }
        return true;
      });
      shownHits += g.shown.length + (titleHit ? 1 : 0);
    });
    if (finderCount) {
      finderCount.textContent =
        found.groups.length + " 条 · " + shownHits + " 处命中";
    }
    if (!found.groups.length) {
      var none = document.createElement("p");
      none.className = "finder-empty";
      none.textContent = "没搜到「" + q + "」。换个词，或者去设置里把搜索范围放宽到「全部字段」。";
      finderResults.appendChild(none);
      return;
    }

    found.groups.forEach(function (g) {
      var group = document.createElement("div");
      group.className = "finder-group";

      var head = document.createElement("button");
      head.type = "button";
      head.className = "finder-item";
      head.setAttribute("data-jump", g.id);
      var idEl = document.createElement("span");
      idEl.className = "finder-id";
      markInto(idEl, g.id, q);
      var titleEl = document.createElement("span");
      titleEl.className = "finder-title";
      markInto(titleEl, g.title, q);
      head.appendChild(idEl);
      head.appendChild(titleEl);
      if (g.lane) {
        var laneEl = document.createElement("span");
        laneEl.className = "finder-lane";
        laneEl.textContent = g.lane;
        head.appendChild(laneEl);
      }
      group.appendChild(head);
      finderRows.push(head);

      g.shown.slice(0, MAX_HIT).forEach(function (h) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "finder-hit";
        row.setAttribute("data-jump", g.id);
        var where = document.createElement("span");
        where.className = "finder-where";
        where.textContent = h.where;
        var snip = document.createElement("span");
        snip.className = "finder-snip";
        markInto(snip, snippet(h.text, q, 24, 56), q);
        row.appendChild(where);
        row.appendChild(snip);
        group.appendChild(row);
        finderRows.push(row);
      });

      if (g.shown.length > MAX_HIT) {
        var more = document.createElement("p");
        more.className = "finder-more";
        more.textContent = "还有 " + (g.shown.length - MAX_HIT) + " 处命中，点标题打开这条看全文。";
        group.appendChild(more);
      }

      finderResults.appendChild(group);
    });

    finderCursor = 0;
    paintCursor();
  }

  // 跳到某条：先切到它所在的视图，再滚过去。
  // 和 route() 处理条目标题锚点走同一条路，收起来的卡片会被 scrollToEl 展开。
  function goItem(id) {
    if (!id) return;
    var view = ITEM_VIEW[id] || viewOfId(id);
    if (view) show(view);
    try {
      history.replaceState(null, "", "#" + id);
    } catch (e) {}
    saveRoute("#" + id);
    nextFrame(function () {
      scrollToEl(id);
    });
  }

  function openFinder() {
    if (!finder) return;
    finder.classList.add("is-open");
    paintResults(finderInput ? finderInput.value.trim() : "");
    if (finderInput) {
      finderInput.focus();
      finderInput.select();
    }
  }

  function closeFinder() {
    if (!finder) return;
    finder.classList.remove("is-open");
    finderCursor = -1;
    paintCursor();
  }

  function initFinder() {
    if (!finder) return;
    var openBtn = $("finder-open");
    if (openBtn) {
      openBtn.addEventListener("click", function (e) {
        e.preventDefault();
        openFinder();
      });
    }
    var closeBtn = $("finder-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        closeFinder();
      });
    }
    if (finderInput) {
      // 每敲一个字就重算。台账最多几十条，重算比「防抖后再算」更好用：
      // 敲完立刻看到结果变少，比等 200 毫秒更像在搜索。
      finderInput.addEventListener("input", function () {
        paintResults(finderInput.value.trim());
      });
      finderInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var pick = finderRows[finderCursor >= 0 ? finderCursor : 0];
          if (pick) {
            var jump = pick.getAttribute("data-jump");
            closeFinder();
            goItem(jump);
          }
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (!finderRows.length) return;
          e.preventDefault();
          var step = e.key === "ArrowDown" ? 1 : -1;
          finderCursor = (finderCursor + step + finderRows.length) % finderRows.length;
          paintCursor();
          var cur = finderRows[finderCursor];
          if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
        }
      });
    }
    if (finderResults) {
      finderResults.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-jump]") : null;
        if (!btn) return;
        e.preventDefault();
        var id = btn.getAttribute("data-jump");
        closeFinder();
        goItem(id);
      });
    }
    // Ctrl+F / ⌘F：设置里可以关掉，关掉后浏览器自带的查找就回来了。
    document.addEventListener("keydown", function (e) {
      var isF = e.key === "f" || e.key === "F" || e.code === "KeyF";
      if (!isF || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (!prefsNow().hotkey) return;
      e.preventDefault();
      openFinder();
    });
  }

  // ─────────────────────── 设置 ───────────────────────

  var settingsEl = $("settings");
  var settingsNote = $("set-note");
  var clearArmed = false;
  var clearTimer = 0;

  function say(msg) {
    if (settingsNote) settingsNote.textContent = msg;
  }

  function paintSeg(id, value) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#" + id + " button"),
      function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-value") === String(value));
      }
    );
  }

  // 打开设置时一律按「当前真实状态」重画一遍，
  // 不在打开时缓存：顶栏色块、[ 快捷键、别处的改动都能被如实反映。
  function paintSettings() {
    if (!settingsEl) return;
    paintSeg("set-theme", document.documentElement.getAttribute("data-theme") || "night");
    paintSeg("set-font", prefsNow().font);
    paintSeg("set-rail", railHiddenNow() ? "1" : "0");
    var view = $("set-view");
    if (view) view.value = prefsNow().view || "";
    var scope = $("set-scope");
    if (scope) scope.value = prefsNow().scope;
    var ev = $("set-evidence");
    if (ev) ev.checked = !!prefsNow().evidence;
    var hk = $("set-hotkey");
    if (hk) hk.checked = !!prefsNow().hotkey;
  }

  function openSettings() {
    if (!settingsEl) return;
    settingsEl.classList.add("is-open");
    clearArmed = false;
    paintSettings();
  }

  function closeSettings() {
    if (!settingsEl) return;
    settingsEl.classList.remove("is-open");
  }

  function resetPrefs() {
    prefs = {};
    var k;
    for (k in PREF_DEF) prefs[k] = PREF_DEF[k];
    savePrefs();
    applyFont(prefs.font);
    applyTheme("night");
    setRail(false);
    paintSettings();
    say("已恢复默认：主题夜晚、字号标准、侧栏展开、默认页跟着上次、搜索搜全部字段。");
  }

  // 「清空」要连主题、侧栏、上次落点、AI 对话一起清，这些键不只本插件用，
  // 所以按前缀扫，而不是列一份迟早会漏的固定清单。
  function clearPrefs() {
    var i;
    try {
      var drop = [];
      for (i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (
          k.indexOf("ops-board-") === 0 ||
          k.indexOf("ops-mini-") === 0 ||
          k.indexOf("ops-fold-") === 0
        ) {
          drop.push(k);
        }
      }
      drop.forEach(function (n) {
        localStorage.removeItem(n);
      });
    } catch (e) {}
    // 内存里的偏好也一起回到出厂值，但界面要摆回默认态——
    // 摆的过程本身会写键（主题、侧栏），所以先摆完，最后再扫一遍删干净。
    prefs = null;
    applyFont(prefsNow().font);
    applyTheme("night");
    setRail(false);
    paintSettings();
    try {
      var again = [];
      for (i = 0; i < localStorage.length; i++) {
        var k2 = localStorage.key(i);
        if (!k2) continue;
        if (k2.indexOf("ops-board-") === 0 || k2.indexOf("ops-mini-") === 0) again.push(k2);
      }
      again.forEach(function (n) {
        localStorage.removeItem(n);
      });
    } catch (e) {}
    say("已清空本机偏好。台账本身不受影响；开着的 AI 对话与面板状态刷新一次就退场。");
  }

  function initSettings() {
    if (!settingsEl) return;
    var openBtn = $("settings-open");
    if (openBtn) {
      openBtn.addEventListener("click", function (e) {
        e.preventDefault();
        openSettings();
      });
    }
    var closeBtn = $("settings-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        closeSettings();
      });
    }
    // 点遮罩空白处关掉，点面板内部不关。
    settingsEl.addEventListener("click", function (e) {
      if (e.target === settingsEl) closeSettings();
    });

    var themeSeg = $("set-theme");
    if (themeSeg) {
      themeSeg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-value]");
        if (!b) return;
        applyTheme(b.getAttribute("data-value"));
        paintSettings();
      });
    }

    var fontSeg = $("set-font");
    if (fontSeg) {
      fontSeg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-value]");
        if (!b) return;
        prefsNow().font = Number(b.getAttribute("data-value"));
        savePrefs();
        applyFont(prefsNow().font);
        paintSettings();
      });
    }

    var railSeg = $("set-rail");
    if (railSeg) {
      railSeg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-value]");
        if (!b) return;
        setRail(b.getAttribute("data-value") === "1");
        paintSettings();
      });
    }

    var viewSel = $("set-view");
    if (viewSel) {
      viewSel.addEventListener("change", function () {
        prefsNow().view = viewSel.value || "";
        savePrefs();
        say(
          viewSel.value
            ? "下次没有停留记录时会打开这一页；有记录时仍然回上次的位置。"
            : "已改回「跟着上次停留的位置」。"
        );
      });
    }

    var scopeSel = $("set-scope");
    if (scopeSel) {
      scopeSel.addEventListener("change", function () {
        prefsNow().scope = scopeSel.value;
        savePrefs();
        if (finder && finder.classList.contains("is-open") && finderInput) {
          paintResults(finderInput.value.trim());
        }
      });
    }

    var evBox = $("set-evidence");
    if (evBox) {
      evBox.addEventListener("change", function () {
        prefsNow().evidence = !!evBox.checked;
        savePrefs();
        if (finder && finder.classList.contains("is-open") && finderInput) {
          paintResults(finderInput.value.trim());
        }
      });
    }

    var hkBox = $("set-hotkey");
    if (hkBox) {
      hkBox.addEventListener("change", function () {
        prefsNow().hotkey = !!hkBox.checked;
        savePrefs();
      });
    }

    var resetBtn = $("set-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        resetPrefs();
      });
    }

    // 清空是不可逆的，误点代价是一个月攒下的对话，所以要点两次。
    var clearBtn = $("set-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (!clearArmed) {
          clearArmed = true;
          clearBtn.textContent = "再点一次确认";
          say("再点一次「确认」就清空了，这一步不能撤销。");
          clearTimeout(clearTimer);
          clearTimer = setTimeout(function () {
            clearArmed = false;
            clearBtn.textContent = "清空本机偏好";
          }, 5000);
          return;
        }
        clearArmed = false;
        clearTimeout(clearTimer);
        clearBtn.textContent = "清空本机偏好";
        clearPrefs();
      });
    }
  }

  // ── 导出报表 ───────────────────────────────────────────────────
  //
  // 这件事的重点不是"把台账画一遍"，那看板本身就是。重点是生成一份
  // 能脱离看板、发给别人的文件：领导要周报、群里要日报、月底要归档。
  //
  // 区间按每块板自己 ledger.updatedAt 往前推，不用今天 —— 看板是静态产物，
  // 可能几天后才打开；按今天算会把真正该报的东西整段漏掉。
  var expEl = $("exporter");
  var expMode = "weekly";
  var expMerged = "merged";
  var expLoaded = false;
  var expBoards = [];
  var expBusy = false;

  function expUrl(name) {
    var env = harnessEnv();
    if (env && env.id) return "/ops-board/b/" + env.id + "/api/report/" + name;
    return "/api/report/" + name;
  }

  function openExport() {
    if (!expEl) return;
    expEl.classList.add("is-open");
    if (!expLoaded) loadExportBoards();
    paintExport();
  }
  function closeExport() {
    if (expEl) expEl.classList.remove("is-open");
  }

  // 看板清单：注册表里有哪些板、各自最后更新、多少条。
  function loadExportBoards() {
    var box = $("exp-boards");
    fetch(expUrl("boards"))
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok || !j.boards || !j.boards.length) {
          if (box) box.innerHTML = '<p class="settings-note">没读到看板列表。可以先只导当前这块。</p>';
          expBoards = [{ id: (harnessEnv() && harnessEnv().id) || '', label: D.project, current: true }];
          expLoaded = true;
          paintExport();
          return;
        }
        expBoards = j.boards;
        expLoaded = true;
        paintExportBoards();
        paintExport();
      })
      .catch(function () {
        // 服务里没这个路由（比如用老版本 serve.mjs 托管）时，至少能导自己。
        expBoards = [{ id: (harnessEnv() && harnessEnv().id) || '', label: D.project, current: true }];
        expLoaded = true;
        if (box) paintExportBoards();
        paintExport();
      });
  }

  function paintExportBoards() {
    var box = $("exp-boards");
    if (!box) return;
    box.innerHTML = expBoards
      .map(function (b) {
        var on = b.current ? " checked" : "";
        var meta = [];
        if (b.updatedAt) meta.push("更新 " + String(b.updatedAt).slice(0, 10));
        if (b.items) meta.push(b.items + " 条");
        return (
          '<label class="exp-board"><input type="checkbox" data-id="' +
          escAttr(b.id) +
          '"' +
          on +
          ' /><span class="t">' +
          escHtml(b.label || b.id) +
          (b.current ? '<span class="cur">当前</span>' : "") +
          (meta.length ? "<i>" + escHtml(meta.join(" · ")) + "</i>" : "") +
          "</span></label>"
        );
      })
      .join("");
  }

  function escHtml(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
  }

  function expPicked() {
    var box = $("exp-boards");
    if (!box) return [];
    var out = [];
    Array.prototype.forEach.call(box.querySelectorAll("input[data-id]"), function (i) {
      if (i.checked) out.push(i.getAttribute("data-id"));
    });
    return out;
  }

  function expFormats() {
    var out = [];
    if ($("exp-f-md") && $("exp-f-md").checked) out.push("md");
    if ($("exp-f-html") && $("exp-f-html").checked) out.push("html");
    if ($("exp-f-txt") && $("exp-f-txt").checked) out.push("txt");
    return out;
  }

  // 分段按钮的高亮 + 生成按钮的可点状态。
  function paintExport() {
    if (!expEl) return;
    var modeSeg = $("exp-mode");
    if (modeSeg) {
      Array.prototype.forEach.call(modeSeg.querySelectorAll("button[data-value]"), function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-value") === expMode);
      });
    }
    var mergeSeg = $("exp-merge");
    if (mergeSeg) {
      Array.prototype.forEach.call(mergeSeg.querySelectorAll("button[data-value]"), function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-value") === expMerged);
      });
    }
    var go = $("exp-go");
    if (go && !expBusy) {
      go.disabled = !expPicked().length || !expFormats().length;
    }
  }

  function expSay(msg, kind) {
    var el = $("exp-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "exp-status" + (kind ? " " + kind : "");
  }

  function fmtKB(n) {
    return (n / 1024).toFixed(1) + " KB";
  }

  function doExport() {
    if (expBusy) return;
    var boards = expPicked();
    var formats = expFormats();
    if (!boards.length) {
      expSay("先勾一块看板", "err");
      return;
    }
    if (!formats.length) {
      expSay("先勾一种格式", "err");
      return;
    }

    expBusy = true;
    var go = $("exp-go");
    if (go) {
      go.disabled = true;
      go.textContent = "生成中…";
    }
    expSay("正在生成…");
    var res = $("exp-result");
    if (res) res.innerHTML = "";

    var payload = {
      mode: expMode,
      boards: boards,
      formats: formats,
      split: expMerged === "split",
    };
    var outDir = $("exp-out") ? $("exp-out").value.trim() : "";
    if (outDir) payload.out = outDir;

    fetch(expUrl("export"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        expBusy = false;
        if (go) {
          go.disabled = false;
          go.textContent = "生成报表";
        }
        if (!j || !j.ok) {
          expSay("生成失败：" + ((j && j.error) || "未知错误"), "err");
          return;
        }
        paintExport();
        showExportResult(j.result);
      })
      .catch(function (e) {
        expBusy = false;
        if (go) {
          go.disabled = false;
          go.textContent = "生成报表";
        }
        expSay("生成失败：" + (e && e.message ? e.message : "网络或服务未响应"), "err");
      });
  }

  function showExportResult(result) {
    var box = $("exp-result");
    if (!box) return;
    if (!result || !result.files || !result.files.length) {
      expSay("生成完了，但没有返回文件路径", "err");
      return;
    }
    expSay("已生成 " + result.files.length + " 个文件", "ok");

    var label = { md: "Markdown", html: "网页", txt: "纯文本" };
    // 文件名里带模式前缀，从路径反推格式就够了，不用再传一份映射。
    function kindOf(p) {
      var m = /\.([a-z]+)$/.exec(String(p).toLowerCase());
      return (m && label[m[1]]) || "文件";
    }

    var files = result.files
      .map(function (f) {
        return (
          '<div class="exp-file"><span class="k">' +
          kindOf(f) +
          '</span><span class="p">' +
          escHtml(f) +
          "</span></div>"
        );
      })
      .join("");

    var sum = [];
    sum.push("未收口 <b>" + result.open + "</b>");
    if (result.moved) sum.push("本期记录 <b>" + result.moved + "</b>");
    if (result.closed) sum.push("本期收口 <b>" + result.closed + "</b>");
    if (result.stale) sum.push("压太久 <b>" + result.stale + "</b>");

    box.innerHTML =
      '<div class="exp-sum">' +
      sum.join(" · ") +
      "<br />文件已存到磁盘，路径如下（点路径可复制）：</div>" +
      files;

    // 点路径复制：导完一般就是要发出去，能直接粘比手抄路径有用。
    Array.prototype.forEach.call(box.querySelectorAll(".exp-file .p"), function (p) {
      p.style.cursor = "pointer";
      p.title = "点击复制路径";
      p.addEventListener("click", function () {
        var t = p.textContent;
        try {
          navigator.clipboard.writeText(t).then(
            function () {
              expSay("路径已复制", "ok");
            },
            function () {
              expSay("复制失败，请手动选中", "err");
            }
          );
        } catch (e) {
          expSay("复制失败，请手动选中", "err");
        }
      });
    });
  }

  // ── 选保存位置 ────────────────────────────────────────────
  //
  // 走系统原生的「选择文件夹」对话框，由看板服务（跑在本机）弹出。
  //
  // 为什么不在网页里自己列目录：那不是"打开文件夹选择"，用户还得一层层点，
  // 也看不到磁盘真实结构。浏览器侧的 <input webkitdirectory> 同样不行 ——
  // 新版 Electron 不再暴露 File.path，webUtils 也没挂到 window 上，
  // 选完拿不到绝对路径，等于选了个寂寞。

  function pickFolder() {
    var start = $("exp-out") ? $("exp-out").value.trim() : "";
    expSay("正在打开文件夹选择窗口…");

    fetch(expUrl2("fs/pick"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: start }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok) {
          expSay((j && j.error) || "打不开文件夹选择窗口", "err");
          return;
        }
        if (j.canceled) {
          expSay("已取消");
          return;
        }
        if ($("exp-out")) $("exp-out").value = j.path;
        expSay("保存位置：" + j.path);
      })
      .catch(function (e) {
        expSay("打不开文件夹选择窗口：" + String((e && e.message) || e), "err");
      });
  }

  // ─────────────────────── 证据点开看 ───────────────────────
  //
  // 卡片下面「证据」里那些 `文件` / `提交`，原本只是纯文本：看到
  // 「cloudfunctions/dailyUpdate/index.js 的 guard()」想确认它现在还在不在，
  // 得自己开编辑器、cd 到项目、git show 那个 commit。
  //
  // 这里把它们做成点得开的：点文件 → 贴出那段代码（并定位到提到的函数）；
  // 点提交 → 贴出那次改了什么。数据由看板服务现查，页面上不存副本。
  //
  // 三个刻意的取舍：
  //   · 用右下角浮层而不是新窗口 —— 看完还要接着读卡片，跳走就回不来了。
  //   · 不缓存结果 —— 代码随时会变，缓存等于给你看旧的。
  //   · 查不到就说清楚为什么（文件没了 / commit 不在 / 目录不是 git 仓库），
  //     不要只弹一句「失败」。

  var lookEl = null;

  function lookBox() {
    if (lookEl) return lookEl;
    lookEl = document.createElement("div");
    lookEl.className = "look";
    lookEl.setAttribute("role", "dialog");
    lookEl.setAttribute("aria-modal", "false");
    lookEl.setAttribute("aria-label", "证据内容");
    lookEl.innerHTML =
      '<div class="look-head"><b class="look-title"></b>' +
      '<button class="look-x" type="button" aria-label="关闭">✕</button></div>' +
      '<div class="look-sub"></div>' +
      '<pre class="look-body"></pre>';
    document.body.appendChild(lookEl);
    lookEl.querySelector(".look-x").addEventListener("click", closeLook);
    return lookEl;
  }

  function closeLook() {
    if (lookEl) lookEl.classList.remove("on");
  }

  function lookOpen(title, sub) {
    var el = lookBox();
    el.querySelector(".look-title").textContent = title;
    el.querySelector(".look-sub").textContent = sub || "";
    el.querySelector(".look-body").textContent = "读取中…";
    el.classList.add("on");
    return el;
  }

  function lookFail(title, why) {
    var el = lookBox();
    el.querySelector(".look-title").textContent = title;
    el.querySelector(".look-sub").textContent = "";
    el.querySelector(".look-body").textContent = "✗ " + why;
    el.classList.add("on");
  }

  function getJson(url, done) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
      done(j, xhr.status);
    };
    xhr.send();
  }

  function showFile(btn) {
    var p = btn.getAttribute("data-path") || "";
    var hint = btn.getAttribute("data-hint") || "";
    if (!p) return;
    btn.setAttribute("aria-busy", "1");
    var url = expUrl2("evidence/file") + "?path=" + encodeURIComponent(p) + "&hint=" + encodeURIComponent(hint);
    getJson(url, function (j) {
      btn.removeAttribute("aria-busy");
      if (!j) return lookFail(p, "看板服务没应答");
      if (!j.ok) return lookFail(p, j.error || "读不到");
      var sub;
      if (j.line) {
        sub = "第 " + j.line + " 行（" + (j.symbol || "?") + "）· 共 " + j.total + " 行 · 显示 " + j.from + "–" + j.to;
      } else {
        sub = "共 " + j.total + " 行 · 显示 " + j.from + "–" + j.to + (j.symbol ? " · 没找到 " + j.symbol : "");
      }
      var el = lookOpen(j.path, sub);
      el.querySelector(".look-body").textContent = j.text;
    });
  }

  function showCommit(btn) {
    var h = btn.getAttribute("data-hash") || "";
    if (!h) return;
    btn.setAttribute("aria-busy", "1");
    getJson(expUrl2("evidence/commit") + "?hash=" + encodeURIComponent(h), function (j) {
      btn.removeAttribute("aria-busy");
      if (!j) return lookFail(h, "看板服务没应答");
      if (!j.ok) return lookFail(h, j.error || "查不到");
      var when = j.at ? j.at.slice(0, 16).replace("T", " ") : "";
      var stat = j.files.length + " 个文件 · +" + j.insertions + " −" + j.deletions;
      var sub = (when ? when + " · " : "") + stat + (j.note ? " · " + j.note : "");
      var el = lookOpen(j.hash + " " + j.subject, sub);
      // 先给文件清单，再给 diff：清单一眼看清动了哪儿，diff 再细看。
      var head = j.files.map(function (f) {
        return "  " + String(f.add == null ? "?" : "+" + f.add).padStart(6) +
          " " + String(f.del == null ? "?" : "−" + f.del).padStart(6) + "  " + f.path;
      }).join("\n");
      el.querySelector(".look-body").textContent = head + "\n\n" + j.diff;
    });
  }

  function initLook() {
    // 委托到 document：卡片会被整块重建（切视图、搜索），
    // 逐个按钮绑事件会随重建不断泄漏。
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-look]");
      if (!btn) return;
      e.preventDefault();
      var kind = btn.getAttribute("data-look");
      if (kind === "file") showFile(btn);
      else if (kind === "commit") showCommit(btn);
    });
    // 点浮层外面 / 按 Esc 关掉。
    document.addEventListener("click", function (e) {
      if (!lookEl || !lookEl.classList.contains("on")) return;
      if (lookEl.contains(e.target)) return;
      if (e.target.closest("[data-look]")) return; // 换一条接着看
      closeLook();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeLook();
    });
  }

  // 接口路径：看板在 8790 上是 /api/xxx；被插件代理时前面要带 /ops-board/b/<id>。
  function expUrl2(name) {
    var env = harnessEnv();
    if (env && env.id) return "/ops-board/b/" + env.id + "/api/" + name;
    return "/api/" + name;
  }

  function initPicker() {
    var openBtn = $("exp-pick");
    if (openBtn) {
      openBtn.addEventListener("click", function (e) {
        e.preventDefault();
        pickFolder();
      });
    }
    var resetBtn = $("exp-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if ($("exp-out")) $("exp-out").value = "";
        expSay("已改回默认位置（看板目录下的 reports\\）");
      });
    }
  }

  function initExport() {
    if (!expEl) return;
    var openBtn = $("export-open");
    if (openBtn) {
      openBtn.addEventListener("click", function (e) {
        e.preventDefault();
        openExport();
      });
    }
    var closeBtn = $("export-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        closeExport();
      });
    }
    // 点遮罩空白处关掉，点面板内部不关。
    expEl.addEventListener("click", function (e) {
      if (e.target === expEl) closeExport();
    });

    var modeSeg = $("exp-mode");
    if (modeSeg) {
      modeSeg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-value]");
        if (!b) return;
        expMode = b.getAttribute("data-value");
        paintExport();
      });
    }

    var mergeSeg = $("exp-merge");
    if (mergeSeg) {
      mergeSeg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-value]");
        if (!b) return;
        expMerged = b.getAttribute("data-value");
        paintExport();
      });
    }

    var box = $("exp-boards");
    if (box) {
      box.addEventListener("change", function () {
        paintExport();
      });
    }

    ["exp-f-md", "exp-f-html", "exp-f-txt"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("change", function () {
        paintExport();
      });
    });

    var go = $("exp-go");
    if (go) {
      go.addEventListener("click", function (e) {
        e.preventDefault();
        doExport();
      });
    }

    initPicker();
  }

  // 只当对话框（?chat=1）：这个 iframe 除了对话框什么都不需要。
  // 页面骨架的脚本一概不跑 —— 搜索/设置浮层、hash 路由、浮窗几何、
  // 「上次开着就自动打开」全部跳过。跑起来只会有两种后果：
  //   · 浮窗几何跟外面那层 Harness 窗口抢同一块面板（拖动时一格一格地跳）；
  //   · savePanelState / saveWin 往 localStorage 写主看板正在用的键，
  //     把主看板的作用域和位置覆盖掉，关掉窗口回去就串台了。
  if (CHAT_ONLY) {
    initSplit();
    // 独立窗：和插件不同源，问/答全靠看板服务的中转。订阅要尽早挂上，
    // 免得第一个回答回来时还没连好。
    if (!inFrame()) startRelay();
    // 接着聊同一条：scope 是看板点「弹窗」时带过来的作用域键。
    // 认不出（空、或者那条台账已经不在了）就退回整本台账 —— 宁可开成
    // 整本台账，也不要开一个指向不存在条目的空壳。
    if (CHAT_SCOPE === "__risks__") {
      openRiskPanel(true);
    } else if (CHAT_SCOPE === "__feature__") {
      openFeaturePanel(true);
    } else if (CHAT_SCOPE === "__skills__") {
      openSkillPanel(null, true);
    } else if (CHAT_SCOPE.indexOf("skill:") === 0) {
      openSkillPanel(CHAT_SCOPE.slice(6), true);
    } else if (CHAT_SCOPE && CHAT_SCOPE !== "__global__" && D.items && D.items[CHAT_SCOPE]) {
      openPanel(CHAT_SCOPE, true);
    } else {
      openPanel("", true);
    }
    return;
  }

  initFinder();
  initSettings();
  initExport();
  initFloat();
  initLook();

  // 「弹窗」要用的 http 源，进页面就先问一声。放着不点也没代价 ——
  // 一次同源的 /ops-board/state，顺手还能发现 Harness 在不在线。
  fetchHttpOrigin(function () {});

  // 首次进页面：如果 URL 本来就带 hash（从浏览器直接打开某个锚点、或外部链接），
  // 先把它记下来，免得下次重建时恢复成更早的旧落点。
  saveRoute(location.hash);
  route();

  // 最后一步：把上次开着面板的状态摆回来。
  // 放在 route() 之后，是因为恢复要按作用域判断「这条台账还在不在」，
  // 那依赖 D.items 已经就位。
  restorePanelState();
})();
