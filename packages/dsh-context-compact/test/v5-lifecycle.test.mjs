import test from 'node:test'
import assert from 'node:assert/strict'
import { breakEvenD, decideAutoCompact } from '../lib/auto-engine.js'
import { coalesceSummaryBlocks, dedupeBlocks } from '../lib/coalesce.js'
import { buildAutoSpanDigest, buildCompactionProjection } from '../lib/index.js'
import { takeRecallSlot, capRecallText } from '../lib/recall-budget.js'

test('break-even table and hysteresis rules', () => {
  const R = 8000
  assert.ok(Math.abs(breakEvenD(R, 3) - 30000) < 50)
  assert.ok(Math.abs(breakEvenD(R, 6) - 13714) < 80)
  assert.ok(Math.abs(breakEvenD(R, 10) - 8000) < 80)
  assert.ok(Math.abs(breakEvenD(R, 20) - 3900) < 80)
  const cold = decideAutoCompact({ D: 1000, R, idleMs: 300_000, lastModelActivityMs: 1, cold: true, surfaceTokens: 1000, minSavings: 300 })
  assert.equal(cold.rule, 'A')
  const hot = decideAutoCompact({ D: 1000, R, N: 3, idleMs: 0, lastModelActivityMs: 1, surfaceTokens: 1000 })
  assert.equal(hot.compact, false)
  const cliff = decideAutoCompact({ D: 1, R, surfaceTokens: 180_000, tierCliffTokens: 180_000 })
  assert.equal(cliff.rule, 'C')
})

test('summary coalesce keeps every recall tag and is idempotent under the cap', () => {
  const blocks = Array.from({ length: 8 }, (_, i) => ({
    text: `note ${i}\n[recall: @span:S${i + 1}-${i + 2}]`,
    recallTags: [`[recall: @span:S${i + 1}-${i + 2}]`],
    spanStart: i + 1,
    spanEnd: i + 2,
    tokens: 80,
    level: 'L0',
  }))
  const once = coalesceSummaryBlocks(blocks)
  assert.equal(once.changed, true)
  assert.equal(once.tagParity, true)
  assert.ok(once.blocks.length <= 6)
  const twice = coalesceSummaryBlocks(once.blocks)
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.blocks.map((b) => b.text), once.blocks.map((b) => b.text))
  const dup = dedupeBlocks([
    { text: 'same body', recallTags: ['[recall: @span:S1-2]'], spanStart: 1, spanEnd: 2 },
    { text: 'same body', recallTags: ['[recall: @span:S3-4]'], spanStart: 3, spanEnd: 4 },
  ])
  assert.equal(dup.length, 1)
  assert.deepEqual(dup[0].recallTags, ['[recall: @span:S1-2]', '[recall: @span:S3-4]'])
})

test('@auto keeps a user correction verbatim and recall budget stops the third call', () => {
  const events = [{ seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '不要用 npm，改成 pnpm' }] } }]
  const session = { events, surface: { nodes: [0] } }
  const digest = buildAutoSpanDigest(session, { eventTurnMap: new Map([[0, 1]]) }, [0])
  assert.ok(digest.includes('不要用 npm，改成 pnpm'))
  const recallSession = { header: { id: 'recall' }, events: [{ type: 'turn/start', data: { turn: 1 } }] }
  assert.equal(takeRecallSlot(recallSession, { target: '@span:S1-2' }).ok, true)
  assert.equal(takeRecallSlot(recallSession, { target: '@span:S1-2' }).duplicate, true)
  assert.equal(takeRecallSlot(recallSession, { target: '@span:S3-4' }).ok, true)
  assert.equal(takeRecallSlot(recallSession, { target: '@span:S5-6' }).code, 'DSH_E_RECALL_BUDGET')
  const delegated = { header: { delegationDepth: 1 }, events: [{ type: 'turn/start', data: { turn: 2 } }] }
  for (let i = 0; i < 4; i++) assert.equal(takeRecallSlot(delegated, { target: `@span:S${i}` }).ok, true)
  assert.equal(capRecallText('x'.repeat(9000), 2000).truncated, true)
  const projection = buildCompactionProjection(31900, 1.1, 40)
  assert.equal(projection.basis, 'heuristic')
  assert.equal(projection.atSeq, 40)
  assert.equal(Math.round(projection.surfaceTokens * projection.calibration), 35090)
})
