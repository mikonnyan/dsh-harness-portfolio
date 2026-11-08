# `@dsh-external/dsh-eval-bench`

Reproducible empirical evaluation benchmark and adversarial **Needle-in-Compacted-Haystack (NICH)** suite for the DeepSeek Harness portfolio packages:

1. **`@dsh-external/dsh-tool-gate`** (`G0 ~ G4` paired ablation: `137 -> 38` tool surface pruning, ghost context stripping, zero-friction direct-call auto-unlock, and bilingual `skill_search` `Recall@1`).
2. **`@dsh-external/dsh-context-compact`** (`C0 ~ C4` adversarial NICH benchmark across 5 haystack depths, Windows backslash paths, Unicode/CJK/grapheme clusters, multi-line stack traces, near-miss Distractor Needles, and non-existent Negative Needles).
3. **`@dsh-external/dsh-relay-dispatch`** (`R1 ~ R3` decoupled verification comparison, HTTP 429 heterogeneous candidate fallback, `evaluateRelayPrepare` parent-child session linking matrix, and 3,000-byte UTF-8 grapheme-safe delivery ceiling).
4. **Tier-1 Sanitized Production Telemetry Ledger** (`fixtures/empirical-ledger.json`: 97 active sessions, 67 child sessions with `parentSession`, 29,004 Zstd frames, 342,035 unpacked events, 21.53M Event Tokens vs. 4.49M Surface Tokens, 31 production `compaction/prune` operations, and 100 `relay_dispatch` runs).

## Quick Start

```bash
# Run full Markdown + JSON benchmark report (< 100 ms)
npm run bench

# Machine-readable JSON output
node packages/dsh-eval-bench/bin/bench.mjs --json

# Run evaluation test suite (11 assertions covering G0~G4, C0~C4, R1~R3, and ledger invariants)
npm --prefix packages/dsh-eval-bench test
```
