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

export function capRecallText(text, maxTokens = 2000) {
  const raw = String(text || '')
  const budget = Number.isFinite(Number(maxTokens)) ? Math.max(0, Math.floor(Number(maxTokens))) : 2000
  const limitChars = budget * 4
  if (raw.length <= limitChars) return { text: raw, truncated: false }
  if (limitChars <= 0) return { text: '', truncated: true }
  const marker = `\n[truncated at ${budget} tokens; continue with line_range]`
  if (marker.length >= limitChars) return { text: marker.slice(0, limitChars), truncated: true }
  return { text: `${raw.slice(0, limitChars - marker.length)}${marker}`, truncated: true }
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
