/**
 * @dsh-external/dsh-context-compact
 * Precise context compaction (`context_compact`) and lossless recall (`context_recall`)
 * for DeepSeek Harness 0.1.0-rc.7.
 * Zero external runtime imports so host injection works without node_modules links.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-context-compact'
// Cordis 4 resolves every inject key as required (array, or a name → config map).
// `{ required, optional }` would wait on services named "required" and "optional".
// `compaction` stays off this list and is read below without that requirement.
export const inject = ['tools', 'tokenMeter', 'sessions', 'systemPrompt']

export const DEFAULT_MIN_SAVINGS_TOKENS = 300
export const DEFAULT_LARGE_BLOCK_TOKENS = 500
export const DEFAULT_IMMEDIATE_RATIO = 0.70
export const DEFAULT_RECALL_MAX_LINES = 120
export const DEFAULT_MAX_FLUSH_RETRIES = 2
export const DEFAULT_SOFT_WATERMARK_TOKENS = 60000
export const DEFAULT_SOFT_WATERMARK_TURNS = 20
export const DEFAULT_KEEP_RECENT_TURNS = 5
export const DEFAULT_TOP_CANDIDATES = 3
export const DEFAULT_OPEN_TURN_LARGE_RESULT_TOKENS = 1500
export const DEFAULT_AUTO_COMPACT_OPEN_TURN_THRESHOLD = 4000
export const DEFAULT_PIGGYBACK_THRESHOLD_TOKENS = 20000
export const DEFAULT_PIGGYBACK_THRESHOLD_TURNS = 8
export const DEFAULT_PIGGYBACK_IDLE_MS = 300000
export const DEFAULT_TIER_CLIFF_TOKENS = 112000
export const DEFAULT_TIER_CLIFF_COMPACTABLE_TOKENS = 10000
export const DEFAULT_HARD_WATERMARK_RATIO = 0.75
export const DEFAULT_HARD_TARGET_RATIO = 0.55
export const DEFAULT_HARD_KEEP_RECENT_STEPS = 2
export const DEFAULT_OVERFLOW_TARGET_RATIO = 0.50
export const DEFAULT_OVERFLOW_MAX_RETRIES = 1

const BACKGROUND_DISPATCH_TOOLS = new Set(['relay_dispatch', 'subagent', 'subagent_fork', 'claude_code', 'cursor_agent'])
const COMPACTION_TOOLS = new Set(['context_compact', 'context_recall'])
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export const COMPACT_SYSTEM_RULE = [
  '### Context Compaction',
  '- 阶段收尾时同一步调用 `context_compact`：summary 写结论 + 精确锚点（路径:行号/符号/错误码/关键值）。',
  '- `results` 可压当前或更早轮的已完成工具结果；`spans` 不能覆盖当前未结束的轮。原文始终可用 `context_recall` 按 `[recall: …]` 标签取回。',
  '- 出现 `[context-compact 水位提醒]` 时，随下一次工具调用或最终回复（`conclude_turn:true`）搭便车压缩，直接用提示里的 span 与 callId，不先 `inspect`；每条 summary ≤120 tokens。',
].join('\n')

// ---------------------------------------------------------------------------
// Zero-dep equivalents of DSH helpers (verified against DSH 0.1.0-rc.7 source)
// ---------------------------------------------------------------------------

/** Iterative deepFreeze matching `@deepseek-ai/dsh-llm` */
export function deepFreeze(value) {
  const seen = new WeakSet()
  const pending = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (typeof AbortSignal !== 'undefined' && node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node, key })
    }
  }
  return value
}

/** Detach and deep-freeze a message matching `@deepseek-ai/dsh-llm#freezeMessage` */
export function freezeMessage(message) {
  return deepFreeze(structuredClone(message))
}

/** Create a frozen user message matching `@deepseek-ai/dsh-llm#createUserMessage` */
export function createUserMessage(input) {
  return freezeMessage({
    ...input,
    id: randomUUID(),
    role: 'user',
  })
}

// DSH v3 exposes a mutable-looking events array; v4 exposes snapshots/accessors.
export function isV4Session(session) {
  return typeof session?.eventAt === 'function' && typeof session?.snapshotEvents === 'function'
}
export function getAllEvents(session) {
  return isV4Session(session) ? session.snapshotEvents() : (session?.events ?? [])
}
export function getEvent(session, seq) {
  return isV4Session(session) ? session.eventAt(seq) : session?.events?.[seq]
}
export function makeReplaceSurfaceOp(session, startSeq, endSeq) {
  return isV4Session(session)
    ? { op: 'replace', startSeq, endSeq }
    : { op: 'replace', start: startSeq, end: endSeq }
}
/** Create checkpoint provenance matching the active DSH session format. */
export function compactCheckpointSource(compactionId, sourceCommandId, session) {
  return Object.freeze(isV4Session(session)
    ? { kind: 'compact-checkpoint', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) }
    : { kind: 'plugin', plugin: 'compact', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) })
}
export function makeCheckpointSource(session, compactionId, sourceCommandId) {
  return compactCheckpointSource(compactionId, sourceCommandId, session)
}
export function makeElideSource(session, compactionId) {
  // v4 accepts producer-owned source kinds. Never impersonate a checkpoint:
  // doing so creates duplicate UI cards and breaks checkpoint/tombstone identity.
  return Object.freeze(isV4Session(session)
    ? { kind: 'context-compact-elide', compactionId }
    : { kind: 'plugin', plugin: 'context-compact-elide', compactionId })
}
export function isProtectedSystemNode(session, seq, options = {}) {
  const nodes = session?.surface?.nodes ?? []
  const ev = getEvent(session, seq)
  if (!ev) return false
  if (ev.type === 'developer/message') return options.absorbInertDev !== true
  if (ev.type !== 'system/message') return false
  const index = nodes.indexOf(seq)
  if (isV4Session(session) && index === 0) return true
  // Only the effective (latest non-empty) in-history system prompt is a barrier;
  // stale/empty system nodes are absorbable and explicitly claimed by shadowedSeqs.
  let latest = -1
  for (let i = 0; i < nodes.length; i++) {
    const candidate = getEvent(session, nodes[i])
    if (candidate?.type === 'system/message' && (candidate.data?.content ?? candidate.data?.message?.content ?? []).length > 0) latest = i
  }
  return index === latest && latest > 0
}
export const isRuntimeSnapshot = (ev) => isSystemPromptSnapshotEvent(ev)
export const nodeTokens = (node) => node?.heuristicTokens ?? node?.tokens ?? 0
export const logLength = (session) => isV4Session(session) ? session.seq : (session?.events?.length ?? 0)
export function eventMessage(session, ev) {
  if (typeof session?.deriveEventMessage === 'function') return session.deriveEventMessage(ev)
  return ev?.type === 'user/message' ? ev.data : ev?.data?.message
}
export const PREFIX_EPOCH_KEY = '@dsh-external/prefix-epoch'
export function publishPrefixClass(session, summarySeq, prefixClass) {
  const reg = globalThis[Symbol.for(PREFIX_EPOCH_KEY)] ??= { v: 1, bySession: new WeakMap() }
  let rec = reg.bySession.get(session)
  if (!rec) reg.bySession.set(session, rec = { classBySummarySeq: new Map() })
  rec.classBySummarySeq.set(summarySeq, prefixClass)
  if (rec.classBySummarySeq.size > 64) rec.classBySummarySeq.delete(rec.classBySummarySeq.keys().next().value)
}
export function computeSurfaceCutSafety(session, suppliedLogInfo) {
  const logInfo = suppliedLogInfo ?? inspectSessionLog(session)
  const nodes = session.surface.nodes
  const callPos = new Map(), resultPos = new Map(), turnOf = [], lastIdxOfTurn = new Map()
  for (let i = 0; i < nodes.length; i++) {
    const ev = getEvent(session, nodes[i])
    const turn = logInfo.eventTurnMap.get(nodes[i]) ?? 0
    turnOf.push(turn)
    lastIdxOfTurn.set(turn, i)
    if (ev?.type === 'assistant/message') {
      for (const b of ev.data?.message?.content ?? []) if (b.type === 'tool-call') callPos.set(b.id, i)
    } else if (ev?.type === 'tool/result') resultPos.set(ev.data?.message?.source?.callId, i)
  }
  const unsafe = new Uint8Array(nodes.length + 1)
  const defects = []
  for (const [id, p] of callPos) {
    const r = resultPos.get(id)
    if (r !== undefined) { for (let i = p + 1; i <= r; i++) unsafe[i] = 1; continue }
    const turn = turnOf[p]
    const open = logInfo.openTurn !== null && turn === logInfo.openTurn
    const end = open ? nodes.length : (lastIdxOfTurn.get(turn) ?? p) + 1
    for (let i = p + 1; i < end; i++) unsafe[i] = 1
    if (!open) defects.push({ kind: 'dangling-call', callId: id, turn, index: p })
  }
  for (const [id, r] of resultPos) if (!callPos.has(id)) defects.push({ kind: 'orphan-result', callId: id, turn: turnOf[r], index: r })
  return { unsafe, defects, turnOf, indexBySeq: new Map(nodes.map((seq, i) => [seq, i])) }
}
export function toolResultBlocks(message) {
  return Array.isArray(message?.content?.[0]?.content) ? message.content[0].content : (message?.content ?? [])
}
/** Images are expensive even when their serialized text is small. */
export function isMultimediaToolResult(session, ev, logInfo = inspectSessionLog(session)) {
  if (ev?.type !== 'tool/result') return false
  const callId = ev.data?.message?.source?.callId ?? ''
  if (callId && logInfo.callMap.get(callId)?.name === 'read_image') return true
  const visit = (value) => {
    if (!value || typeof value !== 'object') return false
    if (value.type === 'image' || value.type === 'image_url' || value.image_url !== undefined) return true
    if (typeof value.data === 'string' && typeof value.mediaType === 'string' && value.mediaType.startsWith('image/')) return true
    if (typeof value.source?.data === 'string' && typeof value.source?.media_type === 'string' && value.source.media_type.startsWith('image/')) return true
    if (typeof value.data === 'string' && typeof value.mimeType === 'string' && value.mimeType.startsWith('image/')) return true
    return Object.values(value).some(visit)
  }
  return visit(toolResultBlocks(ev.data?.message))
}
/** A closed turn is eligible after it is at least two turns behind the active turn. */
export function isMultimediaArchiveTurn(turn, logInfo) {
  const current = logInfo?.openTurn ?? logInfo?.lastTurn ?? 0
  return turn >= 1 && current - turn >= 2
}
export function rewriteToolResultMessage(message, content) {
  return freezeMessage(message?.role === 'tool'
    ? { ...message, content }
    : { ...message, content: [{ ...message?.content?.[0], content }] })
}
/** Match the persisted notice emitted by @deepseek-ai/dsh-spill-policy. */
export function hasSpillNotice(text) {
  if (typeof text !== 'string' || !text.endsWith(')')) return false
  const start = text.lastIndexOf('\n\n(')
  const candidate = text.slice(start < 0 ? 0 : start + 2, -1)
  const marker = ' Full formatted result stored at: '
  const location = candidate.indexOf(marker)
  if (!candidate.startsWith('(') || location < 0 || !candidate.slice(location).includes('. ')) return false
  const omission = candidate.slice(1, location).replace(/ Omitted [1-9][0-9]* images\.$/, '')
  return omission === 'Omitted an unknown number of bytes.'
    || omission === 'No bytes omitted.'
    || /^Omitted exactly [0-9]+ bytes\.$/.test(omission)
}

/**
 * Pair-aware cut safety. Historical defects are quarantined to their closed
 * turn instead of leaving global openCalls/corrupt state permanently poisoned.
 */
function computeSurfaceCutBalance(session) {
  const { unsafe, indexBySeq } = computeSurfaceCutSafety(session)
  const cutBalanced = Array.from(unsafe, (value) => !value)
  cutBalanced[0] = true
  return { cutBalanced, indexBySeq }
}

export function toolPairingBalancedBefore(session, seq) {
  const { cutBalanced, indexBySeq } = computeSurfaceCutBalance(session)
  const index = indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cutBalanced[index]
  if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return balanced
}

export function toolPairingBalancedAfter(session, seq) {
  const { cutBalanced, indexBySeq } = computeSurfaceCutBalance(session)
  const index = indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cutBalanced[index + 1]
  if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return balanced
}

// ---------------------------------------------------------------------------
// Core session log inspection & provenance helpers
// ---------------------------------------------------------------------------

/**
 * Inspect session events to determine:
 * - openTurn: turn number if a turn is currently open, else null
 * - lastTurn: highest turn number started
 * - unmatchedCompactionStart: event if compaction lock is active
 * - eventTurnMap: Map<seq, turn> mapping every event seq to the turn it originally belonged to
 * - callMap: Map<callId, { callSeq, name, turn, step, arguments }>
 * - inFlightCalls: Set<callId> of started tool/call without a settled tool/result
 */
export function inspectSessionLog(session) {
  const events = getAllEvents(session)
  let currentTurn = 0
  let openTurn = null
  let lastTurn = 0
  let unmatchedCompactionStart = undefined
  let latestEndSeedSeq = undefined

  const eventTurnMap = new Map()
  const callMap = new Map()
  const settledCalls = new Set()

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev) continue
    if (ev.type === 'session/end-seed') {
      latestEndSeedSeq = ev.seq
    } else if (ev.type === 'turn/start') {
      currentTurn = ev.data.turn
      openTurn = currentTurn
      if (currentTurn > lastTurn) lastTurn = currentTurn
    } else if (ev.type === 'turn/end') {
      eventTurnMap.set(ev.seq, currentTurn)
      openTurn = null
      continue
    } else if (ev.type === 'compaction/start') {
      unmatchedCompactionStart = ev
    } else if (ev.type === 'compaction/end') {
      unmatchedCompactionStart = undefined
    } else if (ev.type === 'tool/call') {
      const turn = ev.data.turn ?? currentTurn
      callMap.set(ev.data.callId, {
        callSeq: ev.seq,
        callId: ev.data.callId,
        name: ev.data.name,
        turn,
        step: ev.data.step,
        arguments: ev.data.arguments,
      })
    } else if (ev.type === 'tool/result') {
      const cid = ev.data?.message?.source?.callId
      if (cid) settledCalls.add(cid)
    }

    const explicitTurn = ev.data && typeof ev.data === 'object' && typeof ev.data.turn === 'number' ? ev.data.turn : undefined
    eventTurnMap.set(ev.seq, explicitTurn !== undefined ? explicitTurn : currentTurn)
  }

  if (unmatchedCompactionStart && latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq) {
    unmatchedCompactionStart = undefined
  }

  const inFlightCalls = new Set()
  for (const cid of callMap.keys()) {
    if (!settledCalls.has(cid)) inFlightCalls.add(cid)
  }

  return {
    openTurn,
    lastTurn,
    unmatchedCompactionStart,
    eventTurnMap,
    callMap,
    inFlightCalls,
  }
}

/**
 * Recursively expand a seq or array of seqs through `sourceEventSeqs` to collect
 * all original append-surface leaf event seqs (`surfaceOp === 'append'`), sorted ascending.
 */
export function resolveLeafSurfaceSeqs(events, rootSeqs) {
  const visited = new Set()
  const leaves = new Set()
  const stack = Array.isArray(rootSeqs) ? [...rootSeqs] : [rootSeqs]

  while (stack.length > 0) {
    const seq = stack.pop()
    if (typeof seq !== 'number' || visited.has(seq)) continue
    visited.add(seq)
    const ev = events[seq]
    if (!ev) continue

    // Tombstones are provenance pointers, not owners of another summary's leaves.
    if (isElidedPlaceholderEvent(ev)) continue
    if (ev.surfaceOp === 'append') {
      leaves.add(ev.seq)
      continue
    }
    if (Array.isArray(ev.sourceEventSeqs) && ev.sourceEventSeqs.length > 0) {
      for (const srcSeq of ev.sourceEventSeqs) {
        if (!visited.has(srcSeq)) stack.push(srcSeq)
      }
    }
  }

  return [...leaves].sort((a, b) => a - b)
}

/**
 * Determine the original turn range `{ minTurn, maxTurn, turns }` of any current surface node
 * by resolving its original leaf surface events (because a replacement checkpoint event has seq
 * at the time of compaction, not the original turn).
 */
export function resolveSurfaceNodeTurns(session, seq, logInfo) {
  const events = getAllEvents(session)
  const ev = events[seq]
  if (!ev) return { minTurn: 0, maxTurn: 0, turns: new Set(), leafSeqs: [] }

  // For turn attribution only, tombstones retain their own replaced leaves;
  // resolveLeafSurfaceSeqs intentionally treats them as non-owning recall nodes.
  const leafSeqs = ev.surfaceOp === 'append' ? [seq] : resolveLeafSurfaceSeqs(events, isElidedPlaceholderEvent(ev) ? ev.sourceEventSeqs : [seq])
  const turns = new Set()
  let minTurn = Infinity
  let maxTurn = -Infinity

  const targetSeqs = leafSeqs.length > 0 ? leafSeqs : [seq]
  for (const s of targetSeqs) {
    const t = logInfo.eventTurnMap.get(s) ?? 0
    if (t > 0) {
      turns.add(t)
      if (t < minTurn) minTurn = t
      if (t > maxTurn) maxTurn = t
    }
  }

  if (minTurn === Infinity) {
    const fallback = logInfo.eventTurnMap.get(seq) ?? 0
    minTurn = fallback
    maxTurn = fallback
    if (fallback > 0) turns.add(fallback)
  }

  return { minTurn, maxTurn, turns, leafSeqs }
}

/**
 * Format text content from an event for display/recall.
 */
export function extractEventText(ev, callMap) {
  if (!ev) return ''
  if (ev.type === 'tool/result') {
    const msg = ev.data?.message
    const callId = msg?.source?.callId ?? ''
    const callInfo = callMap?.get(callId)
    const toolName = callInfo?.name ?? 'tool'
    const blocks = toolResultBlocks(msg)
    const text = blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
    return `[seq=${ev.seq} turn=${ev.data?.turn ?? '?'} tool/result callId=${callId} tool=${toolName}]\n${text}`
  }
  if (ev.type === 'user/message') {
    const blocks = ev.data?.content ?? []
    const text = blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
    const srcKind = ev.data?.source?.kind ?? 'user'
    return `[seq=${ev.seq} user/message source=${srcKind}]\n${text}`
  }
  if (ev.type === 'assistant/message') {
    const blocks = ev.data?.message?.content ?? []
    const parts = blocks.map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'reasoning') return `<thinking>${b.text}</thinking>`
      if (b.type === 'tool-call') return `[tool-call id=${b.id} name=${b.name} args=${b.arguments}]`
      return `[${b.type}]`
    })
    return `[seq=${ev.seq} turn=${ev.data?.turn ?? '?'} assistant/message]\n${parts.join('\n')}`
  }
  return `[seq=${ev.seq} ${ev.type}] ${JSON.stringify(ev.data)}`
}

/**
 * Build the large-block directory line for non-current-turn items > thresholdTokens.
 * Single line format for minimal token cost.
 */
export function buildLargeBlocksDirectory(session, tokenMeter, options = {}) {
  const threshold = options.thresholdTokens ?? DEFAULT_LARGE_BLOCK_TOKENS
  const logInfo = inspectSessionLog(session)
  const measurement = tokenMeter.measure(session)
  const surfaceNodes = session.surface.nodes
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, n.tokens)

  const items = []
  for (const seq of surfaceNodes) {
    const tokens = pricedBySeq.get(seq) ?? 0
    if (tokens <= threshold) continue
    const ev = getAllEvents(session)[seq]
    if (!ev) continue
    if (isProtectedSystemNode(session, seq) || isSystemPromptSnapshotEvent(ev)) continue
    const nodeTurns = resolveSurfaceNodeTurns(session, seq, logInfo)
    if (logInfo.openTurn !== null && nodeTurns.maxTurn === logInfo.openTurn) continue
    if (ev.surfaceOp !== 'append') continue

    if (ev.type === 'tool/result') {
      const callId = ev.data?.message?.source?.callId ?? ''
      const toolName = logInfo.callMap.get(callId)?.name ?? 'tool'
      items.push(`${callId}(${toolName},T${nodeTurns.minTurn},${tokens}tok)`)
    } else if (ev.type === 'assistant/message' || ev.type === 'user/message') {
      items.push(`S${seq}(${ev.type === 'assistant/message' ? 'asst' : 'user'},T${nodeTurns.minTurn},${tokens}tok)`)
    }
  }

  if (items.length === 0) return ''
  return `[Large context blocks (>500 tok, non-current turn): ${items.join(', ')}]`
}

/**
 * Detailed inspect breakdown when `inspect: true` is passed to `context_compact`.
 */
export function buildInspectReport(session, tokenMeter, threshold = DEFAULT_LARGE_BLOCK_TOKENS) {
  const logInfo = inspectSessionLog(session)
  const measurement = tokenMeter.measure(session)
  const surfaceNodes = session.surface.nodes
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, n.tokens)

  const rows = []
  for (const seq of surfaceNodes) {
    const tokens = pricedBySeq.get(seq) ?? 0
    if (tokens < threshold) continue
    const ev = getAllEvents(session)[seq]
    if (!ev || isProtectedSystemNode(session, seq)) continue
    const nodeTurns = resolveSurfaceNodeTurns(session, seq, logInfo)
    const isCurrentTurn = logInfo.openTurn !== null && nodeTurns.maxTurn === logInfo.openTurn
    const isReplaced = ev.surfaceOp !== 'append'
    if (ev.type === 'tool/result') {
      const callId = ev.data?.message?.source?.callId ?? ''
      const toolName = logInfo.callMap.get(callId)?.name ?? 'tool'
      rows.push(`- seq=${seq} turn=T${nodeTurns.minTurn}${isCurrentTurn ? '(open)' : ''} type=tool/result callId=${callId} tool=${toolName} tokens=${tokens}${isReplaced ? ' [already-compacted]' : ''}`)
    } else {
      rows.push(`- seq=${seq} turn=T${nodeTurns.minTurn}${isCurrentTurn ? '(open)' : ''} type=${ev.type} tokens=${tokens}${isReplaced ? ' [already-compacted]' : ''}`)
    }
  }

  const ctxWin = session.requestContext()?.contextWindow
  const headerLine = `Surface: ${surfaceNodes.length} nodes, ${measurement.surfaceTokens} surface tokens, ${measurement.totalTokens} total tokens${ctxWin ? ` / ${ctxWin} window (${((measurement.totalTokens / ctxWin) * 100).toFixed(1)}%)` : ''}`
  if (rows.length === 0) return `${headerLine}\nNo surface nodes >= ${threshold} tokens.`
  return `${headerLine}\nLarge surface nodes (>= ${threshold} tokens):\n${rows.join('\n')}`
}

/**
 * Resolve one endpoint selector (`turn:N`, `turnsBack:N`, or `callId`) into a surface index.
 */
function resolveEndpointSurfaceIndices(session, selector, isEnd, logInfo, surfaceNodes, nodeTurnsList) {
  const raw = String(selector ?? '').trim()
  if (!raw) throw new Error('empty span endpoint selector')

  let targetTurn = null
  const turnMatch = /^turn:\s*(-?\d+)$/i.exec(raw)
  const turnsBackMatch = /^turnsBack:\s*(-?\d+)$/i.exec(raw)
  const latestClosed = /^(?:latest|latest-closed|auto)$/i.test(raw)

  if (latestClosed) {
    if (!isEnd && /^(?:auto|latest-compacted)$/i.test(raw)) throw new Error('from auto/latest-compacted must be resolved by planSpanCompaction')
    targetTurn = logInfo.openTurn === null ? logInfo.lastTurn : logInfo.openTurn - 1
  } else if (turnMatch) {
    targetTurn = Number(turnMatch[1])
    if (targetTurn <= 0) throw new Error(`invalid turn selector "${raw}": turn must be >= 1`)
  } else if (turnsBackMatch) {
    const back = Number(turnsBackMatch[1])
    if (back < 1) throw new Error(`invalid turnsBack selector "${raw}": must be >= 1 (cannot cover current open turn)`)
    const baseTurn = logInfo.openTurn ?? logInfo.lastTurn
    targetTurn = baseTurn - back
    if (targetTurn < 1) throw new Error(`turnsBack selector "${raw}" resolves to turn ${targetTurn} (< 1; current turn is ${baseTurn})`)
  }

  if (targetTurn !== null) {
    if (targetTurn < 1) throw new Error(`span endpoint "${raw}" has no closed turns to compact`)
    const exact = []
    const replaced = []
    for (let idx = 0; idx < surfaceNodes.length; idx++) {
      const nt = nodeTurnsList[idx]
      if (!nt.turns.has(targetTurn) || (logInfo.openTurn !== null && nt.maxTurn >= logInfo.openTurn)) continue
      if (getAllEvents(session)[surfaceNodes[idx]]?.surfaceOp === 'append') exact.push(idx)
      else replaced.push(idx)
    }
    if (exact.length) return { index: isEnd ? exact.at(-1) : exact[0], resolvedTurn: targetTurn }
    if (replaced.length) {
      // A later raw turn may physically precede a detached tombstone from a
      // multi-cluster compaction. Endpoints remain physical surface indices;
      // auto's F..E slice absorbs all such tombstones in that closed interval.
      return { index: isEnd ? replaced.at(-1) : replaced[0], resolvedTurn: targetTurn }
    }
    // 只使用未压缩 append 节点；闭合检查包含 >= openTurn，防止超界回合越过防线。
    const candidates = []
    for (let idx = 0; idx < surfaceNodes.length; idx++) {
      const nt = nodeTurnsList[idx]
      if (getAllEvents(session)[surfaceNodes[idx]]?.surfaceOp !== 'append' || nt.minTurn < 1) continue
      if (logInfo.openTurn !== null && nt.maxTurn >= logInfo.openTurn) continue
      candidates.push({ idx, turn: isEnd ? nt.maxTurn : nt.minTurn })
    }
    const pool = isEnd
      ? candidates.filter((c) => c.turn <= targetTurn)
      : candidates.filter((c) => c.turn >= targetTurn)
    if (!pool.length) {
      if (replaced.length) return { index: isEnd ? replaced.at(-1) : replaced[0], resolvedTurn: targetTurn }
      const replacedInward = []
      for (let idx = 0; idx < surfaceNodes.length; idx++) {
        const ev = getAllEvents(session)[surfaceNodes[idx]]
        const nt = nodeTurnsList[idx]
        if (!ev || ev.surfaceOp === 'append') continue
        if (isEnd ? nt.maxTurn <= targetTurn : nt.minTurn >= targetTurn) replacedInward.push({ idx, turn: isEnd ? nt.maxTurn : nt.minTurn })
      }
      if (replacedInward.length) {
        const chosen = replacedInward.reduce((best, c) => isEnd ? (c.idx > best.idx ? c : best) : (c.idx < best.idx ? c : best))
        return { index: chosen.idx, resolvedTurn: chosen.turn }
      }
      throw new Error(`no compactable closed-turn events found in span direction for selector "${raw}" (turn ${targetTurn})`)
    }
    const chosen = pool.reduce((best, c) => isEnd
      ? (c.turn > best.turn ? c : best)
      : (c.turn < best.turn ? c : best))
    const sameTurn = candidates.filter((c) => c.turn === chosen.turn)
    return { index: isEnd ? sameTurn.at(-1).idx : sameTurn[0].idx, resolvedTurn: chosen.turn }
  }

  // Otherwise treat selector as callId (or @call:callId)
  const callId = raw.replace(/^@call:/, '')
  for (let idx = 0; idx < surfaceNodes.length; idx++) {
    const ev = getAllEvents(session)[surfaceNodes[idx]]
    if (!ev) continue
    if (ev.type === 'tool/result' && ev.data?.message?.source?.callId === callId) {
      if (isEnd) return idx
      // If `from` is a callId, locate the assistant/message that issued this tool-call so the pair stays balanced!
      for (let j = idx - 1; j >= 0; j--) {
        const aev = getAllEvents(session)[surfaceNodes[j]]
        if (aev?.type === 'assistant/message' && aev.data?.message?.content?.some((b) => b.type === 'tool-call' && b.id === callId)) {
          return j
        }
      }
      return idx
    }
    if (ev.type === 'assistant/message') {
      const hasCall = ev.data?.message?.content?.some((b) => b.type === 'tool-call' && b.id === callId)
      if (hasCall) {
        if (!isEnd) return idx
        for (let j = idx + 1; j < surfaceNodes.length; j++) {
          const rev = getAllEvents(session)[surfaceNodes[j]]
          if (rev?.type === 'tool/result' && rev.data?.message?.source?.callId === callId) return j
        }
        return idx
      }
    }
  }
  throw new Error(`span endpoint "${raw}" not found on current session surface`)
}

/**
 * Normalize a relative `turnsBack:N` selector to a stable `turn:M` selector at staging time
 * so cross-turn retries after abort/failure still target the originally intended turn.
 */
function normalizeEndpointSelector(selector, logInfo) {
  const raw = String(selector ?? '').trim()
  const turnsBackMatch = /^turnsBack:\s*(-?\d+)$/i.exec(raw)
  if (turnsBackMatch) {
    const back = Number(turnsBackMatch[1])
    const baseTurn = logInfo.openTurn ?? logInfo.lastTurn
    const targetTurn = baseTurn - back
    if (back >= 1 && targetTurn >= 1) {
      return `turn:${targetTurn}`
    }
  }
  const turnMatch = /^turn:\s*(-?\d+)$/i.exec(raw)
  if (turnMatch) {
    return `turn:${Number(turnMatch[1])}`
  }
  return raw.replace(/^@call:/, '')
}

/** Latest fully closed turn: openTurn-1 when a turn is open, otherwise lastTurn. */
export function latestClosedTurn(logInfo) {
  if (!logInfo) return 0
  if (logInfo.openTurn !== null && Number.isFinite(logInfo.openTurn)) {
    return logInfo.openTurn - 1
  }
  return Number.isFinite(logInfo.lastTurn) ? logInfo.lastTurn : 0
}

/**
 * Parse one `spans[].turns` token into absolute turn numbers.
 * Supports 226, "226", "turn:226", "turnsBack:3", "235..237", "turn:235..turn:237".
 * `turnsBack:N` is relative to the latest closed turn (turnsBack:1 = that turn).
 */
export function parseTurnsToken(raw, latestClosed) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.trunc(raw)
    if (n < 1) throw new Error(`invalid turn selector "${raw}": turn must be >= 1`)
    return [n]
  }
  const s = String(raw ?? '').trim()
  if (!s) throw new Error('empty turns selector')

  const turnsBackMatch = /^turnsBack:\s*(-?\d+)$/i.exec(s)
  if (turnsBackMatch) {
    const back = Number(turnsBackMatch[1])
    if (back < 1) throw new Error(`invalid turnsBack selector "${s}": must be >= 1 (cannot cover current open turn)`)
    if (!Number.isFinite(latestClosed) || latestClosed < 1) {
      throw new Error(`turnsBack selector "${s}" has no closed turns to compact`)
    }
    const targetTurn = latestClosed - back + 1
    if (targetTurn < 1) {
      throw new Error(`turnsBack selector "${s}" resolves to turn ${targetTurn} (< 1; latest closed turn is ${latestClosed})`)
    }
    return [targetTurn]
  }

  const rangeMatch = /^(?:turn:\s*)?(\d+)\s*\.\.\s*(?:turn:\s*)?(\d+)$/i.exec(s)
  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const end = Number(rangeMatch[2])
    if (start < 1 || end < 1) throw new Error(`invalid turn range "${s}": turn must be >= 1`)
    if (start > end) throw new Error(`invalid turn range "${s}": start ${start} > end ${end}`)
    const out = []
    for (let t = start; t <= end; t++) out.push(t)
    return out
  }

  const turnMatch = /^(?:turn:\s*)?(\d+)$/i.exec(s)
  if (turnMatch) {
    const n = Number(turnMatch[1])
    if (n < 1) throw new Error(`invalid turn selector "${s}": turn must be >= 1`)
    return [n]
  }

  throw new Error(`unrecognized turns selector "${s}" (use 226, "turn:226", "turnsBack:3", "235..237", or "turn:235..turn:237")`)
}

function formatTurnsLabel(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return ''
  const sorted = [...turns].map(Number).sort((a, b) => a - b)
  const parts = []
  let runStart = sorted[0]
  let runPrev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const t = sorted[i]
    if (t === runPrev + 1) {
      runPrev = t
      continue
    }
    parts.push(runStart === runPrev ? `${runStart}` : `${runStart}..${runPrev}`)
    runStart = runPrev = t
  }
  return parts.join(',')
}

function canonicalTurnList(sp) {
  if (!sp) return null
  if (Array.isArray(sp.resolvedTurns) && sp.resolvedTurns.length > 0) {
    return [...sp.resolvedTurns].map(Number).sort((a, b) => a - b)
  }
  return null
}

/**
 * Resolve `spanSpec.turns` / `resolvedTurns` to unique closed-turn numbers.
 * Open turns are dropped; if nothing remains, throws.
 */
export function resolveSpanTurns(spanSpec, logInfo) {
  const latestClosed = latestClosedTurn(logInfo)
  const openTurn = logInfo.openTurn
  const rawList = Array.isArray(spanSpec?.resolvedTurns) && spanSpec.resolvedTurns.length > 0
    ? spanSpec.resolvedTurns
    : spanSpec?.turns
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error('span turns must be a non-empty array')
  }
  const set = new Set()
  for (const token of rawList) {
    for (const t of parseTurnsToken(token, latestClosed)) set.add(t)
  }
  const requested = [...set].sort((a, b) => a - b)
  const closed = requested.filter((t) => openTurn === null || t < openTurn)
  if (closed.length === 0) {
    if (openTurn !== null && requested.some((t) => t >= openTurn)) {
      throw new Error(`span turns [${formatTurnsLabel(requested)}] cannot cover events from the current open turn (turn ${openTurn})`)
    }
    throw new Error(`span turns [${formatTurnsLabel(requested)}] has no closed turns to compact`)
  }
  return closed
}

function groupContiguousSurfaceSeqs(surfaceNodes, targetSeqs) {
  const want = new Set(targetSeqs)
  const clusters = []
  let current = null
  for (const seq of surfaceNodes) {
    if (!want.has(seq)) {
      current = null
      continue
    }
    if (current) current.seqs.push(seq)
    else {
      current = { seqs: [seq] }
      clusters.push(current)
    }
  }
  return clusters
}

function hasExplicitTurns(spanSpec) {
  return (Array.isArray(spanSpec?.turns) && spanSpec.turns.length > 0)
    || (Array.isArray(spanSpec?.resolvedTurns) && spanSpec.resolvedTurns.length > 0)
}

function firstText(ev) {
  return (ev?.data?.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
}
function isSummaryCheckpointEvent(ev) {
  return Boolean(ev?.type === 'user/message' && ev.surfaceOp !== 'append' &&
    (ev.data?.source?.kind === 'compact-checkpoint' ||
      (ev.data?.source?.kind === 'plugin' && ev.data.source.plugin === 'compact')) &&
    !isElidedPlaceholderEvent(ev))
}
function isElidedPlaceholderEvent(ev) {
  return Boolean(ev?.type === 'user/message' && ev.surfaceOp !== 'append' &&
    (ev.data?.source?.kind === 'context-compact-elide' ||
      (ev.data?.source?.kind === 'plugin' && ev.data.source.plugin === 'context-compact-elide') ||
      ev.data?.source?.contextCompactElide === true ||
      /^\[Compact elided (?:S\d+-S?\d+|turns:[\d,.\-]+) /.test(firstText(ev))))
}
function checkpointTurnsLabel(ev, events, logInfo) {
  const leaves = resolveLeafSurfaceSeqs(events, [ev.seq])
  const turns = [...new Set(leaves.map((seq) => logInfo.eventTurnMap.get(seq) ?? 0).filter((t) => t > 0))].sort((a, b) => a - b)
  return formatTurnsLabel(turns)
}
function carriedSummaryBlock(ev, events, logInfo) {
  const text = (ev.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const inner = text.replace(/^[\s\S]*?<compacted-summary>\s*/i, '').replace(/\s*<\/compacted-summary>[\s\S]*$/i, '').trim()
  return `[Compact carried turns:${checkpointTurnsLabel(ev, events, logInfo)}] ${inner}`
}
function splitRangeLabel(start, end) {
  return `S${start}-${end}`
}

/** A hull is only a lookup key: recall always follows the checkpoint's exact provenance. */
export function formatSpanTag(ranges, turns) {
  const rs = Array.isArray(ranges) ? ranges : []
  let label
  if (rs.length > 3) {
    const pair = (r) => Array.isArray(r) ? r : /^S?(\d+)-(\d+)$/.exec(String(r))?.slice(1).map(Number)
    const first = pair(rs[0]); const last = pair(rs.at(-1))
    if (!first || !last) throw new Error('invalid span ranges')
    label = `S${first[0]}-${last[1]}`
  } else {
    label = rs.map((r) => Array.isArray(r) ? splitRangeLabel(r[0], r[1]) : String(r)).join('+')
  }
  const turnLabel = Array.isArray(turns) && turns.length ? ` turns:${formatTurnsLabel(turns)}` : (typeof turns === 'string' && turns ? ` turns:${turns}` : '')
  return `@span:${label}${turnLabel}`
}
function leafRanges(leaves) {
  const ranges = []
  for (let i = 0; i < leaves.length;) {
    let j = i
    while (j + 1 < leaves.length && leaves[j + 1] === leaves[j] + 1) j++
    ranges.push(splitRangeLabel(leaves[i], leaves[j]))
    i = j + 1
  }
  return ranges
}

function isSystemPromptSnapshotEvent(ev) {
  return ev?.data?.source?.plugin === '@deepseek-ai/dsh-system-prompt' || ev?.data?.source?.kind === 'runtime-context'
}

function configuredPositive(options, key, fallback, allowZero = false) {
  const value = options?.[key]
  return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
    ? value
    : fallback
}

function inspectFreeRideWindow(session, logInfo, options = {}, now = Date.now()) {
  const idleMs = configuredPositive(options, 'piggybackIdleMs', DEFAULT_PIGGYBACK_IDLE_MS, true)
  let latestModelRequestTime = null
  let latestDispatchCall = null
  let previousClosedTurnEndTime = null
  let activeTurnUserTime = null
  let activeTurnHasModelActivity = false
  for (const ev of getAllEvents(session)) {
    if (!ev) continue
    const inOpenTurn = logInfo.openTurn !== null && logInfo.eventTurnMap.get(ev.seq) === logInfo.openTurn
    if (inOpenTurn && ev.type === 'user/message') activeTurnUserTime = ev.data?.time ?? ev.time ?? activeTurnUserTime
    if (ev.type === 'request/header' || ev.type === 'assistant/message') {
      latestModelRequestTime = ev.data?.time ?? ev.time
      if (inOpenTurn) activeTurnHasModelActivity = true
    } else if (ev.type === 'tool/call' && BACKGROUND_DISPATCH_TOOLS.has(ev.data?.name)) {
      latestDispatchCall = { callId: ev.data.callId, toolName: ev.data.name, turn: logInfo.eventTurnMap.get(ev.seq) ?? 0, time: ev.time }
    }
    // A newly-opened turn's user message is not idle evidence. Use the prior
    // closed turn's durable end (or its final event) as the cold-start anchor.
    if (ev.type === 'turn/end' || ev.type === 'turn/start') {
      previousClosedTurnEndTime = ev.data?.time ?? ev.time ?? previousClosedTurnEndTime
    }
  }
  if (logInfo.openTurn !== null && !activeTurnHasModelActivity && previousClosedTurnEndTime !== null) latestModelRequestTime = previousClosedTurnEndTime
  else if (activeTurnUserTime !== null && (latestModelRequestTime === null || latestModelRequestTime === activeTurnUserTime)) latestModelRequestTime = null
  const elapsedMs = latestModelRequestTime === null ? null : Math.max(0, now - latestModelRequestTime)
  const idleTriggered = elapsedMs !== null && elapsedMs >= idleMs
  return {
    active: Boolean(latestDispatchCall || idleTriggered),
    dispatch: latestDispatchCall,
    idleTriggered,
    elapsedMs,
    latestModelRequestTime,
  }
}

function selectorIsTurnBased(...selectors) {
  for (const sel of selectors) {
    const raw = String(sel ?? '').trim()
    if (/^turn:\s*\d+$/i.test(raw) || /^turnsBack:\s*\d+$/i.test(raw) || /^(?:latest|latest-closed|auto)$/i.test(raw)) return true
  }
  return false
}

export function parseAutoSummary(raw) {
  const match = /^@auto(?:\s+([\s\S]+))?$/.exec(String(raw || '').trim())
  return { auto: Boolean(match), tail: match?.[1]?.trim() || '' }
}
function autoTokens(text) { return Math.ceil(Array.from(String(text || '')).length / 2) }
function limitAutoSummary(text, maxTokens = 150) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  return Array.from(source).slice(0, Math.max(1, maxTokens * 2)).join('')
}
/** 零 LLM 的确定性摘要；保留机器头/交付块/文件/失败命令，硬上限 150 tokens。 */
export function buildAutoSpanDigest(session, logInfo, seqs, maxTokens = 150) {
  const asks = [], conclusions = [], pipelines = [], files = new Set(), fails = []
  const first = (text, max) => String(text || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean)?.slice(0, max) || ''
  for (const seq of seqs || []) {
    const ev = getEvent(session, seq)
    if (!ev) continue
    if (ev.type === 'user/message' && !isSystemPromptSnapshotEvent(ev)) {
      const text = (ev.data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      const head = text.match(/relay_dispatch_v2:\s*1[^\r\n]*/)?.[0]
      if (head) pipelines.push(head)
      else if ((ev.data?.source?.kind || 'user') === 'user') { const line = first(text, 80); if (line) asks.push(line) }
      for (const match of text.matchAll(/^(?:changed_files|verification):\s*(.+)$/gim)) conclusions.push(match[0].slice(0, 120))
    } else if (ev.type === 'assistant/message') {
      const text = (ev.data?.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      const line = first(text, 120); if (line) conclusions.push(line)
      for (const block of ev.data?.message?.content || []) if (block.type === 'tool-call' && ['write', 'edit'].includes(block.name)) {
        try { const args = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; if (args?.file_path) files.add(args.file_path) } catch {}
      }
    } else if (ev.type === 'tool/call' && ['write', 'edit'].includes(ev.data?.name)) {
      const path = ev.data?.arguments?.file_path || ev.data?.args?.file_path; if (path) files.add(path)
    } else if (ev.type === 'tool/result') {
      const text = toolResultBlocks(ev.data?.message).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      const head = text.match(/relay_dispatch_v2:\s*1[^\r\n]*/)?.[0]; if (head) pipelines.push(head)
      if (/\[exit code: [1-9]\d*\]/.test(text)) fails.push(first(text, 80))
    }
  }
  const turns = [...new Set((seqs || []).map((s) => logInfo?.eventTurnMap?.get(s)).filter(Boolean))]
  const text = `[Auto T${formatTurnsLabel(turns) || '?'}] ask: ${asks.at(-1) || '(none)'} | concl: ${conclusions.at(-1) || '(none)'} | pipeline: ${pipelines.at(-1) || 'none'} | files: ${[...files].join(', ') || 'none'} | fails: ${fails.join('; ') || 'none'}`
  return limitAutoSummary(text, maxTokens)
}

/**
 * Return old summary checkpoints whose complete leaf set is owned by another
 * checkpoint. Equal sets keep the newest node; partial overlaps are untouched.
 * No text is generated and no session mutation happens here.
 */
export function findRedundantSummaryCheckpoints(session, excludedSeqs = []) {
  const excluded = new Set(excludedSeqs)
  const events = getAllEvents(session)
  const nodes = (session?.surface?.nodes ?? []).map((seq) => {
    const ev = getEvent(session, seq)
    if (!isSummaryCheckpointEvent(ev)) return null
    const leafSeqs = resolveLeafSurfaceSeqs(events, [seq])
    return leafSeqs.length ? { seq, leaves: new Set(leafSeqs) } : null
  }).filter(Boolean)
  const redundant = []
  for (const a of nodes) {
    if (excluded.has(a.seq)) continue
    const owner = nodes.find((b) => b.seq !== a.seq && b.leaves.size >= a.leaves.size
      && (b.leaves.size > a.leaves.size || b.seq > a.seq)
      && [...a.leaves].every((seq) => b.leaves.has(seq)))
    if (owner) redundant.push(a.seq)
  }
  return redundant.sort((a, b) => a - b)
}

function buildSpanPlan(session, tokenMeter, fields, minSavingsTokens) {
  const {
    from,
    to,
    resolvedFrom,
    resolvedTo,
    summary,
    allowMerge,
    startSeq,
    endSeq,
    resolvedTurns,
    turns,
  } = fields
  let { shadowedSeqs, clusters } = fields

  const events = getAllEvents(session)
  const logInfo = inspectSessionLog(session)
  const redundantSummarySeqs = findRedundantSummaryCheckpoints(session, shadowedSeqs)
  if (redundantSummarySeqs.length) {
    const baseSeqs = [...shadowedSeqs]
    shadowedSeqs = [...baseSeqs, ...redundantSummarySeqs]
    const ordered = new Map((session?.surface?.nodes ?? []).map((seq, index) => [seq, index]))
    shadowedSeqs.sort((a, b) => (ordered.get(a) ?? 0) - (ordered.get(b) ?? 0))
    // Keep the original contiguous span intact. Covered checkpoints can be
    // anywhere on the surface and must be pruned independently, never by a
    // broad replace that would also shadow unrelated nodes between them.
    clusters = [...(clusters?.length ? clusters : [{ seqs: baseSeqs }]), ...redundantSummarySeqs.map((seq) => ({ seqs: [seq] }))]
  }
  const leafSeqs = resolveLeafSurfaceSeqs(events, shadowedSeqs)
  const minLeaf = leafSeqs.length > 0 ? leafSeqs[0] : startSeq
  const maxLeaf = leafSeqs.length > 0 ? leafSeqs[leafSeqs.length - 1] : endSeq

  const measurement = tokenMeter.measure(session)
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, nodeTokens(n))
  const shadowedTokenCount = shadowedSeqs.reduce((acc, s) => acc + (pricedBySeq.get(s) ?? 0), 0)

  const ranges = clusters?.length > 1
    ? clusters.map((c) => {
        const leaves = resolveLeafSurfaceSeqs(events, c.seqs)
        return [leaves[0] ?? c.seqs[0], leaves.at(-1) ?? c.seqs.at(-1)]
      })
    : leafRanges(leafSeqs).map((r) => /^S(\d+)-(\d+)$/.exec(r).slice(1).map(Number))
  if (!ranges.length) ranges.push([minLeaf, maxLeaf])
  const turnLabel = Array.isArray(resolvedTurns) && resolvedTurns.length > 0 ? ` turns:${formatTurnsLabel(resolvedTurns)}` : ''
  const recallTag = `[recall: ${formatSpanTag(ranges, resolvedTurns)}]`
  const carried = (fields.carried ?? []).map((ev) => carriedSummaryBlock(ev, events, logInfo))
  const auto = parseAutoSummary(summary)
  const resolvedSummary = auto.auto ? limitAutoSummary(`${buildAutoSpanDigest(session, logInfo, shadowedSeqs)}${auto.tail ? ` | ${auto.tail}` : ''}`) : summary.trim()
  const formattedText = [...carried, `[Compact${turnLabel}] ${resolvedSummary} ${recallTag}`].join('\n')
  const summaryBlocks = [{ type: 'text', text: formattedText }]
  const framedContent = [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summaryBlocks,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]

  const tempCompactionId = randomUUID()
  const previewMessage = createUserMessage({
    content: framedContent,
    source: compactCheckpointSource(tempCompactionId, undefined, session),
  })
  let newTokenCount = tokenMeter.estimateMessage(previewMessage)
  if (Array.isArray(clusters) && clusters.length > 1) {
    for (let i = 1; i < clusters.length; i++) {
      const cSeqs = clusters[i].seqs
      const cLeaves = resolveLeafSurfaceSeqs(events, cSeqs)
      const cMin = cLeaves.length > 0 ? cLeaves[0] : cSeqs[0]
      const cMax = cLeaves.length > 0 ? cLeaves.at(-1) : cSeqs.at(-1)
      const elideMsg = createUserMessage({
        content: [{ type: 'text', text: `[Compact elided turns:${formatTurnsLabel([...new Set(cLeaves.map((seq) => logInfo.eventTurnMap.get(seq)).filter(Boolean))] || `${cMin}-${cMax}`)} → summarized above, ${recallTag}]` }],
        source: makeElideSource(session, tempCompactionId),
      })
      newTokenCount += tokenMeter.estimateMessage(elideMsg)
    }
  }
  const savings = shadowedTokenCount - newTokenCount

  if (newTokenCount >= shadowedTokenCount) {
    throw new Error(`span replacement (${newTokenCount} tokens) is not smaller than shadowed range (${shadowedTokenCount} tokens)`)
  }
  if (savings < minSavingsTokens) {
    throw new Error(`span token savings (${savings} tokens) is below minimum threshold (${minSavingsTokens} tokens)`)
  }

  const compactedSeqs = [...shadowedSeqs]
  return {
    kind: 'span',
    from,
    to,
    resolvedFrom,
    resolvedTo,
    summary: auto.auto ? limitAutoSummary(resolvedSummary) : resolvedSummary,
    mergeSummaries: allowMerge,
    startSeq: shadowedSeqs[0] ?? startSeq,
    endSeq: shadowedSeqs.at(-1) ?? endSeq,
    shadowedSeqs,
    compactedSeqs,
    sourceEventSeqs: compactedSeqs,
    leafSeqs,
    minLeaf,
    maxLeaf,
    shadowedTokenCount,
    newTokenCount,
    savings,
    recallTag,
    summaryBlocks,
    framedContent,
    ...(Array.isArray(resolvedTurns) ? { resolvedTurns: [...resolvedTurns] } : {}),
    ...(Array.isArray(turns) ? { turns: [...turns] } : {}),
    ...(Array.isArray(clusters) ? { clusters: clusters.map((c) => ({ seqs: [...c.seqs] })) } : {}),
    carriedSeqs: (fields.carried ?? []).map((ev) => ev.seq),
    redundantSummarySeqs,
    detachedCount: fields.detachedCount ?? 0,
    frontierIndex: fields.frontierIndex,
    prefixClass: fields.prefixClass ?? (allowMerge ? 'rewrite' : 'append'),
  }
}

function planTurnsSpanCompaction(session, tokenMeter, spanSpec, minSavingsTokens, logInfo, surfaceNodes, nodeTurnsList) {
  const summary = spanSpec.summary
  const allowMerge = spanSpec?.mergeSummaries === true
  const resolvedTurns = resolveSpanTurns(spanSpec, logInfo)
  const targetTurnSet = new Set(resolvedTurns)
  const label = formatTurnsLabel(resolvedTurns)

  const eventAt = (idx) => getAllEvents(session)[surfaceNodes[idx]]
  const turnIndices = []
  for (let idx = 0; idx < surfaceNodes.length; idx++) {
    const ev = eventAt(idx)
    const nt = nodeTurnsList[idx]
    if (!ev || !nt) continue
    const intersects = [...nt.turns].some((t) => targetTurnSet.has(t))
    if (!intersects) continue
    if (logInfo.openTurn !== null && (nt.turns.has(logInfo.openTurn) || nt.maxTurn >= logInfo.openTurn)) continue
    if (isSystemPromptSnapshotEvent(ev) || isProtectedSystemNode(session, surfaceNodes[idx])) continue
    // Detached checkpoints and tombstones are part of the physical turn slice.
    // Checkpoints are carried verbatim; tombstones carry no independent content.
    if ((isSummaryCheckpointEvent(ev) || isElidedPlaceholderEvent(ev)) && allowMerge !== false) turnIndices.push(idx)
    else if (!isSummaryCheckpointEvent(ev) && !isElidedPlaceholderEvent(ev)) turnIndices.push(idx)
  }

  if (turnIndices.length === 0) {
    throw new Error(`span turns [${label}] has no uncompacted closed-turn events to compact`)
  }

  // Group contiguous surface runs per selected turn cluster so intra-turn single-result
  // replacements (tool/result with surfaceOp !== 'append') and system-prompt snapshots
  // inside a turn never split an assistant tool-call from its tool/result.
  const indexRuns = []
  let curRun = null
  for (const idx of turnIndices) {
    if (!curRun) {
      curRun = { startIdx: idx, endIdx: idx }
      indexRuns.push(curRun)
      continue
    }
    let canBridge = true
    for (let k = curRun.endIdx + 1; k < idx; k++) {
      const midEv = eventAt(k)
      const midNt = nodeTurnsList[k]
      const midInTurns = midNt && [...midNt.turns].some((t) => targetTurnSet.has(t))
      if (isProtectedSystemNode(session, surfaceNodes[k])) throw new Error(`span turns [${label}] cannot overwrite protected ${midEv?.type} at seq ${surfaceNodes[k]}`)
      if (!midInTurns && !isSystemPromptSnapshotEvent(midEv)) {
        canBridge = false
        break
      }
      if ((isSummaryCheckpointEvent(midEv) || isElidedPlaceholderEvent(midEv)) && !allowMerge) {
        canBridge = false
        break
      }
    }
    if (canBridge) curRun.endIdx = idx
    else {
      curRun = { startIdx: idx, endIdx: idx }
      indexRuns.push(curRun)
    }
  }

  const clusters = []
  const targetSeqs = []
  for (const run of indexRuns) {
    let s = run.startIdx
    let e = run.endIdx
    while (s <= e && isSystemPromptSnapshotEvent(eventAt(s))) s++
    while (e >= s && isSystemPromptSnapshotEvent(eventAt(e))) e--
    if (s > e) continue
    const seqs = surfaceNodes.slice(s, e + 1)
    const hasUncompacted = seqs.some((seq) => {
      const ev = getAllEvents(session)[seq]
      return ev && !isSystemPromptSnapshotEvent(ev) && (ev.surfaceOp === 'append' || (allowMerge && (isSummaryCheckpointEvent(ev) || isElidedPlaceholderEvent(ev))))
    })
    if (!hasUncompacted) continue
    clusters.push({ seqs })
    for (const seq of seqs) {
      if (isProtectedSystemNode(session, seq)) {
        throw new Error(`span turns [${label}] cannot overwrite ${getEvent(session, seq)?.type} at seq ${seq}`)
      }
      targetSeqs.push(seq)
    }
  }

  if (clusters.length === 0) {
    throw new Error(`span turns [${label}] has no compactable closed-turn events`)
  }

  for (const cluster of clusters) {
    const clusterStart = cluster.seqs[0]
    const clusterEnd = cluster.seqs.at(-1)
    if (!toolPairingBalancedBefore(session, clusterStart)) {
      throw new Error(`span turns [${label}] start at seq ${clusterStart} is not tool-pairing balanced before it (would split a tool-call/result pair)`)
    }
    if (!toolPairingBalancedAfter(session, clusterEnd)) {
      throw new Error(`span turns [${label}] end at seq ${clusterEnd} is not tool-pairing balanced after it (would split a tool-call/result pair or step is still open)`)
    }
  }

  const firstCluster = clusters[0]
  const carried = clusters.flatMap((cluster) => cluster.seqs.map((seq) => getEvent(session, seq)).filter((ev) => isSummaryCheckpointEvent(ev) && !allowMerge))
  const detachedCount = carried.filter((ev) => surfaceNodes.indexOf(ev.seq) > 0 && surfaceNodes.slice(0, surfaceNodes.indexOf(ev.seq)).some((seq) => !isSummaryCheckpointEvent(getEvent(session, seq)))).length
  const from = spanSpec.from ?? `turn:${resolvedTurns[0]}`
  const to = spanSpec.to ?? `turn:${resolvedTurns.at(-1)}`
  return buildSpanPlan(session, tokenMeter, {
    from,
    to,
    resolvedFrom: `turn:${resolvedTurns[0]}`,
    resolvedTo: `turn:${resolvedTurns.at(-1)}`,
    summary,
    allowMerge,
    startSeq: firstCluster.seqs[0],
    endSeq: firstCluster.seqs.at(-1),
    shadowedSeqs: targetSeqs,
    resolvedTurns,
    turns: Array.isArray(spanSpec.turns) ? [...spanSpec.turns] : [...resolvedTurns],
    clusters,
    carried,
    detachedCount,
  }, minSavingsTokens)
}

export function summaryFrontierIndex(session) {
  const nodes = session?.surface?.nodes ?? []
  let index = 0
  if (isV4Session(session) && getEvent(session, nodes[0])?.type === 'system/message') index = 1
  while (index < nodes.length) {
    const ev = getEvent(session, nodes[index])
    if (isSummaryCheckpointEvent(ev) || ev?.type === 'developer/message') index++
    else break
  }
  return index
}
export function classifySurfaceNode(session, seq, logInfo = inspectSessionLog(session)) {
  const ev = getEvent(session, seq), index = session.surface.nodes.indexOf(seq)
  const turns = resolveSurfaceNodeTurns(session, seq, logInfo)
  if (isV4Session(session) && index === 0 && ev?.type === 'system/message') return { kind: 'HEAD', ev, index, turns }
  if (ev?.type === 'developer/message') return { kind: 'DEV', ev, index, turns }
  if (ev?.type === 'system/message') return { kind: isProtectedSystemNode(session, seq) ? 'SYS_LATEST' : 'SYS_STALE', ev, index, turns }
  if (isSystemPromptSnapshotEvent(ev)) return { kind: 'SNAP', ev, index, turns }
  if (isSummaryCheckpointEvent(ev)) return { kind: index < summaryFrontierIndex(session) ? 'CP_PREFIX' : 'CP_DETACHED', ev, index, turns }
  if (isElidedPlaceholderEvent(ev)) return { kind: 'TOMB', ev, index, turns }
  if (logInfo.openTurn !== null && turns.maxTurn >= logInfo.openTurn) return { kind: 'OPEN', ev, index, turns }
  if (ev?.type === 'tool/result' && ev.surfaceOp !== 'append') return { kind: 'SINGLE', ev, index, turns }
  if (ev?.surfaceOp === 'append' && ['user/message', 'assistant/message', 'tool/result'].includes(ev.type)) return { kind: 'RAW', ev, index, turns }
  return { kind: 'DEV', ev, index, turns }
}
function planContinuousSlice(session, tokenMeter, spanSpec, minSavingsTokens, logInfo, surfaceNodes, nodeTurnsList, startIdx, endIdx, from, to, resolvedFrom, resolvedTo) {
  const allowMerge = spanSpec?.mergeSummaries === true
  const policy = spanSpec?.detachedPolicy ?? 'allow'
  if (!['allow', 'snap', 'reject'].includes(policy)) throw new Error(`invalid detachedPolicy "${policy}"`)
  const classes = surfaceNodes.map((seq) => classifySurfaceNode(session, seq, logInfo))
  const frontier = summaryFrontierIndex(session)
  if (!allowMerge && startIdx < frontier) {
    startIdx = frontier
    resolvedFrom = nodeTurnsList[startIdx]?.minTurn > 0 ? `turn:${nodeTurnsList[startIdx].minTurn}` : resolvedFrom
  }
  if (startIdx > endIdx) throw new Error('nothing to compact')
  const detachedBefore = classes.slice(frontier, startIdx).filter((c) => c.kind === 'CP_DETACHED').length
  if (policy === 'reject' && detachedBefore) throw new Error(`detached checkpoint(s) before requested start: ${detachedBefore}`)
  if (policy === 'snap') { startIdx = frontier; resolvedFrom = nodeTurnsList[startIdx]?.minTurn > 0 ? `turn:${nodeTurnsList[startIdx].minTurn}` : resolvedFrom }
  const clusters = []
  let current = null
  for (let i = startIdx; i <= endIdx; i++) {
    const c = classes[i]
    const barrier = ['HEAD', 'SYS_LATEST', 'DEV', 'OPEN'].includes(c.kind) || (c.kind === 'CP_PREFIX' && !allowMerge)
    if (barrier) { current = null; continue }
    if (!current) { current = { start: i, end: i, seqs: [] }; clusters.push(current) }
    current.end = i; current.seqs.push(surfaceNodes[i])
  }
  const trimmed = []
  for (const cluster of clusters) {
    let start = cluster.start, end = cluster.end
    while (start <= end && classes[start].kind === 'SNAP') start++
    while (end >= start && classes[end].kind === 'SNAP') end--
    if (start > end) continue
    const seqs = surfaceNodes.slice(start, end + 1)
    const selectedClasses = classes.slice(start, end + 1)
    const absorbOnly = spanSpec?.from === 'auto' || spanSpec?.from === 'latest-compacted'
    if (!selectedClasses.some((c) => c.kind === 'RAW' || c.kind === 'SINGLE' || (allowMerge && c.kind === 'CP_PREFIX') || (absorbOnly && (c.kind === 'TOMB' || c.kind === 'CP_DETACHED')))) continue
    trimmed.push({ seqs })
  }
  if (!trimmed.length) throw new Error('nothing to compact: no RAW/SINGLE nodes outside barriers')
  const safety = computeSurfaceCutSafety(session, logInfo)
  for (const cluster of trimmed) {
    const start = surfaceNodes.indexOf(cluster.seqs[0]), end = surfaceNodes.indexOf(cluster.seqs.at(-1))
    if (safety.unsafe[start] || safety.unsafe[end + 1]) throw new Error(`span cluster ${cluster.seqs[0]}..${cluster.seqs.at(-1)} would split a tool-call/result pair`)
    const owned = new Set(cluster.seqs)
    for (const defect of safety.defects) {
      const defectSeq = surfaceNodes[defect.index]
      if (!owned.has(defectSeq) && safety.turnOf[defect.index] > 0) {
        const anySelectedTurn = cluster.seqs.some((seq) => nodeTurnsList[surfaceNodes.indexOf(seq)]?.turns.has(safety.turnOf[defect.index]))
        if (anySelectedTurn) throw new Error(`defective turn ${safety.turnOf[defect.index]} must be compacted or excluded as a whole`)
      }
    }
  }
  const carried = trimmed.flatMap((c) => c.seqs.map((seq) => getEvent(session, seq)).filter((ev) => isSummaryCheckpointEvent(ev) && !allowMerge))
  const rawTurns = new Set()
  for (const c of trimmed) for (const seq of c.seqs) {
    const cls = classes[surfaceNodes.indexOf(seq)]
    if (cls.kind === 'RAW' || cls.kind === 'SINGLE') for (const turn of cls.turns.turns) if (turn > 0) rawTurns.add(turn)
  }
  const skippedRawBefore = classes.slice(frontier, startIdx).filter((c) => c.kind === 'RAW' || c.kind === 'SINGLE').length
  return buildSpanPlan(session, tokenMeter, {
    from, to, resolvedFrom, resolvedTo, summary: spanSpec.summary, allowMerge,
    startSeq: trimmed[0].seqs[0], endSeq: trimmed[0].seqs.at(-1),
    shadowedSeqs: trimmed.flatMap((c) => c.seqs), clusters: trimmed, carried,
    resolvedTurns: [...rawTurns].sort((a, b) => a - b),
    detachedCount: carried.length, frontierIndex: frontier,
    prefixClass: allowMerge && startIdx < frontier ? 'rewrite' : 'append',
    detachedWarning: skippedRawBefore ? `前面还有未压缩内容；下次使用 from:"auto" 自动携带合拢。` : '',
  }, minSavingsTokens)
}

/**
 * Plan and validate a span compaction on the current surface.
 *
 * Turn-based spans keep the `<compacted-summary>` prefix byte-immutable:
 * - A start that lands on an existing summary snaps right to the next uncompacted closed append
 *   unless `spanSpec.mergeSummaries === true`.
 * - If a summary bounds the nodes immediately before `startIdx`, and those nodes are uncompacted
 *   closed appends, `startIdx` auto-bridges to the first of them. A gap that reaches the surface
 *   head without a summary is left alone, so an explicit later `from` is not rewritten into turn 1.
 * - A summary strictly inside the range truncates the span in front of it unless `mergeSummaries`.
 *
 * When `spanSpec.turns` is set, only uncompacted events on those (possibly non-contiguous) closed
 * turns are collected. Unselected intermediate turns stay on the surface; existing
 * `<compacted-summary>` nodes are skipped unless `mergeSummaries === true`.
 */
export function planSpanCompaction(session, tokenMeter, spanSpec, minSavingsTokens = DEFAULT_MIN_SAVINGS_TOKENS) {
  const { to, summary } = spanSpec
  // Absorb duplicate summaries only alongside an actual new compaction. A
  // dedicated zero-output operation is deliberately absent to avoid hot-cache
  // prefix shifts. Epoch merging itself is cold-start only.
  if (spanSpec.mergeSummaries === true) {
    const now = spanSpec.now ?? Date.now()
    const freeRide = inspectFreeRideWindow(session, inspectSessionLog(session), {}, now)
    if (freeRide.elapsedMs === null || freeRide.elapsedMs < DEFAULT_PIGGYBACK_IDLE_MS) {
      throw new Error('mergeSummaries requires a cold start (idleMs >= 300000)')
    }
  }
  const from = spanSpec.from ?? 'auto'
  let effectiveFrom = spanSpec.resolvedFrom ?? from
  const effectiveTo = spanSpec.resolvedTo ?? to
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('span summary must be a non-empty string')
  }
  if (spanSpec.mergeSummaries === true && parseAutoSummary(summary).auto) throw new Error('@auto 不支持 mergeSummaries，请手写 Epoch 摘要')

  const logInfo = inspectSessionLog(session)
  if (logInfo.unmatchedCompactionStart) {
    throw new Error('compaction lock is already active on this session (unmatched compaction/start)')
  }

  const allSurfaceNodes = [...session.surface.nodes]
  if (allSurfaceNodes.length === 0) throw new Error('session surface is empty')
  const surfaceNodes = allSurfaceNodes

  const nodeTurnsList = surfaceNodes.map((seq) => resolveSurfaceNodeTurns(session, seq, logInfo))
  if (hasExplicitTurns(spanSpec)) {
    return planTurnsSpanCompaction(session, tokenMeter, spanSpec, minSavingsTokens, logInfo, surfaceNodes, nodeTurnsList)
  }
  if (to === undefined && spanSpec.resolvedTo === undefined) {
    throw new Error('span requires to or turns')
  }
  const autoStart = /^(?:auto|latest-compacted)$/i.test(String(from ?? '').trim())
  if (autoStart) {
    const end = resolveEndpointSurfaceIndices(session, effectiveTo, true, logInfo, surfaceNodes, nodeTurnsList)
    let endIdx = typeof end === 'number' ? end : end.index
    const endTurn = typeof end === 'object' ? end.resolvedTurn : null
    const startIdx = summaryFrontierIndex(session)
    while (endIdx + 1 < surfaceNodes.length && isElidedPlaceholderEvent(getEvent(session, surfaceNodes[endIdx + 1]))) endIdx++
    const startTurn = nodeTurnsList[startIdx]?.minTurn ?? endTurn
    return planContinuousSlice(session, tokenMeter, spanSpec, minSavingsTokens, logInfo, surfaceNodes, nodeTurnsList,
      startIdx, endIdx, from, to, `turn:${startTurn}`, `turn:${endTurn}`)
  }
  const start = resolveEndpointSurfaceIndices(session, effectiveFrom, false, logInfo, surfaceNodes, nodeTurnsList)
  const end = resolveEndpointSurfaceIndices(session, effectiveTo, true, logInfo, surfaceNodes, nodeTurnsList)
  let startIdx = typeof start === 'number' ? start : start.index
  let endIdx = typeof end === 'number' ? end : end.index
  let resolvedFromTurn = typeof start === 'object' ? start.resolvedTurn : null
  let resolvedToTurn = typeof end === 'object' ? end.resolvedTurn : null
  if (startIdx > endIdx && resolvedFromTurn !== null && resolvedToTurn !== null) {
    const requestedFrom = /^turn:\s*(\d+)$/i.exec(String(effectiveFrom).trim())
    const requestedTo = /^turn:\s*(\d+)$/i.exec(String(effectiveTo).trim())
    if (requestedFrom && requestedTo && requestedFrom[1] === requestedTo[1]) {
      const actualTurn = resolvedFromTurn
      if (actualTurn === resolvedToTurn && (nodeTurnsList[startIdx].turns.has(actualTurn) || nodeTurnsList[endIdx].turns.has(actualTurn))) {
        return planSpanCompaction(session, tokenMeter, {
          from: `turn:${actualTurn}`, to: `turn:${actualTurn}`, summary,
        }, minSavingsTokens)
      }
    }
  }
  if (startIdx > endIdx) {
    throw new Error(`span from "${from}" (surface index ${startIdx}) is after to "${to}" (surface index ${endIdx})`)
  }

  const turnBased = selectorIsTurnBased(effectiveFrom, from, spanSpec?.resolvedFrom, effectiveTo, to)
  const allowMerge = spanSpec?.mergeSummaries === true
  const originalStartIdx = startIdx
  const originalEndIdx = endIdx
  const requestedFromMatch = /^turn:\s*(\d+)$/i.exec(String(effectiveFrom ?? from ?? '').trim())
  const requestedFromTurn = requestedFromMatch ? Number(requestedFromMatch[1]) : null
  const startWasClampedForward = requestedFromTurn !== null && resolvedFromTurn !== null && resolvedFromTurn > requestedFromTurn
  const eventAt = (idx) => getAllEvents(session)[surfaceNodes[idx]]
  const isClosedUncompactedAppend = (idx) => {
    const ev = eventAt(idx)
    if (!ev || ev.surfaceOp !== 'append') return false
    if (isProtectedSystemNode(session, surfaceNodes[idx]) || isSystemPromptSnapshotEvent(ev) || isSummaryCheckpointEvent(ev)) return false
    const nt = nodeTurnsList[idx]
    if (!nt || nt.maxTurn < 1) return false
    if (logInfo.openTurn !== null && (nt.turns.has(logInfo.openTurn) || nt.maxTurn >= logInfo.openTurn)) return false
    return true
  }

  if (turnBased && !allowMerge && (isSummaryCheckpointEvent(eventAt(startIdx)) || isElidedPlaceholderEvent(eventAt(startIdx)))) {
    let next = startIdx + 1
    while (next <= endIdx && !isClosedUncompactedAppend(next)) next++
    if (next > endIdx) {
      throw new Error(
        `span [${from}..${to}] starts on an immutable <compacted-summary> checkpoint and no uncompacted closed turn remains before "${to}"; refusing to rewrite the summary prefix`
      )
    }
    startIdx = next
  }

  // Bridge only a gap that is bounded by a previous summary. Reaching the surface head
  // without a summary means the caller named a later start on purpose.
  if (turnBased && !startWasClampedForward) {
    let cursor = startIdx - 1
    let bridgeIdx = -1
    let boundedBySummary = false
    while (cursor >= 0) {
      const ev = eventAt(cursor)
      if (!ev) {
        cursor--
        continue
      }
      if (isSummaryCheckpointEvent(ev) || isElidedPlaceholderEvent(ev)) {
        boundedBySummary = true
        break
      }
      if (isSystemPromptSnapshotEvent(ev)) {
        cursor--
        continue
      }
      if (ev.surfaceOp !== 'append') break
      if (!isClosedUncompactedAppend(cursor)) break
      bridgeIdx = cursor
      cursor--
    }
    if (boundedBySummary && bridgeIdx >= 0) startIdx = bridgeIdx
  }

  // Detached checkpoints inside the selected interval are carried verbatim by
  // planContinuousSlice; never truncate in front of them or create an island.

  if (startIdx > endIdx) {
    throw new Error(`span from "${from}" (surface index ${startIdx}) is after to "${to}" (surface index ${endIdx}) after summary-prefix protection`)
  }

  if (startIdx !== originalStartIdx) {
    const bridgedTurn = nodeTurnsList[startIdx]?.minTurn ?? 0
    if (bridgedTurn > 0) resolvedFromTurn = bridgedTurn
  }
  if (endIdx !== originalEndIdx) {
    const trimmedTurn = nodeTurnsList[endIdx]?.maxTurn ?? 0
    if (trimmedTurn > 0) resolvedToTurn = trimmedTurn
  }

  const clampedFrom = resolvedFromTurn === null ? null : `turn:${resolvedFromTurn}`
  const clampedTo = resolvedToTurn === null ? null : `turn:${resolvedToTurn}`

  for (let i = startIdx; i <= endIdx; i++) {
    const nt = nodeTurnsList[i]
    const seq = surfaceNodes[i]
    if (isProtectedSystemNode(session, seq)) {
      throw new Error(`span [${from}..${to}] cannot overwrite protected ${getEvent(session, seq)?.type} at seq ${seq}`)
    }
    if (logInfo.openTurn !== null && (nt.turns.has(logInfo.openTurn) || nt.maxTurn === logInfo.openTurn)) {
      throw new Error(`span [${from}..${to}] cannot cover events from the current open turn (turn ${logInfo.openTurn})`)
    }
  }

  const startSeq = surfaceNodes[startIdx]
  const endSeq = surfaceNodes[endIdx]

  if (!toolPairingBalancedBefore(session, startSeq)) {
    throw new Error(`span start at seq ${startSeq} ("${from}") is not tool-pairing balanced before it (would split a tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, endSeq)) {
    throw new Error(`span end at seq ${endSeq} ("${to}") is not tool-pairing balanced after it (would split a tool-call/result pair or step is still open)`)
  }

  return planContinuousSlice(session, tokenMeter, spanSpec, minSavingsTokens, logInfo, surfaceNodes, nodeTurnsList,
    startIdx, endIdx, from, to, clampedFrom ?? normalizeEndpointSelector(effectiveFrom, logInfo), clampedTo ?? normalizeEndpointSelector(effectiveTo, logInfo))
}

/**
 * Execute one validated span compaction synchronously (4 events back-to-back, no await).
 */
export function commitSpanCompaction(session, tokenMeter, plan) {
  const currentPlan = planSpanCompaction(session, tokenMeter, {
    from: plan.from,
    to: plan.to,
    turns: plan.turns,
    resolvedFrom: /^(?:auto|latest-compacted)$/i.test(String(plan.from ?? '')) ? undefined : plan.resolvedFrom,
    resolvedTo: plan.resolvedTo,
    resolvedTurns: plan.turns ? plan.resolvedTurns : undefined,
    summary: plan.summary,
    mergeSummaries: plan.mergeSummaries === true,
    now: plan.now,
  }, 1)

  const logInfo = inspectSessionLog(session)
  const compactionId = randomUUID()
  const lifecycle = {
    compactionId,
    turn: logInfo.openTurn ?? logInfo.lastTurn,
  }

  const headerConfig = session.requestHeader()?.config
  const provider = headerConfig?.provider || 'context-compact'
  const model = headerConfig?.model || 'manual'

  const checkpointMessage = createUserMessage({
    content: currentPlan.framedContent,
    source: compactCheckpointSource(compactionId, undefined, session),
  })

  const clusters = Array.isArray(currentPlan.clusters) && currentPlan.clusters.length > 0
    ? currentPlan.clusters
    : [{ seqs: [...currentPlan.shadowedSeqs] }]
  const firstCluster = clusters[0]
  const firstStart = firstCluster.seqs[0]
  const firstEnd = firstCluster.seqs.at(-1)

  const measurement = tokenMeter.measure(session)
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, nodeTokens(n))
  const clusterTokenCount = (seqs) => seqs.reduce((acc, s) => acc + (pricedBySeq.get(s) ?? 0), 0)

  // Summary is anchored at the earliest cluster; later clusters become non-empty
  // tombstones. Every replace is immediately preceded by its exact claim.
  const startEvent = session.append('compaction/start', lifecycle)
  let summaryEvent, replaceEvent
  try {
    const firstTokens = clusterTokenCount(firstCluster.seqs)
    summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: currentPlan.summaryBlocks,
      shadowedRange: { start: firstStart, end: firstEnd },
      shadowedSeqs: [...firstCluster.seqs],
      shadowedTokenCount: firstTokens,
      provider,
      model,
    })
    replaceEvent = session.append('user/message', checkpointMessage, {
      surfaceOp: makeReplaceSurfaceOp(session, firstStart, firstEnd),
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...currentPlan.shadowedSeqs],
    })
    for (let i = 1; i < clusters.length; i++) {
      const cluster = clusters[i]
      const start = cluster.seqs[0]
      const end = cluster.seqs.at(-1)
      const clusterLeaves = resolveLeafSurfaceSeqs(getAllEvents(session), cluster.seqs)
      const cMin = clusterLeaves.length > 0 ? clusterLeaves[0] : start
      const cMax = clusterLeaves.length > 0 ? clusterLeaves.at(-1) : end
      const turns = formatTurnsLabel([...new Set(clusterLeaves.map((seq) => logInfo.eventTurnMap.get(seq)).filter(Boolean))]) || `${cMin}-${cMax}`
      session.append('compaction/prune', {
        shadowedRange: { start, end },
        shadowedSeqs: [...cluster.seqs],
        shadowedTokenCount: clusterTokenCount(cluster.seqs),
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `[Compact elided turns:${turns} → summarized above, ${currentPlan.recallTag}]` }],
        source: makeElideSource(session, compactionId),
      }), {
        surfaceOp: makeReplaceSurfaceOp(session, start, end),
        sourceEventSeqs: [...cluster.seqs],
      })
    }
    const endEvent = session.append('compaction/end', lifecycle)
    publishPrefixClass(session, summaryEvent.seq, currentPlan.prefixClass)
    return {
      ...currentPlan,
      compactionId,
      startEventSeq: startEvent.seq,
      summaryEventSeq: summaryEvent.seq,
      replaceEventSeq: replaceEvent.seq,
      endEventSeq: endEvent.seq,
    }
  } catch (err) {
    try {
      session.append('compaction/end', {
        ...lifecycle,
        error: err instanceof Error ? err.message : String(err),
      })
    } catch {}
    throw err
  }
}

/**
 * Plan and validate a single tool/result compaction on the current surface.
 */
export function planResultCompaction(session, tokenMeter, itemSpec, activeCallId, minSavingsTokens = DEFAULT_MIN_SAVINGS_TOKENS) {
  const rawCallId = String(itemSpec?.callId ?? '').trim().replace(/^@call:/, '')
  let summary = String(itemSpec?.summary ?? '').trim()
  if (!rawCallId) throw new Error('result compaction requires a non-empty callId')
  if (!summary) throw new Error(`result compaction for "${rawCallId}" requires a non-empty summary`)

  if (activeCallId && rawCallId === activeCallId) {
    throw new Error(`cannot compact currently executing tool call "${rawCallId}"`)
  }

  const logInfo = inspectSessionLog(session)
  if (logInfo.inFlightCalls.has(rawCallId)) {
    throw new Error(`cannot compact tool call "${rawCallId}" because it is still executing (in-flight)`)
  }

  const surfaceNodes = session.surface.nodes
  let targetSeq = -1
  let targetEvent = null
  for (const seq of surfaceNodes) {
    const ev = getAllEvents(session)[seq]
    if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === rawCallId) {
      targetSeq = seq
      targetEvent = ev
      break
    }
  }

  if (targetSeq === -1 || !targetEvent) {
    throw new Error(`tool/result for callId "${rawCallId}" not found on current session surface (may already be covered by a span compaction or does not exist)`)
  }

  const auto = parseAutoSummary(summary)
  if (auto.auto) summary = limitAutoSummary(`${buildAutoResultDigest(session, logInfo, targetSeq)}${auto.tail ? ` | ${auto.tail}` : ''}`)
  const recallTag = `[recall: @call:${rawCallId}]`
  const formattedText = summary.startsWith('[Compact-Auto]') ? summary : `[Compact] ${summary} ${recallTag}`
  const newContent = [{ type: 'text', text: formattedText }]
  const newMessage = rewriteToolResultMessage(targetEvent.data.message, newContent)

  const shadowedTokenCount = tokenMeter.estimateMessage(targetEvent.data.message)
  const newTokenCount = tokenMeter.estimateMessage(newMessage)
  const savings = shadowedTokenCount - newTokenCount

  const archiveMultimedia = isMultimediaToolResult(session, targetEvent, logInfo) && isMultimediaArchiveTurn(logInfo.eventTurnMap.get(targetSeq), logInfo)
  if (newTokenCount >= shadowedTokenCount && !archiveMultimedia) {
    throw new Error(`result replacement for "${rawCallId}" (${newTokenCount} tokens) is not smaller than original (${shadowedTokenCount} tokens)`)
  }
  if (savings < minSavingsTokens && !archiveMultimedia) {
    throw new Error(`result token savings for "${rawCallId}" (${savings} tokens) is below minimum threshold (${minSavingsTokens} tokens)`)
  }

  return {
    kind: 'result',
    callId: rawCallId,
    summary,
    seq: targetSeq,
    targetEvent,
    newMessage,
    shadowedTokenCount,
    newTokenCount,
    savings,
    recallTag,
  }
}

export function buildAutoResultDigest(session, logInfo, seq, measuredTokens, maxTokens = 150) {
  const ev = getAllEvents(session)[seq]
  if (ev?.type !== 'tool/result') throw new Error(`auto result digest requires tool/result seq, got ${seq}`)
  const callId = ev.data?.message?.source?.callId ?? ''
  const toolName = logInfo.callMap.get(callId)?.name ?? 'tool'
  const blocks = toolResultBlocks(ev.data?.message)
  const text = blocks.map((b) => b.type === 'text' ? b.text : `[${b.type}]`).join('\n')
  const lines = text.split(/\r?\n/)
  const tokens = measuredTokens ?? Math.max(1, Math.ceil(JSON.stringify(ev.data?.message ?? ev.data ?? '').length / 4) + 4)
  const make = (headN, tailN, width) => {
    const clip = (line) => line.length > width ? `${line.slice(0, width)}…` : line
    const head = lines.slice(0, headN).map(clip).join(' / ')
    const last = lines.at(-1) || ''
    const tail = lines.slice(Math.max(headN, lines.length - tailN)).map((line, index, arr) => clip(index === arr.length - 1 ? line.slice(0, Math.min(width, 60)) : line)).join(' / ')
    return `[Compact-Auto] ${toolName} (${tokens} est. tok, ${lines.length} lines) ${head} … ${tail} … ${last.slice(0, 40)} [recall: @call:${callId}]`
  }
  let digest = make(10, 6, 200)
  if (autoTokens(digest) > maxTokens) digest = make(4, 3, 100)
  if (autoTokens(digest) > maxTokens) {
    const marker = ` ${lines.at(-1)?.slice(0, 24) || ''} [recall: @call:${callId}]`
    digest = `${Array.from(digest).slice(0, Math.max(1, maxTokens * 2 - Array.from(marker).length)).join('')}${marker}`
  }
  return digest
}


/**
 * Commit one validated tool/result compaction synchronously (compaction/prune + tool/result replace).
 */
export function commitResultCompaction(session, tokenMeter, plan, activeCallId) {
  const freshPlan = planResultCompaction(session, tokenMeter, {
    callId: plan.callId,
    summary: plan.summary,
  }, activeCallId, 1)

  const { seq, targetEvent, newMessage, shadowedTokenCount } = freshPlan
  const pruneEvent = session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount,
  })
  const repEvent = session.append('tool/result', {
    ...targetEvent.data,
    message: newMessage,
  }, {
    surfaceOp: makeReplaceSurfaceOp(session, seq, seq),
    sourceEventSeqs: [seq],
  })

  return {
    ...freshPlan,
    pruneEventSeq: pruneEvent.seq,
    replaceEventSeq: repEvent.seq,
  }
}

/**
 * Recall original content from `getAllEvents(session)` by recursively expanding `sourceEventSeqs`
 * to `surfaceOp === 'append'` leaves.
 */
export function executeHistorySearch(session, args = {}) {
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query) throw new Error('global history search requires a non-empty query')
  let matcher
  try { matcher = new RegExp(query, 'i') } catch {
    matcher = { test: (line) => line.toLowerCase().includes(query.toLowerCase()) }
  }
  const events = getAllEvents(session)
  const logInfo = inspectSessionLog(session)
  const checkpoints = events.filter(isSummaryCheckpointEvent)
  const ownerByLeaf = new Map()
  for (const checkpoint of checkpoints) {
    const leaves = resolveLeafSurfaceSeqs(events, [checkpoint.seq])
    for (const seq of leaves) {
      const previous = ownerByLeaf.get(seq)
      if (!previous || leaves.length < previous.count) ownerByLeaf.set(seq, { checkpoint, count: leaves.length })
    }
  }
  const contextLines = typeof args.context_lines === 'number' && args.context_lines >= 0 ? Math.floor(args.context_lines) : 3
  const leafSeqs = [...ownerByLeaf.keys()].sort((a, b) => a - b)
  const blocks = []
  for (const seq of leafSeqs) {
    const owner = ownerByLeaf.get(seq)
    const ownerLeaves = resolveLeafSurfaceSeqs(events, [owner.checkpoint.seq])
    const lines = extractEventText(events[seq], logInfo.callMap).split(/\r?\n/)
    const selected = new Set()
    for (let i = 0; i < lines.length; i++) {
      matcher.lastIndex = 0
      if (!matcher.test(lines[i])) continue
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) selected.add(j)
    }
    if (!selected.size) continue
    const ev = events[seq]
    const callId = ev.type === 'tool/result' ? ev.data?.message?.source?.callId : ''
    const tags = [`@span:S${ownerLeaves[0]}-${ownerLeaves.at(-1)}`, ...(callId ? [`@call:${callId}`] : [])]
    blocks.push(`[turn:${logInfo.eventTurnMap.get(seq) ?? 0} seq:${seq} ${tags.join(' ')}]\n${[...selected].map((i) => `${i + 1}: ${lines[i]}`).join('\n')}`)
  }
  const allLines = blocks.join('\n\n---\n\n').split(/\r?\n/)
  const start = Array.isArray(args.line_range) ? Math.max(1, Math.floor(Number(args.line_range[0]) || 1)) : 1
  const requestedEnd = Array.isArray(args.line_range) && args.line_range[1] !== undefined ? Math.max(start, Math.floor(Number(args.line_range[1]))) : start + DEFAULT_RECALL_MAX_LINES - 1
  const end = Math.min(allLines.length, requestedEnd, start + DEFAULT_RECALL_MAX_LINES - 1)
  const page = start <= allLines.length ? allLines.slice(start - 1, end) : []
  const hasMore = end < allLines.length
  return {
    target: '@index', leafSeqs, totalLines: allLines.length, returnedLines: page.length, hasMore,
    ...(hasMore ? { nextLineRange: [end + 1, Math.min(allLines.length, end + DEFAULT_RECALL_MAX_LINES)] } : {}),
    text: `[History search @index | checkpoints=${checkpoints.length} unique_leaves=${leafSeqs.length} query=${JSON.stringify(query)} | lines ${start}-${end} of ${allLines.length}]\n${page.join('\n')}${hasMore ? `\n[Continue with target:"@index", query, line_range:[${end + 1},${Math.min(allLines.length, end + DEFAULT_RECALL_MAX_LINES)}]]` : ''}`,
  }
}

export function executeRecall(session, args = {}) {
  const target = String(args.target ?? '').trim()
  if (!target) throw new Error('target is required (e.g. "@call:<callId>", "@span:S<min>-<max>", "@turn:<N>", "@index", or event seq)')
  if (/^@(?:index|all|search)$/i.test(target)) return executeHistorySearch(session, args)

  const events = getAllEvents(session)
  const logInfo = inspectSessionLog(session)
  const rootSeqs = []
  const nestedPointers = []

  const callMatch = /^(?:@?call:)(.+)$/i.exec(target)
  const spanMatch = /^(?:@?span:)?S(\d+)\s*-\s*(\d+)(?:\+S\d+-\d+)*(?:\s+turns:[\d,..-]+)?$/i.exec(target)
  const turnMatch = /^(?:@?turn:)(\d+)$/i.exec(target)
  const seqMatch = /^S?(\d+)$/i.exec(target)

  if (callMatch) {
    const cid = callMatch[1].trim()
    for (const ev of events) {
      if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === cid) {
        rootSeqs.push(ev.seq)
      }
    }
    if (rootSeqs.length === 0) throw new Error(`no tool/result found in session log for callId "${cid}"`)
  } else if (spanMatch) {
    const minSeq = Number(spanMatch[1])
    const maxSeq = Number(spanMatch[2])
    if (minSeq > maxSeq) throw new Error(`invalid span range ${target}: start ${minSeq} > end ${maxSeq}`)
    const wantedTag = target.replace(/^@?span:/i, '@span:').replace(/\s+turns:[\d,..-]+$/i, '')
    const fullWantedTag = target.replace(/^@?span:/i, '@span:')
    let taggedCheckpoint = null
    let leafCheckpoint = null
    for (const ev of events) {
      if (!isSummaryCheckpointEvent(ev)) continue
      const blocks = ev.data?.content ?? []
      const text = blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      const escapedFull = fullWantedTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const escapedPrefix = wantedTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const unionPattern = /@span:S\d+-\d+(?:\+S\d+-\d+)*/g
      const unionMatches = text.match(unionPattern) ?? []
      if (new RegExp(`${escapedFull}(?![\\d+])`, 'i').test(text) || unionMatches.some((tag) => tag.toLowerCase() === wantedTag.toLowerCase())) taggedCheckpoint = ev
      const leaves = resolveLeafSurfaceSeqs(events, [ev.seq])
      if (leaves.length > 0 && leaves[0] === minSeq && leaves.at(-1) === maxSeq) {
        leafCheckpoint = ev
      }
    }
    const matchedCheckpoint = leafCheckpoint || taggedCheckpoint
    if (matchedCheckpoint) {
      const provenance = Array.isArray(matchedCheckpoint.sourceEventSeqs) && matchedCheckpoint.sourceEventSeqs.length > 0
        ? matchedCheckpoint.sourceEventSeqs.filter((seq) => {
            const src = events[seq]
            return Boolean(src && src.surfaceOp !== undefined)
          })
        : [matchedCheckpoint.seq]
      for (const seq of provenance) {
        const src = events[seq]
        if (isSummaryCheckpointEvent(src) || isElidedPlaceholderEvent(src)) {
          const nested = /@span:S\d+-\d+(?:\+S\d+-\d+)*(?:\s+turns:[\d,..-]+)?/.exec(src.data?.content?.map((b) => b.text ?? '').join('\n'))?.[0]
          if (nested) nestedPointers.push(nested)
        } else rootSeqs.push(seq)
      }
      if (!rootSeqs.length && nestedPointers.length) rootSeqs.push(matchedCheckpoint.seq)
    } else {
      const candidates = events.filter(isSummaryCheckpointEvent).map((ev) => /@span:([^\]]+)/.exec(ev.data?.content?.map((b) => b.text ?? '').join('\n'))?.[1]).filter(Boolean)
      throw new Error(`no exact summary checkpoint for ${target}; nearest tags: ${candidates.slice(-3).map((tag) => `@span:${tag}`).join(', ') || 'none'}`)
    }
  } else if (turnMatch) {
    const turnNum = Number(turnMatch[1])
    for (const ev of events) {
      if (!ev || ev.surfaceOp !== 'append') continue
      const t = logInfo.eventTurnMap.get(ev.seq)
      if (t === turnNum) rootSeqs.push(ev.seq)
    }
    if (rootSeqs.length === 0) throw new Error(`no original surface events found for turn ${turnNum}`)
  } else if (seqMatch) {
    const seq = Number(seqMatch[1])
    if (!events[seq]) throw new Error(`event seq ${seq} out of bounds (0..${events.length - 1})`)
    rootSeqs.push(seq)
  } else {
    for (const ev of events) {
      if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === target) {
        rootSeqs.push(ev.seq)
      }
    }
    if (rootSeqs.length === 0) {
      throw new Error(`unrecognized target "${target}" (use @call:<callId>, @span:S<start>-<end>, @turn:<N>, or event seq)`)
    }
  }

  let leafSeqs = resolveLeafSurfaceSeqs(events, rootSeqs)
  // Provenance is authoritative, especially for multi-cluster unions: filtering
  // by min/max would re-include the exact unselected island turns this tag avoids.

  const fullText = [...leafSeqs.map((seq) => extractEventText(events[seq], logInfo.callMap)),
    ...nestedPointers.map((tag) => `[嵌套摘要：context_recall({ target: "${tag}" })]`)].join('\n\n---\n\n')
  const allLines = fullText.split(/\r?\n/)
  const totalLines = allLines.length

  const query = typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined
  const contextLines = typeof args.context_lines === 'number' && args.context_lines >= 0 ? Math.floor(args.context_lines) : 3

  let selectedLines = []
  if (query !== undefined) {
    let matcher
    try {
      matcher = new RegExp(query, 'i')
    } catch {
      matcher = { test: (line) => line.toLowerCase().includes(query.toLowerCase()) }
    }
    const matchedIndices = new Set()
    for (let i = 0; i < allLines.length; i++) {
      if (matcher.test(allLines[i])) {
        const start = Math.max(0, i - contextLines)
        const end = Math.min(allLines.length - 1, i + contextLines)
        for (let k = start; k <= end; k++) matchedIndices.add(k)
      }
    }
    const sorted = [...matchedIndices].sort((a, b) => a - b)
    if (sorted.length === 0) {
      return {
        target,
        leafSeqs,
        totalLines,
        returnedLines: 0,
        hasMore: false,
        text: `[Recall ${target}: leaves S${leafSeqs[0]}..S${leafSeqs[leafSeqs.length - 1]} (${totalLines} lines total) — 0 matches for query "${query}"]`,
      }
    }
    selectedLines = sorted.map((idx) => ({ lineNumber: idx + 1, text: allLines[idx] }))
  } else {
    selectedLines = allLines.map((text, idx) => ({ lineNumber: idx + 1, text }))
  }

  let startOffset = 0
  let endOffset = selectedLines.length
  if (Array.isArray(args.line_range) && args.line_range.length >= 1) {
    const reqStart = Math.max(1, Math.floor(Number(args.line_range[0]) || 1))
    const reqEnd = args.line_range.length >= 2 && args.line_range[1] !== undefined
      ? Math.max(reqStart, Math.floor(Number(args.line_range[1])))
      : reqStart + DEFAULT_RECALL_MAX_LINES - 1

    if (query !== undefined) {
      startOffset = selectedLines.findIndex((item) => item.lineNumber >= reqStart)
      if (startOffset === -1) startOffset = selectedLines.length
      const afterEnd = selectedLines.findIndex((item) => item.lineNumber > reqEnd)
      endOffset = afterEnd === -1 ? selectedLines.length : afterEnd
    } else {
      startOffset = Math.min(selectedLines.length, reqStart - 1)
      endOffset = Math.min(selectedLines.length, reqEnd)
    }
  }

  const maxLines = DEFAULT_RECALL_MAX_LINES
  const sliceEnd = Math.min(endOffset, startOffset + maxLines)
  const page = selectedLines.slice(startOffset, sliceEnd)
  const hasMore = sliceEnd < selectedLines.length
  const nextStartLine = hasMore ? selectedLines[sliceEnd].lineNumber : null
  const nextEndLine = hasMore ? Math.min(totalLines, nextStartLine + maxLines - 1) : null

  const body = page.map((item) => `${item.lineNumber}: ${item.text}`).join('\n')
  const cursorHint = hasMore
    ? `\n\n[More lines available (${totalLines} total). Continue with: context_recall { target: "${target}"${query ? `, query: ${JSON.stringify(query)}` : ''}, line_range: [${nextStartLine}, ${nextEndLine}] }]`
    : ''

  return {
    target,
    leafSeqs,
    totalLines,
    returnedLines: page.length,
    hasMore,
    ...(hasMore ? { nextLineRange: [nextStartLine, nextEndLine] } : {}),
    text: `[Recall ${target} | leaves: ${leafSeqs.map((s) => `S${s}`).join(',')} | lines: ${page[0]?.lineNumber ?? 0}-${page[page.length - 1]?.lineNumber ?? 0} of ${totalLines}]\n${body}${cursorHint}`,
  }
}

/**
 * Compute whether session context occupancy exceeds the immediate commit ratio (70%).
 */
export function isHighContextOccupancy(session, tokenMeter, ratioThreshold = DEFAULT_IMMEDIATE_RATIO) {
  const ctxWin = session.requestContext()?.contextWindow
  if (!ctxWin || ctxWin <= 0) return false
  const measurement = tokenMeter.measure(session)
  return measurement.totalTokens / ctxWin > ratioThreshold
}

/**
 * Inspect the current open step's `assistant/message` in `getAllEvents(session)` to determine
 * whether `conclude_turn: true` is safe to execute (`exec.concludeTurn()`).
 *
 * Only counts `type === 'text'` blocks (ignores `reasoning`/`thinking`/`tool-call`).
 * Falls back to `canConclude: false` when the assistant message cannot be located
 * or when the same step contains other tool calls.
 */
export function checkConcludeTurnEligibility(session, exec, selfCallId, allowedSiblingTools = []) {
  const events = getAllEvents(session)
  if (events.length === 0) {
    return { canConclude: false, reason: 'no-assistant-message', assistantText: '' }
  }

  const activeCallId = typeof selfCallId === 'string' && selfCallId.length > 0
    ? selfCallId
    : (typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : undefined)
  const allowed = new Set(Array.isArray(allowedSiblingTools) ? allowedSiblingTools : [])
  const siblingCallIds = new Set()
  const successfulSiblingResults = new Set()
  for (const block of events.flatMap((ev) => ev?.type === 'assistant/message' ? (ev.data?.message?.content ?? []) : [])) {
    if (block?.type === 'tool-call' && allowed.has(block.name)) siblingCallIds.add(block.id)
  }
  const rootCallId = typeof exec?.rootCallId === 'string' && exec.rootCallId.length > 0 ? exec.rootCallId : activeCallId
  const runningPhase = exec?.agent?.phase?.kind === 'running' ? exec.agent.phase : undefined

  let asstEvent = null
  const stepToolCallIds = new Set()

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev) continue
    if (ev.type === 'step/end' || ev.type === 'turn/end') {
      break
    }
    if (ev.type === 'tool/call') {
      const cid = ev.data?.callId
      if (typeof cid === 'string' && cid.length > 0) {
        stepToolCallIds.add(cid)
        if (allowed.has(ev.data?.name)) siblingCallIds.add(cid)
      }
    } else if (ev.type === 'tool/result') {
      const message = ev.data?.message
      const cid = message?.source?.callId
      const failed = ev.data?.isError === true || message?.isError === true
        || toolResultBlocks(message).some((block) => block?.isError === true || block?.type === 'error')
      if ((allowed.has(message?.toolName) || siblingCallIds.has(cid)) && !failed) successfulSiblingResults.add(cid)
    } else if (ev.type === 'assistant/message' && !asstEvent) {
      asstEvent = ev
    }
    if (ev.type === 'step/start' || ev.type === 'turn/start') {
      break
    }
  }

  if (!asstEvent) {
    return { canConclude: false, reason: 'no-assistant-message', assistantText: '' }
  }

  if (runningPhase) {
    if (typeof runningPhase.turn === 'number' && typeof asstEvent.data?.turn === 'number' && asstEvent.data.turn !== runningPhase.turn) {
      return { canConclude: false, reason: 'no-assistant-message', assistantText: '' }
    }
    if (typeof runningPhase.step === 'number' && typeof asstEvent.data?.step === 'number' && asstEvent.data.step !== runningPhase.step) {
      return { canConclude: false, reason: 'no-assistant-message', assistantText: '' }
    }
  }

  const content = asstEvent.data?.message?.content
  if (!Array.isArray(content)) {
    return { canConclude: false, reason: 'no-assistant-message', assistantText: '' }
  }

  const toolCallBlocks = content.filter((b) => b && b.type === 'tool-call')
  const isSelf = (id) => id === activeCallId || id === rootCallId
  for (const block of toolCallBlocks) {
    if (isSelf(block.id)) continue
    if (!allowed.has(block.name) || !successfulSiblingResults.has(block.id)) {
      return { canConclude: false, reason: allowed.has(block.name) ? 'sibling-tool-not-successful' : 'other-tool-calls', assistantText: '' }
    }
  }
  for (const cid of stepToolCallIds) {
    if (isSelf(cid)) continue
    if (!siblingCallIds.has(cid) || !successfulSiblingResults.has(cid)) {
      return { canConclude: false, reason: siblingCallIds.has(cid) ? 'sibling-tool-not-successful' : 'other-tool-calls', assistantText: '' }
    }
  }

  const textParts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    }
  }
  const assistantText = textParts.join('').trim()
  if (assistantText.length === 0) {
    return { canConclude: false, reason: 'empty-assistant-text', assistantText: '' }
  }

  return { canConclude: true, reason: 'ok', assistantText }
}

function formatConcludeBlockReason(reason) {
  if (reason === 'other-tool-calls') return '同一步存在其他工具调用'
  if (reason === 'empty-assistant-text') return '当前助手消息不含非空回复文字'
  return '未能确认当前步助手消息包含非空回复文字'
}

/**
 * Determine whether two span specs/plans refer to the exact same target range.
 */
export function isSameSpanTarget(a, b) {
  if (!a || !b) return false
  const aTurns = canonicalTurnList(a)
  const bTurns = canonicalTurnList(b)
  if (aTurns && bTurns) {
    return aTurns.length === bTurns.length && aTurns.every((t, i) => t === bTurns[i])
  }
  if (!aTurns && !bTurns) {
    const aFrom = String(a.from ?? '').trim()
    const aTo = String(a.to ?? '').trim()
    const bFrom = String(b.from ?? '').trim()
    const bTo = String(b.to ?? '').trim()
    if (aFrom && aTo && aFrom === bFrom && aTo === bTo) return true
    if (a.resolvedFrom && a.resolvedTo && b.resolvedFrom && b.resolvedTo && a.resolvedFrom === b.resolvedFrom && a.resolvedTo === b.resolvedTo) {
      return true
    }
  } else {
    return false
  }
  if (typeof a.startSeq === 'number' && typeof a.endSeq === 'number' && typeof b.startSeq === 'number' && typeof b.endSeq === 'number') {
    if (a.startSeq === b.startSeq && a.endSeq === b.endSeq) return true
  }
  if (typeof a.minLeaf === 'number' && typeof a.maxLeaf === 'number' && typeof b.minLeaf === 'number' && typeof b.maxLeaf === 'number') {
    if (a.minLeaf === b.minLeaf && a.maxLeaf === b.maxLeaf) return true
  }
  return false
}

/**
 * Check if `candidate` span overlaps with or is contained in any span in `referenceList`.
 */
export function classifySpanOverlap(candidate, referenceList) {
  if (!candidate || !Array.isArray(referenceList) || referenceList.length === 0) return null
  const candLeaves = Array.isArray(candidate.leafSeqs) && candidate.leafSeqs.length > 0 ? candidate.leafSeqs : null
  const candShadowed = Array.isArray(candidate.shadowedSeqs) && candidate.shadowedSeqs.length > 0 ? candidate.shadowedSeqs : null

  for (const ref of referenceList) {
    if (!ref) continue
    const refLeaves = new Set(Array.isArray(ref.leafSeqs) ? ref.leafSeqs : [])
    const refShadowed = new Set(Array.isArray(ref.shadowedSeqs) ? ref.shadowedSeqs : [])

    if (candLeaves && refLeaves.size > 0) {
      let overlapCount = 0
      for (const s of candLeaves) {
        if (refLeaves.has(s)) overlapCount++
      }
      if (overlapCount === candLeaves.length) {
        return { kind: 'contained', by: ref, reason: `contained in [${ref.from}..${ref.to}]` }
      }
      if (overlapCount > 0) {
        return { kind: 'overlap', by: ref, reason: `overlaps with [${ref.from}..${ref.to}]` }
      }
    }

    if (candShadowed && refShadowed.size > 0) {
      let overlapCount = 0
      for (const s of candShadowed) {
        if (refShadowed.has(s)) overlapCount++
      }
      if (overlapCount === candShadowed.length) {
        return { kind: 'contained', by: ref, reason: `contained in [${ref.from}..${ref.to}]` }
      }
      if (overlapCount > 0) {
        return { kind: 'overlap', by: ref, reason: `overlaps with [${ref.from}..${ref.to}]` }
      }
    }
  }
  return null
}

/**
 * Check whether a staged single-result compaction target has already been compacted
 * (either covered by a span or already replaced by an earlier single-result compaction).
 */
export function isResultAlreadyCompacted(session, callId, shadowedBySpans) {
  const rawCallId = String(callId ?? '').trim().replace(/^@call:/, '')
  const surfaceNodes = session.surface.nodes
  let foundSeq = -1
  for (const seq of surfaceNodes) {
    const ev = getAllEvents(session)[seq]
    if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === rawCallId) {
      foundSeq = seq
      break
    }
  }

  if (foundSeq === -1) {
    // Check if this callId ever had a tool/result in getAllEvents(session) (if so, a span already shadowed it)
    const events = getAllEvents(session)
    const original = events.find((ev) => ev?.type === 'tool/result' && ev.data?.message?.source?.callId === rawCallId && ev.surfaceOp === 'append')
    const covered = original && surfaceNodes.some((seq) => {
      const ev = events[seq]
      return ev && ev.surfaceOp !== 'append' && (isSummaryCheckpointEvent(ev) || isElidedPlaceholderEvent(ev)) && resolveLeafSurfaceSeqs(events, isElidedPlaceholderEvent(ev) ? ev.sourceEventSeqs : [seq]).includes(original.seq)
    })
    if (covered) return { compacted: true, reason: 'shadowed-by-span' }
    return { compacted: false, seq: -1 }
  }

  if (shadowedBySpans && shadowedBySpans.has(foundSeq)) {
    return { compacted: true, reason: 'shadowed-by-span' }
  }

  const surfaceEvent = getAllEvents(session)[foundSeq]
  if (surfaceEvent && surfaceEvent.surfaceOp !== 'append') {
    return { compacted: true, reason: 'already-replaced' }
  }

  return { compacted: false, seq: foundSeq }
}

/**
 * Check whether a staged span compaction target has already been compacted on the session surface.
 */
export function isSpanAlreadyCompacted(session, sp) {
  const surfaceNodes = [...session.surface.nodes]
  if (surfaceNodes.length === 0) return false
  const surfaceSet = new Set(surfaceNodes)
  const events = getAllEvents(session)

  const compactedSurfaceSeqs = surfaceNodes.filter((seq) => {
    const ev = events[seq]
    return Boolean(ev && ev.surfaceOp !== 'append' && !isElidedPlaceholderEvent(ev))
  })
  const rawFrom = /^turn:\s*(\d+)$/i.exec(String(sp.resolvedFrom ?? sp.from ?? '').trim())
  const rawTo = /^turn:\s*(\d+)$/i.exec(String(sp.resolvedTo ?? sp.to ?? '').trim())
  if (rawFrom && rawTo && rawFrom[1] === rawTo[1]) {
    const turn = Number(rawFrom[1])
    const logInfo = inspectSessionLog(session)
    for (const seq of compactedSurfaceSeqs) {
      if (resolveSurfaceNodeTurns(session, seq, logInfo).turns.has(turn)) return true
    }
  }

  if (Array.isArray(sp.leafSeqs) && sp.leafSeqs.length > 0 && compactedSurfaceSeqs.length > 0) {
    // 1. Covered by a single compacted node on the current surface:
    for (const cSeq of compactedSurfaceSeqs) {
      const nodeLeaves = new Set(resolveLeafSurfaceSeqs(events, [cSeq]))
      if (sp.leafSeqs.every((l) => nodeLeaves.has(l))) {
        return true
      }
    }
    // 2. All target leaves are inside compacted nodes AND original surface seqs changed since staging:
    const allCompactedLeaves = new Set(resolveLeafSurfaceSeqs(events, compactedSurfaceSeqs))
    if (sp.leafSeqs.every((l) => allCompactedLeaves.has(l))) {
      if (!Array.isArray(sp.shadowedSeqs) || sp.shadowedSeqs.some((s) => !surfaceSet.has(s))) {
        return true
      }
    }
  }

  // 3. Try resolving endpoints on current surface: if they collapse to a single already-replaced checkpoint node:
  try {
    const logInfo = inspectSessionLog(session)
    const nodeTurnsList = surfaceNodes.map((seq) => resolveSurfaceNodeTurns(session, seq, logInfo))
    const effectiveFrom = sp.resolvedFrom ?? sp.from
    const effectiveTo = sp.resolvedTo ?? sp.to
    const startIdx = resolveEndpointSurfaceIndices(session, effectiveFrom, false, logInfo, surfaceNodes, nodeTurnsList)
    const endIdx = resolveEndpointSurfaceIndices(session, effectiveTo, true, logInfo, surfaceNodes, nodeTurnsList)
    if (startIdx === endIdx) {
      const onlyEv = events[surfaceNodes[startIdx]]
      if (onlyEv && onlyEv.surfaceOp !== 'append') {
        return true
      }
    }
  } catch {
    // Endpoint resolution may fail if callId endpoint was absorbed into a span checkpoint; handled by caller
  }

  return false
}

export const GLOBAL_STATE_KEY = '@dsh-external/dsh-context-compact.state'
export const RUNTIME_STATE_SCHEMA = 2
export function getGlobalRuntimeState() {
  // HMR replaces module instances, not Session objects. Preserve pure-data
  // queues/latches under a process-global symbol; measurement caches stay local.
  const key = Symbol.for(GLOBAL_STATE_KEY)
  const previous = globalThis[key]
  if (previous?.schema === RUNTIME_STATE_SCHEMA && previous.bySession instanceof WeakMap) return previous
  if (previous?.bySession instanceof WeakMap) {
    previous.schema = RUNTIME_STATE_SCHEMA
    previous.generation ??= 0
    return previous
  }
  const bySession = new WeakMap()
  const state = { schema: RUNTIME_STATE_SCHEMA, bySession, generation: 0 }
  globalThis[key] = state
  // Lazy v1 migration: preserve every queued item without traversing WeakMap.
  const legacyAccessors = new WeakMap()
  const legacyMaps = previous?.version === 1 ? [previous.stagedBySession, previous.watermarkLatch, previous.modelCompletion, previous.abnormalFlushPending] : []
  state.legacyAccessors = legacyAccessors
  state.legacyMaps = legacyMaps
  return state
}
export function recoverStagedFromLog(session) {
  const events = getAllEvents(session)
  if (!events.length) return null
  const logInfo = inspectSessionLog(session)
  const staged = { spans: [], results: new Map(), dropped: [] }
  for (const ev of events) {
    if (ev?.type !== 'tool/call' || ev.data?.name !== 'context_compact') continue
    if (logInfo.openTurn !== null && (ev.data?.turn ?? 0) < logInfo.openTurn) continue
    let args
    try { args = JSON.parse(ev.data.arguments) } catch { continue }
    for (const span of args?.spans ?? []) {
      try {
        const normalized = { ...span,
          resolvedFrom: normalizeEndpointSelector(span.resolvedFrom ?? span.from ?? 'auto', logInfo),
          resolvedTo: normalizeEndpointSelector(span.resolvedTo ?? span.to, logInfo) }
        if (!isSpanAlreadyCompacted(session, normalized)) staged.spans.push({ ...normalized, retries: 0 })
      } catch { /* unplannable historical calls are not resurrected */ }
    }
    for (const result of args?.results ?? []) {
      if (result?.callId && !isResultAlreadyCompacted(session, result.callId).compacted) staged.results.set(result.callId, { callId: result.callId, summary: result.summary, retries: 0 })
    }
  }
  return staged.spans.length || staged.results.size ? staged : null
}
function sessionState(session, create = true) {
  const reg = getGlobalRuntimeState()
  let state = reg.bySession.get(session)
  if (!state && create) {
    const recovered = recoverStagedFromLog(session)
    const staged = recovered ?? reg.legacyMaps?.[0]?.get(session) ?? { spans: [], results: new Map(), dropped: [] }
    state = { v: RUNTIME_STATE_SCHEMA, spans: staged.spans, results: staged.results, dropped: staged.dropped,
      lastCompletionMs: reg.legacyMaps?.[2]?.get(session) ?? null, watermarkLatch: reg.legacyMaps?.[1]?.get(session) ?? null,
      closedTurn: null, abnormal: false, flushScheduled: false, flushRunning: false }
    reg.bySession.set(session, state)
    reg.legacyMaps?.[1]?.delete(session); reg.legacyMaps?.[2]?.delete(session)
  }
  return state
}
const runtimeState = getGlobalRuntimeState()
const sessionMeasurementCacheRegistry = new WeakMap()
const stagedBySessionRegistry = { get: (s) => { const st = sessionState(s); return { spans: st.spans, results: st.results, dropped: st.dropped } },
  set: (s, q) => { const st = sessionState(s); st.spans = q.spans; st.results = q.results; st.dropped = q.dropped; return st },
  delete: (s) => runtimeState.bySession.delete(s) }
const watermarkLatchBySessionRegistry = { get: (s) => sessionState(s, false)?.watermarkLatch,
  set: (s, value) => { sessionState(s).watermarkLatch = value },
  delete: (s) => { const st = sessionState(s, false); if (st) st.watermarkLatch = null } }

/** 获取当前会话最近一次 compaction/* 事件的 seq（无压缩事件时为 -1），用于标识当前压缩周期。 */
function getLatestCompactionSeq(session) {
  const events = getAllEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && typeof ev.type === 'string' && ev.type.startsWith('compaction/')) {
      return ev.seq
    }
  }
  return -1
}

/** 同一表面版本只测量一次；systemPrompt.context 的目录与水位提醒共享测量结果。 */
function measureSessionCached(session, tokenMeter) {
  const nodes = session?.surface?.nodes ?? []
  const key = `${logLength(session)}:${nodes.length}:${nodes[nodes.length - 1] ?? ''}`
  const cached = sessionMeasurementCacheRegistry.get(session)
  if (cached && cached.key === key) return cached.measurement
  const measurement = tokenMeter.measure(session)
  sessionMeasurementCacheRegistry.set(session, { key, measurement })
  return measurement
}

/**
 * Inspect a session's staged compaction queue (read-only snapshot for diagnostics and tests).
 */
export function getStagedQueueSnapshot(session) {
  const q = stagedBySessionRegistry.get(session)
  if (!q) {
    return { spans: [], results: [], dropped: [] }
  }
  return {
    spans: q.spans.map((s) => ({ ...s })),
    results: [...q.results.values()].map((r) => ({ ...r })),
    dropped: q.dropped.map((d) => ({ ...d })),
  }
}

/**
 * Compute incremental compactable pool watermark metrics (`compactableTokens`, `compactableTurns`,
 * `uncompactedClosedTurns`, `suggestedSpan`, `topCandidates`, and formatted `hint`).
 *
 * Crucial design invariant:
 * - Excludes already-compacted nodes (`@span` / `@call` where `surfaceOp !== 'append'`) AND excludes
 *   active dialogue (`user/message`, `assistant/message`) in the most recent `keepRecentTurns` (default 5) turns.
 * - Counts every uncompacted `surfaceOp === 'append'` node on a closed turn, including island turns
 *   sandwiched before a later `<compacted-summary>`. Those islands stay compactable. System-prompt
 *   snapshots and the keepRecent tail stay out of the compactable pool.
 * - Counts only uncompacted nodes inside the compactable closed turn span (`turn:A..turn:B`) plus any
 *   uncompacted large single `tool/result >= 500t` outside the span.
 * - Right after compaction, `compactableTokens` drops to 0 (or below threshold), preventing false positives
 *   even when historical checkpoints + recent 5 turns occupy 70k+ tokens.
 */
export function inspectSoftWatermark(session, tokenMeter, options = {}) {
  const enabled = options?.softWatermarkEnabled !== false && options?.enabled !== false
  const softWatermarkTokens = configuredPositive(options, 'softWatermarkTokens', DEFAULT_SOFT_WATERMARK_TOKENS)
  const softWatermarkTurns = Math.floor(configuredPositive(options, 'softWatermarkTurns', DEFAULT_SOFT_WATERMARK_TURNS))
  const keepRecentTurns =
    typeof options?.keepRecentTurns === 'number' && options.keepRecentTurns >= 0
      ? Math.floor(options.keepRecentTurns)
      : DEFAULT_KEEP_RECENT_TURNS
  const largeBlockTokens =
    typeof options?.largeBlockTokens === 'number' && options.largeBlockTokens > 0
      ? options.largeBlockTokens
      : DEFAULT_LARGE_BLOCK_TOKENS
  const topCandidatesLimit =
    typeof options?.topCandidates === 'number' && options.topCandidates > 0
      ? Math.floor(options.topCandidates)
      : DEFAULT_TOP_CANDIDATES

  const logInfo = inspectSessionLog(session)
  const measurement = tokenMeter.measure(session)
  const freeRide = inspectFreeRideWindow(session, logInfo, options, options?.now)
  const effectiveSoftWatermarkTokens = freeRide.active
    ? configuredPositive(options, 'piggybackThresholdTokens', DEFAULT_PIGGYBACK_THRESHOLD_TOKENS)
    : softWatermarkTokens
  const effectiveSoftWatermarkTurns = freeRide.active
    ? Math.floor(configuredPositive(options, 'piggybackThresholdTurns', DEFAULT_PIGGYBACK_THRESHOLD_TURNS))
    : softWatermarkTurns
  const openTurnLargeResultTokens = configuredPositive(options, 'openTurnLargeResultTokens', DEFAULT_OPEN_TURN_LARGE_RESULT_TOKENS)
  const tierCliffTokens = configuredPositive(options, 'tierCliffTokens', DEFAULT_TIER_CLIFF_TOKENS, true)
  const tierCliffCompactableTokens = configuredPositive(options, 'tierCliffCompactableTokens', DEFAULT_TIER_CLIFF_COMPACTABLE_TOKENS, true)
  const surfaceNodes = session?.surface?.nodes ?? []
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, n.tokens)

  const staged = stagedBySessionRegistry.get(session)
  const stagedShadowedSeqs = new Set()
  const stagedCallIds = new Set()
  if (staged) {
    for (const sp of staged.spans) {
      if (Array.isArray(sp.shadowedSeqs)) {
        for (const s of sp.shadowedSeqs) stagedShadowedSeqs.add(s)
      }
    }
    for (const cid of staged.results.keys()) {
      stagedCallIds.add(cid)
    }
  }

  let compactedBaselineTokens = 0
  const uncompactedEntries = []
  const summaryCheckpointIdxs = []
  const summaryPrefixNodes = []
  const frontier = summaryFrontierIndex(session)

  for (let idx = 0; idx < surfaceNodes.length; idx++) {
    const seq = surfaceNodes[idx]
    const ev = getAllEvents(session)[seq]
    if (!ev) continue
    // dsh-system-prompt 持久化的动态上下文快照不是可压缩工作证据，跳过以避免反向抬升水位。
    if (isSystemPromptSnapshotEvent(ev)) continue
    const tokens = pricedBySeq.get(seq) ?? 0
    const nt = resolveSurfaceNodeTurns(session, seq, logInfo)
    const callId = ev.type === 'tool/result' ? (ev.data?.message?.source?.callId ?? '') : ''
    if (isSummaryCheckpointEvent(ev)) {
      summaryCheckpointIdxs.push(idx)
      if (idx < frontier) {
        const nt = resolveSurfaceNodeTurns(session, seq, logInfo)
        summaryPrefixNodes.push({ seq, tokens, minTurn: nt.minTurn, maxTurn: nt.maxTurn })
      }
    }
    const isAlreadyCompacted =
      ev.surfaceOp !== 'append' ||
      ev.data?.source?.plugin === 'compact' ||
      stagedShadowedSeqs.has(seq) ||
      (callId.length > 0 && stagedCallIds.has(callId))

    if (isAlreadyCompacted) {
      compactedBaselineTokens += tokens
      continue
    }

    uncompactedEntries.push({ idx, seq, ev, tokens, nt, callId })
  }

  const isClosedTurn = (t) => t >= 1 && (logInfo.openTurn === null || t < logInfo.openTurn)
  const closedTurnsOf = (nt) => {
    const found = []
    if (nt?.turns && nt.turns.size > 0) {
      for (const t of nt.turns) if (isClosedTurn(t)) found.push(t)
    } else if (isClosedTurn(nt?.minTurn)) {
      found.push(nt.minTurn)
    }
    return found
  }
  const hasLaterSummary = (idx) => {
    for (let i = 0; i < summaryCheckpointIdxs.length; i++) {
      if (summaryCheckpointIdxs[i] > idx) return true
    }
    return false
  }

  const islandTurnSet = new Set()
  const tailTurnSet = new Set()
  for (const item of uncompactedEntries) {
    const closed = closedTurnsOf(item.nt)
    if (closed.length === 0) continue
    const bucket = hasLaterSummary(item.idx) ? islandTurnSet : tailTurnSet
    for (const t of closed) bucket.add(t)
  }
  for (const t of islandTurnSet) tailTurnSet.delete(t)

  const islandTurns = [...islandTurnSet].sort((a, b) => a - b)
  const tailTurns = [...tailTurnSet].sort((a, b) => a - b)
  const islandSpans = []
  for (let i = 0; i < islandTurns.length;) {
    let j = i
    while (j + 1 < islandTurns.length && islandTurns[j + 1] === islandTurns[j] + 1) j++
    islandSpans.push({ from: `turn:${islandTurns[i]}`, to: `turn:${islandTurns[j]}` })
    i = j + 1
  }
  const splitIdx = Math.max(0, tailTurns.length - keepRecentTurns)
  const compactableTailTurns = tailTurns.slice(0, splitIdx)
  const recentClosedTurnNums = tailTurns.slice(splitIdx)
  const compactableSpanTurnNums = [...islandTurns, ...compactableTailTurns].sort((a, b) => a - b)
  const uncompactedClosedTurnNums = [...islandTurns, ...tailTurns].sort((a, b) => a - b)
  const uncompactedClosedTurns = uncompactedClosedTurnNums.length
  const compactableSpanTurnSet = new Set(compactableSpanTurnNums)
  const recentProtectedTurnSet = new Set(recentClosedTurnNums)
  if (logInfo.openTurn !== null) recentProtectedTurnSet.add(logInfo.openTurn)

  let spanCompactableTokens = 0
  let outsideSpanLargeResultTokens = 0
  let recentProtectedTokens = 0
  const candidateResults = []
  const openTurnLargeResults = []

  for (const item of uncompactedEntries) {
    const { seq, ev, tokens, nt, callId } = item
    const t = nt.minTurn
    const isClosed = t >= 1 && (logInfo.openTurn === null || t < logInfo.openTurn)
    const nodeIsIsland = hasLaterSummary(item.idx) && closedTurnsOf(nt).length > 0
    const isMultimedia = isMultimediaToolResult(session, ev, logInfo)
    const archiveMultimedia = isMultimedia && isMultimediaArchiveTurn(t, logInfo)

    if (nodeIsIsland || compactableSpanTurnSet.has(t)) {
      spanCompactableTokens += tokens
    } else if (ev.type === 'tool/result' && (tokens >= largeBlockTokens || archiveMultimedia) && callId && !logInfo.inFlightCalls.has(callId)) {
      outsideSpanLargeResultTokens += tokens
    } else if (recentProtectedTurnSet.has(t)) {
      recentProtectedTokens += tokens
    }

    if (ev.type === 'tool/result' && callId && !logInfo.inFlightCalls.has(callId) && tokens > 0) {
      const toolName = logInfo.callMap.get(callId)?.name ?? 'tool'
      if (logInfo.openTurn !== null && nt.turns.has(logInfo.openTurn) && tokens >= openTurnLargeResultTokens) {
        openTurnLargeResults.push({ callId, toolName, tokens, turn: logInfo.openTurn, seq })
      }
      if (!isClosed) continue
      candidateResults.push({
        callId,
        toolName,
        turn: t,
        tokens,
        seq,
        inCompactableSpan: compactableSpanTurnSet.has(t),
        isLarge: tokens >= largeBlockTokens || archiveMultimedia,
        isMultimedia,
      })
    }
  }

  const compactableTokens = spanCompactableTokens + outsideSpanLargeResultTokens
  const compactableTurns = compactableSpanTurnNums.length

  let suggestedTurns = compactableTailTurns
  if (islandTurns.length > 0) {
    const fromTurn = islandTurns[0]
    let toTurn = fromTurn
    for (let i = 1; i < islandTurns.length; i++) {
      if (islandTurns[i] !== toTurn + 1) break
      toTurn = islandTurns[i]
    }
    suggestedTurns = []
    for (let t = fromTurn; t <= toTurn; t++) suggestedTurns.push(t)
  }
  const suggestedTurnSet = new Set(suggestedTurns)
  let suggestedTokens = 0
  if (islandTurns.length > 0) {
    for (const item of uncompactedEntries) {
      if (closedTurnsOf(item.nt).some((t) => suggestedTurnSet.has(t))) suggestedTokens += item.tokens
    }
  } else {
    suggestedTokens = spanCompactableTokens
  }
  const suggestedSpan =
    suggestedTurns.length > 0
      ? {
          from: `turn:${suggestedTurns[0]}`,
          to: `turn:${suggestedTurns[suggestedTurns.length - 1]}`,
          fromTurn: suggestedTurns[0],
          toTurn: suggestedTurns[suggestedTurns.length - 1],
          turns: suggestedTurns.length,
          tokens: suggestedTokens,
        }
      : null

  const largeCandidates = candidateResults.filter((c) => c.isLarge)
  const poolForTop = largeCandidates.length > 0 ? largeCandidates : candidateResults
  poolForTop.sort((a, b) => (b.tokens !== a.tokens ? b.tokens - a.tokens : a.seq - b.seq))
  const topCandidates = [
    ...openTurnLargeResults.map((c) => ({ ...c, currentTurn: true })),
    ...poolForTop.slice(0, topCandidatesLimit).map(({ callId, toolName, turn, tokens, seq }) => ({
      callId, toolName, turn, tokens, seq, currentTurn: false,
    })),
  ].slice(0, topCandidatesLimit)

  const tokenTriggered = compactableTokens >= effectiveSoftWatermarkTokens
  const turnTriggered =
    compactableTurns >= 1 && (compactableTurns >= effectiveSoftWatermarkTurns || uncompactedClosedTurns >= effectiveSoftWatermarkTurns)
  const warmIslandSuppressed = islandTurns.length > 0 && !freeRide.active && !tokenTriggered && !turnTriggered
  const islandTriggered = islandTurns.length > 0 && !warmIslandSuppressed
  const tierCliffTriggered = measurement.surfaceTokens >= tierCliffTokens && compactableTokens >= tierCliffCompactableTokens
  const triggered = Boolean(enabled && (tokenTriggered || turnTriggered || islandTriggered || tierCliffTriggered))
  const baseReason = !enabled
    ? 'disabled'
    : tokenTriggered && turnTriggered
      ? 'both'
      : tokenTriggered
        ? 'tokens'
        : turnTriggered
          ? 'turns'
          : (warmIslandSuppressed ? 'warm-island-suppressed' : 'none')
  let reason = !islandTriggered || baseReason === 'disabled'
    ? baseReason
    : baseReason === 'none'
      ? 'islands'
      : `${baseReason}+islands`
  if (enabled && freeRide.active && baseReason !== 'none') reason += '+piggyback'
  if (enabled && tierCliffTriggered) reason += `${reason === 'none' ? '' : '+'}tier-cliff`

  const summaryNodeCount = summaryPrefixNodes.length
  const summaryTotalTokens = summaryPrefixNodes.reduce((sum, node) => sum + node.tokens, 0)
  const mergeNodes = summaryPrefixNodes.slice(0, Math.max(0, summaryNodeCount - 2)).slice(0, 8)
  const epochMergeCold = freeRide.elapsedMs !== null && freeRide.elapsedMs >= DEFAULT_PIGGYBACK_IDLE_MS
  const suggestedEpochMerge = epochMergeCold && (summaryNodeCount >= 10 || summaryTotalTokens >= 6000)
    ? mergeNodes.length > 0
      ? {
          from: `turn:${mergeNodes[0].minTurn}`,
          to: `turn:${mergeNodes[mergeNodes.length - 1].maxTurn}`,
          summaryCount: mergeNodes.length,
          mergeSummaries: true,
        }
      : null
    : null

  let hint = ''
  if (triggered) {
    const spanText = suggestedSpan ? `${suggestedSpan.from}..${suggestedSpan.to}` : '暂无'
    const topText =
      topCandidates.length > 0
        ? topCandidates.map((c) => `${c.callId}(${c.toolName},${c.tokens}t${c.currentTurn ? ',当轮' : ''})`).join(', ')
        : '无(>=500t)'
    const islandNote = islandTriggered && islandSpans.length > 0
      ? `；待补压孤岛区间: ${islandSpans.map((s) => `${s.from}..${s.to}`).join(', ')}`
      : ''
    const tierNote = tierCliffTriggered ? '[逼近200k计费阶梯] ' : ''
    const piggybackNote = freeRide.active ? '[搭便车窗口:20k/8轮] ' : ''
    const epochNote = suggestedEpochMerge ? `；建议Epoch归并: ${suggestedEpochMerge.from}..${suggestedEpochMerge.to}（${suggestedEpochMerge.summaryCount}个L0，mergeSummaries:true）` : ''
    hint = `[context-compact 水位提醒: ${tierNote}${piggybackNote}待压缩池已达软水位（共 ${uncompactedClosedTurns} 轮未压缩）。请在本步调用工具（特别是派发长后台任务前，防 5 分钟缓存过期全额重算）或回复（配 conclude_turn:true）时顺手调用 context_compact，无需先调 inspect:true；summary 请用 ≤120 tokens 电报体（路径:行号+结论）以压低输出成本。建议已完成区间: ${suggestedSpan ? 'from:"auto", to:"turnsBack:1"' : spanText}${islandNote}；Top结果: ${topText}${epochNote}]`
  } else if (suggestedEpochMerge) {
    // L1 prefix pressure is an independent trigger even when there is only one
    // new closed turn and the ordinary L0 token/turn watermarks stay quiet.
    hint = `[context-compact 水位提醒: 摘要前缀已累积 ${summaryNodeCount} 段（${summaryTotalTokens} tok）；建议Epoch归并: ${suggestedEpochMerge.from}..${suggestedEpochMerge.to}（${suggestedEpochMerge.summaryCount}个L0，mergeSummaries:true），减少前缀膨胀后再继续。]`
  } else if (session && typeof session === 'object') {
    watermarkLatchBySessionRegistry.delete(session)
  }

  return {
    triggered,
    reason,
    surfaceTokens: measurement.surfaceTokens,
    totalTokens: measurement.totalTokens,
    compactableTokens,
    spanCompactableTokens,
    outsideSpanLargeResultTokens,
    compactedBaselineTokens,
    recentProtectedTokens,
    uncompactedClosedTurns,
    compactableTurns,
    softWatermarkTokens: effectiveSoftWatermarkTokens,
    softWatermarkTurns: effectiveSoftWatermarkTurns,
    defaultSoftWatermarkTokens: softWatermarkTokens,
    defaultSoftWatermarkTurns: softWatermarkTurns,
    freeRide,
    tierCliffTriggered,
    openTurnLargeResults,
    summaryNodeCount,
    summaryTotalTokens,
    suggestedEpochMerge,
    keepRecentTurns,
    suggestedSpan,
    islandTurns,
    islandSpans,
    warmIslandSuppressed,
    topCandidates,
    hint,
  }
}

/**
 * Build the single-line soft watermark auto-hint string when the incremental compactable pool
 * reaches `softWatermarkTokens` or `softWatermarkTurns`; returns `''` otherwise.
 * Latches the first triggered hint string per compaction cycle (keyed by latest `compaction/*` event seq)
 * so repeated turns before a new compaction return the exact same string.
 */
export function buildSoftWatermarkHint(session, tokenMeter, options = {}) {
  const status = inspectSoftWatermark(session, tokenMeter, options)
  if (!status.triggered || !status.hint) {
    if (session && typeof session === 'object') {
      watermarkLatchBySessionRegistry.delete(session)
    }
    return ''
  }
  if (!session || typeof session !== 'object') {
    return status.hint
  }
  const compactionSeq = getLatestCompactionSeq(session)
  const latched = watermarkLatchBySessionRegistry.get(session)
  if (latched && latched.compactionSeq === compactionSeq && typeof latched.hint === 'string' && latched.hint.length > 0) {
    return latched.hint
  }
  watermarkLatchBySessionRegistry.set(session, { compactionSeq, hint: status.hint })
  return status.hint
}

function stepOfSurfaceResult(session, seq, logInfo) {
  const turn = logInfo.eventTurnMap.get(seq) ?? 0
  let step = logInfo.callMap.get(getEvent(session, seq)?.data?.message?.source?.callId)?.step
  if (typeof step === 'number') return { turn, step }
  const events = getAllEvents(session)
  for (let i = seq; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === 'step/start' && (ev.data?.turn ?? turn) === turn) return { turn, step: ev.data?.step ?? 0 }
  }
  return { turn, step: 0 }
}

/** Largest-first, completed append results; open-turn work is included except its recent tail. */
export function collectHardResultCandidates(session, tokenMeter, options = {}) {
  const keepRecentSteps = Math.max(0, Math.floor(configuredPositive(options, 'hardKeepRecentSteps', DEFAULT_HARD_KEEP_RECENT_STEPS, true)))
  const logInfo = inspectSessionLog(session)
  const measurement = tokenMeter.measure(session)
  const pricedBySeq = new Map(measurement.nodes.map((n) => [n.seq, nodeTokens(n)]))
  const latestStepByTurn = new Map()
  for (const ev of getAllEvents(session)) {
    if (ev?.type !== 'step/start') continue
    const turn = ev.data?.turn ?? logInfo.eventTurnMap.get(ev.seq) ?? 0
    latestStepByTurn.set(turn, Math.max(latestStepByTurn.get(turn) ?? 0, ev.data?.step ?? 0))
  }
  const candidates = []
  for (const seq of session.surface.nodes) {
    const ev = getEvent(session, seq)
    if (ev?.type !== 'tool/result' || ev.surfaceOp !== 'append') continue
    const callId = ev.data?.message?.source?.callId ?? ''
    if (!callId || logInfo.inFlightCalls.has(callId) || COMPACTION_TOOLS.has(logInfo.callMap.get(callId)?.name)) continue
    const at = stepOfSurfaceResult(session, seq, logInfo)
    const latestStep = latestStepByTurn.get(at.turn) ?? at.step
    if (logInfo.openTurn !== null && at.turn === logInfo.openTurn && latestStep - at.step <= keepRecentSteps) continue
    candidates.push({ seq, callId, tokens: pricedBySeq.get(seq) ?? 0, ...at })
  }
  return candidates.sort((a, b) => b.tokens - a.tokens || a.seq - b.seq)
}

/** Zero-LLM hard watermark/overflow pass. Every planning failure is isolated to its candidate. */
export function runHardCompaction(session, tokenMeter, options = {}) {
  const contextWindow = session.requestContext()?.contextWindow
  const beforeTokens = tokenMeter.measure(session).totalTokens
  const beforeGeneration = session.surface.replaceGeneration
  const empty = { beforeTokens, afterTokens: beforeTokens, resultCount: 0, spanCount: 0, changed: false, reason: '' }
  if ((!contextWindow || contextWindow <= 0) && options?.allowMissingContextWindow !== true) return { ...empty, reason: 'missing-context-window' }
  const logInfo = inspectSessionLog(session)
  if (logInfo.unmatchedCompactionStart) return { ...empty, reason: 'compaction-lock' }
  const targetRatio = configuredPositive(options, 'hardTargetRatio', DEFAULT_HARD_TARGET_RATIO)
  const committedResults = []
  let measurement = tokenMeter.measure(session)
  for (const candidate of collectHardResultCandidates(session, tokenMeter, options)) {
    if (contextWindow > 0 && measurement.totalTokens / contextWindow <= targetRatio) break
    try {
      const digest = buildAutoResultDigest(session, inspectSessionLog(session), candidate.seq, candidate.tokens)
      const plan = planResultCompaction(session, tokenMeter, { callId: candidate.callId, summary: digest }, undefined, 1)
      committedResults.push(commitResultCompaction(session, tokenMeter, plan))
      measurement = tokenMeter.measure(session)
    } catch {}
  }
  let span = null
  if ((options?.forceSpan === true || (contextWindow > 0 && measurement.totalTokens / contextWindow > configuredPositive(options, 'hardWatermarkRatio', DEFAULT_HARD_WATERMARK_RATIO)))
    && logInfo.openTurn !== null && logInfo.lastTurn > logInfo.openTurn - 1) {
    try {
      const closedTurns = [...new Set([...logInfo.eventTurnMap.values()].filter((turn) => turn > 0 && turn < logInfo.openTurn))]
      if (closedTurns.length) {
        const plan = planSpanCompaction(session, tokenMeter, { turns: closedTurns, summary: '@auto' }, 1)
        span = commitSpanCompaction(session, tokenMeter, plan)
        measurement = tokenMeter.measure(session)
      }
    } catch {}
  }
  return {
    beforeTokens,
    afterTokens: measurement.totalTokens,
    resultCount: committedResults.length,
    spanCount: span ? 1 : 0,
    changed: session.surface.replaceGeneration > beforeGeneration,
    committedResults,
    span,
    reason: '',
  }
}

/** Read-only startup audit. Missing/unreadable preset roots simply produce no warnings. */
export function auditNativeCompactionPresets(root = join(homedir(), '.dsh', '.agent-presets')) {
  const unsafe = []
  try {
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      try {
        const text = readFileSync(join(root, dirent.name, 'agent.cordis.yml'), 'utf8')
        if (/^\s*- id:\s*compaction-basic\s*$/m.test(text)
          && !/^\s*disabled:\s*true\s*$/m.test(text)
          && !/^\s*auto:\s*false\s*$/m.test(text)) unsafe.push(dirent.name)
      } catch {}
    }
  } catch {}
  return unsafe
}

/**
 * Read `ctx.compaction` without Cordis's inject gate.
 * A plugin fiber's context proxy throws `cannot get property "compaction" without inject`
 * for `ctx.compaction` (and optional chaining does not catch that). `ctx.get` is the
 * reflect lookup that does not require the name to be declared. Both paths are guarded
 * so a strict context returns undefined instead of aborting apply().
 */
export function readNativeCompaction(ctx) {
  if (ctx == null) return undefined
  try {
    const getter = ctx.get
    if (typeof getter === 'function') {
      const viaGet = getter.call(ctx, 'compaction')
      if (viaGet != null) return viaGet
    }
  } catch {}
  try {
    return ctx.compaction
  } catch {
    return undefined
  }
}

/**
 * Coordinate with DSH's optional native auto-compaction without editing its
 * files or configuration. Only an `auto: true` value owned by this apply call
 * is changed; dispose restores the value captured at takeover time.
 */
export function takeoverNativeCompaction(ctx, enabled = true) {
  let native
  try {
    native = readNativeCompaction(ctx)
  } catch {
    native = undefined
  }
  if (enabled === false || !native || native.auto !== true) return () => {}
  const previousAuto = native.auto
  try {
    native.auto = false
  } catch {
    return () => {}
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try { native.auto = previousAuto } catch {}
  }
}

export function apply(ctx, config = {}) {
  const stagedBySession = stagedBySessionRegistry
  const overflowRetries = new WeakMap()
  const overflowStepKeys = new WeakMap()
  const overflowSessionAgents = new WeakMap()
  let restoreNativeCompaction = () => {}
  try {
    restoreNativeCompaction = takeoverNativeCompaction(ctx, config.takeoverNativeCompaction !== false)
  } catch {
    restoreNativeCompaction = () => {}
  }
  // Cordis optional dependency: this child stays pending until `compaction` exists,
  // and only then is `ctx.compaction` legal. Skip it when this context already
  // resolved the service, so dispose restores `auto` exactly once.
  try {
    if (config.takeoverNativeCompaction !== false && readNativeCompaction(ctx) == null && typeof ctx.inject === 'function') {
      ctx.inject(['compaction'], (scoped) => {
        let restore = () => {}
        try { restore = takeoverNativeCompaction(scoped, true) } catch { restore = () => {} }
        try { scoped.on('dispose', restore) } catch {}
      })
    }
  } catch {}
  ctx.on('dispose', restoreNativeCompaction)
  try {
    const unsafe = auditNativeCompactionPresets()
    if (unsafe.length) ctx.logger?.('context-compact')?.warn?.(`native compaction still enabled in user preset(s): ${unsafe.join(', ')}`)
  } catch {}

  function getStagedQueue(session) {
    let q = stagedBySession.get(session)
    if (!q) {
      q = { spans: [], results: new Map(), dropped: [] }
      stagedBySession.set(session, q)
    }
    return q
  }

  function recordDroppedItem(q, entry) {
    q.dropped.push(entry)
    if (q.dropped.length > 50) q.dropped.shift()
    try {
      ctx.logger?.('context-compact')?.warn?.(
        `dropped staged ${entry.kind} ${entry.target} after ${entry.retries} retries: ${entry.error}`
      )
    } catch {}
  }

  function flushStagedCompactions(
    session,
    activeCallId,
    minSavingsTokens = DEFAULT_MIN_SAVINGS_TOKENS,
    maxRetries = DEFAULT_MAX_FLUSH_RETRIES,
    boundary = false
  ) {
    const st = sessionState(session)
    if (st.flushRunning) return { deferred: true, committedSpans: [], committedResults: [], skippedSpans: [], alreadyCompactedSpans: [], skippedResults: [], retried: [], dropped: [], errors: [] }
    // A new turn can start synchronously before the previous turn's microtask.
    // Isolate its staged work from the old closing boundary instead of flushing it early.
    const closingTurn = st.closingTurn
    if (boundary && closingTurn !== undefined && inspectSessionLog(session).openTurn !== null && inspectSessionLog(session).openTurn !== closingTurn) {
      const current = sessionState(session)
      const hasNewerWork = current.spans.some((sp) => (sp.stagedLogSeq ?? 0) > st.stagedLogSeq) || [...current.results.values()].some((res) => (res.stagedLogSeq ?? 0) > st.stagedLogSeq)
      if (!hasNewerWork) return { deferred: true, committedSpans: [], committedResults: [], skippedSpans: [], alreadyCompactedSpans: [], skippedResults: [], retried: [], dropped: [], errors: [] }
    }
    if (boundary) {
      const info = inspectSessionLog(session)
      // Historical dangling calls belong to closed turns and must not poison
      // every later boundary. Only calls from the newly opened turn are live.
      const liveCalls = [...info.inFlightCalls].filter((callId) => info.callMap.get(callId)?.turn === info.openTurn)
      if (info.unmatchedCompactionStart || (info.openTurn !== null && liveCalls.length)) {
        return { deferred: true, committedSpans: [], committedResults: [], skippedSpans: [], alreadyCompactedSpans: [], skippedResults: [], retried: [], dropped: [], errors: [] }
      }
    }
    st.flushRunning = true
    const q = stagedBySession.get(session)
    const stagedLogSeq = boundary && st.stagedLogSeq !== undefined ? st.stagedLogSeq : Infinity
    if (!q || (q.spans.length === 0 && q.results.size === 0)) {
      st.flushRunning = false
      return {
        committedSpans: [],
        committedResults: [],
        skippedSpans: [],
        alreadyCompactedSpans: [],
        skippedResults: [],
        retried: [],
        dropped: [],
        errors: [],
      }
    }

    try {
    const spansToRun = q.spans.filter((sp) => (sp.stagedLogSeq ?? 0) <= stagedLogSeq)
    const resultsToRun = [...q.results.values()].filter((res) => (res.stagedLogSeq ?? 0) <= stagedLogSeq)
    for (let i = q.spans.length - 1; i >= 0; i--) if ((q.spans[i].stagedLogSeq ?? 0) <= stagedLogSeq) q.spans.splice(i, 1)
    for (const res of resultsToRun) q.results.delete(res.callId)

    const tokenMeter = ctx.tokenMeter
    const committedSpans = []
    const committedResults = []
    const skippedSpans = []
    const alreadyCompactedSpans = []
    const skippedResults = []
    const retried = []
    const dropped = []
    const errors = []
    const shadowedBySpans = new Set()
    const committedReplacementSeqs = new Set()

    for (const sp of spansToRun) {
      // 1. Check overlap/containment against spans already committed in this flush:
      const overlap = classifySpanOverlap(sp, committedSpans)
      if (overlap) {
        skippedSpans.push({
          from: sp.from,
          to: sp.to,
          reason: overlap.reason,
        })
        continue
      }

      // 2. Silently skip if target span was already compacted prior to this flush:
      if (isSpanAlreadyCompacted(session, sp)) {
        alreadyCompactedSpans.push({ from: sp.from, to: sp.to })
        continue
      }

      // 3. Re-plan against current surface and commit:
      try {
        const plan = planSpanCompaction(session, tokenMeter, sp, minSavingsTokens)
        const postPlanOverlap = classifySpanOverlap(plan, committedSpans)
        if (postPlanOverlap || plan.shadowedSeqs.some((s) => committedReplacementSeqs.has(s))) {
          const reason = postPlanOverlap
            ? postPlanOverlap.reason
            : 'overlaps with span committed in current flush'
          skippedSpans.push({ from: sp.from, to: sp.to, reason })
          continue
        }
        const committed = commitSpanCompaction(session, tokenMeter, plan)
        for (const s of committed.shadowedSeqs) shadowedBySpans.add(s)
        if (Array.isArray(sp.shadowedSeqs)) {
          for (const s of sp.shadowedSeqs) shadowedBySpans.add(s)
        }
        committedReplacementSeqs.add(committed.replaceEventSeq)
        committedSpans.push(committed)
      } catch (err) {
        // Check if failure happened because part of the span was already compacted by an earlier span checkpoint on surface:
        if (Array.isArray(sp.leafSeqs) && sp.leafSeqs.length > 0) {
          const compactedSeqs = session.surface.nodes.filter((seq) => {
            const ev = getAllEvents(session)[seq]
            return Boolean(ev && ev.type === 'user/message' && ev.surfaceOp !== 'append')
          })
          const compactedLeaves = new Set(resolveLeafSurfaceSeqs(getAllEvents(session), compactedSeqs))
          const coveredCount = sp.leafSeqs.filter((l) => compactedLeaves.has(l)).length
          if (coveredCount === sp.leafSeqs.length) {
            alreadyCompactedSpans.push({ from: sp.from, to: sp.to })
            continue
          }
          if (coveredCount > 0) {
            skippedSpans.push({
              from: sp.from,
              to: sp.to,
              reason: 'overlaps with already-compacted span on surface',
            })
            continue
          }
        }

        const errMsg = err instanceof Error ? err.message : String(err)
        const prevRetries = sp.retries ?? 0
        if (prevRetries < maxRetries) {
          const nextRetries = prevRetries + 1
          q.spans.push({ ...sp, retries: nextRetries })
          retried.push(`span [${sp.from}..${sp.to}] (retry ${nextRetries}/${maxRetries})`)
          errors.push(`span [${sp.from}..${sp.to}] (retry ${nextRetries}/${maxRetries} queued): ${errMsg}`)
        } else {
          const dropRecord = {
            kind: 'span',
            target: `[${sp.from}..${sp.to}]`,
            from: sp.from,
            to: sp.to,
            retries: prevRetries,
            error: errMsg,
          }
          dropped.push(dropRecord)
          recordDroppedItem(q, dropRecord)
          errors.push(`span [${sp.from}..${sp.to}] (dropped after ${prevRetries} retries): ${errMsg}`)
        }
      }
    }

    for (const res of resultsToRun) {
      // Silently skip if result was already compacted (by a span or an earlier result compaction):
      const status = isResultAlreadyCompacted(session, res.callId, shadowedBySpans)
      if (status.compacted) {
        skippedResults.push(res.callId)
        continue
      }

      try {
        const plan = planResultCompaction(session, tokenMeter, res, activeCallId, minSavingsTokens)
        const committed = commitResultCompaction(session, tokenMeter, plan, activeCallId)
        committedResults.push(committed)
      } catch (err) {
        const afterStatus = isResultAlreadyCompacted(session, res.callId, shadowedBySpans)
        if (afterStatus.compacted) {
          skippedResults.push(res.callId)
          continue
        }

        const errMsg = err instanceof Error ? err.message : String(err)
        const prevRetries = res.retries ?? 0
        if (prevRetries < maxRetries) {
          const nextRetries = prevRetries + 1
          q.results.set(res.callId, { ...res, retries: nextRetries })
          retried.push(`result ${res.callId} (retry ${nextRetries}/${maxRetries})`)
          errors.push(`result ${res.callId} (retry ${nextRetries}/${maxRetries} queued): ${errMsg}`)
        } else {
          const dropRecord = {
            kind: 'result',
            target: res.callId,
            callId: res.callId,
            retries: prevRetries,
            error: errMsg,
          }
          dropped.push(dropRecord)
          recordDroppedItem(q, dropRecord)
          errors.push(`result ${res.callId} (dropped after ${prevRetries} retries): ${errMsg}`)
        }
      }
    }

    return {
      committedSpans,
      committedResults,
      skippedSpans,
      alreadyCompactedSpans,
      skippedResults,
      retried,
      dropped,
      errors,
    }
    } finally { st.flushRunning = false }
  }

  function boundaryFlush(session, reason, closingTurn) {
    const outcome = flushStagedCompactions(session, undefined, DEFAULT_MIN_SAVINGS_TOKENS, DEFAULT_MAX_FLUSH_RETRIES, true)
    if (outcome.deferred) return outcome
    if (!outcome.errors.length && (outcome.committedSpans.length || outcome.committedResults.length || !sessionState(session).spans.length && !sessionState(session).results.size)) {
      autoCompactClosingTurnResults(session, closingTurn ?? inspectSessionLog(session).lastTurn)
    }
    sessionMeasurementCacheRegistry.delete(session)
    return outcome
  }
  function scheduleBoundaryFlush(session, closingTurn) {
    const st = sessionState(session)
    st.ownerGeneration ??= ownerGeneration
    if (st.flushScheduled) return
    st.flushScheduled = true
    // Latch the closing turn and queue/log fence synchronously in turn/end.
    st.closingTurn = closingTurn
    st.stagedLogSeq = logLength(session)
    const generation = st.ownerGeneration
    queueMicrotask(() => {
      st.flushScheduled = false
      if (generation !== st.ownerGeneration) return
      try {
        const outcome = boundaryFlush(session, 'turn-end', closingTurn)
        st.lastBoundaryOutcome = outcome ? { deferred: outcome.deferred === true, errors: [...(outcome.errors ?? [])], committedSpans: outcome.committedSpans?.length ?? 0, committedResults: outcome.committedResults?.length ?? 0 } : null
      } catch (err) { st.lastBoundaryOutcome = { error: String(err?.message ?? err) } /* queue retained for next prompt boundary */ }
    })
  }
  const ownerGeneration = ++getGlobalRuntimeState().generation

  async function flushBeforeColdWake(sessionId, nowMs = Date.now()) {
    const session = typeof sessionId === 'object' ? sessionId : ctx.sessions?.get?.(sessionId)
    if (!session) return { flushed: false, reason: 'session-not-found' }
    const st = sessionState(session)
    const q = stagedBySession.get(session)
    const lastActivity = st.lastCompletionMs ?? inspectFreeRideWindow(session, inspectSessionLog(session), {}, nowMs).latestModelRequestTime
    const cold = lastActivity != null && nowMs - lastActivity >= DEFAULT_PIGGYBACK_IDLE_MS
    const staged = Boolean(q && (q.spans.length || q.results.size))
    if (!cold && !staged) return { flushed: false, reason: 'warm-no-staged' }
    const outcome = boundaryFlush(session, 'cold-wake', inspectSessionLog(session).lastTurn)
    st.abnormal = false
    return { flushed: true, cold, staged, outcome }
  }

  const hooks = globalThis[Symbol.for('dsh.context-compact.hooks.v1')] ??= {}
  hooks.flushBeforeColdWake = flushBeforeColdWake
  ctx.effect(() => () => {
    if (hooks.flushBeforeColdWake === flushBeforeColdWake) delete hooks.flushBeforeColdWake
  }, '@dsh-external/dsh-context-compact: cold-wake-hook')

  ctx.effect(() => () => { /* no flush/drop on dispose: next instance inherits pure data */ },
    '@dsh-external/dsh-context-compact: state')

  function autoCompactClosingTurnResults(session, closingTurn) {
    const threshold = configuredPositive(config, 'autoCompactOpenTurnThreshold', DEFAULT_AUTO_COMPACT_OPEN_TURN_THRESHOLD, true)
    if (threshold === 0) return []
    const logInfo = inspectSessionLog(session)
    const measurement = ctx.tokenMeter.measure(session)
    const pricedBySeq = new Map(measurement.nodes.map((n) => [n.seq, n.tokens]))
    const candidates = []
    for (const seq of session.surface.nodes) {
      const ev = getAllEvents(session)[seq]
      if (ev?.type !== 'tool/result' || ev.surfaceOp !== 'append') continue
      const turn = logInfo.eventTurnMap.get(seq)
      if (turn !== closingTurn && !isMultimediaArchiveTurn(turn, logInfo)) continue
      const callId = ev.data?.message?.source?.callId ?? ''
      if (!callId || COMPACTION_TOOLS.has(logInfo.callMap.get(callId)?.name)) continue
      const tokens = pricedBySeq.get(seq) ?? 0
      const archiveMultimedia = isMultimediaToolResult(session, ev, logInfo) && isMultimediaArchiveTurn(turn, logInfo)
      if (tokens >= threshold || archiveMultimedia) candidates.push({ seq, callId, tokens })
    }
    const committed = []
    for (const candidate of candidates) {
      try {
        const summary = isMultimediaToolResult(session, getEvent(session, candidate.seq), logInfo)
          ? `[Compact-Auto] read_image/image result archived to reduce multimodal tokens and request size. [recall: @call:${candidate.callId}]`
          : buildAutoResultDigest(session, logInfo, candidate.seq, candidate.tokens)
        const plan = planResultCompaction(session, ctx.tokenMeter, { callId: candidate.callId, summary }, undefined, 1)
        committed.push(commitResultCompaction(session, ctx.tokenMeter, plan))
      } catch (err) {
        try {
          ctx.logger?.('context-compact')?.warn?.(`auto result compaction skipped ${candidate.callId}: ${err instanceof Error ? err.message : String(err)}`)
        } catch {}
      }
    }
    return committed
  }

  ctx.on('agent/turn-stopping', function (payload) {
    const signal = payload?.signal
    if (signal?.aborted) return
    const agent = payload?.agent ?? this?.agent
    const session = agent?.session
    if (!session) return
    const q = stagedBySession.get(session)
    if (q && (q.spans.length > 0 || q.results.size > 0)) {
      flushStagedCompactions(session, undefined, DEFAULT_MIN_SAVINGS_TOKENS, DEFAULT_MAX_FLUSH_RETRIES)
    }
    if (!signal?.aborted) autoCompactClosingTurnResults(session, payload?.turn ?? inspectSessionLog(session).openTurn)
  })

  ctx.on('agent/pre-step', async function (payload, next) {
    try {
      const agent = payload?.agent ?? this?.agent
      const session = agent?.session
      if (!session || payload?.signal?.aborted) return next()
      const contextWindow = session.requestContext()?.contextWindow
      const ratio = configuredPositive(config, 'hardWatermarkRatio', DEFAULT_HARD_WATERMARK_RATIO)
      if (!contextWindow || contextWindow <= 0 || ratio <= 0 || ctx.tokenMeter.measure(session).totalTokens / contextWindow < ratio) return next()
      if (inspectSessionLog(session).unmatchedCompactionStart) return next()
      const result = runHardCompaction(session, ctx.tokenMeter, config)
      try {
        ctx.logger?.('context-compact')?.info?.(`hard watermark: ${result.beforeTokens} -> ${result.afterTokens} tokens; archived ${result.resultCount} result(s), ${result.spanCount} closed-turn span(s)`)
      } catch {}
    } catch (err) {
      try { ctx.logger?.('context-compact')?.warn?.(`hard watermark skipped: ${err instanceof Error ? err.message : String(err)}`) } catch {}
    }
    return next()
  })

  ctx.on('agent/request-error', async function (payload, next) {
    try {
      if (payload?.failure?.code !== 'CONTEXT_WINDOW_EXCEEDED' || payload?.signal?.aborted || config?.overflowRescue === false) return next()
      const agent = payload?.agent ?? this?.agent
      const session = agent?.session
      if (!session) return next()
      const key = `${payload?.turn ?? ''}:${payload?.step ?? ''}`
      let agents = overflowSessionAgents.get(session)
      if (!agents) overflowSessionAgents.set(session, agents = new Set())
      agents.add(agent)
      const retries = overflowStepKeys.get(agent) === key ? (overflowRetries.get(agent) ?? 0) : 0
      const maxRetries = Math.max(0, Math.floor(configuredPositive(config, 'overflowMaxRetries', DEFAULT_OVERFLOW_MAX_RETRIES, true)))
      if (retries >= maxRetries) return next()
      const beforeGeneration = session.surface.replaceGeneration
      const beforeTokens = ctx.tokenMeter.measure(session).totalTokens
      const result = runHardCompaction(session, ctx.tokenMeter, {
        ...config,
        hardKeepRecentSteps: 1,
        hardTargetRatio: DEFAULT_OVERFLOW_TARGET_RATIO,
        forceSpan: true,
        allowMissingContextWindow: true,
      })
      const afterTokens = ctx.tokenMeter.measure(session).totalTokens
      overflowStepKeys.set(agent, key)
      overflowRetries.set(agent, retries + 1)
      try { ctx.logger?.('context-compact')?.info?.(`overflow rescue: ${beforeTokens} -> ${afterTokens} tokens; archived ${result.resultCount} result(s), ${result.spanCount} span(s)`) } catch {}
      if (session.surface.replaceGeneration > beforeGeneration && afterTokens < beforeTokens) return { kind: 'retry' }
    } catch (err) {
      try { ctx.logger?.('context-compact')?.warn?.(`overflow rescue skipped: ${err instanceof Error ? err.message : String(err)}`) } catch {}
    }
    return next()
  })

  ctx.on('session/event', (session, event) => {
    const st = sessionState(session)
    if (event.type === 'assistant/message') {
      st.lastCompletionMs = event.data?.time ?? event.time ?? Date.now()
      for (const agent of overflowSessionAgents.get(session) ?? []) {
        overflowRetries.delete(agent)
        overflowStepKeys.delete(agent)
      }
    }
    if (event.type !== 'turn/end') return
    st.closedTurn = event.data?.turn ?? inspectSessionLog(session).lastTurn
    st.abnormal = event.data?.reason?.kind !== 'completed'
    // session.append is notifying observers with entry.appending=true. Zero
    // writes here; a microtask runs after commit and before the next turn.
    if (st.abnormal) scheduleBoundaryFlush(session, st.closedTurn)
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'context-compact:guidance',
    order: 85,
    text: COMPACT_SYSTEM_RULE,
  }), '@dsh-external/dsh-context-compact: systemPrompt.section')

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'context-compact:directory',
    order: 85,
    text: (context) => {
      const session = context?.agent?.session ?? context?.session
      if (!session) return ''
      try {
        // 同一请求的大块目录与水位提醒共享一次 surface 测量，避免重复扫描整段会话。
        const sharedMeter = { measure: (s) => measureSessionCached(s, ctx.tokenMeter) }
        const q = stagedBySession.get(session)
        const st = sessionState(session)
        const lastCompletion = st.lastCompletionMs ?? inspectFreeRideWindow(session, inspectSessionLog(session)).latestModelRequestTime
        const idleMs = Date.now() - (lastCompletion ?? Date.now())
        if (q && (q.spans.length || q.results.size) && (st.abnormal || idleMs >= DEFAULT_PIGGYBACK_IDLE_MS)) {
          boundaryFlush(session, 'next-prompt', st.closedTurn)
          st.abnormal = false
        }
        // 未达水位不输出目录/占用快照；达水位后整段文本按 compaction 周期锁存。
        const hint = buildSoftWatermarkHint(session, sharedMeter, config)
        if (!hint) return ''
        const dir = buildLargeBlocksDirectory(session, sharedMeter, config)
        return [dir, hint].filter(Boolean).join('\n')
      } catch {
        return ''
      }
    },
  }), '@dsh-external/dsh-context-compact: systemPrompt.context')

  ctx.effect(() => ctx.tools.register({
    name: 'context_compact',
    description: 'Compact completed tool results (`results`: current or earlier turns) or closed multi-turn spans (`spans`: never the current open turn) into a summary with a lossless recall tag. Staged until turn end; committed immediately when occupancy > 70% or `conclude_turn: true`.',
    parameters: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          description: '[{callId, summary}]',
          items: {
            type: 'object',
            properties: {
              callId: { type: 'string', description: 'Completed tool callId.' },
              summary: { type: 'string', description: 'Conclusion with key paths/anchors.' },
            },
            required: ['callId', 'summary'],
            additionalProperties: false,
          },
        },
        spans: {
          type: 'array',
          description: 'Closed multi-turn spans: [{from,to,summary}] for a range or [{turns,summary}] for selected turns. `turns` accepts 226, "turn:226", "turnsBack:N", or "235..237"; `to` then defaults to the maximum. Endpoints: "turn:N", "turnsBack:N", "<callId>", "latest", "latest-closed", or "auto"; omitted `from` means auto/latest-compacted. Open turns are never compacted.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Range start.' },
              to: { type: 'string', description: 'Range end.' },
              turns: {
                type: 'array',
                description: 'Closed turns to compact.',
                items: {
                  anyOf: [
                    { type: 'integer' },
                    { type: 'string' },
                  ],
                },
              },
              summary: { type: 'string', description: 'Checkpoint summary.' },
              mergeSummaries: { type: 'boolean', description: 'Merge selected summaries into one L1 epoch summary.' },
            },
            required: ['summary'],
            additionalProperties: false,
          },
        },
        conclude_turn: {
          type: 'boolean',
          description: '立即提交并结束本轮；仅当本条消息已写完最终回复且无其他工具调用时生效，否则只提交。',
        },
        inspect: {
          type: 'boolean',
          description: 'List surface blocks >= 500 tokens.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('tool call aborted')
      const session = exec?.agent?.session
      if (!session) throw new Error('context_compact requires an active agent session')

      const tokenMeter = ctx.tokenMeter
      const parts = []

      if (args?.inspect === true) {
        parts.push(buildInspectReport(session, tokenMeter))
      }

      const rawSpans = Array.isArray(args?.spans) ? args.spans : []
      const rawResults = Array.isArray(args?.results) ? args.results : []
      const concludeTurn = args?.conclude_turn === true

      if (rawSpans.length === 0 && rawResults.length === 0) {
        if (concludeTurn) {
          if (exec?.signal?.aborted) throw new Error('aborted before commit')
          const outcome = flushStagedCompactions(session, exec?.callId, DEFAULT_MIN_SAVINGS_TOKENS, DEFAULT_MAX_FLUSH_RETRIES)
          if (
            outcome.committedSpans.length > 0 ||
            outcome.committedResults.length > 0 ||
            outcome.skippedSpans.length > 0 ||
            outcome.errors.length > 0
          ) {
            const savedTokens =
              outcome.committedSpans.reduce((s, x) => s + x.savings, 0) +
              outcome.committedResults.reduce((s, x) => s + x.savings, 0)
            const tags = [
              ...outcome.committedSpans.map((x) => x.recallTag),
              ...outcome.committedResults.map((x) => x.recallTag),
            ]
            const skipSpanNote = outcome.skippedSpans.length > 0
              ? ` (skipped overlapping spans: ${outcome.skippedSpans.map((s) => `[${s.from}..${s.to}: ${s.reason}]`).join(', ')})`
              : ''
            const errNote = outcome.errors.length > 0 ? ` [errors: ${outcome.errors.join('; ')}]` : ''
            parts.push(
              `[Compact committed immediately: ${outcome.committedSpans.length} span(s), ${outcome.committedResults.length} result(s), saved ~${savedTokens} tok. ${tags.join(' ')}${skipSpanNote}${errNote}]`
            )
          }
          const eligibility = checkConcludeTurnEligibility(session, exec)
          if (eligibility.canConclude && typeof exec?.concludeTurn === 'function') {
            exec.concludeTurn()
            parts.push('[Compact] Turn concluded.')
          } else {
            parts.push(`[Compact] 未结束本轮，请继续写最终回复（${formatConcludeBlockReason(eligibility.reason)}）。`)
          }
        } else if (parts.length === 0) {
          parts.push(buildInspectReport(session, tokenMeter))
        }
        return { text: parts.join('\n\n') }
      }

      const q = getStagedQueue(session)
      const plannedSpans = []
      const dedupedSpanLabels = []
      const overlapStageNotes = []

      for (const sp of rawSpans) {
        const plan = planSpanCompaction(session, tokenMeter, sp, DEFAULT_MIN_SAVINGS_TOKENS)
        const existingPlannedIdx = plannedSpans.findIndex((existing) => isSameSpanTarget(existing, plan))
        if (existingPlannedIdx !== -1) {
          plannedSpans[existingPlannedIdx] = plan
          dedupedSpanLabels.push(`[${plan.from}..${plan.to}]`)
        } else {
          plannedSpans.push(plan)
        }
      }

      // Compute non-overlapping shadowed seqs for filtering covered results in this call:
      const acceptedForCoverage = [...q.spans]
      const plannedShadowedSeqs = new Set()
      for (const existing of q.spans) {
        if (Array.isArray(existing.shadowedSeqs)) {
          for (const s of existing.shadowedSeqs) plannedShadowedSeqs.add(s)
        }
      }
      for (const plan of plannedSpans) {
        const sameInQueue = q.spans.some((existing) => isSameSpanTarget(existing, plan))
        const overlap = sameInQueue ? null : classifySpanOverlap(plan, acceptedForCoverage)
        if (!overlap) {
          acceptedForCoverage.push(plan)
          for (const s of plan.shadowedSeqs) plannedShadowedSeqs.add(s)
        }
      }

      const plannedResults = []
      const skippedCallIds = []
      for (const r of rawResults) {
        const cid = String(r.callId ?? '').trim().replace(/^@call:/, '')
        let covered = false
        for (const seq of plannedShadowedSeqs) {
          const ev = getAllEvents(session)[seq]
          if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === cid) {
            covered = true
            break
          }
        }
        if (covered) {
          skippedCallIds.push(cid)
          continue
        }
        const plan = planResultCompaction(session, tokenMeter, r, exec.callId, DEFAULT_MIN_SAVINGS_TOKENS)
        const existingResIdx = plannedResults.findIndex((existing) => existing.callId === plan.callId)
        if (existingResIdx !== -1) {
          plannedResults[existingResIdx] = plan
        } else {
          plannedResults.push(plan)
        }
      }

      for (const sp of plannedSpans) {
        const stagedEntry = {
          from: sp.from,
          to: sp.to,
          turns: Array.isArray(sp.turns) ? [...sp.turns] : undefined,
          resolvedFrom: sp.resolvedFrom,
          resolvedTo: sp.resolvedTo,
          resolvedTurns: Array.isArray(sp.resolvedTurns) ? [...sp.resolvedTurns] : undefined,
          summary: sp.summary,
          mergeSummaries: sp.mergeSummaries === true,
          startSeq: sp.startSeq,
          endSeq: sp.endSeq,
          shadowedSeqs: sp.shadowedSeqs,
          compactedSeqs: Array.isArray(sp.compactedSeqs) ? [...sp.compactedSeqs] : sp.shadowedSeqs,
          clusters: Array.isArray(sp.clusters) ? sp.clusters.map((c) => ({ seqs: [...c.seqs] })) : undefined,
          leafSeqs: sp.leafSeqs,
          minLeaf: sp.minLeaf,
          maxLeaf: sp.maxLeaf,
          retries: 0,
          stagedLogSeq: logLength(session),
        }
        const existingQueueIdx = q.spans.findIndex((existing) => isSameSpanTarget(existing, stagedEntry))
        if (existingQueueIdx !== -1) {
          q.spans[existingQueueIdx] = stagedEntry
          dedupedSpanLabels.push(`[${sp.from}..${sp.to}]`)
        } else {
          const overlap = classifySpanOverlap(stagedEntry, q.spans)
          if (overlap) {
            overlapStageNotes.push(`[${sp.from}..${sp.to}: ${overlap.reason}]`)
          }
          q.spans.push(stagedEntry)
        }
      }
      for (const r of plannedResults) {
        q.results.set(r.callId, { callId: r.callId, summary: r.summary, retries: 0, stagedLogSeq: logLength(session) })
      }

      const immediate = concludeTurn || isHighContextOccupancy(session, tokenMeter, DEFAULT_IMMEDIATE_RATIO)
      if (immediate) {
        if (exec?.signal?.aborted) throw new Error('aborted before commit')
        const outcome = flushStagedCompactions(session, exec.callId, DEFAULT_MIN_SAVINGS_TOKENS, DEFAULT_MAX_FLUSH_RETRIES)
        let turnConcluded = false
        let concludeBlockedNote = ''
        if (concludeTurn) {
          const eligibility = checkConcludeTurnEligibility(session, exec)
          if (eligibility.canConclude && typeof exec?.concludeTurn === 'function') {
            exec.concludeTurn()
            turnConcluded = true
          } else {
            concludeBlockedNote = ` | 未结束本轮，请继续写最终回复（${formatConcludeBlockReason(eligibility.reason)}）`
          }
        }
        if (
          outcome.errors.length > 0 &&
          outcome.committedSpans.length === 0 &&
          outcome.committedResults.length === 0 &&
          outcome.skippedSpans.length === 0 &&
          outcome.alreadyCompactedSpans.length === 0
        ) {
          throw new Error(`compaction failed: ${outcome.errors.join('; ')}`)
        }
        const savedTokens =
          outcome.committedSpans.reduce((s, x) => s + x.savings, 0) +
          outcome.committedResults.reduce((s, x) => s + x.savings, 0)
        const tags = [
          ...outcome.committedSpans.map((x) => x.recallTag),
          ...outcome.committedResults.map((x) => x.recallTag),
        ]
        const skippedAll = [...new Set([...skippedCallIds, ...outcome.skippedResults])]
        const skipNote = skippedAll.length > 0 ? ` (skipped covered results: ${skippedAll.join(', ')})` : ''
        const skipSpanNote = outcome.skippedSpans.length > 0
          ? ` (skipped overlapping spans: ${outcome.skippedSpans.map((s) => `[${s.from}..${s.to}: ${s.reason}]`).join(', ')})`
          : ''
        const dedupNote = dedupedSpanLabels.length > 0
          ? ` (deduplicated spans: ${[...new Set(dedupedSpanLabels)].join(', ')})`
          : ''
        const errNote = outcome.errors.length > 0 ? ` [errors: ${outcome.errors.join('; ')}]` : ''
        const concludeNote = turnConcluded ? ' | turn concluded' : concludeBlockedNote
        parts.push(
          `[Compact committed immediately: ${outcome.committedSpans.length} span(s), ${outcome.committedResults.length} result(s), saved ~${savedTokens} tok. ${tags.join(' ')}${skipNote}${skipSpanNote}${dedupNote}${concludeNote}${errNote}]`
        )
      } else {
        const savedTokens =
          plannedSpans.reduce((s, x) => s + x.savings, 0) +
          plannedResults.reduce((s, x) => s + x.savings, 0)
        const tags = [
          ...plannedSpans.map((x) => x.recallTag),
          ...plannedResults.map((x) => x.recallTag),
        ]
        const skipNote = skippedCallIds.length > 0 ? ` (dropped covered results: ${skippedCallIds.join(', ')})` : ''
        const dedupNote = dedupedSpanLabels.length > 0
          ? ` (deduplicated spans: ${[...new Set(dedupedSpanLabels)].join(', ')})`
          : ''
        const overlapNote = overlapStageNotes.length > 0
          ? ` (overlapping spans will be skipped at commit: ${overlapStageNotes.join(', ')})`
          : ''
        parts.push(
          `[Compact staged for turn-stopping: ${plannedSpans.length} span(s), ${plannedResults.length} result(s), est. save ~${savedTokens} tok. Original content remains visible for the rest of this turn. ${tags.join(' ')}${skipNote}${dedupNote}${overlapNote}]`
        )
      }

      return { text: parts.join('\n\n') }
    },
  }), '@dsh-external/dsh-context-compact: context_compact')

  ctx.effect(() => ctx.tools.register({
    name: 'context_recall',
    description: 'Read-only lossless recall of original uncompacted content, including nested compactions. Returns up to 120 lines per call with a continuation cursor.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Recall target: "@call:<callId>", "@span:S<start>-<end>", "@turn:<N>", "@index"/"@all"/"@search" for global query search, or event seq.',
        },
        query: {
          type: 'string',
          description: 'Optional substring or regex to filter lines within the recalled content.',
        },
        context_lines: {
          type: 'integer',
          description: 'Surrounding context lines when `query` is used (default 3)',
        },
        line_range: {
          type: 'array',
          description: 'Optional 1-based inclusive [startLine, endLine] range (capped at 120 lines per call)',
          items: { type: 'integer' },
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          target: { type: 'string' },
          leafSeqs: { type: 'array', items: { type: 'integer' } },
          totalLines: { type: 'integer' },
          returnedLines: { type: 'integer' },
          hasMore: { type: 'boolean' },
        },
        required: ['text', 'target', 'leafSeqs', 'totalLines', 'returnedLines', 'hasMore'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('tool call aborted')
      const session = exec?.agent?.session
      if (!session) throw new Error('context_recall requires an active agent session')
      const res = executeRecall(session, args)
      return {
        text: res.text,
        target: res.target,
        leafSeqs: res.leafSeqs,
        totalLines: res.totalLines,
        returnedLines: res.returnedLines,
        hasMore: res.hasMore,
      }
    },
  }), '@dsh-external/dsh-context-compact: context_recall')

  return restoreNativeCompaction
}

export default { name, inject, apply }
