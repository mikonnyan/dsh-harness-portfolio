import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  apply, evaluateSubagentPrepare, noteSubagentStartFailure,
  readSubagentFreeAudit, resetSubagentFreeRouting, PREPARE_SYM,
} from '../lib/index.js'
import { isRpSession } from '../../dsh-tool-gate/lib/orchestrator-guard.js'

const GROK = 'cursor/grok-4.7-fast'
const modelOf = (route) => `${route.candidate?.provider}/${route.candidate?.model}`
const baseOptions = (meta = {}, extra = {}) => ({
  provider: 'anthropic', model: 'claude-opus-4', reasoningEffort: 'low', prompt: 'bounded audit',
  meta: { delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1', cwd: 'C:/work', ...meta },
  ...extra,
})
beforeEach(() => resetSubagentFreeRouting())

function harness(create) {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-r2-stress-'))
  const disposers = []
  const prepared = []
  const workspace = { path: 'C:/work', sessionIds: ['parent-1'], async attachSession(id) { this.sessionIds.unshift(id) }, async insertSessionBefore() {} }
  const originalPrepare = (id, opts) => {
    prepared.push({ id, model: opts.model, provider: opts.provider, effort: opts.reasoningEffort })
    return { id, header: { id, ...opts.meta } }
  }
  const sessions = { prepare: originalPrepare, get() {}, list() { return [] } }
  const agents = { create }
  const ctx = {
    tools: { register() { return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    get(key) {
      return { sessions, agents, workspaceRegistry: { list: () => [workspace] }, sessionTitle: { rename() {} } }[key]
    },
  }
  const reapply = () => apply(ctx, { parentLogPath: null, manifestDir: dir, refreshTitle: false, resumeDelayMs: 600000 })
  reapply()
  return {
    sessions, agents, prepared, originalPrepare, reapply,
    async close() { while (disposers.length) disposers.pop()(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('concurrent modeled subagent/fork/relay prepares preserve routing isolation', () => {
  const routes = Array.from({ length: 120 }, (_, i) => {
    if (i % 3 === 1) {
      const opts = baseOptions({ origin: 'fork' }, { seed: [] })
      return { kind: 'fork', verdict: evaluateSubagentPrepare(`fork-${i}`, opts, { now: 100 }) }
    }
    if (i % 3 === 2) {
      const opts = baseOptions({ parentSession: 'relay-parent' })
      const slot = { active: true, used: false, createdAt: 0, expiresAt: 1000, cwd: 'C:/work', parent: 'relay-parent' }
      return { kind: 'relay', verdict: evaluateSubagentPrepare(`relay-${i}`, opts, { slot, now: 100 }) }
    }
    const opts = baseOptions()
    return { kind: 'plain', verdict: evaluateSubagentPrepare(`plain-${i}`, opts, { now: 100 }) }
  })
  const plain = routes.filter((r) => r.kind === 'plain')
  assert.equal(plain.length, 40)
  assert.deepEqual(plain.map((r) => modelOf(r.verdict)), plain.map(() => GROK))
  assert.ok(plain.every((r) => r.verdict.reason === 'primary' && r.verdict.candidate.reasoningEffort === 'xhigh'))
  for (const route of routes.filter((r) => r.kind !== 'plain')) {
    assert.equal(route.verdict.action, 'keep')
    assert.equal(route.verdict.reason, route.kind === 'fork' ? 'fork' : 'relay-slot')
    assert.equal(readSubagentFreeAudit(route.verdict.id), undefined)
  }
})

test('mid-flight apply/dispose cycles share one original prepare and never resurrect stale generations', async (t) => {
  const h = harness((options) => ({ options }))
  t.after(() => h.close())
  const original = h.sessions[PREPARE_SYM].orig
  assert.equal(original, h.originalPrepare)
  const generations = []
  for (let i = 0; i < 8; i++) {
    const before = h.sessions[PREPARE_SYM]
    h.reapply()
    h.sessions.prepare(`mid-flight-${i}`, baseOptions())
    h.agents.create(baseOptions({}, { sessionId: `mid-create-${i}` }))
    const after = h.sessions[PREPARE_SYM]
    assert.equal(after, before, 'Symbol.for state must survive reload')
    assert.equal(after.orig, original, 'wrapper layers must not accumulate')
    assert.ok(after.generation > (generations.at(-1) || 0))
    generations.push(after.generation)
    const next = harness((options) => ({ options }))
    assert.equal(next.sessions[PREPARE_SYM].orig, next.originalPrepare)
    await next.close()
  }
  assert.equal(h.prepared.length, 8)
  assert.equal(h.sessions[PREPARE_SYM].generation, generations.at(-1))
})

test('100 concurrent async creates retry once, keep fork/relay explicit and settle every promise', async (t) => {
  const calls = []
  const h = harness(async (options) => {
    calls.push({ id: options.sessionId, model: options.model, retried: options.__subagentRetried === true })
    h.sessions.prepare(options.sessionId, options)
    await new Promise((resolve) => setImmediate(resolve))
    const firstPlainInWave = Number(options.sessionId.split('-')[1]) % 4 === 0
    if (!options.__subagentRetried && options.sessionId.startsWith('plain-') && firstPlainInWave) throw new Error('HTTP 503 unavailable')
    return { options }
  })
  t.after(() => h.close())
  const results = []
  // Each four-call wave has one injected failure. Reset isolates epochs so
  // previously fused candidates do not deliberately drive later waves fail-open.
  for (let wave = 0; wave < 25; wave++) {
    resetSubagentFreeRouting()
    const jobs = Array.from({ length: 4 }, (_, j) => {
      const i = wave * 4 + j
      if (j === 1) return h.agents.create(baseOptions({ origin: 'fork' }, { sessionId: `fork-${i}`, seed: [] }))
      if (j === 2) return h.agents.create(baseOptions({ origin: 'relay-dispatch' }, { sessionId: `relay-${i}`, provider: 'openai', model: 'explicit-model', reasoningEffort: 'medium' }))
      return h.agents.create(baseOptions({}, { sessionId: `plain-${i}` }))
    })
    results.push(...await Promise.all(jobs))
  }
  assert.equal(results.length, 100)
  assert.equal(calls.length, 125)
  assert.equal(calls.filter((c) => c.retried).length, 25)
  for (const result of results) {
    if (result.options.sessionId.startsWith('fork-')) assert.equal(result.options.model, 'claude-opus-4')
    if (result.options.sessionId.startsWith('relay-')) assert.deepEqual([result.options.provider, result.options.model, result.options.reasoningEffort], ['openai', 'explicit-model', 'medium'])
    if (result.options.sessionId.startsWith('plain-')) {
      if (result.options.__subagentRetried) assert.equal(result.options.model, 'kimi-k3.1-pro')
      else {
        assert.equal(result.options.model, 'grok-4.7-fast')
        assert.equal(result.options.reasoningEffort, 'xhigh')
      }
    }
  }
})

test('case-insensitive and mixed-slash sensitive paths cannot bypass either guard', () => {
  const paths = [
    'C:\\work\\XIAOSHUO\\chapter', 'C:/work/XiAoShUo/chapter',
    'C:\\work\\XIAOSHUO\\..\\safe', 'C:/work/XIAOSHUO/../safe',
    'C:\\work\\XIAOSHUO\\..', 'C:/work/XIAOSHUO\\..',
    'C:\\work\\XIAOSHUO', 'C:/work/XIAOSHUO/..',
    'C:\\work\\MAC-V4-SYNC\\..', 'C:/work/DSH-RP-GUARDIAN/..',
  ]
  for (const cwd of paths) {
    const route = evaluateSubagentPrepare(`sneaky-${cwd}`, baseOptions({ cwd }), { now: 100 })
    assert.equal(modelOf(route), GROK, cwd)
    assert.equal(route.candidate.reasoningEffort, 'xhigh', cwd)
    assert.equal(isRpSession({ header: { cwd } }), true, cwd)
  }
})

test('sensitive concurrent failures always retry only grok+xhigh', () => {
  const routes = Array.from({ length: 50 }, (_, i) => evaluateSubagentPrepare(`rp-${i}`, baseOptions({ cwd: `C:/work/XIAOSHUO/${i}` }), { now: 1000 }))
  for (const route of routes) {
    const retry = noteSubagentStartFailure(route.id, new Error('HTTP 429 quota exhausted'), 1000)
    assert.equal(retry.retry, true)
    assert.equal(modelOf(retry), GROK)
    assert.equal(retry.candidate.reasoningEffort, 'xhigh')
    assert.equal(noteSubagentStartFailure(route.id, new Error('HTTP 503 still down'), 1001).retry, false)
  }
})

test('one failed plain create fails over once without disturbing concurrent fork/relay calls', async (t) => {
  const calls = []
  const h = harness(async (options) => {
    calls.push({ id: options.sessionId, model: options.model, retried: options.__subagentRetried === true })
    h.sessions.prepare(options.sessionId, options)
    await new Promise((resolve) => setImmediate(resolve))
    if (!options.__subagentRetried && options.sessionId === 'plain-failure') throw new Error('HTTP 503 unavailable')
    return { options }
  })
  t.after(() => h.close())
  const results = await Promise.all([
    h.agents.create(baseOptions({}, { sessionId: 'plain-failure' })),
    h.agents.create(baseOptions({}, { sessionId: 'plain-success' })),
    h.agents.create(baseOptions({ origin: 'fork' }, { sessionId: 'fork-success', seed: [] })),
    h.agents.create(baseOptions({ origin: 'relay-dispatch' }, { sessionId: 'relay-success', model: 'explicit-model' })),
  ])
  assert.equal(calls.filter((c) => c.retried).length, 1)
  assert.equal(results[0].options.provider, 'kimi')
  assert.equal(results[0].options.model, 'kimi-k3.1-pro')
  assert.equal(results[1].options.model, 'grok-4.7-fast')
  assert.equal(results[1].options.reasoningEffort, 'xhigh')
  assert.equal(results[2].options.model, 'claude-opus-4')
  assert.equal(results[3].options.model, 'explicit-model')
})

test('grok fuse boundary is exact and 4098-down stays on grok without probing', () => {
  const first = evaluateSubagentPrepare('cooldown', baseOptions(), { now: 1000, kimiBridgeUp: true })
  assert.equal(modelOf(first), GROK)
  assert.equal(first.candidate.reasoningEffort, 'xhigh')
  const retry = noteSubagentStartFailure(first.id, new Error('HTTP 503 unavailable'), 1000)
  assert.equal(retry.retry, true)
  assert.equal(retry.candidate.provider, 'kimi')
  assert.equal(retry.candidate.model, 'kimi-k3.1-pro')
  assert.equal(evaluateSubagentPrepare('cooldown-before', baseOptions(), { now: 60999 }).candidate.provider, 'kimi')
  const recovered = evaluateSubagentPrepare('cooldown-at', baseOptions(), { now: 61000 })
  assert.equal(modelOf(recovered), GROK)
  assert.equal(recovered.candidate.reasoningEffort, 'xhigh')
  const down = evaluateSubagentPrepare('known-down', baseOptions(), { now: 62000, kimiBridgeUp: false })
  assert.equal(modelOf(down), GROK)
})
