# dsh-ops-board

在 [DeepSeek Harness](https://github.com/deepseek-ai) 里挂一个**项目看板**：侧栏一个入口，点开是整页的
工作台 —— 问题 / 需求 / 风险三类台账，每条带四段式说明和证据线索，点一下就能让 AI 顺着这条记录干活。

![面板形态：整页看板 + 左侧栏]

> 上面这块是占位说明：仓库里没有放截图（截图里会有真实项目的台账内容）。
> 看板长什么样，跑起来就知道 —— 见下面「30 秒看效果」。

---

## 这东西解决什么

做项目的时候，「问题」通常是散着的：聊天记录里一句、脑子里记一条、TODO 里半条。
真正要复盘的时候，谁也说不清「上周那个白屏到底修没修、怎么验证的」。

这个看板把这些问题变成**结构化的台账**：

- **三条车道**：问题（bug）、需求（feature）、风险（risk），各有自己的状态流转
- **每条四段式**：具体表现 / 影响 / 原因 / 处理，加证据线索（命令、文件、数值）
- **点开就问 AI**：单条 / 整页 / 整本三种作用域，AI 拿着这条记录的上下文去干活
- **能自检**：页面是脚本生成的，人眼看不出的错（重复 id、孤儿样式、没闭合的标签）由机器拦

---

## 里面有两个东西，得一起用

```
dsh-ops-board/          插件本体 —— 装进 DSH profile
  index.js              Host 半侧（启动看板服务、代理、注册表）
  client.js             Client 半侧（侧栏图标、整页面板、问 AI）
  package.json          插件元数据（dsh.client / dsh.bundle 声明）
  cordis.patch.yml      挂载点
  icon.svg              侧栏图标
  locale/               中英文案
  test/                 host / client 自检装置
  sync.ps1              把本体同步进 desktop profile

ops-board-template/     看板模板骨架 —— 插件新建看板时复制它
  scripts/              渲染 / 服务 / 自检 / 生成台账（9 个脚本 + lib/）
  board.config.json     车道 / 状态 / 视图配置
  ledger.json           **空台账**（0 条目，合法状态）
  package.json          build / serve / verify

install.mjs             一条命令装好上面两样（见下）
```

**为什么是两个**：插件负责「在 Harness 里开一个面板」，模板负责「这个面板长什么样、数据怎么读」。
看板目录里只存数据（`ledger.json` + `board.config.json`），脚本是转发器，真脚本只有模板那一份 ——
所以升级脚本只改模板，所有看板立即生效，不用重新拷贝。

> ⚠️ **只装插件不行。** 新建看板时会报「没有模板目录」。必须把 `ops-board-template/` 也放好。

---

## 安装

### 一条命令（推荐）

在仓库根目录（`dsh-ops-board/` 和 `ops-board-template/` 的同级）跑：

```bash
node install.mjs
```

它会把 README 里那三步手工安装替你做掉，并且**顺便把模板放到插件默认认的位置**（`~/ops-board`），
所以装完不用改任何 YAML 配置，重启就能新建看板。

先看看它要改什么（不动文件）：

```bash
node install.mjs --dry-run
```

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只打印计划，不改文件 |
| `--profile <名字>` | 装到别的 profile（默认 `desktop`） |
| `--dsh-home <目录>` | 指定 DSH 主目录（默认 `~/.dsh`） |
| `--template-dir <目录>` | 模板放到自定义位置；会打印要贴进 `cordis.patch.yml` 的片段 |
| `--force` | 覆盖已存在的模板目录（用来更新模板） |

脚本会做这几件事：

1. 插件本体复制进 `<profile>/node_modules/dsh-ops-board`（真实目录，不建链接）
2. 改 `<profile>/package.json`：`dependencies` 加一项，`dsh.profile.bundles` 追加一项
3. 模板复制到 `~/ops-board`（或你指定的位置）
4. 自检，任一项不过就退出码 1，并告诉你备份在哪

**改 profile 前会自动备份**成 `package.json.bak-<时间戳>`，失败可以从那里恢复。
重复运行是安全的：不会重复追加 bundles。

> ⚠️ 如果 `~/ops-board` 已经是一个真实看板（里面有 `project.json`），脚本会拒绝写入，
> 让你换个位置。不会把你的看板覆盖成模板。

### 手工安装（脚本不可用时）

DSH 桌面端只接受**真实目录手工安装**（`dsh plugin add` 会被拒，插件市场只收策展表里的）。
在 `~/.dsh/profiles/desktop/` 下做三件事，然后重启桌面端：

1. 把 `dsh-ops-board/` 整个复制进 `node_modules/dsh-ops-board/`
   —— 必须是真实目录，不能 link、不能 junction
2. `package.json` 的 `dependencies` 加 `"dsh-ops-board": "0.1.0"`
3. `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-ops-board"`

**不要再往 `cordis.patch.yml` 加条目** —— 被 bundles 引用的包，自带 patch 层会自动生效；
两处同时注册会报 `duplicate loader entry id`。

然后把模板放到 `~/ops-board`（插件默认认这个位置），或者配 `templateDir` 指向它。

重启后侧栏出现「项目看板」。第一次进去是空的，点「新建看板」，插件从模板复制骨架。

---

## 30 秒看效果（不用装 Harness）

模板能独立跑，只要有 node：

```bash
cd ops-board-template
npm run build     # 渲染 + 自检
npm run serve     # http://127.0.0.1:8790
```

或者双击 `start.cmd`。这样能看界面、翻页面、改 `ledger.json` 看效果 ——
但「问 AI」用不了，会提示去 Harness 里打开。

---

## 依赖边界（重要）

| 功能 | 需要什么 | 没有会怎样 |
|---|---|---|
| 渲染 / 浏览 / 翻页 / 主题 | 只要有 node | —— |
| Skill 统计 | DSH 的 `~/.dsh/sessions` 与 `~/.dsh/skills` | 渲染成空，不报错 |
| 问 AI | Harness 宿主注入 + 看板服务的 `/ops-board/ask` | 只剩一句提示 |

**这是 Harness 专属工具**，装 DSH 才有完整功能。脱离 DSH 它是一份能看的静态页面。

---

## 自检

```bash
cd dsh-ops-board
node test/host-smoke.mjs      # 宿主半侧：创建 / 增删 / 端口 / 代理 / SSE
node test/client-smoke.mjs    # 客户端半侧：面板 / 侧栏 / 问 AI 流程
```

> 这两个自检要 `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` 等 peer 依赖，
> 它们由 DSH profile 提供 —— **装进 profile 之后才能跑**。单独拷到空目录跑会报
> `ERR_MODULE_NOT_FOUND`，这是预期的，不是坏包。

看板本身的自检：

```bash
cd <看板目录>
node scripts/render.mjs
node scripts/verify-board.mjs   # 退出码 0 才算通过
```

---

## 已知边界

- **问 AI 只能在 Harness 里用** —— 模板里没有接入点，也没有能替它执行的东西
- **多人同时改 `ledger.json` 会打架** —— 没有锁、没有合并
- **`lane.key` 里不要带连字符** —— hash 路由按 `stage-<lane>-<stage>` 切分
- **不支持富文本** —— 文本按纯文本转义。刻意如此：台账要能被机器读
- **AI 不会改台账** —— `ledger.json` 和 `board.config.json` 被系统提示禁掉了。
  台账之所以可信，就因为不肯乱写「已修复」

---

## 不包含什么

这个仓库**只放插件本体和模板骨架**，不放运行时数据和真实台账：

- 不含 `data/`（运行时数据，会记下原机器的绝对路径）
- 不含 `docs/` 截图（那里面是真实项目的台账内容）
- 模板的 `ledger.json` 是空台账

---

## License

MIT
