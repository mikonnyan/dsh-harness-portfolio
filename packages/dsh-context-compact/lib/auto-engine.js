/**
 * Autonomous compaction cost model (v5 §5). Pure: no session mutation.
 * D* = R(w - c) / [(N - 1)*c*(1 - rho) + c - w*rho]
 */

export const DEFAULT_CACHE_HIT_RATIO = 0.1
export const DEFAULT_CACHE_MISS_RATIO = 1
export const DEFAULT_RHO = 0.05
export const AUTO_ENGINE_HYSTERESIS = 1.15
export const DEFAULT_MIN_INTERVAL_REQUESTS = 3

export function breakEvenD(R, N, c = DEFAULT_CACHE_HIT_RATIO, w = DEFAULT_CACHE_MISS_RATIO, rho = DEFAULT_RHO) {
  const denom = (N - 1) * c * (1 - rho) + c - w * rho
  if (!(R > 0) || !(denom > 0)) return Infinity
  return (R * (w - c)) / denom
}

export function estimateContinueP(gapsMs, cacheExpiryMs) {
  const recent = (Array.isArray(gapsMs) ? gapsMs : []).slice(-10).filter((n) => typeof n === 'number')
  if (!recent.length) return 1
  return recent.filter((gap) => gap < cacheExpiryMs).length / recent.length
}

/** EWMA of request/header counts per turn, plus the recent gap ratio inside the cache window. */
export function observeRequestStats(events, cacheExpiryMs = 300000) {
  const counts = []
  const stamps = []
  let turn = null
  let count = 0
  const flush = () => { if (turn != null) counts.push(count) }
  for (const ev of events || []) {
    if (ev?.type !== 'request/header') continue
    const next = ev.data?.turn
    const ts = ev.ts ?? ev.timestamp ?? ev.time ?? ev.data?.time
    if (turn == null || next !== turn) {
      flush()
      turn = next
      count = 0
      if (typeof ts === 'number') stamps.push(ts)
    }
    count += 1
  }
  flush()
  let ewma = 1
  for (const n of counts) ewma = 0.3 * n + 0.7 * ewma
  const gapsMs = []
  for (let i = 1; i < stamps.length; i++) gapsMs.push(stamps[i] - stamps[i - 1])
  const recent = gapsMs.slice(-10)
  return { reqPerTurnEwma: counts.length ? ewma : 1, gapsMs: recent, continueP: estimateContinueP(recent, cacheExpiryMs) }
}

export function estimateN(reqPerTurnEwma = 1, continueP = 1) {
  const n = (Number(reqPerTurnEwma) || 1) * (Number.isFinite(continueP) ? continueP : 1)
  return Math.min(30, Math.max(1, n))
}

/**
 * @returns {{ compact: boolean, rule: 'A'|'B'|'C'|null, D: number, Dstar: number, N: number, idleMs: number }}
 */
export function decideAutoCompact(input = {}) {
  const c = input.c ?? DEFAULT_CACHE_HIT_RATIO
  const w = input.w ?? DEFAULT_CACHE_MISS_RATIO
  const rho = input.rho ?? DEFAULT_RHO
  const D = Math.max(0, input.D || 0)
  const R = Math.max(0, input.R || 0)
  const N = estimateN(input.N ?? input.reqPerTurnEwma ?? 1, input.continueP ?? 1)
  const idleMs = input.idleMs ?? 0
  const cacheExpiryMs = input.cacheExpiryMs ?? 300_000
  const minSavings = input.minSavings ?? 300
  const hysteresis = input.hysteresis ?? AUTO_ENGINE_HYSTERESIS
  const surfaceTokens = input.surfaceTokens ?? 0
  const tierCliffTokens = input.tierCliffTokens ?? 180_000
  const Dstar = breakEvenD(R, N, c, w, rho)
  const base = { D, Dstar, N, idleMs, rho }
  if (tierCliffTokens > 0 && surfaceTokens >= tierCliffTokens) return { ...base, compact: true, rule: 'C' }
  const cold = input.cold === true || (input.lastModelActivityMs > 0 && idleMs >= cacheExpiryMs)
  if (cold && (1 - rho) * D >= minSavings) return { ...base, compact: true, rule: 'A' }
  if (Number.isFinite(Dstar) && D > hysteresis * Dstar) return { ...base, compact: true, rule: 'B' }
  return { ...base, compact: false, rule: null }
}

const states = new WeakMap()
export function autoCompactState(session) {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) {
    return { rhoEwma: DEFAULT_RHO, reqPerTurnEwma: 1, gapsMs: [], lastAutoAtRequest: -999, failures: new Map(), lastDecision: null, requests: 0 }
  }
  let state = states.get(session)
  if (!state) {
    state = { rhoEwma: DEFAULT_RHO, reqPerTurnEwma: 1, gapsMs: [], lastAutoAtRequest: -999, failures: new Map(), lastDecision: null, requests: 0 }
    states.set(session, state)
  }
  return state
}

export function noteAutoFailure(session, key = 'auto') {
  const state = autoCompactState(session)
  state.failures.set(key, (state.failures.get(key) || 0) + 1)
  return state.failures.get(key)
}

export function autoFailures(session, key = 'auto') {
  return autoCompactState(session).failures.get(key) || 0
}
