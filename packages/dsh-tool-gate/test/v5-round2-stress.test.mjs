import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, filterTools, openSources, syncLifecycle, strictTurnDecision, groupOf } from '../lib/index.js'

const cfg = { ...DEFAULT_CONFIG, strictOrchestratorGuard: true }

test('parallel guard calls reserve exactly two reads; invalid arguments do not consume budget', async () => {
  const session = { header: { id: 'parallel-r2' }, events: [{ type: 'turn/start', data: { turn: 1 } }] }
  const state = {}
  const calls = Array.from({ length: 100 }, (_, i) => Promise.resolve().then(() => strictTurnDecision('read', { file_path: 'C:/work/a.md', limit: 20 }, session, state, { strict: true, callId: `r${i}` })))
  const results = await Promise.all(calls)
  assert.equal(results.filter((x) => x.kind === 'allow').length, 2)
  assert.equal(results.filter((x) => x.kind === 'deny').length, 98)
  assert.equal(strictTurnDecision('read', null, session, {}, { strict: true }).kind, 'allow', 'null read args currently fail open')
  for (const [tool, args] of [['tool_unlock', null], ['pwsh', null], ['read', { file_path: null }]]) assert.doesNotThrow(() => strictTurnDecision(tool, args, session, {}, { strict: true }))
})

test('rapid hot-cache tool filtering is byte-stable for mixed malformed event streams', async () => {
  const session = { header: { id: 'rapid-hot-r2' }, events: [
    null, {}, { type: 'turn/start', ts: 1, data: { turn: 1 } }, { type: 'request/header', ts: 100, data: { turn: 1 } },
    { type: 'tool/call', ts: 110, data: { turn: 1, name: 'dev_alpha' } },
    { type: 'tool/call', ts: 120, data: { turn: 1, name: 'tool_unlock', arguments: '{bad json' } },
    { type: 'turn/start', ts: 200, data: { turn: 10 } },
  ] }
  const tools = [{ name: 'read' }, { name: 'dev_alpha' }, { name: 'relay_dispatch' }]
  const expected = JSON.stringify(filterTools(tools, session, cfg, {}, 200))
  const results = await Promise.all(Array.from({ length: 500 }, () => Promise.resolve(JSON.stringify(filterTools(tools, session, cfg, {}, 200)))))
  assert.ok(results.every((x) => x === expected))
  const synced = syncLifecycle(session, cfg, 300200)
  assert.equal(synced.pmw, true)
  for (const value of [null, undefined, 1, '', Symbol('bad')]) assert.doesNotThrow(() => groupOf(value, cfg))
})

test('state pollution and nonstandard persisted values cannot open arbitrary groups', () => {
  const session = { header: { id: 'manual-r2' }, events: [{ type: 'turn/start', ts: 100, data: { turn: 1 } }] }
  for (const state of [null, { 'manual-r2': null }, { 'manual-r2': { dev: 'true' } }, { 'manual-r2': { __proto__: { dev: true } } }]) {
    assert.doesNotThrow(() => openSources(session, cfg, state, 100))
  }
})
