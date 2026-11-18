# 交接文档 · 看板（ops-board）开发

> 写给下一个窗口的自己。读完这份就能直接接手，不用翻历史对话。
> 生成时间：2026-11-17 09:5x（Asia/Shanghai）
> 更新：2026-11-18 —— **「工作流」页已彻底删除**（视图、导航项、设置项、渲染函数一并去掉；工作台只留在「总览」页）。此前的两步：①工作台搬到「总览」页顶部（单实例节点，切视图时搬过去）；②工作流页去掉可拖动的流程画布。同日又修了「每批 1 张却像有两个任务」的显示问题：并行队列里同路第二张起标「排队中 · 等 XXX」（虚线边），执行侧本来就是一张一张跑。
> 上一轮结束时的状态：**工作台在「总览」页顶部**（`#view-overview`，全站唯一一份）。候选池分两组：上面「待执行队列」横排可拖排顺序的卡，下面「备选」区横排放没进队列的卡（点击卡片加入队列 /「全部加入」/「✕移出」都不会丢卡，只是回备选区）。点「分析」后：
> - **串行**：步骤区单列出执行顺序（同区域链序由 flow.mjs 约束拨正）；
> - **并行**：把分析结果按区域前缀拆成**多个任务队列，一路一行**——每队列卡**横向**排（左→右 = 该路执行顺序），**多队列纵向叠放**（`.wb-lanes`/`.wb-lane`）。**每批 1 张时，同路第二张起标「排队中 · 等 <前一张>」+ 虚线边**，和正在跑的那张一眼可分；每批 >1 / 整批时不标（那些卡要一起交给 Agent）；
> - **并行执行每路一条独立对话**：`workbenchAsk` 第三参 `convKey`，`wbConvKey(id)` 按卡所属路返回「路N · 前缀」，同一路的卡复用同一会话键 → 左侧会话列表一条路一条对话；非并行每张卡各一个会话。
> 全部测试绿：flow-test 11/0（工作流页已删 + 旧 hash 不白屏 + 工作台单实例在总览）、flow-workbench-test 57/0（含并行拆路+前后拖拽+分批开关显隐+初始空队列+点卡撤回备选+[5i]并行批1 限速+[5j]排队卡标记）、flow-workbench-run-test 10/0（真 claim→ask→release，串行 3 件 / 并行 5 件 4 路）、flow-api-test 33/0（数据驱动：领取/互斥/跨区/落盘重启）、wb-mount-test 12/0、wb-overview-live-test 11/0、stale-route-test 3/0、card-fold 16/12、verify-board 双板通过。

---

## 一、一句话现状

看板已经能用，**工作台在「总览」页顶部**（2026-11-18 用户从工作流页搬过来，看满意后把那一页整个删了）。它是**单实例节点**，切视图时跟着搬到当前页的 `[data-wb-mount]` 空位；没有挂载点的页（问题页 / Skill 页）则收进隐藏暂存区 `#wb-park`，节点不掉线、状态不丢。
- **总览页现在只有「工作台 + 处理记录」**（2026-11-19 二十改）：原来的「待处理问题」「待处理风险」两块表
  已分别搬到「问题修复」页和「风险」页的**第一行第一模块**，总览一张表都不剩。
- **三个「按车道/页面聚合」的 AI 入口**：问题页「总结项目状态」（整本台账）、风险页「风险审核」（只审风险车道）、
  需求页「计划中」右侧「和 AI 谈谈要加什么」（只谈需求车道）—— 各自独立会话，互不串味。
- **工作台 = 候选池（待执行队列横排 + 备选区）+ 分析（串行/并行）+ 自动执行**。
- **并行 = 多路队列**：点「分析」选并行，步骤区横排成多列 `.wb-lane`（每列一个区域前缀一路，纵向上到下列出该路整条链），不同路可同时推进（同一区域仍互斥，由 claim 保证）；
- **并行每路一条独立对话**：并行执行时用 `wbConvKey(id)` 给 `workbenchAsk` 传 `convKey`，同一路的卡共用一个会话键 → 左侧 Harness 会话列表一条路一条对话；非并行每张卡各一个会话。
- **批次模式**（`useBatches`/整批）：看板分批 → 一批整份清单交给单个 Agent 自主规划批内，见 §4.4。
顶部分批/串行执行引擎不变。全部测试通过（flow-test 11/0、workbench **57/0**、run-test 10/0、api-test 33/0、wb-mount 12/0、verify-board 双板通过）。
**工作台与流程接口测试都已改成数据驱动**：不再写死卡数/卡号，实时读 `/api/flow/plan` 推导期望值，看板随真实收口变化也不误报（`flow-api-test` 2026-11-18 重写，原先写死「7 件未收口 / OPS-022 可开工」，台账一推进就整片红）。
**领取状态已落盘**（`flow-claims.json`，重启不丢，D22 已闭环）。
**工作台（拖卡排顺序→分析→串行/并行→自动逐张/逐路交给 Harness 处理）已完成**，见 §4.4。

**当前最该做的下一件事**：把 `/api/evidence/stale`（38 张卡 / 110 处引用）接到 UI ——
接口早就算好了，但没有任何界面露出。

---

## 二、目录与文件（全部绝对路径）

### 2.1 三个目录，角色不同，别搞混

| 目录 | 角色 | 能不能随便改 |
|---|---|---|
| `D:\WorkSpace-Tools\ops-board\` | **模板 / 脚本源**（唯一一份代码） | 改这里 |
| `D:\WorkSpace-Tools\ops-board-reports\<看板名>\` | **每块看板自己的数据 + 产物** | 数据在这 |
| `D:\WorkSpace-Tools\dsh-ops-board\` | **DSH 插件**（把看板嵌进 GUI） | 改这里要同步 |

> ⚠️ **三个目录都没有 git 版本控制**。改大东西前自己先备份（本机习惯：`文件名.bak-YYYYMMDD-HHMMSS`）。

### 2.2 每块看板目录的结构（关键：**每个看板有自己的 config**）

```
D:\WorkSpace-Tools\ops-board-reports\cyber-egg-basket\
  board.config.json     ← ⚠️ 看板自己的视图配置，改模板不影响它
  ledger.json           ← 台账数据（61 条）
  project.json          ← {"projectDir": "...", "templateDir": "D:\\WorkSpace-Tools\\ops-board"}
  dist\index.html       ← 渲染产物（831 KB）
  scripts\*.mjs         ← 4341 字节的转发 shim，spawnSync 调模板里的真脚本
```

> **踩过的坑**：只改模板的 `board.config.json` 加视图，看板不会变 ——
> 它读自己那份。两块看板都要各改一次（改前备份成 `board.config.json.bak-flow`）。

### 2.3 核心代码文件

| 文件 | 大小 / 行数 | 干什么 |
|---|---|---|
| `scripts\render.mjs` | 42.4 KB / 907 行 | **渲染入口**。视图分发 + 每个视图的 HTML 拼装 |
| `scripts\lib\flow.mjs` | 11.2 KB / 288 行 | **工作流图推导**（下面单独讲） |
| `scripts\lib\workbench.mjs` | ~4 KB / ~110 行 | **工作台分析（纯计算）**：串行/并行建议，见 §4.4 |
| `scripts\lib\css.mjs` | ~64 KB / ~770 行 | 全部样式，一个字符串（含工作台 `.wb-*`） |
| `scripts\lib\client.js` | ~186 KB / ~4620 行 | 浏览器端交互（路由、搜索、AI 面板、领取/交还、**工作台驱动器**） |
| `scripts\lib\parts.mjs` | 21.2 KB / 546 行 | 卡片、表格、阶段块等可复用片段 |
| `scripts\serve.mjs` | ~29 KB / ~795 行 | 独立 HTTP 服务 + `/api/flow/*` + `/api/workbench/analyze` |
| `scripts\verify-board.mjs` | 42.3 KB / 794 行 | 产物自检（孤儿样式、死链、标签闭合） |

### 2.4 依赖文件（这是你要的「依赖」部分）

**运行时不依赖任何第三方包。** `package.json` 里没有 `dependencies` 字段，只有：

```json
{
  "name": "ops-board",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" }
}
```

依赖的只有 **Node 内置模块**：

| 模块 | 用在哪 |
|---|---|
| `node:fs` | 读写 ledger / config / 产物 |
| `node:path` | 路径拼接 |
| `node:http` | `serve.mjs` 的服务器 |
| `node:child_process` | `spawnSync`（看板脚本转发给模板） |
| `node:url` | 请求路径解析 |

测试脚本额外用 **CDP（Chrome DevTools Protocol）** 驱动无头 Edge，也是零依赖
（手写 WebSocket 帧，用 Node 内置的 `fetch` + `WebSocket`）。

**Edge 路径**（写死在几个测试脚本里，换机器要改）：
```
C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe
```

**这块是设计选择，不是巧合**：渲染层是「零依赖字符串拼 HTML + 一个 CSS 文件」。
所以加 React Flow 之类的图库 = 前端整体重写，违反渐进替换原则。
**内联 SVG 手拼是唯一兼容的做法** —— 现在的图就是这么做的。

---

## 三、这一轮做了什么（工作流可视化重做）

### 3.1 用户的原话

> 「现在这个界面是啥意思，不知道咋用，也没有我现象中的可视化」

之前那一版是**泳道 + 卡片列表**，用文字标签表达「抢地 2」「可并行 3」。
数据是对的，但**形式不是图** —— 用户看到的是嵌套列表，不是可视化。

### 3.2 现在的样子

![工作流图](screenshot-flow-graph.png)

（另一块看板：`screenshot-flow-cyber.png`）

**一行 = 一块地方**（按条目 `area` 字段的前缀自动分组，不是人工标注）。

- 同一行里**有箭头连着的** = 必须一件做完再做下一件
- **行与行之间没有箭头** = 可以同时开工

`practise` 那块看板：11 件未收口，**4 条路能同时开工、7 件得排队**。
一眼看得出 `tools` 那条链有 6 件（`BUG-001 → BUG-002 → BUG-003 → BUG-004 → BUG-005 → FEAT-003`）只能串着做，
而 `仓库根` / `out` / `src` 跟它无关，可以并行。

`cyber-egg-basket` 能看出那个跨泳道的坑：`免费额度` 一行 3 件
（`OPS-022 → OPS-025 → FEAT-014`），横跨「问题」和「需求」两条泳道，行标签标了「跨泳道串行 3 件」。

### 3.3 节点上有什么

- **编号**（`<a href="#OPS-022">`，点进去跳到那张卡片）
- **一句话标题**
- **阶段标签 + 状态**：`可以开工`（绿左边框）/ `等 XXX`（灰）/ `执行中`（蓝）
- 可开工的节点右下角有 **「领」按钮** → 点了占住这块地，别人再点后端拒掉

### 3.4 `flow.mjs` 的四步推导（改之前必须读懂）

```
buildFlow(config, ledger, claimed) → { lanes, totals, graph }
```

1. **建全局节点**：遍历所有未收口条目，每个算出
   `laneKey / laneLabel / title / status / statusLabel / tone / step / stepLabel / area / prefix / severity`
2. **全局定头**：按前缀分组，组内按 `(step, id)` 排序。把已被领走的挪到队尾，然后
   - `isHead = (i === 0 && !isClaimed)`
   - `waitFor = i === 0 ? "" : queue[i-1].id` ← **紧邻前驱，不是队首**
   - `chainHead = queue[0].id`
   - `blocks[]` / `parallelWith[]`
3. **按车道组装**（给老的 lane 视图用，图不依赖它）
4. **算像素坐标**：`layoutGraph(byPrefix)` → 每行一个 y、节点横向排开、箭头连相邻两件

**三个关键常量**（`flow.mjs` 顶部）：

```js
const NODE_W = 188;      // 节点宽
const NODE_H = 88;       // 节点高
const GAP_X = 52;        // 横向空隙（留给箭头）
const ROW_GAP = 26;
const LABEL_H = 26;      // 行标题占位
const PAD_TOP = LABEL_H + 6;   // ⚠️ 顶部必须留，否则第一行标题被容器切掉
const NODE_W_MIN = 132;
const WIDTH_BUDGET = 1120;     // 期望一屏容纳宽度
```

`nodeWidthFor(maxCount)` 按最长链反解节点宽度 —— 链越长节点越窄，尽量一屏看全。

### 3.5 这一轮踩的四个坑（都是真 bug，别再犯）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 行标题压在节点上、行与行重叠 | 画布坐标和行内坐标混用：行整体偏移一次，节点又偏移一次 | 节点坐标改成**相对行**（`top:0`），行标题用 `translateY(-100%)` 浮在行上方 |
| 2 | `FEAT-014` 写「等 OPS-022」，箭头却从 OPS-025 来 | `waitFor` 取的是队首，箭头连的是紧邻前驱 | `waitFor = queue[i-1].id`，另存 `chainHead` |
| 3 | 长链被右边裁掉 | 工作流页挤在右侧 2/3 栏 | 加 `.layout.is-wide`：进工作流页时侧栏 `display:none`，内容占满整宽。判据写在 DOM 上（`data-wide-view`），不硬编码视图名 |
| 4 | 第一行标题被容器切掉 | 标题浮在行上方，画布顶部没留空间 | `PAD_TOP = LABEL_H + 6` |

### 3.6 宽视图机制（新加的，值得记住）

`render.mjs` 里工作流 `<section>` 加了 `data-wide-view` 属性；
`client.js` 的 `show()` 里统一处理：

```js
var layout = document.querySelector(".layout");
if (layout) layout.classList.toggle("is-wide", target.hasAttribute("data-wide-view"));
```

CSS（`css.mjs`）：

```css
.layout.is-wide{grid-template-columns:minmax(0,1fr)}
.layout.is-wide>.rail{display:none}
.layout.is-wide>.views{padding-left:0;border-left:0}
```

**以后再加宽视图只需在 section 上加 `data-wide-view`，不用改 JS。**

---

## 四、并行领取（后端）

### 4.1 API（`serve.mjs`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/flow/plan` | 现在能开工哪几件？谁在等谁？ |
| POST | `/api/flow/claim` | 领一件（同区域互斥） |
| POST | `/api/flow/release` | 交还一件 |

**关键设计**：`serve.mjs` 不自己推导「谁能开工」，而是
`buildFlow(config, ledger, new Set(flowClaims.keys()))` —— 和渲染层**同一个函数**。
早先两处各算一套，结果图说 OPS-022 能开工、API 说 FEAT-014，测试专门盯着这条（`flow-api-test` 第 8 节）。

### 4.2 领取状态已落盘（D22 已做，2026-11-17）

```js
// serve.mjs —— flow-claims.json 落在每块看板自己的目录
const claimsPath = resolve(argValue("claims") || join(ROOT, "flow-claims.json"));
```

- 每次 `claim` / `release` 都写回 `flow-claims.json`（临时文件 + 原子改名，不落半截）。
- 启动时若有文件就加载；文件损坏按空状态启动，不被卡死。
- `--claims <文件>` 可覆盖路径，测试用它指向临时文件隔离。
- 顺带修了一个隐藏 bug：**已执行中的件不能再 claim**（即便同一个人点重了也不行），
  否则会静默覆盖持有者。`target.state === "running"` 时回 409。

**测试**：`flow-api-test.mjs` 加了第 [9] 节——领 OPS-024 后**重启服务**，
断言它仍是 `agent-B / 重构` running、跨重启互斥仍生效；第 [10] 节验证交还后
落盘文件也清空。全程用临时 claims 文件，不碰真实 `flow-claims.json`。
基线从 25 提到 **32 通过 / 0 失败**。

> ⚠️ 真实看板目录下会出现 `flow-claims.json`（只在有人领过之后）。它是并行状态，
> 属于数据不是代码，别删。测试运行时用的是临时目录，不会污染它。

### 4.3 已知缺陷（下一轮要修）

**没有超时回收**（D15）—— 某台执行者崩了/关机了，他领的活会永久占着
`flow-claims.json` 里那条（现在落盘了，等于永久占着那块地），别人永远领不了。
下一轮要给 claim 记录的 `at` 加「超时」语义：超过 X 分钟没交还，允许他人接管。

> 已经踩过的坑值得记住：`flowClaims` 曾经写在请求处理器**里面**，
> 每个请求都新建一个空 `Map`，于是 claim 返回 `200 {"ok":true}` 但下一次 plan 显示还在 ready。
> **API 报成功、什么都没发生** —— 这是最坏的一种失败。现在状态在模块作用域 + 落盘，已不再有这个问题。

### 4.4 工作台（自动执行，2026-11-17 已完成）

让「看图 → 手动点领」升级成「**拖卡** → 分析 → 选择串行/并行 → 自动逐张交给 Harness 处理」。
在工作流视图页签下方多了一块 `.workbench`。

**用户流程**：候选人池（来自 `/api/flow/plan` 的 ready + waiting + running）**拖动卡片
排出执行顺序**（上面先做，每张可点 ✕ 移出，底部可一键全部加入）→
「分析」调 serve 纯计算得到串行/并行两种建议（铺成步骤区）→ 选模式 →
「开始执行」→ 驱动器逐张/逐路 `claim → 交给 Harness → 收口 → release`，步骤区每张标 done/asking/wait。
「停止」发停请求，当前卡跑完即停。
- **串行**（analyze 后单列直排）：步骤区单列出执行顺序，同区域链序由 analyze 兜底拨正。
- **并行 = 多路队列**（analyze 后横排成列）：步骤区按区域前缀横排成多列 `.wb-lane`（`WB.lanes`），
  每列一路、纵向上到下列出该路整条链；不同路可同时推进（同一区域仍互斥，由 claim 保证）。
- **并行每路一条独立对话**：执行时 `workbenchAsk(itemTitle, done, convKey)` 第三参传
  `wbConvKey(id)`（=「路N · 前缀」），同一路的卡共用同一会话键 → 左侧 Harness 会话列表
  一条路一条对话；非并行（convKey 空）每张卡各一个会话，仍按卡 id 圈定。

**拖拽语义（重要）**：池不再用勾选，改成一张**可拖拽排序的队列**（`WB.dragPool`，
顺序即用户要的执行顺序）。分析时把该顺序作为 `order` 提交给服务端；
服务端 `planWorkbench(config, ledger, ids, order)` **在同区域仍保持链序**的前提下采纳拖动顺序
（同块地不能跳着做 —— 即使把后件拖到前件前面，也会被拨回链序），跨区域则完全尊重拖动顺序。

**关键文件**：
- `scripts\lib\workbench.mjs`（纯计算）—— `planWorkbench(config, ledger, selected, order?)`：
  传入 `order` 走 `serialByDrag`（按拖动顺序 + 同区链序兜底）；不传回落 `serialAuto`（旧分块）。
  串行=同区域成链、并行=分轮（同一轮无同前缀，互斥不踩）。和 `flow.mjs` 用同一个 `areaPrefix` 判据。
- `scripts\serve.mjs` —— `POST /api/workbench/analyze` 接受 `{ids, order?}`；并把
  `/ops-board/b/<id>/api/*` 前缀剥成 `/api/*`（浏览器裸开和 Harness 里共用一套路由）。
- `scripts\lib\client.js` —— 工作台驱动器 `WB` + `workbenchPump`：claim→ask→release；并行按 cap
  同时放多件；409 做**有上限重试**（等前件收口落盘）；`WB.execOrder` 记执行顺序。
  `renderWorkbenchPool` 铺可拖拽卡片（HTML5 `dragstart/dragover/drop` 排序 + ✕ 移出 + 一键加入）。
  ⚠️ `/api/workbench/analyze` 必须走 `wbUrl()`（带 `/ops-board/b/<id>/` 前缀）而不是裸路径
  —— 插件代理不改 XHR，裸路径在 GUI 里 404，按钮点了没反应（2026-11-17 已修）。
- `scripts\lib\css.mjs` —— `.workbench*` / `.wb-*` 样式（候选池、`wb-pick-grip` 拖把、
  `wb-dragging` / `wb-drop-target` 拖拽态、`wb-pick-x` 移出钮、`wb-pool-foot`）。

**⚠️ 关键语义（最容易翻车）**：`flow.mjs` 里一张卡要真的**收口**（状态离开未收口集合）
同区域下一件才顶上，`release` 只是把占用还给系统。所以工作台交给 Harness 的 prompt 会要求
「处理并**更新台账**（收口/推进状态）」；若 Harness 只分析不改台账，串行链会停在第一件（这是对的）。
测试里的 answer stub 会真的改 `ledger.json` 才让链往下走。

**2026-11-17 修「串行卡死在第一件 + 对话窗空」**：
- 根因一：`workbenchAsk` 的 prompt 只让 AI「给建议」，从不「动手改台账」→ 卡永远不收口 →
  同区域下一件无限 409 重试（那串「还没就绪/稍后重试」）。已改成**真实执行 prompt**：
  明确要求读 `ledger.json` + `board.config.json`，按车道 stages 取收口状态（bug→fixed/closed、
  feature→shipped、risk→resolved/accepted）把 status 改成它，或至少推进。
- 根因二：`serve.mjs` 的 `ensureFresh` 只看台账/配置的新旧重渲染，**不看模板的
  `scripts/lib/client.js`**（它被内联进 index.html）→ 改完前端逻辑页面还是旧的
  （「改了没反应」经典源头，AGENTS 三之六）。已把 `CLIENT_JS` + `RENDER` 加进 freshness 判据。
- 根因三：被残留领取卡死。清理路径：`POST /api/flow/release {id, by}`；没人领会 404。
  若某个进程持有读盘一次就重启（`flow-claims.json` 落盘，重启不丢——好处也是坑：
  进程挂了但 claim 还在，重启同读它）。
- 新增：工作台某张卡回答完会**回读台账核对**（`getLedgerBoard`→`/api/board`）确认状态是否
  真动了 / 收口，并在步骤区与日志里标明「已收口 / 推进 / 未收口」，不再把「拿到回答」当成功。

**2026-11-17 五改（终版）：「工作流」是干净可靠的二维流程连线图**
- 用户要「一块大规划区，卡片自由拖动排流程」，不满意横向单队列。参考 React Flow / LogicFlow 后做了
  二维平面，但初版过度设计（网格点阵背景 + 拖空白平移 + 滚轮缩放 + 固定 520px 视口）出问题被退：
  **卡片被 520px 视口裁掉/看不见、箭头被卡片盖住看不见、网格背景碍眼**。
- 本轮定为**干净可靠的二维流程连线图**，三项痛点全修：
  - **卡片完整显示**：`.flow-canvas` 不再 `absolute;inset:0`（那会被父级 `520px` 锁死把多行卡裁掉），
    改 `position:relative` + 显式 `width/height`（来自 `layoutGraph`），`.flow-canvas-pane` 改
    `overflow:auto`，超高时**纵向滚动看全、不裁剪**（已实测 `clipped:[]`）。
  - **箭头清晰可见**：箭头从「贴行顶」改成「行内卡片垂直中点」（`row.startY + e.y1/y2`，落在卡与卡
    之间 52px 空隙），颜色用 `var(--blue)`，不被卡盖住。
  - **背景干净**：去掉点阵 linear-gradient 网格（`backgroundImage:none`），去掉拖空白平移 + 滚轮缩放
    （这俩在滚动容器里反而碍事）。拖空白处只正常滚动。
- 数据：复用 `flow.mjs` 的 `flow.graph`（`layoutGraph` 已产出每张卡 `{x,y,w,h}` 与 `rows[].edges`
  箭头坐标）；页面一张张按绝对坐标铺在 `.flow-canvas` 平面上，SVG 箭头把串行链连起来
  （行内箭头 = 必须等前面做完；行与行无箭头 = 可同时做，即「并行」）。区域标题浮在每行上方。
- 渲染（`render.mjs` `viewFlow`）：`.flow-canvas-wrap > .flow-canvas-pane`（`overflow:auto`，
  `min-height:240px`）内嵌 `.flow-canvas`（相对定位、显式宽高、绝对定位卡片 + 垫底 `.flow-edge-svg`
  箭头 + 行标题）。底部 `.flow-canvas-controls` 带说明 + 「复原位置」按钮。
- 交互（`client.js` `bindFlowDrag` + `flowDragStart/Move/End`，pointer 自实现，HTML5 DnD 在
  `<a>/<button>` 结构失灵故不用）：
  - **按在可拖卡**（非 `<a>/<button>`、非 claimed）→ 走够 6px 阈值 → 克隆 `.flow-ghost` 跟光标、
    源卡半透明，**自由 2D 位移**：`node.style.left/top = 起点 + 屏幕位移`；
  - 空白处按住走正常滚动（去掉了平移 pan 分支）；滚轮缩放已移除。
  - up/落定后 `flowReadOrder` 读所有可拖卡的 `getBoundingClientRect`，按「上→下、同行左→右」排序 →
    `flowRefreshOrderFromCanvas` 写进 `WB.dragPool` + 刷新工作台候选池；被领走（正在执行）的卡不可拖。
- 语义：同一份 `WB.dragPool` 同时驱动画布空间顺序与工作台执行顺序，二者始终一致；
  同区域链序（同块地不能跳着做）仍由服务端 analyze 兜底，画布规划自由、执行时遵守。
- 样式：`.flow-canvas-pane`（可滚动视口，无网格）+ `.flow-canvas`（相对定位定宽高）+
  `.flow-canvas-card`（绝对定位）+ `.flow-edge-svg` / `.flow-edge`（蓝箭头）+ `.flow-ghost` +
  `.flow-row-label` + `.flow-canvas-controls`。
- 测试：`flow-test.mjs` 改成验「无网格背景 + 卡片不被裁剪 + 空白拖不动 + 坐标铺卡 + 箭头连接 +
  自由 2D 拖卡」（**21/0**，双看板）；`flow-workbench-test.mjs` [5b] 用真实节点坐标大位移拖第一张卡
  越过下方几行、验证坐标顺序变 + `dragPool` 同步 + [5c] analyze 采纳该顺序（**21/0**）。

**2026-11-17 六改（让拖卡真正像「可拖动的流程控制」）**
- 用户指出两个基本功没到位：「卡片被拿起字体异常」「被箭头连着的卡片移动，箭头不跟随」，
  并追问参考了哪个项目。这里明确参考 React Flow：**边每次根据节点新坐标重算**（`getBezierPath`）。
- **箭头跟随**（`client.js` 新增 `flowUpdateEdges(fromId)`）：拖动每一帧，找出所有「以该卡为源或目标」
  的边，用两张卡当前画布坐标重算 `d`（源卡右边缘中点 → 目标卡左边缘中点，bezier 控制点取两端 x 中点）。
  被拿起卡的**入边和出边**都会跟着动；落定/复位不破坏（卡片留新位置、边已实时更新）。
- **幽灵字体修好**（`flowMakeGhost` / `flowUpdateGhost`）：不再 `cloneNode` 真实卡片（克隆会把内联样式/
  外层继承的字体 scale 一起带进 `document.body`，在嵌入环境里易字体走样），改成**独立构造轻量影子**：
  显式写死字体族/字号/宽 188px，只带 id+标题，杜绝级联问题。
- 测试：`flow-test.mjs` 新增 [5c]「拖动卡片 → 箭头实时跟随 + 幽灵字体正常」（验幽灵可见、字号显式、
  宽 188px、被拖卡的入/出边 d 变化）→ **25/0**（双看板）。
- 参考来源：React Flow `BaseEdge.tsx`（`getBezierPath` 按 sourceX/Y、targetX/Y 生成边 d，每帧随节点重算）。

**2026-11-17 七改（按用户反馈调布局 + 加一键清空）**
- 用户四点要求，全部落地：
  1. **去掉「大画布 · 拖卡片排流程」大标题**（`render.mjs` 删掉 `<h1 class="details-title">`，只留 kicker「工作流」）。
  2. **工作台移到第一行**：把 `.workbench` 块挪到 `.flow-canvas-wrap` **之前**（流程页第一个子块，位于
     summary/legend 之后、画布之前），画布在其下方。实测 DOM 子块顺序 `[workbench, flow-canvas-wrap]`。
  3. **工作台一键清空**：`render.mjs` 的 `.workbench-actions` 加 `<button data-wb-clear>清空</button>`；
     `client.js` 新增 `workbenchClear()`（清空 `dragPool`/plan/steps/order、收起步骤区、复位按钮、log），
     在 doc 点击委托里接 `[data-wb-clear]`。正在执行时先 stop 再清。
  4. **拖动时卡片底部字不再显示**：CSS 里 `.flow-canvas-card.flow-drag-src .flow-node-foot,
     .btn-flow-claim{display:none}` —— 被拖走的那张原卡拖动时底部状态文字隐藏；幽灵卡本就只带 id+标题。
- 测试：`flow-test.mjs` 新增 [9]「布局调整」（验无标题、工作台第一行、有清空按钮、拖动时原卡底部隐藏、
  幽灵无 foot）→ **30/0**（双看板）；`flow-workbench-test.mjs` 新增 [5d]「一键清空」→ **23/0**。

**2026-11-17 八改（拖动彻底干净 + 右键选「下一步」）**
- 用户二度反馈「拖动时底部文字还是显示」。DOM 探针确认源卡 foot 已隐藏、幽灵无 foot，但幽灵卡
  标题没限高、把卡片撑到 ~120px（源卡 88px），拖动时底部多出一截 → 视觉上就是「底部有字」。
  修法：`flowMakeGhost` 固定幽灵 `height:88px` + 标题 `-webkit-line-clamp:3` 截断。实测幽灵高回到
  93px（含边框）、标题 3 行截断，底部不再外溢。
- **新增右键选「下一步」**：`client.js` 加 `flowContextMenu`（document contextmenu）、`flowMenuClose`、
  `flowPickNext`、`flowCloseMenuOnAway`；`bindFlowDrag` 里注册 contextmenu + 点击别处/滚动关菜单；
  CSS 加 `.flow-menu*` 浮动菜单样式。右键一张未领的卡 → 弹菜单列出画布上其余未领卡（**不依赖异步
  WB.candidate，用画布 DOM 现取**，离线/要点开就能用）→ 点选后把那张卡 `splice` 到右键卡**紧后一位**
  并刷新 `WB.dragPool` 与候选池。右键卡不在队列时会先用画布当前顺序重建再插入。
- 测试：`flow-test.mjs` [5c] 补幽灵高度断言；新增 [9b]「右键弹菜单 + 选下一步 + 排到它之后」
  → **35/0**（cyber）、**33/0**（practise 有跳过的）。

**2026-11-17 九改（彻底根治「拖动显示原文」+「卡片文字只显示一半」）**
- 用户又反馈「卡片的文字只显示了一半;拖动的时候底部还是显示原文,不要显示」。这次的真正根因
  不再是 foot:DOM 探针逐元素取证后发现,
  - **卡片文字只显示一半** = 卡片固定高 `88px` + `overflow:hidden` + flex 收缩,当
    id+标题+foot 内容总和超过 88 时,flex 把标题**压缩成条** → 看起来「只显示一半」。
    修法:卡片改 `height:auto;min-height:88px`,去掉 `overflow:hidden`;
    `.flow-node-title` 去 `-webkit-line-clamp:3`、设 `flex:0 0 auto` + `white-space:normal`,
    标题再长也完整展示、卡片随内容撑高。
  - **拖动时底部显示原文** = 幽灵卡带了**标题文本**,松开时原卡标题也还半残地露着。
    这次下狠手:幽灵卡**去掉标题、只留 id**,`height/min-height:56px` 的干净小卡;
    拖动中的**原卡**标题 `visibility:hidden`、foot/按钮隐藏(id 半透明),拖动时整片只看到一个
    带 id 的简洁影子,不再有任何原文。
  - **还顺带修掉一个隐患**:幽灵标题用内联字符串拼 style,而字体族含双引号会**截断整个 style
    属性**(实测 `style="font-family:"` 就断了,后面 nowrap 全变垃圾属性)。现全改 style 属性逐个
    赋值 + textContent,不再内联拼串。
- 测试:`flow-test.mjs` [5c] 幽灵断言改为「id-only、无标题、高 40–70」;[9] 增 `srcTitleHidden`/
  `ghostHasTitle`;→ **39/0**（cyber）、**39/0**（practise）。

**2026-11-17 十改（执行引擎重构：看板分批 → 整批交给单个 Agent 自主规划）**
- 用户定调:主要目的不是好看的流程卡片,而是「**在看板里设好任务链 → 交给 Agent 自主解决**」;
  卡片拖动只是表现形式。且要求**整体参考一个成熟成品**,而不是零敲碎打。
- 我参考了任务编排类成品的执行引擎(先研究 n8n 的 `execution-engine/workflow-execute.ts` 架构,
  再结合你的选择定形)。经几轮确认你的偏好是:
  - **不是引擎拓扑自动分流**(n8n 编排器那种),而是「**Agent 自主**:整链交给单个 Agent 自己规划」;
  - **批次由「看板定」**(你手动把可并行的一组划成一批),**不是服务端自动拆**串/并行;
  - **单次 ask 携整批清单**,claim 仍逐张(保留互斥防撞车),每张完成回读台账更新看板。
- 落地(纯执行引擎层,拖动/箭头 UI 不动):
  - `workbench.mjs` 新增 `planBatches(config, ledger, batches)`:**按看板手动分批**返回每批卡元数据,
    不再产出 serial/parallel 自动建议;
  - `serve.mjs` `/api/workbench/analyze` 收到 `batches` 就走分批,否则回落旧逻辑;
  - `render.mjs` 工作台新增「分批(每批 N 张 / 整批全交)」下拉;
  - `client.js`:`workbenchAnalyze` 按批分组铺步骤区(batch=带虚线框的分组)——
    执行改为 `pumpBatch` 逐批:claim 完整批 → **一次 ask 携带整批卡清单**
    (id+标题+台账路径+收口要求,由 Agent 自主决定批内顺序/是否并发)→ release 全部 → 下一批;
    `workbenchStartBatches`/`finishBatch`/`releaseAll` 处理整批收尾;
  - `workbenchRefreshModeBtn` 现在也随队列非空启用「分析」(清空后重加卡可再分析)。
- 说明:execute 提示词把「这一批的整张清单」交给 Agent,让它自主规划批内先做哪个/哪个可并行;
  批次间仍是串行。若想整批一个 Agent 全跑,选「整批全交」。
- 测试:flow-workbench-test 增 [5e](每批 3 张→3 批/卡总数 7/标分批执行)[5f](整批全交→1 批/含全部 7 卡)
  [5g](**整批真实执行**:5 张不同区域头件整批全交 → claim 全部→**一次 ask 带整批清单**→release→全 done)
  [5h](**断言 ask 的 question 确实携带「本批卡片清单」**)→ **33/0**;flow-test 39/0 ×2;verify 双板通过。
- ⚠️ **分批 claim 受「同区域串行约束」**:serve 只放行「当前该区域可开工」的卡;若用户把同区域
  未收口的后续卡也塞进同一批,该卡会 409 claim 不到而滞留(反复重试)。真实运行时 Agent 会真的
  收口卡、解锁同区域后续卡所以能继续;测试用「不同区域头件」构造了一批全可开工的场景,绕过假撞车。

**2026-11-18 十一改（删三格统计 + 拖动手感重构：抓起卡=带标题的醒目浮卡）**
- 用户反馈:「5未收口 / 4能同时干 / 1得排队等 这些不要; 卡片拖动效果还是很烂」。
  - **删三格统计** = `render.mjs` `viewFlow` 去掉 `.flow-summary` 三格块(kicker 后直接进图例);
    `css.mjs` 删掉 `.flow-summary*` 7 条规则 + `@media` 里的 `.flow-summary`——否则 verify 8b 孤儿样式报错。
  - **拖动手感重构** = 老实现是「原卡 opacity:.5 + 一个 id-only 的小幽灵」,反馈弱、看不清抓的是哪张。
    改为:拖动时**原卡淡出让位**(`opacity:.32`+`grayscale(.8)`+去阴影),焦点移到**带标题原文、稍放大
    (`scale 1.03`)、深阴影、蓝描边的「抓手」浮卡**(id 大字 + 标题,一眼看清抓的是哪张);
    `flowMakeGhost` 重写(带标题、宽=原卡+6、不再固定 56 高)。
- **单卡落点只重排「那一张」**:旧 `flowRefreshOrderFromCanvas(apply)` 拖动落点为**重排整池**(按画布坐标
  全部重算),用户「不知道怎么排的」。改为传 `fromId` 时**只把被拖的这张卡**按它在画布上的站位插入
  原池对应位置,其它卡顺序完全不动;日志明确「已排到第 N 位」;`flowCanvasRank` 数被拖卡的站位数。
  (复位/平移仍走整池重排。)
- 测试:`flow-test.mjs` [5c]/[9b] 幽灵/抓手断言从「id-only」改为「带标题原文」;
  **flow-workbench-test 改成数据驱动**——不再写死「7 张/2 排队」,实时读 `/api/flow/plan` 的
  `total`/`queued` 推导期望(看板卡数会随真实收口变化);[4] 串行链、[5] analyze 的 ids、[5e]/[5f]/
  [5g] 批次数/卡数全部改为实时推导;[5g] 头件从实时 plan 的 ready 里取(不再写死 OPS-022/RISK-002)。
  → flow-test **36/0** ×2;workbench **33/0**;verify 双板通过(无孤儿样式)。
- ⚠️ **cyber 看板实际收口 61→56(剩 5 未收口)**:OPS-022、RISK-002 两张已于 2026-11-17 被真实工作
  收口(带完整证据)。这是**看板数据随真实工作变化**,不是 bug;测试之前写死 7 才会误报,现已数据驱动。

**2026-11-18 十二改（画布 ↔ 工作台顺序双向同步 + 去行标题 + 右键箭头**）
- 用户反馈:「右键选下一步,点了之后没有箭头指向那张卡」、「画布上有标题不要」、「工作台分析出的顺序
  画布没同步,希望能按分析顺序在画布上排出来,再在画布上调顺序」。
- **画布顺序 = 工作台顺序**(核心):新增 `flowReorderCanvas(leadingIds)` —— 把画布上所有未领卡按
  `WB.dragPool`(工作台队列)重排成一列(上→下 = 执行顺序),未在队列的卡按视觉顺序接在后面;
  再 `flowDrawOrderEdges(order)` 按相邻顺序重画箭头(order[i] → order[i+1],向下指向下一张)。
  调用时机:
  - **`workbenchAnalyze` 成功**后 → 画布按这次分析出的 `WB.order` 重排(画布立即反映分析顺序);
  - **`flowPickNext`(右键选下一步)** 后 → 画布重排,箭头立刻指向被选为下一步的那张卡;
  - **拖卡落定**(`flowDragEnd`)→ 保守只重画顺序箭头(不改坐标,保留自由摆放),使箭头跟随最新顺序;
    顺序仍写回 `WB.dragPool`(既有 `flowCanvasRank` 逻辑)。
- **去掉画布行标题**:`render.mjs` 删除 `.flow-row-label` 那行标签(区域名「免费额度 · 串行」等);
  `css.mjs` 删除 `.flow-row-label/-name/-tag/-lanes` 规则(否则 verify 8b 孤儿样式报错)。
- **新建辅助**:`flowFullOrder()`(dragPool 前导 + 视觉顺序接尾)、`flowNodeBox()`、`flowDrawOrderEdges()`。
- 测试:
  - `flow-test.mjs` [9b] 增断言「画布出现指向所选手卡的顺序箭头」(`.flow-edge[data-edge-from=anchor][data-edge-to=next]`);
  - `flow-workbench-test.mjs` [5c] 增断言「analyze 后画布按 analyze 顺序重排(前几段与步骤区一致)」;
  - → flow-test cyber **36/0**、practise **37/0**(多 1 条箭头断言);workbench **34/0**;verify 双板通过(无孤儿)。
- ⚠️ 画布初始仍是 `layoutGraph` 的区域自动排版(带依赖箭头);**点一次「分析」后**才切到执行顺序列。
  想回到初始布局点「复原位置」(`flowResetView` 走 apply=false 按画布视觉重排,不顺带改 dragPool 顺序)。

**2026-11-18 十五改（画布上下分区：队列在上横向排 + 未排队卡进底部「备选」区）**
- 用户反馈:「明明没参与任务列的卡片为什么还会出现在画板上…应该在底部是备选状态,横着展示」
  「现在队列都是竖排序很难受,你最好改成横的排序」。用户确认:画布上下分区 + 队列横排。
- **改法**:
  - **画布分区**:`flowReorderCanvas`/`flowLayoutCards` 改成两段——①上面「队列区」= dragPool 里的卡
    (含正在执行的 claimed)按横排从左到右铺,卡之间画「右缘→下一张左缘」执行箭头;②下面「备选区」=
    画布上但没进队列、也没在执行的卡,横排铺开,标 `.flow-node-standby`(虚线边/淡背景)。备选不连箭头。
  - **分区重排触发时机**:工作台候选池加载后、移出/加入队列、全部加入时调 `flowReorderCanvas()` 重排;
    不动用户正在进行的自由拖动(拖动仍是纯摆放)。
  - **工作台队列横排**:`.wb-pick` 从竖排改横排卡片(固定宽、flex 换行);`renderWorkbenchPool` 分两组——
    「执行队列」(可拖排序、✕ 移出)+「备选」(虚线框空白选卡,点一下加入队列;底部保留「全部加入」按钮)。
  - 移出队列的卡 → 进画布备选区(不丢,可随时加回);清空 → 卡全部保留在备选区。
- 测试:`flow-test` 新增 [10](移出队列的卡变 `.flow-node-standby` 且在下方备选区、队列卡横向 left 递增)
  ——cyber/practise 各 **43/0**;`flow-workbench-test` [2](✕ 移出进备选区)、[5d](清空后保留在备选)
  **35/0**;verify 双板通过,无孤儿样式。
- 用户反馈:「右键选下一步时,画布又调成了垂直顺序,别动我的存放位置」「已经在任务队列里的卡,就不要作为可选选项」。
- **改法**:
  - **右键「下一步」只更新执行顺序 + 重画箭头,不再重排画布位置**:`flowPickNext` 不再调 `flowReorderCanvas`
    (那会把所有卡按执行顺序重排成一排/一列,覆盖用户手动 2D 摆放)。改成只把 nextId 插进 `WB.dragPool`
    anchor 之后,并 `flowDrawOrderEdges` 画「右缘→下一张左缘」箭头指向所选卡。卡片位置全都不动。
  - **analyze 后同样不改卡的位置**:`workbenchAnalyze` 里把 `flowReorderCanvas(analyzedIds)` 换成「更新
    dragPool 顺序 + flowDrawOrderEdges」,只排箭头、不动卡片。卡怎么摆用户说了算,箭头反映顺序即可。
  - **候选过滤掉已在队列的卡**:`flowContextMenu` 的候选列表排除 `WB.dragPool` 里已有的卡(含正在执行的
    claimed 卡)。已经在任务队列里的卡不再作为「下一步」可选项弹出。
- 测试:`flow-test` [9b] 改为——清空队列到只剩锚点 → 右键弹菜单,断言 ①候选不含队列里已有的卡、
  ②选「下一步」后卡片位置不动、③画布出现指向所选手卡的箭头。cyber **40/0**、practise **40/0**;
  `flow-workbench-test` [5c] 改断言为「analyze 后箭头指向工作台下一步(不改卡位置)」,**34/0**;verify 双板通过。

**2026-11-18 十六改（去掉可拖动流程画布 → 工作流页 = 工作台；并行改「横排多路队列 + 每路一条独立对话」）**
- 用户原话:「画板不要了,但我觉得现在这个队列展示形式不错,但是我想看到他的并行怎么展示」。确认两点:
  ①**完全去掉画布**——工作流页不再有可拖动的二维流程连线图(拖动自由摆放/右缘→左缘箭头/右键下一步/区域
  上下分区等画布专属行为随之消失);②**并行 = 横排多路队列,执行时每路各开一个独立 Harness 会话**。
- **删画布**(`render.mjs` `viewFlow`):删掉 `flow.graph` 的排版(cardHtml/edgeHtml/edgeSvgHtml/byPrefix/G/
  canvasHtml/flow-legend),模板只留 kicker「工作流」+ `.workbench`(候选池 + 分析 + `.data-wb-run`)。
  `client.js` 里残留的 `flowReorderCanvas`/`flowLayoutCards`/`flowDrawOrderEdges`/`bindFlowDrag`
  因 `#flowCanv` 节点不存在,调用被 try/catch + `wbPresent()` 兜成 no-op(不崩,成死代码)。
- **并行 = 多路队列**(`workbenchAnalyze` 并行分支):不再按 round 单列直排带「第N轮」tag,而是把 order 按
  区域前缀归组成 `WB.lanes`,`stepsEl` 渲染 `<div class="wb-lanes">` 横排多列 `.wb-lane`(每列一路、头标
  「路N · 前缀」、纵向 `.wb-lane-cards` 依次排该路整条链)。CSS 新加 `.wb-lanes`/`.wb-lane`/`.wb-lane-cards`
  (横排 `flex; overflow-x auto`,路内纵排)。串行分支保持单列直排。
- **并行每路一条独立对话**(`client.js`):新增 `wbConvKey(id)`——并行时返回该卡所属路「路N · 前缀」;
  `workbenchAsk(itemTitle, done, convKey)` 第三参传它,`convTitle = convKey || itemTitle` 作为会话键(item)
  → 同一路的卡共用同一会话键 → 左侧 Harness 会话列表一条路一条对话;prompt 正文仍引用真实卡 id(cleanId)。
  非并行 convKey 空 → 每张卡各一个会话(按卡 id 圈定,现网已按 item 作用域)。
- 测试重排:完整删掉画布交互的 flow-test 段,`flow-test.mjs` 重写成「壳验」——画布已去(`#flowCanv`/canvas-wrap 不存在)+
  工作台在 + 候选池有卡(file:// 无后端则跳过池/路断言,深度交给 workbench 覆盖)→ **4/0** 双板;
  `flow-workbench-test` 新增并行拆路断言(seed 跨区域 pool → analyze → 断言 `.wb-lane` ≥2 路,每路每卡只属一路),
  [5b] 改「队列序 = dragPool 序」、[5c] 改「并行铺多路」、删画布 edge 断言 → **33/0** 双板;verify 双板通过。
- 方式:改 `render.mjs`/`lib/client.js`/`lib/css.mjs` 后 `node scripts/render.mjs --board "<dir>"` 重渲染
  cyber/practise 双板 → dist 内联最新 client.js(substring 校验) → flow-test + workbench + verify 全绿。
- **复盘修正（并行形态 + 拖拽 bug）**：
  - **队列只能往前拖、不能往后拖是 bug**：`bindWbDrag` 的 `drop` 原来一律 `splice` 到目标**前**，
    往后拖（源在目标前）会插错位。改成按相对原位置判定 —— 源在目标**前**（往后拖）→ 插目标**后**；
    源在目标**后**（往前拖）→ 插目标**前**。workbench-test [2b] 补「前/后都能拖」双向断言。
  - **并行展示重做**：去掉顶部「并行执行 · 最多同时 N 路」说明文字模块——并行时对 `[data-wb-run]`
    加 `wb-run-parallel`，CSS `.wb-run-parallel .workbench-run-head{display:none}`（按钮仍保留，只藏说明行）。
    并行队列**一路一行**：`.wb-lane` 成一横行（左侧 `.wb-lane-name` 前缀名 + 右侧 `.wb-lane-cards` 横排
    卡，`.wb-lane-cards{display:flex;flex-wrap:wrap}`，卡上只留序号+id+标题，去掉 why），多路纵向叠放
    （`.wb-lanes{display:block}`）。串行分支仍单列直排带 why。
  - 并行横排卡上的 `.wb-lane-cards .wb-step` 去掉竖排左缘线、改卡片式圆角。
- **再修正（分批 = 并行下的开关，不再与串/并行平级）**：
  - 用户觉「分成串行/并行/分批三个平级选项」很容易混。实际实现里分批本就叠加在并行上
    （代码 `WB.mode="parallel"`），是界面假象造成平级冲突。
  - **界面**：分批下拉框收进「并行」档——CSS 用
    `.workbench-controls:has(input[name=wb-mode][value=parallel]:checked) .workbench-batch{...}`
    让**只有选「并行」时才显示**分批，串行时整块隐藏；文案改名「再打包交给 Agent 自主」，首项「不分批（一路一张挨着领）」。
  - **逻辑**：`workbenchAnalyze` 的 `useBatches` 与 `workbenchStart` 的批次判断都加 `viewMode==="parallel"` 前置，
    串行下即便 `WB.batchSize>1` 也不再走分批，彻底杜绝叠用。
  - 测试：[5e] 新增「串行时分批开关 display=none / 并行时 display=flex」双断言；workbench **39/0** 双板。
- **再修正（初始状态 + 分批文案）**：
  - 用户嫌「执行队列一开始就是满的、备选反而不显示」。初始铺卡改为**执行队列空、所有卡都在备选区**
    （`workbenchRefresh` 首跑 `WB.dragPool=[]`），用户自己点/拖把想做的加进队列。
    **正在执行（running）的卡也在备选区展示**（带「某某 正在做」，无 `data-wb-add` 不可点加入，只作占用提示）。
    空队列显「尚未排卡」。
  - 「再打包交给 Agent 自主」太抽象，改**「一次喂几张给 Agent 自主处理」**，选项直白：不分批（一张一张来）/
    每批 2 / 3 / 5 张 / 整批全交（一次全给它）。
  - 测试：[2] 重写为「初始队列空 + 全在备选 → 全部加入 → 可拖拽 + 排队标记」；workbench **42/0** 双板。
- **再修正（池子高度 + 点卡撤回 + running 占用说明）**：
  - `workbench-pool` 高度 280px → **440px**，`.wb-pick` 卡加 `min-height:74px`，展示更舒展。
  - **点执行队列卡本体即撤回备选**：队列卡绑 click（跳过 ✕/拖把/刚拖过）→ 从 `WB.dragPool` 移除回备选；
    组标题改「执行队列（点卡片撤回备选 / 拖动排序）」。备选卡点一下加入本来就支持。
  - `win-jskt98 正在做`（running）卡**为什么不能选**：它已被另一个会话/工作台领走在处理，
    加进你的队列没有意义（会重复抢卡、收口互相覆盖）；系统只把它当占用提示，release 回 ready 后自动可选。
  - 测试：[2c]「点击队列卡本体 → 撤回备选区」；workbench **43/0** 双板。
- **再修正（改名 + running 状态可读）**：
  - 「执行队列」组标题 → **「待执行队列（点卡片撤回备选 / 拖动排序）」**。
  - running 卡的状态从「· win-jskt98 正在做」改成**「处理中（win-jskt98 在用）」**黄色状态戳
    （`.wb-state-tag`），卡片整体置灰（`.wb-occupied` 淡背景 + 标题变 muted），直观表明：被人领走
    在处理的卡不可加入，处理完自动回到可选备选。悬停有完整说明。
  - **标签溢出修复**：`.wb-state-tag` 原 `white-space:nowrap` + `.wb-pick-foot` 单行 flex →
    一起撑破 168px 卡片；改 `.wb-pick-foot{flex-wrap:wrap}`、标签 `white-space:normal;max-width:100%;
    flex:1 1 auto;min-width:0`，长状态文字在卡内换行不再溢出。
  - **假占用排查（「win-jskt98 正在做，没人做他」）**：cyber 板 `flow-claims.json` 有 3 条 2026-11-17
    15:08 的残留 claim（OPS-022/OPS-024/RISK-002，全 by win-jskt98），无人在做却显示处理中——
    正是「进程挂了 claim 还在，重启同读它」老坑。已备份
    `flow-claims.backup-20261118.json` 后**清空 claims**，`/api/flow/plan` 验证 running=0、total=5，
    卡恢复可选。⚠️ 待用户确认：是否要加「claim 超时自动过期」机制防复发（涉及真实长任务误过期风险）。
- **再修正（总览「需求一览」→ 收口页第一个模块「已解决」）**（2026-11-18 用户定）：
  - 总览页删掉「需求一览」模块（`viewOverview` 的 `restLanes` 排除 feature 车道），总览只留待处理问题/待处理风险/处理记录。
    > ⚠️ **此条已被「二十改」覆盖**：待处理问题/风险也搬去了各自车道页，**总览现在只剩工作台 + 处理记录**。
    > 上面这句只反映 2026-11-18 当时的状态，别按它去总览找表。
  - 收口页（已修复 / 已关闭 / 暂停）**第一个模块**新增「已解决」：只列 feature 车道的收口条目
    （已上线/暂停等 `open:false` 阶段，`isClosedLaneItem`），卡片折叠态；原「需求 · 已收口」分组不再重复列。
    空收口页不显示该模块。已确认：只列已收口的 FEAT，总览不再有它。
  - 验证：cyber「已解决（已上线 22 · 暂停 2 · 共 24 项）」第一模块；practise 收口页原为空、模块不出现；
    `需求一览` 双板残留 0。全部门禁仍绿（workbench 43/0、flow-test 4/0、verify、card-fold 16/12）。
- **再修正（底部空白收敛）**（2026-11-18 用户：底部有空白，要向顶部一样处理 → 选「只收敛空白」）：
  - 实测：内容底 9178px，`.page` 底 9208px（底部 padding 30px）+ 页面外 margin 28px，滚到底悬空 58px。
  - `.page` 改 `padding:24px 42px 24px`（顶/底对称）、`margin:0 auto 12px`（只给阴影呼吸）。
    收敛后内容底 9178 → 页面底 9202、页外 12px，与顶部对称不再悬空。全部门禁仍绿。
- **工作台搬到总览页顶部**（2026-11-18 用户要求，先看效果；「工作流」页暂时保留，满意后再删）：
  - 用户原话：「我想把工作流的工作流移动到总览页看看效果」→ 追问后确认「**先保留工作流页面，我满意了再去掉这页**」。
  - 关键约束：工作台带运行状态（`WB.run`/`order`/执行进度），**不能两页各渲染一份**——
    `querySelector('[data-workbench]')` 会取到先出现的那份，另一份成永远不动的死壳。
  - 做法：**单实例 + 按视图搬移**
    1. `render.mjs`：工作台抽成 `workbenchBlock()`；新增 `wbMount()` 输出 `<div class="wb-mount" data-wb-mount></div>` 空位；
       总览页（顶部，`.main-col` 第一个）与工作流页都留挂载点；`buildHtml` 里把工作台**只注入第一个挂载点**。
    2. `client.js`：新增 `mountWorkbench(viewEl)`，在 `show()` 切视图时把工作台 `appendChild` 到当前视图的挂载点
       （同一 DOM 节点搬家，事件与状态都不丢）。没有挂载点的页（问题页/Skill 页）把它收进 `#wb-park` 隐藏暂存区。
  - ⚠️ **踩过的坑**：一开始「没有挂载点就从文档里 removeChild」，结果切回来 `querySelector` 找不到节点，工作台再也挂不上
    （wb-mount-test 第 4 项连挂 2 条）。**收起来必须是移入隐藏容器，不能从 DOM 摘掉**。
  - 测试：新增 `wb-mount-test.mjs`（10 项：单实例/搬移/收起/回来+状态保留）、`wb-overview-live-test.mjs`
    （8 项，带真实后端：总览页铺候选池 5 张、并行分析 4 路、切页结果不丢）；
    `flow-test.mjs` 同步改语义（画布已去 + 挂载点存在 + 从总览进入时工作台在总览）→ 8/0。
  - CSS：`.wb-mount` 三条规则（`display:block` / `:empty` 隐藏 / `>.workbench{margin-top:0}` 防双份留白）——
    **不加会被 verify-board 判「class 没有 CSS 规则」**。
  - 全量门禁：workbench 47/0 双板 · flow-test 8/0 · verify-board 双板通过 · card-fold 16/12。

- **再修正（新增功能页去掉「提审中」阶段）**（2026-11-18 用户定）：
  - 两板 `board.config.json` 的 feature lane `stages` 删掉 `key:"review"`（提审中）阶段，
    并同步删 `statusLabels.review`；`open` 状态集合里保留 "review" 无妨（通用列表，当前无卡用）。
  - 已查：两板 feature 卡 0 张处于 review，删除无卡片无处安放。
  - 验证：cyber 新增功能页 stage-board「0 计划中 / 1 开发中 / 22 已上线 / 2 暂停」无提审中；
    practise 同无。cyber dist 残留的「提审中」31 处全部来自处理记录 history 的历史文本（10-27 记录原文），
    不是阶段模块，不动。全部门禁仍绿。
- **再修正（「每批 1 张」执行时仍出现两张）**（2026-11-18 用户报）：
  - 现象：并行模式默认选「不分批（一张一张来）」，执行时队列里同时出现两张。
  - 根因：`useBatches = parallel && (batchMode || batchSize>1)` 里 batchSize=1 被判成
    「不分批」→ 走旧并行 `workbenchPump`，其 cap=maxParallel（默认 3）→ 同时放多张。
    两个方案经 ask_user 确认：**保持多行队列显示 + 执行限速**；选 1 = 一次只 1 张在跑。
  - 修复：
    1. `workbenchPump` cap 改读 batchSize：并行 + 每批 1 张（含默认/未设）→ cap=1；
       并行 + 每批 >1 / 整批 → 不进这里（workbenchStart 走分批）。
    2. render.mjs 选项文案「不分批（一张一张来）」→「每批 1 张（一张一张来）」，消除「不分批」歧义。
    3. 分批粒度 change 日志：v=1 时写「每批 1 张（一张一张来，同时只在跑一张）」。
  - 新增测试 [5i]（flow-workbench-test 43→47）：并行+批1 走真实执行（claim→ask→release，
    拦 /ops-board/ask 回 answer），采样每次 ask 时 active/inflight 数，断言 max ≤ 1 且全部卡走完
    （至少 2 张可开工卡）。双板 47/0。

**2026-11-18 十七改（删掉「工作流」页 + 执行/接口测试改为数据驱动）**
- 用户原话：「工作流页可以去掉」。触发条件是上一轮那句「先保留工作流页面，我满意了再去掉这页」——
  **用户看满意了，所以现在删**。
- **删页面**（`render.mjs`）：删掉整个 `viewFlow()`，删掉 `buildHtml` 里 `if (v.kind === "flow")` 分支
  （未知 kind 一律 `return ""`），删掉只给它用的 `import { buildFlow }`。**`wbMount()` 保留** ——
  单实例工作台的挂载机制不依赖工作流页。
- **删配置**：两块 `board.config.json` 的 `views` 去掉 `flow` 项
  → `overview / lane:feature / lane:bug / lane:risk / closed / skills`（6 个视图）。
  备份 `board.config.json.bak-rmflow-20261118-193145`。
- ⚠️ **顺手堵掉一个白屏隐患**：老用户 localStorage / 书签里存着 `#view-flow`，页面删了之后
  `route()` 找不到这个视图 → 整页空白。改法：`show()` 本来就有返回值，`route()` 里
  `if (!show(raw.slice(5), true)) { forgetRoute(); show("overview"); }`；`forgetRoute()` 顺手把
  localStorage 里的坏落点删掉，避免每次刷新都读一遍。`stale-route-test`（3/0）专门盯这条。
- **测试处置**：
  - `flow-test.mjs` 改语义：**工作流页已删**（DOM 里没有 `[data-view=flow]`、导航没「工作流」、
    设置里没 flow 选项）+ 无 `#flowCanv` + 旧 hash 落回总览 + 工作台在总览且单实例 → **11/0** 双板。
  - **删掉 `flow-e2e-test.mjs`**：它点的是 `[data-flow-claim]`「领这件」按钮——那是画布才有的东西，
    画布十六改就删了，这个脚本从那时起就是死的（实测 0 个按钮，随后在 `running[0].by` 崩掉）。
    它唯一独有的覆盖（点按钮 → 真领取 → 后端记录）已由 `flow-workbench-run-test`（真实 UI 路径
    跑通 claim→ask→release）和 `flow-workbench-test` `[5g]`（批内 claim→ask→release）承担。
  - **重写 `flow-api-test.mjs`（32 项写死 → 33 项数据驱动）**：旧版把台账当时的快照当契约
    （「未收口 7 件」「能并行 5 路」「OPS-022 可开工」「排队 2 件」），台账一推进就有 20 条红 ——
    **红的不是代码，是测试把数据当成了规格**。新版先 `GET /api/flow/plan` 读出「谁是头 / 谁在排队」，
    再用这份实时结果去验**不随数据变化的语义**：plan 内部自洽（total = 可开工 + 排队、
    parallelNow = ready 数、同区至多一个头、排队指向同区紧邻前驱）→ 领取 → 同区互斥（含排队件被拒）
    → 跨区并行 → 交还只认领取人 → 重启落盘（D22）→ 交还后落盘清空。当前 33/0。
  - ⚠️ 教训（写进 5.3）：**接口测试要验「关系」，不要验「当时的数字」**。数字属于台账，台账会变。
- 全量门禁：verify-board 双板通过 · flow-test 11/0 ×2 · flow-workbench-test 57/0 ×2 ·
  flow-workbench-run-test 10/0 · flow-api-test 33/0 · wb-mount-test 12/0 ·
  wb-overview-live-test 11/0 · stale-route-test 3/0 · card-fold 16/0 & 12/0。
- 产物：cyber **910.2 KB / 61 卡 / 6 视图**、practise **412.9 KB / 11 卡 / 6 视图**（十八改后涨到 912.3 / 415.0）。

**2026-11-18 十八改（并行队列里的「排队卡」显式标出来 + 删诊断脚本）**
- 用户反馈两件事：①「`diag-flow-drag.mjs` 删掉」；②「每批 1 张（一张一张来）但是有的队列里
  会出现两个任务」。②是我追了好几轮的那个「不分批」抱怨的**真正落点**，终于定位了。
- **先取证再改**：写临时探针（真后端 + 真 Edge）实测「并行 + 每批 1 张」分析后的形状 ——
  得出 4 条路：数据源 1 张 / 云环境 1 张 / 重构 1 张 / **免费额度 2 张**（`OPS-025` + `FEAT-014`）。
  **执行侧 cap 确实是 1**（`workbenchPump` 里 `cap = 1`，`[5i]` 断言 maxActive ≤ 1 早已通过）。
  → 所以问题**不在执行，在显示**：同路第二张和正在跑的头一张长得一模一样，
  用户看到「一条队列里有两个任务」，很自然会读成「不是一张一张来」。
- **改法（用户选 B）**：`workbenchAnalyze` 里算 `oneByOne = !WB.batchMode && WB.batchSize <= 1`，
  为真时同路第二张起加 `.wb-step-queued` + `data-wb-queued="1"` + 一句
  「排队中 · 等 <同路前一张 id>」。样式：**虚线左边框 + 淡背景 + 标题转灰**，
  和正在跑那张的**实线蓝边**一眼可分；提示单独占一行（`flex-direction:column`），
  否则挤在 220px 的小卡里会溢出。
- **只在每批 1 张时生效**（用户明确要求）：每批 2/3/5 张或整批全交时**不动** ——
  那些卡是要**一起交给 Agent** 的，本来就该全列出来，标「排队」反而是错的。
- ⚠️ **容易漏的一步**：`workbenchMark` 也必须清 `wb-step-queued` 和 `data-wb-queued`，
  否则某张卡真的轮到它跑起来后，还挂着「排队中 · 等 X」，**自相矛盾**。已加进 remove 列表。
- 测试：`flow-workbench-test` 新增 **[5j]**（10 项，47 → **57/0** 双板）：每批1张时排队卡数量 =
  Σ(每路卡数-1)、提示必须指向**同路前一张**（不是随便一张）、排队卡虚线/头一张实线、
  切每批2张后回到整批清单且标记清零、串行无标记、**跑完标记与属性都清干净**。
- 删 `scripts/diag-flow-drag.mjs`（画布时代的排查脚本，`[data-flow-node]` 已不存在，跑不通）。
- 产物：cyber **912.3 KB** / practise **415.0 KB**（体积涨 ~2 KB = 新样式 + 新逻辑）。
- 全量门禁：verify-board 双板通过 · flow-test 11/0 ×2 · flow-workbench-test **57/0** ×2 ·
  flow-workbench-run-test 10/0 · flow-api-test 33/0 · wb-mount 12/0 · wb-overview-live 11/0 ·
  stale-route 3/0 · card-fold 16/0 & 12/0。

**2026-11-18 十九改（版本控制 + 死代码清理 + 一键门禁 `gate.mjs`；门禁上线首日抓出 3 个真 bug）**

> 本轮起因是用户要「先做版本控制，再处理之前评估里没处理好的问题」。顺序：先能回滚，再动刀。

- **版本控制（从零到有）**：`D:\WorkSpace-Tools\ops-board` 此前**不是 git 仓库** ——
  一个 51 文件 / 1000+ KB 的项目，改错了没有任何退路。本轮 `git init` + 首次提交（63 文件），
  推到 `github.com/ZJR24/dsh-ops-board`。只推**分发产物**（`dsh-ops-board/` 插件 + `ops-board-template/`
  模板骨架），不推开发脚本与看板数据。
  - ⚠️ **本机两个坑**：①全局 `.gitconfig` 有 `url.…insteadOf https://github.com/` 指向一个**已挂的镜像**，
    裸 `git push` 会 `504`；②凭据助手被**有意禁用**（防弹窗），`git credential fill` 直接报
    `Cannot prompt because user interactivity has been disabled`。
    绕法：临时 `GIT_CONFIG_GLOBAL`（只放身份）+ token；`github.com:443` 本机**时通时不通**
    （实测 3 次全 False，而 `api.github.com`/`codeload.github.com` 正常），
    最终用 **Git Data API**（blobs → tree → commit → ref PATCH）推送成功。
- **`export-plugin.mjs` 白名单化**：导出时自检报「源码里还有 31 处本机路径 / 示例值」而中止。
  查清后发现是**扫描范围与复制范围不一致**（扫了整个 `scripts/`，却只想复制其中一部分），
  于是把一大片测试数据里的看板绝对路径当成了产品污染。改成 `PLUGIN_FILES` / `PLUGIN_DIRS` /
  `TEMPLATE_FILES` / `TEMPLATE_SCRIPTS` 白名单 + `scanFile`/`scanTree`，并新增 `resolveLibs()`
  按 `from "./lib/<x>.mjs"` 递归求依赖闭包（9 个 lib）—— 否则模板独立跑会 `ERR_MODULE_NOT_FOUND`。
  另修：模板 `board.config.json` 里残留 `kind:"flow"` 导致 `verify-board` 报「`#view-flow` 找不到落点」。
- **删死代码（画布时代遗留）**：`client.js` 删 **688 行**（`paintFlowNode`、`claimFlowItem`、
  `flowDrag*` 全套、`flowContextMenu`、`flowReorderCanvas`、`flowDrawOrderEdges` 等 30+ 个函数），
  `css.mjs` 删 **76 行**（`.flow-legend*`/`.flow-canvas*`/`.flow-edge*`/`.flow-ghost*`/`.flow-menu*`/
  `.flow-node-*`/`.flow-state-*` 整块）。判据：十六改已把画布整页删掉，这些函数**没有任何调用点**。
  - ⚠️ **保留**：`flowActor`（localStorage `ops-board-flow-actor`）、`postJson`、`claimForWorkbench`/
    `releaseForWorkbench` —— 名字带 flow 但服务于工作台领取，**不是死代码**。
  - 产物：cyber 912.3 → **873.1 KB**、practise 415.0 → **375.8 KB**（共 −64 KB）。
    `verify-board` 的「无孤儿样式」独立印证了删掉的 CSS 确实没人用。
- **新增 `scripts/gate.mjs`（一键门禁）**：20 个测试脚本此前**没有注册表**，靠人记得跑哪几个
  —— 「改了一处，跑了三个测试就以为没坏」。现在 `SUITES` 数组登记 23 项，`npm test`/`npm run gate`
  一条命令跑完：先渲染双板 → `verify-board` → 逐项跑测试，打印每项耗时，任一失败即 exit 1。
  支持 `--fast`（跳过 11 项慢的，实跑 12 项）、`--list`、`--only <子串>`。
  > 这里的 23/12 是**十九改当天**的数字。二十改加了 `stage-ask` 双板后是 **25 项 / --fast 14 项**，
  > 以 §5.2 的基线为准。
  - ✓ 已做**负向验证**：往 `client.js` 的状态表塞一个假状态 → 门禁红并**点名**失败的那一项。
- **新增 `scripts/status-consistency-test.mjs`（10 项）**：`flow.mjs` 的 `OPEN_STATUSES`（Set）与
  `client.js` 的 `isOpenWbStatus`（数组）是**手抄的两份**（`client.js` 是单 IIFE、被内联进 HTML，
  运行时无法 import `.mjs`）。两份漂移**不会有任何报错**，只会让工作台把已收口的卡当成还能做。
  这条测试盯的就是这个沉默漂移。⚠️ 写它时踩过：`client.js` 是 CRLF 而 `flow.mjs` 是 LF，
  负向验证用 CRLF 拼 `Replace` 会**静默不生效**，测试照样绿 —— 假阴性。
- **门禁上线首日抓出 3 个真 bug（这是做门禁最大的回报）**：
  1. **`evidence-look` / `report-ui` 缺 `--board`**：两者都要求 `--board <绝对路径>`，我在 `SUITES`
     里没传，`resolve(process.cwd())` 落到模板根（不是看板目录）→ report-ui **27/11 失败**、
     evidence-look 报「找不到被跟踪的项目目录」。补上参数后 **47/0** 与 **41/0**。
     ⚠️ 教训：**测试脚本的 `--board` 是必需契约，不是可选装饰**；漏传时的报错看起来像功能坏了。
  2. **大提交的 diff 静默变空**（`code-look.mjs`）：取 diff 用 `execFileSync`，`maxBuffer` 只给
     `MAX_DIFF*2 = 400KB`。而 `execFileSync` 的 `maxBuffer` 是**硬上限**，超了抛 `ENOBUFS`、
     **一个字节都拿不到**（不是截断，是全丢）。实测 cyber 看板 `f079811`（51 文件 / +184 / −11081）
     diff 有数 MB → catch 成「diff 取不出来」→ 浮层正文一片空白。
     ⚠️ 关键认知：**截断逻辑根本没执行到**，失败发生在 git 写管道那一层，截断在它之后。
     修法：缓冲区提到 8MB；真超了再走 `spawnSync` 兜底取前 200KB，并且**如实写明被截断**。
     新增 `scripts/code-look-test.mjs`（**18 项**）用**临时构造的 git 仓库**（小提交 + 6MB 提交）
     钉死边界，不依赖任何真实看板数据 —— 因为原测试点哪个 commit 取决于台账，**同样的代码两种结果**。
     ✓ 已做负向验证（退回旧缓冲区 + 关掉兜底 → 4 项红）。
  3. **调试端口竞态**：`evidence-look`/`report-ui` 固定用 `OUT/profile` 当浏览器 profile，
     而上一轮留下的 `DevToolsActivePort`（里面是**已关闭的旧端口**）会被这一轮的等待循环读到，
     于是锁定死端口 → 连 `/json` 全超时 → `target` 为 `undefined` →
     在 `new WebSocket(target.webSocketDebuggerUrl)` 处崩（报的是 `TypeError`，看起来像浏览器起不来）。
     实测：预置死端口再启动 Edge，循环第一次就读到它，**3/3 次锁死**；而 Edge 启动时自己也会重写
     这个文件，所以真实脚本里是**竞态** —— 单跑常没事、连着跑才偶发（本轮门禁撞了一次）。
     修法：profile 带时间戳（不继承上一轮目录）+ 启动前 `rmSync` 掉该文件（不继承上一轮端口）
     + 补 `if (!target) { kill; 报错; exit 1 }` 明确契约（原来直接 `TypeError`）。
     其余 15 个脚本本来就是 `Date.now()` 唯一 profile，不受影响（已逐个核对）。
- **清理**：删 6 个 `.bak-*`（3 个内容已在 git 里可直接删；另 3 个 git 之前的历史快照先归档到
  `D:\WorkSpace-DeepSeek\ops-board-pregit-bak` 再删）+ `.uitest/`（**41.3 MB / 873 文件**）。
  项目体积（不含 `node_modules`/`.git`）：66 文件 / 2.06 MB。
- **`package.json` 脚本**：新增 `test` / `test:all` / `gate` / `gate:fast`；`build` 原来写成
  `render.mjs && verify-board.mjs`（两者都要 `--board`，裸跑不通）→ 改成 `gate.mjs --fast`。
- **门禁基线**：`npm run gate` → **23 通过 / 0 失败（270.9s）**；`npm test`（--fast）→ **12 通过 / 0 失败（174.4s）**。
  逐项耗时：flow-workbench 60.2s、flow-workbench-run 73.5s 是最慢两项，其余多在 10s 内。
- ⚠️ **本文档编号有断档**：`十三改`、`十四改` **从未写过**（全仓库搜不到任何痕迹）。
  本轮把错位的 `十二改`（原排在 `十八改` 之后）搬回 `十一改` 之后，但没有能力凭空补出
  十三/十四 —— **不知道就是不知道，不编**。若日后发现对应改动，补在两处之间即可。

- 对话窗为什么空：插件侧 `dsh-ops-board/client.js` 的 `askInHarness` **强制 `inline=true`**，
  从不 `ui.openSession` —— 会话在后台跑，回答回看板面板（步骤区的 why 文本），
  不会弹独立对话窗。这是设计（避免点一下就跳走），用户如想看见话，看步骤区记录即可。

**测试**：`flow-workbench-test.mjs`（**21/0**，UI 拖池 + 二维大画布拖卡排顺序 + analyze 端点 + 同区链序拨正 +
服务健康）与 `flow-workbench-run-test.mjs`（7/0，真 claim/互斥/收口/串行顺序/并行 rollout，用临时
看板拷贝；无头 CDP 不便模拟拖动，直接驱动 `window.__wb.dragPool`）。

**已知小事**：`window.__wb` 探针在 CDP 里有时读不到（可能被 try/catch 或页面重建吞了），
但功能断言（完成数、顺序、claims 归零）都过了，不影响产品。超时后的有上限重试（badTries ≤ 6）
在极端慢的收口下可能让某步卡久一点，但不会无限自旋。

---

**2026-11-19 二十改（「待处理问题 / 风险」搬到各自车道页 + 需求车道加「和 AI 谈谈要加什么」）**

> 用户原话：「新增功能页面：计划中右侧，增加按钮，用于和ai沟通增加功能；总览页面，待处理问题移动到问题修复，
> 待处理风险同理，都放在第一行第一模块；去掉新增功能/问题修复/风险每个阶段数值的开头表单；」
>
> **第 4 项当场撤回**：追问后用户答「**暂时不删了**」—— `.stage-board` 那排阶段数字原样保留，
> 本轮**没有**动 `stageBoard()`、`.stage-board*` CSS，也没动 `uitest.mjs` 里那两条相关断言。
> 下面三件事才是本轮真正做的。

- **① 总览不再放表格：只剩「工作台 + 处理记录」**。
  两块待处理表搬走后，`restLanes` 本来就排除 bug/risk/feature 三条车道，于是 `laneTables` 在**两块板上都渲染为空**
  —— 总览页一张表都不剩。确认后用户选择「**总览不再放表格，只留工作台 + 处理记录**」，
  所以 `viewOverview` 的返回值现在是 `wbMount() + laneTables + 处理记录`，`laneTables` 的代码**保留**（留着兜底其它车道）。
  - ⚠️ **连带后果（已向用户讲明并获同意）**：总览页不再有任何 `td.title-cell` 链接，
    于是 `uitest.mjs` 的〔4〕「点总览表格编号跳转」**失去前提**，本轮把它改到问题车道上做同样的验证
    （点「待处理问题」表里的编号 → 落到 `lane-bug` 那张卡片 + 在视口内），语义没丢，落点换了。

- **② 「待处理问题」「待处理风险」整块搬到各自车道页的第一行第一模块**。
  `pendingSection()` 从 `viewOverview` 内部提到模块级（`render.mjs` 322–345），内部 `openOfLane`/`itemsOfLane`
  改成按传入的 lane 算；新增 `lanePendingBlock(config, ledger, lane)`（389–406）按车道派发：
  bug →「待处理问题」+`data-ask-global`，risk →「待处理风险」+`data-ask-risks`，其它车道返回空串。
  `viewLane()` 在 `${stageBoard(...)}` **之前**输出它，所以它天然落在 `.details-main` 的第一个模块位。
  - ✓ **重复是被接受的**：同一条未收口条目会**同时**出现在待处理表和阶段卡片里。
    追问时用户选的是「**接受重复，先搬过去**」，所以**没有**去重、也**没有**改阶段卡片的数据逻辑。
  - ⚠️ 原样搬走的价值：`session-pick-test.mjs` ⑫ 要求那个按钮所在的 `section` 里 `h2` 恰好是
    「待处理风险」—— 因为 `<h2>` 和按钮在同一个 `pendingSection` 里一起搬，这个断言**不需要改**（已实测仍绿）。
  - ⚠️ `data-ask-global`（「总结项目状态」）是**全站唯一的「整本台账」入口**，
    搬走后仍在文档里（只是换页），`verify-board` 与几个测试用的都是**整份 HTML 级**的正则/选择器，不受影响。

- **③ 需求车道「计划中」右侧新增「和 AI 谈谈要加什么」**。
  `stageBlock()` 加第 5 个参数 `options.headAsk`（`parts.mjs`），有值时在 `.section-head` 里
  渲染 `<button class="btn btn-ask head-ask" data-ask-feature>`；`viewLane` 只在
  `lane.key === "feature"` 且 `stage.key === "planned"` 时传它。
  - **按钮挂在分节标题「计划中」右侧，不是 `.stage-board` 数字格里** —— 追问后用户选的是「分节标题右侧」。
    这样第 4 项撤回后也不冲突：数字区一点没动。
  - ⚠️ **「计划中」在两块板里都是 0 条**（实测无任何 `statusLabel==="计划中"` 的条目），
    所以按钮是渲染在**空阶段**上的 —— 这正是要它存在的原因：没有条目时也能开口问「缺什么功能」。
    已核对产物：`<h2>计划中</h2><span>0 项<button …data-ask-feature>和 AI 谈谈要加什么</button></span>`。
  - **作用域是需求车道，独立会话**：`AI.featureScope` + 哨兵 `__feature__`，
    与 `__skills__` / `__risks__` 平级。`featureItems()` 取**全部**需求条目（**含已上线/暂停**）——
    不只看未上线的，否则 AI 会把已有功能当缺口重复建议。
  - 改动点（`client.js`，共 15 处）：`AI.featureScope` 标志、`ctxLabel()` 文案、
    `featureItems()`、`HARNESS_FEATURE_QUICK`（4 条动作）、`harnessContext` 的 `__feature__` 分支、
    `harnessPost` 的 `title`、`paintQuick()`、`resetChat()`、`scopeId()`、`savePanelState`/`restorePanelState`、
    `openPanel`/`openSkillPanel`/`openRiskPanel` 里的互斥复位、`openFeaturePanel()`、
    `loadHistoryFromHarness` 的 fresh 标记、`applySessionList` 的 `own`/`scopeTitle`/fresh-force、
    无面板时的 `[data-ask-feature]` 移除、`featureAsk` 点击绑定、`CHAT_ONLY` 路由、
    `fallbackToShellWindow` 的 `featureScope`、`sendHarness` 的 scope 三元。
  - 插件侧（`D:\WorkSpace-Tools\dsh-ops-board\client.js`）**不需要改也不用重启**：
    它的 `open(payload)` 只读 `payload.proxy` 与 `payload.scope`，新哨兵天然通过。

- **校验补强**：`verify-board.mjs` 新增 `data-ask-feature` 存在性检查（缺了就报「需求车道「计划中」右侧缺按钮」），
  并把 `askOff` 分支的正则扩展到 `-feature`，防止关掉 ask 后还残留按钮。

- **产物**：cyber 873.1 → **879.0 KB**、practise 375.8 → **381.7 KB**（两块各多一张待处理表 + 一个按钮）。
  体积涨是因为待处理表**搬家而不是消失**，条目本身没变（61 / 11 卡，6 视图，id 154 / 101 全唯一）。

- **测试**：新增 `stage-ask-test.mjs`（**31/0**，双板）专盯本轮三件事 —— 按钮在「计划中」分节标题里
  （且**不在** `.stage-board` 数字格里，把撤回的第 4 项钉死）、点它开面板作用域是「新增功能」、
  发出去的 `item="__feature__"` / `title="新增功能"` / 上下文覆盖**全部**需求条目
  （用台账条数与问题里「共 N 条」对照，不写死数字 —— practice 板 4 条全是未收口，
  一开始那条「含已上线」的断言在小板上误红了）、两块待处理表在各自车道页第一行第一模块且总览零张表。
  已做负向验收：把按钮从 `.section-head` 摘掉 → **16/11 红**，还原后 31/0。
  `npm run gate` → **25 通过 / 0 失败（286.1s）**（23 + 新增 stage-ask 双板）；
  `npm run uitest` 双板 → **交互验收通过**。
  ⚠️ `uitest.mjs` **不在** `gate.mjs` 的 25 项里（它是人工按需执行的），**改完渲染相关的东西必须单独跑它**。

---


## 五、测试（怎么跑、基线是多少）

### 5.1 跑法

**首选：一条命令跑全部（推荐，2026-11-18 起）**

```powershell
cd D:\WorkSpace-Tools\ops-board
npm run gate          # 渲染双板 → verify-board → 25 套测试，逐项报耗时，任一失败 exit 1
npm test              # = gate --fast，跳掉 11 项慢的、实跑 14 项（约 188s，改完随手跑）
node scripts/gate.mjs --list            # 看都登记了哪些套件
node scripts/gate.mjs --only workbench  # 只跑名字含 workbench 的（调试时用）
```

**单独跑某一套**

```powershell
node scripts\<测试名>.mjs --board "D:\WorkSpace-Tools\ops-board-reports\<看板名>"
```

⚠️ **`gate.mjs` 内部是串行执行的，不要自己再并行跑第二个**（都会起无头 Edge，抢端口/资源）。
⚠️ **`--board` 是必需契约**：`report-ui`、`evidence-look` 漏传时会落到模板根而不是看板目录，
报出来的错看起来像「功能坏了」而不是「参数漏了」（见十九改）。
⚠️ `float-negative.mjs` / `chatwin-negative.mjs` **故意没进 gate**：它们是负向验收，会临时改坏
`client.js`/`css.mjs` 再还原，中途被打断会留下坏源码。

### 5.2 基线（全部绿，2026-11-19 二十改后实测）

**总基线：`npm run gate` → 25 通过 / 0 失败（286.1s）；`npm test`（--fast）→ 14 通过 / 0 失败（188.4s）。**
**另需人工跑 `npm run uitest`（双板）→ 交互验收通过** —— 它不在 gate 的 25 项里，改渲染相关的东西必须单独跑。

| 套件 | 结果 | 说明 |
|---|---|---|
| `status-consistency-test.mjs` | **10 / 0** | `flow.mjs` 的 `OPEN_STATUSES`(Set) 与 `client.js` 的 `isOpenWbStatus`(数组) 两份手抄必须一致（运行时无法 import，只能靠测试盯漂移） |
| `code-look-test.mjs` | **18 / 0** | 代码浮层取 diff 的边界：小提交原样返回、**超大提交必须返回非空 diff**（截断要如实说明）、元数据齐全、坏输入拒绝。用临时 git 仓库构造，不依赖真实看板 |
| `flow-test.mjs` | **11/0**(cyber) **11/0**(practise) | 工作流页已删的「壳验」：DOM/导航/设置里都没有 `flow` + 无 `#flowCanv`/canvas-wrap + 旧 hash `#view-flow` 不白屏（落回总览）+ 工作台在总览且单实例 + 候选池有卡（file:// 无后端则跳过池断言，深度由 workbench 覆盖） |
| `flow-api-test.mjs` | **33 / 0** | API 生命周期（自带服务器，端口 8797）※含重启落盘持久化。**2026-11-18 改成数据驱动**：不写死卡号，先读 plan 得「谁是头 / 谁排队」，再验领取·同区互斥·跨区并行·交还·落盘——台账推进不再误报 |
| `flow-workbench-test.mjs` | **57 / 0**（数据驱动：期望卡数从 `/api/flow/plan` 实时推导） | 工作台 UI（**初始队列空、全在备选** + 拖拽前/后 + **点队列卡撤回备选** + analyze 采纳 + **并行拆成多路队列 `.wb-lane`** + **分批开关只在并行显示** + 一键清空 + 同区链序拨正）+ 分批/整批执行引擎（[5e][5f][5g][5h]）+ 每批 1 张的排队标记（[5j]）+ 服务健康（端口 8799） |
| `flow-workbench-run-test.mjs` | **10 / 0** | 工作台执行驱动器：claim/互斥/收口/串行 3 件顺序/并行 5 件铺 4 路（独立双 phase，端口 8797/8798）。**2026-11-18 修正**：选卡走真实点击（点备选卡）、先选模式再点分析、并轮询等分析结果——原先直接改 `WB.dragPool` 绕过 UI，按钮一直是 `disabled`，`.click()` 不派发事件 |
| `wb-mount-test.mjs` | **12 / 0** | 工作台单实例搬运：总览挂载 / Skill 页收进 `#wb-park` / 回来仍是同一 DOM 节点 / 旧 `#view-flow` 落回总览且仍只有一份 |
| `wb-overview-live-test.mjs` | **11 / 0** | 总览页实时运行：候选池→排卡→分析→并行 4 路，Skill 页往返状态不丢 |
| `stale-route-test.mjs` | **3 / 0** | 旧书签 `#view-flow` 不白屏且坏落点被清出 localStorage |
| `report-ui-test.mjs` | 47 / 0 | 整体 UI |
| `evidence-look-test.mjs` | 41 / 0 | 证据链（`cyber-egg-basket`）/ 25（`practise`） |
| `float-test.mjs` | 51 / 0 | 悬浮面板 |
| `card-fold-test.mjs` | 16 / 0（cyber）12 / 0（practise） | 卡片折叠 |
| `stage-ask-test.mjs` | **31 / 0**（cyber）**31 / 0**（practise） | 二十改三件事：「计划中」右侧 AI 入口（在分节标题里、不在数字格、空阶段也在）/ 点开作用域是「新增功能」/ 请求 `item="__feature__"` 且上下文覆盖全部需求条目 / 两块待处理表在各自车道页第一模块、总览零张表 |
| `msg-align-test.mjs` | 9 | 消息对齐 |
| `verify-board.mjs` | 两块都过 | 产物自检 |

其他基线：chatwin-wiring 43、finder-settings 69、session-pick 38、chat-persist 20、
roundtrip 10、panel-persist 25。

**最慢的两项**：`flow-workbench-run` 73.5s、`flow-workbench` 60.2s，其余多在 10s 内。
这两项慢在真起无头 Edge + 真跑执行引擎（claim→ask→收口→release 整条链），
所以 `npm test`（--fast）把它们排除在外。

### 5.3 一个反复踩的设计原则：**期望值不要写死**

写了两套测试、踩了两次同一个坑，所以单独记一条。

**① `flow-test.mjs`：跨看板就不能写死数量。**
早先写死 `7 个节点 / 5 行`，换 `practise` 看板（11 件）时 12 项全红。现在壳体断言只验
「不该存在的东西不存在」（没有 `flow` 视图、没有 `#flowCanv`、导航里没有「工作流」），
天然与看板数据无关；需要数量时从台账推导（`buildFlow(cfg, led)` 的 `totals`），**加新看板不用改测试**。

**② `flow-api-test.mjs`：同看板也不能写死当时的数量 / 卡号。**
（2026-11-18 重写）旧版把台账快照当契约：「未收口 7 件」「能并行 5 路」「OPS-022 可开工」
「排队 2 件」「同区排队的是 OPS-025」。台账一推进（`OPS-022` 收口成 `fixed`），
**20 条一起变红，而代码一行没错** —— 红的不是功能，是测试把**数据**当成了**规格**。

正确的分界：
- **该验的是「关系」**：`total === 可开工数 + 排队数`、`parallelNow === ready 的数量`、
  同一 prefix 至多一个 ready、排队项指向同区前驱、领取后同区互斥、交还只认领取人、重启后状态不丢。
- **不该验的是「数字」**：今天有几件、哪张卡能开工、第几个是谁。这些属于台账，台账本来就会变。

落地方式：测试先 `GET /api/flow/plan` 读一次，**从实时结果里挑一张可开工卡当靶子**，
再拿它去验上面那些不变式；挑不到可用的卡时（单区域 / 无排队件）显式打印「本轮跳过这一条」，
而不是判失败。当前 33/0。

> 一句话：**接口测试验关系，不验当时的数字。** 数字属于数据，数据会变。

---

## 六、看板数据现状

| 看板 | 条目 | updatedAt | 产物 | 未收口 |
|---|---|---|---|---|
| `cyber-egg-basket` | 61 | 2026-11-13 22:46 | 879.0 KB | 5 |
| `practise` | 11 | 2026-11-05 20:04 | 381.7 KB | 11 |

**6 个视图**（两块看板一致）：总览 / 新增功能 / 问题修复 / 风险 / 已解决 / Skill 统计
（「已解决」= 原「已修复·已关闭·暂停」收尾页；「工作流」页已于 2026-11-18 删除）
（总览页自 2026-11-19 起只有「工作台 + 处理记录」；两张待处理表已搬到问题修复页 / 风险页的第一行第一模块）

`cyber-egg-basket` 的 5 件未收口：
`OPS-025`（bug/watch/免费额度）、`OPS-024`（bug/watch/重构）、
`FEAT-014`（feature/doing/免费额度）、`RISK-001`（risk/watching/云环境）、
`RISK-003`（risk/mitigating/数据源）
（`OPS-022` 与 `RISK-002` 已分别收口为 `fixed` / `resolved`，不再计入）

**台账没有依赖字段。** `area` 字段 61 条有 55 个不同值，按前缀分组得到 24 组。
**area 前缀是依赖边的当下替代品**，这是已知限制（D19 第二期才做真依赖边）。

---

## 七、下一步（优先级已排好）

| 优先级 | 事项 | 依据 | 说明 |
|---|---|---|---|
| **P0** | 领取状态落盘 | D22 | **已做**（下一轮的验收结果见下） |
| **P0** | `/api/evidence/stale` 接到 UI | 用户提过 | 接口已算好（38 张卡 / 110 处引用），**但没有任何界面露出** ← **当前最该做的下一件事** |
| **P1** | 领取超时回收 | D15 | 崩掉的执行者会永久占着地 |
| **P1** | 真正的并行执行器 | D13 | 现在只是「约束」，还没有「自动跑」 |
| **P2** | 依赖边（不只 area 前缀） | D19 二期 | 台账要加依赖字段 |
| **P2** | 执行历史回放 | D24 | |

### 关于「工作台」（用户提过，暂缓）

用户在第 50 轮说过要一个「工作台」：自动读问题卡片 → 推导工作流 → 一件一件解决，
**要有按钮、要人来选解决哪几件**。

`/api/flow/plan` + claim/release 就是它的天然后端。
**「人工领 + 机器守约束」是有意为之**，不是没做完 —— 约束由机器守、选择由人做，这个分工是刻意的。

---

## 八、硬约束（别违反）

1. **零依赖**。渲染层是字符串拼 HTML + 一个 CSS 文件。加图库/框架 = 前端重写，违反渐进替换。
2. **每个看板有自己的 `board.config.json`**。改模板不加视图，要各改一次。
3. **`serve.mjs` 不许自己推导「谁能开工」**。必须 `import { buildFlow }`，和渲染层同一个函数。
4. **卡片锚点是裸 id**（`#OPS-022`），不是 `#item-OPS-022`。`parts.mjs` 里 `<details id="${item.id}">`。
5. **CSS 变量名**：没有 `--panel`。用 `--paper` / `--surface` / `--surface-soft` / `--surface-hover` /
   `--surface-strong` / `--ink` / `--head` / `--muted` / `--rule` / `--rule2` / `--red` / `--blue` /
   `--green` / `--amber` / `--serif` / `--sans` / `--mono`。
6. **`verify-board.mjs` 的孤儿类检查**：CSS 里每个新类都必须在渲染源码里用到，
   而且**注释里不许出现带点的类名**（`/\.([a-zA-Z][\w-]*)/g` 会误抓）。
7. **`pwsh` 只在这个会话的 `danger-full-access` 下能用**。受限档会 `0xC0000142`。
8. **改完必须 `node scripts\render.mjs --board "<看板绝对路径>"` 重新渲染**，否则产物是旧的。
9. **`node -e "..."` 在 pwsh 里会被引号/正则搞坏**。写 `.mjs` / `.cjs` 文件再跑。
10. **ESM 里 import 绝对 Windows 路径要 `file:///D:/...`**。

---

## 九、文档在哪

| 文件 | 内容 |
|---|---|
| `D:\WorkSpace-Tools\ops-board\README.md` | 46 KB，使用说明（面向用户，不是开发） |
| `D:\WorkSpace-Tools\ops-board\docs\research-notes.md` | 76 KB，**外部项目调研笔记**，1562 行 |
| `D:\WorkSpace-Tools\dsh-ops-board\README.md` | 21 KB，插件说明 |

### research-notes.md 的结构（要看哪一节）

```
# 第一轮
  ## 零～八     基础调研（8 个可抄点、设计决策 D1–D12、反面清单）
# 第二轮：并行处理 + 可视化工作流
  ## 九           GitHub 凭据找到了（本机 token 可用，5000/h）
  ## 十           新素材清单
  ## 十一         并行处理：5 个项目怎么做的
  ## 十二         可视化工作流：三种形态对比
  ## 十三         D13–D24 十二条落地决策  ← 重要
  ## 十四         明确不抄清单
  ## 十五         两轮合并结论
# 第三轮：已落地
  ## 十六         做了什么
  ## 十七         撞到的四个真问题
  ## 十八         界面上两个「说不通」
  ## 十九         真实表现
  ## 二十         还没做的 ← 就是本文档第七节
```

**关键设计决策**（D13–D24，在 §十三）里最要紧的几条：
- **D19**：第一期做泳道 + 依赖线，**不做自由画布**
- **D22**：并行状态必须持久化 ← 当前 P0
- **D15**：领取和完成必须共享同一个版本条件
- **D16**：单一状态编码 + 一个 `transition()`

---

## 十、这次对话里没答的问题（如果用户再问）

1. **时间上下文行怎么隐藏**（`Time sampled while preparing turn N…`）：
   两条路 —— 写客户端插件隐藏，或在 `cordis.patch.yml` 里停用 `@deepseek-ai/dsh-time-context`。
   用户没选。**别自作主张**。

2. **`GitNexus` 那个项目**（`abhigyanpatwari/GitNexus`，48.6k star）：
   用户发错了，本来想让别的窗口分析。**结论已给过，不用再查**：
   它是代码知识图谱（Tree-sitter + LadybugDB），和任务看板不是一回事；
   主项目是微信小程序，WXML/WXSS 它不认；许可证 PolyForm Noncommercial，商用要付费。
   **值得抄的只有两块文档**：`pr-swarm-review/orchestration.md`（7 车道编排 + 硬门禁 + 双模式契约）、
   `ARCHITECTURE.md` 的 Storage / Staleness 两节（四态：current/behind/diverged/unknown）。
   **不用装。**

---

## 十一、怎么快速验证环境没坏

```powershell
cd D:\WorkSpace-Tools\ops-board
node scripts\render.mjs --board "D:\WorkSpace-Tools\ops-board-reports\cyber-egg-basket"
node scripts\verify-board.mjs --board "D:\WorkSpace-Tools\ops-board-reports\cyber-egg-basket"
node scripts\flow-test.mjs --board "D:\WorkSpace-Tools\ops-board-reports\cyber-egg-basket"
```

三条都过 = 环境正常。产物：`D:\WorkSpace-Tools\ops-board-reports\cyber-egg-basket\dist\index.html`
（直接用浏览器打开，或经插件在 GUI 里看）。

**注意**：DSH 插件服务（1534 端口）经常不在监听，直接开文件最快。
插件服务在的话可以 `POST http://127.0.0.1:1534/ops-board/start` `{"board":"cyber-egg-basket"}`。
