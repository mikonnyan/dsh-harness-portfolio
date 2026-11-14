import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planSpanCompaction, commitSpanCompaction, executeRecall, summaryFrontierIndex,
  extractSummaryText, inspectSessionLog, checkConcludeTurnEligibility,
  canConcludeAfterCompaction,
} from '../lib/index.js'
import { coalesceSummaryBlocks, extractRecallTags, dedupeBlocks } from '../lib/coalesce.js'
import { decideAutoCompact, observeRequestStats } from '../lib/auto-engine.js'
import { takeRecallSlot, capRecallText } from '../lib/recall-budget.js'

function replaySession() {
  const events = []
  const session = {
    header: { id: 'round2-real-schema-replay' },
    requestHeader() { return { config: { provider: 'deepseek', model: 'round2-replay' } } },
    eventAt(seq) { return events[seq] },
    snapshotEvents() { return events },
    events,
    surface: { nodes: [] },
    append(type, data, options = {}) {
      const seq = events.length
      const ev = { seq, type, data, ...options }
      events.push(ev)
      if (options.surfaceOp === 'append') session.surface.nodes.push(seq)
      else if (options.surfaceOp && typeof options.surfaceOp.startSeq === 'number') {
        const { startSeq, endSeq } = options.surfaceOp
        const start = session.surface.nodes.indexOf(startSeq)
        const end = session.surface.nodes.indexOf(endSeq)
        if (start < 0 || end < start) throw new Error(`bad replay replace ${startSeq}-${endSeq}`)
        session.surface.nodes.splice(start, end - start + 1, seq)
      }
      return ev
    },
  }
  return session
}

const meter = {
  estimateMessage(message) {
    return Math.ceil((message.content || []).map((b) => b.text || '').join('').length / 4)
  },
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => {
      const ev = session.events[seq]
      const text = ev.data?.content ?? ev.data?.message?.content ?? []
      return { seq, tokens: Math.ceil(text.map((b) => b.text || '').join('').length / 4), heuristicTokens: Math.ceil(text.map((b) => b.text || '').join('').length / 4) }
    })
    return { nodes, surfaceTokens: nodes.reduce((n, x) => n + x.tokens, 0), totalTokens: nodes.reduce((n, x) => n + x.tokens, 0) }
  },
}

function addTurn(session, n) {
  session.append('turn/start', { turn: n })
  session.append('user/message', { id: `u${n}`, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: `ORIGINAL_USER_${n}: 保持路径与召回锚点 ${n} ${'original-work-record-'.repeat(500)}` }] }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: n, step: 1, message: { id: `a${n}`, role: 'assistant', content: [{ type: 'text', text: `ORIGINAL_ASSISTANT_${n}: completed replay` }] } }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}

function checkpoints(session) {
  return session.surface.nodes.map((seq) => session.events[seq]).filter((ev) => ev?.data?.source?.kind === 'compact-checkpoint')
}

test('26 real-schema compaction headers: coalesce stays within 6 blocks / 5k and recall survives the merge', () => {
  const session = replaySession()
  for (let n = 1; n <= 26; n++) {
    addTurn(session, n)
    const plan = planSpanCompaction(session, meter, { from: `turn:${n}`, to: `turn:${n}`, summary: `阶段 ${n} 决定与锚点 ${'work-record-'.repeat(140)}` }, 1)
    commitSpanCompaction(session, meter, plan)
  }
  addTurn(session, 27)
  const suffix = session.surface.nodes.slice(summaryFrontierIndex(session))
  const before = checkpoints(session)
  assert.equal(before.length, 26)
  const beforeTokens = before.reduce((n, ev) => n + Math.ceil(extractSummaryText(ev).length / 4), 0)
  assert.ok(beforeTokens >= 12000 && beforeTokens <= 14000, `before=${beforeTokens}`)
  const originalTags = before.flatMap((ev) => extractRecallTags(extractSummaryText(ev)))
  assert.equal(new Set(originalTags).size, 26)
  const blocks = before.map((ev) => {
    const text = extractSummaryText(ev)
    const tag = /@span:S(\d+)-(\d+)/.exec(text)
    return { seq: ev.seq, text, tokens: Math.ceil(text.length / 4), recallTags: extractRecallTags(text), spanStart: Number(tag[1]), spanEnd: Number(tag[2]) }
  })
  const merged = coalesceSummaryBlocks(blocks)
  const summary = merged.blocks.map((b) => b.text).join('\n\n')
  const outputTokens = Math.ceil(summary.length / 4)
  assert.equal(merged.tagParity, true)
  for (const tag of originalTags) assert.ok(summary.includes(tag), tag)
  assert.ok(merged.blocks.length <= 6, `default produces ${merged.blocks.length}, want <=6`)
  assert.ok(outputTokens <= 5000, `default produces ${outputTokens}, want <=5000`)
  const plan = planSpanCompaction(session, meter, { from: 'turn:1', to: 'turn:26', summary, mergeSummaries: true }, 1)
  commitSpanCompaction(session, meter, plan)
  assert.deepEqual(session.surface.nodes.slice(summaryFrontierIndex(session)), suffix)
  assert.ok(checkpoints(session).length <= 6)
  for (const tag of originalTags) {
    const target = tag.match(/@span:[^\]]+/)[0]
    const recalled = executeRecall(session, { target, query: 'ORIGINAL_', context_lines: 0 })
    assert.ok(recalled.returnedLines > 0, `${target} must still resolve after coalescing`)
    assert.ok(!recalled.text.includes('no exact summary checkpoint'))
  }
  const twice = coalesceSummaryBlocks(merged.blocks)
  assert.equal(twice.changed, false)
  assert.equal(twice.tagParity, true)
  assert.deepEqual(twice.blocks.map((b) => b.text), merged.blocks.map((b) => b.text))
  assert.ok(inspectSessionLog(session).inFlightCalls.size === 0)
})

test('coalesce adversarial malformed values fail closed without losing valid recall tags', () => {
  for (const malformed of [null, undefined, 1, 'bad', {}, [null], [{ text: null }]]) {
    assert.doesNotThrow(() => coalesceSummaryBlocks(malformed))
    if (malformed?.[0] === null) assert.equal(coalesceSummaryBlocks(malformed).tagParity, true)
  }
  const tag = '[recall: @span:S7-9]'
  const rows = Array.from({ length: 26 }, (_, i) => ({ text: `unique-${i} ${'x'.repeat(30)}`, recallTags: i === 0 ? [tag] : [`[recall: @span:S${i + 10}-${i + 10}]`] }))
  const result = coalesceSummaryBlocks(rows, { maxBlocks: 0, maxTokens: -1, keepL0: -10, groupBudget: 0 })
  assert.equal(result.tagParity, true)
  assert.ok(result.blocks.map((b) => b.text).join('').includes(tag))
  assert.doesNotThrow(() => dedupeBlocks([{ text: 'x', spanStart: NaN, spanEnd: Infinity }, { text: 'x', spanStart: -1, spanEnd: -1 }]))
})

test('coalesce 100 concurrent calls are deterministic and preserve the original tag set', async () => {
  const rows = Array.from({ length: 26 }, (_, i) => ({ text: `unique-${i} ${'record '.repeat(100)}`, recallTags: [`[recall: @span:S${i}-${i}]`], spanStart: i, spanEnd: i }))
  const results = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => coalesceSummaryBlocks(rows))))
  const canonical = JSON.stringify(results[0])
  for (const result of results) assert.equal(JSON.stringify(result), canonical)
  assert.deepEqual(rows.map((r) => r.text), Array.from({ length: 26 }, (_, i) => `unique-${i} ${'record '.repeat(100)}`))
})

test('recall boundary errors are explicit and capped output includes its marker', () => {
  const session = replaySession()
  for (const target of ['@span:S9-2', '@span:S999-1000', 'nonsense']) assert.throws(() => executeRecall(session, { target }))
  const capped = capRecallText('界'.repeat(9000), 1)
  assert.ok(Math.ceil(capped.text.length / 4) <= 1, `tiny budget must include the marker, got ${Math.ceil(capped.text.length / 4)} tok`)
  const weak = { header: { id: 'weak' }, events: [] }
  assert.equal(takeRecallSlot(weak, {}).ok, true)
  assert.equal(takeRecallSlot(weak, {}).duplicate, true)
})

test('100 rapid conclude and cost-model calls never conclude on failed compaction', async () => {
  const session = replaySession()
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'self', name: 'context_compact' }] } }, { surfaceOp: 'append' })
  const exec = { callId: 'self', agent: { phase: { kind: 'running', turn: 1, step: 1 } } }
  const eligible = checkConcludeTurnEligibility(session, exec, 'self')
  assert.equal(eligible.canConclude, true)
  await Promise.all(Array.from({ length: 100 }, (_, i) => Promise.resolve().then(() => {
    assert.equal(canConcludeAfterCompaction({ committedSpans: [], committedResults: [], errors: i % 2 ? ['boom'] : [] }, eligible), i % 2 === 0)
    assert.doesNotThrow(() => decideAutoCompact({ D: NaN, R: Infinity, N: -1, c: -1, rho: 2, cacheExpiryMs: 0 }))
  })))
})

test('request statistics reject malformed events and bound EWMA inputs', () => {
  assert.doesNotThrow(() => observeRequestStats([null, {}, { type: 'request/header', data: null }, { type: 'request/header', data: { turn: NaN }, ts: Infinity }]))
  const stats = observeRequestStats(Array.from({ length: 1000 }, (_, i) => ({ type: 'request/header', ts: i, data: { turn: i } })))
  assert.ok(stats.gapsMs.length <= 10)
})
