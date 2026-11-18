/**
 * dsh-ops-board — browser half (hand-written __ModuleLoader__ bundle, no build step).
 *
 * Adds a full-page "项目看板 / Ops Board" panel to the Harness shell plus an icon
 * in the left sidebar. The panel switches between the registered project
 * boards; each board is the authored ops-board page, served same-origin by the
 * host at /ops-board/b/<id>/ and proxied to that board's own local server.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ops-board',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-ops-board'
    const PANEL_ID = 'ops-board'
    const STATE_URL = '/ops-board/state'
    const START_URL = '/ops-board/start'
    const BOARDS_URL = '/ops-board/boards'
    const CREATE_URL = '/ops-board/boards/create'
const PROBE_URL = '/ops-board/boards/probe'
    const REMOVE_URL = '/ops-board/boards/remove'
    const STORE_KEY = 'dsh-ops-board.board'

    const zh = {
      panel: '项目看板',
      title: '项目看板',
      refresh: '刷新',
      manage: '管理',
      openExternal: '在浏览器打开',
      statusReady: '看板服务已就绪',
      statusStarting: '正在启动看板服务…',
      statusDown: '看板服务没起来',
      statusUnknown: '正在连接…',
      statusNoBoard: '还没有添加看板',
      loading: '正在连接项目看板…',
      emptyTitle: '项目看板没起来',
      emptyHint: '这个页面只是壳，看板内容由本机的 ops-board 服务提供。',
      noBoardTitle: '还没有看板',
      noBoardHint: '添加一个 ops-board 目录（含 ledger.json 与 scripts/serve.mjs），就能在这里看它的报告。',
      addBoard: '添加看板',
      start: '启动看板服务',
      starting: '启动中…',
      retry: '重试',
      details: '启动日志',
      items: '条',
      updatedAt: '更新于',
      managerTitle: '看板管理',
      managerHint: '每个看板是一个独立的 ops-board 目录：ledger.json 写台账，board.config.json 定车道，ai.config.json 管问 AI。',
      current: '当前',
      open: '打开',
      remove: '删除',
      confirmRemove: '再点一次确认',
      cancel: '取消',
      labelPlaceholder: '名称（留空则用台账里的项目名）',
      dirPlaceholder: '看板目录（含 ledger.json 与 scripts/serve.mjs 的那个文件夹）',
      add: '添加',
      adding: '添加中…',
      registry: '注册表',
      noBoardsYet: '还没有记录。把现有的 ops-board 目录填进来即可。',
      createTitle: '新建看板',
      createHint: '选一个项目（可选），再选报文存放位置；会在该位置下新建一个以项目命名的文件夹，并生成 ledger.json、board.config.json 与运行脚本。',
      projectLabel: '项目目录（可选）',
      projectPlaceholder: '选一个代码项目，生成时会用它的名字和简介初始化报文',
      storageLabel: '报文存放位置（必选）',
      storagePlaceholder: '选择一个用来存放报文实例的目录',
      choose: '选择…',
      createButton: '生成看板',
      creating: '生成中…',
      createFailed: '创建失败',
      storageRequired: '请选择报文存放位置',
      lastUsedTag: '上次用过',
      nameLabel: '名称（可选）',
      generateLabel: '创建后让 Harness 读项目并生成报文',
      genModeLabel: '生成档位',
      genModeFast: '快速档（约 1 分钟）',
      genModeFastHint: '只读文件，不跑构建，出 5~10 条骨架，每条标「待核实」。先看成品长什么样。',
      genModeDeep: '实测档（可能十几分钟）',
      genModeDeepHint: '跑构建 / 测试 / 排查命令拿真实证据，条目按实际情况。慢，但证据硬。',
      probeTitle: '这个项目里有多少可依据的东西',
      probeEmpty: '没指定项目目录，只能按看板现有数据出骨架。',
      existingTitle: '已有看板',
      addExistingTitle: '添加已有目录（高级）',
      addExistingHint: '已经有一份 ops-board 目录时，直接登记它。',
      pickFailed: '选择目录失败',
      onboardStarting: '正在生成第一版台账：Harness 正在读项目并梳理…（快速档约 1 分钟，实测档可能十几分钟）',
      onboardDone: '第一版台账已生成，点「刷新」查看。',
      onboardFailed: '第一版台账生成失败',
      onboardDismiss: '知道了',
      chatPin: '置顶（盖在其它窗口上面）',
      chatUnpin: '取消置顶',
      chatCollapse: '收起（只留标题栏）',
      chatExpand: '展开',
      chatClose: '关闭对话窗',
    }

    const en = {
      panel: 'Ops Board',
      title: 'Ops Board',
      refresh: 'Refresh',
      manage: 'Manage',
      openExternal: 'Open in browser',
      statusReady: 'Board service is ready',
      statusStarting: 'Starting the board service…',
      statusDown: 'Board service is down',
      statusUnknown: 'Connecting…',
      statusNoBoard: 'No boards yet',
      loading: 'Connecting to the board…',
      emptyTitle: 'The board is not running',
      emptyHint: 'This panel is only the shell; the board content comes from the local ops-board service.',
      noBoardTitle: 'No boards yet',
      noBoardHint: 'Add an ops-board directory (ledger.json + scripts/serve.mjs) to show its report here.',
      addBoard: 'Add board',
      start: 'Start the board service',
      starting: 'Starting…',
      retry: 'Retry',
      details: 'Startup log',
      items: 'items',
      updatedAt: 'updated',
      managerTitle: 'Boards',
      managerHint: 'Each board is an independent ops-board checkout: ledger.json for the ledger, board.config.json for lanes, ai.config.json for AI.',
      current: 'current',
      open: 'Open',
      remove: 'Remove',
      confirmRemove: 'Click again to confirm',
      cancel: 'Cancel',
      labelPlaceholder: 'Label (empty = project name from the ledger)',
      dirPlaceholder: 'Board directory (the folder with ledger.json and scripts/serve.mjs)',
      add: 'Add',
      adding: 'Adding…',
      registry: 'Registry',
      noBoardsYet: 'Nothing registered yet. Point at an existing ops-board checkout above.',
      createTitle: 'New board',
      createHint: 'Pick a project (optional), then a storage location. A folder named after the project is created there with ledger.json, board.config.json and the runtime scripts.',
      projectLabel: 'Project directory (optional)',
      projectPlaceholder: 'Pick a code project; its name/description seeds the new report',
      storageLabel: 'Report storage location (required)',
      storagePlaceholder: 'Pick the directory that holds report instances',
      choose: 'Choose…',
      createButton: 'Create board',
      creating: 'Creating…',
      createFailed: 'Create failed',
      storageRequired: 'Choose a storage location',
      lastUsedTag: 'last used',
      nameLabel: 'Name (optional)',
      generateLabel: 'Generate the report from the project after creating',
      genModeLabel: 'Generation mode',
      genModeFast: 'Fast (~1 min)',
      genModeFastHint: 'Read files only, no builds. 5-10 skeleton items, each marked "unverified". See the shape first.',
      genModeDeep: 'Deep (may take 10+ min)',
      genModeDeepHint: 'Run builds / tests / probes for hard evidence. Slow, but the evidence is real.',
      probeTitle: 'How much the project actually records',
      probeEmpty: 'No project directory: only the board data can be used.',
      existingTitle: 'Existing boards',
      addExistingTitle: 'Add an existing directory (advanced)',
      addExistingHint: 'Register an ops-board checkout that already exists.',
      pickFailed: 'Directory picker failed',
      onboardStarting: 'Generating the first ledger: Harness is reading the project… (fast ~1 min, deep may take 10+ min)',
      onboardDone: 'First ledger generated — press Refresh to view.',
      onboardFailed: 'Failed to generate the first ledger',
      onboardDismiss: 'Dismiss',
      chatPin: 'Pin above other windows',
      chatUnpin: 'Unpin',
      chatCollapse: 'Collapse to title bar',
      chatExpand: 'Expand',
      chatClose: 'Close chat window',
    }

    const css =
      '.ob-root{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}' +
      '.ob-bar{flex:none;min-height:40px;display:flex;align-items:center;gap:8px;padding:4px 14px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);flex-wrap:nowrap}' +
      '.ob-title{font-size:13px;font-weight:600;letter-spacing:.2px;flex:none}' +
      '.ob-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ob-sub b{font-weight:500;color:var(--dsw-alias-label-secondary)}' +
      '.ob-spacer{flex:1 1 auto}' +
      '.ob-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-quaternary,#7a7f8c)}' +
      '.ob-dot[data-state="ready"]{background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.15)}' +
      '.ob-dot[data-state="starting"]{background:#d29922;animation:ob-pulse 1.1s ease-in-out infinite}' +
      '.ob-dot[data-state="down"]{background:#f85149}' +
      '@keyframes ob-pulse{0%,100%{opacity:.35}50%{opacity:1}}' +
      '.ob-state{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}' +
      '.ob-select{height:26px;max-width:220px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 6px;outline:none}' +
      '.ob-btn{flex:none;height:26px;padding:0 11px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;white-space:nowrap}' +
      '.ob-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.ob-btn:disabled{opacity:.5;cursor:default}' +
      '.ob-btn.ob-primary{background:var(--dsw-alias-state-business-primary,#3d78e6);border-color:transparent;color:#fff}' +
      '.ob-btn.ob-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-business-primary,#3d78e6)}' +
      '.ob-btn.ob-danger{color:#f85149;border-color:rgba(248,81,73,.45)}' +
      '.ob-frame{flex:1 1 auto;width:100%;min-height:0;border:0;display:block;background:#12141a}' +
      '.ob-empty{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px 24px;text-align:center}' +
      '.ob-empty-title{margin:0;font-size:15px;font-weight:600}' +
      '.ob-empty-text{margin:0;max-width:620px;font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary)}' +
      '.ob-actions{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:6px}' +
      '.ob-details{margin-top:12px;max-width:760px;width:100%;text-align:left}' +
      '.ob-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary)}' +
      '.ob-log{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:190px;overflow:auto}' +
      '.ob-layer{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}' +
      '.ob-modal{width:min(720px,94%);max-height:calc(100% - 24px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:18px 20px;box-shadow:0 18px 48px rgba(0,0,0,.45)}' +
      '.ob-modal-head{display:flex;align-items:center;gap:10px}' +
      '.ob-modal-head h3{margin:0;font-size:15px;font-weight:600;flex:1}' +
      '.ob-hint{margin:6px 0 14px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}' +
      '.ob-rows{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}' +
      '.ob-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}' +
      '.ob-row-main{min-width:0;flex:1}' +
      '.ob-row-label{font-size:13px;display:flex;align-items:center;gap:6px;min-width:0}' +
      '.ob-row-label b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ob-row-dir{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}' +
      '.ob-tag{font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;background:rgba(63,185,80,.16);color:#3fb950;flex:none}' +
      '.ob-section-title{font-size:13px;font-weight:600;margin:16px 0 6px}' +
      '.ob-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:9px 0 4px;display:flex;align-items:center}' +
      '.ob-create{padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}' +
      '.ob-create .ob-hint{margin:0 0 4px}' +
      '.ob-create-actions{display:flex;align-items:center;gap:10px;margin-top:10px}' +
      '.ob-form{display:flex;flex-direction:column;gap:8px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l3)}' +
      '.ob-form-row{display:flex;gap:8px}' +
      '.ob-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0 6px}' +
      '.ob-check input{accent-color:#3d78e6}' +
      // 两档生成：选中的那档加边框，说明文字用小号灰字，避免抢视觉
      '.ob-modes{display:flex;flex-direction:column;gap:6px;margin:2px 0 8px}' +
      '.ob-mode{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);cursor:pointer}' +
      '.ob-mode.is-on{border-color:#3d78e6;background:rgba(61,120,230,.07)}' +
      '.ob-mode input{margin-top:2px;accent-color:#3d78e6}' +
      '.ob-mode-text{display:flex;flex-direction:column;gap:2px;min-width:0}' +
      '.ob-mode-text b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.ob-mode-text em{font-style:normal;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}' +
      // 探测结果：先摊开「有什么、没什么」，再决定要不要生成
      '.ob-probe{margin:2px 0 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03))}' +
      '.ob-probe-head{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:4px}' +
      '.ob-probe-signals{margin:0;padding-left:16px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}' +
      '.ob-probe-note{margin:6px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}' +
      '.ob-input{flex:1;min-width:0;height:30px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 10px;outline:none}' +
      '.ob-input:focus{border-color:var(--dsw-alias-state-business-primary,#3d78e6)}' +
      '.ob-err{color:#f85149;font-size:12px;margin:0}' +
      '.ob-registry{font-size:11px;color:var(--dsw-alias-label-quaternary);margin:12px 0 0;word-break:break-all}' +
      // 首次生成第一版台账的进度条
      '.ob-onboard{flex:none;display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:1.5}' +
      '.ob-onboard-busy{background:rgba(210,153,34,.10)}' +
      '.ob-onboard-ok{background:rgba(63,185,80,.10)}' +
      '.ob-onboard-error{background:rgba(248,81,73,.10)}' +
      '.ob-onboard-dot{flex:none;width:8px;height:8px;border-radius:50%}' +
      '.ob-onboard-dot[data-phase="starting"]{background:#d29922;animation:ob-pulse 1.1s ease-in-out infinite}' +
      '.ob-onboard-dot[data-phase="done"]{background:#3fb950}' +
      '.ob-onboard-dot[data-phase="error"]{background:#f85149}' +
      '.ob-onboard-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary)}' +
      // ── 独立对话窗 ─────────────────────────────────────────────────
      // 画在 Harness 外壳层（挂 document.body，position:fixed），所以它能盖住
      // 侧边栏和顶栏，不受看板 iframe 矩形限制。
      // 层级取 2147483000 这一档：只要不跟宿主自己的模态抢，就压在所有东西上面。
      '.ob-chatwin{position:fixed;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 22px 64px rgba(0,0,0,.46);overflow:hidden;z-index:2147483000}' +
      '.ob-chatwin[data-pinned="1"]{z-index:2147483100;box-shadow:0 26px 80px rgba(0,0,0,.56)}' +
      '.ob-chatwin[data-collapsed="1"]{height:auto!important}' +
      '.ob-chatwin[data-collapsed="1"] .ob-chatwin-body{display:none}' +
      '.ob-chatwin-head{flex:none;display:flex;align-items:center;gap:8px;padding:0 4px 0 12px;height:34px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);cursor:move;user-select:none;touch-action:none}' +
      '.ob-chatwin-title{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ob-chatwin-btn{appearance:none;flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:0}' +
      '.ob-chatwin-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary)}' +
      '.ob-chatwin-btn[aria-pressed="true"]{color:#3d78e6}' +
      '.ob-chatwin-body{flex:1 1 auto;min-height:0;display:flex}' +
      '.ob-chatwin-frame{flex:1 1 auto;width:100%;border:0;display:block;background:transparent}' +
      '.ob-chatwin-grip{position:absolute;z-index:2;touch-action:none}' +
      '.ob-chatwin-grip[data-dir="n"]{top:-3px;left:10px;right:10px;height:7px;cursor:ns-resize}' +
      '.ob-chatwin-grip[data-dir="s"]{bottom:-3px;left:10px;right:10px;height:7px;cursor:ns-resize}' +
      '.ob-chatwin-grip[data-dir="w"]{left:-3px;top:10px;bottom:10px;width:7px;cursor:ew-resize}' +
      '.ob-chatwin-grip[data-dir="e"]{right:-3px;top:10px;bottom:10px;width:7px;cursor:ew-resize}' +
      '.ob-chatwin-grip[data-dir="nw"]{top:-3px;left:-3px;width:13px;height:13px;cursor:nwse-resize}' +
      '.ob-chatwin-grip[data-dir="ne"]{top:-3px;right:-3px;width:13px;height:13px;cursor:nesw-resize}' +
      '.ob-chatwin-grip[data-dir="sw"]{bottom:-3px;left:-3px;width:13px;height:13px;cursor:nesw-resize}' +
      '.ob-chatwin-grip[data-dir="se"]{bottom:-3px;right:-3px;width:13px;height:13px;cursor:nwse-resize}' +
      '.ob-chatwin-grip[data-dir="se"]::after{content:"";position:absolute;right:4px;bottom:4px;width:7px;height:7px;border-right:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.5));border-bottom:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.5));border-bottom-right-radius:2px;pointer-events:none}' +
      '.ob-chatwin.is-moving,.ob-chatwin.is-moving *{user-select:none!important}' +
      // 拖动时让 iframe 别再吃指针：光标压到窗口内部时，事件否则会落到 iframe
      // 那个文档里，外层就收不到 pointermove 了（配合 setPointerCapture 双保险）。
      '.ob-chatwin.is-moving .ob-chatwin-frame{pointer-events:none}'

    const tagId = 'dsh-ops-board/styles'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-ops-board'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    function shortDate(value) {
      const text = String(value || '')
      const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
      return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : text
    }

    /**
     * Accept the pre-multi-board host shape ({ ready, boardDir, project, url })
     * so a hot-updated client stays usable until the Host half is reloaded.
     */
    function normalizeState(body) {
      if (!body || Array.isArray(body.boards)) return body
      if (body.boardDir === undefined && body.ready === undefined) return body
      const id = 'legacy'
      return {
        ok: true,
        boards: [
          {
            id,
            label: (body.project && body.project.name) || '项目看板',
            dir: body.boardDir || '',
            configured: body.configured !== false,
            ready: Boolean(body.ready),
            starting: Boolean(body.starting),
            project: body.project || null,
            port: body.port || 0,
            url: body.url || '',
            proxy: '/ops-board/live/',
            error: body.error || '',
            log: body.log || '',
            owned: Boolean(body.owned),
          },
        ],
        last: id,
        registryFile: '',
      }
    }

    function boardStatus(board, t) {
      if (!board) return t('statusNoBoard')
      if (board.starting) return t('statusStarting')
      return board.ready ? t('statusReady') : t('statusDown')
    }

    function dotState(board) {
      if (!board) return 'down'
      if (board.starting) return 'starting'
      return board.ready ? 'ready' : 'down'
    }

    // ── 独立对话窗的几何 ──────────────────────────────────────────────
    //
    // 键前缀 ops-board- 是刻意的：看板的「清空本机偏好」按这个前缀整片清，
    // 用户想把窗口位置忘掉时不用再记一个键名。
    const CHAT_GEOM_KEY = 'ops-board-chatwin'
    const CHAT_PIN_KEY = 'ops-board-chatwin-pin'
    const CHAT_EDGE = 6
    const CHAT_MIN_W = 340
    const CHAT_MIN_H = 260

    function chatViewport() {
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 800
      return { vw, vh }
    }

    /**
     * 把窗口夹进视口。必须先夹再加最小尺寸：反过来的话，
     * 视口比最小尺寸还小时，「夹回视口」会把窗口推出边界。
     */
    function clampChatGeom(input) {
      const { vw, vh } = chatViewport()
      const maxW = Math.max(120, vw - CHAT_EDGE * 2)
      const maxH = Math.max(120, vh - CHAT_EDGE * 2)
      const w = Math.min(Math.max(Number(input.w) || CHAT_MIN_W, 120), maxW)
      const h = Math.min(Math.max(Number(input.h) || CHAT_MIN_H, 120), maxH)
      const x = Math.min(Math.max(Number(input.x) || 0, CHAT_EDGE), Math.max(CHAT_EDGE, vw - CHAT_EDGE - w))
      const y = Math.min(Math.max(Number(input.y) || 0, CHAT_EDGE), Math.max(CHAT_EDGE, vh - CHAT_EDGE - h))
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
    }

    function defaultChatGeom() {
      const { vw, vh } = chatViewport()
      const w = Math.min(520, vw - 60)
      const h = Math.min(660, vh - 90)
      // 默认靠右下，跟看板里那个浮窗的位置一致，用户不用重新找它。
      return clampChatGeom({ x: vw - w - 28, y: vh - h - 40, w, h })
    }

    function readChatGeom() {
      try {
        const raw = window.localStorage.getItem(CHAT_GEOM_KEY)
        if (raw) {
          const value = JSON.parse(raw)
          if (value && typeof value === 'object') return clampChatGeom(value)
        }
      } catch {}
      return defaultChatGeom()
    }

    function readChatPinned() {
      try {
        return window.localStorage.getItem(CHAT_PIN_KEY) === '1'
      } catch {
        return false
      }
    }

    /**
     * 一次拖拽 / 拉角之后的新几何。
     *
     * 拉边的时候对边必须钉住：只改 width 会让窗口朝右下「长出去」，
     * 手感像整块在漂。所以拖左/上边时要同时改 x/y。
     */
    function nextChatGeom(start, mode, dir, dx, dy) {
      if (mode === 'move') {
        return clampChatGeom({ x: start.x + dx, y: start.y + dy, w: start.w, h: start.h })
      }
      let { x, y, w, h } = start
      if (dir.indexOf('w') >= 0) {
        const nx = Math.min(x + dx, x + w - CHAT_MIN_W)
        w = w + (x - nx)
        x = nx
      }
      if (dir.indexOf('e') >= 0) {
        w = Math.max(CHAT_MIN_W, w + dx)
      }
      if (dir.indexOf('n') >= 0) {
        const ny = Math.min(y + dy, y + h - CHAT_MIN_H)
        h = h + (y - ny)
        y = ny
      }
      if (dir.indexOf('s') >= 0) {
        h = Math.max(CHAT_MIN_H, h + dy)
      }
      return clampChatGeom({ x, y, w, h })
    }

    function readStoredBoard() {
      try {
        return window.localStorage.getItem(STORE_KEY) || ''
      } catch {
        return ''
      }
    }

    function storeBoard(id) {
      try {
        if (id) window.localStorage.setItem(STORE_KEY, id)
      } catch {}
    }

    function Manager(props) {
      const t = props.t
      const state = props.state
      const selectedId = props.selectedId
      const boards = (state && state.boards) || []

      const [projectDir, setProjectDir] = useState('')
      const [root, setRoot] = useState((state && (state.lastCreateDir || state.defaultCreateDir)) || '')
      const [newLabel, setNewLabel] = useState('')
      const [autoGenerate, setAutoGenerate] = useState(true)
      // 两档：fast 只读出骨架（默认，第一次上手先看到东西）；deep 跑构建跑测试拿硬证据
      const [genMode, setGenMode] = useState('fast')
      const [probe, setProbe] = useState(null)
      const [creating, setCreating] = useState(false)
      const [createError, setCreateError] = useState('')

      const [label, setLabel] = useState('')
      const [dir, setDir] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [confirmId, setConfirmId] = useState('')

      useEffect(() => {
        if (root) return
        const fallback = (state && (state.lastCreateDir || state.defaultCreateDir)) || ''
        if (fallback) setRoot(fallback)
      }, [state, root])

      const pick = async (setPath) => {
        if (typeof props.pickDirectory !== 'function') {
          setCreateError(t('pickFailed'))
          return
        }
        try {
          const path = await props.pickDirectory()
          if (path) setPath(path)
        } catch (failure) {
          setCreateError(t('pickFailed') + '：' + String((failure && failure.message) || failure))
        }
      }

      // 探测项目里有多少可依据的东西。只读，不改项目，失败就静默（探测不该挡住创建）。
      const runProbe = async (dir) => {
        const clean = String(dir || '').trim()
        if (!clean) {
          setProbe(null)
          return
        }
        try {
          const response = await fetch(PROBE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectDir: clean }),
          })
          const body = await response.json()
          setProbe(body && body.ok ? body.probe : null)
        } catch {
          setProbe(null)
        }
      }

      const create = async (event) => {
        event.preventDefault()
        if (creating) return
        if (!root.trim()) {
          setCreateError(t('storageRequired'))
          return
        }
        setCreating(true)
        setCreateError('')
        try {
          const response = await fetch(CREATE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              label: newLabel.trim(),
              projectDir: projectDir.trim(),
              root: root.trim(),
              generate: autoGenerate,
              mode: genMode,
            }),
          })
          const body = await response.json()
          if (!body.ok) {
            setCreateError(body.error || t('createFailed'))
          } else {
            props.onChanged(body.state, body.board && body.board.id)
            props.onClose()
            return
          }
        } catch (failure) {
          setCreateError(String((failure && failure.message) || failure))
        } finally {
          setCreating(false)
        }
      }

      const submit = async (event) => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const response = await fetch(BOARDS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: label.trim(), dir: dir.trim() }),
          })
          const body = await response.json()
          if (!body.ok) {
            setError(body.error || '添加失败')
          } else {
            setLabel('')
            setDir('')
            props.onChanged(body.state, body.board && body.board.id)
          }
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setBusy(false)
        }
      }

      const remove = async (id) => {
        if (confirmId !== id) {
          setConfirmId(id)
          return
        }
        setConfirmId('')
        try {
          const response = await fetch(REMOVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          const body = await response.json()
          if (body.ok) props.onChanged(body.state, '')
          else setError(body.error || '删除失败')
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        }
      }

      const rows = boards.length
        ? boards.map((board) =>
            h(
              'div',
              { key: board.id, className: 'ob-row' },
              h('span', { className: 'ob-dot', 'data-state': dotState(board) }),
              h(
                'div',
                { className: 'ob-row-main' },
                h(
                  'div',
                  { className: 'ob-row-label' },
                  h('b', {}, board.label || board.id),
                  board.id === selectedId ? h('span', { className: 'ob-tag' }, t('current')) : null,
                ),
                h('div', { className: 'ob-row-dir', title: board.dir }, board.dir),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ob-btn',
                  onClick: () => props.onOpen(board.id),
                },
                t('open'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ob-btn ob-danger',
                  onClick: () => remove(board.id),
                },
                confirmId === board.id ? t('confirmRemove') : t('remove'),
              ),
            ),
          )
        : [h('p', { key: 'empty', className: 'ob-hint', style: { margin: 0 } }, t('noBoardsYet'))]

      return h(
        'div',
        { className: 'ob-layer', onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h(
          'div',
          { className: 'ob-modal' },
          h(
            'div',
            { className: 'ob-modal-head' },
            h('h3', {}, t('managerTitle')),
            h('button', { type: 'button', className: 'ob-btn', onClick: props.onClose }, t('cancel')),
          ),
          h('p', { className: 'ob-hint' }, t('managerHint')),
          h(
            'form',
            { className: 'ob-create', onSubmit: create },
            h('div', { className: 'ob-section-title', style: { marginTop: 0 } }, t('createTitle')),
            h('p', { className: 'ob-hint' }, t('createHint')),
            h('div', { className: 'ob-field-label' }, t('projectLabel')),
            h(
              'div',
              { className: 'ob-form-row' },
              h('input', {
                className: 'ob-input',
                value: projectDir,
                placeholder: t('projectPlaceholder'),
                onChange: (event) => {
                  setProjectDir(event.target.value)
                  setProbe(null)
                },
                onBlur: (event) => runProbe(event.target.value),
                spellCheck: false,
              }),
              h('button', {
                type: 'button',
                className: 'ob-btn',
                onClick: async () => {
                  await pick(setProjectDir)
                  await runProbe(projectDir)
                },
              }, t('choose')),
            ),
            h(
              'div',
              { className: 'ob-field-label' },
              t('storageLabel'),
              state && state.lastCreateDir
                ? h('span', { className: 'ob-tag', style: { marginLeft: 6 } }, t('lastUsedTag'))
                : null,
            ),
            h(
              'div',
              { className: 'ob-form-row' },
              h('input', {
                className: 'ob-input',
                value: root,
                placeholder: t('storagePlaceholder'),
                onChange: (event) => setRoot(event.target.value),
                spellCheck: false,
              }),
              h('button', { type: 'button', className: 'ob-btn', onClick: () => pick(setRoot) }, t('choose')),
            ),
            h('div', { className: 'ob-field-label' }, t('nameLabel')),
            h(
              'div',
              { className: 'ob-form-row' },
              h('input', {
                className: 'ob-input',
                value: newLabel,
                placeholder: t('labelPlaceholder'),
                onChange: (event) => setNewLabel(event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'ob-check' },
              h('input', {
                type: 'checkbox',
                checked: autoGenerate,
                onChange: (event) => setAutoGenerate(event.target.checked),
              }),
              t('generateLabel'),
            ),
            // 两档：默认快速档 —— 第一次上手最重要的是「1 分钟内看到东西」，
            // 而不是「一次到位」。要硬证据的人自己切实测档。
            autoGenerate
              ? h(
                  'div',
                  { className: 'ob-modes' },
                  h('div', { className: 'ob-field-label' }, t('genModeLabel')),
                  [
                    { key: 'fast', label: t('genModeFast'), hint: t('genModeFastHint') },
                    { key: 'deep', label: t('genModeDeep'), hint: t('genModeDeepHint') },
                  ].map((mode) =>
                    h(
                      'label',
                      {
                        key: mode.key,
                        className: 'ob-mode' + (genMode === mode.key ? ' is-on' : ''),
                        'data-mode': mode.key,
                      },
                      h('input', {
                        type: 'radio',
                        name: 'ob-gen-mode',
                        checked: genMode === mode.key,
                        onChange: () => setGenMode(mode.key),
                      }),
                      h(
                        'span',
                        { className: 'ob-mode-text' },
                        h('b', null, mode.label),
                        h('em', null, mode.hint),
                      ),
                    ),
                  ),
                )
              : null,
            // 探测：把「这个项目里有多少可依据的东西」先摊开，
            // 免得等 agent 说完才发现项目里什么都没记。
            autoGenerate && projectDir.trim()
              ? h(
                  'div',
                  { className: 'ob-probe' },
                  probe
                    ? [
                        h('div', { className: 'ob-probe-head' }, t('probeTitle')),
                        h(
                          'ul',
                          { className: 'ob-probe-signals' },
                          (probe.signals || []).length
                            ? probe.signals.map((s, i) => h('li', { key: i }, s))
                            : h('li', null, t('probeEmpty')),
                        ),
                        h('p', { className: 'ob-probe-note' }, probe.note || ''),
                      ]
                    : null,
                )
              : null,
            h(
              'div',
              { className: 'ob-create-actions' },
              h(
                'button',
                { type: 'submit', className: 'ob-btn ob-primary', disabled: creating || !root.trim() },
                creating ? t('creating') : t('createButton'),
              ),
            ),
            createError ? h('p', { className: 'ob-err' }, createError) : null,
          ),
          h('div', { className: 'ob-section-title' }, t('existingTitle')),
          h('div', { className: 'ob-rows' }, rows),
          h(
            'form',
            { className: 'ob-form', onSubmit: submit },
            h('div', { className: 'ob-section-title' }, t('addExistingTitle')),
            h('p', { className: 'ob-hint', style: { margin: '0 0 6px' } }, t('addExistingHint')),
            h(
              'div',
              { className: 'ob-form-row' },
              h('input', {
                className: 'ob-input',
                value: label,
                placeholder: t('labelPlaceholder'),
                onChange: (event) => setLabel(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'ob-form-row' },
              h('input', {
                className: 'ob-input',
                value: dir,
                placeholder: t('dirPlaceholder'),
                onChange: (event) => setDir(event.target.value),
                spellCheck: false,
              }),
              h(
                'button',
                { type: 'submit', className: 'ob-btn ob-primary', disabled: busy || !dir.trim() },
                busy ? t('adding') : t('add'),
              ),
            ),
            error ? h('p', { className: 'ob-err' }, error) : null,
          ),
          state && state.registryFile
            ? h('p', { className: 'ob-registry' }, t('registry') + ': ' + state.registryFile)
            : null,
        ),
      )
    }

    function OpsBoardPanel(props) {
      const t = props.t
      const [state, setState] = useState(null)
      const [boardId, setBoardId] = useState(() => readStoredBoard())
      const [frameKey, setFrameKey] = useState(0)
      const [busy, setBusy] = useState(false)
      const [managerOpen, setManagerOpen] = useState(false)
      const alive = useRef(true)
      const started = useRef('')
      // 首次生成第一版台账的进行状态：{ board, phase: 'starting'|'done'|'error', error? }
      const [onboard, setOnboard] = useState(null)

      useEffect(() => {
        const listener = (event) => {
          if (!event || event.type !== 'onboard') return
          setOnboard({ board: event.board, phase: event.phase, error: event.error || '' })
          if (event.phase === 'starting') {
            // 生成开始了：顺手把面板指到这个正在生成的看板，用户能第一时间看到进度条。
            setBoardId(event.board)
            storeBoard(event.board)
          }
        }
        onboardListeners.add(listener)
        return () => onboardListeners.delete(listener)
      }, [])

      const load = useCallback(async () => {
        try {
          const response = await fetch(STATE_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
          const body = await response.json()
          const normalized = normalizeState(body)
          if (alive.current) setState(normalized)
          return normalized
        } catch (error) {
          if (alive.current) {
            setState({
              ok: false,
              boards: [],
              error: '读不到 Harness 的看板状态接口：' + String((error && error.message) || error),
            })
          }
          return null
        }
      }, [])

      useEffect(() => {
        alive.current = true
        let timer
        const tick = async () => {
          await load()
          if (alive.current) timer = setTimeout(tick, 3500)
        }
        tick()
        return () => {
          alive.current = false
          clearTimeout(timer)
        }
      }, [load])

      const boards = (state && state.boards) || []
      const selected =
        boards.find((board) => board.id === boardId) ||
        boards.find((board) => board.id === (state && state.last)) ||
        boards[0] ||
        null

      useEffect(() => {
        if (selected && selected.id !== boardId) {
          setBoardId(selected.id)
          storeBoard(selected.id)
        }
      }, [selected, boardId])

      const start = useCallback(async (id) => {
        if (!id) return
        setBusy(true)
        try {
          const response = await fetch(START_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ board: id }),
          })
          const body = await response.json()
          if (alive.current) setState(normalizeState(body))
        } catch {
          // the poller will retry
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [])

      useEffect(() => {
        if (!selected || selected.ready || selected.starting) return
        if (started.current === selected.id) return
        started.current = selected.id
        start(selected.id)
      }, [selected, start])

      const selectBoard = useCallback(
        (id) => {
          setBoardId(id)
          storeBoard(id)
          setFrameKey((value) => value + 1)
          const board = boards.find((item) => item.id === id)
          if (board && !board.ready && !board.starting) start(id)
        },
        [boards, start],
      )

      const refresh = useCallback(() => {
        setFrameKey((value) => value + 1)
        load()
      }, [load])

      const openExternal = useCallback(async () => {
        if (!selected) return
        // A board that is not running has no page behind the proxy: opening it
        // in a browser would land on an empty document. Start it first, then
        // open, so the button always shows something.
        if (!selected.ready) {
          try {
            await start(selected.id)
          } catch {}
        }
        // The desktop shell turns `window.open` into shell.openExternal for
        // http(s) only, so the URL has to be absolute and http(s). The Host
        // reports its own request origin (`state.origin`), which stays correct
        // even when the page itself runs on a dsh-app:// origin.
        const path = selected.proxy && selected.proxy.startsWith('/') ? selected.proxy : `/ops-board/b/${selected.id}/`
        const base = (state && state.origin) || window.location.origin
        const url = /^https?:/i.test(path) ? path : base + path.replace(/\/*$/, '/')
        try {
          const opened = window.open(url, '_blank', 'noopener,noreferrer')
          if (!opened) window.location.assign(url)
        } catch {
          try {
            window.location.assign(url)
          } catch {}
        }
      }, [selected, state, start])

      const onChanged = useCallback(
        (nextState, nextId) => {
          const normalized = nextState ? normalizeState(nextState) : null
          if (normalized) setState(normalized)
          if (nextId) {
            setBoardId(nextId)
            storeBoard(nextId)
            setFrameKey((value) => value + 1)
            const board = ((normalized && normalized.boards) || []).find((item) => item.id === nextId)
            if (board && !board.ready && !board.starting) start(nextId)
          }
        },
        [start],
      )

      const project = selected && selected.project
      const sub = []
      if (project && project.name) {
        sub.push(h('b', { key: 'name' }, project.name))
        if (project.subtitle) sub.push(' · ' + project.subtitle)
        if (project.updatedAt) sub.push(' · ' + t('updatedAt') + ' ' + shortDate(project.updatedAt))
        if (project.items) sub.push(' · ' + project.items + ' ' + t('items'))
      } else if (selected) {
        sub.push(selected.label || selected.id)
      }

      const switcher =
        boards.length > 1
          ? h(
              'select',
              {
                className: 'ob-select',
                value: selected ? selected.id : '',
                onChange: (event) => selectBoard(event.target.value),
                title: t('manage'),
              },
              boards.map((board) => h('option', { key: board.id, value: board.id }, board.label || board.id)),
            )
          : null

      const bar = h(
        'div',
        { key: 'bar', className: 'ob-bar' },
        h('span', { className: 'ob-title' }, t('title')),
        switcher,
        h('span', { className: 'ob-sub' }, sub),
        h('span', { className: 'ob-spacer' }),
        h('span', { className: 'ob-dot', 'data-state': dotState(selected), title: boardStatus(selected, t) }),
        h('span', { className: 'ob-state' }, boardStatus(selected, t)),
        h(
          'button',
          {
            type: 'button',
            className: 'ob-btn',
            onClick: refresh,
            title: t('refresh'),
            disabled: !selected || !selected.ready,
          },
          t('refresh'),
        ),
        h('button', { type: 'button', className: 'ob-btn', onClick: () => setManagerOpen(true) }, t('manage')),
        h(
          'button',
          {
            type: 'button',
            className: 'ob-btn',
            onClick: openExternal,
            title: t('openExternal'),
            disabled: !selected,
          },
          t('openExternal'),
        ),
      )

      const children = [bar]

      // 首次生成第一版台账的进度条：生成开始时出现，完成/失败后保持一小段便于看到结果。
      // 只对「当前选中的看板」显示，不干扰其它看板。
      if (onboard && selected && onboard.board === selected.id) {
        children.push(
          h(
            'div',
            {
              key: 'onboard',
              className: 'ob-onboard ob-onboard-' + (onboard.phase === 'starting' ? 'busy' : onboard.phase === 'error' ? 'error' : 'ok'),
            },
            h(
              'span',
              { className: 'ob-onboard-dot', 'data-phase': onboard.phase },
            ),
            h(
              'span',
              { className: 'ob-onboard-text' },
              onboard.phase === 'starting'
                ? t('onboardStarting')
                : onboard.phase === 'error'
                  ? t('onboardFailed') + (onboard.error ? '：' + onboard.error : '')
                  : t('onboardDone'),
            ),
            onboard.phase !== 'starting'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ob-btn',
                    onClick: () => setOnboard(null),
                    title: t('onboardDismiss'),
                  },
                  t('onboardDismiss'),
                )
              : null,
          ),
        )
      }

      if (selected && selected.ready) {
        children.push(
          h('iframe', {
            key: selected.id + '-' + frameKey,
            className: 'ob-frame',
            src: selected.proxy,
            title: selected.label || t('title'),
            allow: 'clipboard-write',
          }),
        )
      } else if (state === null) {
        children.push(h('div', { key: 'loading', className: 'ob-empty' }, h('p', { className: 'ob-empty-text' }, t('loading'))))
      } else if (!selected) {
        children.push(
          h(
            'div',
            { key: 'no-board', className: 'ob-empty' },
            h('h2', { className: 'ob-empty-title' }, t('noBoardTitle')),
            h('p', { className: 'ob-empty-text' }, t('noBoardHint')),
            h(
              'div',
              { className: 'ob-actions' },
              h('button', { type: 'button', className: 'ob-btn ob-primary', onClick: () => setManagerOpen(true) }, t('addBoard')),
            ),
            state.error ? h('p', { className: 'ob-empty-text' }, String(state.error)) : null,
          ),
        )
      } else {
        const empty = []
        empty.push(h('h2', { key: 'title', className: 'ob-empty-title' }, t('emptyTitle')))
        empty.push(h('p', { key: 'hint', className: 'ob-empty-text' }, t('emptyHint')))
        if (selected.error) empty.push(h('p', { key: 'error', className: 'ob-empty-text' }, String(selected.error)))
        if (selected.dir) empty.push(h('p', { key: 'dir', className: 'ob-empty-text' }, selected.dir))
        const buttons = []
        if (selected.configured !== false) {
          buttons.push(
            h(
              'button',
              {
                key: 'start',
                type: 'button',
                className: 'ob-btn ob-primary',
                onClick: () => {
                  started.current = selected.id
                  start(selected.id)
                },
                disabled: busy || Boolean(selected.starting),
              },
              busy || selected.starting ? t('starting') : t('start'),
            ),
          )
          buttons.push(h('button', { key: 'retry', type: 'button', className: 'ob-btn', onClick: load }, t('retry')))
        }
        empty.push(h('div', { key: 'actions', className: 'ob-actions' }, buttons))
        if (selected.log) {
          empty.push(
            h(
              'details',
              { key: 'details', className: 'ob-details' },
              h('summary', {}, t('details')),
              h('pre', { className: 'ob-log' }, String(selected.log)),
            ),
          )
        }
        children.push(h('div', { key: 'empty', className: 'ob-empty' }, empty))
      }

      if (managerOpen) {
        children.push(
          h(Manager, {
            key: 'manager',
            t,
            state,
            selectedId: selected ? selected.id : '',
            pickDirectory: props.pickDirectory,
            onClose: () => setManagerOpen(false),
            onOpen: (id) => {
              selectBoard(id)
              setManagerOpen(false)
            },
            onChanged,
          }),
        )
      }

      return h('div', { className: 'ob-root' }, children)
    }

    /**
     * 独立对话窗 —— 整个看板的对话框，但画在 Harness 外壳层。
     *
     * 为什么不能留在看板页面里：看板跑在 .ob-frame 这个 iframe 里，页面里的
     * position:fixed 只在 iframe 的矩形内生效，永远盖不到侧边栏和顶栏，
     * 也没法拖出去。所谓「脱离看板界面」只能是「画在 iframe 外面」。
     *
     * 本组件的做法：document.body 上单独开一个 React 根（mountChatWindow），
     * 窗口 position:fixed、z-index 压在最上面，于是它相对整个应用窗口定位 ——
     * 拖动、拉大小、置顶都成立。窗口内容仍是一份看板页面，只是加载时带
     * ?chat=1，那份页面把自己裁成「只剩对话框」。
     *
     * 为什么不在 slot 里画：宿主 slot 的投影尺寸由它自己的容器决定，
     * 曾经实测「注册成功、active:true、但渲染出来不可见且不报错」。
     * 这里要的是一个相对整个视口定位的浮层，DOM 直挂 body 是最稳的 ——
     * 也正是因为挂了 body、不挂在面板树里，收起面板、切到别的页，窗口都还在。
     */
    function OpsBoardChatWindow(props) {
      const { proxy, title, onClose, t } = props
      const wrapRef = useRef(null)
      const [geom, setGeom] = useState(readChatGeom)
      const [pinned, setPinned] = useState(readChatPinned)
      const [collapsed, setCollapsed] = useState(false)

      // 几何写回 localStorage：关掉再打开还在老地方，跟普通窗口一个手感。
      // 键统一走 ops-board- 前缀，这样「清空本机偏好」能一起清掉。
      useEffect(() => {
        try {
          window.localStorage.setItem(CHAT_GEOM_KEY, JSON.stringify(geom))
        } catch {}
      }, [geom])

      useEffect(() => {
        try {
          window.localStorage.setItem(CHAT_PIN_KEY, pinned ? '1' : '0')
        } catch {}
      }, [pinned])

      // 视口变小（切分辨率、拉窄窗口）时夹回来，别让窗口飘到看不见的地方。
      useEffect(() => {
        const onResize = () => setGeom((g) => clampChatGeom(g))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 拖拽/拉角共用一套指针逻辑：pointer 事件对触屏和手写笔都成立。
      const beginDrag = useCallback((event, mode, dir) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const start = { x: event.clientX, y: event.clientY, geom: { ...geom } }
        const node = wrapRef.current
        if (node) node.classList.add('is-moving')

        // 指针捕获是这里的关键：窗口本体就是一个 iframe，光标一旦压到它上面，
        // pointermove 会被 iframe 那个文档吃掉，外面就收不到事件了 ——
        // 表现是「拖到 iframe 上就卡住不动，松手也没反应」。
        // 捕获之后事件全部重定向到按下去的那个元素，iframe 插不上手。
        // （CSS 里那条 .is-moving .ob-chatwin-frame{pointer-events:none} 是第二道保险，
        //   防止某些合成事件不走捕获路径。）
        const captureTarget = event.currentTarget
        try {
          if (captureTarget && captureTarget.setPointerCapture) {
            captureTarget.setPointerCapture(event.pointerId)
          }
        } catch {}

        const move = (ev) => {
          const dx = ev.clientX - start.x
          const dy = ev.clientY - start.y
          setGeom(nextChatGeom(start.geom, mode, dir, dx, dy))
        }
        const up = (ev) => {
          if (node) node.classList.remove('is-moving')
          try {
            if (captureTarget && captureTarget.releasePointerCapture && ev && ev.pointerId != null) {
              captureTarget.releasePointerCapture(ev.pointerId)
            }
          } catch {}
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          setGeom((g) => clampChatGeom(g))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }, [geom])

      const body = h(
        'div',
        { className: 'ob-chatwin-body' },
        h('iframe', {
          className: 'ob-chatwin-frame',
          src:
            proxy +
            (proxy.indexOf('?') >= 0 ? '&' : '?') +
            'chat=1' +
            (props.scope ? '&scope=' + encodeURIComponent(props.scope) : ''),
          title: title || t('title'),
          allow: 'clipboard-write',
        }),
      )

      const grips = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].map((dir) =>
        h('span', {
          key: dir,
          className: 'ob-chatwin-grip',
          'data-dir': dir,
          onPointerDown: (event) => beginDrag(event, 'resize', dir),
        }),
      )

      const head = h(
        'div',
        { className: 'ob-chatwin-head', onPointerDown: (event) => beginDrag(event, 'move') },
        h('span', { className: 'ob-chatwin-title' }, title || t('title')),
        h(
          'button',
          {
            type: 'button',
            className: 'ob-chatwin-btn',
            title: pinned ? t('chatUnpin') : t('chatPin'),
            'aria-pressed': pinned ? 'true' : 'false',
            onPointerDown: (event) => event.stopPropagation(),
            onClick: () => setPinned((v) => !v),
          },
          pinned ? '●' : '○',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ob-chatwin-btn',
            title: collapsed ? t('chatExpand') : t('chatCollapse'),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: () => setCollapsed((v) => !v),
          },
          collapsed ? '▢' : '—',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ob-chatwin-btn',
            title: t('chatClose'),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: onClose,
          },
          '×',
        ),
      )

      const node = h(
        'div',
        {
          ref: wrapRef,
          className: 'ob-chatwin',
          'data-pinned': pinned ? '1' : '0',
          'data-collapsed': collapsed ? '1' : '0',
          style: {
            left: geom.x + 'px',
            top: geom.y + 'px',
            width: geom.w + 'px',
            height: geom.h + 'px',
          },
        },
        head,
        body,
        grips,
      )

      return node
    }

    /**
     * 独立对话窗的宿主：在 document.body 上单独开一个 React 根。
     *
     * 为什么不放在面板组件里：窗口必须比面板活得久 —— 用户切到别的页、
     * 把面板收起来，对话窗都该还在。挂在面板树里，面板一卸载窗口就没了。
     *
     * 为什么用独立的 createRoot 而不是 createPortal：portal 仍然要求有一个
     * React 父组件常驻，而那个父组件（面板）恰恰是会被卸载的那个。
     * 独立根没有这个依赖，还不用把 react-dom 的 portal 拉进主渲染树。
     */
    function mountChatWindow(container, props) {
      // react-dom/client 在宿主里可能是 {createRoot}，也可能藏在 .default 里
      // （取决于它是 CJS 还是被转成 ESM）。两种都认，别假定只有一种形状。
      const client = require('react-dom/client')
      const createRoot =
        (client && client.createRoot) ||
        (client && client.default && client.default.createRoot) ||
        null
      if (!createRoot) throw new Error('react-dom/client 不可用，无法创建独立对话窗')
      const root = createRoot(container)
      root.render(h(OpsBoardChatWindow, props))
      return root
    }

    function OpsBoardIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }),
        h('path', { d: 'M7.5 8.5h9M7.5 12h9M7.5 15.5h5.5' }),
        h('path', { d: 'M16.5 15.5h.01' }),
      )
    }

    /**
     * Turn an "ask" message from the board page into a real Harness
     * conversation. One session per (board, item) — or per board for the
     * "whole ledger" ask — is reused across asks; only a missing/deleted
     * session creates a new one. The board page already supplies a short
     * context block (board dir + item + the action), so nothing is wrapped.
     */
    // 把回答投回看板页面。
    //
    // 看板跑在面板的 iframe 里，插件跑在 Harness 主窗口；两者同源（看板经
    // /ops-board/b/<id>/ 代理），所以 postMessage 能直接到。
    //
    // 为什么要遍历所有 iframe 而不是只发一个：这里拿不到「哪个 iframe 发了这个问题」。
    // ask 是从看板 POST 到 Host、再经 SSE 回到插件，链路里没有窗口引用。
    // 每个 iframe 自己按 askId 过滤，不匹配的直接忽略，所以广播是安全的。
    function postToBoard(payload) {
      try {
        const frames = document.querySelectorAll('iframe')
        for (const frame of frames) {
          try {
            if (frame.contentWindow) frame.contentWindow.postMessage(payload, window.location.origin)
          } catch {}
        }
      } catch {}
    }

    /**
     * 把回答/回包也投给「独立对话窗」。
     *
     * 独立窗是系统浏览器里的一个窗口（源是 http://127.0.0.1:<端口>），插件跑在
     * dsh-app://app，两者不同源，postMessage 和 BroadcastChannel 都过不去 ——
     * 上面那个 postToBoard 只够得着 iframe 里的看板，够不着它。
     *
     * 所以借看板自己的 HTTP 服务过一次河：那条服务允许跨源、还带 CORS，
     * 并且和 Harness 宿主插件无关（能单独重启）。这里用相对路径 /ops-board/b/<id>/，
     * 与 Harness 页面同源，连 CORS 都不用走。
     *
     * 失败不抛：独立窗没开着是最正常的情况，postToBoard 那条路照旧。
     */
    function relayToBoard(boardKey, payload) {
      const id = String(boardKey || '').replace(/[^A-Za-z0-9._-]/g, '')
      if (!id) return
      // 回答进 answer 频道，其余（历史 / 会话列表）进 reply 频道 ——
      // 两者在服务端汇到同一个队列，独立窗只订阅一条流。
      const path = payload && payload.type === 'ops-board/answer' ? 'answer' : 'reply'
      try {
        fetch(`/ops-board/b/${id}/api/relay/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {}
    }

    /** postToBoard 的补充：两条回程路都走，谁在就谁收到。 */
    function replyToBoard(payload) {
      postToBoard(payload)
      relayToBoard(payload && payload.board, payload)
    }

    /**
     * Lightweight in-page broadcasting for the "onboarding" (first-pass
     * ledger generation) phase. askInHarness and the board panel live in the
     * same module instance, so the panel can observe generation progress
     * through these listeners — no host/SSE round-trip needed.
     *
     * Events look like { type, board, phase, mode?, error? } where phase is
     * 'starting' | 'done' | 'error'. The panel renders a status bar off them.
     */
    const onboardListeners = new Set()
    function notifyOnboard(event) {
      for (const listener of onboardListeners) {
        try {
          listener(event)
        } catch {}
      }
    }

    // 从 session 的事件窗口里取出「这一轮」的回答正文。
    //
    // 为什么不用 session.prompt 的返回值：它只回「已受理」（{ok:true}），
    // 不含任何正文。真正的回答是 Host 后续推过来的 assistant/message 事件，
    // 落在 session.eventSource 的窗口里，只能从那里读。
    //
    // eventSource 是 MutableSessionEventSource，getSnapshot() 返回
    // { entries, hasMore, revision, change }；每个 entry 形如
    //   { event: { type: 'assistant/message', seq, data: { message: { content: [...] } } } }
    // content 里既有 reasoning（思考）也有 text（给人看的正文），这里只取 text。
    function answerTextFromEntries(entries, afterSeq) {
      const parts = []
      for (const entry of entries || []) {
        const event = entry && entry.event
        if (!event || event.type !== 'assistant/message') continue
        if (afterSeq !== undefined && Number(event.seq) <= afterSeq) continue
        const content = event.data && event.data.message && event.data.message.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          // 只收 text：reasoning 是模型的思考过程，不该原样倒给用户。
          if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            parts.push(block.text.trim())
          }
        }
      }
      return parts.join('\n\n').trim()
    }

    // 把一段会话历史抽成「谁能看的消息」列表，给看板回显用。
    // 事件里 user 是 `user/message`（data.content 是 block 数组或普通字符串），
    // assistant 是 `assistant/message`（data.message.content 是 block 数组，只取 text）。
    // 这里刻意只抽 text：reasoning / 工具过程不在历史里，避免把「思考」原样倒给看板。
    // 按事件 seq 顺序抛出，让历史读起来像一场连续的对话。
    function historyFromEntries(entries) {
      const rows = []
      for (const entry of entries || []) {
        const event = entry && entry.event
        if (!event) continue
        const data = event.data || {}
        if (event.type === 'assistant/message') {
          const content = (data.message && data.message.content) || []
          if (!Array.isArray(content)) continue
          const parts = []
          for (const block of content) {
            if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              parts.push(block.text.trim())
            }
          }
          const text = parts.join('\n\n').trim()
          if (text) rows.push({ role: 'assistant', seq: event.seq, text })
        } else if (event.type === 'user/message') {
          // 只收「人真正打的字」。
          //
          // 同一个 user/message 类型下混着好几类宿主注入：time-context（时间戳 /
          // 时区提示）、system-reminder（skill 清单、工作区记忆），它们的 role 也是
          // user，光看 role 会一并当成人的话倒进面板 —— 于是对话窗口里最上面永远是
          // 一段 "Time sampled while preparing turn 1, step 1: ..."，真正问的那句
          // 被挤到下面。
          //
          // 判据在 source.kind：人打的固定是 'user'（还带 rpcId），注入的不是。
          // 老数据没有 source 时按「有 source 才判、没有就收」处理，别把历史整段清空。
          const source = data.source
          if (source && typeof source === 'object' && source.kind && source.kind !== 'user') continue
          const content = data.content
          const text = Array.isArray(content)
            ? content
                .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
                .join('\n\n')
                .trim()
            : typeof content === 'string'
              ? content.trim()
              : ''
          if (text) rows.push({ role: 'user', seq: event.seq, text })
        }
      }
      // 只留相邻的 user/assistant 正文；历史若很长，保留对看板最有用的最近一部分。
      // 上限取最后 20 条，避免一次回一堆。
      return rows.slice(-20).map(({ role, text }) => ({ role, text }))
    }

    // 从事件窗口里取出「这一轮做过什么」：工具调用 + 结果。
    //
    // 看板面板以前只显示最终那段文字，中间读了哪些文件、跑了什么命令、
    // 改了哪里，全都在 Harness 会话里，面板看不见 —— 所以面板像个假窗口。
    // 这里把过程也捞出来，按 seq 顺序还给看板。
    //
    // 事件形状（对着 dsh-better-sidebar 的实现核过）：
    //   tool/call   → data.callId / data.name / data.arguments(JSON 字符串)
    //   tool/result → 用 data.callId、data.message.source.callId、data.toolCallId 里第一个有值的配对
    function stepsFromEntries(entries, afterSeq) {
      const steps = []
      const pending = new Map()
      const seen = new Set()
      const callIdOf = (data) => {
        const message = data && data.message
        for (const candidate of [data && data.callId, message && message.source && message.source.callId, message && message.toolCallId, data && data.toolCallId]) {
          if (typeof candidate === 'string' && candidate !== '') return candidate
        }
        return undefined
      }
      for (const entry of entries || []) {
        const event = entry && entry.event
        if (!event || !event.type) continue
        if (afterSeq !== undefined && Number(event.seq) <= afterSeq) continue
        const data = event.data || {}
        if (event.type === 'tool/call') {
          const callId = callIdOf(data) || `anon-${event.seq}`
          if (seen.has(callId)) continue
          seen.add(callId)
          const step = {
            kind: 'tool',
            callId,
            name: typeof data.name === 'string' ? data.name : 'tool',
            args: typeof data.arguments === 'string' ? data.arguments : '',
            seq: Number(event.seq) || 0,
            settled: false,
          }
          pending.set(callId, step)
          steps.push(step)
          continue
        }
        if (event.type === 'tool/result') {
          const callId = callIdOf(data)
          const step = callId ? pending.get(callId) : undefined
          if (step) {
            step.settled = true
            const failed = data && (data.isError === true || data.error !== undefined)
            step.failed = !!failed
            pending.delete(callId)
          }
          continue
        }
      }
      return steps
    }

    // 等这一轮回答落地：轮询事件窗口，直到出现「seq > afterSeq 的 assistant/message」，
    // 且会话不再 running（或超时）。
    //
    // 为什么轮询而不是订阅：eventSource.subscribe 只是「窗口变了」的失效通知，
    // 不告诉你变了什么；而这里要的是「这一轮说完了没」。用轮询读窗口最省事，
    // 也不需要把 React 的订阅机制搬进插件。
    //
    // 返回 { text, steps }：文字是给人看的正文，steps 是这一轮的工具调用轨迹。
    async function waitAnswer(session, afterSeq, { timeoutMs = 180000, intervalMs = 400 } = {}) {
      const started = Date.now()
      let last = ''
      let stableSince = 0
      // 见过 running 才算「真的跑起来了」。
      // 不这样的话，提问刚发出、Host 还没把 running 置位的那几百毫秒里，
      // 会被误判成「已经跑完且没正文」，直接返回空字符串。
      let sawRunning = false
      const collect = (entries) => ({
        text: answerTextFromEntries(entries, afterSeq),
        steps: stepsFromEntries(entries, afterSeq),
      })
      while (Date.now() - started < timeoutMs) {
        const source = session.eventSource
        const snap = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null
        const got = snap ? collect(snap.entries) : { text: '', steps: [] }
        const text = got.text
        const snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null
        const running = !!(snapshot && snapshot.running)
        if (running) sawRunning = true
        if (text) {
          if (text !== last) {
            last = text
            stableSince = Date.now()
          } else if (!running && Date.now() - stableSince >= 800) {
            // 正文稳定且已不在运行：这一轮结束了。
            return { text, steps: got.steps }
          }
        } else if (sawRunning && !running && Date.now() - started > 3000) {
          // 确实跑起来过、现在也停了，却一个字都没有：这轮没有正文，
          // 但可能只有工具调用（纯执行、不解释），过程仍要还回去。
          return { text: '', steps: got.steps }
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
      const source = session.eventSource
      const snap = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null
      const tail = snap ? collect(snap.entries) : { text: '', steps: [] }
      return { text: tail.text || last, steps: tail.steps }
    }

    async function askInHarness(ctx, payload) {
      const ui = ctx.get('uiWorkspace')
      if (!ui || !ui.workspaces) throw new Error('uiWorkspace 服务不可用')
      const question = String(payload.question || '').trim()
      if (!question) throw new Error('问题是空的')
      // 一律在看板里回答，不再按关键词把人弹去会话窗。
      //
      // 以前这里读 payload.inline，而看板那边用 shouldInline() 猜：命中「动手 / 更新 /
      // 解决一下」这类词就判定为「要动手，得让他看着」，于是调 ui.openSession() 把界面
      // 切到 Harness —— 结果点一下就跳走，面板里的对话当场断掉，形同虚设。
      //
      // 现在统一 inline：回答和过程都回看板面板。想看完整会话时，面板底部有链接。
      const inline = true
      const askId = String(payload.askId || '')
      const dir = String(payload.dir || '').trim()
      const label = String(payload.label || payload.board || '项目看板')
      const normalize = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()
      const items = (ui.workspaces.list && ui.workspaces.list.getSnapshot && ui.workspaces.list.getSnapshot().items) || []
      const match = items.find((item) => normalize(item.path) === normalize(dir))
      let workspaceId = match && match.workspaceId
      if (!workspaceId && dir) {
        const created = await ui.workspaces.create({ path: dir })
        workspaceId = created && created.workspaceId
      }
      if (!workspaceId) throw new Error('找不到看板目录对应的工作区')

      const boardKey = String(payload.board || payload.label || 'board')
      const itemKey = String(payload.item || '__global__')
      // 哪个窗口问的（看板整页 / 独立对话窗）。回答是广播给所有 iframe 的，
      // 必须原样带回去让它们各收各的 —— 否则同一轮问答会在两个窗口里
      // 各留一份（没认出发问 id 的那个窗口会补一条「迟到」气泡）。
      const surface = String(payload.surface || 'page')
      // 首次接入的「生成第一版台账」：Host 在 /boards/create 时以 item=__onboard__ 发布。
      // 前端面板靠它显示「正在生成中」状态条。
      const isOnboarding = itemKey === '__onboard__'
      if (isOnboarding) notifyOnboard({ type: 'onboard', board: boardKey, phase: 'starting' })
      const forceNew = payload.fresh === true
      const stamp = () =>
        new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      const time = forceNew ? stamp() : ''
      const generatedTitle = (
        payload.item
          ? forceNew
            ? `${payload.item} · ${time} · ${payload.title || '看板条目'}`
            : `${payload.item} · ${payload.title || '看板条目'}`
          : forceNew
            ? `${label} · ${time} · 整本台账`
            : `${label} · 整本台账`
      ).slice(0, 80)
      const sessionTitle = String(payload.sessionTitle || generatedTitle).slice(0, 80)

      const sessions = ctx.get('sessions')
      if (sessions && typeof sessions.create === 'function' && ui.openSession) {
        let map = {}
        try {
          const response = await fetch('/ops-board/sessions', { cache: 'no-store' })
          map = await response.json()
        } catch {
          map = {}
        }
        // 映射表现在存的是 {id, title, history} 对象（老数据可能是裸字符串 id），
        // 直接用会把整个对象当 sessionId 传下去，所以这里统一取 id。
        const rec = map && map[boardKey] && map[boardKey][itemKey]
        const mappedId = rec && typeof rec === 'object' ? String(rec.id || '') : String(rec || '')
        let sessionId = forceNew ? null : mappedId || null
        // 看板面板上明确选了某条对话时，以它为准（优先级高于映射表）：
        // 映射表只记「上次用的那个」，而用户可能想接进另一条。
        //
        // ⚠️ 这里不能再拿 sessions.list 去校验存在性并把它清成 null ——
        // 快照只覆盖已载入/已投影的会话，用户选的那条完全可能不在里面（例如刚重启、
        // 或是别的窗口建的）。一旦清掉就会掉进下面「新建会话」分支，
        // 表现正是「下拉选了对话，发出去却进了新会话」。
        // 真的接不进去时让 retain/ready 抛错、把话说明白，也比静默新建强。
        const picked = String(payload.reuseSessionId || '')
        if (picked) sessionId = picked
        // 映射表里那条只在「没点名」时才有意义；它可能是过期 id，校验不通过就当作没有。
        const list = sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot()
        if (!picked && sessionId && list && list.byId && !list.byId[sessionId]) sessionId = null

        let createdNew = false
        if (!sessionId) {
          sessionId = await sessions.create({ workspaceId })
          createdNew = true
          try {
            await fetch('/ops-board/sessions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board: boardKey, key: itemKey, sessionId, title: sessionTitle }),
            })
          } catch {}
        } else {
          // 复用了某条旧对话：也要回写一次映射。
          // 一来把「最近用的那条」更新成它，二来让宿主的 history 列表认识它 ——
          // 否则「选择对话」下拉里永远只有新建过的那些，接进来的旧对话反而找不到。
          try {
            await fetch('/ops-board/sessions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board: boardKey, key: itemKey, sessionId, title: '' }),
            })
          } catch {}
        }

        // 不再分叉：一律走 retain()，不调 ui.openSession。
        //
        // ui.openSession 就是把人从看板弹去会话窗的那个动作，也是以前「点一下
        // 就跳走」的根源。这里彻底不碰它；想看完整会话由面板底部的按钮自己发
        // open-session 消息，用户点才跳。
        //
        // 但注意：binding() 只借「已建立的 scope」，不会替你建。所以这里必须用
        // sessions.retain()：它建 scope、并顺手 open 事件窗口，这正是读回答需要的
        // 东西。用完 release，别让这个临时引用一直挂着。
        if (typeof sessions.retain !== 'function') throw new Error('会话 API 不支持 retain')
        const reference = sessions.retain(sessionId, { source: 'ops-board-inline' })
        if (!reference) throw new Error('无法保留会话引用')
        let session = null
        {
          // ready 在窗口打开后 resolve；它给的是 binding（{sessionId, session, eventSource}），
          // 不是 session 本身。失败了就让它抛，别吞成「没回答」。
          const binding = await reference.ready
          session = binding && binding.session
        }
        try {
          if (session && typeof session.prompt === 'function') {
            if (createdNew && typeof session.rename === 'function') {
              try {
                await session.rename(sessionTitle)
              } catch {}
            }
            // inline 要读回答，就必须让会话把事件窗口打开；open() 幂等。
            if (inline && typeof session.open === 'function') {
              try {
                await session.open()
              } catch {}
            }
            // 记下提问前的最后一个 seq，之后只看它后面的回答。
            let beforeSeq
            let history = []
            if (inline) {
              const source = session.eventSource
              const snap = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null
              const entries = (snap && snap.entries) || []
              // 复用旧会话时，把已经聊过的内容带回看板，让对话窗口不空着。
              // 新会话（createdNew）还没有历史，跳过。
              if (!createdNew && entries.length) history = historyFromEntries(entries)
              const last = entries[entries.length - 1]
              beforeSeq = last && last.event ? Number(last.event.seq) : undefined
            }
            // 把会话标题回写映射，让「继续上次会话」下拉能显示标题而不是短 id。
            // 新建时上面 POST 已带标题；复用时要读实时的 title 再刷新一次。
            if (!createdNew) {
              try {
                const snap = sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot()
                const record = snap && snap.byId && snap.byId[sessionId]
                const realTitle =
                  (record && (typeof record.displayTitle === 'string' ? record.displayTitle : record.title)) || ''
                if (realTitle) {
                  await fetch('/ops-board/sessions', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ board: boardKey, key: itemKey, sessionId, title: realTitle }),
                  })
                }
              } catch {}
            }
            // Wire mode is 'queue' | 'steer'; the Host maps queue to a followup
            // turn. 'followup' is NOT a wire value and fails typert validation.
            const result = await session.prompt([{ type: 'text', text: question }], 'queue')
            if (result && result.ok === false) {
              throw new Error((result.error && result.error.message) || '发送问题失败')
            }
            if (inline) {
              try {
                const answer = await waitAnswer(session, beforeSeq)
                if (isOnboarding) notifyOnboard({ type: 'onboard', board: boardKey, phase: 'done' })
                replyToBoard({
                  type: 'ops-board/answer',
                  askId,
                  board: boardKey,
                  item: itemKey,
                  surface,
                  text: answer.text,
                  steps: answer.steps,
                  history,
                  sessionId,
                })
              } catch (error) {
                // 等回答时出错也要回话，否则看板那边会一直停在「正在回答…」。
                if (isOnboarding) {
                  notifyOnboard({
                    type: 'onboard',
                    board: boardKey,
                    phase: 'error',
                    error: (error && error.message) || String(error),
                  })
                }
                replyToBoard({
                  type: 'ops-board/answer',
                  askId,
                  board: boardKey,
                  item: itemKey,
                  surface,
                  text: '',
                  error: (error && error.message) || String(error),
                  history,
                  sessionId,
                })
              }
            }
            return
          }
        } finally {
          // inline 的引用只活到这一轮结束；release 会 retire scope，
          // 会话本身和它的历史不受影响（Host 那边照旧留着）。
          if (reference) {
            try {
              reference.release()
            } catch {}
          }
        }
      }

      // Fallback: open a session with the question pre-filled.
      ui.startSession(workspaceId, { prompt: question, clearPreviousDraft: true })
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ops-board: dictionaries')

      const pickDirectory = async () => {
        const ui = ctx.get('uiWorkspace')
        if (!ui || typeof ui.pickDirectory !== 'function') throw new Error('目录选择器不可用')
        return await ui.pickDirectory()
      }

      ctx.effect(() => {
        if (typeof EventSource === 'undefined') return () => {}
        let source = null
        let timer = null
        let disposed = false
        const connect = () => {
          if (disposed) return
          source = new EventSource('/ops-board/events')
          source.onmessage = (event) => {
            let data
            try {
              data = JSON.parse(event.data)
            } catch {
              return
            }
            if (!data || data.type !== 'ask') return
            askInHarness(ctx, data).catch((error) => {
              console.warn('dsh-ops-board: ask failed', error)
            })
          }
          // A plugin reload makes /ops-board/events briefly 404; EventSource
          // treats that as fatal and stops retrying, so reconnect ourselves.
          source.onerror = () => {
            try {
              source.close()
            } catch {}
            source = null
            if (disposed) return
            clearTimeout(timer)
            timer = setTimeout(connect, 3000)
          }
        }
        connect()
        return () => {
          disposed = true
          clearTimeout(timer)
          try {
            if (source) source.close()
          } catch {}
        }
      }, 'dsh-ops-board: ask bridge')

      // Belt and braces for the case where SSE is unavailable (or an older
      // board page still hands off with postMessage).
      ctx.effect(() => {
        const onMessage = (event) => {
          if (event.origin !== window.location.origin) return
          const data = event.data
          if (!data || data.type !== 'ops-board/ask') return
          askInHarness(ctx, data).catch((error) => {
            console.warn('dsh-ops-board: ask failed', error)
          })
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, 'dsh-ops-board: ask postMessage fallback')

      // 看板面板底部那个「去 Harness 看完整会话」按钮。
      //
      // 面板现在把回答和过程都留在自己里面，不再自动跳走；只有用户主动点这个
      // 才切到 Harness 会话窗口 —— 想看思考过程、原始工具输出的时候用。
      // 处理逻辑在下面的 handleOpenSession（两个入口共用）。

      // 看板打开面板时，主动找 Harness 要这个作用域对应会话的既有对话。
      //
      // 为什么不靠看板自己存：Harness 会话才是真正发生过的事，看板里的
      // localStorage 只是"上一次在本机看到的样子"。两边都存、以会话为准，
      // 才能做到「跳去看完整会话再回来，记录还在」且不出现两套说法。
      //
      // 看板发 {type:'ops-board/history', board, key} 过来，这里按映射表找到
      // 会话 id，把它的 user/assistant 正文读出来回给看板。
      // ── 看板发来的「请求」────────────────────────────────────────────
      //
      // 这些请求原来是纯 postMessage 的：看板在面板的 iframe 里，插件是父窗口，
      // 同源直达。独立对话窗跑在系统浏览器里（源是 http://127.0.0.1:<端口>），
      // 和外壳 dsh-app://app 不同源，postMessage 永远到不了 ——
      // 所以同一套处理逻辑必须还能被 HTTP 中转（/api/relay/reqs）驱动。
      //
      // 抽成具名函数是为了「只有一份行为」：下面每个 ctx.effect 只负责挂监听，
      // 真正的处理逻辑在这里。
      const handleHistory = (data) => {
          if (!data || data.type !== 'ops-board/history') return
          const boardKey = String(data.board || '')
          const itemKey = String(data.key || '')
          const reqId = String(data.reqId || '')
          if (!boardKey) return

          const reply = (payload) => {
            // 必须走 postToBoard（广播给所有看板 iframe），不能用 window.postMessage ——
            // 后者只投给 Harness 主窗口自己，跑在 iframe 里的看板永远收不到。
            // 这和回答（answer）用的是同一条回程路。
            // replyToBoard 另外补一条 HTTP 中转：独立窗不在 iframe 里，够不着 postMessage。
            replyToBoard({ type: 'ops-board/history', reqId, board: boardKey, ...payload })
          }


          ;(async () => {
            const sessions = ctx.get('sessions')
            if (!sessions) return reply({ ok: false, error: 'no sessions service' })
            // 映射表里没有这个作用域的会话，说明还没聊过 —— 这是正常情况。
            let sid = ''
            // 看板明确点名要哪一条对话时以它为准（「选择对话」下拉里选的那个）。
            // 映射表只记「最近用的那个」，不带上这个就永远只能看到最近一次。
            const wanted = String(data.sessionId || '')
            if (wanted) sid = wanted
            else
              try {
                const response = await fetch('/ops-board/sessions', { cache: 'no-store' })
                const map = await response.json()
                const rec = map && map[boardKey] && map[boardKey][itemKey]
                // 新记录是 {id, title}，老记录是裸字符串；两种都认。
                sid = rec && typeof rec === 'object' ? String(rec.id || '') : String(rec || '')
              } catch {}
            if (!sid) return reply({ ok: true, sessionId: '', messages: [] })
            if (typeof sessions.retain !== 'function') return reply({ ok: false, error: 'no retain' })

            let reference = null
            try {
              reference = sessions.retain(sid, { source: 'ops-board-history' })
              if (!reference) return reply({ ok: true, sessionId: sid, messages: [] })
              const binding = await reference.ready
              const session = binding && binding.session
              if (!session) return reply({ ok: true, sessionId: sid, messages: [] })
              // 事件窗口不打开就读不到任何条目；open() 幂等，开着也没事。
              if (typeof session.open === 'function') {
                try {
                  await session.open()
                } catch {}
              }
              // ⚠️ 不能 open() 完立刻读一次就交差：窗口刚挂上时事件还没灌进来，
              // getSnapshot() 会返回空数组，看板那边就表现为「看不到之前的对话」。
              // 回答链路同样是轮询等窗口就绪的（见 waitForAnswer），这里照它的做法办。
              let entries = []
              const deadline = Date.now() + 2500
              while (Date.now() < deadline) {
                const src = session.eventSource
                const s = src && typeof src.getSnapshot === 'function' ? src.getSnapshot() : null
                const list = (s && s.entries) || []
                if (list.length) {
                  entries = list
                  break
                }
                await new Promise((resolve) => setTimeout(resolve, 120))
              }
              // 拿到最新一次快照（可能为空，那就是真的没聊过）
              if (!entries.length) {
                const src = session.eventSource
                const s = src && typeof src.getSnapshot === 'function' ? src.getSnapshot() : null
                entries = (s && s.entries) || []
              }
              const messages = historyFromEntries(entries)
              console.log(
                `dsh-ops-board: history for ${boardKey}/${itemKey} → sid=${sid} entries=${entries.length} messages=${messages.length}`,
              )
              reply({ ok: true, sessionId: sid, messages, entries: entries.length })
            } catch (error) {
              reply({ ok: false, error: String((error && error.message) || error) })
            } finally {
              // 临时引用用完就放，别把会话长期挂在这个桥上。
              try {
                if (reference && typeof reference.release === 'function') reference.release()
              } catch {}
            }
          })()
      }

      // 看板「选择对话」下拉要的候选列表。
      //
      // 为什么不用 /ops-board/sessions：那是 host 维护的映射表，只能记「这个作用域用过哪一条」，
      // 一个作用域通常只有一条，下拉看起来像选择，其实没得选。
      // Harness 自己的会话目录才是完整清单 —— 它就摆在 sessions.list 的快照里（带 cwd 和标题），
      // 按看板目录过滤一下，就是这个看板能接进去的所有对话。
      const handleListSessions = (data) => {
          if (!data || data.type !== 'ops-board/list-sessions') return
          const reqId = String(data.reqId || '')
          const boardKey = String(data.board || '')
          const dir = String(data.dir || '')
          const reply = (payload) => {
            replyToBoard({ type: 'ops-board/sessions-list', reqId, board: boardKey, ...payload })
          }
          try {
            const sessions = ctx.get('sessions')
            const snap =
              sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
                ? sessions.list.getSnapshot()
                : null
            const byId = (snap && snap.byId) || {}
            // 目录比对要宽松：大小写、末尾分隔符、正反斜杠都可能不一致。
            const norm = (v) => String(v || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
            const want = norm(dir)
            const items = []
            for (const rec of Object.values(byId)) {
              if (!rec || !rec.id) continue
              // 只收这个看板目录下的会话；没有 cwd 的记录（子 agent 之类）不掺进来。
              if (want && norm(rec.cwd) !== want) continue
              if (!rec.cwd) continue
              items.push({
                id: rec.id,
                title: String(rec.displayTitle || rec.title || rec.id),
                at: Number(rec.updatedAt) || 0,
                running: !!rec.running,
                blank: !!rec.blank,
              })
            }
            // 最近的排前面，下拉第一项就是「上次那条」。
            items.sort((a, b) => b.at - a.at)
            reply({ ok: true, items: items.slice(0, 40) })
          } catch (error) {
            reply({ ok: false, error: String((error && error.message) || error), items: [] })
          }
      }

      // 看板底部那个「去 Harness 看完整会话」。
      const handleOpenSession = (data) => {
          if (!data || data.type !== 'ops-board/open-session') return
          const sessionId = String(data.sessionId || '')
          if (!sessionId) return
          try {
            const ui = ctx.get('uiWorkspace')
            if (ui && typeof ui.openSession === 'function') ui.openSession(sessionId)
          } catch (error) {
            console.warn('dsh-ops-board: open session failed', error)
          }
      }

      // 三个处理器统一登记，postMessage 和 HTTP 中转两条入口都走这里。
      const BOARD_REQUESTS = {
        'ops-board/history': handleHistory,
        'ops-board/list-sessions': handleListSessions,
        'ops-board/open-session': handleOpenSession,
      }
      const handleBoardRequest = (data) => {
        const handler = data && BOARD_REQUESTS[data.type]
        if (handler) handler(data)
      }

      // 入口一：同源的 iframe（看板面板里的那一份页面）。
      ctx.effect(() => {
        const onMessage = (event) => {
          if (event.origin !== window.location.origin) return
          handleBoardRequest(event.data)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, 'dsh-ops-board: board request bridge')

      // 入口二：HTTP 中转。独立对话窗（系统浏览器窗口，源是 127.0.0.1:<端口>）
      // 够不着 postMessage，把请求 POST 到看板服务上，服务转成 SSE 推过来。
      //
      // 是「每块活着的板各开一条」而不是只订一块：中转坐在看板自己的服务进程里，
      // 每块板一个进程、一个端口。只订一块的话，别的板弹出去的窗口提的请求
      // 会静默丢掉 —— 表现是「历史/选择对话在那块板上永远转圈」。
      //
      // 订阅列表按 /ops-board/state 反复对齐：板可能比 Harness 后起来
      // （服务没跑就没有中转），也可能被删掉，所以不能只做一次。
      ctx.effect(() => {
        if (typeof EventSource === 'undefined') return () => {}
        const sources = new Map()
        let timer = null
        let disposed = false

        const closeOne = (id) => {
          const source = sources.get(id)
          if (!source) return
          sources.delete(id)
          try {
            source.close()
          } catch {}
        }

        const sync = async () => {
          if (disposed) return
          let boards = []
          try {
            const response = await fetch(STATE_URL, { cache: 'no-store' })
            const body = await response.json()
            const normalized = normalizeState(body)
            boards = (normalized && normalized.boards) || []
          } catch {}
          if (disposed) return
          // 只订活着的（ready 且真的起过服务）；starting 的下一轮再来看。
          const wanted = new Set()
          for (const board of boards) {
            if (!board || !board.id || !board.ready) continue
            if (!Number(board.port)) continue
            const id = String(board.id).replace(/[^A-Za-z0-9._-]/g, '')
            if (!id) continue
            wanted.add(id)
            if (sources.has(id)) continue
            const source = new EventSource(`/ops-board/b/${id}/api/relay/reqs`)
            sources.set(id, source)
            source.onmessage = (event) => {
              let data
              try {
                data = JSON.parse(event.data)
              } catch {
                return
              }
              handleBoardRequest(data)
            }
            source.onerror = () => {
              // 板重启了 / 端口换了：摘掉，下一轮 sync 用新端口重开。
              // 不在这里自己重试，避免和 sync 抢着开两条。
              closeOne(id)
            }
          }
          for (const id of [...sources.keys()]) if (!wanted.has(id)) closeOne(id)
          clearTimeout(timer)
          timer = setTimeout(sync, 8000)
        }

        sync()
        return () => {
          disposed = true
          clearTimeout(timer)
          for (const id of [...sources.keys()]) closeOne(id)
        }
      }, 'dsh-ops-board: board request relay')

      // ── 独立对话窗：开 / 关 ─────────────────────────────────────────
      //
      // 看板里的「弹窗」按钮发 {type:'ops-board/chat-open'} 过来，这里在
      // document.body 上开一个 React 根，画一个脱离看板 iframe 矩形的窗口。
      //
      // 窗口里的内容还是同一份看板页面，只是带 ?chat=1：那份页面把自己裁成
      // 只剩对话框（见模板 css.mjs 末尾的 html[data-chat="1"] 规则）。
      // 复用同一份代码而不是重写一个聊天 UI，是因为问答、会话选择、历史回显、
      // 过程清单那一整套都跟页面 DOM 深度耦合，重写一遍等于维护两套行为。
      ctx.effect(() => {
        let root = null
        let host = null

        const close = () => {
          const dying = root
          root = null
          try {
            if (dying) dying.unmount()
          } catch {}
          if (host && host.parentNode) {
            try {
              host.parentNode.removeChild(host)
            } catch {}
          }
          host = null
        }

        const open = (payload) => {
          close()
          // 窗口里加载哪一份页面：用看板自报的代理路径（它在 iframe 里就是
          // /ops-board/b/<id>/），拼上 ?chat=1 让它把自己裁成只剩对话框。
          // 只认相对路径，避免被塞进一个外站地址。
          let proxy = String((payload && payload.proxy) || '')
          if (!proxy.startsWith('/')) proxy = ''
          if (!proxy) {
            console.warn('dsh-ops-board: chat-open 缺 proxy，忽略')
            return
          }
          const boardId = String((payload && payload.board) || '')
          host = document.createElement('div')
          host.dataset.plugin = 'dsh-ops-board'
          host.dataset.chatwin = 'host'
          document.body.appendChild(host)
          root = mountChatWindow(host, {
            proxy,
            scope: String((payload && payload.scope) || ''),
            title: t('title') + (boardId ? ' · ' + boardId : ''),
            onClose: close,
            t,
          })
        }

        const onMessage = (event) => {
          if (event.origin !== window.location.origin) return
          const data = event.data
          if (!data) return
          if (data.type === 'ops-board/chat-open') {
            open(data)
            return
          }
          // 窗口里那个 × 是看板页面的关闭按钮，它自己关不掉自己的 iframe，
          // 只能通知这边把整个窗口收起来。
          if (data.type === 'ops-board/chat-close') close()
        }

        window.addEventListener('message', onMessage)
        return () => {
          window.removeEventListener('message', onMessage)
          close()
        }
      }, 'dsh-ops-board: detached chat window')

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t, pickDirectory }),
          },
          OpsBoardPanel,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('panel'),
            locale: NS,
          },
          OpsBoardIcon,
        ),
      )
    }

    return {
      name: 'dsh-ops-board',
      inject: ['slots', 'locale', 'layout', 'sessions'],
      apply,
    }
  },
})
