import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, syncLifecycle, filterTools, filterContexts, ensurePrefixEpoch } from '../lib/index.js'
import { strictTurnDecision, isMainOrchestratorSession, DELEGATE_REQUIRED } from '../lib/orchestrator-guard.js'

const NOW = 1_700_000_000_000
const session = (extra = {}) => ({ header: { id: `v5-${Math.random()}`, cwd: 'C:\\work', ...extra }, events: [] })
const append = (s, type, data = {}, extra = {}) => { s.events.push({ seq: s.events.length, type, data, time: NOW, ...extra }) }

test('event replay stamps lastUsedAtMs from ev.ts, not Date.now()', () => {
  const s = session()
  append(s, 'turn/start', { turn: 1 })
  append(s, 'tool/call', { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['connector'], action: 'on' }) }, { ts: 111 })
  const meta = syncLifecycle(s, DEFAULT_CONFIG, NOW).state.groupMeta.get('connector')
  assert.equal(meta.lastUsedAtMs, 111)
})

test('same-length sync keeps rewrite visible and open sets identical', () => {
  const s = session()
  append(s, 'turn/start', { turn: 1 })
  append(s, 'tool/call', { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['connector'], action: 'on' }) })
  append(s, 'turn/start', { turn: 3 })
  append(s, 'assistant/message', { turn: 3 }, { time: NOW })
  append(s, 'compaction/summary', { shadowedTokenCount: 1 })
  const catalog = [{ name: 'mcp_connector_status' }, { name: 'read' }]
  const first = syncLifecycle(s, DEFAULT_CONFIG, NOW)
  const second = syncLifecycle(s, DEFAULT_CONFIG, NOW)
  assert.equal(first.rewrite, true)
  assert.equal(second.rewrite, true)
  const a = JSON.stringify(filterTools(catalog, s, DEFAULT_CONFIG, {}, NOW))
  const b = JSON.stringify(filterContexts([{ text: 'x' }], s, DEFAULT_CONFIG, {}, NOW))
  const c = JSON.stringify(filterTools(catalog, s, DEFAULT_CONFIG, {}, NOW))
  assert.equal(a, c)
  assert.equal(b, JSON.stringify([{ text: 'x' }]))
  const reg = globalThis[Symbol.for('@dsh-external/prefix-epoch')]
  assert.equal(reg.v, 2)
  assert.equal(typeof ensurePrefixEpoch(s).pmw.open, 'boolean')
})

test('one dev bypass call stays hidden; four hits promote at the next PMW', () => {
  const s = session()
  append(s, 'turn/start', { turn: 1 })
  append(s, 'tool/call', { turn: 1, name: 'dev_reload_package', arguments: '{}' })
  append(s, 'assistant/message', { turn: 1 }, { time: NOW })
  assert.equal(syncLifecycle(s, DEFAULT_CONFIG, NOW).state.unlocked.has('dev'), false)
  for (let i = 0; i < 3; i++) append(s, 'tool/call', { turn: 1, name: 'dev_reload_package', arguments: '{}' })
  assert.equal(syncLifecycle(s, DEFAULT_CONFIG, NOW).state.unlocked.has('dev'), false)
  assert.equal(syncLifecycle(s, DEFAULT_CONFIG, NOW + DEFAULT_CONFIG.cacheExpiryMs).state.unlocked.has('dev'), true)
})

test('strict budgets deny the third parallel read and code edits, and leave delegates alone', () => {
  const main = session()
  const state = {}
  assert.equal(isMainOrchestratorSession(main), true)
  assert.equal(strictTurnDecision('read', { limit: 10 }, main, state, { strict: true }).kind, 'allow')
  assert.equal(strictTurnDecision('read', { limit: 10 }, main, state, { strict: true }).kind, 'allow')
  const third = strictTurnDecision('read', { limit: 10 }, main, state, { strict: true })
  assert.equal(third.error.code, DELEGATE_REQUIRED)
  assert.match(third.error.message, /relay_dispatch/)
  assert.ok(third.error.hint.relay_dispatch)
  assert.equal(third.error.hint.subagent.immediate.run_in_background, false)
  assert.equal(third.error.hint.subagent.parallel.run_in_background, true)
  const shadow = strictTurnDecision('read', { limit: 10 }, main, state, { strict: 'shadow' })
  assert.equal(shadow.kind, 'allow')
  assert.equal(shadow.shadow, true)
  assert.equal(shadow.error.hint.subagent.parallel.run_in_background, true)
  const edit = strictTurnDecision('edit', { file_path: 'C:\\work\\lib\\a.js' }, session(), {}, { strict: true })
  assert.equal(edit.error.code, DELEGATE_REQUIRED)
  assert.equal(strictTurnDecision('edit', { file_path: 'C:\\work\\lib\\a.js' }, session({ delegationDepth: 1 }), {}, { strict: true }).kind, 'allow')
  assert.equal(strictTurnDecision('dev_reload_package', {}, session({ cwd: 'C:\\Users\\mikon\\xiaoshuo' }), {}, { strict: true }).kind, 'allow')
  assert.equal(strictTurnDecision('read', {}, session(), {}, { strict: false }).kind, 'allow')
})
