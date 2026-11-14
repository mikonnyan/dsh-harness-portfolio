/**
 * lib/topics.js — v5 Round 4 topic taxonomy & deterministic inference (C-06..C-08).
 * Pure, zero-dependency, zero session mutation (I-P1/C-12).
 */

export const TOPIC_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_TOPICS_PER_SPAN = 3
export const MAX_TOPIC_SLUG_LEN = 24

/** Strict file-path anchor extractor (R3.5.1; rejects "v4.1"-style dotted identifiers). */
export const FILE_ANCHOR_RE = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}(?::\d+)?|\b[A-Za-z0-9_-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|scss|vue|py|rs|go|sh|ps1|toml|sql)(?::\d+)?\b/g

/** Outer `[Compact ...]` header token (D3): serves L0, L1 outer wrapper and carried wrapper. */
export const COMPACT_HEADER_TOKEN_RE = /\[Compact(?<carried>\s+carried)?(?:\s+turns:(?<turns>[\d,.\-]+))?(?:\s+topics:(?<topics>[a-z0-9,-]+))?\]/g

/** Close-tag `[recall: @span:S12-45+S50-60 turns:3..6]`. */
export const SPAN_CLOSE_TAG_RE = /\[recall:\s*(?<tag>@span:(?<ranges>S\d+-\d+(?:\+S\d+-\d+)*)(?:\s+turns:(?<turns>[\d,.\-]+))?)\]/g

export const RECALL_FOLDED_PREFIX_RE = /^\[Compact-Recall-(?:Digest\b|Evicted\])/

/** Built-in canonical rules (Round 1 §1.1). Weights: path 3.0 / pipeline 2.5 / tool 2.0 / keyword 1.0. */
export const DEFAULT_TOPIC_RULES = [
  {
    topic: 'harness-core',
    priority: 10,
    paths: ['dsh-context-compact', 'dsh-tool-gate', 'dsh-relay-dispatch', 'dsh-session', 'dsh-token-meter', 'dsh-system-prompt', 'cordis', 'plugins/', 'compaction', 'salience.js', 'coalesce.js', 'auto-engine.js', 'recall-budget.js', 'topics.js', 'topic-index.js'],
    tools: ['context_compact', 'context_recall', 'dev_inject_plugin', 'dev_reload_package', 'tool_unlock', 'dev_plugin_status'],
    pipelines: ['relay_dispatch', 'subagent'],
    keywords: ['compaction', 'checkpoint', 'watermark', 'surfaceop', 'tokenmeter', 'prefix-epoch', 'pmw', 'subagent', 'harness', 'plugin', 'topic', 'recall'],
  },
  {
    topic: 'gateway',
    priority: 8,
    paths: ['gateway', 'bridge', 'proxy', 'router', 'upstream', 'auth', 'oauth', 'provider', 'llm-adapter', 'rate-limit', 'middleware'],
    tools: ['curl', 'invoke-restmethod'],
    pipelines: ['4098', '8318', '/v1/chat/completions', '/v1/messages'],
    keywords: ['gateway', 'proxy', 'bridge', 'upstream', 'sse', 'streaming', 'rate-limit', 'ratelimit', 'failover', 'ttft', 'bearer', 'endpoint', 'model-routing', 'modelrouting'],
  },
  {
    topic: 'mobile-web',
    priority: 6,
    paths: ['apps/web', 'client-ui', 'mobile', 'pwa', 'components/', 'styles/', '.tsx', '.jsx', '.vue', '.css', '.scss', 'vite.config', 'tailwind'],
    tools: ['modlens_read_image', 'read_image'],
    pipelines: ['dev:web', 'vite build', 'pnpm run dev'],
    keywords: ['ui', 'ux', 'dom', 'css', 'layout', 'viewport', 'mobile', 'responsive', 'hmr', 'component', 'frontend', 'web-gui', 'webgui', 'drawer', 'modal'],
  },
  {
    topic: 'media-compiler',
    priority: 4,
    paths: ['media', 'compiler', 'transcode', 'codec', 'audio', 'video', 'image', 'render', 'canvas', 'shader', 'wasm', 'asset-pipeline', 'ffmpeg'],
    tools: ['ffmpeg', 'ffprobe', 'sharp', 'imagemagick'],
    pipelines: [],
    keywords: ['media', 'codec', 'transcode', 'mux', 'demux', 'frame', 'bitrate', 'waveform', 'sprite', 'atlas', 'render-pipeline', 'renderpipeline', 'audio', 'video'],
  },
  {
    topic: 'remote-desktop',
    priority: 5,
    paths: ['remote', 'rdp', 'vnc', 'ssh', 'tunnel', 'tailscale', 'wireguard', 'webrtc', 'hid', 'screen-capture', 'daemon', 'launchd', 'systemd'],
    tools: ['ssh', 'scp', 'rsync', 'systemctl', 'launchctl', 'new-service'],
    pipelines: [],
    keywords: ['ssh', 'remote-desktop', 'remotedesktop', 'vnc', 'rdp', 'tunnel', 'tailscale', 'cross-machine', 'crossmachine', 'sync-target', 'synctarget', 'headless', 'display'],
  },
]

const rulesCache = new Map()
const defaultCompiledRules = DEFAULT_TOPIC_RULES.map(ruleToRegexes)
const warnedTopicRules = new Set()

function warnSkippedTopicRule(rule, reason) {
  const key = `${reason}:${String(rule?.topic ?? '')}`
  if (warnedTopicRules.has(key)) return
  warnedTopicRules.add(key)
  try { console.warn(`[dsh-context-compact] topic rule skipped (${reason}): ${String(rule?.topic ?? '')}`) } catch {}
}

function compileMatcher(list) {
  const items = (Array.isArray(list) ? list : []).map((x) => String(x ?? '').toLowerCase().trim()).filter(Boolean)
  if (!items.length) return null
  return new RegExp(`(?:${items.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i')
}

function ruleToRegexes(rule) {
  return {
    topic: normalizeTopicName(rule?.topic ?? ''),
    priority: typeof rule?.priority === 'number' && Number.isFinite(rule.priority) ? rule.priority : 0,
    pathRe: compileMatcher(rule?.paths),
    toolRe: compileMatcher(rule?.tools),
    pipelineRe: compileMatcher(rule?.pipelines),
    keywordRe: compileMatcher(rule?.keywords),
  }
}

function rulesHash(rules) {
  return JSON.stringify(rules.map((r) => [r.topic, r.priority, r.paths, r.tools, r.pipelines, r.keywords]))
}

/** Compile default + custom rules once per identical rules array (C-08). A bad rule is skipped, never throws. */
export function compileTopicRules(config = {}) {
  const customRaw = Array.isArray(config?.topicRules) ? config.topicRules : []
  const custom = []
  for (const rule of customRaw) {
    if (!rule || typeof rule !== 'object') { warnSkippedTopicRule(rule, 'not-an-object'); continue }
    const slug = normalizeTopicName(rule.topic ?? '')
    if (!slug) { warnSkippedTopicRule(rule, 'invalid-slug'); continue }
    try { custom.push(ruleToRegexes(rule)) } catch { warnSkippedTopicRule(rule, 'compile-failed') }
  }
  return [...DEFAULT_TOPIC_RULES.map(ruleToRegexes), ...custom]
}

function compiledRulesFor(config = {}) {
  const customRaw = Array.isArray(config?.topicRules) ? config.topicRules : null
  if (!customRaw) return defaultCompiledRules
  const hash = rulesHashOfConfig(config)
  let rules = rulesCache.get(hash)
  if (!rules) {
    rules = compileTopicRules(config)
    rulesCache.set(hash, rules)
  }
  return rules
}

export function rulesHashOfConfig(config = {}) {
  const customRaw = Array.isArray(config?.topicRules) ? config.topicRules : null
  if (!customRaw) return 'default'
  return rulesHash(customRaw)
}

/** Lowercase ASCII kebab-case slug, 1..24 chars (C-06). */
export function normalizeTopicName(raw) {
  const slug = String(raw ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
  if (!slug || slug.length > MAX_TOPIC_SLUG_LEN || !TOPIC_SLUG_RE.test(slug)) return ''
  return slug
}

/** Normalize & validate caller-supplied topics without throwing (R2.4.1 / C-05). */
export function sanitizeExplicitTopics(rawTopics) {
  const dropped = []
  const topics = []
  if (rawTopics == null) return { topics, dropped }
  const list = Array.isArray(rawTopics) ? rawTopics : [rawTopics]
  for (const raw of list) {
    const slug = normalizeTopicName(raw)
    if (!slug || topics.includes(slug)) { if (raw != null && String(raw).trim()) dropped.push(String(raw)) ; continue }
    if (topics.length >= MAX_TOPICS_PER_SPAN) { dropped.push(String(raw)) ; continue }
    topics.push(slug)
  }
  return { topics, dropped }
}

function capAdd(scores, topic, add, cap) {
  const prev = scores.get(topic) ?? 0
  scores.set(topic, Math.min(cap, prev + add))
}

function first4k(text) {
  const s = String(text ?? '')
  return s.length > 4096 ? s.slice(0, 4096) : s
}

/** Deterministic 1..3 topic inference (C-06/C-07). Bounded: 200 events, 4KB per event. */
export function inferSpanTopics(input = {}) {
  const events = Array.isArray(input.events) ? input.events : []
  const logInfo = input.logInfo ?? null
  const seqs = Array.isArray(input.seqs) ? input.seqs.slice(0, 200) : []
  const summaryText = first4k(input.summaryText)
  const config = input.config ?? {}
  const explicit = sanitizeExplicitTopics(input.explicitTopics)
  if (explicit.topics.length > 0) return { topics: explicit.topics, droppedExplicit: explicit.dropped, source: 'explicit' }

  const rules = compiledRulesFor(config)
  const scores = new Map()
  const pathScores = new Map()
  const priority = new Map()
  const paths = new Set()
  const tools = new Set()
  const pipelines = new Set()
  const keywordTexts = []

  const harvest = (text) => {
    for (const m of first4k(text).matchAll(FILE_ANCHOR_RE)) paths.add(m[0])
  }

  for (const seq of seqs) {
    const ev = events[seq]
    if (!ev) continue
    const callMap = logInfo?.callMap
    if (ev.type === 'tool/call') {
      tools.add(String(ev.data?.name ?? ''))
      const args = ev.data?.arguments
      const argText = typeof args === 'string' ? args : (args && typeof args === 'object' ? JSON.stringify(args).slice(0, 4096) : '')
      if (argText) {
        try {
          const parsed = typeof args === 'string' ? JSON.parse(args) : args
          for (const key of ['file_path', 'path', 'workdir', 'specFile']) {
            if (typeof parsed?.[key] === 'string') harvest(parsed[key])
          }
          if (Array.isArray(parsed?.writeScope) || Array.isArray(parsed?.reviewTargets)) {
            for (const v of [...(parsed.writeScope ?? []), ...(parsed.reviewTargets ?? [])]) if (typeof v === 'string') harvest(v)
          }
          if (typeof parsed?.mode === 'string') pipelines.add(parsed.mode)
          if (typeof parsed?.prompt === 'string') keywordTexts.push(parsed.prompt.slice(0, 2048))
        } catch { /* ignore malformed args */ }
      }
    } else if (ev.type === 'tool/result') {
      const cid = ev.data?.message?.source?.callId
      const name = callMap?.get?.(cid)?.name ?? ev.data?.name ?? ev.data?.message?.toolName
      if (name) tools.add(String(name))
      const blocks = Array.isArray(ev.data?.message?.content?.[0]?.content) ? ev.data.message.content[0].content : ev.data?.message?.content
      for (const b of Array.isArray(blocks) ? blocks : []) if (b?.type === 'text' && typeof b.text === 'string') harvest(b.text)
    } else if (ev.type === 'assistant/message') {
      for (const block of ev.data?.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') { keywordTexts.push(block.text.slice(0, 2048)) ; harvest(block.text) }
        if (block?.type === 'tool-call') {
          tools.add(String(block.name ?? ''))
          const args = typeof block.arguments === 'string' ? (() => { try { return JSON.parse(block.arguments) } catch { return null } })() : block.arguments
          for (const key of ['file_path', 'path', 'workdir']) if (typeof args?.[key] === 'string') harvest(args[key])
        }
      }
    } else if (ev.type === 'user/message') {
      for (const b of ev.data?.content ?? []) if (b?.type === 'text' && typeof b.text === 'string') keywordTexts.push(b.text.slice(0, 2048))
    }
  }
  if (summaryText) { keywordTexts.push(summaryText) ; harvest(summaryText) }

  const keywordBlob = keywordTexts.join('\n').toLowerCase()
  for (const rule of rules) {
    let pathScore = 0
    if (rule.pathRe) {
      let pathHits = 0
      for (const p of paths) if (rule.pathRe.test(p)) pathHits++
      for (const p of paths) {
        // Also count substring hits of the raw path list against known identifiers
      }
      if (pathHits) { capAdd(scores, rule.topic, 3.0 * Math.min(3, pathHits), 9.0) ; pathScore = 3.0 * Math.min(3, pathHits) }
    }
    if (rule.pipelineRe) {
      let pipeHits = 0
      for (const p of pipelines) if (rule.pipelineRe.test(p)) pipeHits++
      if (!pipeHits && rule.pipelineRe.test(keywordBlob)) pipeHits = 1
      if (pipeHits) capAdd(scores, rule.topic, 2.5 * Math.min(2, pipeHits), 5.0)
    }
    if (rule.toolRe) {
      let toolHits = 0
      for (const t of tools) if (rule.toolRe.test(t)) toolHits++
      if (toolHits) capAdd(scores, rule.topic, 2.0 * Math.min(2, toolHits), 4.0)
    }
    if (rule.keywordRe) {
      const matches = keywordBlob.match(rule.keywordRe instanceof RegExp ? new RegExp(rule.keywordRe.source, 'g') : /.^/g)
      const distinct = new Set(matches ?? [])
      if (distinct.size) capAdd(scores, rule.topic, 1.0 * Math.min(3, distinct.size), 3.0)
    }
    if (scores.has(rule.topic)) {
      pathScores.set(rule.topic, Math.min(9, pathScore))
      priority.set(rule.topic, rule.priority)
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]
    || (pathScores.get(b[0]) ?? 0) - (pathScores.get(a[0]) ?? 0)
    || (priority.get(b[0]) ?? 0) - (priority.get(a[0]) ?? 0)
    || a[0].localeCompare(b[0]))
  if (!sorted.length) return { topics: ['general'], droppedExplicit: explicit.dropped, source: 'fallback' }
  const top = sorted[0][1]
  const kept = sorted.filter(([topic, score]) => score >= 2.0 && score >= 0.35 * top).map(([topic]) => topic)
  if (!kept.length) return { topics: ['general'], droppedExplicit: explicit.dropped, source: 'fallback' }
  return { topics: kept.slice(0, MAX_TOPICS_PER_SPAN), droppedExplicit: explicit.dropped, source: 'inferred' }
}

/** Parse `topics:a,b` from the last non-carried `[Compact ...]` header of a text (R2.2.4 #6). */
export function parseHeaderTopics(text) {
  const s = String(text ?? '')
  let last = null
  for (const m of s.matchAll(COMPACT_HEADER_TOKEN_RE)) {
    if (m.groups?.carried) continue
    if (m.groups?.topics) last = m.groups.topics
    else last = last // keep prior; header without topics does not reset
  }
  if (!last) return []
  const slugs = String(last).split(',').map(normalizeTopicName).filter(Boolean)
  return [...new Set(slugs)].slice(0, MAX_TOPICS_PER_SPAN)
}

/**
 * Read-only 3-tier topic resolver for any checkpoint event (I-P1, C-10).
 * Memoized per (session, checkpointSeq, rulesHash). Tier 3 header parse applies only to
 * records whose events are missing; metadata always wins over text.
 */
const checkpointTopicCache = new WeakMap()

export function resolveCheckpointTopics(session, checkpointEv, events, logInfo, config = {}, summaryEvent = null) {
  if (!checkpointEv) return ['general']
  const hash = rulesHashOfConfig(config)
  let perSession = checkpointTopicCache.get(session)
  if (!perSession) { perSession = new Map() ; checkpointTopicCache.set(session, perSession) }
  const cacheKey = `${checkpointEv.seq}:${hash}`
  const cached = perSession.get(cacheKey)
  if (cached) return cached

  let topics = null
  // Tier 1: structured metadata (authoritative even when ['general']).
  const metaData = summaryEvent?.data?.topics ?? (events?.[checkpointEv.sourceEventSeqs?.[1] ?? -1]?.type === 'compaction/summary' ? events[checkpointEv.sourceEventSeqs[1]].data?.topics : null)
  if (Array.isArray(metaData)) {
    topics = metaData.length ? metaData.map(normalizeTopicName).filter(Boolean) : ['general']
  }
  if (!topics || !topics.length) {
    // Tier 2/3.
    const text = typeof checkpointEv.data?.summary === 'string'
      ? checkpointEv.data.summary
      : (checkpointEv.data?.content ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    const headerTopics = parseHeaderTopics(text)
    if (headerTopics.length && events && !events[checkpointEv.seq]) {
      // Text-tier record: header parse allowed only when the event itself is missing (C-10).
      topics = headerTopics
    }
    if (!topics || !topics.length) {
      const ownLeaves = resolveOwnLeaves(events, checkpointEv)
      const inferred = inferSpanTopics({
        events, logInfo, seqs: ownLeaves, summaryText: text, config,
      })
      topics = inferred.topics
    }
  }
  const out = [...new Set(topics)].slice(0, MAX_TOPICS_PER_SPAN)
  if (!out.length) out.push('general')
  perSession.set(cacheKey, out)
  return out
}

/** Leaves owned by this checkpoint (first-level expansion, cheap). */
function resolveOwnLeaves(events, checkpointEv) {
  if (!events || !checkpointEv) return []
  const seqs = Array.isArray(checkpointEv.sourceEventSeqs) ? checkpointEv.sourceEventSeqs : [checkpointEv.seq]
  const out = []
  for (const seq of seqs) {
    const ev = events[seq]
    if (ev && ev.surfaceOp === 'append') out.push(seq)
  }
  return out
}
