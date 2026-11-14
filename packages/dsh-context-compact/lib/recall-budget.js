/** Per-turn context_recall budget (v5 §7.2). Surface eviction is separate. */

const budgets = new WeakMap()

export function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    try { const events = session.snapshotEvents(); if (Array.isArray(events)) return events } catch {}
  }
  return Array.isArray(session?.events) ? session.events : []
}

export function recallTurnOf(session) {
  let turn = 0
  for (const ev of sessionEvents(session)) {
    const value = ev?.data?.turn ?? ev?.turn
    if (typeof value === 'number') turn = Math.max(turn, value)
  }
  return turn
}

export function isDelegatedRecallSession(session) {
  const header = session?.header || {}
  return Boolean(header.parentSession || session?.parentSession || session?.meta?.parentSession || (header.delegationDepth ?? 0) > 0)
}

export function takeRecallSlot(session, args = {}, options = {}) {
  const delegated = isDelegatedRecallSession(session)
  const limit = delegated ? (options.delegatedPerTurn ?? 4) : (options.perTurn ?? 2)
  const turn = recallTurnOf(session)
  let state = session ? budgets.get(session) : null
  if (!state || state.turn !== turn) {
    state = { turn, calls: 0, seen: new Set() }
    if (session) budgets.set(session, state)
  }
  const key = `${args.target || ''}|${JSON.stringify(args.line_range ?? null)}`
  if (state.seen.has(key)) return { ok: false, duplicate: true, text: `已在上下文中：${args.target || ''}` }
  if (state.calls >= limit) {
    return { ok: false, code: 'DSH_E_RECALL_BUDGET', text: `DSH_E_RECALL_BUDGET 本轮 recall 已用 ${state.calls}/${limit}。请改读摘要里的「未完成事项」「锚点」，或等下一轮。` }
  }
  state.calls += 1
  state.seen.add(key)
  return { ok: true, calls: state.calls, limit }
}

/** Numeric per-turn cap only. The ledger, not this function, refuses duplicate keys (C-35). */
export function chargeRecallSlot(session, options = {}) {
  const delegated = isDelegatedRecallSession(session)
  const limit = delegated ? (options.delegatedPerTurn ?? 4) : (options.perTurn ?? 2)
  const turn = recallTurnOf(session)
  let state = session ? budgets.get(session) : null
  if (!state || state.turn !== turn) {
    state = { turn, calls: 0, seen: new Set() }
    if (session) budgets.set(session, state)
  }
  if (state.calls >= limit) {
    return { ok: false, code: 'DSH_E_RECALL_BUDGET', text: `DSH_E_RECALL_BUDGET 本轮 recall 已用 ${state.calls}/${limit}。请改读摘要里的「未完成事项」「锚点」，或等下一轮。` }
  }
  state.calls += 1
  return { ok: true, calls: state.calls, limit }
}

export function capRecallText(text, maxTokens = 2000, estimateTokens = defaultEstimateRecallTokens) {
  const raw = String(text || '')
  const budget = Number.isFinite(Number(maxTokens)) ? Math.max(0, Math.floor(Number(maxTokens))) : 2000
  const measure = typeof estimateTokens === 'function' ? estimateTokens : defaultEstimateRecallTokens
  const fullTokens = measure(raw)
  if (fullTokens <= budget) return { text: raw, truncated: false, tokens: fullTokens }
  if (budget <= 0) return { text: '', truncated: true, tokens: 0 }
  // C-18: pre-cut to a codepoint bound before binary search (cheap upper bound).
  const cps = Array.from(raw.length > budget * 16 ? raw.slice(0, budget * 16) : raw)
  const marker = `\n[truncated at ${budget} tokens; continue with line_range]`
  const markerTokens = measure(marker)
  if (markerTokens >= budget) {
    const sliced = cps.slice(0, Math.max(1, budget * 2)).join('')
    return { text: sliced, truncated: true, tokens: measure(sliced) }
  }
  let lo = 0
  let hi = cps.length
  let best = ''
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const candidate = `${cps.slice(0, mid).join('')}${marker}`
    if (measure(candidate) <= budget) { best = cps.slice(0, mid).join('') ; lo = mid + 1 } else { hi = mid - 1 }
  }
  // C-18: shrink by 10% steps while still over budget.
  let out = `${best}${marker}`
  while (measure(out) > budget && best.length > 0) {
    best = Array.from(best).slice(0, Math.floor(best.length * 0.9)).join('')
    out = `${best}${marker}`
  }
  const lastNl = best.lastIndexOf('\n')
  const snapped = lastNl >= Math.floor(best.length * 0.8) ? best.slice(0, lastNl) : best
  const finalText = `${snapped}${marker}`
  return { text: finalText, truncated: true, tokens: measure(finalText) }
}

export function defaultEstimateRecallTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  const ascii = s.length - nonAscii
  return Math.ceil(nonAscii * 0.7 + ascii * 0.25) + 4
}

export function recallEvictStub(target) {
  return `[recall evicted: ${target || '@span'} → 再次 recall 可取回]`
}

/** Surface stub only. The original text stays on the block so the log can still be recalled (I-R3). */
export function evictRecallBlock(block, stub) {
  if (!block || typeof block.text !== 'string' || block.text.startsWith('[recall evicted:')) return false
  if (typeof block.recallArchive !== 'string') block.recallArchive = block.text
  block.text = stub
  return true
}

const rebound = new WeakMap()

/** Remember the turn an autonomous compact landed, so the next turn's recalls can be scored. */
export function markAutoCompactSample(session, turn) {
  if (!session) return null
  const row = rebound.get(session) || { misses: [] }
  row.pendingTurn = turn
  row.recalls = 0
  rebound.set(session, row)
  return row
}

/** §7.3: two or more recalls on the turn after an @auto compact count as one extraction miss. */
export function noteRecallRebound(session, turn, line) {
  const row = session ? rebound.get(session) : null
  if (!row || row.pendingTurn == null || !(turn > row.pendingTurn)) return row
  row.recalls += 1
  if (row.recalls === 2) row.misses.push({ turn, line: String(line || '').slice(0, 200) })
  return row
}

/**
 * Recall rows whose turn has already closed. The caller applies the stub only while PMW is open,
 * so a hot cache keeps the original surface.
 */
export function closedRecallResults(events) {
  const closed = new Set()
  let openTurn = null
  for (const ev of events || []) {
    if (ev?.type === 'turn/end' && typeof ev.data?.turn === 'number') closed.add(ev.data.turn)
    if (ev?.type === 'turn/start' && typeof ev.data?.turn === 'number') openTurn = ev.data.turn
  }
  const out = []
  for (const ev of events || []) {
    if (ev?.type !== 'tool/result') continue
    const name = ev.data?.name || ev.data?.message?.toolName
    if (name !== 'context_recall') continue
    const turn = ev.data?.turn ?? ev.turn
    if (typeof turn !== 'number' || turn === openTurn || !closed.has(turn)) continue
    const target = ev.data?.target || ev.data?.message?.source?.target || '@span'
    out.push({ event: ev, stub: recallEvictStub(target) })
  }
  return out
}

// ---------------------------------------------------------------------------
// v5 Round 4: full-argument recall key, per-turn ledger, digests, route pricing.
// ---------------------------------------------------------------------------

/** Normalize `target|query|line_range|context_lines|mode` into the canonical recall key (C-36). */
export function normalizeRecallKey(args = {}) {
  let target = String(args.target ?? '').trim()
  const turnsSuffix = /\s+turns:[\d,..-]+$/i
  target = target.replace(turnsSuffix, '')
  const m = /^@?span:s(\d+)-s?(\d+)(?:\+s\d+-s?\d+)*$/i.exec(target)
  const lower = target.toLowerCase()
  let normalized = lower.replace(/^@?call:/, '@call:').replace(/^@?turn:/, '@turn:')
  if (/^@?(?:all|search|index)$/.test(normalized)) normalized = '@index'
  if (/^@topic:([a-z0-9_,-]+)$/i.test(normalized)) {
    const names = normalized.replace(/^@topic:/i, '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).sort()
    normalized = `@topic:${names.join(',')}`
  }
  const q = typeof args.query === 'string' ? args.query : ''
  const lr = Array.isArray(args.line_range) ? `${Math.floor(Number(args.line_range[0]) || 0)}:${Math.floor(Number(args.line_range[1]) || 0)}` : ''
  const ctx = typeof args.context_lines === 'number' ? String(Math.floor(args.context_lines)) : ''
  const modeRaw = String(args.mode ?? 'full')
  const mode = modeRaw === 'summaries_only' ? 'summaries_only' : 'full'
  return `${normalized}|q=${q}|lr=${lr}|ctx=${ctx}|m=${mode}`
}

const RECALL_FOLDED_RE = /^\[Compact-Recall-(?:Digest\b|Evicted\])/

/**
 * Replay-safe per-turn recall ledger derived from events + surface (C-36).
 * Returns { state, text?, digestText? } — refusal text starts with `[Recall-Gate `.
 */
export function evaluateRecallGate(session, args = {}, options = {}) {
  const events = sessionEvents(session)
  const key = normalizeRecallKey(args)
  const openTurn = currentOpenTurn(events)
  const callMap = new Map()
  for (const ev of events) {
    if (ev?.type === 'tool/call' && ev.data?.name === 'context_recall') {
      const a = typeof ev.data?.arguments === 'string' ? safeParse(ev.data.arguments) : (ev.data?.arguments ?? {})
      callMap.set(ev.data.callId, { key: normalizeRecallKey(a ?? {}), turn: ev.data.turn ?? 0, refused: false })
    }
  }
  const inFlightSet = options.inFlight ?? new Set()
  const served = []
  for (const ev of events) {
    if (ev?.type !== 'tool/result') continue
    const cid = ev.data?.message?.source?.callId
    const call = callMap.get(cid)
    if (!call || call.key !== key) continue
    const text = resultText(ev)
    if (isErrorResult(ev) || text.startsWith('[Recall-Gate ')) { call.refused = true ; continue }
    served.push({ ev, folded: RECALL_FOLDED_RE.test(text), turn: call.turn, onSurface: isOnSurface(session, ev.seq), text })
  }

  const flightKey = `${openTurn}:${key}`
  const rawOnSurface = served.some((s) => !s.folded && s.onSurface)
  const pending = served.length === 0 && recallPendingHas(session, flightKey)
  if (rawOnSurface || inFlightSet.has(flightKey) || pending) {
    return { state: 'raw', ok: false, text: `[Recall-Gate raw] 已在上下文中：${String(args.target ?? '')}（本层级已可见，无需重复取回）` }
  }
  const openServed = served.filter((s) => s.turn === openTurn)
  let decision
  if (openServed.length === 1) decision = { state: 'folded', ok: true, pin: true }
  else if (openServed.length >= 2) {
    const digestText = openServed.find((s) => s.folded)?.text || buildRecallBreadcrumbDigest(openServed.at(-1)?.text ?? '', args, {})
    return { state: 'refetched', ok: false, text: `[Recall-Gate refetched] ${digestText}\nnarrow with \`query\` or \`line_range\`` }
  } else decision = { state: 'fresh', ok: true }
  if (decision.ok && options.recallBudget === true) {
    const slot = chargeRecallSlot(session, options)
    if (!slot.ok) return { state: 'budget', ok: false, text: `[Recall-Gate ${slot.text}` }
  }
  return decision
}

const pendingServed = new WeakMap()
const refusalCounts = new WeakMap()

/** Same key the gate and the in-flight set share (C-37). */
export function recallFlightKey(session, args = {}) {
  return `${currentOpenTurn(sessionEvents(session))}:${normalizeRecallKey(args)}`
}

export function markRecallPending(session, flightKey) {
  if (!session || !flightKey) return
  let set = pendingServed.get(session)
  if (!set) { set = new Set(); pendingServed.set(session, set) }
  set.add(flightKey)
}

function recallPendingHas(session, flightKey) {
  return pendingServed.get(session)?.has(flightKey) === true
}

function clearRecallPending(session, flightKey) {
  pendingServed.get(session)?.delete(flightKey)
}

export const RECALL_LOOP_LINE = '[Recall-Gate DSH_E_RECALL_LOOP] use the digests above or change query/line_range'

/** Count refusals in the open turn. The 4th and later are the loop line (C-37). */
export function noteRecallRefusal(session) {
  if (!session) return 1
  const turn = currentOpenTurn(sessionEvents(session))
  let state = refusalCounts.get(session)
  if (!state || state.turn !== turn) state = { turn, count: 0 }
  state.count += 1
  refusalCounts.set(session, state)
  return state.count
}

function safeParse(raw) { try { return JSON.parse(raw) } catch { return {} } }
function currentOpenTurn(events) {
  let open = null
  for (const ev of events || []) {
    if (ev?.type === 'turn/start' && typeof ev.data?.turn === 'number') open = ev.data.turn
    if (ev?.type === 'turn/end' && typeof ev.data?.turn === 'number') open = null
  }
  return open
}
function resultText(ev) {
  const blocks = Array.isArray(ev.data?.message?.content?.[0]?.content) ? ev.data.message.content[0].content : ev.data?.message?.content
  return (Array.isArray(blocks) ? blocks : []).map((b) => (b?.type === 'text' ? b.text : '')).join('\n')
}
function isErrorResult(ev) {
  return Boolean(ev.data?.isError === true || ev.data?.message?.isError === true)
}
function isOnSurface(session, seq) {
  return (session?.surface?.nodes ?? []).includes(seq)
}

/** Per-session in-memory recall meta capture (R2.3.4 #6; I-P1: memory only). */
const recallMeta = new WeakMap()
export function recordRecallCallMeta(session, callId, meta) {
  if (!session || !callId) return
  let per = recallMeta.get(session)
  if (!per) { per = new Map() ; recallMeta.set(session, per) }
  per.set(callId, meta)
}
export function getRecallCallMeta(session, callId) {
  return recallMeta.get(session)?.get(callId) ?? null
}

/** Deterministic <=160-token breadcrumb digest (C-34). */
export function buildRecallBreadcrumbDigest(rawText, args, meta = {}, maxTokens = 160, estimateTokens = defaultEstimateRecallTokens) {
  const q = (v) => JSON.stringify(String(v ?? '').slice(0, 80))
  const target = meta.target ?? args?.target ?? ''
  const query = meta.query ?? args?.query
  const lines = String(rawText ?? '').split(/\r?\n/).map((line) => line.replace(/\[recall:/g, '[rc:'))
  if (!meta.firstLine || !meta.lastLine) {
    const parsed = /^\[Recall\s+.*?\|\s*(?:leaves:\s*(?<leaves>[^|]+)\s*\|\s*)?lines:\s*(?<first>\d+)-(?<last>\d+)\s+of\s+(?<total>\d+)\]/.exec(lines[0] ?? '')
    if (parsed?.groups) {
      meta = {
        ...meta,
        firstLine: Number(parsed.groups.first), lastLine: Number(parsed.groups.last), totalLines: Number(parsed.groups.total),
        leafSeqs: meta.leafSeqs?.length ? meta.leafSeqs : (parsed.groups.leaves?.match(/S(\d+)/g)?.map((s) => Number(s.slice(1))) ?? []),
      }
    }
  }
  const totalLines = Number(meta.totalLines ?? 0)
  const first = Number(meta.firstLine ?? 0)
  const last = Number(meta.lastLine ?? 0)
  const leafSeqs = Array.isArray(meta.leafSeqs) ? meta.leafSeqs : []
  const turns = meta.turnsLabel ?? ''
  const stageHeaders = Array.isArray(meta.stageHeaders) ? meta.stageHeaders : []
  const matcher = typeof query === 'string' && query ? (() => { try { return new RegExp(query, 'i') } catch { return null } })() : null
  const matched = []
  for (let i = 0; i < lines.length && matched.length < 12; i++) if (matcher && matcher.test(lines[i])) matched.push(`L${i + 1}`)
  const keyLines = []
  for (let i = 0; i < lines.length && keyLines.length < 3; i++) {
    const line = lines[i].replace(/^\[\d+\]\s*/, '')
    if (matcher && matcher.test(line)) keyLines.push(`L${i + 1}: ${line.slice(0, 65)}`)
    else if (/FAIL|PASS|error|fix|决定/i.test(line) && line.trim()) keyLines.push(`L${i + 1}: ${line.slice(0, 65)}`)
  }
  if (!keyLines.length && lines.length) {
    const firstContent = lines.find((l) => l.trim() && !l.startsWith('[')) ?? lines[0]
    const lastContent = lines.at(-1) ?? ''
    keyLines.push(`L1: ${String(firstContent).slice(0, 65)}`)
    if (lines.length > 1) keyLines.push(`L${lines.length}: ${String(lastContent).slice(0, 65)}`)
  }

  const header = `[Compact-Recall-Digest target=${q(target)}${query ? ` query=${q(query)}` : ''}${first ? ` lines=${first}-${last}/${totalLines}` : ''}${matched.length ? ` hits=${matched.length}` : ''}${turns ? ` turns=${turns}` : ''} folded_at=step:${meta.step ?? '?'}]`
  const body = [
    matched.length ? `matched: ${matched.join(' ')}` : '',
    stageHeaders.length ? `stages: ${stageHeaders.slice(0, 4).join(' ; ')}` : '',
    leafSeqs.length ? `anchors: ${leafSeqs.slice(0, 4).map((s) => `S${s}`).join(', ')}` : '',
    keyLines.length ? `key: ${keyLines.join(' | ').slice(0, 180)}` : '',
    `next: ${meta.nextLineRange ? `line_range [${meta.nextLineRange[0]},${meta.nextLineRange[1]}] not yet read` : 'end of content'} | already read: [${first || 1},${last || Math.max(1, lines.length)}]`,
  ].filter(Boolean).join('\n')
  let text = `${header}\n${body}`
  let textTokens = estimateTokens(text)
  while (textTokens > maxTokens && text.length > 40) {
    text = text.slice(0, Math.floor(text.length * 0.9))
    textTokens = estimateTokens(text)
  }
  return text
}

/** Route cache-pricing resolver (R3.3.2). */
export function resolveRouteCachePricing(session, config = {}) {
  const hdr = typeof session?.requestHeader === 'function' ? session.requestHeader()?.config : null
  const provider = String(hdr?.provider ?? session?.header?.provider ?? '').trim().toLowerCase()
  const model = String(hdr?.model ?? session?.header?.model ?? '').trim().toLowerCase()
  const routeKey = `${provider}/${model}`
  const custom = config?.routeCachePricing?.[routeKey] ?? config?.routeCachePricing?.[model] ?? config?.routeCachePricing?.[provider]
  let r = 0.10
  let w = 1.00
  if (custom && typeof custom === 'object') {
    if (typeof custom.r === 'number' && custom.r > 0 && custom.r <= 1) r = custom.r
    if (typeof custom.w === 'number' && custom.w >= r) w = custom.w
  } else if (/glm-5\.3-flash/.test(model)) {
    r = 1.00 ; w = 1.00
  } else if (/claude|anthropic|fable/.test(provider) || /claude|fable/.test(model)) {
    r = 0.10 ; w = 1.25
  } else if (/gemini/.test(model) || (/vertex/.test(provider) && !/claude/.test(model))) {
    r = 0.25 ; w = 1.00
  } else if (/openai/.test(provider) || /^(?:gpt-|o[134](?:$|-))/.test(model)) {
    r = 0.50 ; w = 1.00
  } else if (/deepseek-v4\.1-flash/.test(model)) {
    r = 0.25 ; w = 1.00
  }
  if (typeof config?.cacheHitRatio === 'number' && config.cacheHitRatio > 0 && config.cacheHitRatio <= 1) r = config.cacheHitRatio
  if (typeof config?.cacheMissRatio === 'number' && config.cacheMissRatio >= r) w = config.cacheMissRatio
  return { r, w, provider, model }
}
