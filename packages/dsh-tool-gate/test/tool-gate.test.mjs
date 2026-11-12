import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, syncLifecycle } from '../lib/index.js'

const NOW = 1_700_000_000_000
const session = () => ({ header: { id: `lifecycle-${Math.random()}` }, events: [] })
const append = (s, type, data = {}, seq = s.events.length) => {
  s.events.push({ seq, type, data, time: NOW })
}
const turn = (s, n) => append(s, 'turn/start', { turn: n })
const unlock = (s, action = 'on', group = 'dev') => append(s, 'tool/call', {
  turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: [group], action }),
})
const direct = (s, n = 1) => append(s, 'tool/call', { turn: n, name: 'dev_reload_package', arguments: '{}' })
const request = (s, n, time = NOW) => {
  append(s, 'turn/start', { turn: n })
  append(s, 'request/header', { header: {}, reason: 'initial' }, s.events.length)
  s.events.at(-1).time = time
}
const isOpen = (s, now = NOW) => syncLifecycle(s, DEFAULT_CONFIG, now).state.unlocked.has('dev')

test('once unlock closes automatically on the following turn', () => {
  const s = session(); turn(s, 1); unlock(s, 'once')
  assert.equal(isOpen(s), true)
  turn(s, 2)
  assert.equal(isOpen(s), false)
  assert.equal(syncLifecycle(s, DEFAULT_CONFIG, NOW).state.groupMeta.has('dev'), false)
})

test('unregistered compaction/summary is conservatively a rewrite boundary', () => {
  const s = session(); turn(s, 1); direct(s)
  turn(s, 2); turn(s, 3)
  append(s, 'compaction/summary', { shadowedRange: { start: 0, end: 1 }, shadowedTokenCount: 1 }, 20)
  assert.equal(isOpen(s), false)
})

test('registered append-only compaction/result never becomes a relock boundary', () => {
  const s = session(); turn(s, 1); direct(s)
  request(s, 2); request(s, 3)
  append(s, 'compaction/result', { surfaceOp: 'replace' }, 20)
  assert.equal(isOpen(s), true)
})

test('hot-cache implicit candidate stays open before a safe boundary', () => {
  const s = session(); turn(s, 1); direct(s)
  request(s, 2); request(s, 3)
  assert.equal(isOpen(s), true)
})

test('five-minute idle expires implicit group at the cache boundary', () => {
  const s = session(); turn(s, 1); direct(s)
  request(s, 2); request(s, 3)
  assert.equal(isOpen(s, NOW + DEFAULT_CONFIG.cacheExpiryMs), false)
})

test('explicit unlock uses four idle turns and five-minute expiry', () => {
  const s = session(); turn(s, 1); unlock(s)
  for (let n = 2; n <= 4; n++) request(s, n)
  assert.equal(isOpen(s), true)
  request(s, 5)
  assert.equal(isOpen(s, NOW + DEFAULT_CONFIG.cacheExpiryMs), false)
})

test('twelve idle turns force relock even with a fresh request cache', () => {
  const s = session(); turn(s, 1); direct(s)
  for (let n = 2; n <= 12; n++) request(s, n)
  assert.equal(isOpen(s), true)
  request(s, 13)
  assert.equal(isOpen(s), false)
})

test('using any group tool refreshes its last-used turn', () => {
  const s = session(); turn(s, 1); direct(s)
  for (let n = 2; n <= 6; n++) { request(s, n); direct(s, n) }
  request(s, 7)
  assert.equal(isOpen(s), true)
})

test('replayed compaction does not close a newly unlocked group', () => {
  const s = session(); turn(s, 1); direct(s)
  append(s, 'compaction/summary', { shadowedRange: { start: 0, end: 1 }, shadowedTokenCount: 1 }, 20)
  unlock(s)
  assert.equal(isOpen(s), true)
})
