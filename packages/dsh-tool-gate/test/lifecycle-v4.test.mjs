import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, syncLifecycle, getAllEvents, filterTools, replayUnlocks } from '../lib/index.js'

const NOW = 1_700_000_000_000
function makeSession(v4 = false) {
  const events = []
  const s = { header: { id: `epoch-${Math.random()}` }, events }
  if (v4) {
    Object.defineProperty(s, 'events', { value: undefined })
    s.eventAt = (seq) => events[seq]
    s.snapshotEvents = () => [...events]
  }
  return { s, events, append(type, data = {}, time = NOW) {
    events.push({ seq: events.length, type, data, time })
    if (v4) s.seq = events.length
  } }
}
function activity(h, turn, time = NOW) { h.append('turn/start', { turn }); h.append('assistant/message', { turn, message: { content: [] } }, time) }
function direct(h, turn = 1) { h.append('tool/call', { turn, name: 'dev_reload_package', arguments: '{}' }) }
function summary(h, kind) {
  const seq = h.events.length
  h.append('compaction/summary', { compactionId: kind })
  const key = Symbol.for('@dsh-external/prefix-epoch')
  const reg = globalThis[key] ??= { v: 1, bySession: new WeakMap() }
  const rec = reg.bySession.get(h.s) ?? { classBySummarySeq: new Map() }
  reg.bySession.set(h.s, rec)
  rec.classBySummarySeq.set(seq, kind)
}
const cfg = { ...DEFAULT_CONFIG, hardIdleTurnsCap: 0 }

test('warm append-only L0 never relocks idle groups', () => {
  const h = makeSession(); direct(h); activity(h, 2); activity(h, 3); summary(h, 'append')
  const out = syncLifecycle(h.s, cfg, NOW)
  assert.equal(out.rewrite, false)
  assert.equal(out.cacheExpired, false)
  assert.deepEqual(out.relocked, [])
  assert.equal(out.state.unlocked.has('dev'), true)
})

test('L1 rewrite relocks, while once remains single-turn regardless of boundary', () => {
  const h = makeSession(); direct(h); activity(h, 2); activity(h, 3); summary(h, 'rewrite')
  assert.deepEqual(syncLifecycle(h.s, cfg, NOW).relocked, ['dev'])
  const once = makeSession(); once.append('tool/call', { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['dev'], action: 'once' }) })
  activity(once, 1)
  assert.equal(syncLifecycle(once.s, cfg, NOW).state.unlocked.has('dev'), true)
  activity(once, 2); summary(once, 'append')
  assert.equal(syncLifecycle(once.s, cfg, NOW).state.unlocked.has('dev'), false)
})

test('assistant activity prevents false cache expiry when request header is unchanged', () => {
  const h = makeSession(); direct(h)
  h.append('request/header', { header: {}, reason: 'initial' }, NOW - 400_000)
  activity(h, 3, NOW - 1_000)
  assert.equal(syncLifecycle(h.s, cfg, NOW).cacheExpired, false)
  assert.deepEqual(syncLifecycle(h.s, cfg, NOW).relocked, [])
})

test('v4 snapshotEvents/eventAt replay lifecycle and filters without session.events', () => {
  const h = makeSession(true); direct(h); activity(h, 3); summary(h, 'append')
  assert.equal(getAllEvents(h.s).length, 4)
  assert.deepEqual(replayUnlocks(h.s, cfg), { dev: true })
  assert.equal(syncLifecycle(h.s, cfg, NOW).state.unlocked.has('dev'), true)
  assert.equal(filterTools([{ name: 'dev_reload_package' }], h.s, cfg, {}, NOW).length, 1)
})

test('v4 tool delta plus append compaction permits REBASE boundary', () => {
  const h = makeSession(true); direct(h); activity(h, 2)
  h.append('developer/message', { content: [{ type: 'text', text: 'tool-addition: dev_new' }] })
  activity(h, 3); summary(h, 'append')
  const out = syncLifecycle(h.s, cfg, NOW)
  assert.equal(out.rebase, true)
  assert.deepEqual(out.relocked, ['dev'])
})

test('hard cap is explicit and zero disables it', () => {
  const h = makeSession(); direct(h)
  for (let turn = 2; turn <= 12; turn++) activity(h, turn)
  assert.equal(syncLifecycle(h.s, cfg, NOW).state.unlocked.has('dev'), true)
  const forced = makeSession(); direct(forced)
  for (let turn = 2; turn <= 13; turn++) activity(forced, turn)
  assert.equal(syncLifecycle(forced.s, { ...cfg, hardIdleTurnsCap: 12 }, NOW).state.unlocked.has('dev'), false)
})
