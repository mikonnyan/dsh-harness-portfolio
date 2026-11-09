/**
 * @dsh-external/dsh-context-compact
 * Precise context compaction (`context_compact`) and lossless recall (`context_recall`)
 * for DeepSeek Harness 0.1.0-rc.7.
 * Zero external runtime imports so host injection works without node_modules links.
 */
import { randomUUID } from 'node:crypto'

export const name = '@dsh-external/dsh-context-compact'
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

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export const COMPACT_SYSTEM_RULE = [
  '### Context Compaction (`context_compact` & `context_recall`)',
  '- When you finish a phase of investigation or implementation and reach a conclusion, call `context_compact` in the same step to compress large tool outputs or earlier multi-turn spans from that phase.',
  '- Write concise engineering conclusions in `summary` and preserve exact anchors: file paths, line numbers, symbols, error codes, and key values.',
  '- Single-item (`results`) compaction can replace completed tool returns from the current turn or earlier turns (staged until turn end by default); range (`spans`) compaction cannot cover the current open turn.',
  '- Compacted items remain visible during the current turn (staged until `agent/turn-stopping`, unless context occupancy > 70% or `conclude_turn: true` — 仅在同一条消息已写完最终回复时使用，用于省一次请求), and their original content is always losslessly recoverable via `context_recall` using the `[recall: @call:...]` or `[recall: @span:...]` tag.',
  '- When a `[context-compact 水位提醒: ...]` hint appears, piggyback `context_compact` in the same step as your next tool call (especially before dispatching long background tasks where a >5 min wait expires prompt caches anyway) or final reply (`conclude_turn: true`), using directly the suggested `turn:A..turn:B` span and Top 3 `callId` candidates without calling `inspect: true` first, and keep each `summary` in <=120 tokens telegraphic style (`path:line + conclusion`) to minimize output token cost.'
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

/** Create checkpoint provenance matching `@deepseek-ai/dsh-compaction#compactCheckpointSource` */
export function compactCheckpointSource(compactionId, sourceCommandId) {
  return Object.freeze({
    kind: 'plugin',
    plugin: 'compact',
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  })
}

/**
 * Tool-pairing balance check matching `@deepseek-ai/dsh-compaction/tool-pairing`:
 * `assistant/message` adds tool-call count; `tool/result` subtracts 1.
 */
function computeSurfaceCutBalance(session) {
  const seqs = session.surface.nodes
  const events = session.events
  const cutBalanced = [true]
  const indexBySeq = new Map()
  let inProgressToolCalls = 0

  for (let i = 0; i < seqs.length; i++) {
    const seq = seqs[i]
    const event = events[seq]
    if (!event || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    let delta = 0
    if (event.type === 'assistant/message') {
      delta = event.data.message.content.filter((b) => b.type === 'tool-call').length
    } else if (event.type === 'tool/result') {
      delta = -1
    }
    inProgressToolCalls += delta
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    indexBySeq.set(seq, i)
    cutBalanced.push(inProgressToolCalls === 0)
  }

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
  const events = session.events
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
  const events = session.events
  const ev = events[seq]
  if (!ev) return { minTurn: 0, maxTurn: 0, turns: new Set(), leafSeqs: [] }

  const leafSeqs = ev.surfaceOp === 'append' ? [seq] : resolveLeafSurfaceSeqs(events, [seq])
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
    const blocks = msg?.content?.[0]?.content ?? []
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
    const ev = session.events[seq]
    if (!ev) continue
    if (ev.data?.source?.plugin === '@deepseek-ai/dsh-system-prompt') continue
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
    const ev = session.events[seq]
    if (!ev) continue
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

  if (turnMatch) {
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
    if (logInfo.openTurn !== null && targetTurn === logInfo.openTurn) {
      throw new Error(`span endpoint "${raw}" targets the current open turn (${logInfo.openTurn}), which is forbidden`)
    }
    const matchingIndices = []
    for (let idx = 0; idx < surfaceNodes.length; idx++) {
      const nt = nodeTurnsList[idx]
      if (nt.turns.has(targetTurn) || (nt.minTurn <= targetTurn && targetTurn <= nt.maxTurn && nt.minTurn > 0)) {
        matchingIndices.push(idx)
      }
    }
    if (matchingIndices.length === 0) {
      throw new Error(`no current surface events found for selector "${raw}" (turn ${targetTurn})`)
    }
    return isEnd ? matchingIndices[matchingIndices.length - 1] : matchingIndices[0]
  }

  // Otherwise treat selector as callId (or @call:callId)
  const callId = raw.replace(/^@call:/, '')
  for (let idx = 0; idx < surfaceNodes.length; idx++) {
    const ev = session.events[surfaceNodes[idx]]
    if (!ev) continue
    if (ev.type === 'tool/result' && ev.data?.message?.source?.callId === callId) {
      if (isEnd) return idx
      // If `from` is a callId, locate the assistant/message that issued this tool-call so the pair stays balanced!
      for (let j = idx - 1; j >= 0; j--) {
        const aev = session.events[surfaceNodes[j]]
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
          const rev = session.events[surfaceNodes[j]]
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

/**
 * Plan and validate a span compaction on the current surface.
 */
export function planSpanCompaction(session, tokenMeter, spanSpec, minSavingsTokens = DEFAULT_MIN_SAVINGS_TOKENS) {
  const { from, to, summary } = spanSpec
  const effectiveFrom = spanSpec.resolvedFrom ?? from
  const effectiveTo = spanSpec.resolvedTo ?? to
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('span summary must be a non-empty string')
  }

  const logInfo = inspectSessionLog(session)
  if (logInfo.unmatchedCompactionStart) {
    throw new Error('compaction lock is already active on this session (unmatched compaction/start)')
  }

  const surfaceNodes = [...session.surface.nodes]
  if (surfaceNodes.length === 0) throw new Error('session surface is empty')

  const nodeTurnsList = surfaceNodes.map((seq) => resolveSurfaceNodeTurns(session, seq, logInfo))
  const startIdx = resolveEndpointSurfaceIndices(session, effectiveFrom, false, logInfo, surfaceNodes, nodeTurnsList)
  const endIdx = resolveEndpointSurfaceIndices(session, effectiveTo, true, logInfo, surfaceNodes, nodeTurnsList)

  if (startIdx > endIdx) {
    throw new Error(`span from "${from}" (surface index ${startIdx}) is after to "${to}" (surface index ${endIdx})`)
  }

  for (let i = startIdx; i <= endIdx; i++) {
    const nt = nodeTurnsList[i]
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

  const shadowedSeqs = surfaceNodes.slice(startIdx, endIdx + 1)
  const leafSeqs = resolveLeafSurfaceSeqs(session.events, shadowedSeqs)
  const minLeaf = leafSeqs.length > 0 ? leafSeqs[0] : startSeq
  const maxLeaf = leafSeqs.length > 0 ? leafSeqs[leafSeqs.length - 1] : endSeq

  const measurement = tokenMeter.measure(session)
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, n.tokens)
  const shadowedTokenCount = shadowedSeqs.reduce((acc, s) => acc + (pricedBySeq.get(s) ?? 0), 0)

  const recallTag = `[recall: @span:S${minLeaf}-${maxLeaf}]`
  const formattedText = `[Compact] ${summary.trim()} ${recallTag}`
  const summaryBlocks = [{ type: 'text', text: formattedText }]
  const framedContent = [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summaryBlocks,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]

  const tempCompactionId = randomUUID()
  const previewMessage = createUserMessage({
    content: framedContent,
    source: compactCheckpointSource(tempCompactionId),
  })
  const newTokenCount = tokenMeter.estimateMessage(previewMessage)
  const savings = shadowedTokenCount - newTokenCount

  if (newTokenCount >= shadowedTokenCount) {
    throw new Error(`span replacement (${newTokenCount} tokens) is not smaller than shadowed range (${shadowedTokenCount} tokens)`)
  }
  if (savings < minSavingsTokens) {
    throw new Error(`span token savings (${savings} tokens) is below minimum threshold (${minSavingsTokens} tokens)`)
  }

  return {
    kind: 'span',
    from,
    to,
    resolvedFrom: normalizeEndpointSelector(effectiveFrom, logInfo),
    resolvedTo: normalizeEndpointSelector(effectiveTo, logInfo),
    summary: summary.trim(),
    startSeq,
    endSeq,
    shadowedSeqs,
    leafSeqs,
    minLeaf,
    maxLeaf,
    shadowedTokenCount,
    newTokenCount,
    savings,
    recallTag,
    summaryBlocks,
    framedContent,
  }
}

/**
 * Execute one validated span compaction synchronously (4 events back-to-back, no await).
 */
export function commitSpanCompaction(session, tokenMeter, plan) {
  const currentPlan = planSpanCompaction(session, tokenMeter, {
    from: plan.from,
    to: plan.to,
    resolvedFrom: plan.resolvedFrom,
    resolvedTo: plan.resolvedTo,
    summary: plan.summary,
  }, 1)

  const logInfo = inspectSessionLog(session)
  const compactionId = randomUUID()
  const lifecycle = {
    compactionId,
    turn: logInfo.openTurn,
  }

  const headerConfig = session.requestHeader()?.config
  const provider = headerConfig?.provider || 'context-compact'
  const model = headerConfig?.model || 'manual'

  const checkpointMessage = createUserMessage({
    content: currentPlan.framedContent,
    source: compactCheckpointSource(compactionId),
  })

  // 4 events synchronously adjacent with zero await:
  const startEvent = session.append('compaction/start', lifecycle)
  try {
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: currentPlan.summaryBlocks,
      shadowedRange: {
        start: currentPlan.startSeq,
        end: currentPlan.endSeq,
      },
      shadowedSeqs: [...currentPlan.shadowedSeqs],
      shadowedTokenCount: currentPlan.shadowedTokenCount,
      provider,
      model,
    })
    const replaceEvent = session.append('user/message', checkpointMessage, {
      surfaceOp: {
        op: 'replace',
        start: currentPlan.startSeq,
        end: currentPlan.endSeq,
      },
      sourceEventSeqs: [
        startEvent.seq,
        summaryEvent.seq,
        ...currentPlan.shadowedSeqs,
      ],
    })
    const endEvent = session.append('compaction/end', lifecycle)
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
  const summary = String(itemSpec?.summary ?? '').trim()
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
    const ev = session.events[seq]
    if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === rawCallId) {
      targetSeq = seq
      targetEvent = ev
      break
    }
  }

  if (targetSeq === -1 || !targetEvent) {
    throw new Error(`tool/result for callId "${rawCallId}" not found on current session surface (may already be covered by a span compaction or does not exist)`)
  }

  const origResultBlock = targetEvent.data.message.content[0]
  const recallTag = `[recall: @call:${rawCallId}]`
  const formattedText = `[Compact] ${summary} ${recallTag}`
  const newContent = [{ type: 'text', text: formattedText }]

  const newMessage = freezeMessage({
    ...targetEvent.data.message,
    content: [{
      ...origResultBlock,
      content: newContent,
    }],
  })

  const shadowedTokenCount = tokenMeter.estimateMessage(targetEvent.data.message)
  const newTokenCount = tokenMeter.estimateMessage(newMessage)
  const savings = shadowedTokenCount - newTokenCount

  if (newTokenCount >= shadowedTokenCount) {
    throw new Error(`result replacement for "${rawCallId}" (${newTokenCount} tokens) is not smaller than original (${shadowedTokenCount} tokens)`)
  }
  if (savings < minSavingsTokens) {
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
    surfaceOp: {
      op: 'replace',
      start: seq,
      end: seq,
    },
    sourceEventSeqs: [seq],
  })

  return {
    ...freshPlan,
    pruneEventSeq: pruneEvent.seq,
    replaceEventSeq: repEvent.seq,
  }
}

/**
 * Recall original content from `session.events` by recursively expanding `sourceEventSeqs`
 * to `surfaceOp === 'append'` leaves.
 */
export function executeRecall(session, args = {}) {
  const target = String(args.target ?? '').trim()
  if (!target) throw new Error('target is required (e.g. "@call:<callId>", "@span:S<min>-<max>", "@turn:<N>", or event seq)')

  const events = session.events
  const logInfo = inspectSessionLog(session)
  const rootSeqs = []

  const callMatch = /^(?:@?call:)(.+)$/i.exec(target)
  const spanMatch = /^(?:@?span:)?S?(\d+)\s*-\s*S?(\d+)$/i.exec(target)
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
    for (let s = minSeq; s <= Math.min(maxSeq, events.length - 1); s++) {
      const ev = events[s]
      if (ev && ev.surfaceOp !== undefined) rootSeqs.push(s)
    }
    if (rootSeqs.length === 0) throw new Error(`no surface events found in range S${minSeq}-${maxSeq}`)
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
  if (spanMatch) {
    const minSeq = Number(spanMatch[1])
    const maxSeq = Number(spanMatch[2])
    leafSeqs = leafSeqs.filter((s) => s >= minSeq && s <= maxSeq)
  }

  if (leafSeqs.length === 0) {
    throw new Error(`no original append-surface leaf events found for target "${target}"`)
  }

  const fullText = leafSeqs.map((seq) => extractEventText(events[seq], logInfo.callMap)).join('\n\n---\n\n')
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
 * Inspect the current open step's `assistant/message` in `session.events` to determine
 * whether `conclude_turn: true` is safe to execute (`exec.concludeTurn()`).
 *
 * Only counts `type === 'text'` blocks (ignores `reasoning`/`thinking`/`tool-call`).
 * Falls back to `canConclude: false` when the assistant message cannot be located
 * or when the same step contains other tool calls.
 */
export function checkConcludeTurnEligibility(session, exec) {
  const events = session?.events
  if (!Array.isArray(events) || events.length === 0) {
    return { canConclude: false, reason: 'no-assistant-message', assistantText: '' }
  }

  const activeCallId = typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : undefined
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
      }
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
  if (toolCallBlocks.length > 1) {
    return { canConclude: false, reason: 'other-tool-calls', assistantText: '' }
  }
  if (toolCallBlocks.length === 1 && activeCallId) {
    const blockId = toolCallBlocks[0]?.id
    if (typeof blockId === 'string' && blockId.length > 0 && blockId !== activeCallId && blockId !== rootCallId) {
      return { canConclude: false, reason: 'other-tool-calls', assistantText: '' }
    }
  }
  for (const cid of stepToolCallIds) {
    if (activeCallId) {
      if (cid !== activeCallId && cid !== rootCallId) {
        return { canConclude: false, reason: 'other-tool-calls', assistantText: '' }
      }
    } else if (stepToolCallIds.size > 1) {
      return { canConclude: false, reason: 'other-tool-calls', assistantText: '' }
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
  const aFrom = String(a.from ?? '').trim()
  const aTo = String(a.to ?? '').trim()
  const bFrom = String(b.from ?? '').trim()
  const bTo = String(b.to ?? '').trim()
  if (aFrom && aTo && aFrom === bFrom && aTo === bTo) return true
  if (a.resolvedFrom && a.resolvedTo && b.resolvedFrom && b.resolvedTo && a.resolvedFrom === b.resolvedFrom && a.resolvedTo === b.resolvedTo) {
    return true
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
    const ev = session.events[seq]
    if (ev?.type === 'tool/result' && ev.data?.message?.source?.callId === rawCallId) {
      foundSeq = seq
      break
    }
  }

  if (foundSeq === -1) {
    // Check if this callId ever had a tool/result in session.events (if so, a span already shadowed it)
    const existedInLog = session.events.some(
      (ev) => ev?.type === 'tool/result' && ev.data?.message?.source?.callId === rawCallId
    )
    if (existedInLog) {
      return { compacted: true, reason: 'shadowed-by-span' }
    }
    return { compacted: false, seq: -1 }
  }

  if (shadowedBySpans && shadowedBySpans.has(foundSeq)) {
    return { compacted: true, reason: 'shadowed-by-span' }
  }

  const surfaceEvent = session.events[foundSeq]
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
  const events = session.events

  const compactedSurfaceSeqs = surfaceNodes.filter((seq) => {
    const ev = events[seq]
    return Boolean(ev && ev.surfaceOp !== 'append')
  })

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

const stagedBySessionRegistry = new WeakMap()
const sessionMeasurementCacheRegistry = new WeakMap()
const watermarkLatchBySessionRegistry = new WeakMap()

/** 获取当前会话最近一次 compaction/* 事件的 seq（无压缩事件时为 -1），用于标识当前压缩周期。 */
function getLatestCompactionSeq(session) {
  const events = session?.events
  if (!Array.isArray(events)) return -1
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
  const key = `${session?.events?.length ?? 0}:${nodes.length}:${nodes[nodes.length - 1] ?? ''}`
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
 * - Counts only uncompacted nodes inside the compactable closed turn span (`turn:A..turn:B`) plus any
 *   uncompacted large single `tool/result >= 500t` outside the span.
 * - Right after compaction, `compactableTokens` drops to 0 (or below threshold), preventing false positives
 *   even when historical checkpoints + recent 5 turns occupy 70k+ tokens.
 */
export function inspectSoftWatermark(session, tokenMeter, options = {}) {
  const enabled = options?.softWatermarkEnabled !== false && options?.enabled !== false
  const softWatermarkTokens =
    typeof options?.softWatermarkTokens === 'number' && options.softWatermarkTokens > 0
      ? options.softWatermarkTokens
      : DEFAULT_SOFT_WATERMARK_TOKENS
  const softWatermarkTurns =
    typeof options?.softWatermarkTurns === 'number' && options.softWatermarkTurns > 0
      ? Math.floor(options.softWatermarkTurns)
      : DEFAULT_SOFT_WATERMARK_TURNS
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
  const surfaceNodes = session?.surface?.nodes ?? []
  const pricedBySeq = new Map()
  for (const n of measurement.nodes) pricedBySeq.set(n.seq, n.tokens)

  const staged = stagedBySessionRegistry.get(session)
  const stagedShadowedSeqs = new Set()
  const stagedCallIds = new Set()
  let stagedMaxSpanTurn = 0
  if (staged) {
    for (const sp of staged.spans) {
      if (Array.isArray(sp.shadowedSeqs)) {
        for (const s of sp.shadowedSeqs) stagedShadowedSeqs.add(s)
      }
      const toSel = String(sp.resolvedTo ?? sp.to ?? '').trim()
      const m = /^turn:\s*(\d+)$/i.exec(toSel)
      if (m) stagedMaxSpanTurn = Math.max(stagedMaxSpanTurn, Number(m[1]))
    }
    for (const cid of staged.results.keys()) {
      stagedCallIds.add(cid)
    }
  }

  let lastSpanCompactedTurn = stagedMaxSpanTurn
  let compactedBaselineTokens = 0
  const uncompactedEntries = []

  for (const seq of surfaceNodes) {
    const ev = session.events[seq]
    if (!ev) continue
    // dsh-system-prompt 持久化的动态上下文快照不是可压缩工作证据，跳过以避免反向抬升水位。
    if (ev.data?.source?.plugin === '@deepseek-ai/dsh-system-prompt') continue
    const tokens = pricedBySeq.get(seq) ?? 0
    const nt = resolveSurfaceNodeTurns(session, seq, logInfo)
    const callId = ev.type === 'tool/result' ? (ev.data?.message?.source?.callId ?? '') : ''
    const isSpanCheckpoint =
      ev.type === 'user/message' && (ev.surfaceOp !== 'append' || ev.data?.source?.plugin === 'compact')
    if (isSpanCheckpoint && nt.maxTurn > lastSpanCompactedTurn) {
      lastSpanCompactedTurn = nt.maxTurn
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

    uncompactedEntries.push({ seq, ev, tokens, nt, callId })
  }

  const uncompactedClosedTurnSet = new Set()
  for (const item of uncompactedEntries) {
    const t = item.nt.minTurn
    if (t > lastSpanCompactedTurn && t >= 1 && (logInfo.openTurn === null || t < logInfo.openTurn)) {
      uncompactedClosedTurnSet.add(t)
    }
  }

  const uncompactedClosedTurnNums = [...uncompactedClosedTurnSet].sort((a, b) => a - b)
  const uncompactedClosedTurns = uncompactedClosedTurnNums.length
  const splitIdx = Math.max(0, uncompactedClosedTurnNums.length - keepRecentTurns)
  const compactableSpanTurnNums = uncompactedClosedTurnNums.slice(0, splitIdx)
  const recentClosedTurnNums = uncompactedClosedTurnNums.slice(splitIdx)
  const compactableSpanTurnSet = new Set(compactableSpanTurnNums)
  const recentProtectedTurnSet = new Set(recentClosedTurnNums)
  if (logInfo.openTurn !== null) recentProtectedTurnSet.add(logInfo.openTurn)

  let spanCompactableTokens = 0
  let outsideSpanLargeResultTokens = 0
  let recentProtectedTokens = 0
  const candidateResults = []

  for (const item of uncompactedEntries) {
    const { seq, ev, tokens, nt, callId } = item
    const t = nt.minTurn
    const isClosed = t >= 1 && (logInfo.openTurn === null || t < logInfo.openTurn)

    if (compactableSpanTurnSet.has(t)) {
      spanCompactableTokens += tokens
    } else if (ev.type === 'tool/result' && tokens >= largeBlockTokens && callId && !logInfo.inFlightCalls.has(callId)) {
      outsideSpanLargeResultTokens += tokens
    } else if (recentProtectedTurnSet.has(t)) {
      recentProtectedTokens += tokens
    }

    if (ev.type === 'tool/result' && isClosed && callId && !logInfo.inFlightCalls.has(callId) && tokens > 0) {
      const toolName = logInfo.callMap.get(callId)?.name ?? 'tool'
      candidateResults.push({
        callId,
        toolName,
        turn: t,
        tokens,
        seq,
        inCompactableSpan: compactableSpanTurnSet.has(t),
        isLarge: tokens >= largeBlockTokens,
      })
    }
  }

  const compactableTokens = spanCompactableTokens + outsideSpanLargeResultTokens
  const compactableTurns = compactableSpanTurnNums.length

  const suggestedSpan =
    compactableSpanTurnNums.length > 0
      ? {
          from: `turn:${compactableSpanTurnNums[0]}`,
          to: `turn:${compactableSpanTurnNums[compactableSpanTurnNums.length - 1]}`,
          fromTurn: compactableSpanTurnNums[0],
          toTurn: compactableSpanTurnNums[compactableSpanTurnNums.length - 1],
          turns: compactableTurns,
          tokens: spanCompactableTokens,
        }
      : null

  const largeCandidates = candidateResults.filter((c) => c.isLarge)
  const poolForTop = largeCandidates.length > 0 ? largeCandidates : candidateResults
  poolForTop.sort((a, b) => (b.tokens !== a.tokens ? b.tokens - a.tokens : a.seq - b.seq))
  const topCandidates = poolForTop.slice(0, topCandidatesLimit).map(({ callId, toolName, turn, tokens, seq }) => ({
    callId,
    toolName,
    turn,
    tokens,
    seq,
  }))

  const tokenTriggered = compactableTokens >= softWatermarkTokens
  const turnTriggered =
    compactableTurns >= 1 && (compactableTurns >= softWatermarkTurns || uncompactedClosedTurns >= softWatermarkTurns)
  const triggered = Boolean(enabled && (tokenTriggered || turnTriggered))
  const reason = !enabled
    ? 'disabled'
    : tokenTriggered && turnTriggered
      ? 'both'
      : tokenTriggered
        ? 'tokens'
        : turnTriggered
          ? 'turns'
          : 'none'

  let hint = ''
  if (triggered) {
    const spanText = suggestedSpan ? `${suggestedSpan.from}..${suggestedSpan.to}` : '暂无'
    const topText =
      topCandidates.length > 0
        ? topCandidates.map((c) => `${c.callId}(${c.toolName},${c.tokens}t)`).join(', ')
        : '无(>=500t)'
    hint = `[context-compact 水位提醒: 待压缩池已达软水位（共 ${uncompactedClosedTurns} 轮未压缩）。请在本步调用工具（特别是派发长后台任务前，防 5 分钟缓存过期全额重算）或回复（配 conclude_turn:true）时顺手调用 context_compact，无需先调 inspect:true；summary 请用 ≤120 tokens 电报体（路径:行号+结论）以压低输出成本。建议已完成区间: ${spanText}；最大单条结果: ${topText}]`
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
    softWatermarkTokens,
    softWatermarkTurns,
    keepRecentTurns,
    suggestedSpan,
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
  watermarkLatchBySessionRegistry.set(session, {
    compactionSeq,
    hint: status.hint,
  })
  return status.hint
}

export function apply(ctx, config = {}) {
  const stagedBySession = stagedBySessionRegistry

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
    maxRetries = DEFAULT_MAX_FLUSH_RETRIES
  ) {
    const q = stagedBySession.get(session)
    if (!q || (q.spans.length === 0 && q.results.size === 0)) {
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

    const spansToRun = [...q.spans]
    const resultsToRun = [...q.results.values()]
    q.spans.length = 0
    q.results.clear()

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
            const ev = session.events[seq]
            return Boolean(ev && ev.type === 'user/message' && ev.surfaceOp !== 'append')
          })
          const compactedLeaves = new Set(resolveLeafSurfaceSeqs(session.events, compactedSeqs))
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
  }

  ctx.on('agent/turn-stopping', function (payload) {
    const signal = payload?.signal
    if (signal?.aborted) return
    const agent = payload?.agent ?? this?.agent
    const session = agent?.session
    if (!session) return
    const q = stagedBySession.get(session)
    if (!q || (q.spans.length === 0 && q.results.size === 0)) return
    if (signal?.aborted) return
    flushStagedCompactions(session, undefined, DEFAULT_MIN_SAVINGS_TOKENS, DEFAULT_MAX_FLUSH_RETRIES)
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      const q = stagedBySession.get(session)
      // Preserve staged queue when turn is aborted or when items remain queued for next-turn retry
      if (q && q.spans.length === 0 && q.results.size === 0 && q.dropped.length === 0) {
        stagedBySession.delete(session)
      }
    }
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
        const dir = buildLargeBlocksDirectory(session, sharedMeter, config)
        const hint = buildSoftWatermarkHint(session, sharedMeter, config)
        return [dir, hint].filter(Boolean).join('\n')
      } catch {
        return ''
      }
    },
  }), '@dsh-external/dsh-context-compact: systemPrompt.context')

  ctx.effect(() => ctx.tools.register({
    name: 'context_compact',
    description: 'Compact completed tool results (`results`: can compress completed returns from the current turn or earlier turns; staged until turn end by default) or earlier multi-turn spans (`spans`: cannot cover the current open turn) with a concise summary and lossless `@call`/`@span` recall tag. Staged until turn end by default (original text stays visible in this turn), or committed immediately when occupancy > 70% or `conclude_turn: true`（仅在同一条消息已写完最终回复时使用，用于省一次请求）.',
    parameters: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          description: 'Single tool-result compactions: [{ callId, summary }]. Can replace completed tool returns from the current turn or earlier turns (staged until turn end by default).',
          items: {
            type: 'object',
            properties: {
              callId: { type: 'string', description: 'Completed tool callId to compact (current turn or earlier turns)' },
              summary: { type: 'string', description: 'Concise conclusion preserving key paths/anchors' },
            },
            required: ['callId', 'summary'],
            additionalProperties: false,
          },
        },
        spans: {
          type: 'array',
          description: 'Multi-turn contiguous span compactions: [{ from, to, summary }]. Endpoints support "turn:N", "turnsBack:N", or "<callId>". Cannot cover the current open turn.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Start endpoint: turn:N, turnsBack:N, or callId (closed turns only)' },
              to: { type: 'string', description: 'End endpoint: turn:N, turnsBack:N, or callId (closed turns only)' },
              summary: { type: 'string', description: 'Structured checkpoint summary for the span' },
            },
            required: ['from', 'to', 'summary'],
            additionalProperties: false,
          },
        },
        conclude_turn: {
          type: 'boolean',
          description: 'When true, commits immediately and concludes the current turn (`exec.concludeTurn()`) — 仅在同一条消息已写完最终回复时使用，用于省一次请求（若当前助手消息无回复文字或同一步有其他工具调用，则只立即提交压缩、不结束本轮）.',
        },
        inspect: {
          type: 'boolean',
          description: 'When true, lists large surface blocks (>= 500 tokens) with callId, tool name, turn, and token count.',
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
          const ev = session.events[seq]
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
          resolvedFrom: sp.resolvedFrom,
          resolvedTo: sp.resolvedTo,
          summary: sp.summary,
          startSeq: sp.startSeq,
          endSeq: sp.endSeq,
          shadowedSeqs: sp.shadowedSeqs,
          leafSeqs: sp.leafSeqs,
          minLeaf: sp.minLeaf,
          maxLeaf: sp.maxLeaf,
          retries: 0,
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
        q.results.set(r.callId, { callId: r.callId, summary: r.summary, retries: 0 })
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
    description: 'Read-only lossless recall of original uncompacted content from `session.events` via recursive `sourceEventSeqs` expansion (supports nested compactions). Returns up to 120 lines per call with a continuation cursor.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Recall target: "@call:<callId>", "@span:S<start>-<end>", "@turn:<N>", or event seq',
        },
        query: {
          type: 'string',
          description: 'Optional substring or regex to filter lines within the recalled content',
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
}

export default { name, inject, apply }
