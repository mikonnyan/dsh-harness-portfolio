import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, strictTurnDecision, syncLifecycle, openSources, filterTools, hotCacheForceRelock } from '../lib/index.js'

const cfg = () => ({ ...DEFAULT_CONFIG, hardIdleTurnsCap: 0, strictOrchestratorGuard: true })
const main = () => ({ header: { id: 'audit-main', cwd: 'C:/work' }, events: [{ type: 'turn/start', data: { turn: 1 } }] })
const read = (n = 20) => ['read', { file_path: 'C:/work/a.md', limit: n }]

test('I-G/R6: main third read denied; three parallel reservations admit exactly two', () => {
  const s = main(), state = {}, out = Array.from({ length: 3 }, (_, i) => strictTurnDecision(...read(), s, state, { strict: true, callId: `r${i}` }))
  assert.deepEqual(out.map((x) => x.kind), ['allow', 'allow', 'deny'])
  assert.equal(out[2].error.code, 'DSH_E_DELEGATE_REQUIRED')
})

test('I-G: 201-line first read is rejected without charging the call budget', () => {
  const s = main(), state = {}
  assert.equal(strictTurnDecision(...read(201), s, state, { strict: true }).kind, 'deny')
  assert.equal(state.reads ?? 0, 0)
})

test('I-G: direct code edit and dev tool denied; Markdown allowed', () => {
  const s = main()
  for (const [tool, args] of [['edit', { file_path: 'C:/work/a.ts', old_string: 'a', new_string: 'b' }], ['dev_reload_package', {}]]) {
    assert.equal(strictTurnDecision(tool, args, s, {}, { strict: true }).kind, 'deny')
  }
  assert.equal(strictTurnDecision('write', { file_path: 'C:/work/note.md', content: 'ok' }, s, {}, { strict: true }).kind, 'allow')
})

test('I-G1: delegated and RP sessions have unrestricted deep reads, writes, shell and dev', () => {
  for (const s of [{ header: { id: 'child', delegationDepth: 1 } }, { header: { id: 'rp', rp: true } }]) {
    for (const [tool, args] of [read(500), ['edit', { file_path: 'C:/work/a.ts' }], ['pwsh', { command: 'npm test' }], ['dev_reload_package', {}]]) {
      assert.equal(strictTurnDecision(tool, args, s, {}, { strict: true }).kind, 'allow')
    }
  }
})

test('I-G4: event replay exceptions fail open', () => {
  const s = { header: { id: 'bad' }, snapshotEvents() { throw new Error('replay broke') } }
  assert.equal(strictTurnDecision(...read(), s, {}, { strict: true }).kind, 'allow')
})

test('D1/I-T3: replay retains historical event timestamp, not wall clock', () => {
  const s = { header: { id: 'history' }, events: [
    { type: 'turn/start', ts: 100, data: { turn: 1 } },
    { type: 'tool/call', ts: 123456, data: { turn: 1, name: 'dev_alpha' } },
  ] }
  const r = syncLifecycle(s, cfg(), 999999)
  assert.equal(r.state.groupMeta.get('dev').lastUsedAtMs, 123456)
  assert.equal(r.rewrite, false)
})

test('R3: same-request openSources calls agree after a rewrite summary', () => {
  const s = { header: { id: 'summary' }, events: [
    { type: 'turn/start', ts: 1, data: { turn: 1 } },
    { type: 'compaction/summary', seq: 8, ts: 2, data: {} },
  ] }
  const c = cfg(), before = openSources(s, c, {}, 100)
  const triple = [openSources(s, c, {}, 100), openSources(s, c, {}, 100), openSources(s, c, {}, 100)]
  assert.deepEqual(triple[0], triple[1]); assert.deepEqual(triple[1], triple[2]); assert.deepEqual(before, triple[0])
})

test('I-T1/dev bypass: direct calls preserve tools and wait for PMW before promotion', () => {
  const s = { header: { id: 'hot' }, events: [
    { type: 'turn/start', ts: 100, data: { turn: 1 } },
    { type: 'request/header', ts: 100, data: { turn: 1 } },
  ] }
  const tools = [{ name: 'read' }, { name: 'dev_alpha' }], c = cfg()
  const before = JSON.stringify(filterTools(tools, s, c, {}, 200))
  s.events.push({ type: 'tool/call', ts: 150, data: { turn: 1, name: 'dev_alpha' } })
  const after = JSON.stringify(filterTools(tools, s, c, {}, 200))
  assert.equal(after, before)
  for (let i = 0; i < 3; i++) s.events.push({ type: 'tool/call', ts: 160 + i, data: { turn: 1, name: 'dev_alpha' } })
  assert.equal(JSON.stringify(filterTools(tools, s, c, {}, 200)), before)
  assert.equal(JSON.stringify(filterTools(tools, s, c, {}, 400001)).includes('dev_alpha'), true)
})

test('D6: once expiry is pending at hot cache and relocks only on PMW', () => {
  const s = { header: { id: 'once' }, events: [
    { type: 'turn/start', ts: 100, data: { turn: 1 } },
    { type: 'request/header', ts: 100, data: {} },
    { type: 'tool/call', ts: 110, data: { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['dev'], action: 'once' }) } },
    { type: 'turn/start', ts: 200, data: { turn: 2 } },
  ] }, c = cfg()
  assert.equal(syncLifecycle(s, c, 200).state.unlocked.has('dev'), true)
  assert.equal(syncLifecycle(s, c, 200).state.groupMeta.get('dev').pending, true)
  assert.equal(syncLifecycle(s, c, 300200).state.unlocked.has('dev'), false)
})

test('D2: manual group survives hot idle and relocks at cold PMW', () => {
  const s = { header: { id: 'manual' }, events: [
    { type: 'turn/start', ts: 100, data: { turn: 1 } },
    { type: 'request/header', ts: 100, data: {} },
    { type: 'turn/start', ts: 200, data: { turn: 9 } },
  ] }, c = cfg(), persisted = { manual: { dev: true } }
  assert.equal(openSources(s, c, persisted, 200).dev.on, true)
  assert.equal(openSources(s, c, persisted, 300200).dev.on, false)
})

test('D4: break-even force-relock formula and default no-force', () => {
  assert.equal(hotCacheForceRelock({ hardIdleTurnsCap: 12, groupSchemaTokens: 10000, prefixTokens: 40000, remainingRequests: 36, cacheHitRatio: .1 }), false)
  assert.equal(hotCacheForceRelock({ hardIdleTurnsCap: 12, groupSchemaTokens: 10000, prefixTokens: 40000, remainingRequests: 37, cacheHitRatio: .1 }), true)
  assert.equal(DEFAULT_CONFIG.hardIdleTurnsCap, 0, 'spec §9.6 default hot-cache force relock must be disabled')
})

test('I-G1/isGated: parentSession without delegationDepth preserves delegated lifecycle byte behavior', () => {
  const s = { header: { id: 'child', parentSession: 'main', delegationDepth: 0 }, events: [] }
  const tools = [{ name: 'dev_alpha' }]
  assert.equal(filterTools(tools, s, cfg(), {}, 100), tools)
})
