import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EMPIRICAL_LEDGER_PATH,
  NICH_CORPUS_PATH,
  buildNichBaselineSession,
  buildProductionToolCatalog,
  createCompactRuntime,
  createDeterministicTokenMeter,
  evaluateNichSuite,
  evaluateRelayDispatchSuite,
  evaluateToolGateSuite,
  formatMarkdownReport,
  loadEmpiricalLedger,
  loadNichCorpus,
  runAllBenchmarks,
  verifyEmpiricalLedger,
} from '../lib/index.js'

test('1. Tool-gate suite calls real filterTools (137 -> 38) and groupOf across all 4 hidden groups', async () => {
  const catalog = buildProductionToolCatalog()
  assert.equal(catalog.length, 137)
  const res = await evaluateToolGateSuite()
  assert.equal(res.totalCatalogTools, 137)
  assert.equal(res.defaultVisibleTools, 38)
  assert.equal(res.hiddenToolsCount, 99)
  assert.equal(res.toolReductionPct, 72.3)
  assert.deepEqual(res.groupCounts, {
    core: 38,
    dev: 17,
    relay: 12,
    connector: 14,
    browser: 56,
  })
})

test('2. Tool-gate suite verifies ghost context stripping (filterContexts) and zero-friction auto-unlock (gateDecision)', async () => {
  const res = await evaluateToolGateSuite()
  assert.equal(res.ghostContext.beforeCount, 3)
  assert.equal(res.ghostContext.afterClosedCount, 2)
  assert.equal(res.ghostContext.afterDevOpenCount, 3)
  assert.equal(res.ghostContext.strippedWhenClosed, true)

  assert.equal(res.autoUnlock.decisionKind, 'allow')
  assert.equal(res.autoUnlock.autoUnlockedGroup, 'dev')
  assert.equal(res.autoUnlock.replaySource, '自动放行')
  assert.equal(res.autoUnlock.visibleToolsAfterDevUnlock, 38 + 17)
  assert.equal(res.autoUnlock.internalRelayCallBypassed, true)
})

test('3. Skill-search suite calls real applySkillSearch and achieves 100% Recall@1 across English & Chinese queries', async () => {
  const res = await evaluateToolGateSuite()
  assert.equal(res.skillSearch.queriesTotal, 12)
  assert.equal(res.skillSearch.recallAt1Hits, 12)
  assert.equal(res.skillSearch.recallAt1Fraction, '12/12')
  assert.equal(res.skillSearch.recallAt1Pct, 100.0)
  assert.equal(res.skillSearch.skillLoadInjected, true)
})

test('4. G0 ~ G4 paired ablation stages monotonically reduce static prompt overhead (28,500 -> 8,100 tokens, -71.6%, 137 -> 38 tools)', async () => {
  const res = await evaluateToolGateSuite()
  const stages = res.ablationG0ToG4
  assert.equal(stages.length, 5)
  assert.equal(stages[0].stage, 'G0')
  assert.equal(stages[0].visibleTools, 137)
  assert.equal(stages[0].totalStaticPromptTokens, 28500)
  assert.equal(stages[1].stage, 'G1')
  assert.equal(stages[1].visibleTools, 38)
  assert.equal(stages[1].totalStaticPromptTokens, 8100)
  assert.equal(stages[4].stage, 'G4')
  assert.equal(stages[4].totalStaticPromptTokens, 8100)
  assert.equal(res.turn1StaticReductionPct, 71.6)
  for (let i = 1; i < stages.length; i++) {
    assert.ok(
      stages[i].totalStaticPromptTokens <= stages[i - 1].totalStaticPromptTokens,
      `Stage ${stages[i].stage} static tokens should not exceed ${stages[i - 1].stage}`
    )
    assert.ok(
      stages[i].peakSurfaceTokens <= stages[i - 1].peakSurfaceTokens,
      `Stage ${stages[i].stage} peak surface tokens should not exceed ${stages[i - 1].stage}`
    )
  }
})

test('5. Adversarial NICH corpus embeds all 10 positive needles and all 10 near-miss distractor literals into haystack turns across 5 depths', () => {
  const corpus = loadNichCorpus()
  assert.equal(corpus.turns.length, 5)
  assert.deepEqual(
    corpus.turns.map((t) => t.depthPct),
    [10, 30, 50, 70, 90]
  )
  assert.equal(corpus.positiveNeedles.length, 10)
  assert.equal(corpus.negativeNeedles.length, 5)

  const categories = new Set(corpus.positiveNeedles.map((n) => n.category))
  assert.ok(categories.has('windows-path-line'))
  assert.ok(categories.has('unicode-cjk-grapheme'))
  assert.ok(categories.has('multiline-stack-frame'))
  assert.ok(categories.has('error-code-sha'))

  // Every positive needle AND every distractor literal must be physically embedded in its turn's embeddedLines
  for (const needle of corpus.positiveNeedles) {
    const turnSpec = corpus.turns.find((t) => t.turn === needle.turn)
    assert.ok(turnSpec, `Missing turn ${needle.turn} for needle ${needle.id}`)
    const combinedEmbeddedText = turnSpec.embeddedLines.map((e) => e.text).join('\n')
    assert.ok(
      combinedEmbeddedText.includes(needle.expectedLiteral),
      `Needle ${needle.id} expectedLiteral not embedded in Turn ${needle.turn}`
    )
    assert.ok(
      combinedEmbeddedText.includes(needle.distractorLiteral),
      `Needle ${needle.id} distractorLiteral not embedded in Turn ${needle.turn}`
    )
  }
})

test('6. NICH C0 ~ C4 comparison proves C1/C2 suffer severe literal loss while C3/C4 achieve 100% (10/10) recall and 0/5 negative FP', async () => {
  const nich = await evaluateNichSuite()
  const byId = Object.fromEntries(nich.regimes.map((r) => [r.regime, r]))

  // C0: 0% savings, 10/10 recall
  assert.equal(byId.C0.tokenSavingsPct, 0)
  assert.equal(byId.C0.effectiveRecallFraction, '10/10')
  assert.equal(byId.C0.negativeFpFraction, '0/5')

  // C1 (Sliding-Window Hard Truncation): high loss on depths 10%..70% (only 2/10 survive)
  assert.equal(byId.C1.effectiveRecallFraction, '2/10')
  assert.equal(byId.C1.effectiveRecallPct, 20.0)

  // C2 (Lossy Rolling Summary without provenance): loses exact line numbers/SHAs/offsets (only 1/10 high-level verdict survives)
  assert.equal(byId.C2.effectiveRecallFraction, '1/10')
  assert.equal(byId.C2.effectiveRecallPct, 10.0)

  // C3 (Single-layer @call + @span + executeRecall): substantial token savings + 10/10 exact recall + 10/10 distractor rejection + 0/5 FP
  assert.ok(byId.C3.tokenSavingsPct > 70, `Expected C3 savings > 70%, got ${byId.C3.tokenSavingsPct}%`)
  assert.equal(byId.C3.effectiveRecallFraction, '10/10')
  assert.equal(byId.C3.effectiveRecallPct, 100.0)
  assert.equal(byId.C3.distractorRejectionFraction, '10/10')
  assert.equal(byId.C3.negativeFpFraction, '0/5')
  assert.equal(byId.C3.extraMeta.toolPairingBalanced, true)

  // C4 (Nested multi-gen @span over @span & @call + recursive DAG recall): highest savings + 10/10 exact recall + 0/5 FP
  assert.ok(byId.C4.tokenSavingsPct > byId.C3.tokenSavingsPct, 'Expected C4 nested compaction to save more surface tokens than C3')
  assert.equal(byId.C4.effectiveRecallFraction, '10/10')
  assert.equal(byId.C4.effectiveRecallPct, 100.0)
  assert.equal(byId.C4.distractorRejectionFraction, '10/10')
  assert.equal(byId.C4.negativeFpFraction, '0/5')
  assert.equal(byId.C4.extraMeta.toolPairingBalanced, true)
  assert.equal(byId.C4.extraMeta.outerResolvedLeafCount, 20)
})

test('7. Staged compaction queue commits cleanly on agent/turn-stopping via createCompactRuntime', async () => {
  const tokenMeter = createDeterministicTokenMeter()
  const session = buildNichBaselineSession()
  const runtime = createCompactRuntime(tokenMeter)
  const beforeTokens = tokenMeter.measure(session).surfaceTokens

  const stageRes = await runtime.executeCompact(
    session,
    {
      results: [{ callId: 'call-t1', summary: 'Staged summary for T1' }],
    },
    { callId: 'call-stage-test', commitNow: false }
  )
  assert.match(stageRes.text, /Compact staged for turn-stopping/)
  assert.equal(tokenMeter.measure(session).surfaceTokens, beforeTokens)

  runtime.emitTurnStopping(session)
  const afterTokens = tokenMeter.measure(session).surfaceTokens
  assert.ok(afterTokens < beforeTokens, 'Surface tokens must decrease after turn-stopping flush')
})

test('8. Relay-dispatch suite verifies mode parsing, 429 candidate chain fallback, and error classification', async () => {
  const relay = await evaluateRelayDispatchSuite()
  // 内置模式已扩展为 investigate/implement/verify/review/heavy/rp 共 6 个；同步修复后更新陈旧断言，不删除 rp 功能迎合旧测试。
  assert.equal(relay.modeResolution.builtinModesCount, 6)
  assert.equal(relay.modeResolution.filledDangerAutoConfirmed, true)
  assert.deepEqual(relay.candidateFallback429.attemptedModels, [
    'cursor/claude-opus-5-5',
    'copilot/claude-opus-5.5',
  ])
  assert.equal(relay.candidateFallback429.fallbackSucceeded, true)
  assert.equal(relay.candidateFallback429.errorClassificationPassed, true)
})

test('9. Relay-dispatch evaluateRelayPrepare matrix achieves 6/6 (100%) accuracy and UTF-8 truncation respects 3000-byte ceiling', async () => {
  const relay = await evaluateRelayDispatchSuite()
  assert.equal(relay.parentSessionPrepareMatrix.casesPassed, 6)
  assert.equal(relay.parentSessionPrepareMatrix.casesTotal, 6)
  assert.equal(relay.parentSessionPrepareMatrix.accuracyFraction, '6/6')
  assert.equal(relay.deliveryAndLifecycle.within3000ByteBudget, true)
  assert.equal(relay.deliveryAndLifecycle.noBrokenSurrogates, true)
  assert.equal(relay.deliveryAndLifecycle.stalledSnapNotTerminal, true)
  assert.equal(relay.deliveryAndLifecycle.cancelGraceTimeoutDetected, true)
})

test('10. Tier-1 Empirical Ledger passes strict arithmetic invariants and sanitization checks (zero private paths)', () => {
  const rawLedgerText = readFileSync(EMPIRICAL_LEDGER_PATH, 'utf8')
  assert.doesNotMatch(rawLedgerText, /[A-Za-z]:[\\/]+Users[\\/]/i)
  assert.doesNotMatch(rawLedgerText, /AppData/i)

  const verified = verifyEmpiricalLedger(loadEmpiricalLedger())
  assert.equal(verified.sanitized, true)
  assert.equal(verified.compactionAccountingValid, true)
  assert.equal(verified.globalCorpus.activeSessions, 97)
  assert.equal(verified.globalCorpus.childSessionsWithParent, 67)
  assert.equal(verified.globalCorpus.zstdFrames, 29004)
  assert.equal(verified.globalCorpus.unpackedEvents, 342035)
  assert.equal(verified.globalCorpus.eventTokens, 21530371)
  assert.equal(verified.globalCorpus.surfaceTokens, 4490834)
  assert.equal(verified.compactionSummary.ops, 31)
  assert.equal(verified.compactionSummary.beforeSurfaceTokens, 753347)
  assert.equal(verified.compactionSummary.afterSurfaceTokens, 556615)
  assert.equal(verified.compactionSummary.netSavedSurfaceTokens, 196732)
  assert.equal(verified.compactionSummary.netReductionPct, 26.1)
  assert.equal(verified.compactionSummary.peakSingleSessionRawTokens, 138371)
  assert.equal(verified.compactionSummary.peakSingleSessionCompactedTokens, 67196)
  assert.equal(verified.compactionSummary.peakSingleSessionSavedTokens, 71175)
  assert.equal(verified.compactionSummary.peakSingleSessionReductionPct, 51.4)
  assert.equal(verified.relaySummary.interceptionFraction, '25/52')
  assert.equal(verified.relaySummary.defectInterceptionRatePct, 48.1)
  assert.equal(verified.relaySummary.contextIsolationGainPctPt, 44.0)
  assert.equal(verified.relaySummary.heterogeneityGainPctPt, 44.0)
})

test('11. Full benchmark suite is 100% deterministic across repeated runs and completes in < 2000 ms', async () => {
  const run1 = await runAllBenchmarks()
  const run2 = await runAllBenchmarks()
  assert.ok(run1.elapsedMs < 2000, `Expected benchmark run < 2000ms, got ${run1.elapsedMs}ms`)

  const stripTiming = (r) => ({ ...r, elapsedMs: 0 })
  assert.deepEqual(stripTiming(run1), stripTiming(run2))

  const md = formatMarkdownReport(run1)
  assert.match(md, /137 -> 38/)
  assert.match(md, /10\/10 \(100%\)/)
  assert.match(md, /0\/5 \(0%\)/)
  assert.match(md, /25\/52/)
})
