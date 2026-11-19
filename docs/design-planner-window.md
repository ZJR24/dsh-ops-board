# 设计：分析交给窗口做，按结果派活 + 窗口复用

> 用户设想（2026-11-19）：
> 「用户选择好接下来要做的任务，然后点击分析，插件首先会把任务交给一个窗口分析，
> 看看分批是否合理会不会冲突，然后返回分析结果，插件按照结果去调用对应的分批窗口；
> 按照这个逻辑，可能会产生 2 个批次，但是有 3 个对话窗口的现象；一个窗口用于分析分批，
> 其余窗口根据指派去干活；然后窗口复用，尽量按照分类来调派任务。」
>
> 追问确认：
> - 分析窗口：**默认复用**，但给开关可以关掉（关掉 = 每次新开一个）。
> - 计划不合法：**自动回退到现在的确定性分组**，日志说明原因。
> - 复用键：**让 AI 具体情况具体分析**，不写死按前缀分。

---

## 零、参考项目与可复用点（调研）

> **来源说明**：`web_search` 当时返回 `402 Insufficient Balance` 不可用，所以改走「直接拉源码核对」：
> 下载了 LangGraph supervisor、CrewAI、AutoGen、OpenAI Agents SDK、Celery、Instructor、BAML 的
> 相关源文件逐条对照（共 34 个文件，近 1 MB）。下表每条机制都标了**可核对的出处**，
> 不是凭印象写的。源码副本未入库（属调研中间产物），删了也不影响本结论。

| 项目 | 它的机制（含出处） | 可复用的点 |
|---|---|---|
| **LangGraph**<br>`langgraph-supervisor` | handoff 工具返回 `Command(goto=agent_name, graph=Command.PARENT)` 完成交接（`lgsup_handoff.py:110-124`）；并行交接时把多条 `Send` 合成一个 command（`:113-114`）；`output_mode` 控制给 worker 多少上下文 | ①「先决策、再交接」的图结构就是我们要的形状；②**交接时传多少上下文要显式选**——复用窗口时这点尤其重要（窗口带着旧上下文，可能反而干扰）；③**并行交接是「一个 command 带多条 Send」，不是发多次**——对应我们「一次分析出整份计划」而不是逐个派 |
| **OpenAI Agents SDK / Swarm**<br>handoff | handoff 就是「返回另一个 agent」（`oai_handoffs_init.py`），**无状态**，agent 之间不共享内存，上下文靠调用方显式传 | **无状态交接最省心**：我们不把 analyze 结果塞进后端状态，而是让它作为一次普通 ask 的返回值，天然贴这个模型 |
| **CrewAI**<br>hierarchical process | `Process.hierarchical`（`crewai_process.py:8`）；manager 派活靠 `DelegateWorkTool`，schema 就是 `{task, context, coworker}`（`crewai_delegate.py:19-21`）；`allow_delegation` 逐 agent 控制（`crewai_crew.py:949` 关、`:1544` 对 manager 开） | 「**只允许派一层**」是很好的默认——`crewai_crew.py:1544` 只对 `manager_agent` 开委托，worker 是 `False`。我们的分析窗口同理：不该自己再开窗口 |
| **AutoGen**<br>GroupChat / Selector | 选择器决定下一个说话者（`autogen_selector.py`）；`GroupChat` 有 `max_round` 防打转（`autogen_m1_group.py`） | **必须设上限**：分析窗口只问一次，不合法就回退，**绝不让它自我重试**（否则会无限烧 token） |
| **Celery**<br>`task_routes` | 任务按名字路由到**具名队列**：`task_routes = {'feed.tasks.*': {'queue': 'feeds'}}`（`celery_routing.rst:49`）；消费者按 `Queue('feed_tasks', routing_key='feed.#')` 订阅（`:131`） | ★ **这是「按分类复用窗口」的现成答案**：把 `lane.key` 当队列名，会话键就是队列名，同类任务自然回到同一个窗口。**键要稳定**，所以不能用「路1/路2」这种位置名 |
| **Temporal / K8s lease**<br>（`tempo_arch.md`） | 任务队列 + worker 竞争消费；同一资源只能被一个 worker 持有（lease 续约） | 我们的 `areaPrefix` 互斥 + `serve.mjs` 的 claim 就是这套；**校验器第 4 条**等于在派活前就避免死锁，而不是等 claim 去挡（那时已经在重试了） |
| **Instructor / BAML**<br>结构化输出 | 校验失败就 **reask** 并把 `ValidationError` 回喂给模型重试（`instr_v2_retry.py:3,14,60`）；BAML 有自己的 JSON-ish 解析器（`baml_jsonish_lib.rs`） | ①**解析要能容错**：模型常把 JSON 包在 ```json 里、或前后带话——我们的 `extractPlanJson` 三级兜底正是这个思路；②它们都强调「校验失败要有明确出路」，而**我们的出路是回退，不是重试**（因为我们不能让用户等两轮） |

### 最终采纳的 5 条（已落地）

1. **决策与执行分离**（LangGraph supervisor）：分析窗口只产出计划，不动手。
2. **只派一层**（CrewAI `manager_agent` 才 `allow_delegation=True`）：分析窗口不能再开窗口。
3. **只问一次、不自我重试**（AutoGen 的 `max_round` 教训 + 我们对延迟的要求）：
   不合法立刻回退到确定性分组，**不 reask**（这点与 Instructor 相反，是有意的取舍）。
4. **队列名 = 复用键**（Celery `task_routes`）：`lane.key` 同时是展示名和会话键，
   同类任务回到同一窗口。键必须跨轮次稳定，所以**由 AI 起名并要求它保持稳定**，
   而不是代码拼「路N · 前缀」。
5. **派活前就保证互斥**（K8s lease / Celery 的路由前置检查）：校验器第 4 条把
   「同区域拆两窗口」挡在派发之前。

### 明确没采纳的

- **不引入 LangGraph / CrewAI 这类框架**：它们都要求把编排写成图/DAG 并自带运行时。
  我们只有「1 个决策者 + N 个执行者、只派一层」，手写 30 行就够，引框架反而增加部署面。
- **不做 reask 重试**（Instructor 的做法）：与「点一下分析就出结果」的交互冲突，
  也会让「点分析要等多久」变得不可预期。**回退比重试好**——反正按区域分组本来就能用。
- **不做多轮规划**：同上，planner 反复修正自己的计划会让延迟不可控。
- **不让分析窗口直接调工具改台账**：它只判断，不执行。执行永远由干活窗口做，
  这样「谁动了台账」始终可归因。

---

## 一、现状：分析是纯代码算的，窗口只干活

现在点「分析」走的是 `POST /api/workbench/analyze`，纯 JS：

| 位置 | 做什么 |
|---|---|
| `serve.mjs:605` | 接 ids / order / batches |
| `workbench.mjs planBatches` | 按 `areaPrefix(item.area)` 分组 → `lanes`；批只决定「一次喂几张」 |
| `workbench.mjs planWorkbench` | 自动出 serial / parallel 两种建议 |

也就是说：**「会不会冲突」这个判断现在是硬编码的**——同前缀就算冲突，必须串行。
AI 完全没参与分析。用户要的是把这个判断交给一个窗口。

## 二、两个必须先解决的事实（已核实）

### 事实 1：窗口复用现在**做不到**，因为 `fresh` 写死 true

`client.js:1465`（路引擎）和 `:1703`（单卡）都是 `var fresh = true;`，
而宿主侧 `dsh-ops-board/client.js:1673` 的 `const forceNew = payload.fresh === true;`
直接决定要不要新建会话：

```js
let sessionId = forceNew ? null : mappedId || null   // :1701
```

`forceNew` 为真 → `sessionId` 强制 null → 走 `sessions.create()`（:1718）。
所以**每一次 ask 都是全新会话**，无论会话键叫什么名字。
「路N · 前缀」只是映射表里的一个 key，每次都被覆盖成一个新会话。

→ 想复用，必须让 `fresh = false`（映射表里已有会话就接回去）。

⚠️ 但这里有个副作用要一起想清楚：`fresh=false` 时，宿主会走
`if (!picked && sessionId && list && list.byId && !list.byId[sessionId]) sessionId = null;`（:1714），
即映射表里的会话如果不在快照里就丢弃。跨轮次复用时这是对的（会话被删了就新建）。

### 事实 2：回答能带回完整文本，够传计划 JSON

`replyToBoard({ text: answer.text, ... })`（宿主 `:1812`）→
`POST /api/relay/answer`（`serve.mjs:406`）→ 页面收到 `payload.text`。
`client.js:1482` 就是拿 `res.text` 当结论的。所以分析窗口把计划写成 JSON 放在回复正文里，
是可以完整拿回来的。**不需要新开通道。**

## 三、目标架构

```
用户勾选卡 → 点「分析」
     │
     ├─(分析窗口，1 个，默认复用)  输入：卡清单 + 每张的 area/lane/status + 现有窗口清单
     │                             输出：JSON 计划 {lanes:[{key,prefix,cardIds,why}], note}
     │
     ├─ 校验器（纯 JS，不信任 AI）──不合法──> 回退到 areaPrefix 确定性分组 + 日志说明
     │
     └─ 派发：每条 lane 一个窗口（窗口键 = AI 给的 lane.key）→ 复用已有会话
```

窗口数 = 1（分析）+ N（干活），正是用户说的「2 个批次但有 3 个窗口」。

## 四、计划 JSON 契约

```json
{
  "lanes": [
    {
      "key": "数据源",              // 复用键：分类名，跨轮次稳定的字符串
      "prefix": "数据源",           // 展示名（路名）
      "cardIds": ["OPS-025"],
      "why": "同一块地，必须串行"
    }
  ],
  "note": "一句话说明为什么这么分"
}
```

要求 AI 只输出这个 JSON（允许 ```json 围栏 / 前后带说明文字，解析时抠出来）。

## 五、校验器（这一层是安全底线，不能省）

**校验不过就整份丢弃、回退**，不做「部分采用」——半对半错的计划比没有计划更危险。

| # | 规则 | 不通过时 |
|---|---|---|
| 1 | 能解析出 JSON（容忍围栏、前后文字） | 回退 |
| 2 | `lanes` 是非空数组，每项有 `key` + `cardIds` 非空数组 | 回退 |
| 3 | **卡片全覆盖且不重复**：所有 cardIds 的并集 == 用户选的集合，无重复 | 回退 |
| 4 | ★ **同一 area 前缀不得出现在两条 lane 里** | 回退 |
| 5 | `key` 在本次计划内唯一 | 回退 |
| 6 | 每张卡的 id 必须真的在候选集里（防 AI 编 id） | 回退 |

第 4 条是最关键的不变量，也是唯一有安全含义的一条：
> **同区域的卡可以放进同一个窗口（那就是串行，安全），但绝不能被拆进两个窗口。**

反过来说，AI 想「把同区域的卡拆开并行」——这在本系统里会造成两个窗口抢同一块地，
`serve.mjs` 的 claim 互斥会真的挡住其中一个（不是数据损坏，但会让路卡住重试）。
所以这条必须在客户端就拦掉。

**注意留口子**：AI 把不同区域的卡合并到一条 lane 是**合法的**（等价于串行），
只要它自己说明理由。不要禁止——那是它的判断空间。

## 六、复用键怎么定

用户要求「让 AI 具体情况具体分析」，所以 `key` 由 AI 给，不由代码算。但为了保证跨轮次
能真的接上，提示词里要把**现有窗口清单**给它，并要求「能接就接，别每轮重新造名字」：

```
现有对话窗口（如果能接上就用同样的 key，接不上再起新名字）：
- 数据源  （最近处理：OPS-025，3 天前）
- 重构    （最近处理：OPS-024，5 天前）
```

这样 AI 有依据做「这个卡该回到哪个窗口」的判断，而不是靠猜。

## 七、开关

工作台加一个复选框：「复用分析窗口（关掉 = 每次新开）」默认勾上。
- 勾上：分析窗口的会话键固定成 `调度台`，`fresh=false`
- 关掉：`fresh=true`（当前行为）

干活窗口的复用跟着计划走（`key` 相同就复用），不由这个开关控制——
因为用户明确说了「干活窗口尽量按分类调派」。

## 八、要改的文件

| 文件 | 改动 |
|---|---|
| `scripts/lib/planner.mjs`（新） | 计划 JSON 的解析 + 校验 + 回退（纯函数，可单测） |
| `scripts/lib/client.js` | 分析按钮：先问分析窗口 → 校验 → 建 lanes；`fresh` 改为按开关 |
| `scripts/render.mjs` | 加「复用分析窗口」复选框 |
| `scripts/lib/css.mjs` | 新 class 的样式 |
| `scripts/flow-workbench-test.mjs` | 新增：计划合法/非法回退/复用键命中 |
| `docs/HANDOFF.md` | 二十四改 |

## 九、风险与兜底

1. **分析窗口很慢**：它是一次真实 LLM 往返，可能几十秒。→ 分析期间按钮转「分析中…」，
   并允许「跳过分析，直接用确定性分组」。
2. **分析窗口答非所问**：校验器兜底 + 回退，日志留原文前 200 字供排查。
3. **复用导致上下文污染**：默认复用但可关；复用键带「最近处理」提示，AI 自己判断要不要换。
4. **`fresh=false` 的连带影响**：单卡模式（`:1703`）要不要也改？**先不改**——
   本轮只动工作台的两条 ask，避免影响「问 AI」面板的既有行为。
