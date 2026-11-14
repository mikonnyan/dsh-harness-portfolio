/**
 * lib/topic-index.js — v5 Round 4 checkpoint index, tree walk, tier parsing,
 * @topics catalog and summary-tier recall (C-09..C-14, C-19).
 * Read-only: zero session.append, zero event mutation (I-P1 / C-12).
 */

import {
  TOPIC_SLUG_RE, SPAN_CLOSE_TAG_RE, COMPACT_HEADER_TOKEN_RE, MAX_TOPICS_PER_SPAN,
  parseHeaderTopics, normalizeTopicName, resolveCheckpointTopics, rulesHashOfConfig,
} from './topics.js'
import { stripTopicTimeline } from './coalesce.js'

const indexEventCache = new WeakMap()
function isSummaryCheckpoint(ev) {
  return Boolean(ev?.type === 'user/message' && ev.surfaceOp !== 'append'
    && (ev.data?.source?.kind === 'compact-checkpoint'
      || (ev.data?.source?.kind === 'plugin' && ev.data.source.plugin === 'compact')))
}

function isElided(ev) {
  return Boolean(ev?.type === 'user/message' && ev.surfaceOp !== 'append'
    && (ev.data?.source?.kind === 'context-compact-elide'
      || (ev.data?.source?.kind === 'plugin' && ev.data.source.plugin === 'context-compact-elide')))
}

function leavesOf(events, seqs, visited = new Set()) {
  const leaves = new Set()
  const stack = [...seqs]
  while (stack.length) {
    const seq = stack.pop()
    if (typeof seq !== 'number' || visited.has(seq)) continue
    visited.add(seq)
    const ev = events[seq]
    if (!ev) continue
    if (isElided(ev)) continue
    if (ev.surfaceOp === 'append') { leaves.add(seq) ; continue }
    if (Array.isArray(ev.sourceEventSeqs) && ev.sourceEventSeqs.length) {
      for (const s of ev.sourceEventSeqs) if (!visited.has(s)) stack.push(s)
    }
  }
  return [...leaves].sort((a, b) => a - b)
}

function ownHullTag(text) {
  const matches = [...String(text ?? '').matchAll(SPAN_CLOSE_TAG_RE)]
  return matches.length ? matches[matches.length - 1].groups?.tag ?? matches.at(-1)[0] : null
}

/** Remove the `## Topic Timeline` block (C-24) — line range from heading to last `- T`/`[+` row. */
export { stripTopicTimeline }

/** Minimal Tier-3 parser (C-14): only when events are missing; ranges must lie in the hull. */
export function parseEmbeddedStagesMinimal(summaryText, enclosingHullSet, checkpointSeq = -1) {
  const text = String(summaryText ?? '')
  const hull = enclosingHullSet instanceof Set ? enclosingHullSet : new Set()
  const stages = []
  const headerMatches = [...text.matchAll(COMPACT_HEADER_TOKEN_RE)]
  const closeMatches = [...text.matchAll(SPAN_CLOSE_TAG_RE)]
  // Pair each non-carried header with the next close tag after it.
  for (let i = 0; i < headerMatches.length; i++) {
    const header = headerMatches[i]
    if (header.groups?.carried) continue
    const headerEnd = header.index + header[0].length
    const close = closeMatches.find((m) => m.index >= headerEnd)
    if (!close) continue
    const ranges = [...close.groups.ranges.matchAll(/S(\d+)-(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
    if (!ranges.length) continue
    const inHull = ranges.every(([a, b]) => {
      if (a > b) return false
      for (let leaf = a; leaf <= b; leaf++) if (!hull.has(leaf)) return false
      return true
    })
    if (!inHull) continue // F5 spoof guard: injected ranges outside the hull are dropped
    const stageText = text.slice(headerEnd, close.index).trim()
    stages.push({
      stageKey: ranges.map(([a, b]) => `S${a}-${b}`).join('+'),
      checkpointSeq,
      enclosingEpochTag: null,
      level: 'L0',
      provenance: 'text',
      minLeafSeq: ranges[0][0],
      maxLeafSeq: ranges.at(-1)[1],
      leafSeqs: ranges.flatMap(([a, b]) => { const out = [] ; for (let s = a ; s <= b ; s++) if (hull.has(s)) out.push(s) ; return out }),
      turns: close.groups?.turns ?? header.groups?.turns ?? '',
      topics: header.groups?.topics ? String(header.groups.topics).split(',').map(normalizeTopicName).filter(Boolean) : [],
      ownText: stageText ? `${stageText} (reconstructed)` : '(reconstructed)',
      rawRecallTag: close.groups?.tag ?? null,
    })
  }
  return stages
}

/** Build the read-only checkpoint index (C-09). Cached per (session, logLength, replaceGeneration, rulesHash). */
export function buildCheckpointIndex(session, eventsArg = null, logInfoArg = null, config = {}) {
  const events = eventsArg ?? (typeof session?.snapshotEvents === 'function' ? safeSnapshot(session) : (session?.events ?? []))
  const logInfo = logInfoArg
  const logLen = typeof session?.seq === 'number' ? session.seq : (events?.length ?? 0)
  const replaceGen = session?.surface?.replaceGeneration ?? 0
  const hash = rulesHashOfConfig(config)
  const lastEventSeq = events?.at(-1)?.seq ?? -1
  const perEvents = indexEventCache.get(events) ?? new Map()
  indexEventCache.set(events, perEvents)
  let perSession = perEvents.get(session) ?? new Map()
  perEvents.set(session, perSession)
  const key = `${logLen}:${lastEventSeq}:${replaceGen}:${hash}`
  const cached = perSession.get(key)
  if (cached) return cached

  const surfaceNodes = session?.surface?.nodes ?? []
  const surfaceSet = new Set(surfaceNodes)
  const records = []
  const seenLeafSets = new Map()

  const walk = (checkpointEv, enclosingEpochTag) => {
    if (!checkpointEv) return
    const childSeqs = (checkpointEv.sourceEventSeqs ?? []).filter((s) => {
      const ev = events[s]
      return Boolean(ev && ev.surfaceOp !== undefined && isSummaryCheckpoint(ev))
    })
    const ownLeavesAll = leavesOf(events, [checkpointEv.seq])
    const childLeaves = new Set()
    const childEvents = []
    for (const s of childSeqs) {
      const ev = events[s]
      childEvents.push(ev)
      for (const leaf of leavesOf(events, [s])) childLeaves.add(leaf)
    }
    // Dedup by sorted leaf set, highest seq wins (C-09 rule 5).
    const ownLeaves = ownLeavesAll.filter((s) => !childLeaves.has(s))
    const leafSetKey = ownLeavesAll.join(',')
    const prior = seenLeafSets.get(leafSetKey)
    if (prior !== undefined && prior >= checkpointEv.seq) return
    seenLeafSets.set(leafSetKey, checkpointEv.seq)

    const text = typeof checkpointEv.data?.summary === 'string'
      ? checkpointEv.data.summary
      : (checkpointEv.data?.content ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    const stripped = stripTopicTimeline(text)
    const summarySeq = checkpointEv.sourceEventSeqs?.[1]
    const summaryEvent = events[summarySeq]?.type === 'compaction/summary' ? events[summarySeq] : null
    const levelMeta = summaryEvent?.data?.level
    const hullTag = ownHullTag(stripped)
    const enclosingHull = enclosingEpochTag

    const record = {
      stageKey: leafSetKey || hullTag || '',
      checkpointSeq: checkpointEv.seq,
      enclosingEpochTag,
      level: levelMeta ?? (levelFromText(stripped) ?? (childSeqs.length ? 'L1' : 'L0')),
      provenance: 'event',
      minLeafSeq: ownLeavesAll[0] ?? checkpointEv.seq,
      maxLeafSeq: ownLeavesAll.at(-1) ?? checkpointEv.seq,
      leafSeqs: ownLeavesAll,
      turns: labelOfTurns(events, logInfo, ownLeavesAll),
      topics: resolveCheckpointTopics(session, checkpointEv, events, logInfo, config, summaryEvent),
      ownText: stripped,
      rawRecallTag: hullTag,
      active: surfaceSet.has(checkpointEv.seq),
    }
    records.push(record)
    for (const child of childEvents) walk(child, hullTag ?? enclosingEpochTag)
    if (ownLeaves.length) {
      records.push({
        stageKey: ownLeaves.join(','),
        checkpointSeq: checkpointEv.seq,
        enclosingEpochTag: hullTag ?? enclosingEpochTag,
        level: 'raw-rem',
        provenance: 'event',
        minLeafSeq: ownLeaves[0],
        maxLeafSeq: ownLeaves.at(-1),
        leafSeqs: ownLeaves,
        turns: labelOfTurns(events, logInfo, ownLeaves),
        topics: record.topics,
        ownText: '',
        rawRecallTag: hullTag ?? enclosingEpochTag, // C-13: raw remainder uses the enclosing L1's hull tag
        active: surfaceSet.has(checkpointEv.seq),
      })
    }
  }

  const referencedCheckpoints = new Set()
  for (let seq = 0; seq < (events?.length ?? 0); seq++) {
    const ev = events[seq]
    if (!ev || !isSummaryCheckpoint(ev)) continue
    for (const sourceSeq of ev.sourceEventSeqs ?? []) if (isSummaryCheckpoint(events[sourceSeq])) referencedCheckpoints.add(sourceSeq)
  }
  const roots = []
  for (let seq = 0; seq < (events?.length ?? 0); seq++) {
    const ev = events[seq] ?? null
    if (ev && isSummaryCheckpoint(ev) && !referencedCheckpoints.has(seq)) roots.push(ev)
  }
  for (let i = roots.length - 1; i >= 0; i--) walk(roots[i], null)

  records.sort((a, b) => a.minLeafSeq - b.minLeafSeq || a.maxLeafSeq - b.maxLeafSeq)
  const byTopic = new Map()
  for (const record of records) {
    for (const topic of record.topics.length ? record.topics : ['general']) {
      if (!byTopic.has(topic)) byTopic.set(topic, [])
      byTopic.get(topic).push(record)
    }
  }
  const index = { records, byTopic, logLen, replaceGen, hash, key }
  perSession.set(key, index)
  return index
}

function safeSnapshot(session) {
  try { const events = session.snapshotEvents() ; if (Array.isArray(events)) return events } catch {}
  return session?.events ?? []
}

function labelOfTurns(events, logInfo, leafSeqs) {
  const turns = [...new Set((leafSeqs ?? []).map((s) => logInfo?.eventTurnMap?.get(s)).filter((t) => typeof t === 'number' && t > 0))].sort((a, b) => a - b)
  if (!turns.length) return ''
  const parts = []
  let start = turns[0], prev = turns[0]
  for (let i = 1; i <= turns.length; i++) {
    if (turns[i] === prev + 1) { prev = turns[i] ; continue }
    parts.push(start === prev ? `${start}` : `${start}..${prev}`)
    start = prev = turns[i]
  }
  return parts.join(',')
}

function levelFromText(stripped) {
  const after = stripped.replace(COMPACT_HEADER_TOKEN_RE, '').trim()
  if (after.startsWith('[epoch L1 ·')) return 'L1'
  if (after.startsWith('<compacted-summary>')) {
    const next = after.replace(/^<compacted-summary>\s*/, '')
    if (next.startsWith('[epoch L1 ·')) return 'L1'
  }
  return null
}

/** @topics catalog recall (C-19 route; <=380 tokens by construction of each row). */
export function executeTopicCatalogRecall(session, events, logInfo, config = {}, estimateTokens = null) {
  const index = buildCheckpointIndex(session, events, logInfo, config)
  const active = index.records.filter((r) => r.active)
  const l1 = active.filter((r) => r.level === 'L1')
  const l0 = active.filter((r) => r.level !== 'L1')
  const stages = index.records.length
  const topicRows = []
  for (const [topic, recs] of index.byTopic) {
    if (topic === 'general' && recs.every((r) => r.topics.length > 1)) continue
    const latest = recs.at(-1)
    const spans = [...new Set(recs.map((r) => r.rawRecallTag).filter(Boolean))].slice(0, 4)
    topicRows.push(`- ${topic} (${recs.length} stage(s), ${recs.map((r) => `T${r.turns || r.minLeafSeq}`).join(', ')}): latest T${latest.turns || latest.minLeafSeq} "${clip(latest.ownText.split('\n').find(Boolean) || '', 60)}" | spans: ${spans.join(', ') || 'n/a'}`)
    if (topicRows.length >= 10) break
  }
  const header = `[Topic Index @topics | ${active.length} active checkpoints (${l1.length} L1 epoch(s), ${l0.length} L0), ${stages} indexed stages]`
  const lines = [header, ...topicRows, '[Drill down: context_recall({ target: "@topic:<name>", query: "..." }) for stage summaries, or target: "@span:..." for raw lines]']
  return {
    target: '@topics',
    leafSeqs: [],
    totalLines: lines.length,
    returnedLines: lines.length,
    hasMore: false,
    text: lines.join('\n'),
  }
}

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return Array.from(s).slice(0, n).join('')
}

/** `@topic:<a,b>` / `mode: summaries_only` renderer (C-19; <=1200 tokens by row budgeting). */
export function executeSummaryTierRecall(session, args, events, logInfo, config = {}) {
  const target = String(args?.target ?? '').trim()
  const query = typeof args?.query === 'string' ? args.query : ''
  const topicMatch = /^@topic:([a-z0-9_,-]+)$/i.exec(target)
  const index = buildCheckpointIndex(session, events, logInfo, config)

  let selected = []
  let topicNames = []
  if (topicMatch) {
    topicNames = topicMatch[1].toLowerCase().split(',').map(normalizeTopicName).filter(Boolean).sort()
    const set = new Set(topicNames)
    const known = [...index.byTopic.keys()]
    if (!topicNames.length) {
      return { target, leafSeqs: [], totalLines: 0, returnedLines: 0, hasMore: false, text: `[Recall @topic: no topic name given; known topics: ${known.join(', ')}]` }
    }
    for (const name of topicNames) {
      if (!index.byTopic.has(name) || !index.byTopic.get(name).length) continue
      for (const rec of index.byTopic.get(name)) if (!set.has('') && rec.topics.some((t) => set.has(t))) selected.push(rec)
    }
    selected = [...new Map(selected.map((r) => [r.stageKey + ':' + r.checkpointSeq, r])).values()].sort((a, b) => a.minLeafSeq - b.minLeafSeq)
    if (!selected.length) {
      return { target, leafSeqs: [], totalLines: 0, returnedLines: 0, hasMore: false, text: `[Recall ${target}: no stages; known topics: ${known.join(', ')}]` }
    }
  } else {
    selected = index.records.filter((r) => r.active !== false)
  }

  if (query) {
    let matcher
    try { matcher = new RegExp(query, 'i') } catch { matcher = { test: (l) => String(l).toLowerCase().includes(query.toLowerCase()) } }
    const filtered = selected.filter((r) => matcher.test(r.ownText) || matcher.test(r.topics.join(',')) || r.leafSeqs.some(() => false))
    if (filtered.length) selected = filtered
    else {
      const hintLeaves = selected.flatMap((r) => r.leafSeqs).slice(0, 2000)
      const leafHits = hintLeaves.filter((seq) => events[seq] && matcher.test(JSON.stringify(events[seq].data ?? '').slice(0, 512))).length
      const note = `[0 summary matches for ${JSON.stringify(query)} in ${target}; ${leafHits} raw leaf matches exist — call target:"@span:..." with the same query to inspect raw lines]`
      return { target, leafSeqs: [], totalLines: 1, returnedLines: 1, hasMore: false, text: note }
    }
  }

  const lines = []
  for (const rec of selected) {
    const head = `[Stage T${rec.turns || rec.minLeafSeq} | topics:${rec.topics.join(',')} | level:${rec.level}${rec.enclosingEpochTag ? ` (in ${rec.enclosingEpochTag})` : ''} | raw_recall: ${rec.rawRecallTag ?? 'n/a'} | src:${rec.provenance}]`
    lines.push(head)
    lines.push(clip(stripTopicTimeline(rec.ownText), 400))
  }
  const text = `[Recall ${target} | summary tier | stages: ${selected.length} | lines: 1-${lines.length} of ${lines.length}]\n${lines.join('\n')}`
  return { target, leafSeqs: [], totalLines: lines.length, returnedLines: lines.length, hasMore: false, text }
}
