import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStartArgs, preflightFollowUp, finishConclude, concludeRequested } from '../lib/index.js'

function manifest(baseArgs = {}) {
  return { pipelineId: 'p', parentSessionId: 'parent', phase: 'done', machineHeader: 'RESULT: FAIL', plan: { gate: { checks: [] }, tasks: [{ baseArgs: { workspace: 'C:/work', ...baseArgs }, previewArgs: { workspace: 'C:/work', ...baseArgs }, rawTask: 'fix' }] }, items: [{ index: 0, kind: 'task', status: 'failed', ...(baseArgs.sessionId ? { sessionId: baseArgs.sessionId } : {}) }], followUps: [] }
}
function execWith(events) {
  return { agent: { session: { events }, phase: { turn: 1, step: 1 } }, concludeTurn() { this.concluded = (this.concluded || 0) + 1 } }
}
function assistant(calls = [], text = '') {
  return { type: 'assistant/message', turn: 1, step: 1, seq: 1, data: { message: { content: [...(text ? [{ type: 'text', text }] : []), ...calls] } } }
}

test('100 concurrent successful concludes share one concludeTurn and one receipt', async () => {
  const exec = execWith([{ type: 'step/start' }, assistant([{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }])])
  const results = await Promise.all(Array.from({ length: 100 }, () => finishConclude(exec)))
  assert.ok(results.every((x) => x === ''))
  assert.equal(exec.concluded, 1)
  assert.equal(exec.agent.session.events.filter((e) => e.data?.source?.kind === 'synthetic-receipt').length, 1)
})

test('100 concurrent context_compact waiters accept one success and conclude once', async () => {
  const events = [{ type: 'step/start' }, assistant([{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }, { type: 'tool-call', id: 'c', name: 'context_compact' }]), { type: 'tool/call', seq: 2, data: { callId: 'c', name: 'context_compact' } }]
  const exec = execWith(events)
  const waiter = setTimeout(() => events.push({ type: 'tool/result', seq: 3, data: { name: 'context_compact', message: { source: { callId: 'c' }, content: [{ type: 'text', text: 'committed' }] } } }), 2)
  const results = await Promise.all(Array.from({ length: 100 }, () => finishConclude(exec, [], { timeoutMs: 100, intervalMs: 1 })))
  clearTimeout(waiter)
  assert.ok(results.every((x) => x === ''), [...new Set(results)].join(','))
  assert.equal(exec.concluded, 1)
})

test('followUp invalid values fail explicitly without reading production manifests', () => {
  const config = { currentSessionId: 'parent', readManifest: () => manifest({ sessionId: 's', sessionMode: 'fresh' }) }
  for (const bad of [null, {}, { pipelineId: '../bad' }, { pipelineId: 'p', patchTask: '' }, { pipelineId: 'p', patchTask: 'x'.repeat(2001) }]) assert.throws(() => preflightFollowUp(bad, config))
  const out = preflightFollowUp({ pipelineId: 'p', patchTask: 'fix' }, config)
  assert.ok(!(out.tasks[0].baseArgs.sessionId && out.tasks[0].baseArgs.sessionMode))
  assert.ok(!(out.tasks[0].previewArgs.sessionId && out.tasks[0].previewArgs.sessionMode))
})

test('normalize and conclude tolerate null/prototype and malformed events without false success', async () => {
  assert.doesNotThrow(() => normalizeStartArgs(Object.create(null)))
  assert.doesNotThrow(() => normalizeStartArgs({ sessionId: 'x', sessionMode: null }))
  assert.equal(concludeRequested(null).ok, false)
  assert.equal(concludeRequested({ agent: { session: { events: [null, {}] } } }).ok, false)
  const failure = execWith([{ type: 'step/start' }, assistant([{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }], 'done'), { type: 'tool/result', data: { name: 'read', isError: true } }])
  const results = await Promise.all(Array.from({ length: 100 }, () => finishConclude(failure)))
  assert.ok(results.every((x) => /C1/.test(x)))
  assert.notEqual(failure.concluded, 1)
  assert.equal(await finishConclude(failure, ['warning']), 'C5 有派发警告')
  assert.equal(await finishConclude(failure, [], { failed: true }), 'C1 派发失败，不结束本轮')
})
