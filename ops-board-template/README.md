# ops-board 模板骨架

一份台账 JSON，渲染成一份报纸体例的工作台页面，内置 AI 对话入口。

## 跑起来

```bash
npm run build     # 渲染 + 自检
npm run serve     # http://127.0.0.1:8790
```

或者双击 `start.cmd`：自己生成页面、起服务、开浏览器。那个黑窗口别关。

单独打开时只能看、不能问 —— 模板里没有接入点，「发送」会提示去 Harness 里打开。
双击 `dist/index.html`（`file://`）也能看，但改完台账不会自动重渲染，那是服务的活。

## 改什么

- `ledger.json` —— 台账数据（条目、处理记录、指标）
- `board.config.json` —— 车道 / 状态 / 严重度 / 视图
- `scripts/lib/css.mjs` —— 全部样式，改视觉只改这一个文件

改完 `ledger.json` 刷新浏览器就是最新，不用重跑命令。

## 指标配色是一份三方契约

侧栏「概览指标」每条有自己的 `status`，渲染时拼成 `.metric-<status>` 取配色。合法值写在
`board.config.json` 的 `metricStatuses` 里，默认四档：

```jsonc
"metricStatuses": ["ok", "warn", "danger", "muted"]
```

台账里写了表外的值（比如 `purple`），页面不报错，只是那条指标悄悄没配色。
`verify-board.mjs` 会点名是哪个指标的 status 写错了，也会检查「声明了几档、CSS 就必须有几条规则」。
想加一档，三处一起改：`metricStatuses` 加值、`scripts/lib/css.mjs` 加 `.metric-<值>` 规则、
需要时在 `scripts/lib/parts.mjs` 里补默认值。

## 空台账是合法的

`items: []` 也能渲染、也能过自检 —— 先建板、再慢慢填条目。
