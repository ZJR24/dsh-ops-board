// scripts/lib/css.mjs — 全部样式。
// 视觉照报纸体例复刻：纸纹底 + 内框、双线报头、居中导航、
// 标题前四像素红竖条、边框式 chip、四像素左边框卡片。
// 三套配色：night（默认）/ eye（护眼豆绿）/ paper（报纸米色）。

export function buildCss() {
  return `
:root{
  --paper:#2b2b2b;--paper2:#323232;--ink:#a9b7c6;--head:#cfd9e3;--muted:#8b9199;--rule:#3c3f41;--rule2:#52585b;
  --red:#d9695f;--red2:#f09b93;--blue:#6897bb;--green:#7fa96b;--amber:#cc7832;
  --indigo:#9aa7d6;--deploy:#c0ac86;--red-fill:#8f3a33;
  --page:#1e1f22;--body-text:#9aa7b5;--frame:#4a4f52;--glow:rgba(255,255,255,.025);
  --surface:#333638;--surface-soft:#303335;--surface-hover:#3c4143;--surface-strong:#454b4e;
  --th-bg:#3c3f41;--th-ink:#a9b7c6;--selection:#214283;
  color-scheme:dark;
  --sans:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif;
  --serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC","SimSun",serif;
  --mono:"JetBrains Mono","Cascadia Mono",Consolas,monospace;
}
:root[data-theme="paper"]{
  --paper:#f3edde;--paper2:#e9dfc9;--ink:#1e1c17;--head:#1e1c17;--muted:#6d6455;--rule:#c7bba5;--rule2:#8f826c;
  --red:#a3261f;--red2:#7d1712;--blue:#264b59;--green:#2f6142;--amber:#8a5a13;
  --indigo:#4f5b8a;--deploy:#5c5240;--red-fill:#a3261f;
  --page:#cfc5b2;--body-text:#3a352b;--frame:rgba(30,28,23,.2);--glow:rgba(255,255,255,.55);
  --surface:rgba(255,255,255,.34);--surface-soft:rgba(255,255,255,.18);
  --surface-hover:rgba(255,255,255,.6);--surface-strong:rgba(255,255,255,.9);
  --th-bg:#1e1c17;--th-ink:#f4eddf;--selection:rgba(163,38,31,.18);
  color-scheme:light;
}
:root[data-theme="eye"]{
  --paper:#d3e0c4;--paper2:#c8d7b7;--ink:#2f3829;--head:#262e21;--muted:#5f6953;--rule:#b0be9d;--rule2:#7d8a6a;
  --red:#8b3a2c;--red2:#6b2317;--blue:#2f5157;--green:#375a3f;--amber:#6f4c14;
  --indigo:#4a5480;--deploy:#565040;--red-fill:#8b3a2c;
  --page:#a5b492;--body-text:#3d4735;--frame:rgba(47,56,41,.16);--glow:rgba(255,255,255,.3);
  --surface:rgba(255,255,255,.3);--surface-soft:rgba(255,255,255,.16);
  --surface-hover:rgba(255,255,255,.45);--surface-strong:rgba(255,255,255,.68);
  --th-bg:#2f3829;--th-ink:#e3ecd6;--selection:rgba(47,81,87,.2);
  color-scheme:light;
}
*{box-sizing:border-box}
h1,h2,h3{color:var(--head)}
html,body{margin:0;padding:0;background:var(--page);color:var(--ink)}
html{scroll-padding-top:56px;scrollbar-gutter:stable;scroll-behavior:smooth}
body{font-family:var(--serif);font-size:16px;line-height:1.8;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;text-size-adjust:100%}
::selection{background:var(--selection)}
a{color:inherit;text-decoration:none}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.page{width:min(1180px,calc(100% - 28px));margin:28px auto;background:
  repeating-linear-gradient(0deg,rgba(110,90,55,.018) 0,rgba(110,90,55,.018) 1px,transparent 1px,transparent 4px),
  radial-gradient(circle at 18% 8%,var(--glow),transparent 45%),var(--paper);
  box-shadow:0 18px 55px rgba(30,20,5,.28);padding:24px 42px 30px;position:relative}
.page::before{content:"";position:absolute;inset:10px;border:1px solid var(--frame);pointer-events:none}

/* ── 顶栏 ── */
.topbar{display:flex;justify-content:space-between;gap:16px;align-items:center;border-bottom:1px solid var(--rule2);padding:2px 2px 7px;font-family:var(--sans);font-size:10.5px;letter-spacing:.06em;color:var(--muted)}
.topbar-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.theme-picker{display:inline-flex;align-items:center;gap:4px}
.theme-swatch{appearance:none;display:inline-flex;align-items:center;gap:4px;margin:0;padding:1px 6px 1px 3px;border:1px solid var(--rule2);border-radius:3px;background:var(--surface);color:var(--muted);font:inherit;font-size:9.5px;letter-spacing:.04em;line-height:1.5;cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.theme-swatch i{display:block;width:11px;height:11px;border-radius:2px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.28)}
.theme-swatch[data-theme="paper"] i{background:linear-gradient(135deg,#f3edde 50%,#1e1c17 50%)}
.theme-swatch[data-theme="night"] i{background:linear-gradient(135deg,#2b2b2b 50%,#a9b7c6 50%)}
.theme-swatch[data-theme="eye"] i{background:linear-gradient(135deg,#d3e0c4 50%,#375a3f 50%)}
.theme-swatch:hover{color:var(--ink);border-color:var(--ink)}
.theme-swatch.is-active{color:var(--ink);border-color:var(--ink);background:var(--surface-strong);font-weight:700}

/* ── 侧栏收起按钮 ──
   竖排一条，贴在侧栏
   右边缘、垂直居中；收起后原地变成「展开」，侧栏留 50px 窄条，按钮还在这条上。
   right:0 / top:50% / 28×104 / 竖排 / 左圆角，逐项跟原版对齐 —— 别自己挪。 */
.rail-toggle{position:absolute;top:50%;right:0;width:28px;min-height:104px;padding:12px 6px 26px;border:1px solid var(--rule2);border-right:0;border-radius:5px 0 0 5px;background:linear-gradient(90deg,var(--surface-soft),var(--surface-strong));color:var(--muted);font-family:var(--sans);font-size:9.5px;letter-spacing:.24em;line-height:1;cursor:pointer;writing-mode:vertical-rl;user-select:none;box-shadow:-3px 3px 10px rgba(30,20,5,.12);transform:translateY(-50%);transition:color .15s,background .15s,box-shadow .15s}
.rail-toggle::before{content:"收起"}
/* 底部小箭头：收起时指右，展开时指左 */
.rail-toggle::after{content:"";position:absolute;left:50%;bottom:11px;width:6px;height:6px;border-top:1px solid currentColor;border-left:1px solid currentColor;transform:translateX(-50%) rotate(-45deg)}
.rail-toggle:hover{color:var(--ink);border-color:var(--ink);background:var(--surface-strong);box-shadow:-4px 4px 14px rgba(30,20,5,.18)}
.rail-toggle:active{transform:translateY(-50%) translateX(1px)}
.rail-toggle:focus-visible{outline:1px solid var(--red);outline-offset:-3px}

/* ── 报头 ── */
.masthead{text-align:center;padding:10px 0 9px;border-bottom:4px double var(--ink);position:relative}
.masthead h1{margin:0;font-size:clamp(24px,3vw,34px);line-height:1.1;letter-spacing:.1em;font-weight:700}
.masthead .en{font-family:var(--sans);font-size:9.5px;letter-spacing:.18em;color:var(--muted);margin-top:3px}
.ears{position:absolute;top:12px;width:205px;font-family:var(--sans);font-size:10px;line-height:1.5;color:var(--muted);text-align:left}
.ears span{display:block;letter-spacing:.05em}
.ears b{display:block;color:var(--ink);font-family:var(--serif);font-size:15px;letter-spacing:.02em}
.ears em{display:block;font-style:normal;font-size:9px;letter-spacing:.01em;margin-top:1px;color:var(--muted);word-break:keep-all}
.ears.left{left:0;border-top:1px solid var(--rule2);padding-top:4px}
.ears.right{right:0;text-align:right;border-top:1px solid var(--rule2);padding-top:4px}
@media (max-width:900px){.ears{display:none}}

/* ── 导航 ── */
.nav{position:sticky;top:0;z-index:30;display:flex;gap:4px;justify-content:center;padding:8px 0 7px;border-bottom:1px solid var(--rule2);font-family:var(--sans);font-size:11px;letter-spacing:.08em;color:var(--muted);background:var(--paper);box-shadow:0 8px 14px -12px rgba(30,28,23,.6)}
.nav a{padding:4px 13px 3px;border:1px solid transparent;border-bottom:2px solid transparent;border-radius:3px 3px 0 0;transition:color .15s,background .15s,border-color .15s}
.nav a:hover{color:var(--ink);background:var(--surface)}
.nav a.active{color:var(--ink);border-bottom-color:var(--red);background:color-mix(in srgb,var(--red) 8%,transparent);font-weight:700}

/* ── 双栏布局 ── */
.layout{display:grid;grid-template-columns:minmax(270px,.85fr) minmax(0,2.25fr);gap:0;align-items:start}
@media (max-width:1000px){
  .layout{grid-template-columns:1fr}
  /* 窄屏是上下堆叠：内容在前，索引在后。否则打开先看到一屏索引，正文要滚很久 */
  .views{order:1}
  .rail{order:2}
}
/* 侧栏收起：留 50px 窄条给按钮，正文接上。跟原版一致 —— 不是把整栏拿掉，
   否则按钮跟着没了，就没法再展开。 */
.page.rail-collapsed .layout{grid-template-columns:50px minmax(0,1fr)}
.page.rail-collapsed .rail-body{display:none}
.page.rail-collapsed .rail{padding:24px 0 26px 0;min-height:calc(100vh - 160px)}
.page.rail-collapsed .rail-toggle::before{content:"展开"}
.page.rail-collapsed .rail-toggle::after{transform:translateX(-50%) rotate(135deg)}
.views{min-width:0;padding:0 0 0 28px;border-left:1px solid var(--rule)}
@media (max-width:1000px){.views{padding-left:0;border-left:0;border-top:1px solid var(--rule)}}
/* 窄屏是上下堆叠，没有「收起」这回事：索引永远排在正文后面，按钮一并藏掉，
   否则会把上次在宽屏收起来的状态带过来，变成「索引凭空消失」 */
@media (max-width:1000px){
  .rail-toggle{display:none}
  .page.rail-collapsed .layout{grid-template-columns:1fr}
  .page.rail-collapsed .rail-body{display:block}
  .page.rail-collapsed .rail{min-height:0;padding:18px 0 8px}
}
.view{display:none}
.view.is-active{display:block}
.main-col{min-width:0}
.history{padding:20px 0 6px}

/* 跳过去的落点要看得见：跨视图跳转后闪一下，否则用户不知道该看哪 */
@keyframes land-flash{0%{background:color-mix(in srgb,var(--red) 18%,transparent)}100%{background:transparent}}
.card.is-landed{animation:land-flash 1.1s ease-out 1}

/* ── 侧栏 ── */
.rail{padding:24px 40px 26px 0;align-self:start;position:sticky;top:56px}
/* 侧栏可视高度尽量吃满：减掉的只有顶栏 + 导航 + 一点留白。
   原来减 170px，等于把 sticky 顶 56px 之外又白扔一截，一屏能看的块就少。 */
.rail-body{height:calc(100vh - 96px);max-height:calc(100vh - 96px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--rule2) transparent;scrollbar-gutter:stable;padding-right:6px;overscroll-behavior:contain}
.rail-body::-webkit-scrollbar{width:8px}
.rail-body::-webkit-scrollbar-thumb{background:var(--rule);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.rail-body:hover::-webkit-scrollbar-thumb{background:var(--rule2);background-clip:padding-box}
.rail-body .panel{display:contents}
.rail-body .panel>h3{position:sticky;top:0;z-index:5;display:flex;align-items:flex-start;justify-content:flex-start;gap:6px;min-height:22px;margin:0 0 8px;padding:3px 0 4px;background:var(--paper);box-shadow:0 8px 0 var(--paper);font-family:var(--sans);font-size:11px;letter-spacing:.12em;color:var(--muted);font-weight:700;border-bottom:1px solid var(--rule)}
.panel .rail-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 标题 + 计数一个整体：让它自己换行，别把标题挤成竖排一个字（原版的 .rail-head-jump） */
.rail-head-jump{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:1px 6px}
.rail-head-jump .rail-counts{flex:0 1 auto}
/* 每节标题左侧的折叠箭头：原版的 .rail-fold */
.rail-fold{appearance:none;-webkit-appearance:none;flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin:0 0 0 -2px;padding:0;border:0;background:none;color:var(--muted);cursor:pointer}
.rail-fold::before{content:"";width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg) translate(-1px,-1px);transition:transform .15s}
.rail-fold:hover{color:var(--ink)}
.rail-fold:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.panel.is-collapsed .rail-fold::before{transform:rotate(-45deg) translate(-1px,1px)}
.panel.is-collapsed .panel-body{display:none}
/* 阶段格子当筛选器：点一格只留这一阶段，格子自身点亮，下面给一行提示 */
.stage-board-cell.is-stage-filter{background:var(--surface-strong)}
.stage-board-cell.is-stage-filter .stage-label{color:var(--red2)}
.stage-filter-hint{grid-column:1/-1;margin:0;font-family:var(--sans);font-size:9.5px;color:var(--muted);line-height:1.6}
.details-main.is-stage-filtered>*:not(.stage-board):not(.is-stage-keep){display:none}
.stage-table>a.is-stage-filter{background:var(--surface-strong)}
.stage-table>a.is-stage-filter .stage-label{color:var(--ink)}
.rail-mini-toggle{appearance:none;-webkit-appearance:none;flex:none;margin:8px 0 0;padding:0;border:0;background:none;font-family:var(--sans);font-size:9.5px;color:var(--muted);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.rail-mini-toggle:hover{color:var(--ink)}
.rail-mini-toggle:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.rail-mini-head .rail-mini-toggle{margin:8px 0 0}
[hidden]{display:none!important}
.rail-title-link{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:4px;min-width:0}
.rail-title-link:hover{color:var(--ink)}
.rail-title-link:hover .rail-title{text-decoration:underline;text-underline-offset:2px}
.rail-title-link::after{content:"→";font-size:9px;opacity:0;transition:opacity .15s;color:var(--red)}
.rail-title-link:hover::after{opacity:1}
.rail-counts{font-family:var(--sans);font-size:9px;font-weight:400;letter-spacing:.01em;line-height:1.5;color:var(--muted);white-space:nowrap;display:block}
.rail-counts b{font-weight:700}
/* 计数串放不下时按 | 折行，而不是把整串压成一条 */
.rail-head-jump .rail-counts{white-space:normal}
.rail-title-link{color:inherit;text-decoration:none}
.rail-title-link:hover{text-decoration:underline;text-underline-offset:2px}
.panel{border-top:1px solid var(--rule2);padding:12px 0 14px;margin:0 0 4px}
.rail-body .panel-body{padding:0 0 12px}
.stage-total{display:flex;align-items:baseline;gap:6px;margin:0 0 6px;line-height:1}
.stage-total-num{font-family:var(--serif);font-size:31px;font-weight:700;letter-spacing:-.02em;color:var(--red)}
.stage-total-label{font-family:var(--sans);font-size:9.5px;letter-spacing:.04em;color:var(--muted)}
.stage-table{display:grid;margin:0 0 8px;border:1px solid var(--rule2);background:var(--surface)}
.stage-table>a{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 2px;border-left:1px solid var(--rule2);text-align:center;color:inherit;cursor:pointer;transition:background .15s}
.stage-table>a:first-child{border-left:0}
.stage-table>a:hover{background:var(--surface-hover)}
.stage-table>a:hover .stage-label{color:var(--ink)}
.stage-num{font-family:var(--serif);font-size:17px;font-weight:700;line-height:1.15;color:var(--red)}
.stage-label{font-family:var(--sans);font-size:8.5px;letter-spacing:.04em;color:var(--muted)}
.rail-note{font-family:var(--sans);font-size:9.5px;color:var(--muted);line-height:1.6;margin:8px 0 0}
.rail-mini-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.rail-mini-head .rail-note{flex:1}
.mini-list{list-style:none;margin:7px 0 0;padding:0}
.mini-list li{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11.5px;line-height:1.5;padding:4px 0;border-bottom:1px dotted var(--rule)}
.mini-list li a{flex:1}
.mini-list li a:hover{color:var(--red2)}
.metrics{list-style:none;margin:0;padding:0}
.metric{display:grid;grid-template-columns:1fr auto;gap:0 8px;padding:6px 0;border-bottom:1px dotted var(--rule);font-size:12px}
.metric-label{color:var(--muted)}
.metric-value{font-weight:700;text-align:right}
.metric-note{grid-column:1/-1;font-family:var(--sans);font-size:9.5px;color:var(--muted);line-height:1.5;margin-top:1px}
.metric-ok .metric-value{color:var(--green)}
.metric-warn .metric-value{color:var(--amber)}
.metric-danger .metric-value{color:var(--red)}
.metric-muted .metric-value{color:var(--muted)}
.snapshot{list-style:none;margin:0;padding:0}
.snapshot li{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dotted var(--rule);padding:5px 0;font-size:11.5px}
.snapshot li span:first-child{color:var(--muted)}
.snapshot b{margin:0;text-align:right;overflow-wrap:anywhere;font-weight:400;font-family:var(--sans);font-size:10.5px}

/* ── 正文通用 ── */
.lead{padding:22px 0 24px}
.kicker{font-family:var(--sans);font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--red);display:flex;align-items:center;gap:10px;margin-bottom:8px}
.kicker::after{content:"";height:1px;background:var(--rule);flex:1}
.lead h1{font-size:clamp(22px,2.2vw,28px);line-height:1.3;letter-spacing:-.01em;margin:0 0 10px;font-weight:800}
.deck{font-size:clamp(14.5px,1.45vw,17px);line-height:1.68;color:var(--body-text);margin:0 0 12px;font-weight:600}
.lead-copy{columns:2;column-gap:28px;column-rule:1px solid var(--rule);text-align:justify}
@media (max-width:820px){.lead-copy{columns:1}}
.lead-copy p{margin:0 0 1em;font-size:13.8px;line-height:1.95}
.conclusion{border-left:3px solid var(--red);background:color-mix(in srgb,var(--red) 8%,transparent);padding:10px 12px;font-size:12.8px;line-height:1.75;margin-top:10px}
.highlights{margin:2px 0 12px;border-top:1px solid var(--rule);padding-top:8px}
.highlight-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:0 24px}
@media (max-width:820px){.highlight-list{grid-template-columns:1fr}}
.highlight-list li{display:flex;align-items:flex-start;gap:7px;padding:5px 0;border-bottom:1px dotted var(--rule);font-size:12.8px;line-height:1.7}
.highlight-list .kind-chip{flex:none;margin-top:4px}
.subhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;border-bottom:1px solid var(--rule);padding-bottom:3px;margin-bottom:5px}
.subhead h3{font-family:var(--sans);font-size:11px;letter-spacing:.1em;color:var(--muted);margin:0;font-weight:700}
.subhead span{font-family:var(--sans);font-size:9px;color:var(--muted)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;border-bottom:2px solid var(--ink);padding-bottom:5px;margin:0 0 10px}
.section-head h2{font-size:22px;line-height:1.3;margin:0;position:relative;padding-left:12px}
.section-head h2::before{content:"";position:absolute;left:0;top:.28em;width:4px;height:.95em;background:var(--red)}
.section-head span{font-family:var(--sans);font-size:10px;color:var(--muted);display:inline-flex;align-items:center;gap:9px}
.head-ask{font-size:9.5px;padding:1px 8px}
.details-main{padding:22px 0 24px}
.details-title{font-size:clamp(30px,3.5vw,42px);line-height:1.22;letter-spacing:-.01em;margin:0 0 8px}
.detail-group{padding:18px 0 4px}
.stage-tail{border-top:1px dotted var(--rule2);border-bottom:1px solid var(--rule);padding:9px 0;margin:6px 0 2px;font-size:12px;color:var(--muted)}
.stage-tail b{color:var(--ink)}
.stage-tail a{border-bottom:1px dotted var(--rule2);color:var(--ink)}
.stage-tail a:hover{color:var(--red2)}

/* 阶段板（正文顶部的大红数 + 格表） */
.stage-board{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px 24px;align-items:center;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);padding:12px 0;margin:12px 0 6px}
.stage-board-total{display:flex;flex-direction:column;align-items:center;gap:1px;padding-right:22px;border-right:1px solid var(--rule)}
.stage-board-num{font-family:var(--serif);font-size:46px;font-weight:700;line-height:1;letter-spacing:-.02em;color:var(--red)}
.stage-board-label{font-family:var(--sans);font-size:10px;letter-spacing:.1em;color:var(--muted);white-space:nowrap}
.stage-board-table{display:grid;border:1px solid var(--rule2);background:var(--surface)}
.stage-board-cell{display:flex;flex-direction:column;align-items:center;gap:1px;padding:8px 6px;border-left:1px solid var(--rule2);color:inherit;text-align:center;transition:background .15s;cursor:pointer}
.stage-board-cell:first-child{border-left:0}
.stage-board-cell:hover{background:var(--surface-hover)}
.stage-board-cell b{font-family:var(--serif);font-size:23px;line-height:1.1;color:var(--red)}
.stage-board-cell span{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.04em}
.stage-board-cell small{font-family:var(--sans);font-size:9px;color:var(--muted);line-height:1.45}

/* 表格 */
.table-wrap{width:100%;overflow-x:auto;border:1px solid var(--rule2);box-shadow:0 2px 10px rgba(30,20,5,.05);margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:12.2px;line-height:1.55;background:var(--surface-soft)}
thead th{font-family:var(--sans);font-size:10px;text-align:left;color:var(--th-ink);background:var(--th-bg);padding:6px 8px;font-weight:600;white-space:nowrap}
tbody td{padding:7px 8px;border-top:1px solid var(--rule);vertical-align:top}
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--surface)}
.id-cell{font-family:var(--sans);font-size:10.5px;color:var(--muted);white-space:nowrap}
.title-cell a{border-bottom:1px solid transparent}
.title-cell a:hover{border-bottom-color:var(--red);color:var(--red2)}
.muted{color:var(--muted);font-family:var(--sans);font-size:10px;white-space:nowrap}

/* chip：边框 + 淡底（照原版），严重度用实心 */
.chip{display:inline-block;font-family:var(--sans);font-size:9.5px;line-height:1.5;padding:0 6px;border:1px solid var(--rule2);border-radius:3px;white-space:nowrap;vertical-align:1px;letter-spacing:.02em}
.chip.t-danger{color:var(--red2);border-color:color-mix(in srgb,var(--red2) 45%,transparent);background:color-mix(in srgb,var(--red2) 11%,transparent)}
.chip.t-warn{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 50%,transparent);background:color-mix(in srgb,var(--amber) 13%,transparent)}
.chip.t-info{color:var(--blue);border-color:color-mix(in srgb,var(--blue) 45%,transparent);background:color-mix(in srgb,var(--blue) 11%,transparent)}
.chip.t-ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:color-mix(in srgb,var(--green) 11%,transparent)}
.chip.t-muted{color:var(--muted);border-color:var(--rule2);background:color-mix(in srgb,var(--rule2) 10%,transparent)}
.chip.t-indigo{color:var(--indigo);border-color:color-mix(in srgb,var(--indigo) 45%,transparent);background:color-mix(in srgb,var(--indigo) 12%,transparent)}
.chip.chip-solid{color:#fff;border-color:transparent}
.chip.chip-solid.t-danger{background:var(--red-fill);border-color:var(--red-fill);color:#fff}
.chip.chip-solid.t-warn{background:var(--amber);border-color:var(--amber);color:#fff}
.chip.chip-solid.t-ok{background:var(--green);border-color:var(--green);color:#fff}
.chip.chip-solid.t-info{background:var(--blue);border-color:var(--blue);color:#fff}
.chip.chip-solid.t-muted{background:var(--rule2);border-color:var(--rule2);color:var(--th-ink)}
:root[data-theme="paper"] .chip.chip-solid.t-warn{color:#fffdf7}
.kind-chip{display:inline-block;font-family:var(--sans);font-size:9px;line-height:1.5;padding:0 5px;border:1px solid var(--rule2);border-radius:3px;white-space:nowrap;letter-spacing:.02em;vertical-align:1px}
/* 记录类型配色：跟原版 HISTORY_KINDS 一一对应（发现 / 修复 / 功能 / 运维 / 部署） */
.kind-chip.t-danger{color:var(--red2);border-color:color-mix(in srgb,var(--red2) 45%,transparent)}
.kind-chip.t-ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent)}
.kind-chip.t-info{color:var(--blue);border-color:color-mix(in srgb,var(--blue) 45%,transparent)}
.kind-chip.t-warn{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 50%,transparent)}
.kind-chip.t-indigo{color:var(--indigo);border-color:color-mix(in srgb,var(--indigo) 45%,transparent)}
.kind-chip.t-muted{color:var(--muted);border-color:var(--rule2)}

/* 卡片 */
.card{border:1px solid var(--rule2);background:var(--surface-soft);padding:14px 16px 15px;margin:0 0 14px;break-inside:avoid;box-shadow:0 2px 9px rgba(30,20,5,.05);border-left:4px solid var(--rule2);scroll-margin-top:70px;transition:box-shadow .15s}
.card:hover{box-shadow:0 3px 14px rgba(30,20,5,.09)}
.card.lv-danger{border-left-color:var(--red)}
.card.lv-warn{border-left-color:var(--amber)}
.card.lv-info{border-left-color:var(--blue)}
.card.lv-ok{border-left-color:var(--green)}
.card.lv-muted{border-left-color:var(--rule2)}
.card-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}
.card-head .id{font-family:var(--sans);font-size:10.5px;color:var(--muted);letter-spacing:.06em}
.card-head .meta{font-family:var(--sans);font-size:10px;color:var(--muted)}
.card h3{font-size:22px;line-height:1.35;margin:7px 0 10px}
.sections{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}
@media (max-width:780px){.sections{grid-template-columns:1fr}}
.sections section{padding:0 0 8px}
.sections h4{font-family:var(--sans);font-size:10px;letter-spacing:.1em;color:var(--muted);margin:0 0 3px;font-weight:700}
.sections p{margin:0;font-size:12.8px;line-height:1.85;text-align:justify}
.evidence{margin-top:6px;padding-top:8px;border-top:1px dotted var(--rule2)}
.evidence>b{font-family:var(--sans);font-size:10px;letter-spacing:.1em;color:var(--muted);font-weight:700;display:block;margin-bottom:4px}
.evidence ul{list-style:none;margin:0;padding:0}
.evidence li{display:flex;gap:7px;align-items:baseline;font-size:11.5px;line-height:1.65;padding:1px 0}
.ev-kind{flex:none;font-family:var(--sans);font-size:9px;padding:0 5px;border:1px solid var(--rule2);border-radius:3px;color:var(--muted);letter-spacing:.02em}
.ev-text{font-family:var(--mono);font-size:11px;word-break:break-word}
.card-acts{display:flex;gap:7px;justify-content:flex-end;margin-top:10px}

/* 按钮 */
.btn{appearance:none;font-family:var(--sans);font-size:10px;letter-spacing:.04em;padding:2px 9px;border-radius:3px;border:1px solid var(--rule2);background:var(--surface);color:var(--muted);cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.btn:hover{color:var(--ink);border-color:var(--ink);background:var(--surface-hover)}
.btn-ask{border-color:color-mix(in srgb,var(--red2) 40%,transparent);color:var(--red2);background:color-mix(in srgb,var(--red2) 8%,transparent)}
.btn-ask:hover{background:color-mix(in srgb,var(--red2) 20%,transparent);color:var(--ink);border-color:var(--red2)}
.btn-ok{border-color:var(--green);color:var(--green)}
.btn:disabled{opacity:.45;cursor:not-allowed}

/* 清单与时间线 */
.actions{margin:0;padding-left:18px;font-size:12.4px;line-height:1.7}
.actions li{padding:0 0 6px}
.actions a:hover{color:var(--red2)}
.timeline{list-style:none;margin:0;padding:0 0 0 20px;border-left:2px solid var(--rule2)}
.timeline li{position:relative;padding:0 0 10px 9px;font-size:12.2px;line-height:1.7}
.timeline li::before{content:"";position:absolute;left:-26px;top:7px;width:8px;height:8px;border-radius:50%;background:var(--paper);border:2px solid var(--rule2)}
.timeline li.tl-found::before{border-color:var(--red)}
.timeline li.tl-fixed::before{border-color:var(--green)}
.timeline li.tl-feature::before{border-color:var(--blue)}
.timeline li.tl-ops::before{border-color:var(--amber)}
.timeline li.tl-deploy::before{border-color:var(--deploy)}
.timeline time{display:block;font-family:var(--sans);font-size:10px;color:var(--muted);font-weight:700}
.timeline p{margin:0}
.legend-line{display:flex;flex-wrap:wrap;gap:5px 10px;align-items:center;font-family:var(--sans);font-size:9.5px;color:var(--muted);padding-top:8px}
.legend-line>span:first-child{color:var(--ink)}
/* ── Skill 统计（独立页） ── */
.skills{border-top:1px solid var(--rule2);padding-top:14px;margin-bottom:6px}
#skill-group-used,#skill-group-produced,#skill-group-related{border:1px solid var(--rule2);background:var(--surface-soft);padding:12px 14px 13px;margin:14px 0 0;scroll-margin-top:70px}
.skill-group>h2{margin:0 0 4px;font-family:var(--serif);font-size:16px;font-weight:700;color:var(--head);letter-spacing:.02em;border-bottom:1px solid var(--rule);padding-bottom:6px}
.skill-group>.rail-note{margin:6px 0 4px}
.skill-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:4px}
.skill-group>h3{margin:0 0 6px;font-family:var(--sans);font-size:10px;letter-spacing:.08em;color:var(--muted);font-weight:700;border-bottom:1px dotted var(--rule);padding-bottom:5px}
.skill-group>h3 b{color:var(--ink);font-weight:700}
.skill-list{list-style:none;margin:0;padding:0}
.skill-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;padding:5px 0;border-bottom:1px dotted var(--rule);font-size:11.5px;line-height:1.5}
.skill-row:last-child{border-bottom:0}
.skill-name{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;color:var(--ink);font-weight:700}
/* 每条 skill 的「问 AI」贴在名称那一行右端 */
.skill-row .btn-ask{margin-left:auto;flex:none;font-size:10px;padding:0 7px;line-height:1.7}
.skill-ver{font-family:var(--sans);font-size:9px;color:var(--muted)}
.skill-flag,.skill-meta{font-family:var(--sans);font-size:9px;color:var(--muted);border:1px solid var(--rule2);border-radius:3px;padding:0 4px;white-space:nowrap}
.skill-flag{color:var(--blue);border-color:color-mix(in srgb,var(--blue) 45%,transparent)}
.skill-title{flex:1 1 100%;font-size:11.5px;color:var(--ink)}
.skill-desc{flex:1 1 100%;font-family:var(--sans);font-size:9.5px;line-height:1.6;color:var(--muted)}
@media (max-width:1000px){.skill-groups{grid-template-columns:1fr}}
/* 处理记录按类型筛选：跟原版一样，未选中的淡下去，选中的描一圈边 */
.history-kinds .kind-chip{appearance:none;-webkit-appearance:none;cursor:pointer;opacity:.55;transition:opacity .15s,box-shadow .15s;-webkit-tap-highlight-color:transparent}
.history-kinds .kind-chip:hover{opacity:1}
.history-kinds .kind-chip.is-active{opacity:1;box-shadow:inset 0 0 0 1.5px currentColor}
.history-kinds .kind-chip b{font-weight:700;margin-left:2px;opacity:.8}
.timeline li.is-hidden{display:none}
.history-sub{font-family:var(--sans)}
.stage-empty{font-size:12.2px;color:var(--muted);padding:6px 0 10px;margin:0}
.issue-section{border-bottom:3px double var(--ink);padding:20px 0 22px}

/* ── AI 面板 ── */
.ai-panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);z-index:200;display:flex;flex-direction:column;background:var(--paper);border-left:1px solid var(--rule2);box-shadow:-8px 0 40px rgba(20,14,4,.3);transform:translateX(102%);transition:transform .26s cubic-bezier(.3,.8,.3,1)}
.ai-panel.is-open{transform:translateX(0)}
.ai-head{flex:none;display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:2px solid var(--ink)}
.ai-head h3{margin:0;font-family:var(--sans);font-size:11px;letter-spacing:.12em;font-weight:700;color:var(--red)}
.ai-head .ctx{flex:1;min-width:0;font-family:var(--sans);font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-head button{appearance:none;background:none;border:1px solid var(--rule2);border-radius:3px;color:var(--muted);font-family:var(--sans);font-size:9.5px;padding:1px 6px;cursor:pointer;line-height:1.6}
.ai-head button:hover{color:var(--ink);border-color:var(--ink)}

.ai-msgs{flex:1;overflow-y:auto;padding:14px 14px 6px;scrollbar-width:thin}
.ai-msgs::-webkit-scrollbar{width:8px}
.ai-msgs::-webkit-scrollbar-thumb{background:var(--rule);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.msg{margin-bottom:14px;font-size:12.8px;line-height:1.85}
.msg-role{font-family:var(--sans);font-size:9px;letter-spacing:.12em;font-weight:700;color:var(--muted);margin-bottom:3px;display:flex;align-items:center;gap:6px}
.msg-user .msg-role{color:var(--red)}
.msg-user .msg-body{background:color-mix(in srgb,var(--red) 7%,transparent);border-left:2px solid var(--red2);padding:7px 10px}
.msg-ai .msg-body{border-left:2px solid var(--rule2);padding:2px 0 2px 10px}
.msg-body{white-space:pre-wrap;word-break:break-word}
.msg-body code{font-family:var(--mono);font-size:11px;background:var(--surface-strong);padding:0 3px;border-radius:2px}
.msg-body p{margin:0 0 .7em}
.msg-body p:last-child{margin-bottom:0}
.msg-body .cursor{display:inline-block;width:6px;height:13px;background:var(--red);vertical-align:-2px;animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
.msg-err .msg-body{border-left-color:var(--red);color:var(--red2);font-family:var(--sans);font-size:11.5px}
.msg-act{margin-top:9px;white-space:normal;display:flex;gap:7px;align-items:center}
.msg-act .btn{font-size:10.5px;padding:4px 11px}
.ai-empty{padding:30px 6px;text-align:center;font-family:var(--sans);font-size:11px;color:var(--muted);line-height:1.9}
.ai-empty b{display:block;color:var(--ink);font-size:12px;margin-bottom:4px}

.ai-quick{flex:none;display:flex;flex-wrap:wrap;gap:5px;padding:0 14px 8px}
.ai-quick button{appearance:none;font-family:var(--sans);font-size:9.5px;padding:2px 8px;border:1px solid var(--rule2);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer}
.ai-quick button:hover{color:var(--red2);border-color:var(--red2);background:color-mix(in srgb,var(--red2) 8%,transparent)}

.ai-compose{flex:none;border-top:1px solid var(--rule2);padding:9px 14px 12px}
.ai-compose textarea{width:100%;min-height:62px;max-height:180px;background:var(--paper);border:1px solid var(--rule2);color:var(--ink);font-family:var(--serif);font-size:13px;line-height:1.7;padding:7px 9px;border-radius:3px;resize:vertical}
.ai-compose .send-row{display:flex;gap:7px;align-items:center;margin-top:7px}
.ai-compose .send-hint{flex:1;font-family:var(--sans);font-size:9px;color:var(--muted);line-height:1.4}
.btn-send{appearance:none;font-family:var(--sans);font-size:10.5px;letter-spacing:.06em;padding:4px 14px;border-radius:3px;border:1px solid var(--red-fill);background:var(--red-fill);color:#fff;cursor:pointer;transition:filter .15s}
.btn-send:hover{filter:brightness(1.12)}
.btn-send:disabled{opacity:.5;cursor:not-allowed}

@media print{
  :root{--page:#fff;--paper:#fff;--surface:#fff;--surface-soft:#fff;--surface-strong:#fff}
  .rail,.nav,.topbar,.card-acts,.ai-panel{display:none!important}
  .layout{grid-template-columns:1fr}
  .views{padding-left:0;border-left:0}
  .view{display:block!important;page-break-before:always}
  .view:first-of-type{page-break-before:avoid}
  .card{break-inside:avoid}
  body{font-size:11pt}
  .page{box-shadow:none;width:100%;margin:0}
}
`;
}
