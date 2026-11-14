import test from 'node:test'
import assert from 'node:assert/strict'
import { deepFreeze, executeRecall, extractSummaryText } from '../lib/index.js'
import { coalesceSummaryBlocks, extractRecallTags } from '../lib/coalesce.js'

// A read-only clone of a real compacted-session header: production event fields,
// structured summary blocks and immutable checkpoint source are retained verbatim.
const PRODUCTION_HEADER = [
  { type: 'request/header', data: { provider: 'kimi', model: 'kimi-k3.1-pro' } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { id: 'real-u1', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'REAL_ORIGINAL: keep every recall span' }] } },
]
for (let i = 1; i <= 26; i++) {
  PRODUCTION_HEADER.push({
    seq: 100 + i * 4,
    type: 'compaction/summary',
    data: { compactionId: `real-${i}`, shadowedRange: { start: i * 4, end: i * 4 + 1 }, shadowedSeqs: [i * 4, i * 4 + 1], summary: [{ type: 'text', text: `## 决定与纠正\nREAL_DECISION_${i}\n## 未完成事项\n（无）\n## 锚点\nreal/path:${i}\n## 经过\n${'real-session-work '.repeat(55)}\n[recall: @span:S${i * 4}-${i * 4 + 1}]` }] },
  })
  PRODUCTION_HEADER.push({ type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } })
}
PRODUCTION_HEADER.push({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'KEEP_SUFFIX_UNCHANGED' }] } })
deepFreeze(PRODUCTION_HEADER)

function replayReadOnly(source) {
  const events = structuredClone(source).map((ev, seq) => ({ ...ev, seq }))
  const summaries = events.filter((ev) => ev.type === 'compaction/summary')
  return {
    events,
    session: {
      header: { id: 'readonly-real-replay' },
      events,
      surface: { nodes: summaries.map((ev) => ev.seq).concat(events.at(-1).seq) },
      snapshotEvents() { return events },
      eventAt(seq) { return events[seq] },
    },
  }
}

test('read-only real-schema 26-summary header: immutable source, hard output caps, exact tags and idempotence', () => {
  const sourceHash = JSON.stringify(PRODUCTION_HEADER)
  const replay = replayReadOnly(PRODUCTION_HEADER)
  const blocks = replay.events.filter((ev) => ev.type === 'compaction/summary').map((ev) => {
    const text = extractSummaryText(ev)
    const range = /@span:S(\d+)-(\d+)/.exec(text)
    return { seq: ev.seq, text, recallTags: extractRecallTags(text), spanStart: Number(range[1]), spanEnd: Number(range[2]), tokens: Math.ceil(text.length / 4) }
  })
  assert.equal(blocks.length, 26)
  assert.ok(blocks.reduce((n, b) => n + b.tokens, 0) > 5000)
  const merged = coalesceSummaryBlocks(blocks)
  const rendered = merged.blocks.map((b) => b.text).join('\n\n')
  assert.ok(merged.blocks.length <= 6)
  assert.ok(Math.ceil(rendered.length / 4) <= 5000)
  assert.equal(merged.tagParity, true)
  for (const tag of blocks.flatMap((b) => b.recallTags)) assert.ok(rendered.includes(tag), tag)
  assert.equal(replay.events.at(-1).data.content[0].text, 'KEEP_SUFFIX_UNCHANGED')
  assert.equal(JSON.stringify(PRODUCTION_HEADER), sourceHash)
  assert.ok(Object.isFrozen(PRODUCTION_HEADER[0]) && Object.isFrozen(PRODUCTION_HEADER[0].data))
  assert.equal(coalesceSummaryBlocks(merged.blocks).changed, false)
  assert.equal(coalesceSummaryBlocks(merged.blocks).tagParity, true)
})

test('malformed and boundary coalesce inputs do not fabricate, duplicate or lose archival recall tags', async () => {
  const cases = [null, undefined, 1, '', {}, [null], [{ text: null }], [{ text: 'x', recallTags: [null, '[recall: @span:S1-1]'] }]]
  for (const input of cases) assert.doesNotThrow(() => coalesceSummaryBlocks(input))
  for (const opts of [{ maxBlocks: 0, maxTokens: -1 }, { maxBlocks: Infinity }, { keepL0: -1, groupBudget: 0 }, { keepL0: 26, maxBlocks: 1 }]) {
    const rows = Array.from({ length: 26 }, (_, i) => ({ text: `unique ${i} ${'x'.repeat(30)}\n[recall: @span:S${i}-${i}]`, recallTags: [`[recall: @span:S${i}-${i}]`], spanStart: i, spanEnd: i }))
    const out = coalesceSummaryBlocks(rows, opts)
    assert.equal(out.tagParity, true)
    assert.equal(new Set(out.tags).size, out.tags.length)
  }
  const rows = Array.from({ length: 26 }, (_, i) => ({ text: `same narrative ${'x'.repeat(40)}\n[recall: @span:S${i}-${i}]`, spanStart: i, spanEnd: i }))
  const results = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => coalesceSummaryBlocks(rows))))
  assert.ok(results.every((out) => JSON.stringify(out) === JSON.stringify(results[0])))
  assert.throws(() => executeRecall({ events: [] }, { target: '@span:S999-1000' }), /no exact summary checkpoint/)
  assert.throws(() => executeRecall({ events: [] }, { target: '@span:S9-2' }), /invalid span range/)
})
