# @dsh-external/dsh-context-compact

Event-stream surgical context compaction (`context_compact`) and lossless provenance recall (`context_recall`) for **DeepSeek Harness (DSH)**.

## Overview

Traditional LLM agent context management relies on destructive "rolling summaries" that summarize the entire conversation when the context window fills up—erasing exact file paths, line numbers, symbol names, and error codes that a coding agent needs moments later.

`@dsh-external/dsh-context-compact` exploits DSH's separation between the **immutable append-only event log (`session.events` / `.jsonl.zstd`)** and the **active prompt projection (`session.surface.nodes`)**. It equips the agent with two surgical tools:

1. **`context_compact`**: Dual-granularity surgical replacement on `session.surface.nodes`:
   - **Single tool-result pruning (`results: [{ callId, summary }]`)**: Replaces individual bulky `tool/result` nodes (from the current turn or historical turns) with a concise engineering conclusion and a `[recall: @call:<callId>]` anchor via `compaction/prune` + `tool/result (surfaceOp: replace)`.
   - **Multi-turn contiguous span checkpointing (`spans: [{ from, to, summary }]`)**: Condenses closed historical turns (`turn:N`, `turnsBack:N`, or `<callId>`) into a single checkpoint message with a `[recall: @span:S<min>-<max>]` anchor via atomic 4-event commits (`compaction/start` → `compaction/summary` → `user/message (surfaceOp: replace)` → `compaction/end`).
2. **`context_recall`**: Read-only, concurrency-safe (`isConcurrencySafe: () => true`) lossless retrieval from the underlying event log:
   - Recursively expands `sourceEventSeqs` provenance DAGs down to original `surfaceOp === 'append'` leaf events—even across multiple nested compactions.
   - Supports regex/substring filtering (`query` + `context_lines`) and 120-line paginated slicing (`line_range`) with continuation cursors.

---

## Key Features & Safety Invariants

- **Staged-by-Default Execution**: Compactions called mid-turn are staged in a per-session `WeakMap` queue so the original uncompacted text remains visible to the model for the rest of the current turn, then automatically flushed on `agent/turn-stopping`.
- **Immediate Commit & Turn Conclusion**:
  - Automatically switches from staged to immediate commit when context occupancy exceeds `70%` (`DEFAULT_IMMEDIATE_RATIO = 0.70`) or when `conclude_turn: true` is passed.
  - **`conclude_turn` Guard (`checkConcludeTurnEligibility`)**: Safely calls `exec.concludeTurn()` to save an extra LLM round-trip **only** when the current open step's `assistant/message` already contains non-empty user-visible reply text and no other tool calls exist in the same step. Otherwise, it commits the compaction immediately without prematurely ending the turn.
- **Tool-Pairing Balance Verification**: Enforces `toolPairingBalancedBefore(session, startSeq)` and `toolPairingBalancedAfter(session, endSeq)` so a span replacement never splits an `assistant/message (tool-call)` from its corresponding `tool/result`.
- **Abort & Transient-Failure Resilience**:
  - Relative `turnsBack:N` endpoints are normalized to canonical `turn:M` selectors at staging time.
  - If a turn is aborted (`signal.aborted`), the staged queue survives `turn/end` and automatically commits at the next turn's `agent/turn-stopping`.
  - Transient flush failures re-queue up to `DEFAULT_MAX_FLUSH_RETRIES = 2` times before recording to `dropped`, re-planning against the latest surface and silently skipping targets already compacted.
- **KV-Cache Friendly Prompt Injection**:
  - Injects static compaction guidance via `ctx.systemPrompt.section` (zero prefix KV-cache invalidation).
  - Injects a single-line directory of historical large blocks (`>500` tokens) via `ctx.systemPrompt.context`, updating only across turn boundaries when historical large blocks change.

---

## Tool Reference

### `context_compact`

| Parameter | Type | Description |
|---|---|---|
| `results` | `Array<{ callId: string, summary: string }>` | Single tool-result compactions (completed calls in current or earlier turns). |
| `spans` | `Array<{ from: string, to: string, summary: string }>` | Contiguous historical turn spans (`turn:N`, `turnsBack:N`, or `<callId>`). Cannot cover the current open turn. |
| `conclude_turn` | `boolean` | Commit immediately and call `exec.concludeTurn()` if the current assistant message already has final reply text. |
| `inspect` | `boolean` | Output a detailed breakdown of surface nodes `>= 500` tokens with `seq`, `turn`, `callId`, and token counts. |

### `context_recall`

| Parameter | Type | Description |
|---|---|---|
| `target` | `string` (required) | `@call:<callId>`, `@span:S<start>-<end>`, `@turn:<N>`, or raw event `seq`. |
| `query` | `string` | Optional case-insensitive regex or substring filter. |
| `context_lines` | `integer` | Number of surrounding lines to include around each `query` match (default `3`). |
| `line_range` | `[number, number]` | Optional 1-based inclusive `[startLine, endLine]` range (max `120` lines per page). |

---

## Verification & Testing

```bash
# Syntax check
node --check lib/index.js

# Run unit & integration test suite (7 tests covering single results, spans, nested recall, conclude_turn guards, abort retention, retry limits, and overlap deduplication)
node --test test/compact.test.mjs
```

Set `DSH_ROOT` if your `@deepseek-ai/dsh` installation is in a non-default location:

```bash
DSH_ROOT=/path/to/@deepseek-ai/dsh/node_modules/@deepseek-ai node --test test/compact.test.mjs
```

## License

BSD-3-Clause © mikonnyan
