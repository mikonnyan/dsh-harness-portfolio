import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  apply,
  buildLargeBlocksDirectory,
  buildInspectReport,
  buildSoftWatermarkHint,
  checkConcludeTurnEligibility,
  classifySpanOverlap,
  getStagedQueueSnapshot,
  inspectSoftWatermark,
  isResultAlreadyCompacted,
  isSameSpanTarget,
  isSpanAlreadyCompacted,
  limitAutoSummary,
  buildAutoSpanDigest,
  planResultCompaction,
  commitResultCompaction,
  planSpanCompaction,
  commitSpanCompaction,
  createUserMessage,
  compactCheckpointSource,
  inspectSessionLog,
  latestClosedTurn,
  parseTurnsToken,
  resolveSpanTurns,
  resolveSurfaceNodeTurns,
  executeRecall,
  isHighContextOccupancy,
  resolveLeafSurfaceSeqs,
  toolPairingBalancedBefore,
  toolPairingBalancedAfter,
  getGlobalRuntimeState,
  collectHardResultCandidates,
  runHardCompaction,
  auditNativeCompactionPresets,
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
  const originalPrepare = sessions.prepare.bind(sessions)
  sessions.prepare = (id, options) => {
    if (options?.seedSource === 'persistence') {
      const live = sessions.store.get(id)
      if (live) live.detach()
    }
    const session = originalPrepare(id, options)
    if (session.header?.id && options?.seedSource !== 'persistence') sessions.enter(session)
    return session
  }
  const tokenMeter = new TokenMeter(ctx)
  ctx.sessions = sessions
  ctx.tokenMeter = tokenMeter

  apply(ctx)

  async function emitTurnStopping(agent, turn, signal) {
    await ctx.serial('agent/turn-stopping', { agent, turn, signal })
  }

  return {
    ctx,
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

function addOpenTurnToolStep(session, turn, step, callId, resultText, toolName = 'read', settle = true) {
  session.append('step/start', { turn, step })
  const chunk = session.append('assistant/chunk', { turn, step, chunk: { type: 'tool-call-delta', index: 0, id: callId, name: toolName, argumentsDelta: '{}' } })
  session.append('assistant/message', { turn, step, message: { id: `a-${turn}-${step}`, role: 'assistant', content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }] } }, { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] })
  const call = session.append('tool/call', { turn, step, callId, name: toolName, arguments: '{}' })
  if (settle) session.append('tool/result', { turn, step, message: { id: `r-${callId}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: resultText }] }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn, step })
}

function makeHardSession(session, tokenMeter) {
  addCompleteTurnWithTool(session, 1, 'hard_old_1', 'read', 'old\n'.repeat(9000))
  addCompleteTurnWithTool(session, 2, 'hard_old_2', 'read', 'older\n'.repeat(7000))
  session.append('turn/start', { turn: 3 })
  addOpenTurnToolStep(session, 3, 1, 'hard_open_1', 'open\n'.repeat(9000))
  addOpenTurnToolStep(session, 3, 2, 'hard_open_2', 'recent\n'.repeat(500))
  addOpenTurnToolStep(session, 3, 3, 'hard_open_3', 'latest\n'.repeat(500))
  session.append('step/start', { turn: 3, step: 4 })
  const measurement = tokenMeter.measure(session)
  return { contextWindow: Math.ceil(measurement.totalTokens / 0.76), measurement }
}

test('hard pre-step is quiet at 74% and archives to <=55% at 76%', async () => {
  const { sessions, tokenMeter, ctx } = await createTestHarness()
  const session = sessions.prepare('test-hard-ratio', { meta: { cwd: TEST_CWD } })
  const { contextWindow } = makeHardSession(session, tokenMeter)
  const agent = { session }
  const agentCtx = ctx
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: Math.ceil(contextWindow / 0.74 * 0.76) })
  const before = session.surface.replaceGeneration
  await agentCtx.waterfall('agent/pre-step', { agent, turn: 3, step: 4, messages: [], signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(session.surface.replaceGeneration, before)
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow })
  await agentCtx.waterfall('agent/pre-step', { agent, turn: 3, step: 4, messages: [], signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.ok(session.surface.replaceGeneration > before)
  assert.ok(tokenMeter.measure(session).totalTokens / contextWindow <= 0.55)
})

test('hard candidates include completed open-turn results but exclude in-flight and recent two steps', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-hard-open', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(session, 1, 'closed_result', 'read', 'closed\n'.repeat(100))
  session.append('turn/start', { turn: 2 })
  addOpenTurnToolStep(session, 2, 1, 'open_old', 'old\n'.repeat(1000))
  addOpenTurnToolStep(session, 2, 2, 'open_recent', 'recent')
  addOpenTurnToolStep(session, 2, 3, 'open_latest', 'latest')
  addOpenTurnToolStep(session, 2, 4, 'open_running', '', 'read', false)
  const ids = collectHardResultCandidates(session, tokenMeter).map((c) => c.callId)
  assert.ok(ids.includes('open_old'))
  assert.ok(ids.includes('closed_result'))
  assert.ok(!ids.includes('open_recent'))
  assert.ok(!ids.includes('open_latest'))
  assert.ok(!ids.includes('open_running'))
})

test('hard result archive retains exact recall and never calls ctx.llm', async () => {
  const { sessions, tokenMeter, ctx } = await createTestHarness()
  let llmCalls = 0
  ctx.llm = { stream() { llmCalls++; throw new Error('LLM forbidden') } }
  const session = sessions.prepare('test-hard-recall', { meta: { cwd: TEST_CWD } })
  makeHardSession(session, tokenMeter)
  session.append('request/context', { contextWindow: 10000 })
  const result = runHardCompaction(session, tokenMeter, { hardTargetRatio: 0.55 })
  assert.ok(result.resultCount > 0)
  const recalled = executeRecall(session, { target: '@call:hard_open_1', query: 'open', context_lines: 0 })
  assert.ok(recalled.text.includes('open'))
  assert.equal(llmCalls, 0)
})

test('hard pre-step passes through with compaction lock or missing contextWindow', async () => {
  const { sessions, tokenMeter, ctx } = await createTestHarness()
  const session = sessions.prepare('test-hard-guards', { meta: { cwd: TEST_CWD } })
  const { contextWindow } = makeHardSession(session, tokenMeter)
  const agentCtx = ctx
  const enter = () => Promise.resolve({ kind: 'enter', messages: [] })
  let before = session.surface.replaceGeneration
  session.append('compaction/start', { turn: 3 })
  session.append('request/context', { contextWindow })
  await agentCtx.waterfall('agent/pre-step', { agent: { session }, turn: 3, step: 4, signal: new AbortController().signal }, enter)
  assert.equal(session.surface.replaceGeneration, before)
  session.append('compaction/end', { turn: 3 })
  session.append('request/context', {})
  await agentCtx.waterfall('agent/pre-step', { agent: { session }, turn: 3, step: 4, signal: new AbortController().signal }, enter)
  assert.equal(session.surface.replaceGeneration, before)
})

test('overflow retry shrinks once, preserves unshrinkable errors, and resets on assistant/message', async () => {
  const { sessions, tokenMeter, ctx } = await createTestHarness()
  const session = sessions.prepare('test-overflow', { meta: { cwd: TEST_CWD } })
  makeHardSession(session, tokenMeter)
  const agent = { session }
  const agentCtx = ctx
  const failure = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too large' }
  const terminal = () => Promise.resolve(undefined)
  const payload = { agent, turn: 3, step: 4, failure, signal: new AbortController().signal }
  assert.deepEqual(await agentCtx.waterfall('agent/request-error', payload, terminal), { kind: 'retry' })
  const generation = session.surface.replaceGeneration
  assert.equal(await agentCtx.waterfall('agent/request-error', payload, terminal), undefined)
  assert.equal(session.surface.replaceGeneration, generation)
  session.append('assistant/message', { turn: 3, step: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'progress' }] } }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 3, step: 4 })
  addCompleteTurnWithTool(session, 4, 'overflow_new', 'read', 'new\n'.repeat(50000))
  session.append('request/context', { contextWindow: 1000 })
  session.append('turn/start', { turn: 5 })
  addOpenTurnToolStep(session, 5, 1, 'overflow_latest', 'latest\n'.repeat(100))
  const retry = await agentCtx.waterfall('agent/request-error', { ...payload, turn: 5, step: 1 }, terminal)
  assert.deepEqual(retry, { kind: 'retry' })
  const tiny = sessions.prepare('test-overflow-unshrinkable', { meta: { cwd: TEST_CWD } })
  tiny.append('turn/start', { turn: 1 })
  tiny.append('user/message', { role: 'user', content: [{ type: 'text', text: 'single unshrinkable message' }] }, { surfaceOp: 'append' })
  const tinyCtx = ctx
  assert.equal(await tinyCtx.waterfall('agent/request-error', { agent: { session: tiny }, turn: 1, step: 1, failure, signal: new AbortController().signal }, terminal), undefined)
})

test('non-overflow failures always delegate unchanged', async () => {
  const { sessions, ctx } = await createTestHarness()
  const session = sessions.prepare('test-non-overflow', { meta: { cwd: TEST_CWD } })
  const agentCtx = ctx
  let delegated = 0
  const result = await agentCtx.waterfall('agent/request-error', { agent: { session }, turn: 1, step: 1, failure: { code: 'RATE_LIMIT' }, signal: new AbortController().signal }, () => { delegated++; return Promise.resolve({ kind: 'terminal' }) })
  assert.deepEqual(result, { kind: 'terminal' })
  assert.equal(delegated, 1)
})

test('mergeSummaries cold start anchors at previous closed turn, not new user message', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-cold-anchor', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(session, 1, 'cold_anchor_1', 'read', 'one\n'.repeat(300))
  addCompleteTurnWithTool(session, 2, 'cold_anchor_2', 'read', 'two\n'.repeat(300))
  const turnEnd = getAllEventsForTest(session).findLast((ev) => ev.type === 'turn/end')
  const coldNow = (turnEnd.data?.time ?? turnEnd.time) + 300001
  session.append('turn/start', { turn: 3 })
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'fresh user message' }] }, { surfaceOp: 'append' })
  const plan = planSpanCompaction(session, tokenMeter, { turns: [1, 2], summary: 'cold closed turns', mergeSummaries: true, now: coldNow }, 1)
  assert.ok(plan.shadowedSeqs.length > 0)
})

function getAllEventsForTest(session) { return session.events }

test('startup native-compaction audit is read-only and reports unsafe user presets', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preset-audit-'))
  try {
    fs.mkdirSync(path.join(root, 'unsafe'))
    fs.writeFileSync(path.join(root, 'unsafe', 'agent.cordis.yml'), "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n")
    fs.mkdirSync(path.join(root, 'safe'))
    fs.writeFileSync(path.join(root, 'safe', 'agent.cordis.yml'), "- id: compaction-basic\n  disabled: true\n")
    assert.deepEqual(auditNativeCompactionPresets(root), ['unsafe'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

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

  const spanTagMatch = /\[recall:\s*(@span:S\d+-\d+(?:\+S\d+-\d+)*(?: turns:[\d,..-]+)?)[\]\s]/.exec(nestedOut.text)
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

  // Turn 4, Step 1: NO text block -> commit immediately and conclude with a synthetic receipt (v5 C2)
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

  assert.equal(concludedNoText, true, 'empty assistant text concludes with a synthetic receipt')
  assert.ok(tokenMeter.measure(session).surfaceTokens < tokensBeforeNoText, 'should still commit compaction immediately')
  assert.ok(resNoText.text.includes('Compact committed immediately'))
  assert.match(resNoText.text, /turn concluded/i)

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

  // Step 4: Bare { conclude_turn: true } without text -> flushes G3 and concludes with a receipt
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
  assert.equal(concludedBareNoText, true)
  assert.ok(tokenMeter.measure(session).surfaceTokens < tokensBeforeBareFlush, 'should flush previously staged G3 compaction immediately')
  assert.match(resBareNoText.text, /turn concluded/i)
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
  // Span ending at the open turn clamps back to the latest closed turn.
  const clampedOpenTurn = planSpanCompaction(session, tokenMeter, {
    from: 'turn:2', to: 'turn:3', summary: 'Open turn clamps back to closed turn 2.',
  })
  assert.equal(clampedOpenTurn.resolvedTo, 'turn:2')

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

  // The observer itself performs zero appends. The microtask commits safely
  // after turn/end and leaves retries untouched; before it runs queue survives.
  assert.equal(tokenMeter.measure(sessionA).surfaceTokens, tokensABeforeAbort, 'turn/end observer must not synchronously reenter append')
  assert.equal(getStagedQueueSnapshot(sessionA).spans.length, 1, 'queue survives inside the event observer')
  await Promise.resolve()
  const snapAAfterAbort = getStagedQueueSnapshot(sessionA)
  assert.equal(snapAAfterAbort.spans.length, 0, `aborted boundary microtask commits staged span: ${JSON.stringify(getGlobalRuntimeState().bySession.get(sessionA)?.lastBoundaryOutcome)}`)
  assert.equal(snapAAfterAbort.results.length, 0, 'aborted boundary microtask commits staged result')
  assert.equal(snapAAfterAbort.dropped.length, 0, 'aborted flush does not consume retries/drop items')
  assert.ok(tokenMeter.measure(sessionA).surfaceTokens < tokensABeforeAbort, 'microtask flush is observable after one microtask checkpoint')

  // Complete sessionB Turn 2 normally -> only sessionB flushes
  sessionB.append('step/end', { turn: 2, step: 1 })
  await emitTurnStopping(agentB, 2, ctrlB2.signal)
  sessionB.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.ok(tokenMeter.measure(sessionB).surfaceTokens < tokensBBeforeCommit, 'sessionB flushed independently')
  assert.equal(getStagedQueueSnapshot(sessionB).results.length, 0)
  assert.equal(getStagedQueueSnapshot(sessionA).spans.length, 0, 'sessionA queue was already flushed by its own microtask; sessionB must not duplicate it')

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

test('HMR re-import preserves staged queue and restart recovers uncommitted context_compact call from log', async () => {
  const { sessions, registeredTools } = await createTestHarness()
  const session = sessions.prepare('test-hmr-recovery', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(session, 1, 'hmr_result', 'read', `HMR ${'x'.repeat(2500)}`)
  session.append('turn/start', { turn: 2 })
  const agent = { session }
  await registeredTools.get('context_compact').execute({ results: [{ callId: 'hmr_result', summary: 'preserved across reload' }] }, { callId: 'hmr_stage', agent, signal: new AbortController().signal })
  const before = getStagedQueueSnapshot(session)
  assert.equal(before.results.length, 1)
  const reloaded = await import(`../lib/index.js?hmr=${Date.now()}`)
  assert.equal(reloaded.getStagedQueueSnapshot(session).results[0].summary, 'preserved across reload')
  getGlobalRuntimeState().bySession.delete(session) // simulate process memory loss
  const recovered = reloaded.getStagedQueueSnapshot(session)
  assert.equal(recovered.results.length, 0, 'only logged tool/call records can recover after process loss')
  session.append('tool/call', { turn: 2, step: 1, callId: 'hmr_stage', name: 'context_compact', arguments: JSON.stringify({ results: [{ callId: 'hmr_result', summary: 'preserved across reload' }] }) })
  getGlobalRuntimeState().bySession.delete(session)
  const directRecovery = reloaded.recoverStagedFromLog(session)
  assert.equal(directRecovery?.results?.size, 1)
  assert.equal(reloaded.getStagedQueueSnapshot(session).results[0]?.summary, 'preserved across reload')
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

test('soft watermark auto-hint: (1) silent below watermark; (2) triggers at >=20 closed turns or >=60k compactable tokens with exact turn:A..turn:B and Top 3 callId, latches identical string per compaction cycle without floating-point k numbers; (3) disappears after compaction', async () => {
  const { sessions, tokenMeter, registeredTools, promptContexts, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-soft-watermark-turns', { meta: { cwd: TEST_CWD } })
  const compactTool = registeredTools.get('context_compact')
  const directoryCtx = promptContexts.get('context-compact:directory')
  const ctrl = new AbortController()
  const fakeAgent = { id: 'agent-watermark-1', session }

  // (1) Add 10 closed turns (< 20 turns, < 60k compactable tokens) -> NO watermark hint
  for (let t = 1; t <= 10; t++) {
    const lines = t === 2 ? 95 : t === 5 ? 80 : t === 8 ? 65 : 20
    const out = Array.from({ length: lines }, (_, i) => `T${t}_L${i + 1}: payload_${t}_${i + 1} ${'X'.repeat(32)}`).join('\n')
    const toolName = t === 5 ? 'grep' : 'read'
    addCompleteTurnWithTool(session, t, `call_wm_${t}`, toolName, out)
  }

  const eventsBeforeCheck1 = session.events.length
  const wmBelow = inspectSoftWatermark(session, tokenMeter)
  assert.equal(wmBelow.triggered, false, 'should not trigger when turns < 20 and compactableTokens < 60k')
  assert.equal(wmBelow.hint, '')
  assert.equal(buildSoftWatermarkHint(session, tokenMeter), '')
  assert.equal(directoryCtx.text({ agent: fakeAgent }), '', 'below watermark must not emit a changing runtime-context directory')
  assert.equal(session.events.length, eventsBeforeCheck1, 'must not pollute session.events')

  // (2a) Continue to 24 closed turns -> triggers turn-based soft watermark (>= 20 turns), keeps recent 5 (20..24), suggests turn:1..turn:19 + Top 3 callIds
  for (let t = 11; t <= 24; t++) {
    const out = Array.from({ length: 18 }, (_, i) => `T${t}_L${i + 1}: small_${t}_${i + 1} ${'Y'.repeat(24)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_wm_${t}`, 'read', out)
  }

  session.append('turn/start', { turn: 25 })
  session.append('step/start', { turn: 25, step: 1 })
  const eventsSnapshotBeforeReq = session.events.length
  const surfaceSnapshotBeforeReq = [...session.surface.nodes]

  const wmTriggered = inspectSoftWatermark(session, tokenMeter)
  assert.equal(wmTriggered.triggered, true)
  assert.equal(wmTriggered.uncompactedClosedTurns, 24)
  assert.equal(wmTriggered.compactableTurns, 19)
  assert.deepEqual(wmTriggered.suggestedSpan && { from: wmTriggered.suggestedSpan.from, to: wmTriggered.suggestedSpan.to }, {
    from: 'turn:1',
    to: 'turn:19',
  })
  assert.equal(wmTriggered.topCandidates.length, 3)
  assert.deepEqual(
    wmTriggered.topCandidates.map((c) => `${c.callId}:${c.toolName}`),
    ['call_wm_2:read', 'call_wm_5:grep', 'call_wm_8:read']
  )
  assert.ok(wmTriggered.hint.includes('[context-compact 水位提醒: 待压缩池已达软水位（共 24 轮未压缩）'))
  assert.ok(!/~\d+\.\d+k/.test(wmTriggered.hint), 'hint must not contain real-time changing floating-point k numbers')
  assert.ok(wmTriggered.hint.includes('建议已完成区间: from:"auto", to:"auto"'))
  assert.ok(wmTriggered.hint.includes('call_wm_2(read,'))
  assert.ok(wmTriggered.hint.includes('call_wm_5(grep,'))
  assert.ok(wmTriggered.hint.includes('call_wm_8(read,'))

  const firstContextText = directoryCtx.text({ agent: fakeAgent })
  const firstLatchedHint = buildSoftWatermarkHint(session, tokenMeter)
  assert.ok(firstContextText.includes('建议已完成区间: from:"auto", to:"auto"'))
  assert.equal(session.events.length, eventsSnapshotBeforeReq, 'session.events must remain completely untouched')
  assert.deepEqual(session.surface.nodes, surfaceSnapshotBeforeReq, 'session.surface.nodes must remain untouched')

  // (2b) Finish turn 25 without compacting and advance to turn 26 -> systemPrompt.context MUST stay byte-for-byte identical
  // within the same compaction cycle (no new compaction/* event), preventing host from appending new user/message snapshots every turn!
  session.append('step/end', { turn: 25, step: 1 })
  session.append('turn/end', { turn: 25, reason: { kind: 'completed' } })
  const out26 = Array.from({ length: 18 }, (_, i) => `T26_L${i + 1}: small_26_${i + 1} ${'Y'.repeat(24)}`).join('\n')
  addCompleteTurnWithTool(session, 26, 'call_wm_26', 'read', out26)
  session.append('turn/start', { turn: 27 })
  session.append('step/start', { turn: 27, step: 1 })

  const wmTurn27Live = inspectSoftWatermark(session, tokenMeter)
  assert.equal(wmTurn27Live.uncompactedClosedTurns, 25)
  assert.equal(wmTurn27Live.suggestedSpan.to, 'turn:20')
  assert.equal(buildSoftWatermarkHint(session, tokenMeter), firstLatchedHint, 'latched watermark hint must stay identical before any new compaction')
  assert.equal(directoryCtx.text({ agent: fakeAgent }), firstContextText, 'systemPrompt.context output must remain identical across turns in same compaction cycle')

  // (3) Compact turn:1..turn:20 -> watermark drops to 5 uncompacted turns (0 compactable turns/tokens) and latched hint disappears!
  await compactTool.execute({
    spans: [{ from: 'turn:1', to: 'turn:20', summary: 'Turns 1-20 telegraphic checkpoint: anchors verified.' }],
  }, { callId: 'call_compact_wm', agent: fakeAgent, signal: ctrl.signal })

  // Even while staged in the current turn, watermark immediately recognizes the staged span and stops nagging
  assert.equal(inspectSoftWatermark(session, tokenMeter).triggered, false, 'staged span immediately clears watermark in same turn')
  assert.equal(buildSoftWatermarkHint(session, tokenMeter), '', 'staged compaction immediately clears latched hint')

  session.append('step/end', { turn: 27, step: 1 })
  await emitTurnStopping(fakeAgent, 27, ctrl.signal)
  session.append('turn/end', { turn: 27, reason: { kind: 'completed' } })

  const wmAfterCompact = inspectSoftWatermark(session, tokenMeter)
  assert.equal(wmAfterCompact.triggered, false, 'watermark must disappear after compacting turn:1..turn:20')
  assert.equal(wmAfterCompact.compactableTurns, 0)
  assert.equal(wmAfterCompact.compactableTokens, 0, 'compactableTokens must reset to 0 right after compaction')
  assert.equal(wmAfterCompact.uncompactedClosedTurns, 5)
  assert.equal(wmAfterCompact.hint, '')
  assert.equal(buildSoftWatermarkHint(session, tokenMeter), '')
})

test('incremental compactableTokens watermark: high baseline (compacted summaries + recent 5 turns occupying >70k tokens) NEVER false-triggers until new compactableTokens >= 60k', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-soft-watermark-delta-pool', { meta: { cwd: TEST_CWD } })

  // Step 1: Create 6 early turns (~36k tokens) and compact turns 1..6 into a historical checkpoint (~20k tokens)
  for (let t = 1; t <= 6; t++) {
    const out = Array.from({ length: 220 }, (_, i) => `HIST_${t}_${i}: ${'H'.repeat(100)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_hist_${t}`, 'read', out)
  }
  const hugeHistoricalSummary = Array.from({ length: 240 }, (_, i) => `checkpoint_anchor_${i}:${'S'.repeat(300)}`).join('\n')
  const histPlan = planSpanCompaction(session, tokenMeter, {
    from: 'turn:1',
    to: 'turn:6',
    summary: hugeHistoricalSummary,
  }, 1)
  commitSpanCompaction(session, tokenMeter, histPlan)

  // Step 2: Add recent 5 turns (turns 7..11, protected by keepRecentTurns = 5) whose active dialogue occupies >55k tokens
  // Total surface tokens (historical summary + recent 5 turns) > 75,000 tokens (> 60k!), while compactableTokens === 0!
  for (let t = 7; t <= 11; t++) {
    const bigUserDialogue = Array.from({ length: 140 }, (_, i) => `Active dialogue turn ${t} line ${i}: ${'D'.repeat(320)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_recent_${t}`, 'read', 'short tool output < 500t', bigUserDialogue)
  }

  const wmHighBaseline = inspectSoftWatermark(session, tokenMeter)
  assert.ok(
    wmHighBaseline.surfaceTokens >= 70000,
    `Expected total surfaceTokens >= 70000 to test high-baseline immunity, got ${wmHighBaseline.surfaceTokens}`
  )
  assert.equal(wmHighBaseline.compactableTokens, 0, 'compactableTokens must be 0 when only historical summaries + recent 5 turns exist')
  assert.equal(wmHighBaseline.compactableTurns, 0)
  assert.equal(wmHighBaseline.triggered, false, 'MUST NOT false-trigger when baseline is >70k but compactableTokens is 0')
  assert.equal(wmHighBaseline.hint, '')

  // Step 3: Accumulate 3 new turns (turns 12..14, pushing turns 7..9 into the compactable span turn:7..turn:9)
  // Because turns 7..9 had >30k tokens + we add another ~35k in turn 12 so turn:7..turn:10 exceeds 60k compactableTokens:
  const hugeToolOut7 = Array.from({ length: 280 }, (_, i) => `DELTA_BIG_${i}: ${'M'.repeat(320)}`).join('\n')
  addCompleteTurnWithTool(session, 12, 'call_delta_12', 'read', hugeToolOut7)
  for (let t = 13; t <= 17; t++) {
    addCompleteTurnWithTool(session, t, `call_delta_${t}`, 'grep', 'small recent output')
  }

  // Now uncompacted closed turns are 7..17 (11 turns < 20), recent 5 turns are 13..17,
  // and the compactable span is turn:7..turn:12 whose compactableTokens >= 60,000!
  const wmDeltaTriggered = inspectSoftWatermark(session, tokenMeter)
  assert.equal(wmDeltaTriggered.uncompactedClosedTurns, 11, 'only 11 uncompacted closed turns (< 20 turn threshold)')
  assert.ok(
    wmDeltaTriggered.compactableTokens >= 60000,
    `Expected compactableTokens >= 60000, got ${wmDeltaTriggered.compactableTokens}`
  )
  assert.equal(wmDeltaTriggered.triggered, true, 'must trigger once compactableTokens >= 60000 even with < 20 turns')
  assert.equal(wmDeltaTriggered.reason, 'tokens')
  assert.deepEqual(
    { from: wmDeltaTriggered.suggestedSpan.from, to: wmDeltaTriggered.suggestedSpan.to },
    { from: 'turn:7', to: 'turn:12' }
  )
  assert.ok(wmDeltaTriggered.hint.includes('建议已完成区间: from:"auto", to:"auto"'))
  assert.ok(wmDeltaTriggered.hint.includes('call_delta_12(read,'))

  // Step 4: Compact turn:7..turn:12 -> compactableTokens drops back to 0 even though surfaceTokens is still >25k!
  const deltaPlan = planSpanCompaction(session, tokenMeter, {
    from: 'turn:7',
    to: 'turn:12',
    summary: 'Turns 7-12 telegraphic summary.',
  }, 1)
  commitSpanCompaction(session, tokenMeter, deltaPlan)

  const wmAfterDeltaCompact = inspectSoftWatermark(session, tokenMeter)
  assert.equal(wmAfterDeltaCompact.compactableTokens, 0, 'compactableTokens must return to 0 after compacting turn:7..turn:12')
  assert.equal(wmAfterDeltaCompact.triggered, false, 'watermark must clear immediately after compacting the delta pool')
})

test('system-prompt snapshots do not inflate watermark and prompt context reuses measurement per surface version', async () => {
  const { sessions, tokenMeter, promptContexts } = await createTestHarness()
  const session = sessions.prepare('test-watermark-system-prompt-snapshot', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 6; t++) {
    addCompleteTurnWithTool(session, t, `call_snapshot_${t}`, 'read', `small tool output ${t}`)
  }
  const before = inspectSoftWatermark(session, tokenMeter)

  session.append('user/message', {
    id: 'persisted-system-prompt-snapshot',
    role: 'user',
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    content: [{ type: 'text', text: `persisted dynamic context ${'P'.repeat(120000)}` }],
  }, { surfaceOp: 'append' })

  const after = inspectSoftWatermark(session, tokenMeter)
  assert.ok(after.surfaceTokens > before.surfaceTokens, 'the persisted snapshot must really be on the surface')
  assert.equal(after.compactableTokens, before.compactableTokens, 'persisted system-prompt snapshots must not raise the compactable pool')
  assert.equal(after.triggered, before.triggered)

  const directoryCtx = promptContexts.get('context-compact:directory')
  const agent = { id: 'agent-watermark-cache', session }
  const originalMeasure = tokenMeter.measure.bind(tokenMeter)
  let measureCalls = 0
  tokenMeter.measure = (s) => {
    measureCalls += 1
    return originalMeasure(s)
  }
  try {
    const first = directoryCtx.text({ agent })
    const second = directoryCtx.text({ agent })
    assert.equal(second, first)
    assert.equal(measureCalls, 1, 'directory and watermark share one measurement until the surface changes')
    session.append('user/message', {
      id: 'surface-cache-buster',
      role: 'user',
      source: { kind: 'human' },
      content: [{ type: 'text', text: 'new surface version' }],
    }, { surfaceOp: 'append' })
    directoryCtx.text({ agent })
    assert.equal(measureCalls, 2, 'a new surface version must invalidate the measurement cache')
  } finally {
    tokenMeter.measure = originalMeasure
  }
})

function surfaceSeqsForTurns(session, minTurn, maxTurn) {
  const logInfo = inspectSessionLog(session)
  const seqs = []
  for (const seq of session.surface.nodes) {
    const nt = resolveSurfaceNodeTurns(session, seq, logInfo)
    if (nt.minTurn >= minTurn && nt.maxTurn <= maxTurn && nt.minTurn > 0) seqs.push(seq)
  }
  return seqs
}

function plantSummaryCheckpoint(session, fromTurn, toTurn, text) {
  const seqs = surfaceSeqsForTurns(session, fromTurn, toTurn)
  assert.ok(seqs.length > 0, `expected surface nodes for T${fromTurn}..T${toTurn}`)
  const nodes = [...session.surface.nodes]
  const startPos = nodes.indexOf(seqs[0])
  const endPos = nodes.indexOf(seqs[seqs.length - 1])
  assert.deepEqual(nodes.slice(startPos, endPos + 1), seqs, 'planted range must be one contiguous surface run')
  const msg = createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(`plant-${fromTurn}-${toTurn}`),
  })
  session.append('user/message', msg, {
    surfaceOp: { op: 'replace', start: seqs[0], end: seqs[seqs.length - 1] },
    sourceEventSeqs: seqs,
  })
}

test('summary @auto is deterministic, bounded, supports a judgement tail and rejects epoch merge', async () => {
  const { buildAutoSpanDigest, parseAutoSummary, planSpanCompaction } = await import('../lib/index.js')
  assert.deepEqual(parseAutoSummary('@auto root cause'), { auto: true, tail: 'root cause' })
  const session = { events: [], surface: { nodes: [] } }
  session.events.push({ seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'implement protocol' }] } })
  const digest = buildAutoSpanDigest(session, { eventTurnMap: new Map([[0, 1]]) }, [0])
  assert(digest.includes('implement protocol') && digest.length <= 300)
  assert.throws(() => planSpanCompaction(session, { measure: () => ({ nodes: [] }) }, { to: 'turn:1', summary: '@auto', mergeSummaries: true, now: Date.now() + 300000 }), /mergeSummaries/)
})

test('Pillar 2: closing-turn heavy output auto-compacts and recalls losslessly', async () => {
  const { sessions, tokenMeter, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-pillar2-auto-result', { meta: { cwd: TEST_CWD } })
  const text = Array.from({ length: 900 }, (_, i) => `AUTO_${i + 1}: unique_anchor_${i + 1} ${'Z'.repeat(40)}`).join('\n')
  addCompleteTurnWithTool(session, 1, 'call_auto_heavy', 'read', text)
  assert.ok(tokenMeter.measure(session).nodes.find((n) => n.seq === session.events.findLast((e) => e?.type === 'tool/result')?.seq).tokens >= 4000)
  const before = tokenMeter.measure(session).surfaceTokens
  await emitTurnStopping({ id: 'agent-auto', session }, 1, new AbortController().signal)
  const compacted = session.deriveMessages().find((m) => m.source?.kind === 'tool' && m.source.callId === 'call_auto_heavy')
  const digest = compacted.content[0].content[0].text
  assert.ok(digest.startsWith('[Compact-Auto] read ('))
  assert.ok(digest.includes('AUTO_1:'))
  assert.ok(digest.includes('AUTO_900:'))
  assert.ok(digest.includes('[recall: @call:call_auto_heavy]'))
  assert.ok(tokenMeter.measure(session).surfaceTokens < before)
  const recall = executeRecall(session, { target: '@call:call_auto_heavy', query: 'unique_anchor_777', context_lines: 0 })
  assert.ok(recall.text.includes('unique_anchor_777'))
  assert.ok(session.events.some((e) => e?.type === 'compaction/prune'))
  await emitTurnStopping({ id: 'agent-auto', session }, 1, new AbortController().signal)
  assert.equal(session.events.filter((e) => e?.type === 'compaction/prune').length, 1, 'auto archive must be idempotent')
})

test('Pillar 3: tier cliff guard triggers independently of the normal soft watermark', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-pillar3-tier-cliff', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 22; t++) {
    const output = Array.from({ length: 110 }, (_, i) => `TIER_${t}_${i}: ${'T'.repeat(300)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_tier_${t}`, 'read', output)
  }
  const status = inspectSoftWatermark(session, tokenMeter, { keepRecentTurns: 0 })
  assert.ok(status.surfaceTokens >= 180000, `surface=${status.surfaceTokens}`)
  assert.ok(status.compactableTokens >= 10000, `compactable=${status.compactableTokens}`)
  assert.equal(status.tierCliffTriggered, true)
  assert.equal(status.triggered, true)
  assert.ok(status.hint.includes('[逼近200k计费阶梯]'))
})

test('180K tier cliff commits immediately in a 1M window without conclude_turn', async () => {
  const { sessions, tokenMeter, registeredTools } = await createTestHarness()
  const session = sessions.prepare('test-tier-cliff-immediate', { meta: { cwd: TEST_CWD } })
  for (let turn = 1; turn <= 22; turn++) {
    const output = Array.from({ length: 80 }, (_, i) => `CLIFF_${turn}_${i}: ${'C'.repeat(400)}`).join('\n')
    addCompleteTurnWithTool(session, turn, `call_cliff_${turn}`, 'read', output)
  }
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 1048576 })
  const before = tokenMeter.measure(session)
  assert.ok(before.totalTokens >= 180000, `total=${before.totalTokens}`)
  assert.ok(before.totalTokens / 1048576 < 0.70)
  assert.ok(getStagedQueueSnapshot(session).results.length === 0)
  session.append('turn/start', { turn: 19 })
  session.append('step/start', { turn: 19, step: 1 })
  const out = await registeredTools.get('context_compact').execute({
    results: [{ callId: 'call_cliff_1', summary: 'Tier cliff result committed immediately.' }],
  }, { callId: 'call_cliff_compact', agent: { id: 'agent-cliff', session }, signal: new AbortController().signal })
  assert.ok(out.text.includes('[Compact committed immediately:'), out.text)
  assert.ok(!out.text.includes('staged for turn-stopping'), out.text)
  assert.equal(getStagedQueueSnapshot(session).results.length, 0)
  assert.ok(tokenMeter.measure(session).surfaceTokens < before.surfaceTokens)
})

test('Pillar 3: relay_dispatch free-ride lowers watermark and current-turn result is prioritized', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-pillar3-piggyback', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 8; t++) {
    const output = Array.from({ length: 65 }, (_, i) => `PIG_${t}_${i}: ${'P'.repeat(30)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_pig_${t}`, 'read', output)
  }
  session.append('turn/start', { turn: 9 })
  session.append('step/start', { turn: 9, step: 1 })
  const baseline = inspectSoftWatermark(session, tokenMeter)
  assert.equal(baseline.triggered, false)
  const c = session.append('assistant/chunk', { turn: 9, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call_relay', name: 'relay_dispatch', argumentsDelta: '{}' } })
  session.append('assistant/message', { turn: 9, step: 1, message: { id: 'a-pig-9', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call_relay', name: 'relay_dispatch', arguments: '{}' }] } }, { surfaceOp: 'append', sourceEventSeqs: [c.seq] })
  const call = session.append('tool/call', { turn: 9, step: 1, callId: 'call_relay', name: 'relay_dispatch', arguments: '{}' })
  session.append('tool/result', { turn: 9, step: 1, message: { id: 'r-relay', role: 'user', source: { kind: 'tool', callId: 'call_relay' }, content: [{ type: 'tool-result', toolCallId: 'call_relay', content: [{ type: 'text', text: `job accepted ${'R'.repeat(7000)}` }] }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const status = inspectSoftWatermark(session, tokenMeter)
  assert.equal(status.freeRide.active, true)
  assert.equal(status.softWatermarkTokens, 20000)
  assert.equal(status.softWatermarkTurns, 8)
  assert.equal(status.triggered, true)
  assert.equal(status.topCandidates[0].callId, 'call_relay')
  assert.equal(status.topCandidates[0].currentTurn, true)
  assert.ok(status.openTurnLargeResults[0].tokens >= 1500)
  assert.ok(status.hint.includes('Top结果:'))
  assert.ok(status.hint.includes('当轮'))
  assert.ok(status.hint.includes('搭便车窗口'))
})

test('Pillar 3: mergeSummaries creates an L1 epoch with recursive lossless recall', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-pillar3-epoch', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 10; t++) {
    const out = Array.from({ length: 60 }, (_, i) => `EPOCH_${t}_${i}: ${'E'.repeat(25)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_epoch_${t}`, 'read', out)
    commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, {
      from: `turn:${t}`, to: `turn:${t}`, summary: `L0 summary turn ${t}; anchor EPOCH_${t}_59.`,
    }, 1))
  }
  const leavesBeforeMerge = new Set(session.events.filter((ev) => ev?.type === 'user/message' && ev.surfaceOp !== 'append').flatMap((ev) => resolveLeafSurfaceSeqs(session.events, [ev.seq])))
  session.append('turn/start', { turn: 11 })
  session.append('step/start', { turn: 11, step: 1 })
  const watermark = inspectSoftWatermark(session, tokenMeter)
  assert.equal(watermark.summaryNodeCount, 10)
  assert.equal(watermark.suggestedEpochMerge, null, 'hot cache never suggests an epoch merge')
  const coldNow = Date.now() + 300000
  const coldWatermark = inspectSoftWatermark(session, tokenMeter, { now: coldNow })
  assert.equal(coldWatermark.suggestedEpochMerge.summaryCount, 8)
  assert.deepEqual({ from: coldWatermark.suggestedEpochMerge.from, to: coldWatermark.suggestedEpochMerge.to }, { from: 'turn:1', to: 'turn:8' })
  assert.throws(() => planSpanCompaction(session, tokenMeter, { ...watermark, ...coldWatermark.suggestedEpochMerge, summary: 'hot merge rejected' }, 1), /cold start/)
  const compactTool = registeredTools.get('context_compact')
  const agent = { id: 'agent-epoch', session }
  const clock = Date.now
  Date.now = () => coldNow
  let staged
  try {
    staged = await compactTool.execute({ spans: [{ ...coldWatermark.suggestedEpochMerge, summary: 'L1 epoch turns 1-8.' }] }, { callId: 'call_epoch_merge', agent, signal: new AbortController().signal })
    assert.ok(staged.text.includes('staged'))
    session.append('step/end', { turn: 11, step: 1 })
    await emitTurnStopping(agent, 11, new AbortController().signal)
  } finally { Date.now = clock }

  const summaryEvents = session.events.filter((e) => e?.type === 'user/message' && e.surfaceOp !== 'append')
  const l1 = summaryEvents.at(-1)
  assert.ok(l1.sourceEventSeqs.length > 0)
  const leavesAfterMerge = new Set(session.events.filter((ev) => ev?.type === 'user/message' && ev.surfaceOp !== 'append' && session.surface.nodes.includes(ev.seq)).flatMap((ev) => resolveLeafSurfaceSeqs(session.events, [ev.seq])))
  assert.deepEqual(leavesAfterMerge, leavesBeforeMerge, 'dedup preserves every original leaf')
  assert.equal(session.surface.nodes.filter((seq) => summaryEvents.some((ev) => ev.seq === seq)).length, 3, `eight old L0 nodes leave the surface; new epoch and recent two remain; staged=${staged.text}`)
  const recalled = executeRecall(session, { target: '@turn:8', query: 'EPOCH_8_59', context_lines: 0 })
  assert.ok(recalled.text.includes('EPOCH_8_59'))
  const spanTag = /(@span:S\d+-\d+(?:\+S\d+-\d+)*(?: turns:[\d,..-]+)?)/.exec(session.events[l1.seq].data.content.map((b) => b.text).join('\n'))?.[1]
  assert.ok(spanTag)
  assert.ok(executeRecall(session, { target: spanTag, query: 'EPOCH_1_59', context_lines: 0 }).text.includes('EPOCH_1_59'))
})


test('ordinary span compaction absorbs fully covered old summaries without extra model output', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-ordinary-dedup', { meta: { cwd: TEST_CWD } })
  for (let turn = 1; turn <= 3; turn++) addCompleteTurnWithTool(session, turn, `ordinary_${turn}`, 'read', `ORDINARY_${turn} ${'x'.repeat(1800)}`)
  commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, { from: 'turn:1', to: 'turn:1', summary: 'ordinary L0 one' }, 1))
  const firstSeq = session.surface.nodes.find((seq) => session.events[seq]?.type === 'user/message' && session.events[seq]?.surfaceOp !== 'append')
  const epoch = planSpanCompaction(session, tokenMeter, { from: 'turn:1', to: 'turn:2', summary: 'owner covers old summary', mergeSummaries: true, now: Date.now() + 300000 }, 1)
  commitSpanCompaction(session, tokenMeter, { ...epoch, now: Date.now() + 300000 })
  session.surface.nodes.unshift(firstSeq)
  const retainedBefore = session.surface.nodes.filter((seq) => seq !== firstSeq)
  assert(session.surface.nodes.includes(firstSeq), 'fixture retains a non-adjacent covered duplicate')
  const redundant = planSpanCompaction(session, tokenMeter, { from: 'turn:3', to: 'turn:3', summary: 'ordinary new span absorbs duplicate' }, 1)
  assert(redundant.redundantSummarySeqs.includes(firstSeq))
  assert(redundant.clusters.some((cluster) => cluster.seqs.length === 1 && cluster.seqs[0] === firstSeq))
  commitSpanCompaction(session, tokenMeter, redundant)
  assert(!session.surface.nodes.includes(firstSeq))
  for (const seq of retainedBefore.filter((seq) => !redundant.shadowedSeqs.includes(seq))) assert(session.surface.nodes.includes(seq), `unrelated surface seq ${seq} survives independent prune`)
  assert(session.events[firstSeq], 'append-only original checkpoint remains recallable')
  assert(executeRecall(session, { target: '@turn:1', query: 'ORDINARY_1', context_lines: 0 }).returnedLines > 0)
})

test('conclude eligibility admits only a successfully persisted context_compact sibling', () => {
  const session = { events: [], seq: 4 }
  session.events[1] = { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
    { type: 'text', text: 'Dispatched; compression committed.' },
    { type: 'tool-call', id: 'compact-sibling', name: 'context_compact', arguments: '{}' },
    { type: 'tool-call', id: 'dispatch-self', name: 'relay_dispatch', arguments: '{}' },
  ] } } }
  session.events[2] = { seq: 2, type: 'tool/call', data: { callId: 'compact-sibling', name: 'context_compact' } }
  const exec = { agent: { phase: { kind: 'running', turn: 1, step: 1 } } }
  assert.equal(checkConcludeTurnEligibility(session, exec, 'dispatch-self', ['context_compact']).canConclude, false)
  session.events[3] = { seq: 3, type: 'tool/result', data: { message: { isError: true, source: { callId: 'compact-sibling' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'failed' }] }] } } }
  assert.equal(checkConcludeTurnEligibility(session, exec, 'dispatch-self', ['context_compact']).reason, 'sibling-tool-not-successful')
  session.events[3].data.message.isError = false
  session.events[3].data.message.content[0].isError = false
  const allowed = checkConcludeTurnEligibility(session, exec, 'dispatch-self', ['context_compact'])
  assert.equal(allowed.canConclude, true, JSON.stringify(allowed))
  session.events[3] = undefined
  assert.equal(checkConcludeTurnEligibility(session, exec, 'dispatch-self').reason, 'other-tool-calls')
})

test('small read_image results auto-archive after two turns and stay recallable', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-image-auto-archive', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(session, 1, 'image_call', 'read_image', 'tiny')
  addCompleteTurnWithTool(session, 2, 'recent_text', 'read', 'keep this recent result')
  session.append('turn/start', { turn: 3 })
  session.append('step/start', { turn: 3, step: 1 })
  const watermark = inspectSoftWatermark(session, tokenMeter, { keepRecentTurns: 5 })
  assert.ok(watermark.topCandidates.some((candidate) => candidate.callId === 'image_call'))
  assert.ok(watermark.outsideSpanLargeResultTokens > 0)
  const ctrl = new AbortController()
  session.append('step/end', { turn: 3, step: 1 })
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  await emitTurnStopping({ id: 'agent-image', session }, 3, ctrl.signal)
  const derived = session.deriveMessages().find((m) => m.source?.callId === 'image_call')
  assert.match(derived.content[0].content[0].text, /\[Compact-Auto\].*read_image.*\[recall: @call:image_call\]/)
  assert.ok(!JSON.stringify(derived).includes('tiny'))
  assert.ok(executeRecall(session, { target: '@call:image_call', query: 'tiny', context_lines: 0 }).text.includes('tiny'))
  assert.ok(session.surface.nodes.some((seq) => session.events[seq]?.data?.message?.source?.callId === 'recent_text'))
})

test('deterministic summary dedup handles subsets, equal sets and partial overlap', async () => {
  const { findRedundantSummaryCheckpoints } = await import('../lib/index.js')
  const events = [
    { seq: 0, type: 'user/message', surfaceOp: 'append' },
    { seq: 1, type: 'user/message', surfaceOp: 'append' },
    { seq: 2, type: 'user/message', surfaceOp: 'append' },
    { seq: 3, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [0], data: { source: { kind: 'plugin', plugin: 'compact' } } },
    { seq: 4, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [0, 1], data: { source: { kind: 'plugin', plugin: 'compact' } } },
    { seq: 5, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [0], data: { source: { kind: 'plugin', plugin: 'compact' } } },
    { seq: 6, type: 'user/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [1, 2], data: { source: { kind: 'plugin', plugin: 'compact' } } },
  ]
  const session = { events, surface: { nodes: [3, 4, 5, 6] } }
  assert.deepEqual(findRedundantSummaryCheckpoints(session), [3, 5])
  assert.deepEqual(findRedundantSummaryCheckpoints(session, [4]), [3, 5])
})

test('sandwiched island turns stay in the compactable watermark pool', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-island-watermark', { meta: { cwd: TEST_CWD } })

  for (let t = 1; t <= 5; t++) {
    const out = Array.from({ length: 30 }, (_, i) => `ISL_EARLY_${t}_${i}: ${'E'.repeat(24)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_isl_early_${t}`, 'read', out)
  }
  commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, {
    from: 'turn:1',
    to: 'turn:5',
    summary: 'Turns 1-5 checkpoint.',
  }, 1))

  for (const t of [6, 7]) {
    const out = Array.from({ length: 80 }, (_, i) => `ISL_T${t}_${i}: ${'I'.repeat(48)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_isl_${t}`, 'read', out)
  }
  for (let t = 8; t <= 10; t++) {
    addCompleteTurnWithTool(session, t, `call_isl_mid_${t}`, 'read', `mid ${t} ${'M'.repeat(60)}`)
  }
  plantSummaryCheckpoint(session, 8, 10, 'Turns 8-10 checkpoint planted after the T6-T7 island.')
  for (let t = 11; t <= 15; t++) {
    addCompleteTurnWithTool(session, t, `call_isl_tail_${t}`, 'read', 'short tool output < 500t')
  }

  const wm = inspectSoftWatermark(session, tokenMeter)
  assert.deepEqual(wm.islandTurns, [6, 7])
  assert.deepEqual(wm.islandSpans, [{ from: 'turn:6', to: 'turn:7' }])
  assert.equal(wm.uncompactedClosedTurns, 7, 'island T6-T7 plus protected tail T11-T15')
  assert.equal(wm.compactableTurns, 2, 'keepRecent tail must not hide the sandwiched island')
  assert.equal(wm.triggered, false)
  assert.equal(wm.reason, 'warm-island-suppressed')
  assert.equal(wm.warmIslandSuppressed, true)
  assert.equal(wm.suggestedSpan.from, 'turn:6')
  assert.equal(wm.suggestedSpan.to, 'turn:7')
  assert.equal(wm.hint, '')
  const coldIsland = inspectSoftWatermark(session, tokenMeter, { now: Date.now() + 300001 })
  assert.equal(coldIsland.triggered, true)
  assert.equal(coldIsland.reason, 'islands')
  assert.ok(coldIsland.hint.includes('待补压孤岛区间: turn:6..turn:7'))

  const logInfo = inspectSessionLog(session)
  const priced = new Map(tokenMeter.measure(session).nodes.map((n) => [n.seq, n.tokens]))
  let islandTokens = 0
  for (const seq of session.surface.nodes) {
    const ev = session.events[seq]
    const nt = resolveSurfaceNodeTurns(session, seq, logInfo)
    if (ev?.surfaceOp === 'append' && (nt.minTurn === 6 || nt.minTurn === 7)) {
      islandTokens += priced.get(seq) ?? 0
    }
  }
  assert.ok(islandTokens > 0)
  assert.equal(wm.spanCompactableTokens, islandTokens)
  assert.equal(wm.compactableTokens, islandTokens)
})

test('planSpanCompaction auto-bridges the preceding island and keeps the summary prefix immutable', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-island-bridge', { meta: { cwd: TEST_CWD } })

  for (let t = 1; t <= 10; t++) {
    const out = Array.from({ length: 70 }, (_, i) => `BR_${t}_${i}: ${'B'.repeat(36)}`).join('\n')
    addCompleteTurnWithTool(session, t, `call_br_${t}`, 'read', out)
  }
  const committedPrefix = commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, {
    from: 'turn:1',
    to: 'turn:5',
    summary: 'Turns 1-5 immutable prefix.',
  }, 1))
  const prefixSeq = committedPrefix.replaceEventSeq
  const prefixBefore = structuredClone(session.events[prefixSeq])
  const t6Seqs = surfaceSeqsForTurns(session, 6, 6)
  assert.ok(t6Seqs.length > 0)

  const plan = planSpanCompaction(session, tokenMeter, {
    from: 'turn:7',
    to: 'turn:10',
    summary: 'Bridge T6 into the T7-T10 span.',
  }, 1)
  assert.equal(plan.resolvedFrom, 'turn:6')
  assert.equal(plan.resolvedTo, 'turn:10')
  for (const seq of t6Seqs) {
    assert.ok(plan.shadowedSeqs.includes(seq), `T6 seq ${seq} must be bridged into T7..T10`)
  }
  assert.ok(!plan.shadowedSeqs.includes(prefixSeq))

  const snapped = planSpanCompaction(session, tokenMeter, {
    from: 'turn:3',
    to: 'turn:10',
    summary: 'Start landed inside the existing summary.',
  }, 1)
  assert.equal(snapped.resolvedFrom, 'turn:6')
  assert.equal(snapped.resolvedTo, 'turn:10')
  assert.ok(!snapped.shadowedSeqs.includes(prefixSeq))

  const committed = commitSpanCompaction(session, tokenMeter, plan)
  assert.deepEqual(session.events[prefixSeq], prefixBefore, 'historical summary bytes must stay immutable')
  assert.ok(session.surface.nodes.includes(prefixSeq))
  assert.equal(session.surface.nodes[0], prefixSeq, 'summary prefix stays at the surface head')
  for (const seq of t6Seqs) {
    assert.ok(!session.surface.nodes.includes(seq))
  }
  assert.ok(session.surface.nodes.includes(committed.replaceEventSeq))
  assert.ok(committed.shadowedSeqs.includes(t6Seqs[0]))
  assert.ok(!committed.shadowedSeqs.includes(prefixSeq))
})

test('v3 from auto starts at turn 1, then the physical turn after latest checkpoint', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-v3-auto', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 5; t++) addCompleteTurnWithTool(session, t, `v3_auto_${t}`, 'read', `AUTO_${t} ${'x'.repeat(1200)}`)
  const initial = planSpanCompaction(session, tokenMeter, { from: 'auto', to: 'turn:2', summary: 'Initial auto range.' }, 1)
  assert.equal(initial.resolvedFrom, 'turn:1')
  commitSpanCompaction(session, tokenMeter, initial)
  const next = planSpanCompaction(session, tokenMeter, { from: 'latest-compacted', to: 'turn:4', summary: 'Next physical uncompacted turns.' }, 1)
  assert.equal(next.resolvedFrom, 'turn:3')
  assert.ok(!next.shadowedSeqs.includes(session.surface.nodes[0]))
  assert.equal(planSpanCompaction(session, tokenMeter, { to: 'turn:4', summary: 'Omitted from means auto.' }, 1).resolvedFrom, 'turn:3')
})

test('v3 global history search traverses nested checkpoints and deduplicates leaves', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-v3-index', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 4; t++) addCompleteTurnWithTool(session, t, `v3_idx_${t}`, 'read', `GLOBAL_NEEDLE_${t} ${'x'.repeat(1200)}`)
  commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, { from: 'turn:1', to: 'turn:2', summary: 'L0 global search.', }, 1))
  commitSpanCompaction(session, tokenMeter, { ...planSpanCompaction(session, tokenMeter, { from: 'turn:1', to: 'turn:3', summary: 'L1 global search.', mergeSummaries: true, now: Date.now() + 300000 }, 1), now: Date.now() + 300000 })
  for (const target of ['@index', '@all', '@search']) {
    const hit = executeRecall(session, { target, query: 'GLOBAL_NEEDLE_1', context_lines: 0 })
    assert.equal(hit.returnedLines > 0, true)
    assert.equal((hit.text.match(/\d+: GLOBAL_NEEDLE_1/g) || []).length, 1)
    assert.ok(hit.text.includes('@call:v3_idx_1') && hit.text.includes('@span:S') && hit.text.includes('turn:1'))
  }
  const page = executeRecall(session, { target: '@index', query: 'GLOBAL_NEEDLE', context_lines: 0, line_range: [1, 2] })
  assert.equal(page.hasMore, true)
  assert.deepEqual(page.nextLineRange, [3, page.totalLines])
})

test('v3 idle system-prompt observation commits staged work after five minutes', async () => {
  const { sessions, tokenMeter, registeredTools, promptContexts } = await createTestHarness()
  const session = sessions.prepare('test-v3-idle', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(session, 1, 'v3_idle_1', 'read', `IDLE_OLD ${'x'.repeat(1500)}`)
  session.append('turn/start', { turn: 2 })
  const agent = { session }
  const tool = registeredTools.get('context_compact')
  const staged = await tool.execute({ results: [{ callId: 'v3_idle_1', summary: 'idle flush' }] }, { callId: 'v3_idle_stage', agent, signal: new AbortController().signal })
  assert.ok(staged.text.includes('staged'))
  session.append('assistant/message', { turn: 2, step: 1, time: Date.now() - 301000, message: { role: 'assistant', content: [{ type: 'text', text: 'idle boundary' }] } }, { surfaceOp: 'append' })
  const context = promptContexts.get('context-compact:directory')
  context.text({ agent })
  assert.equal(getStagedQueueSnapshot(session).results.length, 0)
  assert.equal(session.surface.nodes.some((seq) => session.events[seq].surfaceOp !== 'append'), true)
})

function bulkyNeedleOutput(turn, needle, lines = 80) {
  return Array.from({ length: lines }, (_, i) => `T${turn}_L${i + 1}: ${needle}_${i + 1} ${'X'.repeat(30)}`).join('\n')
}

function surfaceTextBlob(session) {
  return session.deriveMessages().map((m) => JSON.stringify(m)).join('\n')
}

function surfaceSeqsForTurn(session, turn) {
  const logInfo = inspectSessionLog(session)
  return session.surface.nodes.filter((seq) => resolveSurfaceNodeTurns(session, seq, logInfo).turns.has(turn))
}

function checkpointMessages(session) {
  return session.deriveMessages().filter((m) => m.source?.plugin === 'compact')
}

test('cold-wake hook flushes staged work and archives the latest closed heavy result', async () => {
  const { sessions, tokenMeter, registeredTools } = await createTestHarness()
  const session = sessions.prepare('test-cold-wake', { meta: { cwd: TEST_CWD } })
  const big = Array.from({ length: 900 }, (_, i) => `COLD_${i}: ${'C'.repeat(40)}`).join('\n')
  addCompleteTurnWithTool(session, 1, 'cold_wake_big', 'read', big)
  session.append('turn/start', { turn: 2 })
  const agent = { session }
  const tool = registeredTools.get('context_compact')
  await tool.execute({ results: [{ callId: 'cold_wake_big', summary: 'staged cold-wake digest' }] }, { callId: 'cold_stage', agent, signal: new AbortController().signal })
  assert.equal(getStagedQueueSnapshot(session).results.length, 1)
  const hook = globalThis[Symbol.for('dsh.context-compact.hooks.v1')]?.flushBeforeColdWake
  assert.equal(typeof hook, 'function')
  const result = await hook(session.id, Date.now())
  assert.equal(result.flushed, true)
  assert.equal(getStagedQueueSnapshot(session).results.length, 0)
  assert.equal(isResultAlreadyCompacted(session, 'cold_wake_big').compacted, true)
  assert.equal(executeRecall(session, { target: '@call:cold_wake_big', query: 'COLD_899', context_lines: 0 }).returnedLines, 1)
})

test('spans[].turns parsers: number, turn:, range, turnsBack vs latest closed, duplicates, open-turn drop', async () => {
  const { sessions } = await createTestHarness()
  const session = sessions.prepare('test-turns-parse', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 5; t++) addCompleteTurnWithTool(session, t, `parse_${t}`, 'read', bulkyNeedleOutput(t, `PARSE_${t}`))

  const closedLog = inspectSessionLog(session)
  assert.equal(closedLog.openTurn, null)
  assert.equal(latestClosedTurn(closedLog), 5)
  assert.deepEqual(parseTurnsToken('turnsBack:1', latestClosedTurn(closedLog)), [5])
  assert.deepEqual(parseTurnsToken('turnsBack:3', latestClosedTurn(closedLog)), [3])
  assert.deepEqual(resolveSpanTurns({ turns: ['turnsBack:1'] }, closedLog), [5])

  session.append('turn/start', { turn: 6 })
  session.append('step/start', { turn: 6, step: 1 })
  const openLog = inspectSessionLog(session)
  assert.equal(openLog.openTurn, 6)
  assert.equal(latestClosedTurn(openLog), 5)
  assert.deepEqual(parseTurnsToken(226, 5), [226])
  assert.deepEqual(parseTurnsToken('226', 5), [226])
  assert.deepEqual(parseTurnsToken('turn:226', 5), [226])
  assert.deepEqual(parseTurnsToken('235..237', 5), [235, 236, 237])
  assert.deepEqual(parseTurnsToken('turn:235..turn:237', 5), [235, 236, 237])
  assert.deepEqual(parseTurnsToken('turnsBack:1', 5), [5])
  assert.deepEqual(parseTurnsToken('turnsBack:3', 5), [3])
  assert.deepEqual(
    resolveSpanTurns({ turns: [2, 2, '2..3', 'turn:2', 'turnsBack:3', 6] }, openLog),
    [2, 3],
  )
  assert.throws(() => resolveSpanTurns({ turns: [6] }, openLog), /open turn/)
  assert.throws(() => parseTurnsToken('turnsBack:0', 5), /must be >= 1/)
  assert.throws(() => parseTurnsToken('237..235', 5), /start 237 > end 235/)
  assert.throws(() => parseTurnsToken('nope', 5), /unrecognized turns selector/)
  assert.throws(() => parseTurnsToken('turnsBack:99', 5), /resolves to turn/)
})

test('non-contiguous spans[].turns keeps unselected turns; span/index recall is exact', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-turns-noncontiguous', { meta: { cwd: TEST_CWD } })

  const needles = {
    1: 'KEEP_T1',
    2: 'COMPACT_T2',
    3: 'KEEP_T3',
    4: 'COMPACT_T4',
    5: 'COMPACT_T5',
    6: 'KEEP_T6',
    7: 'COMPACT_T7',
    8: 'KEEP_T8',
  }
  for (let t = 1; t <= 8; t++) {
    addCompleteTurnWithTool(session, t, `nc_${t}`, 'read', bulkyNeedleOutput(t, needles[t]))
  }

  const t3Before = surfaceSeqsForTurn(session, 3)
  const t6Before = surfaceSeqsForTurn(session, 6)
  assert.ok(t3Before.length > 0 && t6Before.length > 0)

  session.append('turn/start', { turn: 9 })
  session.append('step/start', { turn: 9, step: 1 })

  const plan = planSpanCompaction(session, tokenMeter, {
    turns: [2, '4..5', 'turn:7'],
    summary: 'Non-contiguous T2+T4-5+T7 checkpoint.',
  }, 1)

  assert.deepEqual(plan.resolvedTurns, [2, 4, 5, 7])
  assert.equal(plan.resolvedFrom, 'turn:2')
  assert.equal(plan.resolvedTo, 'turn:7')
  assert.equal(plan.to, 'turn:7')
  assert.ok(plan.clusters.length >= 3, 'selected turns are non-contiguous clusters')
  assert.ok(plan.recallTag.includes('+'), 'three or fewer physical ranges retain legacy format')
  const targetSet = new Set(plan.compactedSeqs)
  assert.equal(plan.sourceEventSeqs.length, plan.compactedSeqs.length)

  const logInfo = inspectSessionLog(session)
  for (const seq of plan.compactedSeqs) {
    const turns = resolveSurfaceNodeTurns(session, seq, logInfo).turns
    assert.equal([...turns].every((t) => [2, 4, 5, 7].includes(t)), true, `seq ${seq} must belong to selected turns`)
    assert.equal(session.events[seq].surfaceOp, 'append')
  }
  for (const keepTurn of [3, 6]) {
    for (const seq of surfaceSeqsForTurn(session, keepTurn)) {
      assert.equal(targetSet.has(seq), false, `unselected turn ${keepTurn} seq ${seq} must not be compacted`)
    }
  }

  const tokensBefore = tokenMeter.measure(session).surfaceTokens
  const committed = commitSpanCompaction(session, tokenMeter, plan)
  const tokensAfter = tokenMeter.measure(session).surfaceTokens
  assert.ok(tokensAfter < tokensBefore)
  assert.ok(committed.savings > 0)
  const blob = surfaceTextBlob(session)
  assert.ok(blob.includes('KEEP_T3'), 'Turn 3 must remain on the surface')
  assert.ok(blob.includes('KEEP_T6'), 'Turn 6 must remain on the surface')
  assert.ok(blob.includes('KEEP_T1') && blob.includes('KEEP_T8'))
  assert.ok(!blob.includes('COMPACT_T2_1'), 'Turn 2 original body must leave the surface')
  assert.ok(!blob.includes('COMPACT_T4_1'))
  assert.ok(!blob.includes('COMPACT_T5_1'))
  assert.ok(!blob.includes('COMPACT_T7_1'))
  assert.ok(blob.includes('KEEP_T3_1') && blob.includes('KEEP_T6_1'))

  const t3After = surfaceSeqsForTurn(session, 3)
  const t6After = surfaceSeqsForTurn(session, 6)
  assert.deepEqual(t3After, t3Before)
  assert.deepEqual(t6After, t6Before)

  const checkpoints = checkpointMessages(session)
  assert.equal(checkpoints.length, 1)
  for (const msg of session.deriveMessages()) {
    assert.ok(Array.isArray(msg.content) && msg.content.length > 0, `derived message ${msg.id} must have non-empty content (no content: [] tombstones)`)
    for (const block of msg.content) {
      if (block.type === 'text') assert.ok(typeof block.text === 'string' && block.text.trim().length > 0)
    }
  }
  const summaryText = checkpoints[0].content.map((b) => b.text ?? '').join('\n')
  assert.ok(summaryText.includes('<compacted-summary>'))
  const cpIndex = session.surface.nodes.indexOf(committed.replaceEventSeq)
  assert.ok(session.surface.nodes.slice(cpIndex + 1).includes(t3Before[0]), 'summary must precede retained island')
  const tombstones = session.surface.nodes.map((seq) => session.events[seq]).filter((ev) => ev.data?.source?.plugin === 'context-compact-elide')
  assert.equal(tombstones.length, plan.clusters.length - 1)
  assert.ok(tombstones.every((ev) => ev.data.content.length > 0 && ev.data.content[0].text.includes('summarized above')))
  const claims = session.events.filter((ev) => ev?.type === 'compaction/summary' || ev?.type === 'compaction/prune')
  for (const claim of claims.filter((ev) => ev.data?.compactionId === committed.compactionId || ev.seq > committed.startEventSeq && ev.seq < committed.endEventSeq)) {
    assert.equal(session.events[claim.seq + 1].surfaceOp.start, claim.data.shadowedRange.start)
    assert.equal(session.events[claim.seq + 1].surfaceOp.end, claim.data.shadowedRange.end)
  }
  assert.ok(summaryText.includes('Non-contiguous T2+T4-5+T7 checkpoint.'))
  const spanTag = /@span:S\d+-\d+(?:\+S\d+-\d+)*(?: turns:[\d,..-]+)?/.exec(summaryText)?.[0]
  assert.ok(spanTag)
  assert.ok(committed.recallTag.includes('+'))

  const spanRecall = executeRecall(session, { target: spanTag, query: 'COMPACT_T', context_lines: 0 })
  assert.ok(executeRecall(session, { target: spanTag, query: 'COMPACT_T2_1', context_lines: 0 }).text.includes('COMPACT_T2_1'))
  assert.ok(executeRecall(session, { target: spanTag, query: 'COMPACT_T4_1', context_lines: 0 }).text.includes('COMPACT_T4_1'))
  assert.ok(executeRecall(session, { target: spanTag, query: 'COMPACT_T5_1', context_lines: 0 }).text.includes('COMPACT_T5_1'))
  assert.ok(executeRecall(session, { target: spanTag, query: 'COMPACT_T7_1', context_lines: 0 }).text.includes('COMPACT_T7_1'))
  assert.equal(executeRecall(session, { target: spanTag, query: 'KEEP_T3_', context_lines: 0 }).returnedLines, 0)
  assert.equal(executeRecall(session, { target: spanTag, query: 'KEEP_T6_', context_lines: 0 }).returnedLines, 0)
  assert.equal(executeRecall(session, { target: spanTag, query: 'KEEP_T1_', context_lines: 0 }).returnedLines, 0)
  assert.equal(executeRecall(session, { target: spanTag, query: 'KEEP_T8_', context_lines: 0 }).returnedLines, 0)
  assert.ok(spanRecall.returnedLines > 0)
  const recalledTurns = new Set()
  for (const seq of spanRecall.leafSeqs) {
    const t = inspectSessionLog(session).eventTurnMap.get(seq)
    if (t) recalledTurns.add(t)
  }
  assert.deepEqual([...recalledTurns].sort((a, b) => a - b), [2, 4, 5, 7])

  const indexAll = executeRecall(session, { target: '@index', query: 'COMPACT_T2_', context_lines: 0 })
  const indexTurns = new Set()
  for (const seq of indexAll.leafSeqs) {
    const t = inspectSessionLog(session).eventTurnMap.get(seq)
    if (t) indexTurns.add(t)
  }
  assert.deepEqual([...indexTurns].sort((a, b) => a - b), [2, 4, 5, 7])
  for (const [needle, expectHit] of [
    ['COMPACT_T2_', true],
    ['COMPACT_T4_', true],
    ['COMPACT_T5_', true],
    ['COMPACT_T7_', true],
    ['KEEP_T3_', false],
    ['KEEP_T6_', false],
    ['KEEP_T1_', false],
    ['KEEP_T8_', false],
  ]) {
    const hit = executeRecall(session, { target: '@index', query: needle, context_lines: 0 })
    assert.equal(new RegExp(`\\d+: .*${needle}`).test(hit.text), expectHit, `@index ${needle}`)
  }

  const restored = sessions.prepare(session.id, {
    seed: structuredClone(session.events),
    meta: structuredClone(session.header),
    seedSource: 'persistence',
  })
  assert.deepEqual(restored.surface.nodes, session.surface.nodes)
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.equal(tokenMeter.measure(restored).surfaceTokens, tokenMeter.measure(session).surfaceTokens)
  const restoredRecall = executeRecall(restored, { target: spanTag, query: 'COMPACT_T5_10', context_lines: 0 })
  assert.ok(restoredRecall.text.includes('COMPACT_T5_10'))
  assert.equal(executeRecall(restored, { target: spanTag, query: 'KEEP_T3_', context_lines: 0 }).returnedLines, 0)
})

test('spans[].turns skips open turn, existing summaries unless mergeSummaries, and equivalent selectors', async () => {
  const { sessions, tokenMeter, registeredTools, emitTurnStopping } = await createTestHarness()
  const session = sessions.prepare('test-turns-boundaries', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 5; t++) {
    addCompleteTurnWithTool(session, t, `bd_${t}`, 'read', bulkyNeedleOutput(t, `BOUND_${t}`))
  }

  commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, {
    from: 'turn:3', to: 'turn:3', summary: 'Pre-existing T3 checkpoint.',
  }, 1))

  session.append('turn/start', { turn: 6 })
  session.append('step/start', { turn: 6, step: 1 })

  assert.throws(
    () => planSpanCompaction(session, tokenMeter, { turns: [6], summary: 'Open only.' }, 1),
    /open turn/,
  )
  assert.throws(
    () => planSpanCompaction(session, tokenMeter, { summary: 'Neither to nor turns.' }, 1),
    /requires to or turns/,
  )
  assert.throws(
    () => planSpanCompaction(session, tokenMeter, { turns: [2], summary: '   ' }, 1),
    /non-empty string/,
  )

  const skipped = planSpanCompaction(session, tokenMeter, {
    turns: [2, 3, 4, 6],
    summary: 'Skip T3 summary and open T6.',
  }, 1)
  assert.deepEqual(skipped.resolvedTurns, [2, 3, 4])
  const skipLog = inspectSessionLog(session)
  for (const seq of skipped.compactedSeqs) {
    const ev = session.events[seq]
    assert.equal(ev.surfaceOp, 'append')
    assert.equal(ev.data?.source?.plugin === 'compact', false)
    const turns = [...resolveSurfaceNodeTurns(session, seq, skipLog).turns]
    assert.equal(turns.some((t) => t === 3 && ev.type === 'user/message' && ev.surfaceOp !== 'append'), false)
    assert.ok(turns.every((t) => t !== 6))
  }
  assert.equal(skipped.compactedSeqs.some((seq) => session.events[seq].data?.source?.plugin === 'compact'), false)

  const viaRange = planSpanCompaction(session, tokenMeter, {
    turns: ['turn:2..turn:2', '4..4'],
    to: 'turn:4',
    summary: 'Equivalent range tokens.',
  }, 1)
  const viaMixed = planSpanCompaction(session, tokenMeter, {
    turns: [2, 'turn:4'],
    summary: 'Equivalent mixed tokens.',
  }, 1)
  assert.deepEqual(viaRange.resolvedTurns, [2, 4])
  assert.deepEqual(viaMixed.resolvedTurns, [2, 4])
  assert.equal(isSameSpanTarget(viaRange, viaMixed), true)

  const dupPlan = planSpanCompaction(session, tokenMeter, {
    turns: [2, 2, '2..2', 'turn:2'],
    summary: 'Duplicate targets collapse.',
  }, 1)
  assert.deepEqual(dupPlan.resolvedTurns, [2])

  commitSpanCompaction(session, tokenMeter, skipped)
  const blob = surfaceTextBlob(session)
  assert.ok(blob.includes('Pre-existing T3 checkpoint'), 'existing T3 summary stays when mergeSummaries is not set')
  assert.ok(blob.includes('BOUND_3_') === false || blob.includes('Pre-existing T3 checkpoint'))
  const t3StillSummary = session.surface.nodes.some((seq) => {
    const ev = session.events[seq]
    return ev?.data?.source?.plugin === 'compact' && JSON.stringify(ev.data).includes('Pre-existing T3 checkpoint')
  })
  assert.equal(t3StillSummary, true)

  const merged = planSpanCompaction(session, tokenMeter, {
    turns: [2, 3, 4],
    mergeSummaries: true, now: Date.now() + 300000,
    summary: 'L1 merge including T3 checkpoint.',
  }, 1)
  assert.ok(merged.compactedSeqs.some((seq) => session.events[seq]?.data?.source?.plugin === 'compact'))

  const compactTool = registeredTools.get('context_compact')
  const ctrl = new AbortController()
  const stageSession = sessions.prepare('test-turns-stage', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 4; t++) addCompleteTurnWithTool(stageSession, t, `st_${t}`, 'read', bulkyNeedleOutput(t, `STAGE_${t}`))
  stageSession.append('turn/start', { turn: 5 })
  stageSession.append('step/start', { turn: 5, step: 1 })
  const staged = await compactTool.execute({
    spans: [{ turns: [1, '3..3'], summary: 'Staged non-contiguous 1+3.' }],
  }, { callId: 'call_turns_stage', agent: { id: 'agent-stage', session: stageSession }, signal: ctrl.signal })
  assert.ok(staged.text.includes('staged'))
  const snap = getStagedQueueSnapshot(stageSession)
  assert.equal(snap.spans.length, 1)
  assert.deepEqual(snap.spans[0].resolvedTurns, [1, 3])
  stageSession.append('step/end', { turn: 5, step: 1 })
  await emitTurnStopping({ id: 'agent-stage', session: stageSession }, 5, ctrl.signal)
  const stagedBlob = surfaceTextBlob(stageSession)
  assert.ok(stagedBlob.includes('STAGE_2_1'), 'unselected Turn 2 remains after flush')
  assert.ok(stagedBlob.includes('STAGE_4_1'), 'unselected Turn 4 remains after flush')
  assert.ok(!stagedBlob.includes('STAGE_1_1'))
  assert.ok(!stagedBlob.includes('STAGE_3_1'))
})

function surfaceToolText(session, callId) {
  const msg = session.deriveMessages().find((m) => m.source?.kind === 'tool' && m.source.callId === callId)
  return msg?.content?.[0]?.content?.[0]?.text ?? ''
}

function addRecallTurn(session, turn, callId, target, resultText, { afterAssistant = true, endKind = 'completed' } = {}) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', {
      header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
      reason: 'initial',
    })
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 100000 })
  }
  session.append('user/message', {
    id: `u-recall-${turn}`,
    role: 'user',
    source: { kind: 'human' },
    content: [{ type: 'text', text: `recall turn ${turn}` }],
  }, { surfaceOp: 'append' })
  const args = JSON.stringify({ target })
  const chunk = session.append('assistant/chunk', {
    turn, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: callId, name: 'context_recall', argumentsDelta: args },
  })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: { id: `a-recall-${turn}`, role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'context_recall', arguments: args }] },
  }, { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] })
  const call = session.append('tool/call', { turn, step: 1, callId, name: 'context_recall', arguments: args })
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      id: `tr-recall-${turn}`,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: resultText }] }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn, step: 1 })
  if (afterAssistant) {
    session.append('step/start', { turn, step: 2 })
    const reply = session.append('assistant/chunk', {
      turn, step: 2, chunk: { type: 'text-delta', index: 0, text: 'read the recall' },
    })
    session.append('assistant/message', {
      turn,
      step: 2,
      message: { id: `a-recall-${turn}-2`, role: 'assistant', content: [{ type: 'text', text: 'read the recall' }] },
    }, { surfaceOp: 'append', sourceEventSeqs: [reply.seq] })
    session.append('step/end', { turn, step: 2 })
  }
  if (endKind) session.append('turn/end', { turn, reason: { kind: endKind } })
}

test('v4.1 to:auto keeps the last 2 closed turns and backs off to a non-empty span', async () => {
  const { sessions, tokenMeter } = await createTestHarness()
  const session = sessions.prepare('test-v41-auto-keep2', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 5; t++) addCompleteTurnWithTool(session, t, `keep_${t}`, 'read', `KEEP_${t} ${'x'.repeat(1500)}`)
  session.append('turn/start', { turn: 6 })
  const plan = planSpanCompaction(session, tokenMeter, { from: 'auto', to: 'auto', summary: 'keep two closed turns.' }, 1)
  assert.equal(plan.resolvedFrom, 'turn:1')
  assert.equal(plan.resolvedTo, 'turn:3')
  assert.ok(plan.resolvedTurns.includes(1) && plan.resolvedTurns.includes(3))
  assert.ok(!plan.resolvedTurns.includes(4) && !plan.resolvedTurns.includes(5))
  const latest = planSpanCompaction(session, tokenMeter, { from: 'auto', to: 'latest', summary: 'latest still reaches the last closed turn.' }, 1)
  assert.equal(latest.resolvedTo, 'turn:5')
  const late = planSpanCompaction(session, tokenMeter, { from: 'turn:5', to: 'auto', summary: 'explicit late from still compacts.' }, 1)
  assert.equal(late.resolvedTo, 'turn:5')

  const one = sessions.prepare('test-v41-auto-one', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(one, 1, 'only_1', 'read', `ONLY ${'y'.repeat(1500)}`)
  one.append('turn/start', { turn: 2 })
  const single = planSpanCompaction(one, tokenMeter, { from: 'auto', to: 'auto', summary: 'single closed turn still compacts.' }, 1)
  assert.equal(single.resolvedFrom, 'turn:1')
  assert.equal(single.resolvedTo, 'turn:1')

  const two = sessions.prepare('test-v41-auto-two', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(two, 1, 'two_1', 'read', `A ${'y'.repeat(1500)}`)
  addCompleteTurnWithTool(two, 2, 'two_2', 'read', `B ${'y'.repeat(1500)}`)
  two.append('turn/start', { turn: 3 })
  const backed = planSpanCompaction(two, tokenMeter, { from: 'auto', to: 'auto', summary: 'backoff keep 1.' }, 1)
  assert.equal(backed.resolvedTo, 'turn:1')
  assert.ok(!backed.resolvedTurns.includes(2))
})

test('v4.1 open: and @auto tail survive a long files/ids list', () => {
  const events = []
  const push = (type, data) => {
    const ev = { seq: events.length, type, data }
    events.push(ev)
    return ev
  }
  push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'ship v4.1' }] })
  const calls = []
  for (let i = 0; i < 30; i++) {
    calls.push({
      type: 'tool-call',
      id: `id_${i}_${'abc'.repeat(8)}`,
      name: 'write',
      arguments: JSON.stringify({ file_path: `C:/proj/pkg/module_${i}_${'x'.repeat(40)}.js` }),
    })
  }
  push('assistant/message', {
    message: {
      content: [
        ...calls,
        { type: 'text', text: '改完了。\n下一步：要不要保留最近两轮？' },
      ],
    },
  })
  const session = { events, surface: { nodes: events.map((ev) => ev.seq) } }
  const digest = buildAutoSpanDigest(session, { eventTurnMap: new Map(events.map((ev) => [ev.seq, 1])) }, events.map((ev) => ev.seq))
  assert.ok(digest.includes('open:'))
  assert.ok(digest.includes('要不要保留最近两轮'))
  const withTail = limitAutoSummary(`${digest} | TAIL_KEEP_ME`, 150)
  assert.ok(withTail.includes('要不要保留最近两轮'))
  assert.ok(withTail.includes('TAIL_KEEP_ME'))
  assert.ok(Array.from(withTail).length <= 300)
  assert.ok(!withTail.includes('module_29_'), 'long files list is the part that shrinks')
})

test('v4.1 evicts read context_recall results without a nested @call and collapses thinking', async () => {
  const { sessions, tokenMeter, emitTurnStopping } = await createTestHarness()
  const big = Array.from({ length: 700 }, (_, i) => `RECALL_LINE_${i}: KEEP_ME_NOT ${'Q'.repeat(48)}`).join('\n')
  const session = sessions.prepare('test-v41-recall-evict', { meta: { cwd: TEST_CWD } })
  addRecallTurn(session, 1, 'call_recall_big', '@span:S1-9', big)
  const resultSeq = session.events.findLast((ev) => ev?.type === 'tool/result')?.seq
  assert.ok(tokenMeter.measure(session).nodes.find((n) => n.seq === resultSeq).tokens >= 2000)
  await emitTurnStopping({ id: 'agent-recall', session }, 1, new AbortController().signal)
  const evicted = surfaceToolText(session, 'call_recall_big')
  assert.equal(evicted, '[Compact-Recall-Evicted] context_recall({ target: "@span:S1-9" })')
  assert.ok(!evicted.includes('[recall:'))
  assert.ok(!evicted.includes('@call:'))
  assert.ok(!evicted.includes('KEEP_ME_NOT'))

  const direct = sessions.prepare('test-v41-recall-direct-call', { meta: { cwd: TEST_CWD } })
  addRecallTurn(direct, 1, 'call_recall_direct', '@call:original_tool', big)
  await emitTurnStopping({ id: 'agent-recall-direct', session: direct }, 1, new AbortController().signal)
  const pointed = surfaceToolText(direct, 'call_recall_direct')
  assert.equal(pointed, '[Compact-Recall-Evicted] context_recall({ target: "@call:original_tool" })')
  assert.ok(!pointed.includes('@call:call_recall_direct'))
  assert.ok(!pointed.includes('[recall:'))

  for (const kind of ['aborted', 'error', 'blocked']) {
    const held = sessions.prepare(`test-v41-recall-${kind}`, { meta: { cwd: TEST_CWD } })
    addRecallTurn(held, 1, `call_recall_${kind}`, '@span:S4-5', `${kind}_MARKER\n${big}`, { afterAssistant: false, endKind: kind })
    await emitTurnStopping({ id: `agent-${kind}`, session: held }, 1, new AbortController().signal)
    await new Promise((resolve) => queueMicrotask(resolve))
    const text = surfaceToolText(held, `call_recall_${kind}`)
    assert.ok(text.includes(`${kind}_MARKER`), `${kind} before assistant read must stay`)
    assert.ok(!text.includes('[Compact-Recall-Evicted]'))
  }

  const readThenAbort = sessions.prepare('test-v41-recall-read-abort', { meta: { cwd: TEST_CWD } })
  addRecallTurn(readThenAbort, 1, 'call_recall_read_abort', '@span:S8-8', big, { afterAssistant: true, endKind: 'aborted' })
  await emitTurnStopping({ id: 'agent-read-abort', session: readThenAbort }, 1, new AbortController().signal)
  assert.ok(surfaceToolText(readThenAbort, 'call_recall_read_abort').startsWith('[Compact-Recall-Evicted]'))

  const completedUnread = sessions.prepare('test-v41-recall-completed', { meta: { cwd: TEST_CWD } })
  addRecallTurn(completedUnread, 1, 'call_recall_completed', '@span:S2-2', big, { afterAssistant: false, endKind: 'completed' })
  await emitTurnStopping({ id: 'agent-completed', session: completedUnread }, 1, new AbortController().signal)
  assert.ok(surfaceToolText(completedUnread, 'call_recall_completed').includes('context_recall({ target: "@span:S2-2" })'))

  const small = sessions.prepare('test-v41-recall-small', { meta: { cwd: TEST_CWD } })
  addRecallTurn(small, 1, 'call_recall_small', '@span:S1-1', 'tiny recall body')
  await emitTurnStopping({ id: 'agent-small', session: small }, 1, new AbortController().signal)
  assert.equal(surfaceToolText(small, 'call_recall_small'), 'tiny recall body')

  const thinking = sessions.prepare('test-v41-thinking', { meta: { cwd: TEST_CWD } })
  thinking.append('turn/start', { turn: 1 })
  thinking.append('user/message', {
    id: 'u-think', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'hi' }],
  }, { surfaceOp: 'append' })
  const body = `${'think '.repeat(40)}\nsecret_thought_zzz buried`
  thinking.append('assistant/message', {
    turn: 1,
    message: {
      id: 'a-think',
      role: 'assistant',
      content: [{ type: 'reasoning', text: body }, { type: 'text', text: 'visible answer' }],
    },
  }, { surfaceOp: 'append' })
  thinking.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const collapsed = executeRecall(thinking, { target: '@turn:1' })
  const block = collapsed.text.match(/<thinking>[\s\S]*?<\/thinking>/)?.[0]
  assert.ok(block && !block.includes('\n'))
  assert.ok(collapsed.text.includes('visible answer'))
  assert.ok(!collapsed.text.includes('secret_thought_zzz'))
  const full = executeRecall(thinking, { target: '@turn:1', query: 'thinking', context_lines: 1 })
  assert.ok(full.text.includes('secret_thought_zzz'))

  // mergeSummaries with from:"turn:1" anchors to first summary checkpoint even when raw turn 1 is gone
  const epochMix = sessions.prepare('test-v41-epoch-mix', { meta: { cwd: TEST_CWD } })
  for (let t = 1; t <= 4; t++) {
    addCompleteTurnWithTool(epochMix, t, `call_em_${t}`, 'read', `EM_${t} ${'Z'.repeat(1600)}`)
  }
  commitSpanCompaction(epochMix, tokenMeter, planSpanCompaction(epochMix, tokenMeter, {
    from: 'turn:1', to: 'turn:2', summary: 'Summary 1..2',
  }, 1))
  const mergePlan = planSpanCompaction(epochMix, tokenMeter, {
    from: 'turn:1', to: 'turn:4', mergeSummaries: true, summary: 'Unified L1 Epoch 1..4', now: Date.now() + 300000,
  }, 1)
  commitSpanCompaction(epochMix, tokenMeter, { ...mergePlan, now: Date.now() + 300000 })
  const surfaceSummaries = epochMix.surface.nodes.map((seq) => epochMix.events[seq]).filter((ev) => ev?.type === 'user/message' && ev.surfaceOp !== 'append')
  assert.equal(surfaceSummaries.length, 1, 'from:turn:1 with mergeSummaries must swallow prior summary prefix into a single L1 node')
  assert.ok(!surfaceSummaries[0].data.content.map((b) => b.text).join('\n').includes('Summary 1..2'), 'merged L1 must not duplicate old summary text in carried')
})

test('R2: manual context_compact of an already compacted span returns success no-op', async () => {
  const { sessions, tokenMeter, registeredTools } = await createTestHarness()
  const session = sessions.prepare('test-r2-noop', { meta: { cwd: TEST_CWD } })
  addCompleteTurnWithTool(session, 1, 'call_r2', 'read', `R2 ${'Q'.repeat(2000)}`)
  session.append('turn/start', { turn: 2 })
  commitSpanCompaction(session, tokenMeter, planSpanCompaction(session, tokenMeter, { from: 'turn:1', to: 'turn:1', summary: 'R2 summary kept.' }, 1))
  const out = await registeredTools.get('context_compact').execute({
    spans: [{ from: 'turn:1', to: 'turn:1', summary: 'R2 summary again.' }],
  }, { callId: 'call_r2_again', agent: { id: 'agent-r2', session }, signal: new AbortController().signal, concludeTurn() {} })
  assert.match(out.text, /already compacted/)
  assert.doesNotMatch(out.text, /Error|failed/i)
})
