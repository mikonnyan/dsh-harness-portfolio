import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getGlobalRuntimeState, makeElideSource, compactCheckpointSource, makeReplaceSurfaceOp,
  rewriteToolResultMessage, toolResultBlocks, isProtectedSystemNode, hasSpillNotice,
  computeSurfaceCutSafety, toolPairingBalancedAfter, executeRecall, summaryFrontierIndex,
} from '../lib/index.js'

const v4 = (nodes = []) => ({ seq: 0, surface: { nodes }, eventAt: () => undefined, snapshotEvents: () => [] })
const event = (seq, type, data = {}, surfaceOp = 'append') => ({ seq, type, data, surfaceOp })
const assistant = (seq, turn, calls) => event(seq, 'assistant/message', { turn, message: { role: 'assistant', content: calls.map((id) => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })) } })
const result = (seq, turn, callId) => event(seq, 'tool/result', { turn, message: { role: 'tool', source: { kind: 'tool', callId }, content: [] } })
const user = (seq, turn, text) => event(seq, 'user/message', { turn, role: 'user', content: [{ type: 'text', text }] })
function defectSession(events) {
  return { surface: { nodes: events.filter(Boolean).map((e) => e.seq) }, events,
    snapshotEvents() { return this.events }, eventAt(seq) { return this.events[seq] } }
}

test('v4 adapters use producer-owned sources, seq keys and flat tool messages', () => {
  const s = v4()
  assert.deepEqual(makeElideSource(s, 'c1'), { kind: 'context-compact-elide', compactionId: 'c1' })
  assert.deepEqual(compactCheckpointSource('c1', undefined, s), { kind: 'compact-checkpoint', compactionId: 'c1' })
  assert.deepEqual(makeReplaceSurfaceOp(s, 10, 20), { op: 'replace', startSeq: 10, endSeq: 20 })
  const message = { id: 'r1', role: 'tool', source: { kind: 'tool', callId: 'x' }, content: [{ type: 'text', text: 'old' }], extra: 'same' }
  const rewritten = rewriteToolResultMessage(message, [{ type: 'text', text: 'new' }])
  assert.equal(rewritten.role, 'tool'); assert.equal(rewritten.extra, 'same')
  assert.equal(rewritten.content[0].text, 'new'); assert.equal(rewritten.toolCallId, message.toolCallId)
  assert.equal(toolResultBlocks(rewritten)[0].text, 'new')
  const v3Message = { ...message, role: 'user', content: [{ type: 'tool-result', content: [] }] }
  assert.equal(rewriteToolResultMessage(v3Message, []).content[0].type, 'tool-result')
})

test('latest non-empty system and node zero are protected; stale system is absorbable', () => {
  const events = [event(0, 'system/message', { content: [{ type: 'text', text: 'head' }] }),
    event(1, 'system/message', { content: [{ type: 'text', text: 'old' }] }),
    event(2, 'system/message', { content: [] }), event(3, 'system/message', { content: [{ type: 'text', text: 'latest' }] })]
  const s = defectSession(events)
  assert.equal(isProtectedSystemNode(s, 0), true)
  assert.equal(isProtectedSystemNode(s, 1), false)
  assert.equal(isProtectedSystemNode(s, 2), false)
  assert.equal(isProtectedSystemNode(s, 3), true)
})

test('closed dangling tool call only quarantines its own turn; following cuts recover', () => {
  const events = [assistant(0, 1, ['lost']), user(1, 1, 'tail'), assistant(2, 2, ['paired']), result(3, 2, 'paired')]
  const s = defectSession(events)
  const safety = computeSurfaceCutSafety(s, { openTurn: null, lastTurn: 2, eventTurnMap: new Map(events.map((e) => [e.seq, e.data.turn])) })
  assert.equal(safety.defects.length, 1)
  assert.equal(safety.defects[0].kind, 'dangling-call')
  assert.equal(safety.unsafe[1], 1)
  assert.equal(safety.unsafe[2], 0)
  assert.equal(toolPairingBalancedAfter(s, 1), true)
})

test('open-turn dangling call protects all subsequent cuts; orphan result does not poison later cuts', () => {
  const events = [result(0, 1, 'orphan'), assistant(1, 2, ['running']), assistant(2, 2, ['paired']), result(3, 2, 'paired')]
  const s = defectSession(events)
  const safety = computeSurfaceCutSafety(s, { openTurn: 2, lastTurn: 2, eventTurnMap: new Map([[0, 1], [1, 2], [2, 2], [3, 2]]) })
  assert.deepEqual(safety.defects.map((d) => d.kind), ['orphan-result'])
  assert.equal(safety.unsafe[1], 0)
  assert.equal(safety.unsafe[2], 1)
})

test('exact recall tags cannot prefix-match another span and no range-scan fallback leaks islands', () => {
  const cp = event(20, 'user/message', { role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'x' }, content: [{ type: 'text', text: '[recall: @span:S2-3+S6-7 turns:1,3]' }] }, { op: 'replace', startSeq: 2, endSeq: 2 })
  cp.sourceEventSeqs = [2, 6]
  const events = [user(0, 0, 'system'), user(1, 1, 'one'), user(2, 1, 'one result'), user(3, 2, 'ISLAND MUST NOT LEAK'), user(4, 2, 'island result'), user(5, 3, 'three'), user(6, 3, 'three result'), cp]
  const indexedEvents = Array.from({ length: 21 }, (_, seq) => events.find((ev) => ev.seq === seq))
  const s = defectSession(indexedEvents)
  const recall = executeRecall(s, { target: '@span:S2-3+S6-7 turns:1,3', context_lines: 0 })
  assert.deepEqual(recall.leafSeqs, [2, 6])
  assert.ok(!recall.text.includes('MUST NOT LEAK'))
  assert.throws(() => executeRecall(s, { target: '@span:S2-30' }), /no exact summary checkpoint/)
})

test('long span hull resolves only its exact checkpoint provenance, never retained islands', () => {
  const cp = event(20, 'user/message', { role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'hull' }, content: [{ type: 'text', text: '[recall: @span:S2-10 turns:1,3,4]' }] }, { op: 'replace', startSeq: 2, endSeq: 2 })
  cp.sourceEventSeqs = [2, 6, 8, 10]
  const events = [user(0, 0, 'system'), user(1, 1, 'one'), user(2, 1, 'one result'), user(3, 2, 'ISLAND MUST NOT LEAK'), user(4, 2, 'island result'), user(5, 3, 'three'), user(6, 3, 'three result'), user(7, 4, 'four'), user(8, 4, 'four result'), user(9, 5, 'five'), user(10, 5, 'five result'), cp]
  const indexedEvents = Array.from({ length: 21 }, (_, seq) => events.find((ev) => ev.seq === seq))
  const recall = executeRecall(defectSession(indexedEvents), { target: '@span:S2-10', context_lines: 0 })
  assert.deepEqual(recall.leafSeqs, [2, 6, 8, 10])
  assert.ok(!recall.text.includes('MUST NOT LEAK'))
})

test('global runtime schema survives module replacement without queue loss', () => {
  const registry = getGlobalRuntimeState()
  const session = {}
  const marker = { spans: [{ summary: 'keep' }], results: new Map([['call', { callId: 'call' }]]), dropped: [], watermarkLatch: { hint: 'same' } }
  registry.bySession.set(session, { v: 2, ...marker })
  assert.equal(registry.schema, 2)
  assert.equal(globalThis[Symbol.for('@dsh-external/dsh-context-compact.state')], registry)
  assert.equal(getGlobalRuntimeState().bySession.get(session).spans[0].summary, 'keep')
  assert.equal(summaryFrontierIndex(v4([])), 0)
})

test('spill notice filter only accepts persisted spill trailers', () => {
  assert.equal(hasSpillNotice('output\n\n(Omitted exactly 120 bytes. Full formatted result stored at: C:\\tmp\\x. Use read.)'), true)
  assert.equal(hasSpillNotice('ordinary output'), false)
  assert.equal(hasSpillNotice('Omitted exactly 120 bytes'), false)
})
