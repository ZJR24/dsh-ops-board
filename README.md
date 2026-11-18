# dsh-ops-board —— 干净插件本体

`dsh-ops-board` 插件的可分发副本：不带运行时数据、不带本机路径、不带示例项目。
给的是"能装、能跑、能自己建看板"的最小完整集。

## 里面有什么

```
dsh-ops-board/          插件本体 —— 装进 DSH profile 的 node_modules
  index.js              Host 半侧（启动看板服务、代理、注册表）
  client.js             Client 半侧（侧栏图标、整页面板、问 AI）
  package.json          插件元数据（dsh.client / dsh.bundle 声明）
  cordis.patch.yml      挂载点（被 profile bundles 引用时自动生效）
  icon.svg              侧栏图标
  locale/               中英文案
  test/                 host / client 自检装置
  sync.ps1              把本体同步进 desktop profile

ops-board-template/     看板模板骨架 —— 插件新建看板时复制它
  scripts/              渲染 / 服务 / 自检 / 导出 / 生成台账（10 个脚本 + lib）
  board.config.json     车道 / 状态 / 视图配置
  ledger.json           **空台账**（0 条目，合法状态）
  package.json          build / serve / verify

```

**不含**：`data/`（运行时数据，记着原机器的绝对路径）、`docs/`（截图是真实台账内容）。

## 怎么装

DSH 桌面端只接受**真实目录手工安装**（`dsh plugin add` 会被拒，插件市场只收策展表里的）。
在 `~/.dsh/profiles/desktop/` 下做三件事，然后重启桌面端：

1. 把 `dsh-ops-board/` 整个复制进 `node_modules/dsh-ops-board/`
   —— 必须是真实目录，不能 link、不能 junction
2. `package.json` 的 `dependencies` 加 `"dsh-ops-board": "0.1.0"`
3. `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-ops-board"`

**不要再往 `cordis.patch.yml` 加条目** —— 被 bundles 引用的包，自带 patch 层会自动生效；
两处同时注册会报 `duplicate loader entry id`。

## 怎么用

重启后侧栏出现「项目看板」。第一次进去是空的，点「新建看板」：

- 选一个项目目录（可选，记进注册表供问 AI 时读代码）
- 选一个存放位置（看板目录建在那儿）
- 插件从模板复制骨架，生成一个带 `ledger.json` 的空看板

想直接登记已有的看板目录，把路径填进「添加看板」即可（目录里要有 `ledger.json` 和 `scripts/serve.mjs`）。

## 依赖边界（重要）

- **渲染 / 浏览 / 翻页 / 主题**：纯静态，有 node 就能跑，`dist/index.html` 双击也看
- **Skill 统计**：要 DSH 的 `~/.dsh/sessions` 与 `~/.dsh/skills`，没有就渲染成空，不报错
- **问 AI**：要 Harness 宿主注入 + 看板服务的 `/ops-board/ask`，脱离 DSH 只剩提示

换句话说：**这是 Harness 专属工具**，装 DSH 才有完整功能。

## 自检

```powershell
cd dsh-ops-board
node test/host-smoke.mjs      # 宿主半侧：创建 / 增删 / 端口 / 代理 / SSE
node test/client-smoke.mjs    # 客户端半侧：面板 / 侧栏 / 问 AI 流程
```

> 这两个自检要 `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` 两个 peer 依赖，
> 它们由 DSH profile 提供 —— **装进 profile 之后才能跑**，单独拷到空目录跑会报
> `ERR_MODULE_NOT_FOUND`，这是预期的，不是坏包。
