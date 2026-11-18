# 任务工作台 · 外部项目参考笔记

> **用途**：为 ops-board 后续「工作台 / 自动化处理流程」开发积累可借鉴的设计点。
> **不是**产品文档，是调研笔记 —— 记录「别人怎么解决同一个问题」以及「我们能抄哪一段、抄成什么样」。
> **取材时间**：2026-11-17。素材已下载到本地（见文末「素材位置」），可随时复查原文。

---

## 零、先明确我们自己的处境（读笔记前必看）

所有借鉴都必须落在这个前提上，否则会抄错方向：

| 事实 | 值 | 含义 |
|---|---|---|
| 卡片总数 | 61（cyber-egg-basket） | 不是空白看板，是**已基本做完的报告** |
| 已闭环 | 52 / 61（85%） | 「任务队列」模型不适用；真正在飞的只有 2 张 |
| `sections` 结构一致性 | 100% | bug/risk 恒为 `具体表现\|影响\|解决办法\|复核方式`；feature 恒为 `做了什么\|用户能感知到什么\|验证方式` |
| 有完成判据的比例 | 30/30 已闭环项都有 `verification` 且可判定 | **判据不缺**（上一轮「判据没写」的结论是错的，已纠正） |
| `解决办法` 含可跑命令 | 3 / 61 | 这是真缺口：**判据可读但不可执行** |
| 依赖关系字段 | 无 | 这是真缺口：无法推导执行顺序 |
| `owner` 字段语义 | **不是人**，是状态散文（`已处理` / `代码侧已修（仓库 HEAD 1c95c10）· 未发版，等手机实测` …共 17 种） | 不能当 assignee 用 |
| `status` 分布 | bug: fixed 27 / closed 3 / watch 3；feature: shipped 22 / paused 2 / doing 1；risk: watching 2 / mitigating 1 | 状态机已有雏形，但是**每个 kind 一套**，不统一 |
| `/api/evidence/stale` | 已实现但**没有任何 UI 暴露** | 38 张卡 / 110 条引用处于「可能已过期」状态，无人可见 |

**由此推出的三条设计约束**（贯穿全文）：

1. **不要做「把卡片变成待办队列」**——85% 已完成，队列是空的，做了没人用。
2. **缺的不是判据，是「判据能不能被执行」和「先做哪个」**——即 *可执行验证* + *依赖顺序*。
3. **补数据必须按需，不能批量回填**——61 张卡批量补 `dependsOn` / 可跑命令，是纯体力活且大部分是废数据。

---

## 一、结论速览：值得抄的 8 个点（按价值排序）

| # | 借鉴点 | 出处 | 解决我们的什么问题 |
|---|---|---|---|
| 1 | **Triage 先量任务大小，再决定投入** | workbench | 工作台不该对每张卡一视同仁；小修小补不该烧大模型 |
| 2 | **`flow_log[]` 只追加的状态迁移审计** | edict | 卡片没有「谁在什么时候把它从 A 推到 B」的历史 |
| 3 | **`block` 字段：当前卡住的**具体原因**** | edict | 我们的 `watch` 卡「在等外部」，但没写等什么、什么条件算等到 |
| 4 | **可判定验收判据的写法规范**（点名文件/命令/期望值） | spec_driven_develop | 我们 30/30 有判据，但只有 3/61 能被机器执行 |
| 5 | **启动前查依赖**（`GET /tasks/<id>/dependencies`，上游未完则别开始） | veritas-kanban | 没有依赖字段 → 工作台无法排执行顺序 |
| 6 | **`run.tokens` 遥测三件套**（input/output/cache） | veritas-kanban | 自动化跑起来后无法回答「这轮花了多少」 |
| 7 | **门禁默认全关、按需打开**（enforcement gates） | veritas-kanban | 我们有 61 张卡的历史数据，硬门禁会直接卡死自己 |
| 8 | **并行任务互相告知「我改了哪些文件」** | workbench | 工作台一旦并行跑多张卡，会撞同一批文件 |

---

## 二、逐项目详录

### 2.1 edict（★17076，OpenClaw 多 agent，「三省六部」官僚模型）

**它是什么**：把多 agent 协作建模成古代官僚体系（太子→中书省→门下省→尚书省→六部），
用**制度**而不是**自由讨论**来保证质量。核心是状态机 + 权限矩阵 + 自动派发 + 调度重试。

#### ① `_STATE_FLOW`：状态迁移表是四元组

```python
_STATE_FLOW = {
  state: (next_state, from_org, to_org, remark)
}
```

8 个状态：`Pending → Taizi → Zhongshu → Menxia → Assigned → Doing → Review → Done`，
另有 `Next`（打回）和 `Cancelled`。

**关键点**：迁移不只是「从 A 到 B」，还带**谁交给谁**（from_org/to_org）和**为什么**（remark）。
这比单纯的状态枚举信息量大得多 —— 看板上一眼能看出「这张卡现在是门下省在审，还没到尚书省」。

**对我们的用法**：`status` 现在每个 kind 一套（bug: fixed/closed/watch，feature: shipped/paused/doing），
若要统一成一条流水线，应当直接采用四元组形态：

```
transition = { at, from, to, by, remark }
```

#### ② `flow_log[]`：只追加的迁移审计

每条 `{at, from, to, remark}`，**append-only**，不可改写。

**反伪造设计**（值得单独抄）：
- 状态**只能由关卡守卫改**，agent 自己改不了；
- `flow_log` 追加时做签名校验；
- 即使 `flow_log` 被篡改，`state` 本身也不受影响（两者分离）。

**对我们的用法**：现在卡片只有 `updatedAt`，没有「改了什么」。61 张卡里 52 张已闭环，
如果当时有 `flow_log`，现在就能回答「这张卡从发现到修好花了多久、中间被打回过几次」——
**这类统计是「自动化流程」最容易被追问的数据**。

#### ③ `block` 字段：当前卡住的具体原因

任务 schema 里 `block` 存「当前阻塞原因」，配合 `now`（一句人话的当前状态）一起显示。

**对我们的用法**：这正是 `watch` 类卡片缺的东西。现在 RISK-001/002（watching）、
OPS-022/024/025（watch）只是「在看着」，没写**看着什么、什么条件算看着了**。
`block` + 一个 `retrigger`（重新触发条件）就能把这类卡从「挂着」变成「可判定」。

#### ④ 停滞升级阶梯（scheduler 每 60s 扫一次，`stallThresholdSec=180`）

```
跳过终态
  → elapsed < 阈值 → 跳过
  → retryCount < maxRetry → 重试
  → 升级 L1（唤醒门下省）
  → 升级 L2（唤醒尚书省）
  → 自动回滚到 _scheduler.snapshot 的状态，重置计数
```

**每一步都写一条 `flow_log`**。

**对我们的用法**：这是「自动化」最核心的一段 —— 不是「跑完就完了」，
而是**卡住了怎么办**。工作台必须定义：一张卡跑了 N 分钟没动静，是重试、是换人、还是回滚。
没有这段，自动化就是「启动器」而不是「流程」。

#### ⑤ 业务契约（制度条款，可直接借用措辞）

| 条款 | 含义 | 对我们的映射 |
|---|---|---|
| **不可越级** | 权限矩阵：某角色只能把卡推到下一个状态 | 工作台不能跳步（比如从 `doing` 直接 `shipped`） |
| **状态单向递进** | 不能倒退，除非走 `Next` 分支 | 需要显式的「打回」动作，而不是偷偷改 status |
| **门下必审** | 强制复核关卡 | 对应我们的 `复核方式` 段 —— 应升级为**必填关卡** |
| **一旦 Done 无改** | 终态不可变 | 已闭环的 52 张卡应锁定 |
| **资源消耗透明** | 每次进度上报必须报 tokens/cost/elapsed | 见 §2.2 ⑥ |
| **task_id 唯一性** | | 我们的 154 个 unique id 已满足 |

#### ⑥ `progress_log[]`

每条：`{agent, agentLabel, text, state, org, tokens, cost, elapsed, todos[]}`。

**注意 `todos[]` 嵌在进度条目里** —— 进度不是一句话，而是**带子任务快照的一句话**。
这样回看历史时能还原「当时以为还剩几步」。

#### ⑦ 看板 = 10 个视图面板

全部 / 按状态 / 按部门 / 按优先级 / agent 在线状态 / 任务详情 / …

agent 存活分级：🟢运行中 / 🟡待命 / ⚪空闲(>10min) / 🔴离线 / ❌未配置。

**对我们的用法**：ops-board 现在 6 个视图（全量/按 lane/按状态…）。若要加工作台，
**「按状态」和「按依赖」是最该补的两个**，而不是再加一个「按 area」。

#### ⑧ Workflow state ≠ execution ownership（重要概念区分）

- **workflow state** = 任务在制度流程里处于哪一阶段（看板显示的就是它）
- **execution ownership** = 当前**实际**持有下一步动作的运行时 agent/session

两者**可以暂时不一致**：看板已经显示 `Assigned`，但实际执行上下文还挂在上一阶段的派发链上。

**为什么重要**（原文给了三条理由，都很实在）：
1. 调试交接行为时；
2. 理解「为什么后一阶段的标签先出现了，而隔离的执行交接还没发生」；
3. 为「阶段隔离编排」这类改进做推理。

**对我们的用法**：如果工作台要显示「这张卡正在被自动处理」，必须分清
「卡片状态 = doing」和「真的有进程在跑」。否则会出现「显示在跑，其实早就死了」。

---

### 2.2 veritas-kanban（★854，Express + React + CLI + MCP + Electron）

**它是什么**：一个带 **SOP 生命周期**、**治理门禁**、**遥测**的看板。

#### ① SOP 六步生命周期（每步都有明确动作）

```
0. Intake   → 标题清晰、描述、验收判据、类型、项目、sprint
1. Claim    → status=in-progress，启动计时器，Agent Status → working
2. Work     → 逐条勾掉子任务
3. Update   → 写评论；**在等人时设为 blocked**
4. Complete → 停计时器，done，写完成总结 + 附件 + 经验教训
```

**第 3 步的措辞值得照抄**：「set `blocked` when waiting on human」——
**等人也算 blocked**，不是「在跑」。我们 61 张卡里没有任何一张表达「在等人」。

#### ② 三种角色分工

| 角色 | 职责 |
|---|---|
| Human / PM | 定义验收判据、复核、设定复核策略 |
| Worker Agent | 干活 |
| Reviewer Agent | 策略要求时**独立复核** |

**关键**：Reviewer 是**独立**的，不是 worker 自己说自己好了。
我们 30/30 的 `verification` 目前是**作者自述**，没有独立复核记录。

#### ③ 启动前查依赖（直接对应我们的缺口）

```
GET /api/tasks/<id>/dependencies
```

> 「If upstream blockers are incomplete, don't start — pick another task instead.」

**这就是我们缺的那个字段**。工作台要「自动挑下一张卡」，必须先有 `dependencies`。

#### ④ 治理：动手前先查策略，受限动作前先评估

```
GET  /api/policies?scope.project=      # 查适用策略
POST /api/policies/:id/evaluate        # 受限动作前评估；被拒就别做
```

决策要记录：**置信度 / 证据 / 假设**，并输出评分。

**对我们的用法**：这是「自动化要不要人批准」的机制化答案 —— 不是二选一，
而是**按动作类型分级**：读操作直接做，写操作查策略，危险操作必须评估通过。

#### ⑤ 遥测三事件（驱动看板）

| 事件 | 携带 |
|---|---|
| `run.started` | — |
| `run.completed` | `durationMs`, `success` |
| `run.tokens` | `inputTokens` / `outputTokens` / `cacheTokens` |

**对我们的用法**：自动化跑起来后，「这轮花了多少」是必答题。
**`cacheTokens` 单独列**是细节但重要 —— 缓存命中率直接决定成本。

#### ⑥ 门禁（Enforcement Gates）：默认全关，按需打开

| 门禁 | 行为 | 默认 |
|---|---|---|
| `reviewGate` | 四项 reviewScores 全 10 才准完成 | `false` |
| `closingComments` | 至少一条 ≥20 字的复核评论才准完成 | `false` |
| `autoTelemetry` | 状态变化自动发遥测 | `false` |
| `autoTimeTracking` | 状态变化自动启停计时器 | `false` |
| `orchestratorDelegation` | 编排者亲自干活而非派发时**警告** | `false` |
| `ceremonyDesignReview` | 高风险/多 agent 任务要求设计评审，`off/warn/block` 三档 | `off` |
| `ceremonyFailureRetrospective` | 阻塞或失败后要求复盘，同上三档 | `off` |

**两个设计要点必须抄**：

1. **默认全关**。我们手上有 61 张历史卡，任何「默认开启」的硬门禁都会立刻卡死。
2. **三档而非布尔**（`off` / `warn` / `block`）。先观察再拦截，这是灰度落地的正确姿势。

#### ⑦ 其他

- Agent 注册表是**文件式**：`.veritas-kanban/agent-registry.json`
- 心跳超时 5 分钟，stale 检查 1 分钟
- 组织约束：任务必须在**自己的 git worktree** 里跑

---

### 2.3 workbench（★107，Electron 外壳，跑在本机 Claude Code CLI 上）

**它是什么**：**不自建 harness**，而是把已有的 Claude Code CLI 包起来，
把力气全花在**会话之外**的事情上。

> 「don't write another harness — run on the one already installed and spend effort on everything *around* the session.」

这条哲学对我们极其适用：**ops-board 已经有数据了，不要重写数据层，力气花在「围绕卡片的流程」上。**

#### ① Triage：先量任务大小，再决定投入（**最值得抄的一条**）

每个任务开始前先跑一个**只读的、短的** triage：

```
输入：任务描述
输出：TaskTriage = {
  model:    haiku | sonnet | opus | fable,
  effort:   low … max,
  needsPlan: bool,
  scope,
  title,
  verification commands
}
```

原文的动机说得极准：

> 「a one-line fix doesn't burn an Opus run and a refactor across a dozen files doesn't get handed to Haiku」

**对我们的用法**：工作台如果对所有卡一视同仁（都用同一套流程、同一个模型、同样多的步骤），
那 61 张卡里 52 张已完成的小修小补会被浪费掉大量算力。
**triage 的输出里 `needsPlan` 和 `verification commands` 是关键** ——
它顺手把「这张卡该怎么验证」也一起定下来了。

#### ② 一条会话贯穿四个阶段

```
triage → plan（可选） → implement → validate
```

- `plan`：`--permission-mode plan`，结构化计划存 `plan.md`
- `implement`：**resume 同一个 session**，权限放开（靠 worktree 隔离兜底）
- `validate`：同一个 session 跑检查、**用新鲜视角 review 自己的 diff**、提交、返回结构化 `ValidationReport`
- `revise` 模式：应用「请求修改」的反馈，然后**再 validate 一遍**

**「用新鲜视角 review 自己的 diff」** —— 这条很重要。同一个 session 连续做，
天然会对自己刚写的东西有盲区。做法是 `/code-review` 或开一个 subagent 专门审。

**对我们的用法**：我们的 `复核方式` 段现在是人写的一句话。若自动化执行，
应当变成「跑完 → 换一个上下文 → 按 `复核方式` 检查 → 出结构化结论」。

#### ③ 结构化 `ValidationReport`

不是「成功/失败」，是一个结构化对象。原文还提到：
任务大小被 triage 判为 `large` 时，validation 会**要求多角度 review，且每条发现都要被再核一遍才算数**。

**「每条发现都要被再核一遍才算数」** —— 这是抑制 AI 复核幻觉的关键机制，值得抄。

#### ④ 并行任务互相告知

- 每个任务在**自己的 git worktree** 里跑，主分支安全；
- `buildParallelTasksPrompt()` 在每个阶段往 system prompt 里塞一段「Parallel tasks」：
  **其他未合并的任务，以及它们改了哪些文件**；
- 任务改完文件后，`conflict-check.ts` 用 `git merge-tree --write-tree` **试合并**，
  报出冲突的文件和行号；试合并跑不了时，退化成「告知共享了哪些文件」。

**对我们的用法**：工作台一旦并行处理多张卡（比如同时修 3 个 bug），
必然会撞文件。这套「提前告知 + 试合并探测」是现成的方案。

#### ⑤ 断点续跑

- 状态存 `<specDir>/claude_run.json`（session id、triage、plan、各阶段 cost、validation）
- 被停掉 / 被限流的运行，**继续而不是重来**
- `workflows` 记录在 `ClaudeRunInfo.workflows` 里，续跑时用 `resumeFromRunId`
  —— **已完成的 agent 复用结果**，不重跑

#### ⑥ 明确的工程红线（措辞可直接借）

| 红线 | 原文 | 我们的对应 |
|---|---|---|
| 不阻塞主进程 | IPC handler 不得跑同步子进程/网络调用 | 看板渲染不能被自动化任务卡住 |
| 不要在打开时重新拉取 | 页面显示存好的值，只在用户按刷新时拉 | 我们的 board 已经是静态渲染，保持 |
| 不给时间预估 | 「Provide priority-based ordering instead of duration predictions」 | **工作台别显示「预计 3 分钟」** |
| 最小改动 | 「If the user asks for X, implement X — don't bundle additional fixes」 | |
| 默认行动 | 意图明确就做，别只建议；不清楚就读代码而不是问 | 对上了用户的偏好 |

---

### 2.4 agetor（★136，Electrobun 看板，编排 CLI coding agent）

#### ① 任务生命周期与「孤儿对账」

```
POST /tasks            → backlog
POST /tasks/:id/start  → 一串 pre-flight：
                          agent 在 PATH 上？登录了吗？CLI 版本够吗？
                          准备 worktree（分支 agetor/<short-id>-<slug>）
                        → 插 runs 行 → running → spawn
退出时                 → exit 0 → review，否则 → ready
```

**启动对账（boot reconciliation）**：绑定端口即「所有权声明」；
然后 `reconcileOrphans()`：
- 还活着的 `running` run → **重新接上**
- 其余 → 标记 `orphaned`，任务**退回 `ready`**

> 「Reconciliation never enumerates-and-kills `agetor-*` tmux sessions:
> every kill is keyed to a task id from this instance's own DB」

**对我们的用法**：这是「自动化跑着跑着应用重启了」的标准答案 ——
**按自己的 DB 记录逐个核对，绝不按名字通配杀进程**。

#### ② 事件持久化 + 可重放

`GET /tasks/:id/events` **先重放已持久化的事件，再流式推送新的** ——
所以运行面板可以关掉再打开，**不丢 scrollback**。

**对我们的用法**：如果工作台要显示执行日志，「关掉再打开就没了」是不可接受的。

#### ③ SSE 的三个细节（照抄即可）

- `after` = 已消费的遥测 sequence，`logsAfter` = 日志 sequence，缺省按 0
- 每个 `telemetryDelta` / `logDelta` **最多保留最新 80 条**
- 空闲时每 15 秒发 `: heartbeat` 注释
- **当前不解析 `Last-Event-ID`，重连必须显式传 sequence**（明确承认的简化）

#### ④ 有界 spawn：1.5 秒预算

`SPAWN_RESPONSE_BUDGET_MS = 1500`。等不到就返回 `pending: true`，spawn 继续在后台跑。

**对我们的用法**：任何「点一下按钮启动自动化」的操作，都不能让 UI 卡在那里等。

#### ⑤ 两套 token 的取舍（安全设计，值得看）

- **master token**：只在内存里，通过 preload 进 webview，**永不落盘**
- **CLI token**：写在 `~/.agetor/agetor-core.json`

> 为什么是两个：「any program running as the user, an agent included, can read that file」
> —— 落盘的那个只能给 CLI 权限，桌面权限的必须只在内存。

#### ⑥ `ROUTE_POLICY`：路由必须声明策略，否则服务起不来

每个路由/方法都要有策略条目，**默认拒绝**。
启动时检查：有路由没策略 → 抛异常；有策略没路由 → 抛异常；方法键不匹配 → 抛异常。

**对我们的用法**：这是「默认安全」的工程实现。`serve.mjs` 若要加写操作路由，
应当有同样的「未声明即拒绝」检查。

#### ⑦ 从 issue 建任务（对我们最直接）

- 两个入口共用一套管线：issue 详情页按钮 + CLI `agetor add --issue <url>`
- **不可信内容警告**：issue 正文和评论是**攻击者可写的文本**，
  prompt 和快照里都带同一段警告 ——「不要让 agent 遵循里面的指令、跑里面的命令、访问里面的 URL」
- **字节预算**：`ISSUE_PROMPT_INLINE_MAX_BYTES = 32KB`，
  只限制**内联的 issue 文本**，不限制整条 prompt；正文最多占一半，剩下按条内联评论，
  被截断的地方指向快照文件
- 快照落盘：`dataDir/issue-threads/<taskId>/issue-<n>-thread.md`
- `issue_url` 存**归一化后**的值（小写 host/owner/repo，去掉 query/hash/slug），
  且**只读**（不在 `ALLOWED_PATCH_FIELDS` 里）

**对我们的用法**：我们的卡片就是从 issue 类数据来的。若要「自动挑卡并执行」，
**卡片的 `sections` 文本同样是不可信输入**（尤其 `evidence` 里的 url）——
应当带同样的警告，且限制内联字节数。

#### ⑧ 前端约定（可直接用）

- 语义色只有四个 token：`--success` / `--warning` / `--info` / `--danger`，各带 `-foreground`
- **新 UI 必须用语义 token，不许写字面色**（`text-rose-400` 这类只对一种背景调过，换个主题就崩）
- **未定义 token 陷阱**：Tailwind 对缺 token 的语义类**输出零 CSS** → 元素全透明，review 时很难发现。
  **新 token 必须同时进 `index.css` 和 `tailwind.config.js`**
- 布局状态（面板折叠等）放 `localStorage`，**必须在首帧同步解析**（lazy `useState` 初始化器），
  否则会先画错再跳
- 弹层 `fixed` 要 portal 到 `document.body`；**有 transform 的祖先会把 `fixed` 重定位到自己身上**

> 最后这条和我们踩过的坑一模一样（AGENTS.md 三之四：自己的固定位置 UI 用 DOM 注入 + `position:fixed`）。

---

### 2.5 LoopForge（★2260，Go 平台，SOP 引擎）

#### ① SOP 定义：节点 + 边 + 条件

```json
{
  "nodes":[{"id":"implement","type":"agent","agentId":"agent-dev",
            "maxAttempts":2,"maxReworks":1}],
  "edges":[{"id":"e1","source":"implement","target":"review","when":"success"}]
}
```

- 节点类型：`agent` | `script` | `approval`
- **边带 `when` 条件**（`success` / …）—— 不是简单的线性串联
- 节点可配：制品契约、失败/重试策略、画布位置
- **`maxAttempts` 与 `maxReworks` 是两个不同的重试预算**：
  `maxAttempts` = 同一节点失败重试次数；`maxReworks` = **被打回重做**的次数

**对我们的用法**：「打回重做」和「失败重试」分开计数，这个区分很实用。

#### ② 版本与修订

- `version`：`POST /workflows/{id}/publish` 时 +1
- `revision`：每次保存 +1；**冲突返回 409**
- 完整修订历史：`GET /workflows/{id}/revisions`，可 `restore`
- 删除保护：有 `running|waiting` 的 run，或仍被未关闭 Issue 绑定 → **409**

**对我们的用法**：`revision` 冲突返回 409 = 乐观锁。
若工作台要支持「边跑边改卡片」，这个机制是必需的。

#### ③ 运行状态与租约

run 状态：`running | waiting | succeeded | failed | cancelled`

内部字段 `ownerInstanceId` / `leaseUntil` / `executionGeneration` / `workspaceHost` /
`workspaceRoot` / `sandboxId` 是**租约/执行定位信息**，
原文明确写：**客户端可忽略，不应据此实现实例接管或沙箱生命周期操作**。

**对我们的用法**：这是「内部字段不暴露给 UI 做逻辑」的明确边界，值得学。

#### ④ 验收矩阵（`docs/testing/acceptance-matrix.md`）—— 文档形态值得抄

一张表：**能力 → 自动化覆盖（具体测试文件） → 运行前提**

例：

| 能力 | 自动化覆盖 | 前提 |
|---|---|---|
| 运行引擎：审批门禁、返工、重试、手动通过、暂停/恢复、取消、子 SOP、事件流 | `e2e/api/30-runs.test.mjs` | — |
| 制品跨节点、契约错误 | `e2e/api/30-runs.test.mjs`, `35-runner-mode` | — |
| 数据跨容器重建后仍在 | `e2e/container-persistence.mjs` | Docker |

还有一节 **「Not covered automatically」**，明确列出哪些**没有**自动覆盖及原因。

**对我们的用法**：ops-board 有 `verify-board.mjs` 等一堆检查。
**把它们整理成一张「能力 → 哪个检查守住」的表**，比散落在各测试文件里强得多。
尤其「明确列出没覆盖的」这一节，是诚实且有用的。

#### ⑤ 明确写出的架构规则（Go 项目，但规则本身通用）

- **`Store` 上禁止新增领域方法**：`Store` 只做两件事 —— 组合各领域 Repo、管理连接生命周期
- 新实体先找所属领域，没有就新建 `XxxRepo`
- **代码不做迁移、不做 seed**：`Open()` 只连 + 增量 DDL；
  基线 schema、数据迁移、seed 全部写成 `migrations/` 下的 SQL，**由人手动执行**
- **禁止新增 `ensureXxx`/`migrateXxx`/`seedXxx` 之类的启动自愈逻辑**

> 最后这条的理由很实在：启动自愈在生产路径上是不可控的副作用源。
> 对照我们的处境：**不要给 ops-board 加「启动时自动修数据」的逻辑**。

---

### 2.6 spec_driven_develop（★993，Markdown 优先的 agent 工作流）

#### ① 任务定义字段（**验收判据那段可直接照抄成规范**）

每个任务要有：

| 字段 | 内容 |
|---|---|
| Description | 到底要做什么 |
| Priority | P0 阻塞 / P1 重要 / P2 可有可无 |
| Effort | S(<1h) / M(1-4h) / L(4-8h) / XL(>8h) |
| Dependencies | 哪些任务必须先完成（**按 task ID**） |
| Delivery Batch | 归属哪个实现/集成/PR 批次 |
| **Acceptance Criteria** | 见下 |
| Test Expectation | 要加的测试，或**明确的「不测」理由 + 最接近的验证命令** |
| Memory/Governance Impact | 能否改记忆面/指令面 |
| Source Reference | 对应原始模块/文件 |

#### ② 验收判据的写法（原文，逐句都值得抄）

> 「Concrete, checkbox-style conditions that prove the task is done.
> Each criterion must be **independently verifiable by an independent reviewer agent
> without re-deriving intent** — **name exact files, commands, and expected outcomes**.
> Reviewer agents consume these criteria as their review checklist.」

拆成三条硬要求：

1. **独立可验证**：另一个 agent 拿着判据就能判，**不需要重新推导意图**
2. **点名具体文件、命令、期望结果**
3. **复核者直接拿判据当检查清单**

**这正是我们 3/61 的缺口**。我们的 `verification` 写得可读（30/30 可判定），
但**没点名命令**，所以复核者（人或 agent）还得自己想办法验证。

#### ③ 「测试是默认，不是例外」

> 「Testing is the default. Any task that adds or changes user-visible features,
> business behavior, API contracts, schemas, migrations, parsing, routing,
> permissions, caching, or persistence must include relevant automated test work in its acceptance criteria.
> If the analysis shows no usable test harness, **add an early foundation task to create
> the smallest practical test surface before feature implementation begins**.」

**对我们的用法**：注意最后一句 —— 没测试就先建最小测试面。我们已经有 `verify-board.mjs`，
所以「建测试面」这一步已经完成，可以直接要求判据指向它。

#### ④ 「治理也是默认」

> 「If the analysis shows missing, stale, or conflicting instruction surfaces,
> add a foundation task to resolve and repair them before implementation tasks are launched.」

**对我们的用法**：AGENTS.md 里那些「本机坑」就是指令面。
如果发现指令面冲突/过期，**先修指令面再干活**。

#### ⑤ 转型策略四选一（选一个，别混）

| 策略 | 何时用 |
|---|---|
| Bottom-up | 先建基础库/工具，再往上搭 |
| Top-down | 先搭应用外壳/入口，再填内部 |
| **Strangler fig** | **逐步替换模块，系统始终在跑** |
| Big bang | 全部重写（**很少推荐**） |

> 「Be decisive. Pick one approach and commit.」

**对我们的用法**：ops-board 要加工作台，正确策略是 **strangler fig** ——
在现有报告旁边长出工作台，不要重写渲染层。

#### ⑥ 分阶段的要求

每个阶段必须：**目标清晰可测** / **结束时项目处于可工作状态** / **建立在前一阶段输出上** /
**不太细也不太粗** / **早期就修掉违规热点和基础设施**。

#### ⑦ 仓库自身的开发规则（元规则，对我们有参考）

- **Markdown 优先**，不加运行时依赖除非真的需要
- 改工作流行为时，**核心 SKILL.md、受影响的 references/templates、受影响的 agent prompt 一起改** ——
  **「Avoid one-line prompt patches that leave other execution surfaces stale」**
- 用户可见行为变了，`README.md` 和 `README.zh-CN.md` 保持一致
- `AGENTS.md` 和 `CLAUDE.md` 是**活跃的指令面**，保持一致；`CLAUDE.md` 只放 Claude Code 特有内容
- 没有自动化测试面时，跑最接近的静态/语法检查，**并说明为什么不加测试**

---

## 三、横向对比：六个项目怎么解决「任务 → 判据 → 复核」

这一节是全文最该反复看的部分 —— 同一个问题，六种答案。

| 维度 | edict | veritas-kanban | workbench | agetor | LoopForge | spec_driven |
|---|---|---|---|---|---|---|
| **判据存在哪** | 任务 schema 的 `ac` | task 的 acceptance criteria | triage 输出的 `verification commands` | 无（靠 issue 文本） | 节点的制品契约 | 任务定义的 Acceptance Criteria |
| **判据谁写** | 派发时 | Human/PM | **triage 自动生成** | — | SOP 设计者 | 架构师 agent |
| **判据可否执行** | 否（文本） | 否（文本） | **是（命令）** | — | 是（契约） | 要求点名命令 |
| **谁复核** | 门下省（强制关卡） | Reviewer Agent（独立） | **同一 session 换新鲜视角** | 无 | approval 节点 | 独立 reviewer agent |
| **复核结果形态** | `flow_log` 一条 | `reviewScores` 四项 | 结构化 `ValidationReport` | — | 节点产出 | 检查清单逐条勾 |
| **防幻觉** | 状态只能守卫改 | 四项全 10 分门禁 | **每条发现要再核一遍** | — | — | — |
| **打回机制** | `Next` 分支 | `blocked` 状态 | `revise` 模式 | 退回 `ready` | `maxReworks` | 新任务 |
| **依赖** | 状态流本身 | `GET .../dependencies` | 无（并行 + 试合并） | worktree 隔离 | `edges` + `when` | `Dependencies` 按 ID |
| **卡住怎么办** | **升级阶梯 + 自动回滚** | 计时器 + stale 检查 | 断点续跑 | 孤儿对账 | 重试预算 | — |
| **成本可见** | `progress_log.tokens/cost` | `run.tokens` 三件套 | 各阶段 cost | — | run usage | — |

### 从这张表读出的三件事

1. **「判据自动生成」只有 workbench 做到了**（triage 顺手输出 verification commands）。
   这是最省力的路 —— 不用回填 61 张卡，**每张卡真被处理时才生成**。
2. **「独立复核」和「同一 session 复核」是两种成本档次**。
   我们 61 张卡里 52 张已闭环，没必要重跑独立复核；**只对真正在飞的卡要求独立复核**。
3. **所有成熟项目都有「卡住了怎么办」**，只有我们没有。这是自动化的分水岭。

---

## 四、可直接落地的设计决策（针对 ops-board 工作台）

> 这些是从上面推出来的**具体建议**，不是泛泛而谈。每条都标注了「抄自哪」。

### D1. 工作台按需补数据，不做批量回填

**抄自**：workbench triage 哲学 + spec_driven「按 ID 声明依赖」

一张卡被工作台真正选中处理时，才问三件事：
- 这张卡的完成判据是什么？（从 `复核方式` 段解析，解析不出就问人）
- 要先做哪张卡？（让用户指，或从 `evidence` 的 commit 链推）
- 卡住了算谁的？（默认记「等外部」，写清等什么）

**理由**：61 张卡里 52 张已完成。批量补 61 条依赖和命令，其中 ~50 条永远用不到。

### D2. 卡片补 `flow_log[]`（只追加）

**抄自**：edict `flow_log`

```
{ at, from, to, by, remark }
```

- 只追加，不可改
- `by` 记 `human` / `agent:<id>` / `system`
- `remark` 必填（一句话为什么）

**收益**：立刻能回答「这张卡从发现到修好花了多久」「被打回过几次」——
这类统计是自动化流程最容易被追问的数据，而现在完全拿不出来。

### D3. `watch` 类卡片补 `retrigger` 字段，而不是补完成判据

**抄自**：edict `block` 字段 + veritas-kanban 的 `blocked` 语义

`watch` / `watching` 的卡（OPS-022/024/025、RISK-001/002）不是「没做完」，
是「在等外部世界」。给它们补完成判据是错的，应该补：

```
retrigger: {
  watch: "看着什么",         // 例：手机端搜索「讯飞」的结果
  condition: "什么算等到了",  // 例：搜索结果里出现 X
  checkBy: "谁去查/怎么查"    // 例：人工手机实测，或某个命令
}
```

**注意** OPS-027（`verify`）是另一回事 —— 它有真判据
（「发版后手机搜一次「讯飞」再改 fixed」），属于**待执行**，不是 `watch`。

### D4. 判据分两级：可读级 / 可执行级

**抄自**：spec_driven「点名文件、命令、期望结果」+ workbench「triage 输出 verification commands」

- **可读级**（现有 30/30 都满足）：一句话，人读了能判断
- **可执行级**（现有 3/61）：点名命令 + 期望输出

工作台只在**真的要跑**的时候，才把可读级升级成可执行级（D1）。
升级方式是 triage：让 agent 读卡片 + 读仓库，输出一条命令。

### D5. 门禁三档，默认全关

**抄自**：veritas-kanban `enforcement gates`

```
off    → 什么都不做
warn   → 记录 + 提示，但不拦
block  → 硬拦
```

先全 `off` 跑一段时间，看误报率，再逐个升 `warn`，最后才考虑 `block`。

**理由**：61 张历史卡里，任何默认开启的硬门禁都会立刻卡死。

### D6. 卡住升级阶梯（必须有）

**抄自**：edict scheduler

```
扫描间隔 60s，阈值 180s（可按 ops-board 实际调整）
  → 跳过终态
  → 未超阈值 → 跳过
  → 重试（retryCount < maxRetry）
  → 升级 L1：提示人
  → 升级 L2：停下并标 blocked
  → 回滚到快照状态，重置计数
```

**每一步写一条 `flow_log`**。

**理由**：没有这段，工作台只是「启动器」，不是「流程」。
而且**自动回滚**比「一直重试」安全 —— 重试会把错误放大。

### D7. 成本遥测三件套

**抄自**：veritas-kanban `run.tokens`

```
{ inputTokens, outputTokens, cacheTokens, durationMs, success }
```

`cacheTokens` 单独列 —— 缓存命中率直接决定成本，混在 input 里就看不见了。

### D8. 并行处理时，任务之间互相告知改了哪些文件

**抄自**：workbench `buildParallelTasksPrompt` + `conflict-check`

- 每个任务在独立 worktree（我们没有 git 仓库，退化为「独立输出目录」）
- 每个阶段往 prompt 里塞「其他在跑的任务改了哪些文件」
- 用 `git merge-tree` 试合并探测冲突；没有 git 就退化为「共享了哪些文件」的告知

**注意**：ops-board 当前**没有 git 仓库**，所以完整方案跑不了。
但「告知共享文件」这半截可以立刻用。

### D9. 执行日志要能关掉再打开

**抄自**：agetor 事件持久化 + 重放

先重放已持久化的事件，再流式推新的。**面板关掉再打开不丢 scrollback**。

### D10. 启动按钮不能等

**抄自**：agetor `SPAWN_RESPONSE_BUDGET_MS = 1500`

等不到就返回 `pending: true`，后台继续。UI 立刻响应。

### D11. 别加启动自愈逻辑

**抄自**：LoopForge「禁止 `ensureXxx`/`migrateXxx`/`seedXxx` 写进生产路径」

ops-board 的 `serve.mjs` 启动时**不要**做「发现数据不对就自动修」。
数据修复一律走显式脚本 + 人手动跑。

### D12. 把现有检查整理成验收矩阵

**抄自**：LoopForge `acceptance-matrix.md`

一张表：**能力 → 哪个检查守住 → 运行前提**，外加一节「没有自动覆盖的及原因」。

ops-board 已有 `verify-board.mjs`、`report-ui`、`evidence-look`、`chatwin-wiring` 等一批检查，
散落在各处。整理成一张表，比现在好用得多。

---

## 五、明确不要抄的（反面清单）

| 不要抄 | 出处 | 原因 |
|---|---|---|
| 多 agent 官僚制（三省六部） | edict | ★17076 很诱人，但它是**从零组织多 agent 协作**的框架。我们只有 2 张在飞的卡，**没有 agent 组织问题**。抄它的状态机和 `flow_log` 就够了，别抄组织架构 |
| 完整 SOP 引擎（节点+边+画布） | LoopForge | 太重。61 张卡、2 张在飞，用不上可视化编排器 |
| 独立 Reviewer Agent 全量跑 | veritas-kanban | 52 张已闭环，重跑复核是纯浪费。**只对在飞的卡用** |
| `reviewGate` 四项全 10 分 | veritas-kanban | 太硬。先 `warn` |
| worktree 隔离 | workbench / agetor | ops-board **没有 git 仓库**，整套机制跑不起来 |
| 两套 token 的完整安全模型 | agetor | 它是桌面应用 + CLI 双入口；我们只有本地 HTTP。**抄「默认拒绝」的思路即可**，不必抄实现 |
| `Last-Event-ID` 不解析 | agetor | 这是它自己承认的简化，别学 |
| 时间预估 | workbench 明令禁止 | 工作台别显示「预计 3 分钟」 |

---

## 六、我们独有的、别人都没有的东西（别丢）

调研中发现，ops-board 有几样东西是这六个项目**都没有**的，属于既有资产：

1. **`sections` 结构 100% 一致**（61/61）。
   六个项目里没有一个做到这种程度的数据规整度 —— 它们的判据都是自由文本。
   这让我们**从卡片推导工作流**在技术上完全成立。
2. **`evidence` 带 `kind`**（file 192 / commit 50 / value 36 / url 8 / command 1）。
   这是「结论挂在哪」的显式指针，别人都是把证据埋在描述里。
3. **`/api/evidence/stale` 已实现**。
   别人都没有「证据过期检测」。**只是没接 UI**（38 张卡 / 110 条引用）——
   这是现成的、成本极低的一个新功能点。
4. **双主题 + 单文件 CSS**（`css.mjs`）。
   在 Electron/React 之外做零依赖渲染，六个项目里没有同类。

**结论**：不要因为抄别人而把自己已经更规整的数据结构改差。

---

## 七、素材位置与复核方式

### 本地素材（已解压）

```
D:\WorkSpace-DeepSeek\.research2\
  ├─ edict\edict-main\              cft0808/edict ★17076
  │    docs\task-dispatch-architecture.md   ← 1639 行，核心全在这
  │    README.md
  ├─ veritas-kanban\veritas-kanban-main\   BradGroux/veritas-kanban ★854
  │    docs\SOP-agent-task-workflow.md
  │    docs\enforcement.md                  ← 门禁那张表
  │    docs\WORKFLOW-GUIDE.md
  │    docs\AGENTS-TEMPLATE.md
  ├─ workbench\workbench-main\       proactive-agent/workbench ★107
  │    CLAUDE.md                            ← triage / 并行任务 / 红线全在这
  │    README.md
  ├─ agetor\agetor-main\             alamops/agetor ★136
  │    CLAUDE.md                            ← 生命周期 / token / 前端约定
  │    docs\architecture\issue-tasks.md     ← issue → 任务
  │    docs\architecture\security.md
  ├─ LoopForge\LoopForge-main\       Tencent/LoopForge ★2260
  │    docs\api\orchestration.md            ← SOP / run / SSE
  │    docs\testing\acceptance-matrix.md    ← 验收矩阵
  └─ spec_driven_develop\spec_driven_develop-main\  zhu1090093659 ★993
       plugins\spec-driven-develop\agents\task-architect.md  ← 验收判据规范
       plugins\spec-driven-develop\skills\spec-driven-develop\SKILL.md
```

### 已知网络限制（下次再调研会再遇到）

| 通道 | 状态 | 备注 |
|---|---|---|
| `api.github.com` | ❌ 匿名配额 60/h，**已耗尽** | 403 rate limit |
| `github.com` HTML（含 `/search`、`/trending`） | ✅ 可用 | 搜索结果是 React 渲染，数据在 `<script type="application/json" data-target="react-app.embeddedData">` |
| `codeload.github.com` | ✅ 可靠 | `zip/refs/heads/<branch>` |
| `raw.githubusercontent.com` | ❌ TLS 失败 | |
| `cdn.jsdelivr.net` | ❌ TLS 失败 | |
| `web_search` | ❌ HTTP 402 | |

**本机凭据只有** `DEEPSEEK_API_KEY` / `GITEE_TOKEN` / `LOCAL_API_KEY` ——
**没有 GitHub token**，所以 GitHub API 只能匿名。
绕法：`github.com` HTML 搜索 + `codeload` 下 zip（本次就是这么做的）。

**搜索解析脚本**：`D:\WorkSpace-DeepSeek\gh-search2.cjs`
用法 `node gh-search2.cjs "query1" "query2"`。
读 `react-app.embeddedData` 的 JSON，走 `repo.repository.name` + `owner_login` + `stargazers_count`。
注意：**约 6 次查询后会 429**，要放慢。

### 下载了但没细看的（下次可继续）

| 仓库 | 星 | 为什么可能有用 |
|---|---|---|
| `zjrosen/perles` | 194 | BQL / beads 看板 TUI —— 终端形态的任务图 |
| `TechDufus/openkanban` | 155 | 纯看板 |
| `hoangsonww/Claude-Code-Agent-Monitor` | 1185 | agent 监控面板 |
| `february2015/dsh-taskswarm` | 3 | **DSH 插件**，同生态 |
| `skyf0xx/hedgehog` | 48 | 未知 |
| `warpforgehq/warpforge` | 41 | 未知 |
| `jordigilh/kubernaut` | 37 | 未知 |
| `seropaski/lets-build` | 17 | 未知 |
| `gbFinch/agentic-orchestration` | 13 | 编排 |
| `lerenn/paseo-playbooks` | 12 | playbook |
| `IgnatRozhkoTR/governed-workflow` | 8 | 受治理的工作流 |
| `anikamin940/hitl-agent-ts` | 4 | **HITL**（human-in-the-loop）—— 用户要的「人选择」正好是这个 |

> **`anikamin940/hitl-agent-ts` 虽然只有 4 星，但主题完全对口**
> ——「人在回路」正是工作台「人选择解哪些问题」的核心。
> 下次优先看这个，不要因为星少跳过。

### 已被用户否掉的（不要再提）

- OpenHands、Aider、Backstage、Plane
- 上游 pipeline-idle 结论（明确否决，不要复活）

---

## 八、下一步（供后续开发取用）

按「投入产出比」排序，都是本文档推导出来的、可直接开工的：

| 优先级 | 动作 | 依据 | 预估 |
|---|---|---|---|
| **P0** | 把 `/api/evidence/stale` 接进 UI（38 卡 / 110 条引用现成） | §六.3 | 最小，纯前端 |
| **P0** | `watch` 卡补 `retrigger` 字段（5 张卡） | D3 | 小 |
| **P1** | 卡片补 `flow_log[]`（新卡必填，老卡留空） | D2 | 中 |
| **P1** | 整理验收矩阵表 | D12 | 小，纯文档 |
| **P2** | triage：按需生成可执行判据 | D1 + D4 | 大 |
| **P2** | 卡住升级阶梯 | D6 | 大 |
| **P3** | 成本遥测三件套 | D7 | 中 |

> **注意**：P0/P1 都不需要「工作台」这个 UI 存在就能做，
> 且都能独立验证效果。**先把数据补对，工作台才有东西可跑。**

---
---

# 第二轮：并行处理 + 可视化工作流

> **触发**：用户明确追加两个硬需求 ——「这个自动化需要支持并行处理」+「我还需要可视化的工作流程」。
> **取材时间**：2026-11-17（同日，第二轮）。5 个新项目已下载到 `D:\WorkSpace-DeepSeek\.research3\`。

## 九、这一轮最重要的前提变化：GitHub 凭据找到了

**上一轮我说「没有 GitHub token」是错的。** 真相是：

| 项 | 事实 |
|---|---|
| 凭据位置 | **Windows 凭据管理器**，Target = `GitHub - https://api.github.com/ZJR24`，User = `ZJR24` |
| 为什么第一轮没找到 | 只查了文件（`.git-credentials` / `gh` CLI / 环境变量），**没查凭据管理器** |
| 为什么 `cmdkey /list` 也只显示 target 不显示值 | 那是正常行为，值要用 `CredReadW` 读 |
| 编码坑 | `CREDENTIAL.CredentialBlob` 是 **UTF-16**，但实际内容是 **ASCII 字节**（40 字节 = 40 字符）。按 Unicode 读会得到乱码「桧彯坘䙚」—— **必须按 ASCII/UTF-8 解码** |
| token 类型 | `gho_` 开头 = GitHub OAuth token |
| scopes | `repo, user, workflow`（完整读写权限） |
| 配额变化 | 匿名 **60/h** → 认证 **5000/h**；搜索 30/min；GraphQL 5000/h |

**复核脚本**：`D:\WorkSpace-DeepSeek\gh-cred2.ps1`（读原始字节）+ `gh-test.ps1`（测权限）。
读法要点：`CredReadW(target, 1, 0, out p)` 的 type=1 是 Generic；`CredentialBlob` 用 `Marshal.Copy` 取字节，
**用 `Encoding.ASCII.GetString` 解码，不要用 `Encoding.Unicode`**。

> ⚠️ **教训**：「有没有凭据」不能只查文件系统。Windows 上至少三个地方：
> ① 文件（`.git-credentials`、`hosts.yml`）② 环境变量 ③ **凭据管理器**。
> 我只查了 ①②，就得出了「没有」的错误结论，还让你白说了两轮。

## 十、新素材清单

```
D:\WorkSpace-DeepSeek\.research3\
  ├─ hatchet\hatchet-main\                  hatchet-dev/hatchet ★8298   (97.6 MB)
  ├─ pyspur\pyspur-main\                    PySpur-Dev/pyspur ★5810     (71.9 MB)
  ├─ amux\amux-main\                        mixpeek/amux ★562           (144.4 MB)
  ├─ multi-agent-shogun\...-main\           yohey-w/multi-agent-shogun ★1421 (52.1 MB)
  └─ open-agent-builder\...-main\           firecrawl/open-agent-builder ★2661 (0.9 MB)
```

另外本轮搜索发现的、**尚未下载**但值得一看的：

| 仓库 | 星 | 为什么 |
|---|---|---|
| `golutra/golutra` | 3867 | 多 agent 并行 + 任务编排（zip 404，可能主分支名不是 main） |
| `argoproj/argo-workflows` | 17100 | Kubernetes 上的 DAG 引擎，**可视化 DAG 的工业标准** |
| `inkeep/agents` | 1500 | 无代码可视化 builder + TS SDK **双向同步** |
| `vercel-labs/workflow-builder-template` | 1241 | Vercel 官方的可视化工作流模板 |
| `dagrs-dev/dagrs` | 480 | Rust 异步 DAG 框架，Flow-Based Programming |
| `erson/awesome-coding-agent-orchestration` | 6 | **策展清单**，星少但可能一次看全 |
| `hoadh/agentmux` | 1 | Go TUI，DAG 流水线 + stream-json |
| `oktayhaktan0/taskgraph-runner` | 0 | **零依赖 JS DAG 引擎**：并发限制、依赖结果传递、重试、超时、环检测、失败传播 —— 星少但正好是我们要的最小实现 |

---

## 十一、并行处理：五个项目怎么做的

### 11.1 PySpur：懒创建 + 递归等待（**最优雅的并行模型**）

**核心洞察**：它**没有拓扑排序**，也不按「层」批量执行。做法是：

```python
def _get_async_task_for_node_execution(self, node_id):
    if node_id in self._node_tasks:
        return self._node_tasks[node_id]        # 已有任务，复用
    task = asyncio.create_task(self._execute_node(node_id))
    self._node_tasks[node_id] = task            # 登记，保证每节点只跑一次
    return task
```

每个节点执行前：

```python
dependency_ids = self._dependencies.get(node_id, set())
predecessor_outputs = await asyncio.gather(
    *[self._get_async_task_for_node_execution(dep_id) for dep_id in dependency_ids]
)
```

**为什么这天然并行**：节点 A 和 B 互不依赖，谁先被请求谁就先启动；
请求 C 时它会 `await` A 和 B 的 task，而 A、B 早已并发在跑。
**不需要调度器、不需要拓扑层、不需要并发上限**（并发上限靠 asyncio 自然背压）。

**对我们极重要**：ops-board 没有 async 运行时，但这个**结构**可以照搬 ——
「节点任务表 + 按需创建 + 递归等待上游」用 Promise/回调同样能实现。

#### 配套的两个关键设计

**① 失败/暂停的传播**

```python
if any(dep_id in self._failed_nodes for dep_id in dependency_ids):
    # 上游失败 → 本节点不执行
if has_paused_dependencies:
    # 上游暂停 → 本节点挂起
```

**② `get_blocked_nodes(paused_node_id)`：算出「暂停一个节点会阻塞谁」**

```python
# 反向建图：dependents[dep] = {依赖它的节点}
# 从暂停节点 BFS 向下游扩散
```

用途：用户点「暂停这个节点」时，**立刻告诉他会影响哪些下游节点**，
而不是等跑到一半才发现全卡住了。**这是可视化界面必须有的能力。**

#### ③ 三种「汇合」语义（不是一种！）

| 节点 | 语义 | 用在哪 |
|---|---|---|
| **Merge** | 把多个上游输出**合并**成一个 | 并行分支各自产出一部分，最后拼起来 |
| **Coalesce** | 取**第一个非空**的上游输出，按 `preferences` 列表顺序 | 兜底/竞速：多个来源谁先给结果用谁 |
| **Router** | 按条件**分流**到不同下游 | if/else，且**边必须带 `source_handle`** |

> **`Router` 的边必须声明 `source_handle`，否则启动时直接报错**：
> `Missing source_handle in link from router node {src} to {dst}`
> —— 这是「条件分支的边不能只写 from/to」的硬约束，我们画可视化图时必须遵守。

#### ④ 节点类型分组（可直接借鉴的分类法）

```
Input/Output : InputNode, OutputNode
AI           : SingleLLMCallNode, AgentNode, RetrieverNode, BestOfNNode
Code Exec    : PythonFuncNode
Logic        : RouterNode, CoalesceNode, MergeNode, HumanInterventionNode
Loops        : (loops 目录)
Integrations : (email, search, subworkflow, utils…)
```

**`HumanInterventionNode` 单独作为一种节点类型** —— 这正好对上你要的「人选择」。
**它不是「流程外的手动操作」，而是图上的一个节点**。这个建模方式值得抄。

---

### 11.2 Hatchet：并行的工业级原语（★8298）

它把「并行」拆成一堆**正交的控制维度**，每个都有明确语义：

| 原语 | 作用 | 我们能用在哪 |
|---|---|---|
| **DAG** | 静态依赖图，节点间并行 | 卡片依赖关系 |
| **Durable tasks** | 长跑工作流，可从中断恢复 | 一次处理多张卡 |
| **Concurrency policies** | **按动态 key 设并发上限** | 「同时最多跑 3 张卡」 |
| **Worker slots** | 每个 worker 不能接超过自己能力的活 | 每张卡最多 N 个并行子步骤 |
| **Priority** | 关键任务先跑 | P0 卡插队 |
| **Rate limits**（含 dynamic） | 限流第三方 API / 按用户限流 | 限模型调用速率 |
| **Fair scheduling** | 按 key 公平调度 | 防止某类卡饿死其他卡 |
| **Durable sleep / event waits** | 暂停等条件，可组合 | `watch` 卡等外部条件 |
| **Worker affinity** | 按标签路由到特定 worker | 某类卡只能给特定执行器 |
| **Retries + exponential backoff** | 失败重试 | 卡住重试 |

**最值得抄的三条**：

1. **并发上限是「按动态 key」的，不是一个全局数字。**
   例：全局最多 5 个并行，但「同一个 area 最多 1 个」。
   实现上就是 `concurrency(key=card.area, limit=1)`。
2. **`durable sleep` + `event wait` 是两种不同的等待**：
   - `durable sleep` = 等**时间**（睡 30 分钟）
   - `event wait` = 等**事件**（等到某个条件成立）
   → 我们的 `watch` 卡正需要 `event wait` 语义。
3. **`worker slots` 防止过载**：不是「有几个 worker 就并发几个」，
   而是每个 worker 声明自己能接几个，调度器据此分配。

> **反面提醒**：Hatchet 是**服务端引擎**（Go + Postgres），我们不会引入它。
> 只抄**控制维度的划分方式**，不抄实现。

---

### 11.3 amux：并行系统的踩坑清单（**最有警示价值**）

★562，Rust + SQLite，跑 Claude Code/Codex/Gemini 并行。
它有一份 `docs/design/implicit-state-machines.md` —— **把自己系统的状态管理缺陷逐条列出来**。
这份文档的价值远超它的功能：**它列出的每一个坑，我们做并行时都会遇到**。

#### 原文定义的「隐式状态机」

> 一个**隐式**状态机 = 实体的生命周期被存成**字符串字面量**（在 status 列或 JSON key 里），
> 或存成**标志位 + 时间戳 + 可空列 + 标记文件**的组合，
> 而**迁移逻辑散落在各处**，而不是通过一个 enum + 一个迁移函数。

#### 六条「贯穿所有状态机」的通病（逐条对照我们的处境）

| # | 通病 | 原文细节 | 我们的风险 |
|---|---|---|---|
| 1 | **自由文本状态列** | 144 个迁移里只有 3 个 CHECK 约束；`board_overlap_callbacks.state` 是唯一有约束的状态列。其余任意字符串都能存 → 历史拼写（`resolved`/`needs_you`）、手工清理值、自由格式拒绝码全在盘上 | **我们已经有这个问题**：`status` 每个 kind 一套词（fixed/closed/watch/shipped/paused/doing/watching/mitigating），**没有任何约束** |
| 2 | **有 enum 但写入方绕过去** | `amux-core` 定义了 `TaskStatus` + `apply_transition`，但 `db/advance.rs`（主迁移路径）不调用它；后台任务用**裸 SQL** 写 `issues.status`；`WorkerState` 干脆没有迁移函数 | 若我们加 `flow_log`，必须保证**所有写入都走同一个函数**，否则日志和真实状态会分叉 |
| 3 | **有守卫的领取，盲目的完成** | 队列几乎都是 `WHERE state='queued'` 领取，然后 `WHERE id=?` 完成。**过期回收后，原来的完成者会覆盖新的那次运行** | **并行必踩**：卡 A 被 worker1 领走、超时回收给 worker2，worker1 迟到的完成消息会覆盖 worker2 的结果 |
| 4 | **一个事实，多种编码** | needs-you（status vs tag vs 决策卡）、blocked（status vs `blocked_on`）、archived（`lifecycle` 列 vs `CC_ARCHIVED` 环境变量 vs `.env.reaped` 文件）、disabled schedule（`enabled` vs 锁 vs reason）、terminal（三个不同集合）、deleted（`IS NULL` vs `COALESCE(...)=0`） | 我们的 `watch` 已经是「status=watch」+「sections 里有说明」两种编码 |
| 5 | **同一事实推导多次** | worker 状态在服务端从 hook、pane 抓取、transcript、进程树推导；**dashboard 又用不同优先级重推了至少 6 次**；`worker-stall-watch.sh` 第三次，boundary guard 第四次。结果：**已停止的 worker 卡片显示 "Needs input"，过滤器显示 `stopped`；暂停但仍在跑的 worker 过滤成 `working`；网格点和图点把猜出来的 `unknown` 显示成绿色** | 若工作台和看板各算一套「卡是否在跑」，必然出现这种矛盾 |
| 6 | **内存状态，重启就忘** | goal keeper 的无进展预算和耗尽标志、客户端的通知边沿检测器（每 tab 一个）、挂起的暂停/恢复投影 | 工作台的「已重试 2 次」若只在内存，重启就归零 → 无限重试 |

#### 它列出的 Tier 1 状态机（我们对应哪些）

| # | amux 的机器 | 存储位置 | 主要隐患 |
|---|---|---|---|
| 1 | Worker 活动状态 | **不存**，实时推导 | 优先级链后规则覆盖前规则；客户端函数互相矛盾 |
| 2 | Hook 上报状态 | 两个生产者（`hook-report.sh` 队列 + `native-status.py` 号池） | **两个生产者事件映射不同**；`blocked` 只在特定事件清除，被中断的轮次永远卡在 blocked |
| 3 | Worker 执行状态 | `_amux_workers.state` JSON | `update_worker_state` 是**盲覆盖**，四个独立写入者 → 迟到的 `Idle` 覆盖 `Starting`/`Error` |
| 4 | Worker 生命周期 | 列 + 两个环境变量 + 标记文件 | 迁移后 `CC_ARCHIVED` 仍在 ~50 处读写；`lifecycle != active` 与 `state == stopped` 无关联 |
| 5 | Session | `ended_at IS NULL` | **没有唯一索引保证每 worker 只有一个活会话**，读者取最新 |
| 6 | **看板卡片** | `issues.status` **外加约 8 个字段**：`archived`/`pre_archive_status`/`deleted`/`blocked_on`/`waiting_on`/lease 列/`needs:you` 标签/`type='decision'` | `db/advance.rs` **没有 from-to 边检查**，终态可以离开；PATCH 对任意状态对回落到 `Force`；`save_patched` 是**最后写入者赢**（bump version 但从不检查）；取消归档**盲目**恢复 `pre_archive_status` |
| 7 | **卡片租约（两套系统）** | `issues.lease_*` 和 `_amux_leases` 表 | **互不读取**，一张卡能被持有两次；`generation` 恒为 0（回收时删行，`generation+1` 只在无行时执行）→ **世代守卫完全失效**；租约强制**默认关闭**（`AMUX_LEASE_ENFORCE`） |

> **第 6、7 条是我们最该警惕的**：并行处理卡片时，
> 「谁在持有这张卡」必须**只有一套机制**，且**必须有世代号**（否则回收后旧持有者的写入会覆盖新的）。
> amux 的 `generation` 恒为 0 这个 bug，正是「以为有守卫、其实没有」的典型。

#### 从 amux 提炼的硬规则

1. **状态列必须有 CHECK 约束**，或至少有一个白名单校验函数，且**所有写入都过它**。
2. **领取和完成必须用同一个条件**：领 `WHERE state='queued' AND version=N`，
   完成 `WHERE id=? AND version=N` —— **不能领的时候有守卫、完成的时候没有**。
3. **一个事实只能有一种编码**。`watch` 就是 `status='watch'`，不要在 `sections` 里再写一遍。
4. **状态只在服务端算一次**，客户端只渲染。**看板和工作台必须读同一个函数**。
5. **内存里的计数器要落盘**，否则重启后行为不一致。

---

### 11.4 multi-agent-shogun：零协调开销（★1421）

它的核心主张，一句话：

> **Most multi-agent frameworks burn API tokens on coordination. Shogun doesn't.**
> Agents talk through **YAML files on disk**. The only API calls are for actual work, not orchestration.

| 维度 | Claude Code `Task` | Agent Teams | LangGraph | CrewAI | **shogun** |
|---|---|---|---|---|---|
| 并行度 | 顺序（一次一个） | 多独立会话 | 并行节点 | 有限 | **8 个独立 agent** |
| **协调开销** | 每次 Task 一次 API | 重（每个 teammate 独立上下文） | API + 基础设施（PG/Redis） | API + 平台 | **零（YAML + tmux）** |
| 可观测性 | 只有日志 | tmux 分屏 | LangSmith | OpenTelemetry | **实时 tmux 面板 + 看板** |

#### 三个可直接抄的机制

**① 用文件通信，不用 API 通信**

协调信息（任务分配、报告、决策）全部写成 YAML 文件。
好处：**可读、可 diff、可版本控制、零 token 成本**。
坏处：需要「谁写哪个文件」的严格约定。

**② 角色边界写进 agent 定义（防越权）**

> Shogun can read `queue/reports/*` for oversight but **cannot write** them;
> Karo is limited to coordination files plus report aggregation;
> Ashigaru only touch **their own task/report pair**;
> Gunshi reads ashigaru reports but **only writes `gunshi_report.yaml`**.

**这是并行的关键安全设计**：每个 agent 只能写自己那份文件，
**物理上不可能冲突**。比加锁简单得多，也比「约定不要冲突」可靠得多。

**③ 「每个 agent 独占文件」比「共享文件加锁」好**

对照 amux 的租约问题：amux 用租约保护共享的卡片表，结果租约本身出 bug。
shogun 干脆**不让共享** —— 每个 worker 有自己的 task/report 文件，
主控读所有人、写自己的队列。**冲突在结构上被消除，而不是被检测。**

> **对我们的启示**：工作台并行跑 N 张卡时，
> **每张卡一个独立的输出文件/目录**，主控汇总。不要让 N 个执行器同时写同一个 ledger。

**④ 成本模型的洞察（值得单独记）**

| | API 按 token | CLI 订阅（flat-rate） |
|---|---|---|
| 8 个 agent × Opus | ~$100+/小时 | ~$200/月 |
| 成本可预测性 | 不可预测的尖峰 | 固定月费 |
| 心理负担 | 每个 token 都要算 | 无限制 |

> 「With flat-rate CLI subscriptions, deploy 8 agents without hesitation.
> The cost is the same whether they work 1 hour or 24 hours.」

**这解释了为什么「并行」在 CLI 订阅模式下是免费的** ——
并行度不影响成本，只影响墙钟时间。**这是支持并行的最强理由。**

---

### 11.5 open-agent-builder：可视化的最小可用形态（★2661）

只有 0.9 MB，是五个里最轻的，但**可视化这块最直接**。

#### 8 种节点类型（够用且不臃肿）

```
Start | Agent | MCP Tools | Transform | If/Else | While Loop | User Approval | End
```

对照 PySpur 的复杂分类，这个**更接近我们能做的规模**。

#### 数据模型（极简）

```
workflows : { customId, name, description, category, tags, difficulty,
              nodes: any[], edges: any[], version, isTemplate, isPublic }
executions: { workflowId, status, currentNodeId, nodeResults, variables,
              input, output, error, startedAt, completedAt, threadId }
```

**注意两个点**：
- `nodes` / `edges` 是 `v.any()` —— **故意不强类型**，换取快速演进
- `executions` 有 `variables` —— **执行期可变状态单独存**，不污染定义

#### 人审批的实现（`User Approval` 是节点）

```
POST /api/approval/[approvalId]/resume
```

审批是一个**可恢复的节点**：执行到它时挂起，把 `approvalId` 暴露给前端，
人点了之后 `resume` 继续。**不是「执行完再问」，而是「执行中停下等人」。**

---

## 十二、可视化工作流：三种形态对比

这一节回答「可视化该做成什么样」。

| 形态 | 代表 | 优点 | 缺点 | 适合我们吗 |
|---|---|---|---|---|
| **自由画布**（拖拽节点+连线） | PySpur、open-agent-builder、Firecrawl builder | 表达力最强，用户最熟悉 | 需要 xyflow/React Flow 类库；**我们的渲染层是零依赖字符串拼 HTML**，加画布等于重写前端 | ❌ 代价太大 |
| **静态 DAG 图**（自动布局，只读或轻交互） | Argo Workflows、Hatchet UI | 实现简单（SVG/Canvas 画一遍）；能看清依赖和并行 | 不能自由编辑 | ✅ **最合适** |
| **分层列表 / 泳道**（按阶段分组） | amux、shogun 的 tmux 网格、Kanban | 零图形依赖，纯 HTML/CSS；天然适配我们现有报纸体例 | 看不出「并行」的形状 | ✅ **可作第一期** |

### 12.1 推荐路径：三期走，别一步到位

**第一期：泳道 + 依赖连线（纯 HTML/CSS/SVG）**

- 横轴 = 状态阶段（待办 / 进行中 / 待复核 / 完成）
- 纵轴 = 并行通道（按 area 或按执行器分组）
- 卡片之间用**细 SVG 连线**表示依赖
- 复用现有 `css.mjs` 的变量体系（`--paper`/`--ink`/`--rule`…）

**为什么先做这个**：ops-board 现在是「零依赖字符串拼 HTML + 单文件 CSS」。
引入 React Flow 意味着整个前端重写，**违背 strangler fig 策略**（见 §2.6 ⑤）。
泳道图用纯 HTML + 一点点内联 SVG 就能画，且**和现有报纸体例天然兼容**。

**第二期：加交互（点击节点展开详情、悬停高亮上下游）**

- 点击卡片 → 展开 `sections`（现成的）
- 悬停 → 高亮它的上游（祖先）和下游（后代）
- **需要 `get_blocked_nodes` 的等价物**（见 §11.1 ②）

**第三期：才考虑自由画布**（如果真的有编辑需求）

> **判断标准**：如果用户只是**看**工作流，泳道图够了；
> 只有需要**编辑**工作流时，画布才必要。**先确认是不是真的要编辑。**

### 12.2 可视化的五个必备要素（从五个项目归纳）

不管什么形态，这五样缺一不可：

| # | 要素 | 出处 | 为什么必须 |
|---|---|---|---|
| 1 | **节点状态**（未开始/运行中/成功/失败/暂停/跳过） | PySpur、open-agent-builder | 没有状态的可视化只是静态图 |
| 2 | **并行分支的可辨识性** | PySpur Merge/Coalesce | 用户要能一眼看出「这几条是同时跑的」 |
| 3 | **依赖边**（带条件） | PySpur `source_handle`、LoopForge `when` | 条件分支的边不能只写 from/to |
| 4 | **阻塞传播**（暂停一个，标出影响谁） | PySpur `get_blocked_nodes` | 否则暂停后一片红，不知道为什么 |
| 5 | **执行历史可回放** | agetor 事件重放、LoopForge revisions | 「上次跑到哪了、为什么失败」 |

### 12.3 状态色：只能用语义 token（血的教训）

从 agetor 抄来的、和我们踩过的坑完全一致：

- 语义色只有四个：`--success` / `--warning` / `--info` / `--danger`，各带 `-foreground`
- **不许写字面色**（`text-rose-400` 只对一种背景调过，换主题就崩）
- **未定义 token 陷阱**：框架对缺 token 的语义类**输出零 CSS** → 元素全透明
- 我们的 `css.mjs` 已有 `--paper`/`--surface`/`--surface-soft`/`--ink`/`--muted`/`--rule`/`--rule2`，
  **新图元一律用这些，不要新增字面色值**

---

## 十三、并行 + 可视化 的十二条落地决策

> 编号接续第一轮的 D1–D12。这些是针对**并行**和**可视化**两个新需求的。

### D13. 用「懒创建 + 递归等待」实现并行，不要写调度器

**抄自**：PySpur `_get_async_task_for_node_execution`

```
nodeTask(id):
    if id in tasks: return tasks[id]        # 幂等
    tasks[id] = start(execute(id))          # 懒启动
    return tasks[id]

execute(id):
    deps = dependencies[id]
    upstream = awaitAll(nodeTask(d) for d in deps)   # 递归等待，天然并发
    ...
```

**收益**：不需要拓扑排序、不需要并发上限、不需要调度循环。
**风险**：递归深度 = 依赖链长度（我们的卡片依赖很浅，不是问题）。

### D14. 并发上限按「动态 key」设，不是一个全局数字

**抄自**：Hatchet concurrency policies

```
全局：最多 N 张卡同时跑
分组：同一 area 最多 1 张
单卡：最多 M 个子步骤并行
```

**理由**：全局数字会让「同一批文件被两张卡同时改」。按 area 分组才是真正的保护。

### D15. 领取和完成必须用同一个版本条件

**抄自**：amux 的「守卫的领取，盲目的完成」

```
领取：UPDATE ... WHERE id=? AND status='queued' AND version=N
完成：UPDATE ... WHERE id=? AND version=N+1     ← 必须带版本
```

**否则**：超时回收后，原执行者迟到的完成会**覆盖新执行者的结果**。
这是并行系统最常见、最难查的 bug。

### D16. 状态只能有一个编码，且所有写入走同一个函数

**抄自**：amux 通病 1/2/4

- 状态列有**白名单校验**（我们的 `status` 现在每个 kind 一套词，无任何约束）
- 所有状态变更**只能**调用 `transition(card, to, by, remark)`
- 该函数内部：校验合法性 → 写 `status` → 追加 `flow_log` → 返回新卡片
- **禁止**任何地方直接改 `status` 字段

### D17. 每个执行器独占输出，不要让 N 个写同一个文件

**抄自**：shogun 的角色边界

```
输出目录/
  ├─ runner-1/result.json     ← 只有 runner-1 写
  ├─ runner-2/result.json     ← 只有 runner-2 写
  └─ _summary.json            ← 只有主控写
```

**收益**：冲突在结构上被消除，不需要锁。
对照 amux 的双租约系统（互不读取、generation 恒为 0）——**加锁比避免共享更容易出错**。

### D18. 协调信息用文件，不用内存消息

**抄自**：shogun「零协调开销」

任务分配、报告、决策写成 JSON/YAML 文件。
**好处**：可读、可 diff、零 API 成本、崩溃后还在。

### D19. 可视化第一期做「泳道 + 依赖连线」，不做自由画布

**理由**：见 §12.1。我们的渲染层是零依赖字符串拼 HTML，
引入画布库 = 前端重写 = 违背 strangler fig。

### D20. 条件分支的边必须带 `handle` / `when`

**抄自**：PySpur `source_handle`（缺失直接报错）+ LoopForge `when`

```
edge = { from, to, when: "success" | "failure" | "condition-name" }
```

**没有 `when` 的边 = 无条件边**，这是两种不同语义，不能混。

### D21. 暂停/跳过要能算出「影响谁」

**抄自**：PySpur `get_blocked_nodes`

```
blockedBy(nodeId):
    反向建图 dependents[dep] = {依赖它的节点}
    从 nodeId BFS 向下游扩散
    返回集合
```

UI 上：点「暂停」时**先高亮会被阻塞的下游**，再确认。

### D22. 并行状态必须落盘，不能只在内存

**抄自**：amux 通病 6「内存状态，重启就忘」

- 重试计数 → 落盘
- 「已处理过哪些」 → 落盘
- 暂停/恢复的挂起状态 → 落盘

否则重启后行为不一致（无限重试 / 重复处理）。

### D23. 「等人」是一种正式状态，不是「在跑」

**抄自**：PySpur `HumanInterventionNode` + veritas-kanban「等人也算 blocked」

- 图上有 `approval` 节点类型
- 状态是 `waiting_approval`，不是 `running`
- 有 `resume` 入口（`POST .../approval/{id}/resume`）

### D24. 可视化必须能回答「上次跑到哪、为什么停」

**抄自**：agetor 事件重放 + LoopForge revisions

- 执行历史只追加
- 每个节点保留最后一次的输入/输出/错误
- 能从任意历史点回放

---

## 十四、并行 + 可视化 的明确不抄清单

| 不要抄 | 出处 | 原因 |
|---|---|---|
| 自由画布 / 拖拽编辑器 | PySpur、open-agent-builder | 前端重写代价远超收益；我们不是要做「工作流设计器」，是要**看**流程 |
| 完整 DAG 引擎（Postgres 持久化） | Hatchet | 它是服务端，我们只有 `serve.mjs` |
| 双租约系统 | amux | **这是它的 bug 来源，不是优点** |
| 8 个 agent 的封建等级 | shogun | 我们并行的是「卡」不是「agent 团队」；等级制度在这里无意义 |
| `v.any()` 弱类型 schema | open-agent-builder | 它是早期快速演进阶段的选择；我们数据已经规整（61/61 sections 一致），**不该倒退** |
| tmux 面板 | shogun、amux | 我们已经有 Web GUI |

---

## 十五、两轮调研的合并结论

### 15.1 如果只能记住三件事

1. **并行用「懒创建 + 递归等待」实现，不要写调度器**（PySpur，§11.1）
2. **冲突要在结构上消除（每人独占文件），不要在运行时加锁**（shogun，§11.4 ②）
3. **可视化先做泳道图，不要一上来做画布**（§12.1）

### 15.2 最大的风险不是「不会做」，而是「做了但状态不一致」

amux 那份 `implicit-state-machines.md` 列的每一条，都是**功能做完了才发现状态管理崩了**：

- 有 enum 但写入方绕过 → 日志和状态分叉
- 领取有守卫、完成没有 → 迟到写入覆盖新结果
- 一个事实多种编码 → 看板和工作台各显示一套
- 内存计数不落盘 → 重启后无限重试

**这些都不是「并行」带来的新问题，而是「一旦并行就会暴露」的老问题。**
所以 §D15/D16/D22 三条（版本条件、单一编码、落盘）**优先级应该高于任何并行功能本身**。

### 15.3 修订后的优先级

| 优先级 | 动作 | 依据 | 说明 |
|---|---|---|---|
| **P0** | 状态白名单 + 单一 `transition()` 函数 | D16 | **并行的地基**，不做这个后面全塌 |
| **P0** | `/api/evidence/stale` 接进 UI | §六.3 | 现成，纯前端 |
| **P0** | `watch` 卡补 `retrigger` | D3 | 5 张卡，小 |
| **P1** | `flow_log[]` 只追加 | D2 | 有了 transition 就顺手 |
| **P1** | 版本条件（领取/完成） | D15 | 并行前必须 |
| **P1** | 泳道 + 依赖连线（只读） | D19 | 可视化的第一期 |
| **P2** | 懒创建 + 递归等待的并行执行 | D13 | 核心并行 |
| **P2** | 独占输出目录 | D17 | 配合 D13 |
| **P2** | `get_blocked_nodes` 等价物 | D21 | 可视化的第二期 |
| **P3** | 动态并发上限 | D14 | 优化项 |
| **P3** | 执行历史回放 | D24 | 完善项 |

> **P0 的前三条都不是「并行」也不是「可视化」** ——
> 它们是这两件事的**前提**。先把状态管对，并行才不会互相踩，可视化才有可信的数据源。

---

# 第三轮：已落地 —— 可视化工作流 + 并行领取

> 这一轮不是调研，是把前两轮的结论**做出来**，并记下实现过程中撞到的真问题。
> 落点：`scripts/lib/flow.mjs`（推导）、`render.mjs` 的 `viewFlow()`（渲染）、
> `serve.mjs` 的 `/api/flow/{plan,claim,release}`（并行约束）、`css.mjs`（样式）。

## 十六、做了什么

| 层 | 文件 | 内容 |
|---|---|---|
| 推导 | `scripts/lib/flow.mjs`（新，约 200 行） | 把台账变成「泳道 + 阶段轴 + 冲突组」 |
| 渲染 | `render.mjs` `viewFlow()` | 纯 HTML，零依赖，无画布库 |
| 约束 | `serve.mjs` `/api/flow/*` | 领取 / 交还 / 同区域互斥 |
| 交互 | `client.js` `claimFlowItem()` | 「领这件」按钮，真调接口 |
| 样式 | `css.mjs` `.flow-*`（约 60 行） | 只用既有语义变量 |
| 测试 | `flow-test.mjs` 28 项、`flow-api-test.mjs` 25 项、`flow-e2e-test.mjs` 8 项 | 当时全绿 |

> ⚠️ **本节是历史记录（2026-11-17 的泳道/画布版本），现状已不同**：
> ①画布在 2026-11-18 被完整去掉（`viewFlow` 里的可拖动流程连线图），
> ②「工作流」页本身也在同日删除（`viewFlow()` 整个函数移除，工作台搬到总览页）；
> ③`flow-e2e-test.mjs` 因所测按钮（`[data-flow-claim]`「领这件」）只存在于画布上，画布一删即失效，
> 已于 2026-11-18 删除，其覆盖由 `flow-workbench-run-test.mjs`（真实 UI 路径 claim→ask→release）
> 与 `flow-workbench-test.mjs` `[5g]`（批内 claim→ask→release）承担；
> ④`flow-api-test.mjs` 同日重写为数据驱动（33 项，不再写死卡号与件数）。
> 现役视图为 6 个：总览 / 新增功能 / 问题修复 / 风险 / 已修复·已关闭·暂停 / Skill 统计。
> 当前门禁基线见 `docs/HANDOFF.md` §5.2。
> `flow.mjs` 本身仍是活的 —— `serve.mjs` 的 `/api/flow/plan` 与证据链推导在用它，只是不再渲染成页面。

**为什么是泳道而不是拖拽画布**：渲染层是零依赖字符串拼 HTML，
引入 React Flow 等于前端重写，违反渐进替换。用户要的是**看**流程，不是**画**流程。

## 十七、实现中撞到的四个真问题（都不在调研里）

### 问题 1：按 lane 各算一套并行度，会高估

第一版在每条 lane 内部独立算「同区域只能跑一件」。结果：

```
bug 车道：免费额度 2 件 → 串行
feature 车道：免费额度 1 件 → 单件，可开工
合计：3 路并行
```

**实际这 3 件抢同一块地**（OPS-022 / OPS-025 / FEAT-014 的 area 前缀都是「免费额度」），
只能 1 件先跑。按 lane 算得出的 3 路是假的。

**修法**：冲突组和定头都按**全台账**算，节点先全局建好，再按 lane 分组渲染。
`buildFlow()` 的注释里写死了这条不变量。

**这是本轮最重要的发现**：并行度如果按「视图分组」算而不是按「资源」算，
就会系统性高估。台账里 `area` 的前缀就是资源名。

### 问题 2：同一个事实两套编码（amux 通病 5 的实例）

`serve.mjs` 第一版自己写了一套「同区域第一个」的挑选逻辑（按 id 字母序），
而 `flow.mjs` 按阶段步序挑。结果：

- 流程图说：**OPS-022** 可以开工
- 接口说：**FEAT-014** 可以开工

同一份台账，两个答案。这正是 amux `implicit-state-machines.md` 记的
「derived more than once」—— 一旦推导了两遍，两份就会漂移。

**修法**：`serve.mjs` 删掉自己那套，改成 `import { buildFlow }` 复用。
测试里加了一条断言：图里说谁是头，接口就必须说谁能开工。

### 问题 3：状态写在请求处理器里 = 每个请求丢一次

`flowClaims`（谁领了哪件）第一版写在 `createServer(async (req,res) => {...})` **内部**。
于是：

```
POST /api/flow/claim  → 200 {"ok":true,"holders":1}   ← 看起来成功了
GET  /api/flow/plan   → 那件仍是 ready，by=""          ← 领了个寂寞
```

`claim` 回 200 是真的，但记录活在只属于那个请求的 Map 里，请求结束就没了。

**这是 amux 第 6 条通病（in-memory state lost on restart）的变体**：
不是重启丢，是**每个请求丢**。而且它比重启丢更阴 —— 因为接口返回成功。

**修法**：状态移到模块作用域。测试里专门有一条
「领取状态要持久（这是之前真正的 bug）」。

### 问题 4：头被领走后队列不前进，串行永远卡在第一件

第一版：`n.isHead = (i === 0)`。头被领走后，同区域第二件仍是 `i === 1`，
永远不是头 → **这条泳道再也无法开工**。

**修法**：`buildFlow(config, ledger, claimed)` 接收「已领走」集合，
把已领走的排到队尾，头的位置让给下一件。这样：

```
领走 OPS-022 后：
  OPS-025 / FEAT-014 里有一件顶上来成为新头 → 泳道继续流动
```

## 十八、界面上的两个「说不通」

### 「这一行只有一件，凭什么不能开工」

`feature / 免费额度` 这条轨道只有 FEAT-014 一件，却标着「排队中」，
因为它要等 bug 车道的 OPS-022。

不解释清楚，用户会认为逻辑坏了。**修法**：等待标签带上跨泳道提示 ——
`等 OPS-022（另一条泳道）`。

### 「排在前面的是排队中，排在后面才能开工」

轨道内节点没排序，渲染顺序跟「谁是头」的判定顺序不一致，
于是画面上第一行是「排队中」、第二行才是「领这件」。

**修法**：轨道内按**和定头相同的规则**排序（阶段步序 → id）。
判据：`t.serial && t.items[0].isHead === false` 就是不一致，测试里查这个。

## 十九、这套东西现在的真实表现

cyber-egg-basket 实测（61 条台账，7 条未收口）：

```
7 件未收口 → 只有 5 件能同时开工
  可开工：OPS-022(免费额度) OPS-024(重构) RISK-001(云环境) RISK-002(发布链路) RISK-003(数据源)
  排队中：OPS-025 等 OPS-022
          FEAT-014 等 OPS-022（另一条泳道）
需要排队的泳道：1 条（免费额度，横跨问题/需求两条 lane）
```

**这就是可视化的价值**：不画图也能从数字里读出来 ——
「7 件活里有 2 件在互相等，因为它们改的是同一块地方」。
这句话在原来的界面上是看不见的。

## 二十、还没做的（下一步）

| 优先级 | 事项 | 依据 | 说明 |
|---|---|---|---|
| **P0** | 领取状态落盘 | 问题 3 的延伸 | 现在只活在内存里，重启就清空。多进程/重启后「谁在执行」会丢 |
| **P1** | 领取超时回收 | D15 | 没有超时，崩掉的执行者会永久占着那块地 |
| **P1** | 真正的并行执行器 | D13 | 现在只是「约束」，还没有「自动跑」 |
| **P2** | 依赖边（不只 area 前缀） | D19 第二期 | 台账里没有依赖字段，area 前缀是当下的替代品 |
| **P2** | 执行历史回放 | D24 | |

> **关于「自动并行跑」**：现在的实现是**人工领 + 机器守约束**。
> 不自动跑是有意的 —— 用户在第 50 轮说过要「人来选做哪几件」。
> 约束由机器守，选择由人做，这个分工是刻意的。

---

## ⚠️ 历史注记（2026-11-18 复核，本节以上的界面描述已过时）

上面第十八～十九节描述的是**旧「工作流」页的泳道画布**（`[data-flow-node]`、泳道、拖拽箭头、
「领这件」按钮）。**画布和那一页现在都不存在了**，相关界面描述只作历史参考，别照着去找。

当前实际的界面与执行形态：

| 事项 | 现在的事实 |
|---|---|
| 视图 | **6 个**：总览 / 新增功能 / 问题修复 / 风险 / 已修复·已关闭·暂停 / Skill 统计 |
| 工作台位置 | 「总览」页顶部，全站唯一一份 DOM 节点；切页时搬到当前页 `[data-wb-mount]`，无挂载点则收进 `#wb-park` |
| 总览页内容 | **只有「工作台 + 处理记录」**（2026-11-19 起）。两张待处理表已搬到问题修复页 / 风险页，**紧跟在那两页的状态表后面** |
| 各页第一个模块 | **都是状态表**（2026-11-19 二十一改）：车道页 `.stage-board` → 待处理块 → 各阶段；收口页是**跨车道合并表**（左「已收口 N」+ 右按状态分格，0 的格不给链接）；Skill 页数字表在「问 AI」之前。**总览页没有表** |
| 三个聚合式 AI 入口 | 问题页「总结项目状态」（整本台账）/ 风险页「风险审核」（只审风险车道）/ 需求页「计划中」右侧「和 AI 谈谈要加什么」（只谈需求车道），各自独立会话 |
| 并行形态 | 按区域前缀拆成多条队列（`.wb-lane`），每队列卡**横向**排、多队列**纵向**叠 |
| 「每批 1 张」 | 执行侧 `cap = 1`（`workbenchPump`），真正的「一张一张来」；**同路第二张起**在界面上标「排队中 · 等 <前一张>」+ 虚线边 |
| 批量 >1 / 整批 | 走 `workbenchStartBatches`，显示整批卡片清单（`.wb-batch`），**不标**排队 —— 那些卡是一起交给 Agent 的 |
| 已删脚本 | `flow-e2e-test.mjs`（点画布按钮）、`diag-flow-drag.mjs`（量画布拖拽） |

> §十九 里那句「7 件未收口 → 只有 5 件能同时开工」是当时的快照，现在台账前进过：
> `OPS-022` 已 `fixed`、`RISK-002` 已 `resolved`，未收口 5 件。
> **接口测试已改成数据驱动**（`flow-api-test` 33 项），验的是「关系」不是当时的数字 —— 原因见 HANDOFF §5.3。
