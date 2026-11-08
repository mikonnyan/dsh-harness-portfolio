import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  apply,
  buildLargeBlocksDirectory,
  buildInspectReport,
  checkConcludeTurnEligibility,
  classifySpanOverlap,
  getStagedQueueSnapshot,
  isResultAlreadyCompacted,
  isSameSpanTarget,
  isSpanAlreadyCompacted,
  planResultCompaction,
  commitResultCompaction,
  planSpanCompaction,
  commitSpanCompaction,
  executeRecall,
  isHighContextOccupancy,
  resolveLeafSurfaceSeqs,
  toolPairingBalancedBefore,
  toolPairingBalancedAfter,
} from '../lib/index.js'

const DSH_ROOT = process.env.DSH_ROOT
  ?? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const TEST_CWD = path.join(os.homedir(), 'workspace')

const { Context } = await import(pathToFileURL(path.join(DSH_ROOT, 'cordis', 'lib', 'index.js')).href)
const { default: SessionStore } = await import(pathToFileURL(path.join(DSH_ROOT, 'dsh-session', 'lib', 'index.js')).href)
const { TokenMeter } = await import(pathToFileURL(path.join(DSH_ROOT, 'dsh-token-meter', 'lib', 'index.js')).href)

/** Create a lightweight test harness using real Cordis Context, DSH SessionStore, and TokenMeter */
async function createTestHarness() {
  const ctx = new Context()
  const registeredTools = new Map()
  const promptSections = new Map()
  const promptContexts = new Map()

  ctx.provide('tools', {
    register(def) {
      registeredTools.set(def.name, def)
      return () => registeredTools.delete(def.name)
    },
  })
  ctx.provide('systemPrompt', {
    section(sec) {
      promptSections.set(sec.name, sec)
      return () => promptSections.delete(sec.name)
    },
  context(ctxDef) {
      promptContexts.set(ctxDef.name, ctxDef)
      return () => promptContexts.delete(ctxDef.name)
    },
  })

  const sessions = new SessionStore(ctx)
  const tokenMeter = new TokenMeter(ctx)
  ctx.sessions = sessions
  ctx.tokenMeter = tokenMeter

  apply(ctx)

  async function emitTurnStopping(agent, turn, signal) {
    await ctx.serial('agent/turn-stopping', { agent, turn, signal })
  }

  return {
    ctx,
    sessions: ctx.sessions,
    tokenMeter: ctx.tokenMeter,
    registeredTools,
    promptSections,
    promptContexts,
    emitTurnStopping,
  }
}

function addCompleteTurnWithTool(session, turn, callId, toolName, resultText, userText = `User prompt for turn ${turn}`) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', {
      header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 100000,
    })
  }
  session.append('user/message', {
    id: `u-${turn}`,
    role: 'user',
    source: { kind: 'human' },
    content: [{ type: 'text', text: userText }],
  }, { surfaceOp: 'append' })

  const c1 = session.append('assistant/chunk', {
    turn,
    step: 1,
    chunk: { type: 'tool-call-delta', index: 0, id: callId, name: toolName, argumentsDelta: '{}' },
  })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: `a-${turn}-1`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c1.seq] })

  const tc = session.append('tool/call', {
    turn,
    step: 1,
    callId,
    name: toolName,
    arguments: '{}',
  })
  const tr = session.append('tool/result', {
    turn,
    step: 1,
    message: {
      id: `tr-${turn}`,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: false,
        content: [{ type: 'text', text: resultText }],
      }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc.seq] })
  session.append('step/end', { turn, step: 1 })

  session.append('step/start', { turn, step: 2 })
  const c2 = session.append('assistant/chunk', {
    turn,
    step: 2,
    chunk: { type: 'text-delta', index: 0, text: `Turn ${turn} response.` },
  })
  session.append('assistant/message', {
    turn,
    step: 2,
    message: {
      id: `a-${turn}-2`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'text', text: `Turn ${turn} response.` }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c2.seq] })
  session.append('step/end', { turn, step: 2 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return tr.seq
}

test('single tool/result compaction + shadow pricing + reload consistency', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-res-1', { meta: { cwd: TEST_CWD } })

  const bigOutput = Array.from({ length: 140 }, (_, i) => `Line ${i + 1}: important value_${i + 1} ${'X'.repeat(30)}`).join('\n')
  addCompleteTurnWithTool(session, 1, 'call_1', 'read', bigOutput)

  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })

  const beforeTokens = tokenMeter.measure(session).surfaceTokens
  const plan = planResultCompaction(session, tokenMeter, {
    callId: 'call_1',
    summary: 'Read 140 lines of config; key anchor value_42.',
  })
  assert.ok(plan.savings >= 300)
  const committed = commitResultCompaction(session, tokenMeter, plan)
  const afterTokens = tokenMeter.measure(session).surfaceTokens

  assert.equal(beforeTokens - afterTokens, committed.savings)
  assert.ok(session.deriveMessages().some((m) =>
    m.source?.kind === 'tool' &&
    m.content[0].content[0].text.includes('[Compact] Read 140 lines of config; key anchor value_42. [recall: @call:call_1]')
  ))

  const page1 = executeRecall(session, { target: '@call:call_1' })
  assert.equal(page1.returnedLines, 120)
  assert.equal(page1.hasMore, true)
  assert.ok(page1.text.includes('value_1 '))

  const page2 = executeRecall(session, { target: '@call:call_1', line_range: [121, 200] })
  assert.equal(page2.hasMore, false)
  assert.ok(page2.text.includes('value_140 '))
})

test('spans compaction + nested compaction + recall + persistence restore', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-span-1', { meta: { cwd: TEST_CWD } })

  const out1 = Array.from({ length: 80 }, (_, i) => `T1_L${i + 1}: alpha_anchor_${i + 1} ${'A'.repeat(30)}`).join('\n')
  const out2 = Array.from({ length: 80 }, (_, i) => `T2_L${i + 1}: beta_anchor_${i + 1} ${'B'.repeat(30)}`).join('\n')
  const out3 = Array.from({ length: 80 }, (_, i) => `T3_L${i + 1}: gamma_anchor_${i + 1} ${'C'.repeat(30)}`).join('\n')

  addCompleteTurnWithTool(session, 1, 'call_t1', 'read', out1)
  addCompleteTurnWithTool(session, 2, 'call_t2', 'grep', out2)
  addCompleteTurnWithTool(session, 3, 'call_t3', 'read', out3)

  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })

  const dirLine = buildLargeBlocksDirectory(session, tokenMeter)
  assert.ok(dirLine.includes('call_t1(read,T1,'))
  assert.ok(dirLine.includes('call_t2(grep,T2,'))
  assert.ok(dirLine.includes('call_t3(read,T3,'))

  const compactTool = registeredTools.get('context_compact')
  const ctrl = new AbortController()
  const fakeAgent = { id: 'agent-1', session }

  const tokensBefore = tokenMeter.measure(session).surfaceTokens
  const stagedOut = await compactTool.execute({
    spans: [{ from: 'turn:1', to: 'turn:1', summary: 'T1 summary: alpha_anchor_10 verified.' }],
    results: [
      { callId: 'call_t1', summary: 'Should be skipped as covered by turn:1 span' },
      { callId: 'call_t3', summary: 'T3 result summary: gamma_anchor_20.' },
    ],
  }, {
    callId: 'call_compact_4',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {},
  })

  assert.ok(stagedOut.text.includes('staged for turn-stopping'))
  assert.ok(stagedOut.text.includes('dropped covered results: call_t1'))
  assert.equal(tokenMeter.measure(session).surfaceTokens, tokensBefore)

  session.append('step/end', { turn: 4, step: 1 })
  await emitTurnStopping(fakeAgent, 4, ctrl.signal)
  const tokensAfterTurn4 = tokenMeter.measure(session).surfaceTokens
  assert.ok(tokensAfterTurn4 < tokensBefore)
  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

  session.append('turn/start', { turn: 5 })
  session.append('step/start', { turn: 5, step: 1 })
  const c5 = session.append('assistant/chunk', {
    turn: 5,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'Final report ready.' },
  })
  session.append('assistant/message', {
    turn: 5,
    step: 1,
    message: {
      id: 'a-5-1',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [
        { type: 'text', text: 'Final report ready.' },
        { type: 'tool-call', id: 'call_compact_5', name: 'context_compact', arguments: '{}' },
      ],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c5.seq] })
  const tc5 = session.append('tool/call', {
    turn: 5,
    step: 1,
    callId: 'call_compact_5',
    name: 'context_compact',
    arguments: '{}',
  })
  let turnConcluded = false
  const nestedOut = await compactTool.execute({
    spans: [{ from: 'turn:1', to: 'turnsBack:2', summary: 'Combined T1-T3 checkpoint.' }],
    conclude_turn: true,
  }, {
    callId: 'call_compact_5',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {
      turnConcluded = true
    },
  })

  assert.equal(turnConcluded, true)
  assert.ok(nestedOut.text.includes('Compact committed immediately'))
  assert.ok(nestedOut.text.includes('turn concluded'))
  session.append('tool/result', {
    turn: 5,
    step: 1,
    message: {
      id: 'tr-5-1',
      role: 'user',
      source: { kind: 'tool', callId: 'call_compact_5' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call_compact_5',
        isError: false,
        content: [{ type: 'text', text: nestedOut.text }],
      }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc5.seq] })
  session.append('step/end', { turn: 5, step: 1 })
  session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })

  const r1 = executeRecall(session, { target: '@call:call_t1', query: 'alpha_anchor_10', context_lines: 0 })
  assert.ok(r1.text.includes('alpha_anchor_10'))

  const r2 = executeRecall(session, { target: '@turn:2', query: 'beta_anchor_55', context_lines: 1 })
  assert.ok(r2.text.includes('beta_anchor_55'))

  const spanTagMatch = /\[recall:\s*(@span:S\d+-\d+)\]/.exec(nestedOut.text)
  assert.ok(spanTagMatch)
  const rSpan = executeRecall(session, { target: spanTagMatch[1], query: 'gamma_anchor_70', context_lines: 0 })
  assert.ok(rSpan.text.includes('gamma_anchor_70'))

  const restored = sessions.prepare(session.id, {
    seed: structuredClone(session.events),
    meta: structuredClone(session.header),
    seedSource: 'persistence',
  })
  assert.deepEqual(restored.surface.nodes, session.surface.nodes)
  assert.equal(tokenMeter.measure(restored).surfaceTokens, tokenMeter.measure(session).surfaceTokens)
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
})

test('conclude_turn guard: with text -> concludes; without text -> commits without concluding; with other tools in same step -> commits without concluding', async () => {
  const { sessions, tokenMeter, registeredTools } = await createTestHarness()
  const session = sessions.prepare('test-conclude-guard', { meta: { cwd: TEST_CWD } })
  const compactTool = registeredTools.get('context_compact')
  const ctrl = new AbortController()
  const fakeAgent = { id: 'agent-guard', session }

  const out1 = Array.from({ length: 90 }, (_, i) => `G1_L${i + 1}: anchor_one_${i + 1} ${'X'.repeat(30)}`).join('\n')
  const out2 = Array.from({ length: 90 }, (_, i) => `G2_L${i + 1}: anchor_two_${i + 1} ${'Y'.repeat(30)}`).join('\n')
  const out3 = Array.from({ length: 90 }, (_, i) => `G3_L${i + 1}: anchor_three_${i + 1} ${'Z'.repeat(30)}`).join('\n')

  addCompleteTurnWithTool(session, 1, 'call_g1', 'read', out1)
  addCompleteTurnWithTool(session, 2, 'call_g2', 'read', out2)
  addCompleteTurnWithTool(session, 3, 'call_g3', 'read', out3)

  // Turn 4, Step 1: NO text block (only reasoning + tool-call) -> must commit immediately, NOT conclude turn
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })
  const c4_1 = session.append('assistant/chunk', {
    turn: 4,
    step: 1,
    chunk: { type: 'reasoning-delta', index: 0, text: 'Thinking only, no user-visible reply text yet.' },
  })
  session.append('assistant/message', {
    turn: 4,
    step: 1,
    message: {
      id: 'a-4-1',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [
        { type: 'reasoning', text: 'Thinking only, no user-visible reply text yet.' },
        { type: 'tool-call', id: 'call_compact_no_text', name: 'context_compact', arguments: '{}' },
      ],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c4_1.seq] })
  const tc4_1 = session.append('tool/call', {
    turn: 4,
    step: 1,
    callId: 'call_compact_no_text',
    name: 'context_compact',
    arguments: '{}',
  })

  const tokensBeforeNoText = tokenMeter.measure(session).surfaceTokens
  let concludedNoText = false
  const resNoText = await compactTool.execute({
    results: [{ callId: 'call_g1', summary: 'Compacted G1 result.' }],
    conclude_turn: true,
  }, {
    callId: 'call_compact_no_text',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {
      concludedNoText = true
    },
  })

  assert.equal(concludedNoText, false, 'should NOT conclude turn when assistant message has no text block')
  assert.ok(tokenMeter.measure(session).surfaceTokens < tokensBeforeNoText, 'should still commit compaction immediately')
  assert.ok(resNoText.text.includes('Compact committed immediately'))
  assert.ok(resNoText.text.includes('未结束本轮，请继续写最终回复'))

  session.append('tool/result', {
    turn: 4,
    step: 1,
    message: {
      id: 'tr-4-1',
      role: 'user',
      source: { kind: 'tool', callId: 'call_compact_no_text' },
      content: [{ type: 'tool-result', toolCallId: 'call_compact_no_text', isError: false, content: [{ type: 'text', text: resNoText.text }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc4_1.seq] })
  session.append('step/end', { turn: 4, step: 1 })

  // Turn 4, Step 2: Has text block, BUT same step also has another tool call -> must commit immediately, NOT conclude turn
  session.append('step/start', { turn: 4, step: 2 })
  const c4_2 = session.append('assistant/chunk', {
    turn: 4,
    step: 2,
    chunk: { type: 'text-delta', index: 0, text: 'Partial reply while calling two tools.' },
  })
  session.append('assistant/message', {
    turn: 4,
    step: 2,
    message: {
      id: 'a-4-2',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [
        { type: 'text', text: 'Partial reply while calling two tools.' },
        { type: 'tool-call', id: 'call_other_tool', name: 'todo_write', arguments: '{}' },
        { type: 'tool-call', id: 'call_compact_multi_tool', name: 'context_compact', arguments: '{}' },
      ],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c4_2.seq] })
  const tc4_2a = session.append('tool/call', {
    turn: 4,
    step: 2,
    callId: 'call_other_tool',
    name: 'todo_write',
    arguments: '{}',
  })
  session.append('tool/result', {
    turn: 4,
    step: 2,
    message: {
      id: 'tr-4-2a',
      role: 'user',
      source: { kind: 'tool', callId: 'call_other_tool' },
      content: [{ type: 'tool-result', toolCallId: 'call_other_tool', isError: false, content: [{ type: 'text', text: 'ok' }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc4_2a.seq] })
  const tc4_2b = session.append('tool/call', {
    turn: 4,
    step: 2,
    callId: 'call_compact_multi_tool',
    name: 'context_compact',
    arguments: '{}',
  })

  const tokensBeforeMultiTool = tokenMeter.measure(session).surfaceTokens
  let concludedMultiTool = false
  const resMultiTool = await compactTool.execute({
    results: [{ callId: 'call_g2', summary: 'Compacted G2 result.' }],
    conclude_turn: true,
  }, {
    callId: 'call_compact_multi_tool',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {
      concludedMultiTool = true
    },
  })

  assert.equal(concludedMultiTool, false, 'should NOT conclude turn when same step has other tool calls')
  assert.ok(tokenMeter.measure(session).surfaceTokens < tokensBeforeMultiTool, 'should still commit compaction immediately')
  assert.ok(resMultiTool.text.includes('Compact committed immediately'))
  assert.ok(resMultiTool.text.includes('未结束本轮，请继续写最终回复'))
  assert.ok(resMultiTool.text.includes('同一步存在其他工具调用'))

  session.append('tool/result', {
    turn: 4,
    step: 2,
    message: {
      id: 'tr-4-2b',
      role: 'user',
      source: { kind: 'tool', callId: 'call_compact_multi_tool' },
      content: [{ type: 'tool-result', toolCallId: 'call_compact_multi_tool', isError: false, content: [{ type: 'text', text: resMultiTool.text }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc4_2b.seq] })
  session.append('step/end', { turn: 4, step: 2 })

  // Turn 4, Step 3: Stage a compaction first, then in Step 4 call { conclude_turn: true } alone without text -> flushes staged, does NOT conclude
  session.append('step/start', { turn: 4, step: 3 })
  const c4_3 = session.append('assistant/chunk', {
    turn: 4,
    step: 3,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call_stage_g3', name: 'context_compact', argumentsDelta: '{}' },
  })
  session.append('assistant/message', {
    turn: 4,
    step: 3,
    message: {
      id: 'a-4-3',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'tool-call', id: 'call_stage_g3', name: 'context_compact', arguments: '{}' }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c4_3.seq] })
  const tc4_3 = session.append('tool/call', {
    turn: 4,
    step: 3,
    callId: 'call_stage_g3',
    name: 'context_compact',
    arguments: '{}',
  })
  const resStageG3 = await compactTool.execute({
    results: [{ callId: 'call_g3', summary: 'Compacted G3 result.' }],
  }, {
    callId: 'call_stage_g3',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {},
  })
  assert.ok(resStageG3.text.includes('staged for turn-stopping'))
  session.append('tool/result', {
    turn: 4,
    step: 3,
    message: {
      id: 'tr-4-3',
      role: 'user',
      source: { kind: 'tool', callId: 'call_stage_g3' },
      content: [{ type: 'tool-result', toolCallId: 'call_stage_g3', isError: false, content: [{ type: 'text', text: resStageG3.text }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc4_3.seq] })
  session.append('step/end', { turn: 4, step: 3 })

  // Step 4: Bare { conclude_turn: true } without text -> flushes G3, does NOT conclude
  session.append('step/start', { turn: 4, step: 4 })
  const c4_4 = session.append('assistant/chunk', {
    turn: 4,
    step: 4,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call_bare_conclude_no_text', name: 'context_compact', argumentsDelta: '{}' },
  })
  session.append('assistant/message', {
    turn: 4,
    step: 4,
    message: {
      id: 'a-4-4',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'tool-call', id: 'call_bare_conclude_no_text', name: 'context_compact', arguments: '{}' }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c4_4.seq] })
  const tc4_4 = session.append('tool/call', {
    turn: 4,
    step: 4,
    callId: 'call_bare_conclude_no_text',
    name: 'context_compact',
    arguments: '{}',
  })
  const tokensBeforeBareFlush = tokenMeter.measure(session).surfaceTokens
  let concludedBareNoText = false
  const resBareNoText = await compactTool.execute({
    conclude_turn: true,
  }, {
    callId: 'call_bare_conclude_no_text',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {
      concludedBareNoText = true
    },
  })
  assert.equal(concludedBareNoText, false)
  assert.ok(tokenMeter.measure(session).surfaceTokens < tokensBeforeBareFlush, 'should flush previously staged G3 compaction immediately')
  assert.ok(resBareNoText.text.includes('未结束本轮，请继续写最终回复'))
  session.append('tool/result', {
    turn: 4,
    step: 4,
    message: {
      id: 'tr-4-4',
      role: 'user',
      source: { kind: 'tool', callId: 'call_bare_conclude_no_text' },
      content: [{ type: 'tool-result', toolCallId: 'call_bare_conclude_no_text', isError: false, content: [{ type: 'text', text: resBareNoText.text }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc4_4.seq] })
  session.append('step/end', { turn: 4, step: 4 })

  // Step 5: Assistant writes final reply text + calls context_compact { conclude_turn: true } alone -> concludes turn!
  session.append('step/start', { turn: 4, step: 5 })
  const c4_5 = session.append('assistant/chunk', {
    turn: 4,
    step: 5,
    chunk: { type: 'text-delta', index: 0, text: 'Here is the complete final response.' },
  })
  session.append('assistant/message', {
    turn: 4,
    step: 5,
    message: {
      id: 'a-4-5',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [
        { type: 'text', text: 'Here is the complete final response.' },
        { type: 'tool-call', id: 'call_conclude_with_text', name: 'context_compact', arguments: '{}' },
      ],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c4_5.seq] })
  const tc4_5 = session.append('tool/call', {
    turn: 4,
    step: 5,
    callId: 'call_conclude_with_text',
    name: 'context_compact',
    arguments: '{}',
  })
  let concludedWithText = false
  const resWithText = await compactTool.execute({
    conclude_turn: true,
  }, {
    callId: 'call_conclude_with_text',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {
      concludedWithText = true
    },
  })
  assert.equal(concludedWithText, true, 'should conclude turn when assistant message has non-empty text and no other tool calls')
  assert.ok(resWithText.text.includes('Turn concluded'))
  session.append('tool/result', {
    turn: 4,
    step: 5,
    message: {
      id: 'tr-4-5',
      role: 'user',
      source: { kind: 'tool', callId: 'call_conclude_with_text' },
      content: [{ type: 'tool-result', toolCallId: 'call_conclude_with_text', isError: false, content: [{ type: 'text', text: resWithText.text }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc4_5.seq] })
  session.append('step/end', { turn: 4, step: 5 })
  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
})

test('positive multi-turn span compaction of earlier turns + current-turn completed result compaction + turn-stopping auto-commit', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-pos-span-and-cur-res', { meta: { cwd: TEST_CWD } })
  const compactTool = registeredTools.get('context_compact')
  const ctrl = new AbortController()
  const fakeAgent = { id: 'agent-pos', session }

  const out1 = Array.from({ length: 90 }, (_, i) => `P1_L${i + 1}: past_one_${i + 1} ${'A'.repeat(30)}`).join('\n')
  const out2 = Array.from({ length: 90 }, (_, i) => `P2_L${i + 1}: past_two_${i + 1} ${'B'.repeat(30)}`).join('\n')
  const out3 = Array.from({ length: 90 }, (_, i) => `P3_L${i + 1}: cur_turn_done_${i + 1} ${'C'.repeat(30)}`).join('\n')

  addCompleteTurnWithTool(session, 1, 'call_p1', 'read', out1)
  addCompleteTurnWithTool(session, 2, 'call_p2', 'grep', out2)

  // Turn 3 is currently open; Step 1 has a completed tool result `call_p3_done` in the current open turn
  session.append('turn/start', { turn: 3 })
  session.append('step/start', { turn: 3, step: 1 })
  const c3_1 = session.append('assistant/chunk', {
    turn: 3,
    step: 1,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call_p3_done', name: 'read', argumentsDelta: '{}' },
  })
  session.append('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      id: 'a-3-1',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'tool-call', id: 'call_p3_done', name: 'read', arguments: '{}' }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c3_1.seq] })
  const tc3_1 = session.append('tool/call', { turn: 3, step: 1, callId: 'call_p3_done', name: 'read', arguments: '{}' })
  session.append('tool/result', {
    turn: 3,
    step: 1,
    message: {
      id: 'tr-3-1',
      role: 'user',
      source: { kind: 'tool', callId: 'call_p3_done' },
      content: [{ type: 'tool-result', toolCallId: 'call_p3_done', isError: false, content: [{ type: 'text', text: out3 }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [tc3_1.seq] })
  session.append('step/end', { turn: 3, step: 1 })

  // Step 2 in Turn 3: stage positive multi-turn span (turn:1..turn:2) AND current-turn completed result (call_p3_done)
  session.append('step/start', { turn: 3, step: 2 })
  // Span covering current open turn (turn:3) must still be forbidden:
  await assert.rejects(
    () => compactTool.execute({
      spans: [{ from: 'turn:2', to: 'turn:3', summary: 'Should fail on open turn 3' }],
    }, { callId: 'call_fail_open_span', agent: fakeAgent, signal: ctrl.signal }),
    /current open turn/
  )

  const tokensBeforeStage = tokenMeter.measure(session).surfaceTokens
  const stagedRes = await compactTool.execute({
    spans: [{ from: 'turn:1', to: 'turn:2', summary: 'Turns 1-2 summary: past_one_15 and past_two_30.' }],
    results: [{ callId: 'call_p3_done', summary: 'Current turn 3 completed read: cur_turn_done_45.' }],
  }, {
    callId: 'call_stage_t3',
    agent: fakeAgent,
    signal: ctrl.signal,
  })

  assert.ok(stagedRes.text.includes('Compact staged for turn-stopping: 1 span(s), 1 result(s)'))
  assert.equal(tokenMeter.measure(session).surfaceTokens, tokensBeforeStage, 'staged items remain uncompacted during the turn')

  session.append('step/end', { turn: 3, step: 2 })
  await emitTurnStopping(fakeAgent, 3, ctrl.signal)
  const tokensAfterAutoCommit = tokenMeter.measure(session).surfaceTokens
  assert.ok(tokensAfterAutoCommit < tokensBeforeStage, 'turn-stopping automatically committed both past span and current-turn result')
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

  assert.equal(getStagedQueueSnapshot(session).spans.length, 0)
  assert.equal(getStagedQueueSnapshot(session).results.length, 0)

  const msgs = session.deriveMessages()
  assert.ok(msgs.some((m) => m.source?.plugin === 'compact' && m.content.some((b) => b.text?.includes('Turns 1-2 summary: past_one_15 and past_two_30.'))))
  assert.ok(msgs.some((m) => m.source?.kind === 'tool' && m.content[0].content[0].text.includes('Current turn 3 completed read: cur_turn_done_45.')))

  const recallP2 = executeRecall(session, { target: '@turn:2', query: 'past_two_30', context_lines: 0 })
  assert.ok(recallP2.text.includes('past_two_30'))
  const recallP3 = executeRecall(session, { target: '@call:call_p3_done', query: 'cur_turn_done_45', context_lines: 0 })
  assert.ok(recallP3.text.includes('cur_turn_done_45'))
})

test('abort retention across turns + next-turn turn-stopping commit + per-session queue isolation', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const sessionA = sessions.prepare('test-abort-session-a', { meta: { cwd: TEST_CWD } })
  const sessionB = sessions.prepare('test-abort-session-b', { meta: { cwd: TEST_CWD } })
  const compactTool = registeredTools.get('context_compact')

  const outA1 = Array.from({ length: 85 }, (_, i) => `A1_L${i + 1}: alpha_${i + 1} ${'A'.repeat(30)}`).join('\n')
  const outA2 = Array.from({ length: 85 }, (_, i) => `A2_L${i + 1}: beta_${i + 1} ${'B'.repeat(30)}`).join('\n')
  const outB1 = Array.from({ length: 85 }, (_, i) => `B1_L${i + 1}: other_sess_${i + 1} ${'Z'.repeat(30)}`).join('\n')

  addCompleteTurnWithTool(sessionA, 1, 'call_a1', 'read', outA1)
  addCompleteTurnWithTool(sessionA, 2, 'call_a2', 'read', outA2)
  addCompleteTurnWithTool(sessionB, 1, 'call_b1', 'read', outB1)

  // Open Turn 3 on sessionA, and Turn 2 on sessionB
  sessionA.append('turn/start', { turn: 3 })
  sessionA.append('step/start', { turn: 3, step: 1 })
  sessionB.append('turn/start', { turn: 2 })
  sessionB.append('step/start', { turn: 2, step: 1 })

  const ctrlA3 = new AbortController()
  const ctrlB2 = new AbortController()
  const agentA = { id: 'agent-a', session: sessionA }
  const agentB = { id: 'agent-b', session: sessionB }

  // Stage relative span `turnsBack:2..turnsBack:2` (targeting Turn 1) + result `call_a2` on sessionA
  await compactTool.execute({
    spans: [{ from: 'turnsBack:2', to: 'turnsBack:2', summary: 'SessionA Turn 1 summary: alpha_12.' }],
    results: [{ callId: 'call_a2', summary: 'SessionA Turn 2 result: beta_34.' }],
  }, { callId: 'call_stage_a3', agent: agentA, signal: ctrlA3.signal })

  // Stage result `call_b1` on sessionB
  await compactTool.execute({
    results: [{ callId: 'call_b1', summary: 'SessionB Turn 1 result: other_sess_56.' }],
  }, { callId: 'call_stage_b2', agent: agentB, signal: ctrlB2.signal })

  // Verify queues are isolated per session
  const snapA = getStagedQueueSnapshot(sessionA)
  const snapB = getStagedQueueSnapshot(sessionB)
  assert.equal(snapA.spans.length, 1)
  assert.equal(snapA.spans[0].resolvedFrom, 'turn:1')
  assert.equal(snapA.spans[0].resolvedTo, 'turn:1')
  assert.equal(snapA.results.length, 1)
  assert.equal(snapB.spans.length, 0)
  assert.equal(snapB.results.length, 1)

  const tokensABeforeAbort = tokenMeter.measure(sessionA).surfaceTokens
  const tokensBBeforeCommit = tokenMeter.measure(sessionB).surfaceTokens

  // Abort sessionA Turn 3!
  ctrlA3.abort(new Error('user interrupted turn 3'))
  sessionA.append('step/end', { turn: 3, step: 1 })
  await emitTurnStopping(agentA, 3, ctrlA3.signal)
  sessionA.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: 'user interrupted turn 3' } })

  // sessionA must NOT have flushed and must NOT have lost its staged queue on turn/end!
  assert.equal(tokenMeter.measure(sessionA).surfaceTokens, tokensABeforeAbort, 'aborted turn must not flush compactions')
  const snapAAfterAbort = getStagedQueueSnapshot(sessionA)
  assert.equal(snapAAfterAbort.spans.length, 1, 'staged span must survive abort + turn/end')
  assert.equal(snapAAfterAbort.results.length, 1, 'staged result must survive abort + turn/end')

  // Complete sessionB Turn 2 normally -> only sessionB flushes
  sessionB.append('step/end', { turn: 2, step: 1 })
  await emitTurnStopping(agentB, 2, ctrlB2.signal)
  sessionB.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.ok(tokenMeter.measure(sessionB).surfaceTokens < tokensBBeforeCommit, 'sessionB flushed independently')
  assert.equal(getStagedQueueSnapshot(sessionB).results.length, 0)
  assert.equal(getStagedQueueSnapshot(sessionA).spans.length, 1, 'sessionA queue untouched by sessionB flush')

  // Now run Turn 4 on sessionA and finish normally -> staged items from aborted Turn 3 commit at Turn 4 turn-stopping!
  const ctrlA4 = new AbortController()
  sessionA.append('turn/start', { turn: 4 })
  sessionA.append('step/start', { turn: 4, step: 1 })
  sessionA.append('step/end', { turn: 4, step: 1 })
  await emitTurnStopping(agentA, 4, ctrlA4.signal)
  sessionA.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

  assert.ok(tokenMeter.measure(sessionA).surfaceTokens < tokensABeforeAbort, 'retained items committed on next turn-stopping')
  assert.equal(getStagedQueueSnapshot(sessionA).spans.length, 0)
  assert.equal(getStagedQueueSnapshot(sessionA).results.length, 0)

  // Verify `turnsBack:2` staged in Turn 3 still compacted Turn 1 (not Turn 2!) when committed in Turn 4
  const msgsA = sessionA.deriveMessages()
  assert.ok(msgsA.some((m) => m.source?.plugin === 'compact' && m.content.some((b) => b.text?.includes('SessionA Turn 1 summary: alpha_12.'))))
  assert.ok(msgsA.some((m) => m.source?.kind === 'tool' && m.content[0].content[0].text.includes('SessionA Turn 2 result: beta_34.')))
})

test('flush failure retry retention (max 2 retries, drop & record after exceeding) + re-plan + silent skip when already compacted', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-retry-and-skip', { meta: { cwd: TEST_CWD } })
  const compactTool = registeredTools.get('context_compact')
  const fakeAgent = { id: 'agent-retry', session }

  const out1 = Array.from({ length: 85 }, (_, i) => `R1_L${i + 1}: r_one_${i + 1} ${'A'.repeat(30)}`).join('\n')
  const out2 = Array.from({ length: 85 }, (_, i) => `R2_L${i + 1}: r_two_${i + 1} ${'B'.repeat(30)}`).join('\n')
  const out3 = Array.from({ length: 85 }, (_, i) => `R3_L${i + 1}: r_three_${i + 1} ${'C'.repeat(30)}`).join('\n')

  addCompleteTurnWithTool(session, 1, 'call_r1', 'read', out1)
  addCompleteTurnWithTool(session, 2, 'call_r2', 'read', out2)
  addCompleteTurnWithTool(session, 3, 'call_r3', 'read', out3)

  // Turn 4: stage span `turn:1..turn:1` and result `call_r2`
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })
  await compactTool.execute({
    spans: [{ from: 'turn:1', to: 'turn:1', summary: 'Retryable T1 span summary.' }],
    results: [{ callId: 'call_r2', summary: 'Retryable R2 result summary.' }],
  }, { callId: 'call_stage_t4', agent: fakeAgent, signal: new AbortController().signal })
  session.append('step/end', { turn: 4, step: 1 })

  // Inject transient failure during Turn 4 turn-stopping flush
  const origAppend = session.append.bind(session)
  let failCompactionWrites = true
  session.append = function (type, data, opts) {
    if (failCompactionWrites && (type === 'compaction/start' || type === 'compaction/prune')) {
      throw new Error('simulated transient storage lock')
    }
    return origAppend(type, data, opts)
  }

  await emitTurnStopping(fakeAgent, 4, new AbortController().signal)
  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

  // Both items failed once -> must remain in queue with retries === 1
  const snapAfterT4 = getStagedQueueSnapshot(session)
  assert.equal(snapAfterT4.spans.length, 1)
  assert.equal(snapAfterT4.spans[0].retries, 1)
  assert.equal(snapAfterT4.results.length, 1)
  assert.equal(snapAfterT4.results[0].retries, 1)
  assert.equal(snapAfterT4.dropped.length, 0)

  // Turn 5: clear transient failure, AND manually compact `call_r2` before Turn 5 turn-stopping
  // so `call_r2` is already compacted when Retry #1 runs (must be silently skipped!), while `turn:1..turn:1` re-plans and commits!
  failCompactionWrites = false
  session.append('turn/start', { turn: 5 })
  session.append('step/start', { turn: 5, step: 1 })
  const manualPlanR2 = planResultCompaction(session, tokenMeter, {
    callId: 'call_r2',
    summary: 'Manually compacted R2 ahead of retry.',
  })
  commitResultCompaction(session, tokenMeter, manualPlanR2)
  assert.equal(isResultAlreadyCompacted(session, 'call_r2').compacted, true)
  session.append('step/end', { turn: 5, step: 1 })

  const tokensBeforeT5Stop = tokenMeter.measure(session).surfaceTokens
  await emitTurnStopping(fakeAgent, 5, new AbortController().signal)
  session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })

  // `turn:1..turn:1` committed on Retry #1, `call_r2` was silently skipped because already compacted, queue is now empty!
  assert.ok(tokenMeter.measure(session).surfaceTokens < tokensBeforeT5Stop, 'span committed on Retry #1')
  const snapAfterT5 = getStagedQueueSnapshot(session)
  assert.equal(snapAfterT5.spans.length, 0)
  assert.equal(snapAfterT5.results.length, 0)
  assert.equal(snapAfterT5.dropped.length, 0)
  assert.equal(isSpanAlreadyCompacted(session, { from: 'turn:1', to: 'turn:1' }), true)

  // Now test exceeding maxRetries (2): stage `call_r3` in Turn 6 and fail persistently across Turn 6 (initial), Turn 7 (retry 1), Turn 8 (retry 2 -> drop!)
  session.append('turn/start', { turn: 6 })
  session.append('step/start', { turn: 6, step: 1 })
  await compactTool.execute({
    results: [{ callId: 'call_r3', summary: 'Persistent fail R3.' }],
  }, { callId: 'call_stage_t6', agent: fakeAgent, signal: new AbortController().signal })
  session.append('step/end', { turn: 6, step: 1 })

  failCompactionWrites = true

  // Attempt 1 (Turn 6 end, initial flush): fails -> retries becomes 1
  await emitTurnStopping(fakeAgent, 6, new AbortController().signal)
  session.append('turn/end', { turn: 6, reason: { kind: 'completed' } })
  assert.equal(getStagedQueueSnapshot(session).results.length, 1)
  assert.equal(getStagedQueueSnapshot(session).results[0].retries, 1)
  assert.equal(getStagedQueueSnapshot(session).dropped.length, 0)

  // Attempt 2 (Turn 7 end, retry #1): fails -> retries becomes 2
  session.append('turn/start', { turn: 7 })
  session.append('step/start', { turn: 7, step: 1 })
  session.append('step/end', { turn: 7, step: 1 })
  await emitTurnStopping(fakeAgent, 7, new AbortController().signal)
  session.append('turn/end', { turn: 7, reason: { kind: 'completed' } })
  assert.equal(getStagedQueueSnapshot(session).results.length, 1)
  assert.equal(getStagedQueueSnapshot(session).results[0].retries, 2)
  assert.equal(getStagedQueueSnapshot(session).dropped.length, 0)

  // Attempt 3 (Turn 8 end, retry #2): fails -> exceeds maxRetries (2), dropped and recorded!
  session.append('turn/start', { turn: 8 })
  session.append('step/start', { turn: 8, step: 1 })
  session.append('step/end', { turn: 8, step: 1 })
  await emitTurnStopping(fakeAgent, 8, new AbortController().signal)
  session.append('turn/end', { turn: 8, reason: { kind: 'completed' } })

  const snapAfterDrop = getStagedQueueSnapshot(session)
  assert.equal(snapAfterDrop.results.length, 0, 'dropped item must be removed from active queue after 2 retries')
  assert.equal(snapAfterDrop.dropped.length, 1, 'dropped item must be recorded')
  assert.equal(snapAfterDrop.dropped[0].target, 'call_r3')
  assert.equal(snapAfterDrop.dropped[0].retries, 2)
  assert.ok(snapAfterDrop.dropped[0].error.includes('simulated transient storage lock'))

  session.append = origAppend
})

test('same-turn duplicate span deduplication in staging + overlapping/contained spans skipped with explanation at commit', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-span-dedup-overlap', { meta: { cwd: TEST_CWD } })
  const compactTool = registeredTools.get('context_compact')
  const ctrl = new AbortController()
  const fakeAgent = { id: 'agent-dedup', session }

  const out1 = Array.from({ length: 85 }, (_, i) => `D1_L${i + 1}: d_one_${i + 1} ${'A'.repeat(30)}`).join('\n')
  const out2 = Array.from({ length: 85 }, (_, i) => `D2_L${i + 1}: d_two_${i + 1} ${'B'.repeat(30)}`).join('\n')
  const out3 = Array.from({ length: 85 }, (_, i) => `D3_L${i + 1}: d_three_${i + 1} ${'C'.repeat(30)}`).join('\n')

  addCompleteTurnWithTool(session, 1, 'call_d1', 'read', out1)
  addCompleteTurnWithTool(session, 2, 'call_d2', 'read', out2)
  addCompleteTurnWithTool(session, 3, 'call_d3', 'read', out3)

  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })

  // 1. Same call duplicate spans (`turn:1..turn:2` twice) -> deduplicated at staging
  const stage1 = await compactTool.execute({
    spans: [
      { from: 'turn:1', to: 'turn:2', summary: 'Summary v1' },
      { from: 'turn:1', to: 'turn:2', summary: 'Summary v2' },
    ],
  }, { callId: 'call_dedup_1', agent: fakeAgent, signal: ctrl.signal })

  assert.ok(stage1.text.includes('deduplicated spans: [turn:1..turn:2]'))
  let snap = getStagedQueueSnapshot(session)
  assert.equal(snap.spans.length, 1, 'identical spans in single call must be deduplicated')
  assert.equal(snap.spans[0].summary, 'Summary v2')

  // 2. Second call in same turn with equivalent span via `turnsBack:3..turnsBack:2` -> deduplicated in-place in queue
  const stage2 = await compactTool.execute({
    spans: [
      { from: 'turnsBack:3', to: 'turnsBack:2', summary: 'Summary v3 canonical' },
    ],
  }, { callId: 'call_dedup_2', agent: fakeAgent, signal: ctrl.signal })

  assert.ok(stage2.text.includes('deduplicated spans'))
  snap = getStagedQueueSnapshot(session)
  assert.equal(snap.spans.length, 1, 'equivalent span in second call must update existing staged span')
  assert.equal(snap.spans[0].summary, 'Summary v3 canonical')

  // 3. Stage an overlapping span (`turn:2..turn:3`) and a contained span (`turn:1..turn:1`) in the same turn
  const stage3 = await compactTool.execute({
    spans: [
      { from: 'turn:2', to: 'turn:3', summary: 'Overlapping T2-T3 summary' },
      { from: 'turn:1', to: 'turn:1', summary: 'Contained T1 summary' },
    ],
  }, { callId: 'call_overlap_3', agent: fakeAgent, signal: ctrl.signal })

  assert.ok(stage3.text.includes('overlapping spans will be skipped at commit'))
  snap = getStagedQueueSnapshot(session)
  assert.equal(snap.spans.length, 3)

  // 4. Commit via bare { conclude_turn: true } (immediate flush) -> must NOT throw; commits T1-T2 and skips overlapping/contained with explanation!
  const c4 = session.append('assistant/chunk', {
    turn: 4,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'Done testing overlap.' },
  })
  session.append('assistant/message', {
    turn: 4,
    step: 1,
    message: {
      id: 'a-4-dedup',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [
        { type: 'text', text: 'Done testing overlap.' },
        { type: 'tool-call', id: 'call_flush_overlap', name: 'context_compact', arguments: '{}' },
      ],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [c4.seq] })
  session.append('tool/call', {
    turn: 4,
    step: 1,
    callId: 'call_flush_overlap',
    name: 'context_compact',
    arguments: '{}',
  })

  const flushRes = await compactTool.execute({
    conclude_turn: true,
  }, {
    callId: 'call_flush_overlap',
    agent: fakeAgent,
    signal: ctrl.signal,
    concludeTurn() {},
  })

  assert.ok(flushRes.text.includes('Compact committed immediately: 1 span(s), 0 result(s)'))
  assert.ok(flushRes.text.includes('skipped overlapping spans:'))
  assert.ok(flushRes.text.includes('[turn:2..turn:3: overlaps with [turnsBack:3..turnsBack:2]]'))
  assert.ok(flushRes.text.includes('[turn:1..turn:1: contained in [turnsBack:3..turnsBack:2]]'))
  assert.ok(!flushRes.text.includes('[errors:'), 'overlapping spans must be skipped cleanly without errors')

  snap = getStagedQueueSnapshot(session)
  assert.equal(snap.spans.length, 0)
  session.append('step/end', { turn: 4, step: 1 })
  await emitTurnStopping(fakeAgent, 4, ctrl.signal)
  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
})
