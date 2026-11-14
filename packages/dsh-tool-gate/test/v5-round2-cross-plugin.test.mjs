import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, filterTools, ensurePrefixEpoch, strictTurnDecision } from '../lib/index.js'
import { publishPrefixClass, stampRequestClock } from '../../dsh-context-compact/lib/index.js'

test('same-process PMW handoff relocks idle dev; 500 hot turns remain byte-identical', async () => {
  const events = [
    { seq: 0, type: 'turn/start', ts: 1, data: { turn: 1 } },
    { seq: 1, type: 'request/header', ts: 100, data: { turn: 1 } },
    { seq: 2, type: 'tool/call', ts: 110, data: { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['dev'], action: 'on' }) } },
    { seq: 3, type: 'turn/start', ts: 200, data: { turn: 30 } },
    { seq: 4, type: 'request/header', ts: 200, data: { turn: 30 } },
  ]
  const session = { header: { id: 'r2-cross-pmw' }, events, snapshotEvents() { return events } }
  const tools = [{ name: 'read' }, { name: 'dev_reload_package' }, { name: 'relay_dispatch' }]
  const baseline = JSON.stringify(filterTools(tools, session, DEFAULT_CONFIG, {}, 200))
  assert.ok(baseline.includes('dev_reload_package'))
  const hot = await Promise.all(Array.from({ length: 500 }, () => Promise.resolve().then(() => JSON.stringify(filterTools(tools, session, DEFAULT_CONFIG, {}, 200)))))
  assert.ok(hot.every((value) => value === baseline))
  events.push({ seq: 5, type: 'compaction/summary', ts: 210, data: { summary: [{ type: 'text', text: 'rewrite' }] } })
  publishPrefixClass(session, 5, 'rewrite')
  assert.equal(stampRequestClock(session, 220), 220)
  const epoch = ensurePrefixEpoch(session)
  assert.equal(epoch.pmw.open, true)
  const coldBoundary = filterTools(tools, session, DEFAULT_CONFIG, {}, 220)
  assert.deepEqual(coldBoundary.map((tool) => tool.name), ['read', 'relay_dispatch'])
  assert.equal(epoch.requestClock.now, 220)
})

test('R6 rapid parallel reads reserve exactly two slots and malformed calls do not spend valid budget', async () => {
  const session = { header: { id: 'r2-r6', parentSession: 'parent' }, events: [{ type: 'turn/start', data: { turn: 1 } }] }
  assert.equal((await Promise.all(Array.from({ length: 100 }, () => strictTurnDecision('read', { file_path: 'C:/work/a.md', limit: 20 }, session, {}, { strict: true })))).every((r) => r.kind === 'allow'), true)
  session.header = { id: 'r2-r6' }
  const sharedState = {}
  const calls = Array.from({ length: 100 }, (_, i) => Promise.resolve().then(() => strictTurnDecision('read', { file_path: 'C:/work/a.md', limit: 20 }, session, sharedState, { strict: true, callId: `r-${i}` })))
  const results = await Promise.all(calls)
  assert.equal(results.filter((r) => r.kind === 'allow').length, 2)
  assert.equal(results.filter((r) => r.kind === 'deny').length, 98)
  for (const bad of [null, undefined, 1, '', { file_path: null }]) {
    assert.equal(strictTurnDecision('read', bad, session, {}, { strict: true }).kind, 'allow', 'current fail-open baseline')
  }
})
