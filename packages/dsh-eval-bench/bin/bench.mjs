#!/usr/bin/env node
import { formatMarkdownReport, runAllBenchmarks } from '../lib/index.js'

const args = process.argv.slice(2)
const jsonOnly = args.includes('--json')

const report = await runAllBenchmarks()

if (jsonOnly) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  const md = formatMarkdownReport(report)
  const summaryJson = {
    elapsedMs: report.elapsedMs,
    toolGate: {
      toolsBefore: report.toolGate.totalCatalogTools,
      toolsAfter: report.toolGate.defaultVisibleTools,
      reductionPct: report.toolGate.toolReductionPct,
      staticTokensG0: report.toolGate.ablationG0ToG4[0].totalStaticPromptTokens,
      staticTokensG4: report.toolGate.ablationG0ToG4[4].totalStaticPromptTokens,
      staticReductionPct: report.toolGate.turn1StaticReductionPct,
      skillSearchRecallAt1: report.toolGate.skillSearch.recallAt1Fraction,
    },
    nich: {
      distractorEmbedded: report.nich.distractorEmbeddedFraction,
      regimes: Object.fromEntries(
        report.nich.regimes.map((r) => [
          r.regime,
          {
            surfaceNodes: r.surfaceNodesCount,
            surfaceTokens: r.surfaceTokens,
            tokenSavingsPct: r.tokenSavingsPct,
            surfaceRecall: r.surfaceRecallFraction,
            effectiveRecall: r.effectiveRecallFraction,
            effectiveRecallPct: r.effectiveRecallPct,
            distractorRejection: r.distractorRejectionFraction,
            negativeFp: r.negativeFpFraction,
          },
        ])
      ),
    },
    relayDispatch: {
      builtinModesCount: report.relayDispatch.modeResolution.builtinModesCount,
      candidateFallbackChain: report.relayDispatch.candidateFallback429.attemptedModels,
      prepareMatrixAccuracy: report.relayDispatch.parentSessionPrepareMatrix.accuracyFraction,
      detailBytes: report.relayDispatch.deliveryAndLifecycle.detailByteLength,
    },
    empiricalLedger: {
      activeSessions: report.empirical.globalCorpus.activeSessions,
      childSessionsWithParent: report.empirical.globalCorpus.childSessionsWithParent,
      zstdFrames: report.empirical.globalCorpus.zstdFrames,
      unpackedEvents: report.empirical.globalCorpus.unpackedEvents,
      eventTokens: report.empirical.globalCorpus.eventTokens,
      surfaceTokens: report.empirical.globalCorpus.surfaceTokens,
      surfaceRatioPct: report.empirical.globalCorpus.surfaceToEventRatioPct,
      compactionOps: report.empirical.compactionSummary.ops,
      compactionBeforeTokens: report.empirical.compactionSummary.beforeSurfaceTokens,
      compactionAfterTokens: report.empirical.compactionSummary.afterSurfaceTokens,
      compactionNetSavedTokens: report.empirical.compactionSummary.netSavedSurfaceTokens,
      compactionNetReductionPct: report.empirical.compactionSummary.netReductionPct,
      compactionPeakRawTokens: report.empirical.compactionSummary.peakSingleSessionRawTokens,
      compactionPeakCompactedTokens: report.empirical.compactionSummary.peakSingleSessionCompactedTokens,
      compactionPeakSavedTokens: report.empirical.compactionSummary.peakSingleSessionSavedTokens,
      compactionPeakReductionPct: report.empirical.compactionSummary.peakSingleSessionReductionPct,
      relayDispatches: report.empirical.relaySummary.totalDispatches,
      independentReviews: report.empirical.relaySummary.independentVerificationRuns,
      interceptedDefects: report.empirical.relaySummary.interceptedBlindSpotDefects,
      defectInterceptionRatePct: report.empirical.relaySummary.defectInterceptionRatePct,
    },
    liveDynamicMetrics: report.liveDynamicMetrics,
  }
  process.stdout.write(md + '\n\n### Machine-Readable Metrics Summary (JSON)\n\n```json\n' + JSON.stringify(summaryJson, null, 2) + '\n```\n')
}
