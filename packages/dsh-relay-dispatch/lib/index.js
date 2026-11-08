/**
 * @dsh-external/dsh-relay-dispatch
 * 派发 Harness relay 任务后立即返回，由后台 job 代为等待；任务结束时 DSH 的
 * job 完成通知只带回精简结论（状态 + 截断后的 assistantText），主会话不再循环 wait_run。
 * 纯 JS、零运行时依赖（宿主无 checkout 也能直接注入）。
 */

export const name = '@dsh-external/dsh-relay-dispatch'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const inject = ['tools']
export const PREPARE_SYM = Symbol.for('relay-dispatch.prepare')
export const API_HANDLER_SYM = Symbol.for('relay-dispatch.apiHandler')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const PARENT_LOG_PATH = process.env.DSH_RELAY_PARENT_LOG_PATH || join(DSH_HOME, 'relay-dispatch-parent.log')

const DEFAULTS = {
  sliceMs: 30000, // 单次 wait_run 切片上限（毫秒），便于及时感知取消与停滞
  maxResultChars: 4000,
  maxWaitMinutes: 240,
  stallMinutes: 15, // 无新进展提醒阈值（分钟）；<=0 关闭
  cancelGraceMs: 60000, // cancelRequested:true 但仍未终止时的最大宽限等待（默认 1 分钟）
  waitMaxRetries: 3, // wait_run 遇单次瞬时网络错误时的最大连续重试次数
  waitRetryDelayMs: 2000, // wait_run 瞬时网络错误重试间隔（毫秒）
  startTimeoutMs: 120000, // start_run 单次调用超时（默认 2 分钟）
  slotWindowMs: 120000, // parentSession 槽有效时间窗口上限
  titleRefreshTimeoutMs: 15000, // titles.refresh() 本地超时
  titlePollFirstMs: 400,
  titlePollIntervalMs: 3000,
  titlePollMaxAttempts: 40,
  defaultProvider: 'copilot',
  defaultModel: 'claude-sonnet-5.5',
  defaultAgentPreset: undefined, // 默认不设，沿用官方 preset；按需可配置为 'standard-lean'
  defaultSessionMode: 'fresh',
}

const TOOL_START_RUN = 'mcp__harness_relay__start_run'
const TOOL_START_REVIEW = 'mcp__harness_relay__start_review'
const TOOL_LIST_WS = 'mcp__harness_relay__list_workspaces'
const TOOL_WAIT = 'mcp__harness_relay__wait_run'
const TOOL_CANCEL = 'mcp__harness_relay__cancel_run'
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'incomplete', 'needs_attention'])

let seq = 0

function sameDir(a, b) {
  const n = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return n(a) === n(b)
}

function textOf(content) {
  if (!Array.isArray(content)) return undefined
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
}

function tryJson(s) {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return { text: s } }
}

/** 从工具执行结果中取出 relay 的 JSON 快照（兼容多种 MCP 结果形态）。 */
export function parseResult(result) {
  if (result && result.isError) {
    const msg = (result.error && result.error.message) || textOf(result.content) || 'tool error'
    throw new Error(String(msg))
  }
  const v = result ? result.value : undefined
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.structuredContent && typeof v.structuredContent === 'object') return v.structuredContent
    if (Array.isArray(v.content)) {
      if (v.isError) throw new Error(textOf(v.content) || 'relay error')
      return tryJson(textOf(v.content))
    }
    return v
  }
  if (typeof v === 'string') return tryJson(v)
  return tryJson(textOf(result && result.content))
}

function clip(s, max) {
  const text = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s)
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[已截断，原文 ${text.length} 字符；需要全文可用 get_run 查看]`
}

/** 通知用结论：assistantText 按字符硬截断到 max（含省略标记）以内。 */
export function conclusion(snap, max = 2000) {
  const t = snap && (snap.assistantText || snap.finalText || snap.result)
  const text = typeof t === 'string' ? t : t == null ? '' : JSON.stringify(t)
  if (!text) return snap && snap.error ? String(snap.error).slice(0, max) : '(无)'
  if (text.length <= max) return text
  const mark = '…[已截断]'
  return text.slice(0, max - mark.length) + mark
}

export const DETAIL_BUDGET_BYTES = 3000
const byteLen = (s) => Buffer.byteLength(s, 'utf8')

/** 按 UTF-8 字节预算截取前缀；不切码点/代理对，Intl.Segmenter 可用时不切字素。 */
export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (byteLen(text) <= maxBytes) return text
  let units
  try { units = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (x) => x.segment) } catch { units = Array.from(text) }
  let out = ''; let used = 0
  for (const u of units) {
    const b = byteLen(u)
    if (used + b > maxBytes) break
    out += u; used += b
  }
  return out
}

/** 完整结论原文（不截断）；无文本时回退 error / '(无)'。 */
export function fullConclusion(snap) {
  const t = snap && (snap.assistantText || snap.finalText || snap.result)
  const text = typeof t === 'string' ? t : t == null ? '' : JSON.stringify(t)
  if (!text) return snap && snap.error ? String(snap.error) : '(无)'
  return text
}

/** 同一判定生成 detail 与结构化交付元数据，保证 full_in_detail/truncated 与结构化字段一致。 */
export function buildDelivery(status, text, budget = DETAIL_BUDGET_BYTES, fullTextAvailable = true) {
  const s = String(text ?? '')
  const fullLength = Array.from(s).length
  const avail = Boolean(fullTextAvailable)
  const st = `status: ${status}`
  const full = `${st}\nfull_in_detail=1\n${s}`
  if (byteLen(full) <= budget) {
    return { detail: full, finalText: s, truncated: false, fullLength, fullTextAvailable: avail }
  }
  const hint = avail ? '以下仅为预览；完整原文请调用 job_output 获取' : '以下仅为预览（完整原文不可用）'
  const head = `${st}\ntruncated=1 full_length=${fullLength} chars (${byteLen(s)} bytes) ${hint}\n---\n`
  const mark = '\n…[预览已截断]'
  const preview = truncateUtf8(s, budget - byteLen(head) - byteLen(mark))
  return { detail: head + preview + mark, finalText: preview, truncated: true, fullLength, fullTextAvailable: avail }
}

/** detail：头部元信息（状态/标记/读取指引）在预览之前，总 UTF-8 字节 <= budget。 */
export function buildDetail(status, text, budget = DETAIL_BUDGET_BYTES, fullTextAvailable = true) {
  return buildDelivery(status, text, budget, fullTextAvailable).detail
}
export function summarize(snap, maxChars) {
  const lines = [`status: ${(snap && snap.status) || 'unknown'}`, `runId: ${(snap && snap.runId) || '?'}`]
  if (snap && snap.webUrl) lines.push(`webUrl: ${snap.webUrl}`)
  if (snap && snap.error) lines.push(`error: ${clip(snap.error, 800)}`)
  const text = snap && (snap.assistantText || snap.finalText || snap.result)
  lines.push('assistantText:')
  lines.push(text ? clip(text, maxChars) : '(无)')
  return lines.join('\n')
}

/** 补全 startArgs 默认值（纯函数，便于测试）。显式传入的字段永不覆盖。 */
export function fillStartArgs(input, config = DEFAULTS, review = false) {
  const a = { ...(input || {}) }
  const ws = a.workspace
  if (a.provider == null && config.defaultProvider) a.provider = config.defaultProvider
  if (a.model == null && config.defaultModel) a.model = config.defaultModel
  if (a.authorizationBasis == null) a.authorizationBasis = 'explicit-user-request'
  if (a.sessionMode == null && a.sessionId == null && config.defaultSessionMode) a.sessionMode = config.defaultSessionMode
  if (!review && a.agentPreset == null && config.defaultAgentPreset) a.agentPreset = config.defaultAgentPreset
  if (ws) {
    if (a.reviewTargets == null) a.reviewTargets = [ws]
    if (a.contextReadScope == null) a.contextReadScope = [ws]
    const writable = review ? false : (a.permissionPreset === 'workspace-write' || a.permissionPreset === 'danger-full-access')
    if (writable && a.writeScope == null) a.writeScope = [ws]
  }
  if (!review && a.permissionPreset === 'danger-full-access' && a.confirmedDangerousPermission == null) a.confirmedDangerousPermission = true
  return a
}


// ───────── 派发模式（dispatch-modes.yaml 热读）─────────
const MODES_PATH = process.env.DSH_DISPATCH_MODES_PATH || join(DSH_HOME, 'dispatch-modes.yaml')
const TOOL_CAPS = 'mcp__harness_relay__list_capabilities'

/** 极简 YAML 解析：两层映射 + "- " 列表 + "|" 多行文本 + 注释。格式不合法时抛错。 */
export function parseModesYaml(text) {
  const out = {}
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  let mode = null, key = null, block = null
  const scalar = (v) => {
    v = v.trim()
    if (v === '' || v === '~' || v === 'null') return ''
    if (/^(true|false)$/.test(v)) return v === 'true'
    return v.replace(/^(['"])(.*)\1$/, '$2')
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (block) {
      if (raw.trim() === '' || /^\s{4,}/.test(raw)) { block.push(raw.replace(/^\s{4}/, '')); continue }
      out[mode][key] = block.join('\n').replace(/\n+$/, '') + '\n'; block = null
    }
    if (/^\s*(#.*)?$/.test(raw)) continue
    let m
    if ((m = raw.match(/^([A-Za-z][\w-]*):\s*(#.*)?$/))) { mode = m[1]; out[mode] = {}; key = null; continue }
    if (!mode) throw new Error(`第 ${i + 1} 行：缺少模式名`)
    if ((m = raw.match(/^\s+-\s+(.*?)\s*$/))) {
      if (!key || !Array.isArray(out[mode][key])) throw new Error(`第 ${i + 1} 行：列表项无所属键`)
      out[mode][key].push(scalar(m[1].replace(/\s+#.*$/, ''))); continue
    }
    if ((m = raw.match(/^\s+([A-Za-z]\w*):\s*(.*)$/))) {
      key = m[1]; const v = m[2]
      if (/^\|\s*(#.*)?$/.test(v)) { block = []; continue }
      if (/^(#.*)?$/.test(v)) { out[mode][key] = (lines[i + 1] || '').match(/^\s+-\s/) ? [] : ''; continue }
      out[mode][key] = scalar(v.replace(/\s+#.*$/, '')); continue
    }
    throw new Error(`第 ${i + 1} 行无法解析：${raw.slice(0, 60)}`)
  }
  if (block) out[mode][key] = block.join('\n').replace(/\n+$/, '') + '\n'
  return out
}

/** 保留段 aliases.models（列表项 name=provider/model）→ 别名表；不是模式。 */
export function extractAliases(modes) {
  const map = {}
  const list = modes && modes.aliases && modes.aliases.models
  if (Array.isArray(list)) for (const it of list) {
    const m = String(it).match(/^([^=\s]+)=(\S+\/\S+)$/)
    if (m) map[m[1]] = m[2]
  }
  return map
}

/** 每次调用都重新读文件。返回 {modes, warning}；读/解析失败回退内置并给 warning。 */
export function loadModes(path = MODES_PATH, readFn = readFileSync) {
  try {
    const modes = parseModesYaml(readFn(path, 'utf8'))
    const aliases = extractAliases(modes)
    delete modes.aliases
    if (!Object.keys(modes).length) throw new Error('文件中没有任何模式')
    return { modes, aliases }
  } catch (e) {
    return { modes: BUILTIN_MODES, warning: `dispatch-modes.yaml 读取失败（${(e && e.message) || e}），已回退到插件内置默认模式` }
  }
}

const PREFIX = '通用禁令：不重启 DSH；不读 secrets、.credentials.yaml、.env；改文件前先备份；工作区外文件用绝对路径。\n'
const DELIV = '交付格式（尽量短；summary 先给结论，证据路径只列关键 3~5 条）：\nstatus: done | blocked\nchanged_files: [...]\nverification: …\nrisks: …\nrollback: …\nsummary: ≤10 行\n'
export const BUILTIN_MODES = {
  investigate: { permission: 'read-only', models: ['cursor/grok-4.7-fast', 'google/gemini-3.8-flash'], taskPrefix: PREFIX, deliverable: '交付格式：summary 先给结论；证据路径只列关键 3~5 条。\n' },
  implement: { permission: 'danger-full-access', models: ['copilot/claude-sonnet-5.5', 'cursor/claude-opus-5-5'], taskPrefix: PREFIX, deliverable: DELIV },
  verify: { permission: 'read-only', models: ['copilot/claude-sonnet-5.5', 'cursor/grok-4.7-fast'], taskPrefix: PREFIX, deliverable: '交付格式：summary 先给结论；通过/不通过清单，证据路径只列关键 3~5 条。\n' },
  review: { permission: 'read-only', models: ['cursor/claude-opus-5-5', 'copilot/claude-opus-5.5'], taskPrefix: PREFIX, deliverable: '交付格式：summary 先给结论；问题按严重度列出，证据路径只列关键 3~5 条。\n' },
  heavy: { permission: 'danger-full-access', checkpoint: true, models: ['cursor/claude-opus-5-5', 'copilot/claude-opus-5.5'], taskPrefix: PREFIX, deliverable: DELIV },
}

/** 错误分类：仅明确的模型/渠道类错误返回 true（可切换候选）；其余（参数校验、工具隐藏、workspace、权限、未知）一律视为请求/环境类，立即报错。 */
export function isModelError(msg) {
  const s = String(msg || '')
  if (/-32602|input validation|invalid arguments|属于 .* 组|已隐藏|workspace|not registered|outside DSH_RELAY_ALLOWED|permission|writeScope|authorizationBasis|confirmedDangerous/i.test(s)) return false
  return /model.{0,40}(not found|not exist|unknown|unavailable|not supported)|unknown model|no such model|模型.{0,10}(不存在|不可用|未找到)|provider|\b429\b|rate.?limit|quota|unauthori[sz]ed|\b401\b|\b403\b|authentication|api key|credential|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|connection (failed|refused|reset)|fetch failed|\b50[0234]\b|overloaded|timed? ?out/i.test(s)
}

/** 从任务正文提取干净的单行短标题（去掉通用禁令前缀与首行装饰符）。 */
export function cleanBodyTitle(rawTask, prefix = '') {
  let s = String(rawTask || '')
  if (prefix) {
    const p = String(prefix).trim()
    if (p && s.trimStart().startsWith(p)) s = s.trimStart().slice(p.length)
  }
  s = s.replace(/^\s*通用禁令：[^\r\n]*[\r\n]*/g, '').trim()
  const line = (s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '').replace(/^[#*\-\d.\s]+/, '').trim()
  return truncateUtf8(line, 40).trimEnd()
}

/** 套用模式：返回 {args, candidates}。显式字段优先；显式 provider/model 时不生成候选链。 */
export function applyMode(modeCfg, input, aliases = {}) {
  const a = { ...(input || {}) }
  const al = (s) => (typeof s === 'string' && Object.prototype.hasOwnProperty.call(aliases, s) ? aliases[s] : s)
  if (typeof a.model === 'string' && al(a.model) !== a.model) { // 就地改写已有字段；不生成候选链
    const v = aliases[a.model], i = v.indexOf('/')
    a.provider = v.slice(0, i); a.model = v.slice(i + 1)
  }
  if (a.workspace == null && modeCfg.workspace) a.workspace = modeCfg.workspace
  if (a.permissionPreset == null && modeCfg.permission) a.permissionPreset = modeCfg.permission
  if (a.agentPreset == null && modeCfg.agentPreset) a.agentPreset = modeCfg.agentPreset
  if (a.reasoningEffort == null && modeCfg.reasoningEffort) a.reasoningEffort = modeCfg.reasoningEffort
  const parts = []
  if (modeCfg.taskPrefix && String(modeCfg.taskPrefix).trim()) parts.push(String(modeCfg.taskPrefix).trim())
  if (a.task != null) parts.push(String(a.task))
  if (modeCfg.checkpoint) parts.push('检查点：任务较长，完成第一阶段后在会话里写一句简短进度，再继续。')
  if (modeCfg.deliverable && String(modeCfg.deliverable).trim()) parts.push(String(modeCfg.deliverable).trim())
  if (parts.length) a.task = parts.join('\n\n')
  let candidates = []
  if (a.provider == null && a.model == null) {
    candidates = (Array.isArray(modeCfg.models) ? modeCfg.models : []).map((s) => {
      s = al(s)
      const i = String(s).indexOf('/')
      return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : null
    }).filter(Boolean)
  }
  return { args: a, candidates }
}

/** 从 list_capabilities 结果里尽力收集 "provider/model" 集合；识别不了返回 null（不过滤）。 */
export function collectModelIds(caps) {
  const set = new Set()
  const walk = (o, provider) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, provider))
    if (typeof o === 'string') { if (provider) set.add(`${provider}/${o}`); return }
    if (!o || typeof o !== 'object') return
    const p = o.provider || o.providerId || (typeof o.id === 'string' && Array.isArray(o.models) ? o.id : undefined) || provider
    if (o.provider && (o.model || o.id) && typeof (o.model || o.id) === 'string') set.add(`${o.provider}/${o.model || o.id}`)
    for (const [k, v] of Object.entries(o)) {
      if (k === 'models' || k === 'providers' || k === 'items' || typeof v === 'object') walk(v, k === 'models' ? p : (k === 'providers' ? undefined : p))
    }
  }
  walk(caps, undefined)
  return set.size ? set : null
}
/** 识别 /api HTTP 请求来源：'browser'（Web GUI 手动操作）| 'relay'（Node/relay 客户端）| 'unknown'。 */
export function classifyApiRequest(headers) {
  if (!headers || typeof headers !== 'object') return undefined
  const h = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]) || ''
  const origin = String(h('origin') || '')
  const referer = String(h('referer') || '')
  const secSite = String(h('sec-fetch-site') || '')
  const secUa = String(h('sec-ch-ua') || '')
  const ua = String(h('user-agent') || '')
  const ct = String(h('content-type') || '')
  const principal = String(h('x-dsh-relay-principal') || '')
  if (principal || (/^(node|dsh-relay|harness-relay)\b/i.test(ua) && !origin && !referer)) return 'relay'
  if (origin || referer || secUa || (secSite && secSite !== 'none') || /Mozilla\/|Chrome\/|Safari\/|Edg\//i.test(ua)) return 'browser'
  if (!origin && !referer && !secSite && /charset=utf-8/i.test(ct)) return 'relay'
  return 'unknown'
}

/**
 * 判定 sessions.prepare(id, opts) 是否可挂接当前 slot 的 parentSession，并返回结构化诊断信息。
 * 规则：
 * 1) 槽有效（在 start_run 时间窗口内、未被消费）+ cwd 命中 + meta.origin 与 meta.parentSession 都为空，默认视为 relay 创建并注入；
 * 2) agentPreset 仅在派发时显式指定（s.agentPreset 有值）时才比较；
 * 3) 只有能确认是浏览器手动新建（reqKind === 'browser' 或等价手动/UI 特征）时才拒绝。
 */
export function evaluateRelayPrepare(id, opts, s, ctxInfo = {}) {
  const meta = opts && typeof opts === 'object' ? opts.meta : undefined
  const metaCwd = meta && typeof meta === 'object' ? meta.cwd : undefined
  const cwdMatch = Boolean(metaCwd && s && s.cwd && sameDir(metaCwd, s.cwd))
  if (!s) return { ok: false, reason: 'no_slot', slotStatus: 'none', cwdMatch: false }
  if (!s.active) return { ok: false, reason: 'slot_inactive', slotStatus: 'inactive', cwdMatch }
  if (s.used) return { ok: false, reason: 'slot_used', slotStatus: 'used', cwdMatch }
  const now = ctxInfo.now ?? Date.now()
  if (now < s.createdAt || now > s.expiresAt) {
    return { ok: false, reason: 'slot_expired', slotStatus: 'expired', cwdMatch }
  }
  const slotStatus = 'active'
  if (typeof id !== 'string' || !id || id.startsWith('ingest-')) {
    return { ok: false, reason: 'invalid_or_ingest_id', slotStatus, cwdMatch }
  }
  if (!opts || typeof opts !== 'object') {
    return { ok: false, reason: 'invalid_opts', slotStatus, cwdMatch: false }
  }
  if (opts.seed !== undefined) {
    return { ok: false, reason: 'has_seed', slotStatus, cwdMatch }
  }
  if (opts.manual === true) {
    return { ok: false, reason: 'manual_opt', slotStatus, cwdMatch }
  }
  if (!meta || typeof meta !== 'object' || !meta.cwd) {
    return { ok: false, reason: 'missing_cwd', slotStatus, cwdMatch: false }
  }
  if (!cwdMatch) {
    return { ok: false, reason: 'cwd_mismatch', slotStatus, cwdMatch: false }
  }
  if (meta.parentSession != null && meta.parentSession !== '') {
    return { ok: false, reason: 'has_parentSession', slotStatus, cwdMatch }
  }
  if (meta.origin != null && meta.origin !== '') {
    return { ok: false, reason: 'has_origin', slotStatus, cwdMatch }
  }
  if (meta.seedLength !== undefined || meta.delegationDepth !== undefined) {
    return { ok: false, reason: 'has_seed_or_delegation', slotStatus, cwdMatch }
  }
  if (s.agentPreset != null && s.agentPreset !== '' && (meta.agentPreset ?? undefined) !== s.agentPreset) {
    return { ok: false, reason: 'agentPreset_mismatch', slotStatus, cwdMatch }
  }
  const reqKind = ctxInfo.reqKind
  if (reqKind === 'browser') {
    return { ok: false, reason: 'browser_request', slotStatus, cwdMatch }
  }
  const init = opts.initiator || opts.source || meta.initiator || meta.source || meta.client
  if (init && /^(user|web|browser|gui|manual|human)$/i.test(String(init))) {
    return { ok: false, reason: `manual_initiator:${init}`, slotStatus, cwdMatch }
  }
  const stack = String(ctxInfo.stack || '')
  if (/\b(startIngest|connectWorkspace|startSession|forkSession|manualCreate|userCreate)\b/.test(stack)) {
    return { ok: false, reason: 'manual_stack', slotStatus, cwdMatch }
  }
  return { ok: true, reason: 'matched', slotStatus, cwdMatch }
}

export function isRelayPrepare(id, opts, s, ctxInfo = {}) {
  return evaluateRelayPrepare(id, opts, s, ctxInfo).ok
}

function withLocalTimeout(promise, ms, label = 'timeout') {
  if (!(ms > 0)) return Promise.resolve(promise)
  let timer
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 将时间戳（数字毫秒或 ISO 字符串）解析为毫秒数；无法解析返回 undefined。 */
export function parseTimeMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return undefined
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      if (Number.isFinite(n)) return n
    }
    const t = Date.parse(s)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

/**
 * 判定 relay 快照是否处于真正终态。
 * 注意：relay 在 run 超过 runStallMs 无进展但会话仍在运行时会置 status='needs_attention' 且 attentionReason='run_stalled'；
 * 此时会话并未结束（后续有新事件会恢复 running），不应视为终态提前结束后台 job。
 */
export function isTerminalSnap(snap) {
  if (!snap || typeof snap !== 'object') return false
  const st = snap.status
  if (!TERMINAL.has(st)) return false
  if (st === 'needs_attention' && snap.attentionReason === 'run_stalled' && !snap.finishedAt) return false
  return true
}

/** 检查宿主中的子会话是否已停止运行（agent.status==='idle' 或最新 turn 已有 turn/end）。 */
export function isChildSessionTerminated(ctx, sessionId) {
  if (!sessionId || !ctx || typeof ctx.get !== 'function') return false
  try {
    const agents = ctx.get('agents')
    const childAgent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (childAgent && childAgent.status === 'idle') return true
    const sessions = ctx.get('sessions')
    const childSession = (sessions && typeof sessions.get === 'function' && sessions.get(sessionId)) || (childAgent && childAgent.session)
    const events = childSession && Array.isArray(childSession.events) ? childSession.events : undefined
    if (events && events.length) {
      let lastStartIdx = -1
      let lastEndIdx = -1
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (!e || typeof e !== 'object') continue
        if (e.type === 'turn/start') lastStartIdx = i
        else if (e.type === 'turn/end') lastEndIdx = i
      }
      if (lastEndIdx >= 0 && lastEndIdx > lastStartIdx) return true
    }
  } catch {}
  return false
}

/**
 * 识别 relay run 是否已取消：
 * 1) snap.status === 'cancelled'
 * 2) snap.cancelRequested === true 且已终止（snap 已终态 / finishedAt 已存在 / 宿主子会话已结束）
 * 3) snap.cancelRequested === true 但卡在工具调用等仍为 running，且距首次观测 cancelRequested 超过 cancelGraceMs（默认 1 分钟）
 */
export function isRunCancelled(snap, opts = {}) {
  const now = opts.now ?? Date.now()
  const cancelGraceMs = opts.cancelGraceMs ?? DEFAULTS.cancelGraceMs
  if (!snap || typeof snap !== 'object') return { cancelled: false, cancelRequestedAt: null }
  if (snap.status === 'cancelled') {
    return { cancelled: true, reason: 'status=cancelled', cancelRequestedAt: opts.cancelRequestedAt ?? null }
  }
  if (snap.cancelRequested === true) {
    const terminated = isTerminalSnap(snap) ||
      Boolean(snap.finishedAt) ||
      snap.running === false ||
      snap.sessionRunning === false ||
      Boolean(opts.sessionTerminated)
    const reqAt = opts.cancelRequestedAt ?? parseTimeMs(snap.cancelRequestedAt ?? snap.canceledAt) ?? now
    if (terminated) {
      return { cancelled: true, reason: 'cancelRequested 且已终止', cancelRequestedAt: reqAt }
    }
    if (now - reqAt >= cancelGraceMs) {
      return { cancelled: true, reason: `cancelRequested 超过 ${Math.max(1, Math.round(cancelGraceMs / 1000))}s 仍未终止`, cancelRequestedAt: reqAt }
    }
    return { cancelled: false, cancelRequestedAt: reqAt }
  }
  return { cancelled: false, cancelRequestedAt: null }
}

/** 生成取消结论文本：保证包含「已取消」，同时保留已有的 assistantText/error。 */
export function buildCancelConclusion(snap, reason) {
  const raw = fullConclusion(snap)
  const tag = reason ? `已取消（${reason}）` : '已取消'
  if (!raw || raw === '(无)') return tag
  if (raw.includes('已取消')) return raw
  return `${tag}\n${raw}`
}

/** 从子会话事件列表或 relay 快照中提取最后一个工具调用名（若能拿到）。 */
export function extractLastToolName(snap, session) {
  const events = (session && Array.isArray(session.events) && session.events) ||
    (snap && Array.isArray(snap.events) && snap.events) ||
    null
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (!e || typeof e !== 'object') continue
      if (e.type === 'tool/call') {
        const n = (e.data && e.data.name) || e.name
        if (typeof n === 'string' && n.trim()) return n.trim()
      }
      if (e.type === 'assistant/message') {
        const content = (e.data && e.data.message && e.data.message.content) || (e.data && e.data.content) || e.content
        if (Array.isArray(content)) {
          for (let j = content.length - 1; j >= 0; j--) {
            const b = content[j]
            if (b && (b.type === 'tool-call' || b.type === 'tool_use' || b.type === 'toolCall') && typeof b.name === 'string' && b.name.trim()) {
              return b.name.trim()
            }
          }
        }
      }
      if (e.type === 'assistant/chunk') {
        const ch = e.data && e.data.chunk
        if (ch && ch.type === 'tool-call-delta' && typeof ch.name === 'string' && ch.name.trim()) {
          return ch.name.trim()
        }
      }
    }
  }
  if (snap && typeof snap === 'object') {
    const direct = snap.lastToolName || (snap.lastToolCall && snap.lastToolCall.name) || (typeof snap.lastToolCall === 'string' ? snap.lastToolCall : undefined) || snap.lastTool
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
  }
  return undefined
}

/** 获取子会话最后一个事件的时间戳（毫秒）。 */
export function getLatestSessionEventTime(session) {
  if (!session || !Array.isArray(session.events) || !session.events.length) return undefined
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i]
    const t = parseTimeMs(e && (e.time ?? e.time0 ?? (e.data && e.data.time)))
    if (t !== undefined) return t
  }
  return undefined
}

/** 构造停滞提醒通知文本：包含 runId、会话链接、已无进展时长、最后一个工具调用名。 */
export function formatStallNotice({ runId, webUrl, stalledMs, lastToolName, jobId }) {
  const mins = Math.floor(Math.max(0, stalledMs) / 60000)
  const secs = Math.max(1, Math.round(Math.max(0, stalledMs) / 1000))
  const durationStr = mins >= 1 ? `${mins} 分钟` : `${secs} 秒（约 ${(Math.max(0, stalledMs) / 60000).toFixed(1)} 分钟）`
  const urlStr = webUrl || '(无)'
  const toolStr = lastToolName || '(未获取到)'
  return `[relay_dispatch 卡死提醒] runId=${runId || '?'}${jobId ? ` (jobId=${jobId})` : ''} 已无进展 ${durationStr}；会话链接：${urlStr}；最后一个工具调用：${toolStr}。（后台 job 仍在继续等待，未结束）`
}

/**
 * 向发起派发的主会话发送中途提醒通知（不结束后台 job）。
 * 说明：主会话忙碌时也统一走 followup 排队等空闲投递，不使用 inject 插话打断。
 */
export function sendSessionNotice(ctx, agent, text, summary = 'relay-dispatch notice') {
  const sum = String(summary || 'relay-dispatch notice')
  const boundSum = sum.length <= 120 ? sum : `${sum.slice(0, 119)}…`
  const message = {
    id: `relay-dispatch-notice-${Date.now()}-${++seq}`,
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: {
      kind: 'plugin',
      plugin: 'relay-dispatch',
      form: 'notice',
      summary: boundSum,
    },
  }
  const target = (agent && (typeof agent.followup === 'function' || typeof agent.steer === 'function'))
    ? agent
    : (agent && agent.id && ctx && typeof ctx.get === 'function' && ctx.get('agents') && typeof ctx.get('agents').get === 'function'
      ? ctx.get('agents').get(agent.id)
      : undefined)
  if (!target) return false
  if (typeof target.followup === 'function') {
    target.followup(message)
    return true
  }
  if (typeof target.steer === 'function') {
    target.steer(message)
    return true
  }
  return false
}

/** 识别后台等待轮询 relay 状态时的瞬时网络/传输错误（可连续重试）。 */
export function isTransientPollError(err) {
  const s = String((err && err.message) || err || '')
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|connection (failed|refused|reset|closed)|timed? ?out|\b50[234]\b/i.test(s)
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig || {}) }
  const tools = ctx.tools
  const dispatchAls = new AsyncLocalStorage()
  const httpAls = new AsyncLocalStorage()
  let disposed = false
  let slot = null
  let startChain = Promise.resolve()
  const activeStarts = new Set()
  const titleTasks = new Set()

  const emitWarn = (msg) => {
    try {
      if (typeof config.onWarn === 'function') config.onWarn(msg)
      const logger = (ctx && ctx.logger) || (ctx && typeof ctx.get === 'function' && ctx.get('logger'))
      if (logger && typeof logger.warn === 'function') logger.warn(msg)
      else console.warn(msg)
    } catch {}
  }

  const logPath = config.parentLogPath === undefined ? PARENT_LOG_PATH : config.parentLogPath
  let logDirEnsured = false
  const logParent = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`
    try {
      if (typeof config.onParentLog === 'function') config.onParentLog(line)
      if (logPath) {
        if (!logDirEnsured) {
          mkdirSync(dirname(logPath), { recursive: true })
          logDirEnsured = true
        }
        appendFileSync(logPath, `${line}\n`, 'utf8')
      }
    } catch {}
  }

  ctx.effect(() => () => {
    disposed = true
    if (slot) slot.active = false
    slot = null
    startChain = Promise.resolve()
    for (const cancel of [...activeStarts]) {
      try { cancel(new Error('relay_dispatch disposed')) } catch {}
    }
    activeStarts.clear()
    for (const cancel of [...titleTasks]) {
      try { cancel() } catch {}
    }
    titleTasks.clear()
  })

  if (config.linkParentSession !== false) {
    try {
      const ws = (ctx && ctx.webServer) || (ctx && typeof ctx.get === 'function' && ctx.get('webServer'))
      const apiRoute = ws && ws.prefixes && typeof ws.prefixes.get === 'function' && ws.prefixes.get('/api')
      if (apiRoute && typeof apiRoute.handler === 'function') {
        let apiState = apiRoute[API_HANDLER_SYM]
        if (!apiState || typeof apiState.orig !== 'function') {
          apiState = { orig: apiRoute.handler, generation: 0 }
          apiRoute[API_HANDLER_SYM] = apiState
        } else {
          apiRoute.handler = apiState.orig
        }
        const myApiGen = ++apiState.generation
        const origHandler = apiState.orig
        const wrappedHandler = function (req, res) {
          const kind = classifyApiRequest(req && req.headers)
          return httpAls.run(kind, () => origHandler.call(this, req, res))
        }
        apiRoute.handler = wrappedHandler
        ctx.effect(() => () => {
          if (apiRoute[API_HANDLER_SYM] && apiRoute[API_HANDLER_SYM].generation === myApiGen) {
            apiRoute.handler = origHandler
          }
        })
      }
    } catch {}
    try {
      const sess = ctx.get('sessions')
      if (sess && typeof sess.prepare === 'function') {
        let prepState = sess[PREPARE_SYM]
        if (!prepState || typeof prepState.orig !== 'function') {
          prepState = { orig: sess.prepare, generation: 0 }
          sess[PREPARE_SYM] = prepState
        } else {
          sess.prepare = prepState.orig
        }
        const myGen = ++prepState.generation
        const orig = prepState.orig
        const wrapped = function (id, opts) {
          try {
            const s = slot
            const stack = new Error().stack || ''
            const inDispatchContext = Boolean(s && dispatchAls.getStore() === s)
            const reqKind = httpAls.getStore()
            const verdict = evaluateRelayPrepare(id, opts, s, { inDispatchContext, reqKind, stack })
            let injectedParent = 'none'
            if (verdict.ok && s) {
              const cleanOpts = { ...opts }
              delete cleanOpts.relay
              delete cleanOpts.initiator
              delete cleanOpts.source
              const cleanMeta = { ...opts.meta, parentSession: s.parent }
              delete cleanMeta.initiator
              delete cleanMeta.source
              delete cleanMeta.client
              s.used = true
              s.sessionId = id
              injectedParent = s.parent
              opts = { ...cleanOpts, meta: cleanMeta }
            }
            logParent(
              `prepare gen=${myGen} id=${id || '?'} slot=${verdict.slotStatus} cwdMatch=${verdict.cwdMatch} ` +
              `result=${verdict.ok ? 'inject' : 'reject'} reason=${verdict.reason} parentSession=${injectedParent}`
            )
          } catch (err) {
            logParent(`prepare gen=${myGen} id=${id || '?'} slot=error cwdMatch=false result=reject reason=error:${(err && err.message) || err} parentSession=none`)
          }
          return orig.call(this, id, opts)
        }
        sess.prepare = wrapped
        logParent(`wrapper installed generation=${myGen}`)
        ctx.effect(() => () => {
          if (sess[PREPARE_SYM] && sess[PREPARE_SYM].generation === myGen) {
            sess.prepare = orig
          }
        })
      }
    } catch { /* sessions 不可用：不关联，照常派发 */ }
  }

  /** 带 parentSession 的会话不走首条消息自动标题：立即写入去掉 taskPrefix 的任务正文标题，随后尝试一次 LLM 标题刷新（可取消，dispose 时停止，refresh 带本地超时）。 */
  function scheduleTitle(id, rawTask, prefix) {
    if (config.refreshTitle === false || disposed) return { cancel: () => {} }
    const fallback = cleanBodyTitle(rawTask, prefix)
    let cancelled = false
    let wakeTimer = null
    let wakeResolve = null
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      if (wakeTimer !== null) { clearTimeout(wakeTimer); wakeTimer = null }
      if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r() }
      titleTasks.delete(cancel)
    }
    titleTasks.add(cancel)
    const maxAttempts = config.titlePollMaxAttempts ?? 40
    const firstMs = config.titlePollFirstMs ?? 400
    const intervalMs = config.titlePollIntervalMs ?? 3000
    const refreshTimeoutMs = config.titleRefreshTimeoutMs ?? 15000
    const sleep = (ms) => new Promise((resolve) => {
      if (cancelled || disposed) { resolve(); return }
      wakeResolve = resolve
      wakeTimer = setTimeout(() => { wakeTimer = null; wakeResolve = null; resolve() }, ms)
    })
    ;(async () => {
      let seeded = false
      try {
        for (let i = 0; i < maxAttempts; i++) {
          await sleep(i === 0 ? firstMs : intervalMs)
          if (cancelled || disposed) return
          try {
            const session = (ctx.get('sessions') && ctx.get('sessions').get(id)) || (ctx.get('agents') && ctx.get('agents').get(id) && ctx.get('agents').get(id).session)
            const titles = ctx.get('sessionTitle')
            if (!session || !titles) continue
            if (!seeded && fallback && typeof titles.rename === 'function') {
              try { titles.rename(session, fallback); seeded = true } catch {}
            }
            if (!(session.events || []).some((e) => e && e.type === 'user/message')) continue
            if (!(session.events || []).some((e) => e && e.type === 'request/header')) continue
            if (cancelled || disposed) return
            if (typeof titles.refresh === 'function') {
              await withLocalTimeout(titles.refresh(session), refreshTimeoutMs, 'sessionTitle.refresh timeout')
            }
            return
          } catch {
            if (seeded) return
          }
        }
      } finally {
        titleTasks.delete(cancel)
      }
    })().catch(() => {})
    return { cancel }
  }

  /** 串行化 start 调用：同一时刻只有一个槽，并发派发不会串号；单次调用带超时并在超时/dispose 时清槽释放队列。 */
  function startLinked(toolName, args, exec, rawTask, prefix) {
    if (disposed) return Promise.reject(new Error('relay_dispatch plugin disposed'))
    const parent = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.id
    const canLink = Boolean(parent && args && args.workspace && !args.sessionId && config.linkParentSession !== false)
    const timeoutMs = config.startTimeoutMs ?? 120000
    const windowMs = config.slotWindowMs ?? timeoutMs

    const run = async () => {
      if (disposed) throw new Error('relay_dispatch plugin disposed')
      const now = Date.now()
      const my = canLink
        ? {
            parent,
            cwd: args.workspace,
            agentPreset: args.agentPreset,
            createdAt: now,
            expiresAt: now + windowMs,
            active: true,
            used: false,
          }
        : null
      if (my) slot = my
      const callAbort = new AbortController()
      const extSignal = exec && exec.signal
      const onExtAbort = () => callAbort.abort(extSignal.reason || new Error('aborted'))
      if (extSignal) {
        if (extSignal.aborted) onExtAbort()
        else extSignal.addEventListener('abort', onExtAbort, { once: true })
      }
      let timer = null
      let rejectWait = null
      const clearSlot = () => {
        if (my) {
          my.active = false
          if (slot === my) slot = null
        }
      }
      const abortRun = (err) => {
        clearSlot()
        try { callAbort.abort(err) } catch {}
        if (rejectWait) { const r = rejectWait; rejectWait = null; r(err) }
      }
      activeStarts.add(abortRun)
      const raceWait = new Promise((_, reject) => {
        rejectWait = reject
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            abortRun(new Error(`start_run 超时（>${timeoutMs}ms）`))
          }, timeoutMs)
        }
      })
      let started
      try {
        const execCall = () => call(toolName, args, exec && exec.agent, callAbort.signal)
        started = await Promise.race([
          my ? dispatchAls.run(my, execCall) : execCall(),
          raceWait,
        ])
        if (my && my.sessionId) {
          const retSid = (started && (typeof started.sessionId === 'string' ? started.sessionId : (started.run && typeof started.run.sessionId === 'string' ? started.run.sessionId : undefined))) || undefined
          if (retSid && retSid !== my.sessionId) {
            const warnMsg = `[relay-dispatch] parentSession 注入会话 (${my.sessionId}) 与 start_run 返回 sessionId (${retSid}) 不一致`
            emitWarn(warnMsg)
            if (started && typeof started === 'object') started.__parentMismatchWarning = warnMsg
          } else {
            scheduleTitle(my.sessionId, rawTask, prefix)
          }
        }
        return started
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (extSignal) { try { extSignal.removeEventListener('abort', onExtAbort) } catch {} }
        activeStarts.delete(abortRun)
        clearSlot()
      }
    }
    const p = startChain.then(run, run)
    startChain = p.then(() => undefined, () => undefined)
    return p
  }

  async function call(toolName, args, agent, signal) {
    const result = await tools.execute({
      callId: `relay-dispatch-${Date.now()}-${++seq}`,
      name: toolName,
      arguments: args,
      ...(agent ? { agent } : {}),
      signal,
    })
    return parseResult(result)
  }

  ctx.effect(() => tools.register({
    name: 'relay_dispatch',
    description:
      '派发 Harness relay 任务并在后台等待：立即返回 jobId，结束时通过 job 完成通知回传精简结论。' +
      '【startArgs 默认值】最少只需 workspace+task（workspace 须为 Harness 已注册工作区）。未传时自动补：provider/model=' + config.defaultProvider + '/' + config.defaultModel +
      '；sessionMode=fresh；authorizationBasis=explicit-user-request；reviewTargets 与 contextReadScope=[workspace]；permissionPreset 为 workspace-write/danger-full-access 且无 writeScope 时 writeScope=[workspace]；danger-full-access 时 confirmedDangerousPermission=true；' +
      'agentPreset 可透传' + (config.defaultAgentPreset ? '（默认 ' + config.defaultAgentPreset + '）' : '（默认不设，用官方 preset）') + '；显式传入的字段不被覆盖。' +
      '【mode】可选：investigate/implement/verify/review/heavy（键取自 ~/.dsh/dispatch-modes.yaml，每次派发热读）；套用其 permission/workspace/agentPreset/reasoningEffort，并拼 taskPrefix+task+deliverable；未显式给 provider/model 时按 models 候选链依次尝试（跳过不存在的模型，start_run 报错换下一个）；返回里写明实际模型。最简用法：{mode, startArgs:{workspace, task}}。' +
      '派发后不要调用 wait_run 或 job_output 轮询；没有其他活就直接结束本轮。',
    parameters: {
      type: 'object',
      properties: {
        startArgs: {
          type: 'object',
          additionalProperties: true,
          description: '原样传给 start_run（review=true 时为 start_review）的参数对象，如 workspace/task/provider/model 等',
        },
        mode: { type: 'string', description: '派发模式名（见 dispatch-modes.yaml）；不给则保持原行为' },
        review: { type: 'boolean', description: 'true 时改用 start_review（只读审查）' },
        maxWaitMinutes: { type: 'integer', description: '后台最长等待分钟数（缺省 240）' },
      },
      required: ['startArgs'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `已派发 runId=${value.runId}，后台等待中（jobId=${value.jobId}）。` +
          (value.webUrl ? ` 会话：${value.webUrl}。` : '') +
          ' ' + (value.note || '') + ' 结束时会收到通知，不要轮询。',
      }],
    },
    async execute(args, exec) {
      const jobs = ctx.get('jobs')
      if (!jobs) throw new Error('background jobs unavailable')
      const startTool = args.review ? TOOL_START_REVIEW : TOOL_START_RUN
      const notes = []
      const rawTask = args.startArgs && args.startArgs.task
      let modePrefix = ''
      let baseArgs = args.startArgs
      let candidates = []
      let modeName
      if (args.mode) {
        const { modes, warning, aliases } = loadModes(config.modesPath || MODES_PATH)
        if (warning) notes.push(warning)
        const cfg = modes[args.mode]
        if (!cfg) throw new Error(`未知 mode: ${args.mode}；可用：${Object.keys(modes).join(', ')}`)
        modeName = args.mode
        modePrefix = (cfg && cfg.taskPrefix) || ''
        const r = applyMode(cfg, args.startArgs, aliases || {})
        baseArgs = r.args
        candidates = r.candidates
        if (!baseArgs || !baseArgs.workspace) throw new Error('mode=' + args.mode + ' 需要 startArgs.workspace（该模式未配置默认 workspace）；请传入已注册工作区路径。')
        if (candidates.length) {
          try {
            const ids = collectModelIds(await call(TOOL_CAPS, {}, exec.agent, exec.signal))
            if (ids) {
              const kept = []
              for (const c of candidates) {
                if (ids.has(`${c.provider}/${c.model}`)) kept.push(c)
                else notes.push(`跳过 ${c.provider}/${c.model}：能力列表中不存在`)
              }
              if (kept.length) candidates = kept
              else notes.push('候选均不在能力列表中，仍按原链依次尝试')
            }
          } catch (e) { notes.push(`list_capabilities 失败，未过滤候选：${(e && e.message) || e}`) }
        }
      }
      const attempts = candidates.length ? candidates : [null]
      let started, used
      let lastErr
      for (let i = 0; i < attempts.length; i++) {
        const c = attempts[i]
        const sa = c ? { ...baseArgs, provider: c.provider, model: c.model } : baseArgs
        try {
          started = await startLinked(startTool, fillStartArgs(sa, config, !!args.review), exec, rawTask, modePrefix)
          if (started && started.__parentMismatchWarning) notes.push(started.__parentMismatchWarning)
          used = c ? `${c.provider}/${c.model}` : `${sa.provider || config.defaultProvider}/${sa.model || config.defaultModel}`
          lastErr = undefined
          break
        } catch (err) {
          let msg = String((err && err.message) || err)
          if (/not registered in Harness|outside DSH_RELAY_ALLOWED/i.test(msg)) {
            try {
              const ws = await call(TOOL_LIST_WS, {}, exec.agent, exec.signal)
              const paths = ((ws && (ws.items || ws.workspaces)) || []).map((w) => w.path).filter(Boolean)
              if (paths.length) msg += '\n已注册工作区：' + paths.join('; ')
            } catch {}
            lastErr = new Error(msg); break // 工作区问题换模型无意义
          }
          lastErr = new Error(msg)
          if (c && !isModelError(msg)) break // 请求/环境类错误：换模型无意义
          if (c) notes.push(`跳过 ${c.provider}/${c.model}：启动失败 ${clip(msg, 200)}`)
          if (exec.signal && exec.signal.aborted) break
        }
      }
      if (lastErr) {
        let extra = ''
        if (isModelError(lastErr.message)) {
          try {
            const ids = collectModelIds(await call(TOOL_CAPS, {}, exec.agent, exec.signal))
            extra = ids ? '\n可用 provider/model：' + [...ids].join(', ') : '\n无法取得可用模型列表（能力列表无法解析）'
          } catch { extra = '\n无法取得可用模型列表（list_capabilities 失败）' }
        }
        throw new Error(lastErr.message + (notes.length ? '\n' + notes.join('\n') : '') + extra)
      }
      const modelNote = `实际使用：${used}` + (modeName ? `（mode=${modeName}）` : '') + (notes.length ? '；' + notes.join('；') : '')
      const runId = (started && (started.runId || (started.run && started.run.runId))) || undefined
      if (!runId) throw new Error(`start 未返回 runId：${clip(started, 600)}`)
      const webUrl = started.webUrl
      const getNow = typeof config.now === 'function' ? config.now : () => Date.now()
      const stallMinutes = args.stallMinutes != null ? args.stallMinutes : config.stallMinutes
      const stallMs = config.stallMs != null ? config.stallMs : (stallMinutes != null ? stallMinutes * 60000 : DEFAULTS.stallMinutes * 60000)
      const cancelGraceMs = config.cancelGraceMs ?? config.cancelTimeoutMs ?? DEFAULTS.cancelGraceMs
      const deadline = getNow() + (args.maxWaitMinutes || config.maxWaitMinutes) * 60000
      const agent = exec.agent
      let jobId

      jobId = jobs.start({
        kind: 'relay-dispatch',
        label: `relay ${String(runId).slice(0, 8)}`,
        owner: agent,
        run: () => {
          const abort = new AbortController()
          let cancelled = false
          let pending = ''
          const finish = (r) => { pending += (r.output || '') + '\n' + modelNote; return r }
          const done = (async () => {
            let snap = started
            let cancelRequestedAt = snap && snap.cancelRequested ? (parseTimeMs(snap.cancelRequestedAt ?? snap.canceledAt) ?? getNow()) : null
            let cancelReason = null
            let cancelledRun = false
            const resolveChildSession = (s) => {
              const sid = (s && s.sessionId) || (started && (started.sessionId || (started.run && started.run.sessionId)))
              if (!sid || !ctx || typeof ctx.get !== 'function') return { sid, session: undefined }
              try {
                const sessSvc = ctx.get('sessions')
                const agSvc = ctx.get('agents')
                const session = (sessSvc && typeof sessSvc.get === 'function' && sessSvc.get(sid)) ||
                  (agSvc && typeof agSvc.get === 'function' && agSvc.get(sid) && agSvc.get(sid).session) ||
                  undefined
                return { sid, session }
              } catch {
                return { sid, session: undefined }
              }
            }
            const initChild = resolveChildSession(snap)
            let lastSnapProgMs = parseTimeMs(snap && (snap.lastProgressAt ?? snap.updatedAt))
            let lastSessProgMs = getLatestSessionEventTime(initChild.session)
            let lastProgressMs = lastSnapProgMs ?? lastSessProgMs ?? parseTimeMs(snap && snap.startedAt) ?? getNow()
            let lastSeq = snap && typeof snap.lastEventSeq === 'number' ? snap.lastEventSeq : undefined
            let lastTextLen = snap && typeof snap.assistantText === 'string' ? snap.assistantText.length : 0
            let hadSession = Boolean(initChild.session && Array.isArray(initChild.session.events))
            let lastEvCount = hadSession ? initChild.session.events.length : 0
            let stallNotified = false
            const maxPollRetries = config.waitMaxRetries ?? DEFAULTS.waitMaxRetries
            const pollRetryDelayMs = config.waitRetryDelayMs ?? DEFAULTS.waitRetryDelayMs
            const waitRetrySleep = (ms) => new Promise((resolve) => {
              if (!(ms > 0) || abort.signal.aborted) { resolve(); return }
              let t
              const onAbort = () => { clearTimeout(t); resolve() }
              abort.signal.addEventListener('abort', onAbort, { once: true })
              t = setTimeout(() => {
                abort.signal.removeEventListener('abort', onAbort)
                resolve()
              }, ms)
            })

            try {
              while (!abort.signal.aborted) {
                const nowBefore = getNow()
                const remaining = deadline - nowBefore
                if (remaining <= 0) {
                  return {
                    status: 'failed',
                    detail: 'wait timeout',
                    output: `后台等待超时（任务未取消）。\n${summarize(snap, config.maxResultChars)}`,
                  }
                }
                let sliceTimeout = Math.min(config.sliceMs, remaining)
                if (cancelRequestedAt != null) {
                  sliceTimeout = Math.min(sliceTimeout, Math.max(1, cancelGraceMs - Math.max(0, nowBefore - cancelRequestedAt)))
                }
                if (stallMs > 0 && !stallNotified) {
                  sliceTimeout = Math.min(sliceTimeout, Math.max(1, stallMs - Math.max(0, nowBefore - lastProgressMs)))
                }
                let pollAttempt = 0
                while (true) {
                  try {
                    snap = await call(TOOL_WAIT, { runId, timeoutMs: sliceTimeout }, agent, abort.signal)
                    break
                  } catch (pollErr) {
                    if (abort.signal.aborted || !isTransientPollError(pollErr) || pollAttempt >= maxPollRetries) {
                      throw pollErr
                    }
                    pollAttempt++
                    await waitRetrySleep(pollRetryDelayMs)
                    if (abort.signal.aborted) throw pollErr
                  }
                }
                const nowAfter = getNow()
                const { sid, session: childSession } = resolveChildSession(snap)
                const sessionTerminated = isChildSessionTerminated(ctx, sid)
                const cRes = isRunCancelled(snap, {
                  cancelRequestedAt,
                  now: nowAfter,
                  cancelGraceMs,
                  sessionTerminated,
                })
                cancelRequestedAt = cRes.cancelRequestedAt
                if (cRes.cancelled) {
                  cancelledRun = true
                  cancelReason = cRes.reason || null
                  break
                }
                if (isTerminalSnap(snap)) break

                // 进展跟踪与停滞提醒（不结束 job；同一停滞周期只提醒一次，恢复进展后重置）
                const snapProgMs = parseTimeMs(snap && (snap.lastProgressAt ?? snap.updatedAt))
                const sessProgMs = getLatestSessionEventTime(childSession)
                const curSeq = snap && typeof snap.lastEventSeq === 'number' ? snap.lastEventSeq : undefined
                const curTextLen = snap && typeof snap.assistantText === 'string' ? snap.assistantText.length : 0
                const hasCurSess = Boolean(childSession && Array.isArray(childSession.events))
                const curEvCount = hasCurSess ? childSession.events.length : 0
                const seqAdvanced = curSeq !== undefined && lastSeq !== undefined && curSeq > lastSeq
                const textAdvanced = curTextLen > lastTextLen
                const evAdvanced = hadSession && hasCurSess && curEvCount > lastEvCount
                const snapTsAdvanced = snapProgMs !== undefined && lastSnapProgMs !== undefined && snapProgMs > lastSnapProgMs
                const sessTsAdvanced = sessProgMs !== undefined && lastSessProgMs !== undefined && sessProgMs > lastSessProgMs
                const progressed = seqAdvanced || textAdvanced || evAdvanced || snapTsAdvanced || sessTsAdvanced

                if (curSeq !== undefined) lastSeq = curSeq
                if (curTextLen > lastTextLen) lastTextLen = curTextLen
                if (hasCurSess) { hadSession = true; lastEvCount = curEvCount }
                if (snapProgMs !== undefined) lastSnapProgMs = snapProgMs
                if (sessProgMs !== undefined) lastSessProgMs = sessProgMs

                const authProgMs = (snapProgMs !== undefined && sessProgMs !== undefined)
                  ? Math.max(snapProgMs, sessProgMs)
                  : (snapProgMs ?? sessProgMs)
                if (progressed) {
                  stallNotified = false
                  lastProgressMs = (snapTsAdvanced || sessTsAdvanced) && authProgMs !== undefined
                    ? authProgMs
                    : Math.max(authProgMs ?? 0, nowAfter)
                } else if (authProgMs !== undefined) {
                  lastProgressMs = authProgMs
                }

                const stalledMs = nowAfter - lastProgressMs
                if (stallMs > 0 && !stallNotified && stalledMs >= stallMs) {
                  stallNotified = true
                  const lastToolName = extractLastToolName(snap, childSession)
                  const baseUrl = config.webBaseUrl || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
                  const effectiveWebUrl = (snap && snap.webUrl) || webUrl || (sid ? `${baseUrl.replace(/\/$/, '')}/?sessionId=${sid}` : undefined)
                  const noticeText = formatStallNotice({
                    runId,
                    webUrl: effectiveWebUrl,
                    stalledMs,
                    lastToolName,
                    jobId,
                  })
                  try {
                    sendSessionNotice(ctx, agent, noticeText, `relay ${String(runId).slice(0, 8)} 卡死提醒`)
                    if (typeof config.onStallNotice === 'function') {
                      config.onStallNotice({ runId, jobId, webUrl: effectiveWebUrl, stalledMs, lastToolName, text: noticeText })
                    }
                  } catch {}
                }
              }
              if (cancelled || cancelledRun || (snap && snap.status === 'cancelled')) {
                const output = buildCancelConclusion(snap, cancelReason)
                const deliv = buildDelivery('cancelled', output)
                return { status: 'cancelled', ...deliv, output }
              }
              const output = fullConclusion(snap)
              const ok = snap && snap.status === 'succeeded'
              const deliv = buildDelivery(String(snap && snap.status), output)
              return { status: ok ? 'completed' : 'failed', ...deliv, output }
            } catch (err) {
              if (cancelled || cancelledRun || (snap && snap.status === 'cancelled')) {
                const output = buildCancelConclusion(snap, cancelReason)
                const deliv = buildDelivery('cancelled', output)
                return { status: 'cancelled', ...deliv, output }
              }
              const output = fullConclusion(snap)
              return { status: 'failed', detail: String((err && err.message) || err), output }
            }
          })().then(finish)
          return {
            cancel: () => {
              if (cancelled) return
              cancelled = true
              abort.abort('cancelled')
              call(TOOL_CANCEL, { runId }, agent, new AbortController().signal).catch(() => {})
            },
            done,
            // 只在结束后一次性给出精简结论；运行中不吐任何中间输出。
            readOutput: () => { const t = pending; pending = ''; return t },
          }
        },
      })
      return { jobId, runId, model: used, note: modelNote, ...(webUrl ? { webUrl } : {}) }
    },
  }))
}
