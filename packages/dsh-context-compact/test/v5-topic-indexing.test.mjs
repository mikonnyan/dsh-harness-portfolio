import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { coalesceSummaryBlocks } from '../lib/coalesce.js'
import { autoCompactState } from '../lib/auto-engine.js'
import {
  evaluateRecallGate, recallFlightKey, markRecallPending, noteRecallRefusal, RECALL_LOOP_LINE,
  defaultEstimateRecallTokens, buildRecallBreadcrumbDigest,
} from '../lib/recall-budget.js'
import {
  apply, executeRecall, publishPrefixClass, resolveCompactRuntimeConfig,
  planSpanCompaction, commitSpanCompaction, planResultCompaction, commitResultCompaction,
} from '../lib/index.js'
import { buildCheckpointIndex, parseEmbeddedStagesMinimal } from '../lib/topic-index.js'

const DSH_ROOT = process.env.DSH_ROOT
  ?? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const TEST_CWD = path.join(os.homedir(), 'workspace')
const { Context } = await import(pathToFileURL(path.join(DSH_ROOT, 'cordis', 'lib', 'index.js')).href)
const { default: SessionStore } = await import(pathToFileURL(path.join(DSH_ROOT, 'dsh-session', 'lib', 'index.js')).href)
const { TokenMeter } = await import(pathToFileURL(path.join(DSH_ROOT, 'dsh-token-meter', 'lib', 'index.js')).href)

const ALLOWED_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'items', 'required', 'additionalProperties', 'enum'])

function walkSchema(node, pathName, bad, anyOf) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${pathName}[${i}]`, bad, anyOf))
    return
  }
  const names = pathName === 'properties' || pathName.endsWith('.properties')
  for (const [key, value] of Object.entries(node)) {
    const next = pathName ? `${pathName}.${key}` : key
    if (names) { walkSchema(value, next, bad, anyOf); continue }
    if (key === 'anyOf') anyOf.push(pathName)
    else if (!ALLOWED_SCHEMA_KEYS.has(key)) bad.push(next)
    walkSchema(value, next, bad, anyOf)
  }
}

function createHarness(config) {
  const ctx = new Context()
  const registeredTools = new Map()
  ctx.provide('tools', { register(def) { registeredTools.set(def.name, def); return () => registeredTools.delete(def.name) } })
  ctx.provide('systemPrompt', { section() { return () => {} }, context() { return () => {} } })
  const sessions = new SessionStore(ctx)
  const tokenMeter = new TokenMeter(ctx)
  ctx.sessions = sessions
  ctx.tokenMeter = tokenMeter
  apply(ctx, { takeoverNativeCompaction: false, autoEngine: false, autoCoalesce: true, recallBudget: false, recallRollingDigest: true, topicIndexing: true, ...config })
  return { ctx, sessions, tokenMeter, registeredTools }
}

function surfaceToolText(session, callId) {
  const msg = session.deriveMessages().find((m) => m.source?.kind === 'tool' && m.source.callId === callId)
  return msg?.content?.[0]?.content?.[0]?.text ?? ''
}

function seed(session, turn = 1) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' })
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 100000 })
  }
  session.append('user/message', {
    id: `u-${turn}`, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: `turn ${turn} ${'payload '.repeat(300)}` }],
  }, { surfaceOp: 'append' })
}

function assistant(session, turn, step, id, content, sourceKind = 'model') {
  if (step > 1) {
    session.append('step/end', { turn, step: step - 1 })
    session.append('step/start', { turn, step })
  }
  const chunk = session.append('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: id } })
  return session.append('assistant/message', {
    turn, step,
    message: { id, role: 'assistant', source: { kind: sourceKind, provider: 'deepseek', model: 'deepseek-chat' }, content },
  }, { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] })
}

function toolPair(session, turn, step, callId, name, args, text) {
  const call = session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
  session.append('tool/result', {
    turn, step,
    message: {
      id: `tr-${callId}`, role: 'user', source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

const BIG = Array.from({ length: 900 }, (_, i) => `RECALL_LINE_${i} ${'Q'.repeat(48)}`).join('\n')

test('C-01 topicIndexing stays undefined under node:test and explicit values win', () => {
  assert.equal(process.env.NODE_TEST_CONTEXT != null, true)
  const defaults = resolveCompactRuntimeConfig({})
  assert.equal(defaults.topicIndexing, undefined)
  assert.equal(defaults.recallRollingDigest, undefined)
  assert.equal(resolveCompactRuntimeConfig({ topicIndexing: false }).topicIndexing, false)
  assert.equal(resolveCompactRuntimeConfig({ recallRollingDigest: true }).recallRollingDigest, true)
})

test('C-25 L1 topic union keeps the first three constituent topics', () => {
  const blocks = Array.from({ length: 8 }, (_, i) => ({
    text: `note ${i}\n[recall: @span:S${i + 1}-${i + 2}]`,
    recallTags: [`[recall: @span:S${i + 1}-${i + 2}]`],
    spanStart: i + 1,
    spanEnd: i + 2,
    tokens: 80,
    level: 'L0',
    seq: i + 1,
    topics: i % 2 === 0 ? ['gateway', 'pmw'] : ['recall-gate'],
  }))
  const once = coalesceSummaryBlocks(blocks)
  const l1 = once.blocks.find((b) => b.level === 'L1')
  assert.ok(l1)
  assert.deepEqual(l1.topics, ['gateway', 'pmw', 'recall-gate'])
  assert.equal(once.blocks.filter((b) => b.level !== 'L1').every((b) => b.level === 'L0' || b.level == null || b.level === 'L0'), true)
})

test('C-36/C-37 recall gate: raw, pending, folded allow, refetched digest, closed-turn raw', () => {
  const args = { target: '@span:S1-2' }
  const call = (seq, callId, turn) => ({ seq, type: 'tool/call', data: { name: 'context_recall', callId, turn, arguments: args } })
  const result = (seq, callId, text) => ({
    seq, type: 'tool/result',
    data: { message: { source: { callId }, content: [{ type: 'text', text }] } },
  })
  const session = {
    surface: { nodes: [] },
    events: [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      call(1, 'c1', 1),
    ],
    snapshotEvents() { return this.events },
  }
  assert.equal(evaluateRecallGate(session, args).state, 'fresh')
  markRecallPending(session, recallFlightKey(session, args))
  assert.equal(evaluateRecallGate(session, args).state, 'raw')
  session.events.push(result(2, 'c1', '[Compact-Recall-Digest target="x"]\nfolded'))
  session.surface.nodes.push(2)
  assert.equal(evaluateRecallGate(session, args).state, 'folded')
  assert.equal(evaluateRecallGate(session, args).pin, true)
  session.events.push(call(3, 'c2', 1), result(4, 'c2', '[Compact-Recall-Digest target="x"]\nagain'))
  const again = evaluateRecallGate(session, args)
  assert.equal(again.state, 'refetched')
  assert.match(again.text, /^\[Recall-Gate refetched\]/)
  assert.match(again.text, /narrow with `query` or `line_range`/)

  const closed = {
    surface: { nodes: [2] },
    events: [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      call(1, 'c1', 1),
      result(2, 'c1', 'STILL RAW'),
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 4, type: 'turn/start', data: { turn: 2 } },
    ],
    snapshotEvents() { return this.events },
  }
  assert.equal(evaluateRecallGate(closed, args).state, 'raw')
  const loopSession = { events: [{ seq: 0, type: 'turn/start', data: { turn: 3 } }], snapshotEvents() { return this.events } }
  assert.equal(noteRecallRefusal(loopSession), 1)
  assert.equal(noteRecallRefusal(loopSession), 2)
  assert.equal(noteRecallRefusal(loopSession), 3)
  assert.equal(noteRecallRefusal(loopSession), 4)
  assert.match(RECALL_LOOP_LINE, /^\[Recall-Gate DSH_E_RECALL_LOOP\]/)
})

test('C-03 tool schemas stay Gemini-safe and flag-invariant', () => {
  const a = createHarness({ topicIndexing: false, recallRollingDigest: false, topicRules: [{ topic: 'zzz', keywords: ['zzz'] }] })
  const b = createHarness({ topicIndexing: true, recallRollingDigest: true })
  for (const name of ['context_compact', 'context_recall']) {
    const left = a.registeredTools.get(name).parameters
    const right = b.registeredTools.get(name).parameters
    assert.deepEqual(left, right)
    const bad = []
    const anyOf = []
    walkSchema(left, '', bad, anyOf)
    assert.deepEqual(bad, [])
  }
  const compactAny = []
  walkSchema(a.registeredTools.get('context_compact').parameters, '', [], compactAny)
  assert.deepEqual(compactAny, ['properties.spans.items.properties.turns.items'])
  const recallAny = []
  walkSchema(a.registeredTools.get('context_recall').parameters, '', [], recallAny)
  assert.deepEqual(recallAny, [])
  assert.deepEqual(a.registeredTools.get('context_recall').parameters.properties.mode.enum, ['full', 'summaries_only'])
})

test('C-17 token budget reports only the lines it returned and the cursor covers each line once', async () => {
  const { sessions } = createHarness({ recallRollingDigest: false })
  const session = sessions.prepare('v5-page-budget', { meta: { cwd: TEST_CWD } })
  const lines = Array.from({ length: 24 }, (_, i) => `PAGE_${String(i + 1).padStart(2, '0')} ${'x'.repeat(40)}`)
  seed(session, 1)
  assistant(session, 1, 1, 'a-page', [{ type: 'tool-call', id: 'page_call', name: 'read', arguments: '{}' }])
  toolPair(session, 1, 1, 'page_call', 'read', {}, lines.join('\n'))
  const estimate = (text) => defaultEstimateRecallTokens(text)
  const full = executeRecall(session, { target: '@call:page_call' })
  const expected = full.text.split('\n').filter((line) => /^\d+:/.test(line)).map((line) => Number(line.split(':')[0]))
  assert.ok(expected.length >= lines.length)
  const seen = []
  let range
  let guard = 0
  do {
    const page = executeRecall(session, { target: '@call:page_call', ...(range ? { line_range: range } : {}) }, { maxTokens: 80, estimateTokens: estimate })
    const body = page.text.split('\n').filter((line) => /^\d+:/.test(line))
    assert.equal(body.length, page.returnedLines)
    assert.ok(page.returnedLines < expected.length)
    const header = /lines: (\d+)-(\d+) of (\d+)/.exec(page.text)
    assert.equal(Number(header[1]), Number(body[0].split(':')[0]))
    assert.equal(Number(header[2]), Number(body.at(-1).split(':')[0]))
    for (const line of body) seen.push(Number(line.split(':')[0]))
    range = page.hasMore ? page.nextLineRange : null
    guard += 1
  } while (range && guard < 40)
  assert.deepEqual(seen, expected)
})

test('C-20 a rewrite without a same-request publisher is stale on the next log growth', async () => {
  const { ctx, sessions } = createHarness()
  const stale = sessions.prepare('v5-pmw-stale', { meta: { cwd: TEST_CWD } })
  seed(stale, 1)
  publishPrefixClass(stale, 1, 'rewrite', Date.now())
  stale.append('user/message', {
    id: 'u-next', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'next request' }],
  }, { surfaceOp: 'append' })
  await ctx.waterfall('agent/before-request', { agent: { session: stale } }, () => {})
  assert.ok((autoCompactState(stale).pmwStaleSkips ?? 0) >= 1)

  const fresh = sessions.prepare('v5-pmw-fresh', { meta: { cwd: TEST_CWD } })
  seed(fresh, 1)
  publishPrefixClass(fresh, 1, 'rewrite', Date.now())
  const before = autoCompactState(fresh).pmwStaleSkips ?? 0
  await ctx.waterfall('agent/before-request', { agent: { session: fresh } }, () => {})
  assert.equal(autoCompactState(fresh).pmwStaleSkips ?? 0, before)
})

test('C-29/C-30 synthetic receipt does not fold, a trailing read pins, a tail recall folds once', async () => {
  const { ctx, sessions, tokenMeter } = createHarness()
  const pinned = sessions.prepare('v5-d0-pin', { meta: { cwd: TEST_CWD } })
  seed(pinned, 1)
  assistant(pinned, 1, 1, 'a-pin', [
    { type: 'tool-call', id: 'pin_recall', name: 'context_recall', arguments: JSON.stringify({ target: '@span:S1-2' }) },
    { type: 'tool-call', id: 'pin_read', name: 'read', arguments: '{}' },
  ])
  toolPair(pinned, 1, 1, 'pin_recall', 'context_recall', { target: '@span:S1-2' }, `PIN_MARKER\n${BIG}`)
  toolPair(pinned, 1, 1, 'pin_read', 'read', {}, 'read landed last')
  assistant(pinned, 1, 2, 'a-pin-next', [{ type: 'tool-call', id: 'pin_next', name: 'context_recall', arguments: JSON.stringify({ target: '@span:S3-4' }) }])
  const fire = (session) => ctx.waterfall('agent/pre-step', { agent: { session }, turn: 1, step: 3, signal: new AbortController().signal }, () => Promise.resolve())
  await fire(pinned)
  await fire(pinned)
  const pinnedText = surfaceToolText(pinned, 'pin_recall')
  assert.match(pinnedText, /PIN_MARKER/)
  assert.equal(pinnedText.includes('[Compact-Recall-Digest'), false)

  const unread = sessions.prepare('v5-synthetic-unread', { meta: { cwd: TEST_CWD } })
  seed(unread, 1)
  assistant(unread, 1, 1, 'a-unread', [{ type: 'tool-call', id: 'unread_recall', name: 'context_recall', arguments: JSON.stringify({ target: '@span:S1-2' }) }])
  toolPair(unread, 1, 1, 'unread_recall', 'context_recall', { target: '@span:S1-2' }, `UNREAD_MARKER\n${BIG}`)
  unread.append('step/end', { turn: 1, step: 1 })
  unread.append('step/start', { turn: 1, step: 2 })
  unread.append('assistant/message', {
    turn: 1,
    step: 2,
    source: { kind: 'synthetic-receipt' },
    message: { id: 'a-receipt', role: 'assistant', content: [{ type: 'text', text: 'receipt' }] },
  }, { surfaceOp: 'append' })
  assert.ok(tokenMeter.measure(unread).nodes.some((n) => n.tokens > 180))
  await fire(unread)
  const unreadText = surfaceToolText(unread, 'unread_recall')
  assert.match(unreadText, /UNREAD_MARKER/)
  assert.equal(unreadText.includes('[Compact-Recall-Digest'), false)

  const folded = sessions.prepare('v5-d0-fold', { meta: { cwd: TEST_CWD } })
  seed(folded, 1)
  assistant(folded, 1, 1, 'a-fold', [{ type: 'tool-call', id: 'fold_recall', name: 'context_recall', arguments: JSON.stringify({ target: '@span:S1-2' }) }])
  toolPair(folded, 1, 1, 'fold_recall', 'context_recall', { target: '@span:S1-2' }, `FOLD_MARKER\n${BIG}`)
  assistant(folded, 1, 2, 'a-fold-next', [{ type: 'tool-call', id: 'fold_next', name: 'context_recall', arguments: JSON.stringify({ target: '@span:S9-9' }) }])
  await fire(folded)
  await fire(folded)
  const foldedText = surfaceToolText(folded, 'fold_recall')
  assert.match(foldedText, /^\[Compact-Recall-Digest/)
  assert.equal(foldedText.includes('RECALL_LINE_400'), false)
})

test('C-09/C-14 sparse event logs index; partial embedded ranges never escape the hull', () => {
  const events = []
  events[2] = { seq: 2, type: 'user/message', surfaceOp: 'append', data: {} }
  events[3] = { seq: 3, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [0, 1, 2], data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '[Compact] body [recall: @span:S2-2 turns:1]' }] } }
  const session = { events, surface: { nodes: [3], replaceGeneration: 1 } }
  const index = buildCheckpointIndex(session)
  assert.equal(index.records.length, 2)
  assert.ok(index.records.every((r) => r.checkpointSeq === 3))
  assert.equal(parseEmbeddedStagesMinimal('[Compact turns:1] stage [recall: @span:S2-4]', new Set([2, 3, 4])).length, 1)
  assert.equal(parseEmbeddedStagesMinimal('[Compact turns:1] stage [recall: @span:S2-4]', new Set([2, 4])).length, 0)
  const secondEvents = [...events]
  const second = buildCheckpointIndex({ ...session, events: secondEvents, surface: { nodes: [], replaceGeneration: 1 } })
  assert.equal(second.records[0].active, false)
})

test('C-09 nested child survives parent walk once; raw remainder keeps the enclosing hull', () => {
  const cp = (seq, leaf, text) => ({ seq, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [0, 1, leaf], data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text }] } })
  const events = [
    { seq: 0, type: 'compaction/start', data: {} }, { seq: 1, type: 'compaction/summary', data: {} },
    { seq: 2, type: 'user/message', surfaceOp: 'append', data: {} },
    { seq: 3, type: 'user/message', surfaceOp: 'append', data: {} },
    cp(4, 2, '[Compact turns:1] child [recall: @span:S2-2 turns:1]'),
    { ...cp(5, 4, '[Compact turns:1..2] parent [recall: @span:S2-3 turns:1..2]'), sourceEventSeqs: [0, 1, 4, 3] },
  ]
  const index = buildCheckpointIndex({ events, surface: { nodes: [5], replaceGeneration: 1 } })
  const cps = index.records.filter((r) => r.level !== 'raw-rem')
  assert.deepEqual(cps.map((r) => [r.checkpointSeq, r.level]), [[4, 'L0'], [5, 'L1']])
  const raw = index.records.find((r) => r.level === 'raw-rem' && r.checkpointSeq === 5)
  assert.deepEqual(raw.leafSeqs, [3])
  assert.equal(raw.rawRecallTag, '@span:S2-3 turns:1..2')
})

test('C-02/C-21/C-28 legacy commits have no v5 metadata; live topics persist', () => {
  const { sessions, tokenMeter } = createHarness({ topicIndexing: false, recallRollingDigest: false })
  const session = sessions.prepare('v5-legacy-meta', { meta: { cwd: TEST_CWD } })
  seed(session, 1)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  seed(session, 2)
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const plan = planSpanCompaction(session, tokenMeter, { turns: [1, 2], summary: 'legacy body' }, 1, { topicIndexing: false })
  const committed = commitSpanCompaction(session, tokenMeter, plan, { topicIndexing: false })
  const summaryEvent = session.events[committed.summaryEventSeq]
  assert.equal(Object.hasOwn(summaryEvent.data, 'topics'), false)
  assert.equal(Object.hasOwn(summaryEvent.data, 'level'), false)
  assert.equal(Object.hasOwn(summaryEvent.data, 'subSpans'), false)
  assert.equal(summaryEvent.data.summary[0].text.includes('topics:'), false)

  const live = sessions.prepare('v5-live-meta', { meta: { cwd: TEST_CWD } })
  seed(live, 1)
  live.append('step/end', { turn: 1, step: 1 })
  live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  seed(live, 2)
  live.append('step/end', { turn: 2, step: 1 })
  live.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const livePlan = planSpanCompaction(live, tokenMeter, { turns: [1, 2], summary: 'topic body', topics: ['gateway'] }, 1, { topicIndexing: true })
  const liveCommit = commitSpanCompaction(live, tokenMeter, livePlan, { topicIndexing: true })
  assert.deepEqual(live.events[liveCommit.summaryEventSeq].data.topics, ['gateway'])
})

test('C-34 reload fallback parses page headers and rewrites nested recall tokens', () => {
  const raw = '[Recall @span:S7-9 | leaves: S7,S8,S9 | lines: 4-6 of 20]\n4: error [recall: @span:S1-2]'
  const digest = buildRecallBreadcrumbDigest(raw, { target: '@span:S7-9' }, {})
  assert.match(digest, /lines=4-6\/20/)
  assert.match(digest, /anchors: S7, S8, S9/)
  assert.equal(digest.includes('[recall:'), false)
  assert.match(digest, /\[rc:/)
})

test('C-17 an overlong line retains its truncation marker and never disappears', () => {
  const { sessions } = createHarness({ recallRollingDigest: false })
  const session = sessions.prepare('v5-long-line', { meta: { cwd: TEST_CWD } })
  seed(session, 1)
  assistant(session, 1, 1, 'a-long', [{ type: 'tool-call', id: 'long_call', name: 'read', arguments: '{}' }])
  toolPair(session, 1, 1, 'long_call', 'read', {}, 'X'.repeat(10000))
  const page = executeRecall(session, { target: '@call:long_call' }, { maxTokens: 1, estimateTokens: defaultEstimateRecallTokens })
  assert.equal(page.returnedLines, 1)
  assert.match(page.text, /line truncated, \d+ chars/)
  assert.equal(page.text.includes('10000:'), false)
  assert.ok(page.nextLineRange == null || page.nextLineRange[0] === 2)
})
