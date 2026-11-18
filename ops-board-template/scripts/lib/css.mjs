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
  /* 正文字号倍率：设置页的「正文字号」改这一个值。
     用倍率而不是直接改 body 字号 —— 正文各段的字号都是显式 px，
     只改 body 等于什么都没动；而如果把编号、时间、按钮也一起乘，
     密排的索引行会被撑散。所以只让「读的东西」跟着缩放。 */
  --fs-scale:1;
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
body{font-family:var(--serif);font-size:calc(16px * var(--fs-scale));line-height:1.8;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;text-size-adjust:100%}
::selection{background:var(--selection)}
a{color:inherit;text-decoration:none}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
/* 上下对称：padding 顶/底同为 24px；margin-bottom 只留一点给阴影呼吸，
   不向底部悬空一大段（2026-11-18 用户：底部空白太大，向顶部一样收住）。 */
.page{width:min(1180px,calc(100% - 28px));margin:0 auto 12px;background:
  repeating-linear-gradient(0deg,rgba(110,90,55,.018) 0,rgba(110,90,55,.018) 1px,transparent 1px,transparent 4px),
  radial-gradient(circle at 18% 8%,var(--glow),transparent 45%),var(--paper);
  box-shadow:0 18px 55px rgba(30,20,5,.28);padding:24px 42px 24px;position:relative}
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
/* 报头两侧的统计耳朵（ears 一族）已随该块删除（2026-11-16），用户要更干净的头部。 */

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
/* 工作流页要占满整宽：它的全部价值就是「横向铺开看链条」，
   挤在 2/3 栏里 6 件的长链必被裁掉。进入这一页时侧栏让位。 */
.layout.is-wide{grid-template-columns:minmax(0,1fr)}
.layout.is-wide>.rail{display:none}
.layout.is-wide>.views{padding-left:0;border-left:0}
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
.kicker{font-family:var(--sans);font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--red);display:flex;align-items:center;gap:10px;margin-bottom:8px}
.kicker::after{content:"";height:1px;background:var(--rule);flex:1}
/* 「本轮要点」那块的样式（highlights / highlight-list / subhead 三个类）已随该块一起删除（2026-11-16）。
   注释里故意不写点号：verify-board 用「CSS 里出现过的 .类名」判断样式是否已定义，
   写成带点的样式名会把这个类重新算成「已定义」，将来真漏了样式反而查不出来。 */
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
/* 表头走报纸体例：纸色底 + 深墨字 + 上下双线。
   --paper 在三套主题下正是指定值：night #2b2b2b(43,43,43) / eye #d3e0c4(211,224,196) / paper #f3edde(243,237,222) */
thead th{font-family:var(--sans);font-size:10px;text-align:left;color:var(--head);background:var(--paper);padding:6px 8px;font-weight:700;white-space:nowrap;letter-spacing:.06em;border-top:3px double var(--head);border-bottom:1px solid var(--head)}
tbody td{padding:7px 8px;border-top:1px solid var(--rule);vertical-align:top;color:var(--body-text)}
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
/* 正文分两栏。用 columns 而不是 grid：grid 的行必须等高，一段长文会把同一行的短段
   底下撑出一大块空白（实测 54 张卡累计 7125px，最差单卡 852px）。columns 由浏览器
   按内容均衡分栏，同样的卡片总高从 23201px 降到 18014px，空白自然消失。
   注意不要加 break-inside:avoid —— 加了会退回到「整段不拆分」，总高回升到 20881px。 */
.sections{columns:2;column-gap:24px}
@media (max-width:780px){.sections{columns:1}}
.sections section{padding:0 0 8px}
.sections h4{font-family:var(--sans);font-size:10px;letter-spacing:.1em;color:var(--muted);margin:0 0 3px;font-weight:700}
.sections p{margin:0;font-size:calc(12.8px * var(--fs-scale));line-height:1.85;text-align:left;overflow-wrap:break-word}
.evidence{margin-top:6px;padding-top:8px;border-top:1px dotted var(--rule2)}
.evidence>b{font-family:var(--sans);font-size:10px;letter-spacing:.1em;color:var(--muted);font-weight:700;display:block;margin-bottom:4px}
.evidence ul{list-style:none;margin:0;padding:0}
.evidence li{display:flex;gap:7px;align-items:baseline;font-size:11.5px;line-height:1.65;padding:1px 0}
.ev-kind{flex:none;font-family:var(--sans);font-size:9px;padding:0 5px;border:1px solid var(--rule2);border-radius:3px;color:var(--muted);letter-spacing:.02em}
.ev-text{font-family:var(--mono);font-size:11px;word-break:break-word}
.ev-look{all:unset;cursor:pointer;font-family:var(--mono);font-size:11px;word-break:break-word;border-bottom:1px dotted var(--rule2);transition:border-color .12s,color .12s}
.ev-look:hover{color:var(--ink);border-bottom-color:var(--ink)}
.ev-look:focus-visible{outline:1px solid var(--rule2);outline-offset:2px}
.ev-look[aria-busy="1"]{opacity:.55;cursor:progress}

/* 证据浮层：右下角，看完还能接着读卡片。
   底色用 --paper（和 AI 面板、设置框同一个口径）——
   --surface 在纸白/护眼主题下是半透明的，拿来当浮层底会透出后面的卡片，字就读不成了。 */
.look{position:fixed;right:18px;bottom:18px;width:min(760px,calc(100vw - 36px));max-height:min(64vh,640px);display:none;flex-direction:column;background:var(--paper);border:1px solid var(--ink);border-radius:8px;box-shadow:0 18px 48px rgba(0,0,0,.42);z-index:640;overflow:hidden}
.look.on{display:flex}
.look-head{display:flex;align-items:baseline;gap:10px;padding:10px 12px 6px;border-bottom:1px solid var(--rule2)}
.look-title{flex:1;min-width:0;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.look-x{all:unset;cursor:pointer;flex:none;font-size:12px;color:var(--muted);padding:2px 5px;border-radius:4px}
.look-x:hover{color:var(--ink);background:var(--surface-hover)}
.look-sub{padding:5px 12px;font-family:var(--sans);font-size:10.5px;color:var(--muted);border-bottom:1px solid var(--rule2);letter-spacing:.02em}
.look-sub:empty{display:none}
.look-body{flex:1;min-height:0;margin:0;overflow:auto;padding:10px 12px 14px;font-family:var(--mono);font-size:11px;line-height:1.62;color:var(--ink);white-space:pre;tab-size:2;background:var(--surface-soft)}
.card-acts{display:flex;gap:7px;justify-content:flex-end;margin-top:10px}

/* 已收口卡片默认收起：只露标题行，点击展开 */
.card.card-collapsed,.card.card-open{list-style:none;padding:0}
.card-collapsed>summary,.card-open>summary{display:block;cursor:pointer;list-style:none;position:relative;padding:9px 30px 9px 16px;user-select:none;-webkit-tap-highlight-color:transparent;overflow:visible}
.card-collapsed>summary::-webkit-details-marker,.card-open>summary::-webkit-details-marker{display:none}
.card-collapsed>summary .id,.card-open>summary .id{display:inline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px;font-family:var(--sans);font-size:10.5px;color:var(--muted);letter-spacing:.06em}
.card-collapsed>summary .meta,.card-open>summary .meta{float:right;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%;margin-right:14px;font-family:var(--sans);font-size:10px;color:var(--muted)}
.card-collapsed>summary h3{font-size:15px;margin:4px 0 0;clear:none}
/* 车道页默认展开：标题仍是卡片标题的尺寸，收起后就是一行条目 */
.card-open>summary h3{font-size:19px;line-height:1.35;margin:6px 0 0;clear:none}
.card-collapsed>.sections,.card-collapsed>.evidence,.card-collapsed>.card-acts{padding:0 16px 15px}
.card-open>.sections,.card-open>.evidence,.card-open>.card-acts{padding:0 16px 15px}
.card-collapsed>summary::after,.card-open>summary::after{content:"";position:absolute;right:12px;top:50%;transform:translateY(-50%);font-family:var(--sans);font-size:10px;line-height:1;color:var(--muted);pointer-events:none}
.card-collapsed[open]>summary::after,.card-open[open]>summary::after{content:"▲"}
.card-collapsed:not([open])>summary::after,.card-open:not([open])>summary::after{content:"▼"}

/* 按钮 */
.btn{appearance:none;font-family:var(--sans);font-size:10px;letter-spacing:.04em;padding:2px 9px;border-radius:3px;border:1px solid var(--rule2);background:var(--surface);color:var(--muted);cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.btn:hover{color:var(--ink);border-color:var(--ink);background:var(--surface-hover)}
.btn-ask{border-color:color-mix(in srgb,var(--red2) 40%,transparent);color:var(--red2);background:color-mix(in srgb,var(--red2) 8%,transparent)}
.btn-ask:hover{background:color-mix(in srgb,var(--red2) 20%,transparent);color:var(--ink);border-color:var(--red2)}
.btn:disabled{opacity:.45;cursor:not-allowed}

/* 清单与时间线 */
.timeline{list-style:none;margin:0;padding:0 0 0 20px;border-left:2px solid var(--rule2)}
.timeline li{position:relative;padding:0 0 10px 9px;font-size:calc(12.2px * var(--fs-scale));line-height:1.7}
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

/* ── 工作台（自动执行） ── */
/* 挂载点：工作台是单实例节点，切视图时被搬进当前页的这个空位。
   挂载点本身不画东西，只负责占位与顶部间距（工作台自己还有 margin-top）。
   总览页是它默认落点，所以这里把上方留白交给它，别和工作台的外边距叠双份。 */
.wb-mount{display:block}
.wb-mount:empty{display:none}
.wb-mount>.workbench{margin-top:0}
.workbench{border:1px solid var(--rule2);background:var(--surface-soft);padding:14px 16px;margin-top:18px;border-radius:3px}
.workbench-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.workbench-head h3{margin:0;font-family:var(--serif);font-size:15px;font-weight:700;color:var(--head)}
.workbench-desc{font-size:10.5px;color:var(--muted);line-height:1.65;font-family:var(--sans)}
.workbench-controls{display:flex;flex-direction:column;gap:10px}
.workbench-pool{max-height:440px;overflow:auto;border:1px solid var(--rule);background:var(--paper);border-radius:3px;padding:8px}
.wb-group{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;margin-bottom:8px}
.wb-group:last-child{margin-bottom:0}
.wb-group-label{flex:0 0 100%;font-size:10px;color:var(--muted);font-family:var(--sans);letter-spacing:.04em;text-transform:uppercase}
.workbench-empty{font-size:11.5px;color:var(--muted);padding:10px 6px;margin:0;font-family:var(--sans)}
.wb-pick{display:flex;flex-direction:column;flex:0 0 168px;min-height:74px;gap:5px;padding:9px 9px;border:1px solid var(--rule);border-radius:4px;cursor:pointer;font-family:var(--sans);background:var(--surface);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.wb-pick-row{display:flex;align-items:baseline;gap:6px}
.wb-pick:hover{background:var(--surface-hover)}
.wb-pick[draggable=true]{cursor:grab}
.wb-pick[draggable=true]:active{cursor:grabbing}
.wb-pick.wb-dragging{opacity:.45;outline:1px dashed var(--rule2)}
.wb-pick.wb-drop-target{outline:2px solid var(--blue);outline-offset:-1px}
.wb-pick input{accent-color:var(--green);flex:none;position:relative;top:1px}
.wb-pick-busy{opacity:.55;cursor:default}
.wb-pick-grip{flex:none;color:var(--muted);cursor:grab;font-size:12px;user-select:none;align-self:flex-start}
.wb-pick-id{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:10px;color:var(--blue);font-weight:700;flex:none}
.wb-pick-title{font-size:11.5px;color:var(--ink);flex:1 1 auto;line-height:1.4;word-break:break-word}
.wb-pick-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:2px;flex-wrap:wrap}
.wb-pick-prefix{font-size:9.5px;color:var(--muted);flex:none;border:1px solid var(--rule2);border-radius:3px;padding:0 5px;font-family:var(--sans)}
.wb-pick .wb-occupied{color:var(--muted);font-size:10px}
.wb-pick .wb-queued{color:var(--muted);font-size:10px;font-style:italic}
.wb-state-tag{font-size:9.5px;color:#8a5a00;background:#fff3cd;border:1px solid #e6c66a;border-radius:3px;padding:1px 6px;font-family:var(--sans);white-space:normal;word-break:break-word;max-width:100%;flex:1 1 auto;text-align:left;min-width:0}
.wb-pick.wb-occupied{background:var(--surface-soft);box-shadow:none}
.wb-pick.wb-occupied .wb-pick-title{color:var(--muted)}
.wb-pick-x{flex:none;border:0;background:none;color:var(--muted);cursor:pointer;font-size:11px;line-height:1;padding:2px 4px;border-radius:3px}
.wb-pick-x:hover{color:var(--danger,#d33);background:var(--surface-hover)}
.wb-standby{border-style:dashed;border-color:var(--rule2);background:var(--surface-soft)}
.wb-standby .wb-pick-title{color:var(--muted)}
.wb-pool-foot{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:11px;color:var(--muted);font-family:var(--sans)}
.workbench-mode{display:flex;gap:16px;flex-wrap:wrap;font-family:var(--sans);font-size:11.5px}
.wb-mode-option{display:inline-flex;align-items:center;gap:4px;color:var(--ink);cursor:pointer}
.wb-mode-option input{accent-color:var(--blue)}
.workbench-batch{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-family:var(--sans);font-size:11.5px;color:var(--ink)}
/* 分批是「并行」之下的开关：并行才显示，串行隐藏。避免和串/并行平级显得三选一。 */
.workbench-controls:not(:has(input[name=wb-mode][value=parallel]:checked)) .workbench-batch{display:none}
.wb-batch-label{color:var(--muted)}
.wb-batch-size{font-family:var(--sans);font-size:11.5px;padding:2px 6px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);border-radius:3px}
.wb-batch{display:block;margin:8px 0;border:1px dashed var(--rule2);border-radius:4px;padding:6px 8px}
.wb-batch-head{display:flex;align-items:baseline;gap:8px;font-size:11px;font-weight:700;color:var(--ink);padding-bottom:4px}
.wb-batch-reason{font-weight:400;font-size:9.5px;color:var(--muted)}
.workbench-actions{display:flex;gap:8px;flex-wrap:wrap}
.workbench-actions .btn{font-family:var(--sans)}
.workbench-actions .btn:disabled{opacity:.45;cursor:not-allowed}
.workbench-run{margin-top:12px;border-top:1px solid var(--rule);padding-top:10px}
.workbench-run-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.wb-run-phase{font-family:var(--sans);font-size:11.5px;font-weight:700;color:var(--head)}
.wb-run-progress{font-family:var(--sans);font-size:10.5px;color:var(--muted)}
.wb-log{display:block;width:100%;font-size:10px;color:var(--muted);font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);line-height:1.6}
.workbench-steps{list-style:none;margin:10px 0 0;padding:0;font-family:var(--sans)}
.wb-step{display:flex;align-items:baseline;gap:8px;padding:6px 8px;border-left:3px solid var(--rule2);margin:2px 0;font-size:11.5px;background:var(--paper)}
.wb-step-i{flex:none;width:20px;text-align:right;font-size:10px;color:var(--muted);font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.wb-step-id{flex:none;font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:10px;color:var(--blue);font-weight:700}
.wb-step-title{flex:1 1 auto;color:var(--ink)}
.wb-step-why{flex:none;max-width:46%;font-size:9.5px;color:var(--muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--sans)}
.wb-step-running{border-left-color:var(--blue);background:var(--surface-strong)}
.wb-step-wait{border-left-color:var(--rule);opacity:.7}
.wb-step-asking{border-left-color:var(--amber)}
.wb-step-done{border-left-color:var(--green)}
.wb-step-done .wb-step-title{text-decoration:line-through;color:var(--muted)}
.wb-step-skip{border-left-color:var(--red);opacity:.6}
@media (max-width:560px){.wb-step{flex-direction:column;align-items:flex-start}.wb-step-why{max-width:100%;text-align:left}}

/* 并行 = 多个任务队列：一路一行横排卡，多路队列从上往下叠。
   run-head 说明文字模块（phase/progress）在并行时整行隐藏，只留队列本身。 */
.wb-run-parallel .workbench-run-head{display:none}
.wb-lanes{display:block}
.wb-lane{display:grid;grid-template-columns:86px 1fr;align-items:start;gap:8px;margin:6px 0;border-top:1px dashed var(--rule2);padding-top:8px}
.wb-lane-name{font-size:11px;font-weight:700;color:var(--head);line-height:1.9;white-space:nowrap;text-align:right;padding-top:2px}
.wb-lane-cards{list-style:none;margin:0;padding:0;display:flex;gap:8px;flex-wrap:wrap;align-items:stretch}
.wb-lane-cards .wb-step{border-left:3px solid var(--rule2);border-radius:3px;margin:0;padding:6px 10px;flex:0 0 auto;min-width:150px;max-width:220px;background:var(--paper)}
.wb-lane-cards .wb-step-i,.wb-lane-cards .wb-step-id{display:inline-block}
.wb-lane-cards .wb-step-title{display:block;margin-top:2px;white-space:normal}
.wb-lane-cards .wb-step-done{border-left-color:var(--green)}
.wb-lane-cards .wb-step-asking{border-left-color:var(--amber)}
.wb-lane-cards .wb-step-wait{border-left-color:var(--rule);opacity:.7}
/* 「每批 1 张」时同路第二张起 = 排队：虚线边 + 淡字 + 「排队中 · 等 XXX」，
   和正在跑的那张（实线蓝边）明确区分开。提示单独占一行，免得挤在 220px 的小卡里。 */
.wb-lane-cards .wb-step-queued{border-left:3px dashed var(--rule2);opacity:.78;background:var(--surface-soft);flex-direction:column;align-items:flex-start}
.wb-lane-cards .wb-step-queued .wb-step-title{color:var(--muted)}
.wb-lane-cards .wb-step-queued .wb-step-why{flex:none;max-width:100%;margin-top:3px;font-size:9px;color:var(--muted);text-align:left;white-space:nowrap}

/* ── Skill 统计（独立页） ── */
.skills{border-top:1px solid var(--rule2);padding-top:14px;margin-bottom:6px}
#skill-group-used,#skill-group-produced,#skill-group-related{border:1px solid var(--rule2);background:var(--surface-soft);padding:12px 14px 13px;margin:14px 0 0;scroll-margin-top:70px}
.skill-group>h2{margin:0 0 4px;font-family:var(--serif);font-size:16px;font-weight:700;color:var(--head);letter-spacing:.02em;border-bottom:1px solid var(--rule);padding-bottom:6px}
.skill-group>.rail-note{margin:6px 0 4px}
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
.skill-title{flex:1 1 100%;font-size:calc(11.5px * var(--fs-scale));color:var(--ink)}
.skill-desc{flex:1 1 100%;font-family:var(--sans);font-size:9.5px;line-height:1.6;color:var(--muted)}
/* 处理记录按类型筛选：跟原版一样，未选中的淡下去，选中的描一圈边 */
.history-kinds .kind-chip{appearance:none;-webkit-appearance:none;cursor:pointer;opacity:.55;transition:opacity .15s,box-shadow .15s;-webkit-tap-highlight-color:transparent}
.history-kinds .kind-chip:hover{opacity:1}
.history-kinds .kind-chip.is-active{opacity:1;box-shadow:inset 0 0 0 1.5px currentColor}
.history-kinds .kind-chip b{font-weight:700;margin-left:2px;opacity:.8}
.timeline li.is-hidden{display:none}
.history-sub{font-family:var(--sans)}
.stage-empty{font-size:12.2px;color:var(--muted);padding:6px 0 10px;margin:0}
.issue-section{border-bottom:3px double var(--ink);padding:20px 0 22px}
.priority-block{margin-top:2px;padding-top:16px}

/* ── AI 面板：一个能拖、能拉、能钉住的对话浮窗 ──
   不是右侧抽屉。抽屉占满整条边、盖住半页台账，而且没法同时看两边；
   这里做成独立小窗：标题栏拖位置，八条边拉大小，双线上下一拉分问答区。
   下面的 left/top/width/height 只是「JS 还没量出视口」时的兜底值，
   打开时 client.js 会用内联样式覆盖成量好的像素值。 */
/* 层级：默认 180，压在搜索浮层（190）和设置弹窗（210）之下 ——
   打开搜索时该盖住它，否则浮窗挡着搜索结果。置顶才升到 205。
   （180 是刻意的：只比正文高，不与任何浮层抢。） */
.ai-panel{position:fixed;top:auto;bottom:26px;right:26px;left:auto;width:min(456px,calc(100vw - 32px));height:min(640px,calc(100vh - 96px));min-width:320px;min-height:300px;z-index:180;display:flex;flex-direction:column;background:var(--paper);border:1px solid var(--ink);border-radius:5px;box-shadow:0 16px 48px rgb(0 0 0 / .34);overflow:visible;opacity:0;pointer-events:none;transition:opacity .18s ease}
.ai-panel.is-open{opacity:1;pointer-events:auto}
/* 置顶：盖住搜索浮层（190），但仍然让设置弹窗（210）压在上面 ——
   设置是模态确认框，被一个对话窗盖住会让人以为点不动。 */
.ai-panel[data-pinned="1"]{z-index:205;box-shadow:0 20px 60px rgb(0 0 0 / .42);border-color:var(--red2)}
.ai-head{flex:none;display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:2px solid var(--ink);cursor:move;user-select:none;touch-action:none}
.ai-head h3{margin:0;font-family:var(--sans);font-size:11px;letter-spacing:.12em;font-weight:700;color:var(--red)}
.ai-head .ctx{flex:1;min-width:0;font-family:var(--sans);font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-head button{appearance:none;background:none;border:1px solid var(--rule2);border-radius:3px;color:var(--muted);font-family:var(--sans);font-size:9.5px;padding:1px 6px;cursor:pointer;line-height:1.6}
.ai-head button:hover{color:var(--ink);border-color:var(--ink)}

/* 会话选择：新对话 / 选择对话。放在标题下方单独一行，避免和标题挤在一起。 */
.ai-session{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 14px;border-bottom:1px solid var(--rule2);background:var(--paper2)}
.ai-mode{display:inline-flex;align-items:center;gap:4px;font-family:var(--sans);font-size:9.5px;color:var(--muted);cursor:pointer;white-space:nowrap}
.ai-mode input{appearance:none;width:11px;height:11px;margin:0;border:1px solid var(--rule2);border-radius:50%;cursor:pointer;position:relative}
.ai-mode input:checked{border-color:var(--red)}
.ai-mode input:checked::after{content:"";position:absolute;inset:2px;border-radius:50%;background:var(--red)}
.ai-mode input:checked + span{color:var(--ink);font-weight:700}
.ai-mode input:disabled + span{opacity:.45;cursor:default}
/* 下拉是「选择对话」的一部分：没选这个模式时它没有意义，藏起来省一行视觉噪音。 */
.ai-session select{flex:1;min-width:0;appearance:none;background:none;border:1px solid var(--rule2);border-radius:3px;color:var(--muted);font-family:var(--sans);font-size:9.5px;padding:2px 6px;cursor:pointer;text-overflow:ellipsis}
.ai-session select[hidden]{display:none}
.ai-session select:disabled{opacity:.45;cursor:default}
.ai-session select:not(:disabled):hover{color:var(--ink);border-color:var(--ink)}
.ai-session select option{background:var(--paper);color:var(--ink);font-size:11px}

.ai-msgs{flex:1 1 0;min-height:96px;overflow-y:auto;padding:14px 14px 6px;scrollbar-width:thin}
.ai-msgs::-webkit-scrollbar{width:8px}
.ai-msgs::-webkit-scrollbar-thumb{background:var(--rule);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
/* 问答区和输入区之间的那道分界：能上下拉。
   消息区 flex:1 吃掉剩下的高度，输入区高度由 JS 写成像素（没拉过就不写，按内容自适应）。
   min-height:0 是关键：不写的话消息区的内容会把整块撑高，
   分界看着在、拉起来却没反应（实际是被下面的内容顶住了）。 */
.ai-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.ai-split{flex:none;height:9px;cursor:row-resize;touch-action:none;position:relative;background:var(--paper)}
.ai-split::before{content:"";position:absolute;left:14px;right:14px;top:4px;height:1px;background:var(--rule2);transition:background .12s,height .12s}
.ai-split:hover::before,.ai-split:focus-visible::before,.ai-split.is-moving::before{background:var(--red2);height:2px;top:3.5px}
.ai-split:focus-visible{outline:none}
/* 已经拉到上下两端到头时把手柄画灰：再拉也没用了，免得以为坏了。 */
.ai-split.is-capped{cursor:default}
.ai-split.is-capped::before{background:var(--rule)}
/* 输入区：默认按内容自适应高度（flex-shrink 允许它在窗口太矮时收一点并自己滚），
   用户拉了分界之后高度就由 JS 写成像素，并把它钉住不再被压。 */
/* 输入区：.ai-foot 被拉高之后，多出来的高度要给输入框本身，
   而不是在「发送」下面留一块空白 —— 那里是多写几个字的，不是装饰。 */
.ai-foot{flex:0 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;scrollbar-width:thin}
.ai-foot[data-locked="1"]{flex:none}
.ai-foot[data-locked="1"] .ai-compose{flex:1;min-height:0;display:flex;flex-direction:column}
.ai-foot[data-locked="1"] .ai-compose textarea{flex:1;min-height:62px;max-height:none}
.ai-foot[data-locked="1"] .ai-compose .send-row{flex:none}
/* 一问一答分左右：用户消息靠右、做成气泡，助手消息留在左侧占满宽度。
   和常见对话界面一致 —— 一眼能看出哪句是自己说的。
   气泡最大宽度 86%，长问题不至于顶满整行、看不出边界。 */
.msg{display:flex;flex-direction:column;align-items:stretch;margin-bottom:14px;font-size:calc(12.8px * var(--fs-scale));line-height:1.85}
.msg-user{align-items:flex-end}
.msg-role{font-family:var(--sans);font-size:9px;letter-spacing:.12em;font-weight:700;color:var(--muted);margin-bottom:3px;display:flex;align-items:center;gap:6px}
.msg-user .msg-role{color:var(--red);justify-content:flex-end}
.msg-user .msg-body{max-width:86%;background:color-mix(in srgb,var(--red) 8%,transparent);border:1px solid color-mix(in srgb,var(--red) 24%,transparent);border-radius:11px 11px 3px 11px;padding:7px 11px;text-align:left}
.msg-ai .msg-body{max-width:100%;border-left:2px solid var(--rule2);padding:2px 0 2px 10px}
.msg-body{white-space:pre-wrap;word-break:break-word}
.msg-body code{font-family:var(--mono);font-size:11px;background:var(--surface-strong);padding:0 3px;border-radius:2px}
.msg-body p{margin:0 0 .7em}
.msg-body p:last-child{margin-bottom:0}
.msg-divider{display:flex;align-items:center;gap:8px;font-family:var(--sans);font-size:9px;letter-spacing:.12em;color:var(--muted);opacity:.8;margin:2px 0 12px;white-space:nowrap}
.msg-divider::after{content:"";flex:1;border-top:1px dotted var(--rule2)}
.msg.is-history{opacity:.82}
.msg.is-history .msg-body{font-size:calc(12.4px * var(--fs-scale))}
.msg.is-history .msg-role::after{content:"（历史）";font-weight:400;color:var(--muted)}
/* 从 localStorage 恢复的上一轮对话：不淡化，只在角色后标一下来源 */
.msg.is-restored .msg-role::after{content:"（已保存）";font-weight:400;color:var(--muted);opacity:.75}

/* 过程清单：把这一轮的工具调用摊开，让人看见它到底做了什么。
   默认折叠，展开后是一行一步；失败的那步标红，没跑完的转圈。 */
.msg-steps-wrap{align-self:stretch;margin-top:6px;border-top:1px dotted var(--rule2);padding-top:5px}
.msg-steps-wrap summary{font-family:var(--sans);font-size:9px;letter-spacing:.1em;color:var(--muted);cursor:pointer;list-style:none;user-select:none}
.msg-steps-wrap summary::-webkit-details-marker{display:none}
.msg-steps-wrap summary::before{content:"▸ ";font-size:8px}
.msg-steps-wrap[open] summary::before{content:"▾ "}
.msg-steps-wrap summary:hover{color:var(--ink)}
.msg-steps{margin-top:5px;display:flex;flex-direction:column;gap:2px}
.msg-steps-head{display:none}
.msg-step{display:flex;align-items:baseline;gap:6px;font-size:10px;line-height:1.5;padding:1px 0}
.msg-step-name{font-family:var(--sans);font-weight:700;color:var(--muted);white-space:nowrap;flex:0 0 auto}
.msg-step-detail{font-family:var(--mono);font-size:9.5px;color:var(--muted);opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.msg-step.is-pending .msg-step-name{color:var(--amber,var(--muted))}
.msg-step.is-failed .msg-step-name{color:var(--red)}
.msg-step.is-failed .msg-step-detail{color:var(--red);opacity:.7}
/* 每条回答底下的「去 Harness 看完整会话」：小、次要，不抢正文。
   align-self 把它钉在左边 —— 父级 .msg 在用户消息上是 flex-end，
   否则这个按钮会被一起推到右边去。 */
.msg-goto{align-self:flex-start;margin-top:6px;font-family:var(--sans);font-size:9px;letter-spacing:.06em;color:var(--muted);background:none;border:1px solid var(--rule2);border-radius:2px;padding:2px 7px;cursor:pointer}
.msg-goto:hover{color:var(--ink);border-color:var(--ink)}
.msg-body .cursor{display:inline-block;width:6px;height:13px;background:var(--red);vertical-align:-2px;animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
.msg-body.msg-error{border-left-color:var(--red);color:var(--red2);font-family:var(--sans);font-size:11.5px}
.ai-empty{padding:30px 6px;text-align:center;font-family:var(--sans);font-size:11px;color:var(--muted);line-height:1.9}
.ai-empty b{display:block;color:var(--ink);font-size:calc(12px * var(--fs-scale));margin-bottom:4px}

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

/* 停靠按钮：当前形态记在面板的 data-mode 上，按钮文字由 JS 换。
   置顶按下时给个实心红，跟普通按钮区分开。 */
.ai-head .ai-tool[aria-pressed="true"]{background:var(--red-fill);border-color:var(--red-fill);color:#fff}
.ai-head .ai-tool[aria-pressed="true"]:hover{color:#fff;border-color:var(--red2)}
/* 停靠形态：回到老样子 —— 贴右边缘、占满整条边、没有圆角。
   这一形态下拖拽和拉角全部关掉，免得用户以为拖不动是坏了。 */
.ai-panel[data-mode="dock"]{top:0;bottom:0;right:0;left:auto;width:min(456px,100%);height:auto;min-width:0;min-height:0;border-radius:0;border:0;border-left:1px solid var(--rule2);box-shadow:-8px 0 40px rgb(20 14 4 / .3)}
.ai-panel[data-mode="dock"] .ai-head{cursor:default}
.ai-panel[data-mode="dock"] .ai-grip{display:none}

/* 八条边/角的抓手。放在面板四边，各管一个方向；
   只在浮窗形态显示。宽高都靠 JS 改内联样式，这里只管光标和位置。 */
.ai-grip{position:absolute;z-index:2;touch-action:none}
.ai-grip[data-dir="n"]{top:-3px;left:8px;right:8px;height:8px;cursor:ns-resize}
.ai-grip[data-dir="s"]{bottom:-3px;left:8px;right:8px;height:8px;cursor:ns-resize}
.ai-grip[data-dir="w"]{left:-3px;top:8px;bottom:8px;width:8px;cursor:ew-resize}
.ai-grip[data-dir="e"]{right:-3px;top:8px;bottom:8px;width:8px;cursor:ew-resize}
.ai-grip[data-dir="nw"]{top:-3px;left:-3px;width:14px;height:14px;cursor:nwse-resize}
.ai-grip[data-dir="ne"]{top:-3px;right:-3px;width:14px;height:14px;cursor:nesw-resize}
.ai-grip[data-dir="sw"]{bottom:-3px;left:-3px;width:14px;height:14px;cursor:nesw-resize}
.ai-grip[data-dir="se"]{bottom:-3px;right:-3px;width:14px;height:14px;cursor:nwse-resize}
/* 右下角画三道斜线，让人看得出这儿能拉 —— 光靠光标形状是发现不了的。 */
.ai-grip[data-dir="se"]::after{content:"";position:absolute;right:4px;bottom:4px;width:7px;height:7px;border-right:2px solid var(--rule);border-bottom:2px solid var(--rule);border-bottom-right-radius:2px;pointer-events:none}
.ai-grip[data-dir="se"]:hover::after{border-color:var(--red2)}
/* 拖拽/拉伸时别让页面跟着选中文字，也别触发 iframe 里的原生拖拽。 */
.ai-panel.is-moving,.ai-panel.is-moving *{user-select:none!important}
.ai-panel.is-moving{cursor:inherit}

/* ── 顶栏上的搜索 / 设置入口 ── */
.topbar-btn{appearance:none;font-family:var(--sans);font-size:9.5px;letter-spacing:.06em;padding:2px 9px;border:1px solid var(--rule2);border-radius:3px;background:var(--surface);color:var(--muted);cursor:pointer;transition:color .15s,border-color .15s}
.topbar-btn:hover{color:var(--ink);border-color:var(--ink)}

/* ── 搜索浮层 ── */
/* 为什么不用浏览器自带的 Ctrl+F：整本台账是一个文件里的 6 个视图，
   看不见的视图、AI 面板里的字都在 DOM 里，自带查找会命中一堆当前看不到的东西，
   而且它只能滚到文字，没法按条目跳。这层只搜条目，命中点分组列出来。 */
.finder{position:fixed;top:0;left:0;right:0;z-index:190;display:none;flex-direction:column;max-height:min(72vh,640px);background:var(--paper);border-bottom:2px solid var(--ink);box-shadow:0 16px 40px rgb(0 0 0 / .3)}
.finder.is-open{display:flex}
.finder-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--rule)}
.finder-input{flex:1;min-width:0;appearance:none;background:var(--surface);border:1px solid var(--rule2);border-radius:3px;color:var(--ink);font-family:var(--serif);font-size:15px;line-height:1.6;padding:6px 10px}
.finder-input:focus{outline:none;border-color:var(--red2)}
.finder-count{flex:none;font-family:var(--sans);font-size:10px;letter-spacing:.06em;color:var(--muted);white-space:nowrap}
.finder-close{flex:none;appearance:none;background:none;border:0;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}
.finder-close:hover{color:var(--ink)}
.finder-hint{flex:none;font-family:var(--sans);font-size:9.5px;letter-spacing:.04em;color:var(--muted);padding:5px 16px;border-bottom:1px solid var(--rule)}
.finder-results{overflow:auto;padding:6px 10px 10px}
.finder-group{border-bottom:1px dotted var(--rule2);padding:6px 0}
.finder-group:last-child{border-bottom:0}
.finder-item{display:flex;align-items:baseline;gap:8px;width:100%;appearance:none;background:none;border:0;padding:2px 6px;border-radius:2px;color:inherit;text-align:left;font-family:inherit;cursor:pointer}
.finder-item:hover{background:var(--surface-hover)}
.finder-id{flex:none;font-family:var(--sans);font-size:10px;color:var(--muted);letter-spacing:.04em}
.finder-title{font-size:13.5px;line-height:1.5;font-weight:600}
.finder-lane{flex:none;margin-left:auto;font-family:var(--sans);font-size:9px;color:var(--muted)}
.finder-hit{display:flex;align-items:baseline;gap:8px;width:100%;appearance:none;background:none;border:0;padding:2px 6px 2px 22px;border-radius:2px;color:inherit;text-align:left;font-family:inherit;font-size:12px;line-height:1.65;cursor:pointer}
.finder-hit:hover{background:var(--surface-hover)}
.finder-item.is-active,.finder-hit.is-active{background:var(--surface-strong);box-shadow:inset 2px 0 0 var(--red2)}
.finder-where{flex:none;min-width:56px;font-family:var(--sans);font-size:9px;letter-spacing:.04em;color:var(--red2)}
.finder-snip{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--body-text)}
.finder-snip b{background:color-mix(in srgb,var(--red) 26%,transparent);color:var(--ink);font-weight:700;border-radius:2px}
.finder-more{font-family:var(--sans);font-size:9px;color:var(--muted);padding:1px 6px 1px 22px;margin:0}
.finder-empty{padding:26px 8px;text-align:center;font-family:var(--sans);font-size:11px;color:var(--muted);line-height:1.9;margin:0}

/* ── 设置浮窗 ── */
.settings{position:fixed;inset:0;z-index:210;display:none;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / .44)}
.settings.is-open{display:flex}
.settings-box{position:relative;display:flex;flex-direction:column;width:min(540px,100%);max-height:min(84vh,760px);background:var(--paper);border:1px solid var(--ink);border-radius:4px;box-shadow:0 22px 56px rgb(0 0 0 / .42)}
.settings-head{flex:none;display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:2px solid var(--ink)}
.settings-head h3{margin:0;font-size:16px;line-height:1.4}
.settings-head span{margin-left:auto;font-family:var(--sans);font-size:9.5px;letter-spacing:.06em;color:var(--muted)}
.settings-close{flex:none;appearance:none;background:none;border:0;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}
.settings-close:hover{color:var(--ink)}
.settings-body{overflow:auto;padding:2px 16px 14px}
.settings-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:11px 0;border-bottom:1px dotted var(--rule2)}
.settings-row:last-child{border-bottom:0}
.settings-label{flex:0 0 84px;font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.04em}
.settings-ctl{flex:1;display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
.settings-note{flex:1 0 100%;margin:0;font-family:var(--sans);font-size:9.5px;line-height:1.75;color:var(--muted)}
.settings-seg{display:flex;border:1px solid var(--rule2);border-radius:3px;overflow:hidden}
.settings-seg button{appearance:none;background:var(--surface);border:0;border-left:1px solid var(--rule2);color:var(--muted);font-family:var(--sans);font-size:10px;letter-spacing:.04em;padding:3px 11px;cursor:pointer;transition:color .15s,background .15s}
.settings-seg button:first-child{border-left:0}
.settings-seg button:hover{color:var(--ink)}
.settings-seg button.is-active{background:var(--red-fill);color:#fff}
.settings-select{appearance:none;background:var(--surface);border:1px solid var(--rule2);border-radius:3px;color:var(--ink);font-family:var(--sans);font-size:10.5px;padding:3px 7px;cursor:pointer;max-width:100%}
.settings-select:focus{outline:none;border-color:var(--red2)}
.settings-check{display:inline-flex;align-items:center;gap:6px;font-family:var(--sans);font-size:10.5px;color:var(--ink);cursor:pointer}
.settings-check input{margin:0;cursor:pointer}
.settings-btn{appearance:none;font-family:var(--sans);font-size:10px;letter-spacing:.04em;padding:3px 11px;border:1px solid var(--rule2);border-radius:3px;background:var(--surface);color:var(--ink);cursor:pointer}
.settings-btn:hover{border-color:var(--ink)}
.settings-btn.is-danger{color:var(--red2);border-color:color-mix(in srgb,var(--red) 42%,transparent)}
.settings-btn.is-danger:hover{border-color:var(--red2)}

/* ── 导出报表面板 ──
   复用 .settings 那套外壳（遮罩、圆角、行、分段按钮），这里只补它没有的几块：
   多选列表、路径输入框、生成按钮的进行中状态、结果清单。 */
.exp-boards{width:100%;max-height:172px;overflow:auto;border:1px solid var(--rule2);border-radius:3px;background:var(--surface);padding:3px}
.exp-boards .settings-note{padding:6px 7px;margin:0}
.exp-board{display:flex;align-items:flex-start;gap:7px;padding:6px 7px;cursor:pointer;border-radius:2px}
.exp-board:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}
.exp-board input{margin:2px 0 0;cursor:pointer;flex:none}
.exp-board .t{flex:1;min-width:0;font-family:var(--sans);font-size:11.5px;line-height:1.5}
.exp-board .t i{display:block;font-style:normal;font-size:9.5px;color:var(--muted);letter-spacing:.02em;margin-top:1px}
.exp-board .cur{font-family:var(--sans);font-size:8.5px;letter-spacing:.06em;color:var(--red2);border:1px solid color-mix(in srgb,var(--red) 40%,transparent);border-radius:2px;padding:0 3px;margin-left:4px;vertical-align:1px}
.exp-path{flex:1;min-width:0;font-family:var(--mono);font-size:10.5px;padding:4px 7px}
/* placeholder 不写就会落到浏览器默认的灰（rgb(117,117,117)），
   在夜晚主题的深底上几乎看不见，和正文字色也不搭。统一压到 muted。 */
.exp-path::placeholder{color:var(--muted);opacity:1}
.exp-go{font-size:10.5px;padding:5px 16px;border-color:var(--red2);color:var(--red2)}
.exp-go:hover{border-color:var(--red2);background:var(--red-fill);color:#fff}
.exp-go[disabled]{cursor:default;opacity:.55}
.exp-go[disabled]:hover{background:var(--surface);color:var(--red2)}
.exp-status{font-family:var(--sans);font-size:10px;color:var(--muted);letter-spacing:.02em}
.exp-status.err{color:var(--red2)}
.exp-status.ok{color:var(--ink)}
.exp-result{flex:1 0 100%;margin-top:2px;max-height:190px;overflow:auto}
.exp-result:empty{display:none}
.exp-file{display:flex;align-items:baseline;gap:8px;padding:5px 0;border-top:1px dotted var(--rule2);font-family:var(--sans);font-size:10.5px}
.exp-file:first-child{border-top:1px solid var(--rule2)}
.exp-file .k{flex:none;width:58px;font-size:9px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase}
.exp-file .p{flex:1;min-width:0;font-family:var(--mono);font-size:10px;color:var(--ink);word-break:break-all;line-height:1.55}
.exp-file .b{flex:none;font-size:9px;color:var(--muted);font-variant-numeric:tabular-nums}
.exp-sum{font-family:var(--sans);font-size:10.5px;color:var(--muted);line-height:1.9;padding:7px 0 2px;letter-spacing:.02em}
.exp-sum b{color:var(--ink);font-variant-numeric:tabular-nums}
/* 「浏览…」按钮：比旁边的「默认」窄一点，不抢主按钮的注意力 */
.exp-pick{padding:3px 9px}

/* ── 只当对话窗用（?chat=1）────────────────────────────────────────
   同一个页面被 Harness 用一个独立的小 iframe 再加载一次，这次只留对话框：
   页面骨架全藏掉，对话框从「浮层」变成「填满这个 iframe 的正文」。
   特性：几何位置、置顶、停靠、拖拽全归外面的 Harness 窗口管 —— 这里必须
   一个都不做，否则两套定位会互相打架（外面拖动时里面再夹一次边界，
   窗口就会一格一格地跳）。 */
html[data-chat="1"] .topbar,
html[data-chat="1"] .masthead,
html[data-chat="1"] .nav,
html[data-chat="1"] .layout,
html[data-chat="1"] .page::before,
html[data-chat="1"] .finder,
html[data-chat="1"] .settings{display:none!important}
/* 页面容器本身是用来给正文留白和描边框的，这里不需要 */
html[data-chat="1"] .page{width:auto;margin:0;background:none;box-shadow:none;border:0;min-height:0}
/* 页面本身不许滚：留着滚动条的话，铺满整个视口的浮层会少掉一条滚动条的宽度
   （约 15px），右边露出底色，看起来像窗口没贴边。
   scrollbar-gutter:stable 也要关 —— 它在 :root 上给整页预留了一条槽，
   哪怕 overflow 已经 hidden，body 的可用宽度照样少 15px。 */
html[data-chat="1"]{overflow:hidden;height:100%;scrollbar-gutter:auto}
html[data-chat="1"] body{overflow:hidden;height:100%;background:var(--paper)}
/* 对话框铺满整个 iframe。去掉圆角和外阴影 —— 圆角是浮窗的语汇，
   现在这一层就是窗口本身，圆角由 Harness 那边的窗口画。 */
html[data-chat="1"] .ai-panel,
html[data-chat="1"] .ai-panel[data-mode="dock"]{position:fixed;top:0;left:0;right:0;bottom:0;width:auto;height:auto;min-width:0;min-height:0;border:0;border-radius:0;box-shadow:none;opacity:1;pointer-events:auto;z-index:1}
/* 标题栏不再能拖：窗口的拖动在外层。光标也就别装成可拖的样子。 */
html[data-chat="1"] .ai-head{cursor:default;touch-action:auto}
/* 拉角和置顶/停靠按钮在这里没有意义，藏掉省得点了没反应。 */
html[data-chat="1"] .ai-grip,
html[data-chat="1"] #ai-pin,
html[data-chat="1"] #ai-detach,
html[data-chat="1"] #ai-float-toggle{display:none}

@media print{
  :root{--page:#fff;--paper:#fff;--surface:#fff;--surface-soft:#fff;--surface-strong:#fff}
  .rail,.nav,.topbar,.card-acts,.ai-panel,.finder,.settings{display:none!important}
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
