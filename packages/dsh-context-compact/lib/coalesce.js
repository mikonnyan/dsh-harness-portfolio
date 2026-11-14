import { createHash } from 'node:crypto'

/** Deterministic summary-prefix dedup (v5 §6). Pure. */

const TAG_RE = /\[recall:\s*@[^\]]+\]/g
const SECTION_RE = /^##\s*(决定与纠正|未完成事项|锚点|经过)\s*$/

export function extractRecallTags(text) {
  return [...String(text || '').matchAll(TAG_RE)].map((m) => m[0])
}

export function normalizeSummaryText(text) {
  return String(text || '').replace(TAG_RE, '').replace(/\s+/g, ' ').trim()
}

export function summaryHash(text) {
  return createHash('sha256').update(normalizeSummaryText(text)).digest('hex')
}

export function lineShingles(text) {
  return String(text || '').replace(/\[recall:\s*@[^\]]+\]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function jaccard(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const item of A) if (B.has(item)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

function spanOfTag(tag) {
  const m = /S(\d+)/.exec(tag || '')
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

export function unionTags(tags) {
  const seen = new Set()
  const out = []
  for (const tag of tags || []) {
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out.sort((a, b) => spanOfTag(a) - spanOfTag(b) || String(a).localeCompare(String(b)))
}

function spansOverlap(a, b) {
  if (a.spanStart == null || b.spanStart == null || a.spanEnd == null || b.spanEnd == null) return false
  return a.spanStart <= b.spanEnd && b.spanStart <= a.spanEnd
}

function spanCovered(inner, outer) {
  if (inner.spanStart == null || outer.spanStart == null) return false
  return outer.spanStart <= inner.spanStart && outer.spanEnd >= inner.spanEnd
}

function parseSections(text) {
  const buckets = { '决定与纠正': [], '未完成事项': [], '锚点': [], '经过': [] }
  let current = '经过'
  let any = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line === '<compacted-summary>' || line === '</compacted-summary>') continue
    if (/^\[recall:\s*@/.test(line) && normalizeSummaryText(line) === '') continue
    const heading = SECTION_RE.exec(line)
    if (heading) { current = heading[1]; any = true; continue }
    buckets[current].push(line)
  }
  if (!any) buckets['经过'] = normalizeSummaryText(text) ? [normalizeSummaryText(text)] : []
  return buckets
}

function dedupeLines(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const key = row.replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

export function renderL1(blocks, turns, narrativeBudget = 1500) {
  const buckets = { '决定与纠正': [], '未完成事项': [], '锚点': [], '经过': [] }
  for (const block of blocks) {
    const parsed = parseSections(block.text)
    for (const key of Object.keys(buckets)) buckets[key].push(...parsed[key])
  }
  const tags = unionTags(blocks.flatMap((b) => archivalTags(b)))
  const narrative = dedupeLines(buckets['经过'])
  let narrativeText = narrative.join('\n')
  const budget = Number.isFinite(narrativeBudget) && narrativeBudget >= 0 ? narrativeBudget : 1500
  if (narrativeText.length > budget) {
    const lines = narrative
    while (lines.length && lines.join('\n').length > budget) lines.shift()
    narrativeText = lines.join('\n')
  }
  const body = [
    '## 决定与纠正',
    dedupeLines(buckets['决定与纠正']).join('\n') || '（无）',
    '## 未完成事项',
    dedupeLines(buckets['未完成事项']).join('\n') || '（无）',
    '## 锚点',
    dedupeLines(buckets['锚点']).join('\n') || '（无）',
    '## 经过',
    narrativeText || '（无）',
    tags.join(' '),
  ].join('\n')
  const label = turns ? `turns ${turns}` : `${blocks.length} blocks`
  return `<compacted-summary>\n[epoch L1 · ${label} · ${blocks.length} blocks]\n${body}\n</compacted-summary>`
}

function decorate(block, index) {
  const recallTags = unionTags([...(block.recallTags || []), ...extractRecallTags(block.text)])
  return {
    ...block,
    index,
    level: block.level || 'L0',
    recallTags,
    hash: summaryHash(block.text),
    shingles: lineShingles(block.text),
    tokens: block.tokens ?? Math.ceil(String(block.text || '').length / 4),
  }
}

/** Exact hash, Jaccard>=0.8 with overlapping spans, then containment. Tags move onto the keeper. */
export function dedupeBlocks(blocks, jaccardThreshold = 0.8) {
  const items = (Array.isArray(blocks) ? blocks : []).filter((block) => block && typeof block === 'object').map(decorate)
  const kept = []
  for (const block of items) {
    const same = kept.find((other) => other.hash === block.hash)
    if (same) { same.recallTags = unionTags([...same.recallTags, ...block.recallTags]); continue }
    const near = kept.find((other) => spansOverlap(block, other) && jaccard(block.shingles, other.shingles) >= jaccardThreshold)
    if (near) {
      const blockSpan = (block.spanEnd ?? 0) - (block.spanStart ?? 0)
      const nearSpan = (near.spanEnd ?? 0) - (near.spanStart ?? 0)
      const winner = blockSpan > nearSpan ? block : near
      const loser = winner === block ? near : block
      winner.recallTags = unionTags([...winner.recallTags, ...loser.recallTags])
      const extra = loser.shingles.filter((line) => !winner.shingles.includes(line))
      if (extra.length) winner.text = `${winner.text}\n${extra.join('\n')}`
      winner.shingles = lineShingles(winner.text)
      winner.hash = summaryHash(winner.text)
      if (winner === block) {
        const at = kept.indexOf(near)
        kept.splice(at, 1, winner)
      }
      continue
    }
    kept.push(block)
  }
  return kept.filter((block) => !kept.some((other) => other !== block && spanCovered(block, other) && block.shingles.every((line) => other.shingles.includes(line))))
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Archival recall tags. An L1's own span tag is excluded so parity stays idempotent (I-S1 / I-S3). */
export function archivalTags(block) {
  if (!block || typeof block !== 'object') return []
  const self = typeof block.recallTag === 'string' ? block.recallTag : ''
  const field = Array.isArray(block.recallTags) ? block.recallTags : []
  const fromText = extractRecallTags(block.text).filter((tag) => tag !== self)
  return unionTags([...field, ...fromText])
}

function measuredTokens(block) {
  return Math.ceil(String(block?.text || '').length / 4)
}

function joinedTokens(blocks) {
  if (!blocks.length) return 0
  return Math.ceil(blocks.map((block) => String(block.text || '')).join('\n\n').length / 4)
}

function packGroups(head, groupBudget, slots) {
  if (!head.length) return []
  const groups = []
  let current = []
  let used = 0
  for (const block of head) {
    const size = Math.max(1, measuredTokens(block))
    if (current.length && used + size > groupBudget) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(block)
    used += size
  }
  if (current.length) groups.push(current)
  const limit = Math.max(1, slots)
  while (groups.length > limit) {
    let best = 0
    let bestCost = Infinity
    for (let i = 0; i < groups.length - 1; i++) {
      const cost = groups[i].reduce((sum, block) => sum + measuredTokens(block), 0) + groups[i + 1].reduce((sum, block) => sum + measuredTokens(block), 0)
      if (cost < bestCost) { bestCost = cost; best = i }
    }
    groups.splice(best, 2, groups[best].concat(groups[best + 1]))
  }
  return groups
}

function makeL1(group, narrativeBudget) {
  const spanStart = group.map((b) => b.spanStart).filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b)[0]
  const spanEnd = group.map((b) => b.spanEnd).filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => b - a)[0]
  const turns = group.map((b) => b.turns).filter(Boolean).join(',')
  const recallTag = `[recall: @span:S${Number.isFinite(spanStart) ? spanStart : 0}-${Number.isFinite(spanEnd) ? spanEnd : 0}]`
  const rendered = renderL1(group, turns, narrativeBudget)
  const text = rendered.includes(recallTag) ? rendered : rendered.replace('</compacted-summary>', `${recallTag}\n</compacted-summary>`)
  return {
    level: 'L1',
    text,
    recallTag,
    recallTags: unionTags(group.flatMap((block) => archivalTags(block))),
    spanStart,
    spanEnd,
    tokens: Math.ceil(text.length / 4),
  }
}

/**
 * Keep the latest `keepL0` blocks. Roll older ones into L1 groups.
 * `maxBlocks` / `maxTokens` are hard caps on the rendered output (v5 §6 / §10).
 * Returns the same array when already under both caps.
 */
export function coalesceSummaryBlocks(blocks, options = {}) {
  const maxBlocks = positiveInt(options.maxBlocks, 6)
  const maxTokens = positiveInt(options.maxTokens, 5000)
  const keepRaw = Number(options.keepL0)
  const keepL0 = Number.isFinite(keepRaw) ? Math.max(0, Math.floor(keepRaw)) : 2
  const groupBudget = positiveInt(options.groupBudget, 1500)
  const input = (Array.isArray(blocks) ? blocks : []).filter((block) => block && typeof block === 'object')
  const beforeTags = unionTags(input.flatMap((block) => archivalTags(block)))
  const tokens = input.reduce((sum, block) => sum + measuredTokens(block), 0)
  if (input.length <= maxBlocks && tokens <= maxTokens) {
    return { blocks: input, changed: false, tags: beforeTags, tagParity: true }
  }
  const deduped = dedupeBlocks(input)
  let tailCount = Math.min(keepL0, deduped.length)
  while (tailCount > 0) {
    const tailSlice = deduped.slice(deduped.length - tailCount)
    const tailTok = tailSlice.reduce((sum, block) => sum + measuredTokens(block), 0)
    const headLeft = deduped.length - tailCount
    if (tailCount <= maxBlocks && tailTok <= maxTokens && (headLeft === 0 || tailCount < maxBlocks)) break
    tailCount--
  }
  const head = deduped.slice(0, deduped.length - tailCount)
  const tail = deduped.slice(deduped.length - tailCount)
  const slots = Math.max(1, maxBlocks - tail.length)
  const groups = packGroups(head, groupBudget, slots)
  const renderAt = (narrativeBudget) => groups.map((group) => makeL1(group, narrativeBudget))
  let chosen = renderAt(0)
  const hi = Math.max(1, groupBudget) * 4
  if (groups.length && joinedTokens([...chosen, ...tail]) <= maxTokens) {
    let lo = 0
    let high = hi
    while (lo <= high) {
      const mid = Math.floor((lo + high) / 2)
      const trial = renderAt(mid)
      if (joinedTokens([...trial, ...tail]) <= maxTokens) { chosen = trial; lo = mid + 1 }
      else high = mid - 1
    }
  }
  const next = [...chosen, ...tail]
  const afterTags = unionTags(next.flatMap((block) => archivalTags(block)))
  const changed = next.length !== input.length || next.some((block, index) => block.text !== input[index]?.text)
  return { blocks: next, changed, tags: afterTags, tagParity: beforeTags.join('|') === afterTags.join('|') }
}
