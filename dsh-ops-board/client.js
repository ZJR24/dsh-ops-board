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
      '.ob-registry{font-size:11px;color:var(--dsw-alias-label-quaternary);margin:12px 0 0;word-break:break-all}'

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
    async function askInHarness(ctx, payload) {
      const ui = ctx.get('uiWorkspace')
      if (!ui || !ui.workspaces) throw new Error('uiWorkspace 服务不可用')
      const question = String(payload.question || '').trim()
      if (!question) throw new Error('问题是空的')
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
        let sessionId = forceNew ? null : map && map[boardKey] && map[boardKey][itemKey]
        const list = sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot()
        if (sessionId && list && list.byId && !list.byId[sessionId]) sessionId = null

        let createdNew = false
        if (!sessionId) {
          sessionId = await sessions.create({ workspaceId })
          createdNew = true
          try {
            await fetch('/ops-board/sessions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board: boardKey, key: itemKey, sessionId }),
            })
          } catch {}
        }

        ui.openSession(sessionId)
        let session = null
        for (let attempt = 0; attempt < 30 && !session; attempt += 1) {
          const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
          session = binding && binding.session
          if (!session) await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (session && typeof session.prompt === 'function') {
          if (createdNew && typeof session.rename === 'function') {
            try {
              await session.rename(sessionTitle)
            } catch {}
          }
          // Wire mode is 'queue' | 'steer'; the Host maps queue to a followup
          // turn. 'followup' is NOT a wire value and fails typert validation.
          const result = await session.prompt([{ type: 'text', text: question }], 'queue')
          if (result && result.ok === false) {
            throw new Error((result.error && result.error.message) || '发送问题失败')
          }
          return
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
