import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, finishConclude, preflightFollowUp } from '../lib/index.js'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function exec(events) {
  return { agent: { session: { events }, phase: { turn: 1, step: 1 } }, concludeTurn() { this.concluded = (this.concluded || 0) + 1 } }
}
const message = (text = '') => ({ type: 'assistant/message', turn: 1, step: 1, seq: 1, data: { message: { content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool-call', id: 'r', name: 'relay_dispatch' }] } } })

test('100 concurrent successful concludes are one-shot; failed and streaming paths never conclude', async () => {
  const good = exec([{ type: 'step/start' }, message()])
  const results = await Promise.all(Array.from({ length: 100 }, () => finishConclude(good)))
  assert.ok(results.every((x) => x === ''))
  assert.equal(good.concluded, 1)
  assert.equal(good.agent.session.events.filter((e) => e.data?.source?.kind === 'synthetic-receipt').length, 1)
  const failed = exec([{ type: 'step/start' }, message('done'), { type: 'tool/result', data: { name: 'read', isError: true } }])
  assert.ok((await Promise.all(Array.from({ length: 100 }, () => finishConclude(failed)))).every((x) => /C1/.test(x)))
  assert.notEqual(failed.concluded, 1)
  const streaming = exec([{ type: 'step/start' }, message(), { type: 'assistant/chunk', data: { chunk: { type: 'text-delta' } } }])
  assert.match(await finishConclude(streaming), /输出尚未结束/)
})

test('AUDIT R2-NEW-01: stale successful context result must not satisfy a still-pending sibling', async () => {
  const events = [{ type: 'step/start' }, message('done'), { type: 'tool/call', data: { name: 'context_compact', callId: 'current' } }, { type: 'tool/result', data: { name: 'context_compact', callId: 'old', content: [{ type: 'text', text: 'committed' }] } }]
  const target = exec(events)
  assert.match(await finishConclude(target, [], { timeoutMs: 0 }), /超时未完成/)
  const currentError = [...events.slice(0, -1), { type: 'tool/result', data: { name: 'context_compact', callId: 'current', isError: true } }]
  assert.match(await finishConclude(exec(currentError), [], { timeoutMs: 0 }), /执行失败/)
})

test('followUp malformed inputs fail before remote dispatch and never emit mutually exclusive session fields', () => {
  const config = { currentSessionId: 'p', readManifest: () => ({ pipelineId: 'p', parentSessionId: 'p', phase: 'completed', machineHeader: 'RESULT: FAIL', plan: { gate: { checks: [] }, tasks: [{ baseArgs: { workspace: 'W', task: 'old' }, previewArgs: { workspace: 'W' } }] }, items: [{ index: 0, kind: 'task', status: 'failed', sessionId: 'child' }], followUps: [] }) }
  for (const bad of [null, 1, {}, { pipelineId: '../x' }, { pipelineId: 'p', patchTask: '' }, { pipelineId: 'p', patchTask: 'x'.repeat(2001) }, { pipelineId: 'p', patchGate: [] }]) assert.throws(() => preflightFollowUp(bad, config))
  const plan = preflightFollowUp({ pipelineId: 'p', patchTask: 'fix' }, config)
  for (const task of plan.tasks) {
    assert.equal(task.baseArgs.sessionMode, undefined)
    assert.equal(task.previewArgs.sessionMode, undefined)
    assert.equal(task.baseArgs.sessionId, 'child')
  }
})

test('hot-reload wake waits for compaction commit; detach resumes original runId without a second start', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-r2-wake-'))
  const modesPath = join(dir, 'modes.yaml')
  writeFileSync(modesPath, 'verify:\n  permission: read-only\n  models:\n    - a/m1\n')
  const parent = { id: 'parent', status: 'idle', session: { header: { id: 'parent' }, events: [] }, inbox: { nextStep: [], nextTurn: [] }, followUps: [], followup(msg) { this.followUps.push(msg) } }
  const epoch = { bySession: new WeakMap() }
  epoch.bySession.set(parent.session, { compacting: true })
  const key = Symbol.for('@dsh-external/prefix-epoch')
  const previousEpoch = globalThis[key]
  globalThis[key] = epoch
  t.after(() => { globalThis[key] = previousEpoch })
  const disposers = []
  const remote = new Map()
  const calls = []
  const jobs = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    get(k) {
      if (k === 'agents') return { get: (id) => id === parent.id ? parent : undefined }
      if (k === 'jobs') return { start(spec) { const rec = { id: 'job-original', hooks: spec.run() }; rec.done = rec.hooks.done; jobs.push(rec); return rec.id } }
    },
    tools: { register(tool) { this.tool = tool; return () => {} }, async execute(call) {
      calls.push(call)
      if (call.name.endsWith('start_run')) { remote.set('run-original', { runId: 'run-original', sessionId: 'child', status: 'running' }); return { isError: false, value: remote.get('run-original') } }
      if (call.name.endsWith('wait_run')) { await new Promise((resolve) => setTimeout(resolve, 5)); return { isError: false, value: { ...remote.get(call.arguments.runId), status: 'running' } } }
      return { isError: false, value: {} }
    } },
  }
  apply(ctx, { modesPath, manifestDir: dir, linkParentSession: false, refreshTitle: false, sliceMs: 1, resumeDelayMs: 60000, wakeDelayMs: 1, wakePollMs: 2, wakeMaxChecks: 100, maxConsecutiveWakes: 2 })
  const accepted = await ctx.tools.tool.execute({ tasks: [{ startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }] }, { agent: parent })
  while (disposers.length) disposers.pop()()
  const out = await jobs[0].done
  assert.equal(out.status, 'killed')
  const manifest = JSON.parse(readFileSync(accepted.manifestPath, 'utf8'))
  assert.equal(manifest.phase, 'detached')
  assert.equal(manifest.items[0].runId, 'run-original')
  epoch.bySession.get(parent.session).compacting = false

  const resumedDisposers = []
  let starts = 0
  const resumed = {
    effect(fn) { const d = fn(); if (typeof d === 'function') resumedDisposers.push(d); return d },
    get(k) {
      if (k === 'agents') return { get: () => parent }
      if (k === 'jobs') return { start(spec) { const hooks = spec.run(); return hooks.done.finally(() => {}) } }
    },
    tools: { register() { return () => {} }, async execute(call) {
      if (call.name.endsWith('start_run')) starts++
      if (call.name.endsWith('wait_run')) return { isError: false, value: { runId: 'run-original', status: 'succeeded', assistantText: 'done' } }
      return { isError: false, value: {} }
    } },
  }
  apply(resumed, { modesPath, manifestDir: dir, linkParentSession: false, refreshTitle: false, sliceMs: 1, resumeDelayMs: 1, wakeDelayMs: 60000 })
  for (let i = 0; i < 40 && JSON.parse(readFileSync(accepted.manifestPath, 'utf8')).phase !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(starts, 0)
  assert.equal(JSON.parse(readFileSync(accepted.manifestPath, 'utf8')).phase, 'completed')
  parent.inbox.nextStep.push({ id: 'done-notice', role: 'user', content: [{ type: 'text', text: 'done job-original' }] })
  epoch.bySession.get(parent.session).compacting = true
  apply(ctx, { modesPath, manifestDir: dir, linkParentSession: false, refreshTitle: false, resumeDelayMs: 1, wakeDelayMs: 1, wakePollMs: 2, wakeMaxChecks: 100, parentWakeWindowMs: 60000 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(parent.followUps.length, 0, 'notification must stay queued during compaction')
  epoch.bySession.get(parent.session).compacting = false
  for (let i = 0; i < 30 && !parent.followUps.length; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.equal(parent.followUps.length, 1)
  while (resumedDisposers.length) resumedDisposers.pop()()
  while (disposers.length) disposers.pop()()
})
