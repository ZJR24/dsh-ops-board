// 复刻插件里那段「决定接进哪条会话」的取值逻辑，逐条验证。
const B = 'board'
const K = '__global__'

function decide({ forceNew, map, picked, byId }) {
  const rec = map && map[B] && map[B][K]
  const mappedId = rec && typeof rec === 'object' ? String(rec.id || '') : String(rec || '')
  let sessionId = forceNew ? null : mappedId || null
  if (picked) sessionId = picked
  if (!picked && sessionId && byId && !byId[sessionId]) sessionId = null
  return sessionId
}

const cases = [
  ['用户选了会话 → 必须采纳，哪怕快照里没有它',
    { picked: 'sess-picked', map: {}, byId: {} }, 'sess-picked'],
  ['用户选了会话 → 快照里有它',
    { picked: 'sess-picked', map: {}, byId: { 'sess-picked': {} } }, 'sess-picked'],
  ['用户选了会话且映射表另有记录 → 以用户选的为准',
    { picked: 'sess-picked', map: { board: { __global__: { id: 'sess-mapped' } } }, byId: {} }, 'sess-picked'],
  ['没点名时用映射表里那条（对象记录）',
    { picked: '', map: { board: { __global__: { id: 'sess-mapped' } } }, byId: { 'sess-mapped': {} } }, 'sess-mapped'],
  ['没点名时用映射表里那条（老式裸字符串）',
    { picked: '', map: { board: { __global__: 'sess-old' } }, byId: { 'sess-old': {} } }, 'sess-old'],
  ['映射表那条已失效 → 当作没有（会新建）',
    { picked: '', map: { board: { __global__: { id: 'sess-gone' } } }, byId: {} }, null],
  ['新对话（fresh）且没点名 → 新建',
    { forceNew: true, picked: '', map: { board: { __global__: { id: 'sess-mapped' } } }, byId: { 'sess-mapped': {} } }, null],
  ['映射表整条是对象但没有 id → 当作没有',
    { picked: '', map: { board: { __global__: { title: 'x' } } }, byId: {} }, null],
]

let bad = 0
for (const [name, input, want] of cases) {
  const got = decide(input)
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${name} → ${JSON.stringify(got)}${ok ? '' : ' (期望 ' + JSON.stringify(want) + ')'}`)
}
console.log(`\n${bad === 0 ? '全部通过' : bad + ' 项没过'}：${cases.length} 项`)
process.exit(bad === 0 ? 0 : 1)
