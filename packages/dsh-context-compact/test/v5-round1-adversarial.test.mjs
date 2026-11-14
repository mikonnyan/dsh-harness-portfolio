import test from 'node:test'
import assert from 'node:assert/strict'
import { breakEvenD, decideAutoCompact } from '../lib/auto-engine.js'
import { coalesceSummaryBlocks, dedupeBlocks, unionTags } from '../lib/coalesce.js'
import { collectSalience } from '../lib/salience.js'
import { takeRecallSlot, capRecallText, evictRecallBlock } from '../lib/recall-budget.js'
import { buildAutoSpanDigest, checkConcludeTurnEligibility, canConcludeAfterCompaction, buildCompactionProjection, extractSummaryText, extractEventText, isAlreadyCompactedSpanError, landSyntheticReceipt } from '../lib/index.js'

const text = (s) => [{ type: 'text', text: s }]
const ev = (type, body, extra = {}) => ({ type, data: body, ...extra })
const user = (s) => ev('user/message', { content: text(s) })
const assistant = (s, calls = []) => ev('assistant/message', { turn: 1, step: 1, message: { content: [...text(s), ...calls] } })
const successfulOutcome = { committedSpans: [], committedResults: [], errors: [] }

test('I-A/D*: all four specification values', () => {
  for (const [N, expected] of [[3, 30000], [6, 13700], [10, 8000], [20, 3900]]) assert.ok(Math.abs(breakEvenD(8000, N) - expected) < 100, `${N}: ${breakEvenD(8000, N)}`)
})

test('I-A: cold, hot, cliff and hysteresis/interval decision edges', () => {
  assert.equal(decideAutoCompact({ D: 1000, cold: true, minSavings: 300 }).rule, 'A')
  assert.equal(decideAutoCompact({ D: 200, cold: true, minSavings: 300 }).compact, false)
  const threshold = breakEvenD(8000, 20)
  assert.equal(decideAutoCompact({ D: threshold, R: 8000, N: 20 }).compact, false)
  assert.equal(decideAutoCompact({ D: threshold * 1.16, R: 8000, N: 20 }).rule, 'B')
  assert.equal(decideAutoCompact({ D: 0, surfaceTokens: 180000 }).rule, 'C')
  assert.equal(decideAutoCompact({ D: 1e6, N: 1, cold: false }).compact, false)
})

test('I-C2: successful conclude is permitted only with text and completed siblings', () => {
  const s = { events: [ev('step/start', {}), assistant('done', [{ type: 'tool-call', id: 'self', name: 'context_compact' }])] }
  const exec = { callId: 'self', agent: { phase: { kind: 'running', turn: 1, step: 1 } } }
  assert.equal(canConcludeAfterCompaction(successfulOutcome, checkConcludeTurnEligibility(s, exec, 'self')), true)
  assert.equal(canConcludeAfterCompaction({ ...successfulOutcome, errors: ['commit failed'] }, checkConcludeTurnEligibility(s, exec, 'self')), false)
})

test('I-C2: sibling tool error cannot conclude', () => {
  const s = { events: [ev('step/start', {}), assistant('done', [{ type: 'tool-call', id: 'self', name: 'context_compact' }, { type: 'tool-call', id: 'sib', name: 'relay_dispatch' }]), ev('tool/result', { isError: true, message: { source: { callId: 'sib' }, toolName: 'relay_dispatch', content: text('failed') } })] }
  assert.equal(checkConcludeTurnEligibility(s, { callId: 'self' }, 'self', ['relay_dispatch']).canConclude, false)
})

test('synthetic receipt does not mutate a frozen events array', () => {
  const events = Object.freeze([])
  landSyntheticReceipt({ events }, '已压缩上下文。')
  assert.equal(events.length, 0)
})

test('C2: empty assistant text gets a deterministic synthetic receipt and concludes', () => {
  const s = { events: [ev('step/start', {}), assistant('', [{ type: 'tool-call', id: 'self', name: 'context_compact' }])] }
  const eligibility = checkConcludeTurnEligibility(s, { callId: 'self' }, 'self')
  assert.equal(eligibility.canConclude, true, 'C2 requires receipt rather than Step 2')
  assert.ok(eligibility.receipt?.length > 0)
})

test('I-C3/projection: payload is rounded, calibrated and ordered', () => {
  assert.deepEqual(buildCompactionProjection(123.6, 1.25, 42), { surfaceTokens: 124, basis: 'heuristic', calibration: 1.25, atSeq: 42 })
})

test('I-S: exact duplicate removal keeps 100% recall tag union', () => {
  const tags = ['[recall: @span:S1-2]', '[recall: @span:S3-4]']
  const r = coalesceSummaryBlocks(Array.from({ length: 26 }, (_, i) => ({ text: i < 2 ? '<compacted-summary>same</compacted-summary>' : `<compacted-summary>story ${i}</compacted-summary>`, recallTags: i < 2 ? [tags[i]] : [`[recall: @span:S${i + 3}-${i + 3}]`], spanStart: i, spanEnd: i })))
  assert.equal(r.tagParity, true)
  for (const tag of tags) assert.ok(r.tags.includes(tag))
})

test('I-S5: decisions and todos survive coalescing; narrative truncation is bounded', () => {
  const blocks = Array.from({ length: 8 }, (_, i) => ({ text: `<compacted-summary>\n## 决定与纠正\n不要改配置 ${i}\n## 未完成事项\n待办 ${i}\n## 经过\n${'x'.repeat(2000)}\n[recall: @span:S${i}-${i}]\n</compacted-summary>`, spanStart: i, spanEnd: i }))
  const r = coalesceSummaryBlocks(blocks)
  const body = r.blocks.map((b) => b.text).join('\n')
  for (let i = 0; i < 6; i++) { assert.ok(body.includes(`不要改配置 ${i}`)); assert.ok(body.includes(`待办 ${i}`)) }
})

test('I-S3: coalescing is idempotent including already merged over-threshold heads', () => {
  const blocks = Array.from({ length: 8 }, (_, i) => ({ text: `<compacted-summary>story ${i} ${'x'.repeat(100)}</compacted-summary>`, spanStart: i, spanEnd: i, recallTags: [`[recall: @span:S${i}-${i}]`] }))
  const once = coalesceSummaryBlocks(blocks)
  const twice = coalesceSummaryBlocks(once.blocks)
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.blocks, once.blocks)
})

test('I-S4: real summary events retain original recall tags for post-coalesce recall', () => {
  const summary = '<compacted-summary>decision</compacted-summary>'
  const event = ev('compaction/summary', { summary: [{ type: 'text', text: `${summary}\n[recall: @span:S12-19]` }] })
  const extracted = extractSummaryText(event)
  assert.ok(extracted.includes('[recall:'), 'perhapsCoalesceSummaries must read the actual summary payload and recall tags')
})

test('I-S2: coalescing registers each generated L1 as a recallable span', () => {
  const r = coalesceSummaryBlocks(Array.from({ length: 8 }, (_, i) => ({ text: `block ${i}`, recallTags: [`[recall: @span:S${i}-${i}]`], spanStart: i, spanEnd: i })))
  assert.ok(r.blocks.filter((b) => b.level === 'L1').every((b) => typeof b.recallTag === 'string' && b.recallTag.startsWith('[recall:')))
})

test('I-R1: every user correction and negation is retained verbatim', () => {
  const input = [user('不要重启'), user('这不是正确路径'), user('请改用绝对路径'), user('这个方案 wrong，需要修正'), user('don\'t restart')]
  const got = collectSalience(input).corrections
  for (const expected of ['不要重启', '这不是正确路径', '请改用绝对路径', '这个方案 wrong，需要修正', "don't restart"]) assert.ok(got.includes(expected), expected)
})

test('I-R2: latest structured todo_write open items are included', () => {
  const input = [ev('tool/call', { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'write adversarial tests', status: 'in_progress' }, { content: 'read spec', status: 'completed' }] }) })]
  const got = collectSalience(input).openItems
  assert.ok(got.includes('write adversarial tests'))
  assert.ok(!got.includes('read spec'))
})

test('I-R1 integration: @auto output preserves corrections verbatim, not only 80-char asks', () => {
  const correction = '不要改成相对路径，必须保持当前实现不变'
  const events = [user(correction), assistant('下一步验证')]
  const session = { events }
  const info = { eventTurnMap: new Map([[0, 1], [1, 1]]) }
  const output = buildAutoSpanDigest(session, info, [0, 1], 500)
  assert.ok(output.includes(correction))
  assert.ok(output.includes('## 决定与纠正'))
})

test('I-R4: main recall <=2 calls, duplicate suppression, delegated 4 calls, 2000 token cap', () => {
  const s = { header: { id: 'main' }, events: [ev('turn/start', { turn: 1 })] }
  assert.equal(takeRecallSlot(s, { target: '@span:S1-2' }).ok, true)
  assert.equal(takeRecallSlot(s, { target: '@span:S1-2' }).duplicate, true)
  assert.equal(takeRecallSlot(s, { target: '@span:S3-4' }).ok, true)
  assert.equal(takeRecallSlot(s, { target: '@span:S5-6' }).code, 'DSH_E_RECALL_BUDGET')
  const child = { header: { id: 'child', parentSession: 'main' }, events: [ev('turn/start', { turn: 1 })] }
  for (let i = 0; i < 4; i++) assert.equal(takeRecallSlot(child, { target: `@span:S${i}-${i}` }).ok, true)
  assert.equal(takeRecallSlot(child, { target: '@span:S9-9' }).code, 'DSH_E_RECALL_BUDGET')
  const capped = capRecallText('x'.repeat(8001), 2000)
  assert.equal(capped.truncated, true)
  assert.ok(Math.ceil(capped.text.length / 4) <= 2000, 'cap must include truncation marker within hard token budget')
})

test('R2: an already-compacted span error is a no-op, other planner errors are not', () => {
  assert.equal(isAlreadyCompactedSpanError(new Error('span [turn:1..turn:1] starts on an immutable <compacted-summary> checkpoint and no uncompacted closed turn remains before "turn:1"')), true)
  assert.equal(isAlreadyCompactedSpanError(new Error('span summary must be a non-empty string')), false)
})

test('I-R3: PMW stub keeps the original recall text for a later recall', () => {
  const block = { type: 'text', text: 'ORIGINAL BODY line' }
  assert.equal(evictRecallBlock(block, '[recall evicted: @span:S1-2 → 再次 recall 可取回]'), true)
  assert.ok(block.text.startsWith('[recall evicted:'))
  const ev = { seq: 4, type: 'tool/result', data: { turn: 1, message: { source: { callId: 'c' }, content: [block] } } }
  assert.ok(extractEventText(ev).includes('ORIGINAL BODY line'))
  assert.equal(evictRecallBlock(block, 'again'), false)
})

test('R7: a trailing assistant chunk is not treated as an empty final reply', () => {
  const s = { events: [
    ev('step/start', {}),
    assistant('', [{ type: 'tool-call', id: 'self', name: 'context_compact' }]),
    ev('assistant/chunk', { chunk: { type: 'text-delta', text: 'still writing' } }),
  ] }
  const eligibility = checkConcludeTurnEligibility(s, { callId: 'self' }, 'self')
  assert.equal(eligibility.canConclude, false)
  assert.equal(eligibility.reason, 'output-in-progress')
})
