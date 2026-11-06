# dsh-ops-board

把 ops-board（工作报文）嵌进 DeepSeek Harness，并支持**多个项目的多份看板**：

- 主界面一个整页 **「工作台」** 面板，左栏一个同名图标；
- 面板里可以**切换 / 添加 / 删除**看板，每个看板是一个独立的 ops-board 目录；
- 每份看板有自己的服务与端口，插件按需启动、按 LRU 回收（默认同时最多 2 个）；
- 看板页里有一个浮动的 **「在 Harness 里问」**：把问题交给 Harness，在你的看板目录里新建会话，问题预填进输入框；
- 看板自带的「问 AI」原样保留（走它自己的 `ai.config.json`），本插件不碰密钥、不换模型。

![工作台面板](docs/screenshot.png)

## 多项目 / 多看板

**一个看板 = 一个 ops-board 目录**（含 `ledger.json`、`board.config.json`、`scripts/serve.mjs`）。
插件把看板清单放在 `~/.dsh/ops-board/boards.json`，除了看板列表还记住上次的报文存放位置：

```json
{
  "version": 1,
  "last": "my-project",
  "lastCreateDir": "<报文存放根>",
  "boards": [
    { "id": "my-project", "label": "我的项目", "dir": "<报文存放根>\\my-project" }
  ]
}
```

### 新建看板（工作台直接生成，不再手复制目录）

面板右上角 **管理 → 新建看板**：

1. **项目目录（可选）**：用系统的目录选择器选一个代码项目。生成时会读它的 `package.json` / `README.md`，用项目名和简介初始化报文；不选也可以。
2. **报文存放位置（必选）**：选一个用来放报文实例的根目录。没选就默认上次用过的位置（`lastCreateDir`），再没有就用 `defaultCreateRoot`。
3. **名称（可选）**：留空用项目名。
4. **生成档位**（勾了「创建后生成报文」才出现）：
   - **快速档（默认，约 1 分钟）**：只读文件，不跑构建、不跑测试，出 5~10 条骨架，每条 evidence 标「待核实」。
     目的是让人**第一次就马上看到成品长什么样**，而不是等十几分钟。
   - **实测档（可能十几分钟）**：跑构建 / 测试 / 只读排查命令拿真实证据，条目按实际情况不设上限。
5. 点 **生成看板**：在工作台里直接创建 `<存放位置>/<项目名>/`（重名自动 `-2`），写数据文件与 `scripts/` 转发入口，
   按项目重写 `board.config.json` 的 `project`，生成一份空 `ledger.json`，登记并选中它。

#### 先探测，再决定

填了项目目录后，对话框会先探一次这个项目里**有多少可依据的东西**（只读，不改项目）：

```
这个项目里有多少可依据的东西
  - git 历史 368 个 commit（195 条提到修/改/问题）
  - 有 docs/ops/issues.json
  - 构建方式：小程序（project.config.json）
这个项目有现成文档和提交历史，能挖到真实的「为什么」和「怎么验的」。
```

探到的四类结果：

| kind | 什么情况 | 会怎么生成 |
|---|---|---|
| `rich` | 有文档 + 有 git 历史 | 能挖到真实的「为什么」和「怎么验的」 |
| `history` | 有 git 但没文档 | 能挖到改过什么，「为什么」多半要推断 |
| `thin` | 只有构建配置 / 少量文档 | 看得出「有哪些东西」，看不出「为什么」 |
| `empty` | 没 git、没文档、没构建配置 | **老实说只能出骨架**，每条标「待核实」 |

探测结果会原样写进给 agent 的 prompt，并附三条硬要求：

- 上表没有的东西就是没有，不要凭代码风格推测「当初为什么这么做」；
- `evidence` 只能指向真实存在的东西（文件 / commit / 配置 / 文档原文），指不到就写「待核实：需要 XX 才能确认」；
- **宁可少写几条真的，也不要凑数量。**

这样三种项目都不会被坑：小程序 / Java 后端（有 git 有构建）能挖到真东西；学习项目、一次性脚本（啥都没有）
不会得到一堆编出来的「证据」。

已经有一份现成的 ops-board 目录时，仍可用底部的 **添加已有目录（高级）** 直接登记。


### 管理

- **管理** 里列出全部看板：打开 / 删除（只删登记，不删磁盘目录）；
- 切到某个看板时，插件替它起一个独立服务（首个看板优先用 8790，其余用空闲端口），并给它一个稳定代理前缀 `/ops-board/b/<id>/`；
- 同时运行的看板超过 `maxRunning` 时，最久没用的那个会被停掉（清单不会丢）。

配置里也可以声明看板（与注册表合并，按目录去重）：

```yaml
- id: ops-board
  config:
    boards:
      - id: my-project
        label: 我的项目
        dir: '<报文存放根>\my-project'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `boardDir` | `''` | 旧版单看板字段；`boards` 为空时用它建一个看板 |
| `boards` | `[]` | 声明式看板列表 `{id?, label?, dir}` |
| `templateDir` | `''` | 新建看板时复制的模板目录（含 `scripts/serve.mjs`）；留空用第一个已登记看板 |
| `defaultCreateRoot` | 模板同级 `ops-board-reports` | 没有上次位置时，新建看板的默认存放根目录 |
| `port` | `8790` | 第一个看板优先使用的端口，占用则自动换 |
| `autoStart` | `true` | Harness 启动后拉起始看板 |
| `maxRunning` | `2` | 同时最多跑几个看板服务 |
| `registryFile` | `~/.dsh/ops-board/boards.json` | 注册表路径；`sessions.json` 放在同一目录。留空即用默认（在 `~/.dsh` 下），想换位置再 override |
| `nodePath` | `''` | 指定 node；留空用托管 node，再退回 Electron Node 模式 |
| `keepRunningOnExit` | `false` | Harness 退出后保留服务 |

## 「问 AI」就是问 Harness（项目看板里不再有 Cloud 面板）

工作台里的看板是 **Harness 专属模式**（页面注入 `window.__OPS_HARNESS__`）：

- 每条问题 / 需求 / 风险卡片上的 **「问 AI」**、总览页的 **「总结项目状态」** 就是入口；没有额外的浮动按钮；
- 点击**先打开右侧的台账助手面板**（Harness 模式）：这一条的标题 / 状态已经在顶部，动作按钮（现在什么情况 / 别动手和我讨论 / 给出处理方案 / 解决一下）**只把动作填进输入框**，不会自动发送；也可以自己写问题。点「发送」才交给 Harness；
- 总览页的「总结项目状态」在 Harness 模式下列出四个动作：**总结并更新台账**（默认）/ 只总结，不改台账 / 检查台账是否过期 / 更新台账。发送后 agent 会读项目目录、`ledger.json`、`board.config.json`，把确认的变化按原 schema 写回 `ledger.json`，并在看板目录里跑 `render` / `verify-board`；回工作台点「刷新」就能看到新报文。项目源码不会被改动；
- 发送时只带一小段上下文，不再把整本系统提示塞进去：

  ```
  看板：我的项目（<报文存放根>\my-project）
  项目目录：<项目代码目录>
  条目：BUG-001 · 某个具体问题
  状态：待处理 高　区域：某模块 / 某子功能

  这次要你做的事：这条现在什么情况？……

  台账在 ledger.json，配置在 board.config.json；先读再答。
  ```

  agent 在会话里直接读文件，不需要靠 prompt 复述整本台账。

- **一个条目一个会话**（整本台账是每个看板一个），不是每次点都新开：
  - 映射在 `sessions.json`（默认 `~/.dsh/ops-board/`，跟注册表同目录）；
  - 同一条目再点「问 AI」、发送，打开原会话并追加问题；只有会话被删掉才新建；
  - 新建时会话标题写成 `BUG-001 · 某个具体问题…` / `我的项目 · 整本台账`。
- 面板右上角的 **「新会话」**：只对下一条发送生效；发送时新建一个 Harness 会话（标题写成 `BUG-001 · 14:05 · 某个具体问题…`，时间放在编号后面，侧栏截断也能看见），并把该条目的映射切到新会话，旧会话保留在侧栏。新会话**没有旧对话**，但发送时会重新按需读 `ledger.json` / `board.config.json`——上下文是新读的，不是从旧会话继承的。
- 会话需要工作目录，插件把**看板目录本身**登记成 Harness 工作区（每个看板一个，不是每次一个），agent 因此能相对读 `ledger.json`、`board.config.json`；侧栏里显示的就是看板的 id。不再用的旧看板工作区可以直接删掉。
- 面板里的**模型 / 设置 / 接入点 / 体检**在 Harness 模式隐藏；`ai.config.json` 只在独立运行 `127.0.0.1:8790` 时还有意义。点「发送」后 Harness 客户端会创建或复用会话、打开并发送（不是草稿）。
- 每个看板的项目目录记在 `boards.json` 的 `projectDir` 里，页面会把「项目目录」一并带进上下文；没有 `projectDir` 的旧看板可以在注册表里补上。
- 报文数据放在你选定的**报文存放根**下的 `<board>` 子目录；插件的注册表 / 会话映射默认在 `~/.dsh/ops-board/`。Harness 的会话记录本身由 DSH 存在 `~/.dsh/sessions`，那是 DSH 的全局存储，不是看板数据。
- **「在浏览器打开」** 用的是绝对 http(s) 地址（`state.origin` + 看板代理路径）：桌面端把 `window.open` 交给 `shell.openExternal`，只接受 http/https，相对路径会被拒掉。看板服务没起来时按钮会先把服务拉起来再打开，不会开出一张空白页。

## Skill 统计（独立一页）

导航最后一页 **Skill 统计**（`#view-skills`，`views[].kind = "skills"`）单独成页，不在总览里。页面结构：

- 头部：总数 + 三个格子（会话里用过的 / 项目产出的 / 为它写的），点格子跳到对应分组；
- 三组各一块，带一句判据说明；没数据时给「还没统计」和该跑的命令。

| 组 | 数据来源 | 判据 |
|---|---|---|
| 会话里用过的 | `~/.dsh/sessions/*/session.v4.jsonl.zstd` 里的 `tool/call`（`name === "skill"`） | 只统计会话 `cwd` 属于这个项目（项目目录 + 看板目录）的那些 |
| 项目产出的 | 项目目录里递归找 `SKILL.md`，读 frontmatter | `agent_created: true` 的标「agent 生成」 |
| 为它写的 | skill 根（`~/.dsh/skills`，可加 `--extraSkills`）里的 SKILL.md | **说明/标题里点了项目名**（目录名或台账里的中文名），或正文反复提到（≥2 次）；只在命令示例里出现一次的不算 |

数据由 `scripts/collect-skills.mjs` 生成 `skills.json`（在报文目录里）：

```powershell
node scripts/collect-skills.mjs --project <项目目录> --extraSkills <额外 skill 根>
```

- 会话日志是「一帧一条记录」的 zstd 流，脚本按 magic 切开逐帧解压；
- 看板每次刷新会自动重算（`serve.mjs` 的 `refreshSkills()`，用 `project.json` 里的 `projectDir`）；
- 没有 `skills.json` 时这页仍然在，三组给「还没调用过 / 没有 SKILL.md / 没有为它写的」，不会凭空消失。

### 这一页的「问 AI」

两级入口，都走 Harness 会话（不碰 Cloud）：

- **每条 skill 右侧一个「问 AI」** → 面板锁定这条，上下文带 `skill:<名字>`、文件路径、版本、使用次数；
- **页首「问整页 Skill」** → 针对全部 skill，上下文里列出全部名字和所属组。

快捷动作分两套，**作用域严格分开**（点一下只填进输入框，不自动发送）：

**单条 skill → `HARNESS_SKILL_ONE_QUICK`**（只该动这一个文件）

| 动作 | 让 agent 做什么 |
|---|---|
| 总结并更新这一个 | 只读改这一个 SKILL.md，把过期的地方按原格式改掉，逐条列改了什么 |
| 只总结，不改文件 | 只读这一个，报告还准不准，不动文件 |
| 查它和其它 skill 的冲突 | 以这一个为主体找冲突，可读别的用于比对，但结论只针对它、不改别的 |
| 查它缺什么 | 只针对这一个，列建议新增的条目 |
| 查它有没有该删的 | 只针对这一个，给删减建议并说明会丢什么 |

**整页 Skill → `HARNESS_SKILL_QUICK`**（跨 skill）

| 动作 | 让 agent 做什么 |
|---|---|
| 更新所有 Skill | 读全部 SKILL.md + 项目现状，把过期的地方按原格式改掉，逐条列每个文件改了什么 |
| 检查 Skill 冲突 | 跨 skill 找说法相反的，逐条列原文、判断哪个对、依据 |
| 检查冗余重叠 | 找重复知识、被完全覆盖的章节，给合并/拆分建议 |
| 检查该补没补的 | 对照最近实际改动，列出反复踩坑但没写进去的东西，建议写进哪个 skill |
| 只报告，不改文件 | 报告过期/冲突/冗余/缺漏各多少，这一轮不写文件 |

单条的上下文里还会写死一句「作用域限制：只读、只改这一个 SKILL.md」，防止 agent 顺手把同目录的其它 skill 一起改了。`verify-board` 会检查单条那套动作里不出现「全部 SKILL.md / 每个 skill / 这些 skill」这类越界说法。

会话按 `skill:<名字>` 复用（`sessions.json` 里的 key 带 `skill:` 前缀，不会和台账条目 id 撞），同一 skill 再问是追加而不是新开。

## 侧栏：高度、折叠与筛选

侧栏（`.rail-body`）的可视高度是 `calc(100vh - 96px)`，只减掉顶栏 + 导航，一屏能吃满；它仍然是内部滚动，不会把整页撑高。

跟原版 `render-report.mjs` 对齐的四个交互，**一个都不能少**：

| 交互 | 位置 | 行为 | 记忆键 |
|---|---|---|---|
| 整栏收起 | 侧栏右边缘竖排按钮 / `[` | 留 50px 窄条，按钮文字翻「展开」 | `ops-board-rail` |
| **整节折叠** | 每节标题**左侧**的小箭头 `.rail-fold` | 把这一节正文折起来，标题留在吸顶堆里 | `ops-fold-<bodyId>` |
| **收起明细** | 明细列表上方那行右侧 `.rail-mini-toggle` | 只收这一块里的明细列表，阶段格子和统计数字留着 | `ops-mini-<listId>` |
| **阶段格子筛选** | 阶段板 / 侧栏阶段表的格子 | 整页只留这一阶段，再点同一格恢复；格子上会有一行「只看「X」· 再点这一格恢复全部」 | 不记忆（一次会话内） |

处理记录（`data-history-section`）还有一个 **按类型筛选** 的标签条（`data-history-filter`）：

- 「全部 / 发现 / 修复 / 功能 / 运维 / 部署」，每个标签带计数；
- 点某个类型只留该类记录，标题右侧改成 `显示 N / M 条`；点「全部」恢复原文案；
- 记录里只有一种类型时不渲染筛选条（跟原版一致）；
- 按下时清掉浏览器选区，否则连点会把正文整段选中。

## 新建看板：从项目生成第一版报文

「管理 → 生成看板」选项目目录和存放位置（存放位置必选），默认勾选 **创建后让 Harness 读项目并生成报文**：

1. 看板目录按项目名生成（`<存放位置>/<项目目录名>`），并写入一份 starter 报文（项目名 / 描述 / headline / highlights / metrics）和 `board.config.json`；
2. 如果 Harness 页面开着（SSE 在线），Host 会发布一条 onboarding ask；Harness 自动新建会话「`<看板名> · 生成项目报文`」，读项目的 README / package.json / docs/ops，按 ledger schema 生成真实台账，写回 `ledger.json` 并跑 `render` / `verify-board`；
3. 生成完回工作台点「刷新」即可看到报文；
4. 不勾选或 SSE 不在线时，看板仍有 starter 报文，之后可以点「总结项目状态」手动生成 / 更新。

报文的项目来源在 `boards.json` 的 `projectDir`；项目源码不会被修改。

旧版 client 没有 `sessions` 自动发送能力时会退回 `postMessage` 并只预填草稿；没有 SSE 时同样退回 `postMessage`。SSE 断线（例如插件热重载）后客户端会每 3 秒重连，不会永久失联。

## 它是怎么接的

```
Harness 页面 (http://127.0.0.1:4679)
 ├─ main 面板「项目看板」
 │    └─ iframe src=/ops-board/b/<id>/        ← 同源，避开跨源 iframe
 │         ├─ 注入 window.__OPS_HARNESS__ = { id, label, dir, projectDir }
 │         └─ 卡片「问 AI」→ POST /ops-board/ask
 └─ SSE /ops-board/events                    ← 客户端建会话、打开、自动发送
```

- 看板页里写死的 `/api/*` 由注入的 fetch shim 改到当前看板前缀，因此看板源码只加了一段 Harness 分支；
- 看板服务没起来时代理直接断连接，页面会走它自己的 8790 兜底文案。

## 脚本只有一份：项目里放数据，不放副本

早先每新建一个看板，都会把整目录 `scripts/` 拷过去。结果就是 N 个项目 = N 份代码在漂移：
改一次模板要手动拷 N 次，漏拷一处就静默不一致（`client.js` 拷了、`css.mjs` 忘了）。

现在反过来：

```
模板 <模板目录>\
  scripts\            ← 真身只有这一份（render / serve / verify / uitest / collect-skills / lib）
  board.config.json   ← 新建看板时的骨架

项目 <报文存放根>\<项目>\
  ledger.json         ← 只有数据
  board.config.json
  skills.json
  project.json        ← { projectDir, templateDir }
  scripts\*.mjs       ← 每个 ~2KB 的转发入口，没有 lib\
```

转发入口只做一件事：从 `project.json` 的 `templateDir` 找到模板（找不到则退到 `OPS_TEMPLATE_DIR`
或默认位置），把参数原样转给模板里的同名脚本，退出码透传。

带来的变化：

- **升级脚本改模板即可**，所有看板下一次运行就是新版，不用逐个重拷；
- 项目目录里剩下的全是自己的数据，一眼分得清「这是哪个项目」和「这是工具」；
- 代价：项目不再自包含。脱离模板目录跑不起来 —— 但这比「悄悄跑着旧副本」好，因为
  入口找不到模板时会直接报错并告诉你该改哪个字段，而不是用旧代码继续跑。

`project.json` 里记的是**绝对路径**，所以模板目录搬家时要顺手改这个字段（或设 `OPS_TEMPLATE_DIR`）。

## 源码 / 同步 / 重载

源码在本目录，运行时是 profile 里的一份**真实目录副本**
（desktop 端不接受 link/junction）。改完源码：

```powershell
.\sync.ps1
```

- **不要去 `pnpm install` 这个包**：它 `private: true`、从未发布，profile 的 `dependencies` 里**不能**有
  `"dsh-ops-board"` 这一行，否则 pnpm 会去仓库找 `dsh-ops-board@0.1.0` 并 404 失败。它只靠
  `dsh.profile.bundles` + `node_modules/dsh-ops-board` 真实目录加载。
- **`pnpm install` 会删掉它**：不在 `dependencies` 里的目录会被当成孤儿清掉。装完别的插件后
  发现工作台没了，跑一次 `.\sync.ps1` 就回来了（源码一直在这里，报文在 `ops-board-reports`，都不会丢）。
- **Client 半边**：下次窗口加载生效（重启桌面端最稳）。桌面端没有“重新加载”菜单，
  `Ctrl+R` 在输入框有焦点时会被当成字符；不要依赖它。
- **Host 半边**：改 `index.js` 后，最稳的重载方式是让 loader 重新挂一次——
  把 `dsh-ops-board` 从 profile `package.json` 的 `dsh.profile.bundles` 里去掉，等 3 秒再加回去。
  （只改 `cordis.patch.yml` 的 config 有时也能触发热重载，但不保证。）

`/ops-board/state`、`/ops-board/ask` 都是**公开路由**，判断 host 是否换新：
`POST /ops-board/ask` 空 body 应返回 400（旧版没有这个路由，返回 404）。

## 自测

测试要解析 Harness 的 `@deepseek-ai/schemastery`，所以先在 profile 副本里跑：

```powershell
.\sync.ps1
$t = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ops-board\test"
node "$t\client-smoke.mjs"   # 插槽注册 / 面板渲染 / SSE 与 postMessage 桥 / 自动发送
node "$t\host-smoke.mjs"     # 两个看板：创建脚手架、增删、独立端口、代理、SSE ask、清理
```

`host-smoke` 会复制一份看板到系统临时目录、用临时注册表，不碰 8790 与真实清单。
它会检查新建出来的看板里 `scripts/serve.mjs` 是**转发入口**（不是整份副本）、没有 `scripts/lib/`、
且 `project.json` 记下了 `templateDir`。

各看板各自的渲染与静态自检（业务看板走转发入口，模板本身自包含）：

```powershell
cd <报文存放根>\<看板目录>
node scripts/render.mjs
node scripts/verify-board.mjs
```

交互验收（会开无头 Edge，需要看板服务在跑）：

```powershell
cd <报文存放根>\<看板目录>
node scripts/serve.mjs 8811          # 别用 8799：uitest 自己要占它做换源测试
$env:OPS_BOARD_URL = 'http://127.0.0.1:8811/'
node scripts/uitest.mjs
```

## 边界

- 看板服务进程归插件管：Harness 退出时只停它自己拉起的那些；`keepRunningOnExit: true` 可保留。
- 同一个看板目录只允许登记一次（按目录去重）。
- 看板页的「问 AI」就是问 Harness。看板自带的 Cloud AI 面板在 Harness 模式下不出现
  （`window.__OPS_HARNESS__` 存在时隐藏接入点与设置）；直接开裸页时那套代码仍在，但**不再是推荐路径**，
  后续会删掉。
- 「问 AI」不会复用看板自带 Cloud AI 的对话历史；它给 Harness agent 一份新上下文（看板目录 + 这一条的台账 + 默认问题）。
- 快捷动作一律**只填进输入框**，发不发由人按「发送」决定；这条在所有模式下一致。


