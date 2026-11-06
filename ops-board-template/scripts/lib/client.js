// scripts/lib/client.js — 页面里的全部交互。由 render.mjs 原样内联进 HTML。
// 说明：这个文件不经过模板求值，所以可以放心用模板字符串。

(function () {
  "use strict";

  var D = JSON.parse(document.getElementById("board-data").textContent);
  // 由 dsh-ops-board 注入：看板 id / 目录 / 项目目录，发送时一并发过去。
  // 这块板的「问 AI」只有一条路 —— 交给 Harness 会话。
  var HARNESS = window.__OPS_HARNESS__ || null;

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

  var ITEM_VIEW = {};
  Array.prototype.forEach.call(document.querySelectorAll(".card[id]"), function (c) {
    var view = c.closest(".view");
    if (view) ITEM_VIEW[c.id] = view.dataset.view;
  });

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
      show("overview");
      return;
    }
    if (raw.indexOf("stage-") === 0) {
      var laneKey = raw.split("-").slice(1, -1).join("-");
      if (show("lane-" + laneKey)) nextFrame(function () {
        scrollToEl(raw);
      });
      return;
    }
    if (raw.indexOf("view-") === 0) {
      show(raw.slice(5), true);
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

  window.addEventListener("hashchange", route);

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

  Array.prototype.forEach.call(document.querySelectorAll(".theme-swatch"), function (b) {
    b.addEventListener("click", function () {
      var t = b.dataset.theme;
      document.documentElement.setAttribute("data-theme", t);
      localStorage.setItem("ops-board-theme", t);
      paintThemeButtons();
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
    }
  });

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
    busy: false,
    fresh: false, // 面板里点了「新会话」：下一条发送强制新建 Harness 会话
  };

  function ctxLabel() {
    if (AI.skill) return "Skill · " + AI.skill;
    if (AI.skillScope) return "整页 Skill";
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

  // 三个作用域各自拼自己的上下文，不再共用一个 else 分支。
  //
  // 之前条目和整本共用 else，而那个 else 只写了 skill 的话术：点某条台账的
  // 「问 AI」，发出去的是「范围：本页全部 Skill（共 0 个）」加一句「skill 文件是
  // SKILL.md」，那条台账的四段和证据一个字都没带上，连编号都没有。
  function harnessContext(itemId, actionText, skillName) {
    var it = itemId ? D.items[itemId] : null;
    var skills = D.skills || { used: [], produced: [], related: [] };
    var head = ["看板：" + D.project + "（" + HARNESS.dir + "）", HARNESS.projectDir ? "项目目录：" + HARNESS.projectDir : null];
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
    } else {
      // 整本台账：没有具体条目，说清是整本。
      lines = head.slice();
      lines.push("范围：整本台账，共 " + (D.totalCount || 0) + " 条，未收口 " + (D.openCount || 0) + " 条。");
      lines.push("用户没有指定某一条，回答时可以点出具体编号；需要细节就读 " + HARNESS.dir + "/ledger.json。");
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

  function harnessPost(itemId, actionText, fresh, done, skillName) {
    var it = itemId ? D.items[itemId] : null;
    var skillKey = skillName || null;
    var payload = {
      board: HARNESS.id,
      dir: HARNESS.dir,
      label: HARNESS.label,
      // skill 用独立前缀，避免和台账条目 id 撞车（条目是 OPS-030 这种）
      item: skillKey ? "skill:" + skillKey : itemId || "",
      title: skillKey ? "Skill · " + skillKey : it ? it.title : "整本台账",
      fresh: !!fresh,
      question: harnessContext(itemId, actionText, skillKey),
    };

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
          done({ ok: true });
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
                question: payload.question,
              },
              window.location.origin
            );
            target.focus();
            done({ ok: true, fallback: true });
            return;
          } catch (e) {}
        }
        done({ ok: false, error: (j && j.error) || "Harness 没接住这个问题" });
      })
      .catch(function (e) {
        done({ ok: false, error: String((e && e.message) || e) });
      });
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
  function resetChat(itemId) {
    if (itemId !== undefined) AI.ctx = itemId || null;
    // 哨兵 ctx 只用来把面板打开；重置后不能把它当条目 id 留着（D.items 里没有）
    if (AI.ctx === "__skills__") AI.ctx = null;
    msgsEl.innerHTML = "";
    paintCtx();

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
          ? "选一个动作，或直接写你要它做的事；发送后会在 Harness 里打开这个条目的会话，同一会话继续追加。"
          : "共 " + D.totalCount + " 条，" + D.openCount + " 条未收口。选一个动作或直接问；发送后会在 Harness 里打开「整本台账」会话。");
    }
    msgsEl.appendChild(empty);
    setHint("");
  }

  function openPanel(itemId) {
    // 从台账条目进来时清掉 skill 作用域；skill 入口在 openSkillPanel 里设回来
    if (itemId !== "__skills__") {
      AI.skill = null;
      AI.skillScope = false;
    }
    AI.busy = false;
    AI.fresh = false;
    sendBtn.disabled = false;
    resetChat(itemId || null);
    inputEl.value = "";
    panel.classList.add("is-open");
    panel.classList.add("is-harness");

    var newBtn = $("ai-new");
    if (newBtn) {
      newBtn.style.display = "";
      newBtn.textContent = "新会话";
      newBtn.title = "下一条发送新开一个 Harness 会话";
    }
    inputEl.placeholder = "选一个动作，或直接写你要它做的事";
    setHint("发送后在 Harness 会话里执行");
    setTimeout(function () {
      inputEl.focus();
    }, 260);
  }

  // Skill 页专用的打开入口：skillName 为空表示"整页 skill"。
  // 用哨兵 ctx（__skills__）让 openPanel 照常走初始化流程；AI.skill / AI.skillScope
  // 记录真正的作用域，resetChat 会把哨兵清掉。
  function openSkillPanel(skillName) {
    AI.skill = skillName || null;
    AI.skillScope = true;
    openPanel("__skills__");
  }

  function closePanel() {
    panel.classList.remove("is-open");
  }

  function setHint(text, warn) {
    hintEl.textContent = text || "";
    hintEl.style.color = warn ? "var(--red)" : "";
  }

  // ── 发送 ──

  function sendHarness(text) {
    if (!text) {
      setHint("先选一个动作，或写一句要问的。", true);
      return;
    }
    AI.busy = true;
    sendBtn.disabled = true;
    setHint("正在交给 Harness…");
    var fresh = AI.fresh;
    var skillKey = AI.skill || null;
    harnessPost(AI.ctx || null, text, fresh, function (result) {
      AI.busy = false;
      sendBtn.disabled = false;
      if (!result.ok) {
        setHint(result.error || "发送失败", true);
        return;
      }
      AI.fresh = false;
      inputEl.value = "";
      var empty = msgsEl.querySelector(".ai-empty");
      if (empty) empty.remove();
      addMsg("user", text);
      var what = skillKey ? "Skill「" + skillKey + "」" : "这个条目";
      addMsg("ai", fresh
        ? "已交给 Harness，正在新开一个会话；之后" + what + "的「问 AI」会继续用新会话。"
        : "已交给 Harness，正在打开" + what + "的会话；之后在同一会话里继续追加。");
      setHint(result.fallback ? "已交给 Harness 窗口。" : "已交给 Harness。");
    }, skillKey);
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
    if (!HARNESS) {
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
      document.querySelectorAll("[data-ask], [data-ask-skill], [data-ask-skills], [data-ask-global]"),
      function (b) {
        b.parentNode && b.parentNode.removeChild(b);
      }
    );
    route();
    return;
  }

  $("ai-send").addEventListener("click", send);
  $("ai-close").addEventListener("click", closePanel);
  $("ai-new").addEventListener("click", function () {
    AI.fresh = true;
    resetChat();
    inputEl.value = "";
    setHint("下一条发送会新开一个 Harness 会话；旧会话保留在侧栏。");
    inputEl.focus();
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("is-open")) closePanel();
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

  route();
})();
