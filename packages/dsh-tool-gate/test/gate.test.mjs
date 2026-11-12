import test from 'node:test'
import assert from 'node:assert/strict'
import { filterContexts, filterTools, gateDecision, groupOf, DEFAULT_CONFIG as cfg } from '../lib/index.js'

const names = ['bash', 'dev_reload_package', 'dev_mode_set', 'mcp__harness_relay__get_run', 'relay_dispatch', 'mcp_connector_status', 'mcp__chrome-devtools__click', 'tool_unlock']
const tools = names.map((name) => ({ name }))
const sess = (events = [], extra = {}) => ({ header: { id: 's-' + Math.random(), ...extra }, events })
const call = (args) => ({ type: 'tool/call', data: { name: 'tool_unlock', arguments: JSON.stringify(args) } })
const vis = (t) => t.map((x) => x.name)

test('group matching', () => {
  assert.equal(groupOf('dev_x', cfg), 'dev')
  assert.equal(groupOf('mcp__harness_relay__x', cfg), 'relay')
  assert.equal(groupOf('relay_dispatch', cfg), undefined)
  assert.equal(groupOf('tool_unlock', cfg), undefined)
  assert.equal(groupOf('bash', cfg), undefined)
  assert.equal(groupOf('workflow', cfg), 'extras')
  assert.equal(groupOf('read_page', cfg), 'extras')
  assert.equal(cfg.groups.extras.names.length, 16)
})
test('default hidden', () => {
  assert.deepEqual(vis(filterTools(tools, sess(), cfg, {})), ['bash', 'relay_dispatch', 'tool_unlock'])
})
test('unlock makes visible; off hides again', () => {
  const s = sess([call({ groups: ['dev'] })])
  assert.ok(vis(filterTools(tools, s, cfg, {})).includes('dev_mode_set'))
  s.events.push(call({ groups: ['dev'], action: 'off' }))
  assert.ok(!vis(filterTools(tools, s, cfg, {})).includes('dev_mode_set'))
})
test('resume keeps (replay from events, no file state)', () => {
  const s = sess([call({ groups: ['relay', 'connector'] })])
  const v = vis(filterTools(tools, s, cfg, {}))
  assert.ok(v.includes('mcp__harness_relay__get_run') && v.includes('mcp_connector_status') && !v.includes('dev_mode_set'))
})
test('command state overrides', () => {
  const s = sess(); const state = { [s.header.id]: { browser: true } }
  assert.ok(vis(filterTools(tools, s, cfg, state)).includes('mcp__chrome-devtools__click'))
})
test('hidden call denied with hint; unlocked allowed', () => {
  const s = sess()
  const d = gateDecision('dev_mode_set', s, cfg, {})
  assert.equal(d.kind, 'allow'); assert.equal(d.autoUnlock, 'dev')
  assert.equal(gateDecision('bash', s, cfg, {}).kind, 'allow')
  assert.equal(gateDecision('dev_mode_set', sess([call({ groups: ['dev'] })]), cfg, {}).kind, 'allow')
})
test('RP cleared tools stay empty (remove-only)', () => {
  assert.deepEqual(filterTools([], sess([call({ groups: ['dev'] })]), cfg, {}), [])
})
test('subagents not gated by default', () => {
  assert.equal(vis(filterTools(tools, sess([], { delegationDepth: 1 }), cfg, {})).length, names.length)
  assert.equal(gateDecision('dev_x', sess([], { delegationDepth: 1 }), cfg, {}).kind, 'allow')
})

import { isInternalCall } from '../lib/index.js'
test('plugin-internal calls bypass gate', () => {
  assert.equal(isInternalCall({ callId: 'relay-dispatch-1-2', name: 'mcp__harness_relay__start_run' }), true)
  assert.equal(isInternalCall({ callId: 'call_abc', name: 'x' }), false)
  assert.equal(isInternalCall({ callId: 'call_abc', parent: {} }), true)
})

test('replay: hidden-group call unlocks; off then call re-unlocks; RP empty stays empty', () => {
  const c = { type: 'tool/call', data: { name: 'dev_mode_set', arguments: '{}' } }
  const s = sess([c])
  assert.ok(vis(filterTools(tools, s, cfg, {})).includes('dev_mode_set'))
  s.events.push(call({ groups: ['dev'], action: 'off' }))
  assert.ok(!vis(filterTools(tools, s, cfg, {})).includes('dev_mode_set'))
  s.events.push(c)
  assert.ok(vis(filterTools(tools, s, cfg, {})).includes('dev_mode_set'))
  assert.deepEqual(filterTools([], s, cfg, {}), [])
})

import { replayUnlocks, openSources } from '../lib/index.js'
const hv = (s, st = {}) => vis(filterTools(tools, s, cfg, st))
const mk = (name, extra = {}) => ({ type: 'tool/call', data: { name, arguments: '{}', ...extra } })
test('fresh session: all hidden; empty/invalid groups unlock nothing', () => {
  assert.deepEqual(hv(sess()), ['bash', 'relay_dispatch', 'tool_unlock'])
  assert.deepEqual(hv(sess([call({ groups: [] }), call({}), call({ groups: ['nope', 'all', ''] })])), ['bash', 'relay_dispatch', 'tool_unlock'])
})
test('session isolation', () => {
  const a = sess([call({ groups: ['dev'] })]); const b = sess()
  const st = { [a.header.id]: { browser: true } }
  assert.ok(hv(a, st).includes('mcp__chrome-devtools__click'))
  assert.ok(!hv(b, st).includes('mcp__chrome-devtools__click') && !hv(b, st).includes('dev_mode_set'))
  assert.ok(!hv(b, { '': { dev: true }, undefined: { dev: true } }).includes('dev_mode_set'))
})
test('internal calls and resident tools do not unlock', () => {
  const s = sess([mk('mcp__harness_relay__start_run', { callId: 'relay-dispatch-1' }), mk('dev_x', { parent: {} }), mk('relay_dispatch'), mk('tool_unlock')])
  assert.deepEqual(hv(s), ['bash', 'relay_dispatch', 'tool_unlock'])
})
test('real connector call unlocks only connector; resume stable', () => {
  const s = sess([mk('mcp_connector_status')])
  const v = hv(s)
  assert.ok(v.includes('mcp_connector_status') && !v.includes('dev_mode_set') && !v.includes('mcp__harness_relay__get_run'))
  assert.equal(openSources(s, cfg, {}).connector.src, '自动放行')
  assert.deepEqual(hv(s), v)
  assert.deepEqual(filterTools([], s, cfg, {}), [])
})
test('bad prefixes ignored', () => {
  const c = { ...cfg, groups: { x: { prefixes: ['', undefined], names: [] } } }
  assert.equal(groupOf('bash', c), undefined)
})
test('extras implicit direct call stays allowed without changing warm tools[]', () => {
  const s = sess()
  const catalog = [...tools, { name: 'workflow' }, { name: 'read_page' }]
  const before = vis(filterTools(catalog, s, cfg, {}))
  const decision = gateDecision('workflow', s, cfg, {})
  assert.equal(decision.kind, 'allow')
  assert.equal(decision.autoUnlock, 'extras')
  s.events.push(mk('workflow'))
  assert.deepEqual(vis(filterTools(catalog, s, cfg, {})), before)
  assert.equal(openSources(s, cfg, {}).extras?.src, '直调放行(缓存不变)')
  s.events.push(call({ groups: ['extras'] }))
  assert.ok(vis(filterTools(catalog, s, cfg, {})).includes('workflow'))
})
test('contexts: super-injector text gated by dev group', () => {
  const ctxs = [{ text: '沙箱策略' }, { text: '本环境装有 dsh-super-injector（dev_* 工具）：x' }, '审批策略']
  const closed = filterContexts(ctxs, sess(), cfg, {})
  assert.deepEqual(closed, [ctxs[0], ctxs[2]])
  assert.equal(filterContexts(ctxs, sess([call({ groups: ['dev'] })]), cfg, {}).length, 3)
  assert.deepEqual(filterContexts([], sess(), cfg, {}), [])
})
