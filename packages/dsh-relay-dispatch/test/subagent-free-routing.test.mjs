import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  apply, applySubagentRoute, evaluateSubagentPrepare, isModelError,
  markSubagentCandidateUnhealthy, noteSubagentStartFailure,
  readSubagentFreeAudit, resetSubagentFreeRouting,
} from '../lib/index.js'
import { DELEGATE_REQUIRED, strictTurnDecision } from '../../dsh-tool-gate/lib/orchestrator-guard.js'

const GROK = 'cursor/grok-4.7-fast'
const parent = () => ({ provider: 'anthropic', model: 'claude-opus-4', reasoningEffort: 'low' })
const plain = (meta = {}, extra = {}) => ({
  ...parent(), prompt: 'inspect implementation',
  meta: { delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1', cwd: 'C:/work', ...meta },
  ...extra,
})
const modelOf = (v) => `${v.candidate?.provider}/${v.candidate?.model}`
const assertGrok = (v) => {
  assert.equal(modelOf(v), GROK)
  assert.equal(v.candidate.reasoningEffort, 'xhigh')
  assert.doesNotMatch(JSON.stringify(v), /kimi\/|claude-fable-5-2/)
}

beforeEach(() => resetSubagentFreeRouting())

test('I-SUB1/I-SUB5: plain and header-depth children never inherit; healthy default is grok', () => {
  for (const opts of [plain(), plain({ delegationDepth: undefined }, { header: { delegationDepth: 2 } })]) {
    const verdict = evaluateSubagentPrepare(`plain-${Math.random()}`, opts, { now: 100 })
    assert.equal(verdict.action, 'rewrite')
    assert.equal(verdict.reason, 'primary')
    assertGrok(verdict)
    applySubagentRoute(opts, verdict)
    assert.equal(opts.provider, verdict.candidate.provider)
    assert.equal(opts.model, verdict.candidate.model)
    assert.notEqual(opts.model, 'claude-opus-4')
    assert.equal(opts.reasoningEffort, 'xhigh')
  }
  resetSubagentFreeRouting()
  const batch = Array.from({ length: 10 }, (_, i) => evaluateSubagentPrepare(`rr-${i}`, plain(), { now: 100 }))
  assert.deepEqual(batch.map(modelOf), Array.from({ length: 10 }, () => GROK))
  assert.ok(batch.every((verdict) => verdict.reason === 'primary' && verdict.candidate.reasoningEffort === 'xhigh'))
})

test('I-SUB2: every fork marker keeps the exact parent provider/model/effort', () => {
  const forks = [plain({}, { seed: [] }), plain({ seedLength: 0 }), plain({ origin: 'fork' })]
  for (const [i, opts] of forks.entries()) {
    const before = structuredClone(opts)
    const verdict = evaluateSubagentPrepare(`fork-${i}`, opts, { now: 100 })
    assert.equal(verdict.action, 'keep')
    applySubagentRoute(opts, verdict)
    assert.equal(opts.provider, before.provider)
    assert.equal(opts.model, before.model)
    assert.equal(opts.reasoningEffort, before.reasoningEffort)
  }
})

test('I-SUB3: relay origin and live relay slots keep explicit models byte-for-byte', () => {
  for (const [i, meta] of [
    { origin: 'relay-dispatch' },
    { origin: 'relay-dispatch', parentSession: undefined },
  ].entries()) {
    const explicit = plain(meta, { provider: 'openai', model: 'explicit-model', reasoningEffort: 'medium' })
    const before = structuredClone(explicit)
    const verdict = evaluateSubagentPrepare(`relay-origin-${i}`, explicit, { now: 100 })
    assert.equal(verdict.action, 'keep')
    applySubagentRoute(explicit, verdict)
    assert.deepEqual(explicit, before, 'keep must be a byte-for-byte no-op')
  }
  const slot = { active: true, used: false, createdAt: 0, expiresAt: 1000, cwd: 'C:/work', parent: 'parent-1' }
  const slotted = plain()
  assert.equal(evaluateSubagentPrepare('relay-slot', slotted, { slot, now: 100 }).reason, 'relay-slot')
  assert.equal(slotted.model, 'claude-opus-4')
})

test('I-SUB4: all sensitive markers override plain/fork/relay/depth-zero and every forbidden target', () => {
  const cases = [
    plain({ cwd: 'C:/novel/xiaoshuo/chapter-1' }),
    plain({ cwd: 'C:/sync/mac-v4-sync' }),
    plain({}, { prompt: 'write about 苏晚晴' }),
    plain({ origin: 'fork' }, { seed: [{}], cwd: 'C:/work/dsh-rp-guardian' }),
    plain({ origin: 'relay-dispatch' }, { provider: 'kimi', model: 'kimi-k3.1-pro', cwd: 'C:/work/xiaoshuo' }),
    plain({ delegationDepth: 0, cwd: 'C:/work/xiaoshuo' }, { provider: 'claude', model: 'claude-fable-5-2' }),
  ]
  cases.push(plain())
  for (const [i, opts] of cases.entries()) {
    const verdict = evaluateSubagentPrepare(`sensitive-${i}`, opts, { now: 100, rpGuardianActive: i === cases.length - 1 })
    assertGrok(verdict)
    applySubagentRoute(opts, verdict)
    assert.deepEqual([opts.provider, opts.model, opts.reasoningEffort], ['cursor', 'grok-4.7-fast', 'xhigh'])
    const retry = noteSubagentStartFailure(verdict.id, new Error('HTTP 429 quota exhausted'), 100)
    assert.equal(retry.retry, true)
    assert.deepEqual(retry.candidate, { provider: 'cursor', model: 'grok-4.7-fast', reasoningEffort: 'xhigh' })
  }
})

test('I-SUB4/I-SUB6: RP retry cannot become fail-open parent inheritance when grok is fused', () => {
  markSubagentCandidateUnhealthy({ provider: 'cursor', model: 'grok-4.7-fast' }, 100)
  const verdict = evaluateSubagentPrepare('rp-fused', plain({ cwd: 'C:/work/xiaoshuo' }), { now: 100 })
  assertGrok(verdict)
  const first = noteSubagentStartFailure('rp-fused', new Error('HTTP 503 unavailable'), 100)
  assert.equal(first.retry, true)
  assertGrok({ candidate: first.candidate })
  const second = noteSubagentStartFailure('rp-fused', new Error('HTTP 503 unavailable'), 101)
  assert.equal(second.retry, false)
  assert.equal(readSubagentFreeAudit('rp-fused').candidate.model, 'grok-4.7-fast')
})

test('I-SUB6: plain subagent defaults to grok; 429 falls back to kimi until grok recovers at 60s', () => {
  const down = evaluateSubagentPrepare('bridge-down', plain(), { now: 1000, kimiBridgeUp: false })
  assertGrok(down)
  resetSubagentFreeRouting()
  const primary = evaluateSubagentPrepare('primary', plain(), { now: 1001, kimiBridgeUp: true })
  assertGrok(primary)
  assert.equal(primary.reason, 'primary')
  const failure = noteSubagentStartFailure('primary', new Error('HTTP 429 quota exhausted'), 1001)
  assert.equal(failure.retry, true)
  assert.deepEqual(failure.candidate, { provider: 'kimi', model: 'kimi-k3.1-pro' })
  assert.equal(evaluateSubagentPrepare('during-fuse', plain(), { now: 60_999 }).reason, 'fallback')
  assert.equal(evaluateSubagentPrepare('during-fuse-model', plain(), { now: 60_999 }).candidate.provider, 'kimi')
  const after = evaluateSubagentPrepare('after-fuse', plain(), { now: 61_001 })
  assertGrok(after)
  assert.equal(noteSubagentStartFailure('primary', new Error('HTTP 429 again'), 1002).retry, false)
})

test('I-SUB6: grok failure does not retry kimi when 4098 is already known down', () => {
  const verdict = evaluateSubagentPrepare('known-down-retry', plain(), { now: 1000, kimiBridgeUp: true })
  assertGrok(verdict)
  const retry = noteSubagentStartFailure(verdict.id, new Error('HTTP 503 unavailable'), 1001, { kimiBridgeUp: false })
  assert.deepEqual(retry, { retry: false, fused: true, reason: 'none-healthy' })
  assert.equal(evaluateSubagentPrepare('known-down-open', plain(), { now: 1001, kimiBridgeUp: false }).action, 'fail-open')
})

test('I-SUB6: validation errors propagate without retry or candidate fuse', () => {
  const verdict = evaluateSubagentPrepare('invalid', plain(), { now: 100 })
  const error = new Error('MCP error -32602: Input validation error: workspace required')
  assert.equal(isModelError(error.message), false)
  assert.deepEqual(noteSubagentStartFailure(verdict.id, error, 100), { retry: false, fused: false, reason: 'not-model-error' })
  const next = evaluateSubagentPrepare('after-invalid', plain(), { now: 100, pinnedCandidate: verdict.candidate })
  assert.equal(next.candidate.provider, verdict.candidate.provider, 'the original healthy candidate must not be fused')
})

test('I-SUB7: all candidates unhealthy fails open without mutating inherited options', () => {
  for (const candidate of [{ provider: 'kimi', model: 'kimi-k3.1-pro' }, { provider: 'cursor', model: 'grok-4.7-fast' }]) {
    markSubagentCandidateUnhealthy(candidate, 500)
  }
  const opts = plain()
  const verdict = evaluateSubagentPrepare('fail-open', opts, { now: 500 })
  assert.equal(verdict.action, 'fail-open')
  applySubagentRoute(opts, verdict)
  assert.deepEqual([opts.provider, opts.model, opts.reasoningEffort, opts.meta.origin], ['anthropic', 'claude-opus-4', 'low', 'subagent'])
})

test('I-SUB6 race: mid-stream fuse is observed immediately by later prepares', () => {
  const seen = []
  for (let i = 0; i < 10; i++) {
    const verdict = evaluateSubagentPrepare(`race-${i}`, plain(), { now: 900 })
    seen.push(modelOf(verdict))
    if (i === 4) markSubagentCandidateUnhealthy(verdict.candidate, 900)
  }
  assert.equal(new Set(seen).size, 2)
  const fused = seen[4]
  assert.ok(seen.slice(5).every((model) => model !== fused))
})

function harness({ create, onPrepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-free-audit-'))
  const logPath = join(dir, 'parent.log')
  const disposers = []
  const ids = ['parent-1']
  const attachments = []
  const workspace = {
    path: 'C:/work', sessionIds: ids,
    async attachSession(id) { attachments.push(id); if (!ids.includes(id)) ids.unshift(id) },
    async insertSessionBefore(id, before) {
      const rest = ids.filter((x) => x !== id)
      ids.splice(0, ids.length, ...rest.slice(0, rest.indexOf(before)), id, ...rest.slice(rest.indexOf(before)))
    },
  }
  const saved = new Map()
  const sessions = {
    prepare(id, opts) {
      onPrepare?.(id, opts)
      saved.set(id, { provider: opts.provider, model: opts.model, reasoningEffort: opts.reasoningEffort, meta: structuredClone(opts.meta) })
      return { id, header: { id, ...opts.meta } }
    },
    get() { return undefined }, list() { return [] },
  }
  const agents = { create: create || ((options) => ({ options })) }
  const ctx = {
    tools: { register() { return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    get(key) {
      if (key === 'sessions') return sessions
      if (key === 'agents') return agents
      if (key === 'workspaceRegistry') return { list: () => [workspace] }
      if (key === 'sessionTitle') return { rename() {} }
      return undefined
    },
  }
  apply(ctx, { parentLogPath: logPath, manifestDir: dir, refreshTitle: false, resumeDelayMs: 600000 })
  return {
    sessions, agents, saved, ids, attachments, logPath,
    async close() { while (disposers.length) disposers.pop()(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('I-SUB6 integration: asynchronous create model failure retries exactly once with live candidate', async (t) => {
  resetSubagentFreeRouting()
  const calls = []
  const h = harness({ create(options) {
    calls.push({ ...options, setup: undefined })
    h.sessions.prepare(options.sessionId, options)
    if (calls.length === 1) return Promise.reject(new Error('HTTP 503 unavailable'))
    return Promise.resolve({ options })
  } })
  t.after(() => h.close())
  const result = await h.agents.create(plain({}, { sessionId: 'async-failover', agentOptions: parent() }))
  assert.equal(calls.length, 2)
  const log = readFileSync(h.logPath, 'utf8')
  assert.match(log, /id=async-failover action=rewrite provider=cursor model=grok-4\.7-fast reasoningEffort=xhigh/)
  assert.match(log, /id=async-failover action=rewrite provider=kimi model=kimi-k3\.1-pro/)
  assert.equal(result.options.provider, 'kimi')
  assert.equal(result.options.model, 'kimi-k3.1-pro')
  assert.notEqual(result.options.reasoningEffort, 'xhigh')
  assert.equal(result.options.__subagentRetried, true)
  assert.equal(readSubagentFreeAudit('async-failover').failedKey, 'cursor/grok-4.7-fast')
})

test('I-SUB6 integration: delayed first failure prepares again and rejects a second async failure cleanly', async (t) => {
  resetSubagentFreeRouting()
  const pending = []
  const calls = []
  const h = harness({ create(options) {
    calls.push(options)
    return new Promise((resolve, reject) => pending.push({ options, resolve, reject }))
  } })
  t.after(() => h.close())
  const creating = h.agents.create(plain({}, { sessionId: 'deferred-failover', agentOptions: parent() }))
  assert.equal(pending.length, 1)
  // Delay rejection until after the synchronous create stack has popped.
  pending[0].reject(new Error('HTTP 503 unavailable'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pending.length, 2, 'the first model rejection must retry once')
  h.sessions.prepare('deferred-failover', pending[1].options)
  assert.equal(pending[1].options.provider, 'kimi')
  assert.equal(pending[1].options.model, 'kimi-k3.1-pro')
  assert.notEqual(pending[1].options.reasoningEffort, 'xhigh')
  const secondError = new Error('HTTP 503 still unavailable')
  pending[1].reject(secondError)
  await assert.rejects(creating, (error) => error === secondError, 'second failure must reject the original call exactly once')
})

test('I-SUB6 integration: invalid create options are not retried', async (t) => {
  let calls = 0
  const h = harness({ create(options) { calls++; h.sessions.prepare(options.sessionId, options); throw new Error('MCP error -32602: bad params') } })
  t.after(() => h.close())
  assert.throws(() => h.agents.create(plain({}, { sessionId: 'invalid-create' })), /-32602/)
  assert.equal(calls, 1)
})

test('I-SUB8 integration: persisted origin, parent link, workspace order and fail-open log', async (t) => {
  const h = harness()
  t.after(() => h.close())
  h.sessions.prepare('child-free', plain())
  const saved = h.saved.get('child-free')
  assert.equal(saved.meta.parentSession, 'parent-1')
  assert.equal(saved.meta.origin, 'subagent-free')
  assert.equal(readSubagentFreeAudit('child-free').originAudit, 'subagent-free')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(h.attachments.includes('child-free'))
  assert.deepEqual(h.ids.slice(0, 2), ['child-free', 'parent-1'], 'child is grouped immediately before its parent')
  for (const candidate of [{ provider: 'kimi', model: 'kimi-k3.1-pro' }, { provider: 'cursor', model: 'grok-4.7-fast' }]) markSubagentCandidateUnhealthy(candidate, Date.now())
  h.sessions.prepare('child-open', plain())
  assert.match(readFileSync(h.logPath, 'utf8'), /id=child-open action=fail-open reason=all-unhealthy parentInherited=1/)
})

test('orchestrator: third read and >200-line overflow give structured zero-cost subagent guidance', () => {
  const session = { header: { id: 'main' }, events: [{ type: 'turn/start', data: { turn: 1 } }] }
  const state = {}
  strictTurnDecision('read', { limit: 100 }, session, state, { strict: true })
  strictTurnDecision('read', { limit: 100 }, session, state, { strict: true })
  const third = strictTurnDecision('read', { limit: 1 }, session, state, { strict: true })
  assert.equal(third.kind, 'deny')
  assert.equal(third.error.ok, false)
  assert.equal(third.error.code, DELEGATE_REQUIRED)
  assert.deepEqual(third.error.hint.subagent.immediate, { run_in_background: false, prompt: '<阅读摘要任务>' })
  assert.equal(third.error.hint.subagent.parallel.run_in_background, true)
  assert.match(third.error.hint.subagent.note, /免费.*不要轮询.*relay_dispatch/)
  const lines = strictTurnDecision('read', { limit: 201 }, session, {}, { strict: true })
  assert.equal(lines.error.code, DELEGATE_REQUIRED)
  assert.ok(lines.error.hint.subagent)
  for (let i = 0; i < 3; i++) strictTurnDecision('read', { limit: 1 }, session, state, { strict: true })
  const stop = strictTurnDecision('read', { limit: 1 }, session, state, { strict: true })
  assert.match(stop.error.message, /停止尝试，直接派发/)
  const shadow = strictTurnDecision('read', { limit: 201 }, session, {}, { strict: 'shadow' })
  assert.equal(shadow.kind, 'allow')
  assert.equal(shadow.shadow, true)
  assert.ok(shadow.error.hint.subagent)
  assert.equal(strictTurnDecision('subagent', {}, session, {}, { strict: true }).kind, 'allow')
  assert.equal(strictTurnDecision('subagent_fork', {}, session, {}, { strict: true }).kind, 'allow')
})
