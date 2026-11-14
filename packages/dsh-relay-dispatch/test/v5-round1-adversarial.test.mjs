import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { normalizeStartArgs, fillStartArgs, preflightFollowUp, finishConclude } from '../lib/index.js'

const manifest = (baseArgs = {}) => ({ pipelineId: 'failed-p', parentSessionId: 'audit-parent', phase: 'done', machineHeader: 'RESULT: FAIL', result: 'FAIL', updatedAt: new Date().toISOString(), plan: { gate: { checks: [] }, tasks: [{ baseArgs: { workspace: 'C:/work', sessionMode: 'fresh', ...baseArgs }, previewArgs: { workspace: 'C:/work', sessionMode: 'fresh', ...baseArgs }, rawTask: 'fix', status: 'failed', kind: 'task' }] }, items: [{ index: 0, kind: 'task', status: 'failed', checks: [], ...(baseArgs.sessionId ? { sessionId: baseArgs.sessionId } : {}) }], followUps: [] })

test('§8.1 normalizeStartArgs: explicit sessionId always wins and input not mutated', () => {
  const input = { sessionId: 'abc', sessionMode: 'fresh', task: 'fix' }
  assert.deepEqual(normalizeStartArgs(input), { sessionId: 'abc', task: 'fix' })
  assert.equal(input.sessionMode, 'fresh')
  assert.equal(normalizeStartArgs({ task: 'x' }).sessionMode, 'fresh')
})

test('§8.1 followUp: base and preview never send sessionId + sessionMode', () => {
  for (const baseArgs of [{ sessionId: 'resume-me' }, {}]) {
    const plan = preflightFollowUp({ pipelineId: 'failed-p', patchTask: 'fix' }, { currentSessionId: 'audit-parent', readManifest: () => manifest(baseArgs) })
    const task = plan.tasks[0]
    for (const args of [task.baseArgs, task.previewArgs]) assert.ok(!(args.sessionId && args.sessionMode), JSON.stringify(args))
  }
})

test('§8.1 ordinary and explicit resume fill paths have the same invariant', () => {
  for (const input of [{ workspace: 'C:/work', task: 'x' }, { workspace: 'C:/work', task: 'x', sessionId: 's', sessionMode: 'fresh' }]) {
    const out = fillStartArgs(input)
    assert.ok(!(out.sessionId && out.sessionMode))
  }
})

const execWith = (events) => ({ agent: { session: { events }, phase: { turn: 1, step: 1 } }, concludeTurn() { this.concluded = true } })
const assistant = (calls = []) => ({ type: 'assistant/message', seq: 1, turn: 1, step: 1, data: { message: { content: [{ type: 'text', text: 'dispatched' }, ...calls] } } })

test('I-C2: any tool error in current step blocks conclude', async () => {
  const exec = execWith([{ type: 'step/start' }, assistant([{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }]), { type: 'tool/result', seq: 2, data: { name: 'read', isError: true } }])
  assert.equal(await finishConclude(exec), 'C1 工具报错，不结束本轮')
  assert.notEqual(exec.concluded, true)
})

test('I-C2: context_compact error blocks conclude', async () => {
  const exec = execWith([{ type: 'step/start' }, assistant([{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }, { type: 'tool-call', id: 'c', name: 'context_compact' }]), { type: 'tool/result', seq: 2, data: { name: 'context_compact', status: 'error' } }])
  assert.match(await finishConclude(exec, [], { timeoutMs: 1, intervalMs: 0 }), /失败|超时/)
  assert.notEqual(exec.concluded, true)
})

test('C1: tool error hidden in an earlier step must not poison valid current step; current-step success concludes', async () => {
  const exec = execWith([{ type: 'tool/result', data: { name: 'read', isError: true } }, { type: 'step/start' }, assistant([{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }])])
  assert.equal(await finishConclude(exec), '')
  assert.equal(exec.concluded, true)
})

test('C1: failed sibling tool result blocks conclude even when tool call block was streamed separately', async () => {
  const exec = execWith([{ type: 'step/start' }, assistant(), { type: 'tool/call', seq: 2, data: { name: 'relay_dispatch' } }, { type: 'tool/result', seq: 3, data: { name: 'read', status: 'error', message: { isError: true } } }])
  assert.equal(await finishConclude(exec), 'C1 工具报错，不结束本轮')
  assert.notEqual(exec.concluded, true, 'failed tool must never trigger conclude')
})

test('R7: a chunk after the assistant message waits for model output to end', async () => {
  const exec = execWith([
    { type: 'step/start' },
    { type: 'assistant/message', turn: 1, step: 1, data: { message: { content: [{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }] } } },
    { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'still' } } },
  ])
  assert.match(await finishConclude(exec), /模型输出尚未结束/)
  assert.notEqual(exec.concluded, true)
})

test('C2: empty text synthesizes a receipt instead of refusing to conclude', async () => {
  const exec = execWith([{ type: 'step/start' }, { type: 'assistant/message', turn: 1, step: 1, data: { message: { content: [{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }] } } }])
  await finishConclude(exec)
  assert.equal(exec.concluded, true)
  assert.ok(exec.agent.session.events.some((e) => e.data?.source?.kind === 'synthetic-receipt'))
})

test('conclude: true with empty assistant text survives a frozen Session v4 events array', async () => {
  const events = Object.freeze([
    { type: 'step/start' },
    { type: 'assistant/message', turn: 1, step: 1, data: { message: { content: [{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }] } } },
  ])
  const exec = execWith(events)
  assert.equal(Object.isExtensible(exec.agent.session.events), false)
  const reason = await finishConclude(exec)
  assert.equal(reason, '')
  assert.equal(exec.concluded, true)
})

test('I-C3/I-C4: ring uses calibrated projection only until newer usage', () => {
  const file = new URL('../lib/client.js', import.meta.url)
  let source = readFileSync(file, 'utf8').replace('exports.meterInternals = { compactionSavedAfterUsage, adjustedRingTokens };', 'exports.meterInternals = { compactionSavedAfterUsage, adjustedRingTokens, compactProjectionTokens };')
  let exported
  const sandbox = { window: { __ModuleLoader__: { load: (x) => { exported = x.factory(() => ({})) } } } }
  vm.runInNewContext(source, sandbox)
  const f = exported.meterInternals.compactProjectionTokens
  const projection = { type: 'session/compact', seq: 20, data: { projection: { surfaceTokens: 1000, calibration: 1.2, basis: 'heuristic', atSeq: 20 } } }
  assert.equal(f([projection]), 1200)
  assert.equal(f([{ type: 'assistant/chunk', seq: 21, data: { chunk: { type: 'usage', usage: { prompt_tokens: 5000 } } } }, projection]), null)
  assert.equal(f([projection, { type: 'assistant/chunk', seq: 21, data: { chunk: { type: 'usage', usage: { prompt_tokens: 5000 } } } }]), null)
})
