/**
 * @dsh-external/dsh-relay-dispatch
 * 派发 Harness relay 任务后立即返回，由后台 job 代为等待；任务结束时 DSH 的
 * job 完成通知只带回精简结论（状态 + 截断后的 assistantText），主会话不再循环 wait_run。
 * 纯 JS、零运行时依赖（宿主无 checkout 也能直接注入）。
 */

export const name = '@dsh-external/dsh-relay-dispatch'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const inject = ['tools']
export const PREPARE_SYM = Symbol.for('relay-dispatch.prepare')
export const API_HANDLER_SYM = Symbol.for('relay-dispatch.apiHandler')
export const PARENT_LOG_PATH = join(homedir(), '.dsh', 'relay-dispatch-parent.log')

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
  wakeDelayMs: 300, // 后台 job 结算后检查主会话 idle 未消费通知并补唤醒的延时（毫秒）
  maxConsecutiveWakes: 15, // 插件侧连续自动唤醒主会话的安全上限
  maxConcurrentTasks: 4, // v2 聚合派发的同时运行子任务上限
  manifestDir: undefined, // v2 清单目录；缺省 ~/.dsh/relay-pipelines，测试可覆盖
  llmTitle: false, // v2 默认只做确定性标题，不额外调用 LLM
  defaultProvider: 'copilot',
  defaultModel: 'claude-sonnet-5.5',
  defaultAgentPreset: undefined, // 默认不设，沿用官方 preset；重启测试 standard-lean 后可配置为 'standard-lean'
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
export function buildDelivery(status, text, budget = DETAIL_BUDGET_BYTES, fullTextAvailable = true, machineHeader = '') {
  const s = String(text ?? '').trimStart()
  const fullLength = Array.from(s).length
  const avail = Boolean(fullTextAvailable)
  const st = machineHeader ? `${machineHeader}\nstatus: ${status}` : `status: ${status}`
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
const MODES_PATH = join(homedir(), '.dsh', 'dispatch-modes.yaml')
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
  rp: { permission: 'read-only', workspace: join(homedir(), 'xiaoshuo'), models: ['cursor/grok-4.7', 'strata/qwen3.8-flash-next-iq3_s'], taskPrefix: '', deliverable: '' },
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

/** 检查 agent 信箱中是否仍有未消费消息（兼容 ReactLoopAgent.inbox 与测试 mock）。 */
export function hasPendingInbox(agent) {
  const inbox = agent && agent.inbox
  if (!inbox || typeof inbox !== 'object') return false
  if (inbox.hasPending === true) return true
  if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return true
  if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return true
  return false
}

// ───────── v2：tasks -> join -> gate 的同步预检与写冲突规划 ─────────
export const V2_MACHINE_HEADER = 'relay_dispatch_v2: 1'
const V2_WRITABLE_PRESETS = new Set(['workspace-write', 'danger-full-access'])
const V2_TASK_SHORTCUTS = ['workspace', 'task', 'provider', 'model', 'writeScope']

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

/** 仅用于写范围比较：统一斜杠、去尾部斜杠，Windows/盘符路径忽略大小写。 */
export function writePathKey(raw) {
  let p = String(raw == null ? '' : raw).trim().replace(/[\\/]+/g, '/')
  if (!p) return ''
  const windowsPath = process.platform === 'win32' || /^[A-Za-z]:/.test(p) || p.startsWith('//')
  if (p.length > 1) p = p.replace(/\/+$/g, '')
  if (/^[A-Za-z]:$/.test(p)) p += '/'
  return windowsPath ? p.toLowerCase() : p
}

/** 两个写路径是否相同或互为祖先；必须按完整路径段边界判断，避免 foo 命中 foobar。 */
export function writePathsOverlap(a, b) {
  const pa = writePathKey(a)
  const pb = writePathKey(b)
  if (!pa || !pb) return false
  if (pa === pb) return true
  const aa = pa.endsWith('/') ? pa : `${pa}/`
  const bb = pb.endsWith('/') ? pb : `${pb}/`
  return pa.startsWith(bb) || pb.startsWith(aa)
}

export function writeScopesOverlap(a, b) {
  const left = Array.isArray(a) ? a : []
  const right = Array.isArray(b) ? b : []
  return left.some((x) => right.some((y) => writePathsOverlap(x, y)))
}

function validateGate(gate) {
  if (gate == null) return null
  if (!isPlainObject(gate)) throw new Error('gate 必须是对象')
  if (typeof gate.userAsk !== 'string' || !gate.userAsk.trim()) throw new Error('gate.userAsk 必须是非空字符串')
  if (typeof gate.criteria !== 'string' || !gate.criteria.trim()) throw new Error('gate.criteria 必须是非空字符串')
  if (gate.mode != null && gate.mode !== 'verify') throw new Error("gate.mode 目前仅支持 'verify'")
  if (gate.commands != null && (!Array.isArray(gate.commands) || gate.commands.some((x) => typeof x !== 'string' || !x.trim()))) {
    throw new Error('gate.commands 必须是非空字符串组成的数组')
  }
  if (gate.onPartial != null && gate.onPartial !== 'skip' && gate.onPartial !== 'gate') {
    throw new Error("gate.onPartial 仅支持 'skip' 或 'gate'")
  }
  return { ...gate, mode: 'verify', onPartial: gate.onPartial || 'skip', commands: gate.commands ? [...gate.commands] : [] }
}

/**
 * 在不调用任何 relay 工具、也不注册后台 Job 的前提下展开并校验 v2 参数。
 * 返回的 dependsOn 仅供 onWriteConflict:'serial' 调度；默认 error 会在首个冲突处直接失败。
 */
export function preflightDispatchV2(args, config = DEFAULTS, modesInfo = { modes: BUILTIN_MODES, aliases: {} }) {
  if (!isPlainObject(args)) throw new Error('relay_dispatch 参数必须是对象')
  const hasTasks = args.tasks != null
  if (hasTasks && (!Array.isArray(args.tasks) || args.tasks.length === 0)) throw new Error('tasks 必须是非空数组')
  if (args.startArgs != null && !isPlainObject(args.startArgs)) throw new Error('startArgs 必须是对象')
  if (args.onWriteConflict != null && args.onWriteConflict !== 'error' && args.onWriteConflict !== 'serial') {
    throw new Error("onWriteConflict 仅支持 'error' 或 'serial'")
  }
  const onWriteConflict = args.onWriteConflict || 'error'
  const gate = validateGate(args.gate)
  const items = hasTasks ? args.tasks : [null]
  const tasks = items.map((item, index) => {
    if (item != null && !isPlainObject(item)) throw new Error(`tasks[${index}] 必须是对象`)
    if (item && item.startArgs != null && !isPlainObject(item.startArgs)) throw new Error(`tasks[${index}].startArgs 必须是对象`)
    const merged = { ...(args.startArgs || {}), ...((item && item.startArgs) || {}) }
    if (item) {
      for (const key of V2_TASK_SHORTCUTS) {
        if (item[key] !== undefined) merged[key] = item[key]
      }
    }
    const modeName = (item && item.mode != null ? item.mode : args.mode) || undefined
    const review = Boolean(item && item.review != null ? item.review : args.review)
    const rawTask = merged.task
    let baseArgs = merged
    let candidates = []
    let modePrefix = ''
    if (modeName) {
      const cfg = modesInfo.modes && modesInfo.modes[modeName]
      if (!cfg) throw new Error(`tasks[${index}] 未知 mode: ${modeName}；可用：${Object.keys(modesInfo.modes || {}).join(', ')}`)
      modePrefix = cfg.taskPrefix || ''
      const applied = applyMode(cfg, merged, modesInfo.aliases || {})
      baseArgs = applied.args
      candidates = applied.candidates
    }
    const previewArgs = fillStartArgs(baseArgs, config, review)
    if (typeof previewArgs.workspace !== 'string' || !previewArgs.workspace.trim()) {
      throw new Error(`tasks[${index}] 缺少 workspace（该模式未配置默认 workspace）`)
    }
    if (typeof previewArgs.task !== 'string' || !previewArgs.task.trim()) {
      throw new Error(`tasks[${index}] 缺少非空 task`)
    }
    if (previewArgs.writeScope != null && (!Array.isArray(previewArgs.writeScope) || previewArgs.writeScope.some((p) => typeof p !== 'string' || !p.trim()))) {
      throw new Error(`tasks[${index}].writeScope 必须是非空路径字符串组成的数组`)
    }
    const writable = !review && V2_WRITABLE_PRESETS.has(previewArgs.permissionPreset)
    const label = String((item && item.label) || cleanBodyTitle(rawTask, modePrefix) || `task-${index + 1}`)
    return {
      index,
      label,
      mode: modeName,
      review,
      rawTask,
      modePrefix,
      baseArgs,
      previewArgs,
      candidates,
      workspace: previewArgs.workspace,
      writeScope: writable ? (previewArgs.writeScope || [previewArgs.workspace]) : [],
      writable,
      dependsOn: new Set(),
    }
  })

  const conflicts = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]
      const b = tasks[j]
      if (!a.writable || !b.writable || !sameDir(a.workspace, b.workspace)) continue
      if (!writeScopesOverlap(a.writeScope, b.writeScope)) continue
      conflicts.push({ a: i, b: j })
      if (onWriteConflict === 'error') {
        throw new Error(
          `写范围冲突：tasks[${i}](${a.label}) 与 tasks[${j}](${b.label}) 在同一 workspace 的 writeScope 重叠；` +
          "请缩小 writeScope，或显式设置 onWriteConflict: 'serial'",
        )
      }
      b.dependsOn.add(i)
    }
  }
  return { hasTasks, tasks, gate, onWriteConflict, conflicts }
}

export const V2_CAPABILITIES_TTL_MS = 60000

/** start_run 在写任务中结果不可知时不得换模型重试，避免同一任务被实际执行两次。 */
export function isUnknownStartError(err) {
  const s = String((err && err.message) || err || '')
  return /start_run 超时|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|connection (failed|refused|reset|closed)|timed? ?out|未返回 runId/i.test(s)
}

/** 启动前即应停止候选链重试的错误；写任务遇到结果不可知错误时同样必须停止，防止双写。 */
export function isPreStartRejection(err, writable = false) {
  const msg = String((err && err.message) || err || '')
  return !isModelError(msg) || Boolean(writable && isUnknownStartError(err))
}

/** 插件卸载或 jobs 服务关闭只分离本地等待，不得误杀远端 run。 */
export function isDisposeCancelReason(reason) {
  return /disposed/i.test(String(reason || ''))
}

/** 按模型实际厂商归族，避免同厂商换模型后仍被当成异构审查。 */
export function vendorOf(provider, model) {
  const p = String(provider || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  const s = `${p}/${m}`
  if (/google|vertex|gemini/.test(s)) return 'google'
  if (/kimi|moonshot/.test(s)) return 'kimi'
  if (/anthropic|claude/.test(s)) return 'anthropic'
  if (/xai|grok/.test(s)) return 'xai'
  if (/openai|gpt|codex/.test(s)) return 'openai'
  if (/deepseek/.test(s)) return 'deepseek'
  if (/qwen|alibaba/.test(s)) return 'alibaba'
  return p || m.split(/[-.]/)[0] || 'unknown'
}

/** 只信任守门员正文显式 verdict；会话 succeeded 本身不代表验收通过。 */
export function parseGateVerdict(text) {
  const match = /^\s*verdict:\s*(pass|fail|partial)/im.exec(String(text || ''))
  return match ? match[1].toLowerCase() : 'unknown'
}

function execGit(workspace, args, env = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-c', 'core.quotepath=off', ...args]
    execFile('git', fullArgs, {
      cwd: workspace,
      env: { ...process.env, ...env },
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim() || String(error.message || error)
        reject(new Error(`git ${args.join(' ')} 失败：${detail}`))
      } else resolve(String(stdout).trimEnd())
    })
  })
}

/**
 * 用临时 GIT_INDEX_FILE 对工作区（含未提交改动）执行 write-tree。
 * 全程不写真实 index、不改工作树；非 Git 目录或快照失败时返回 available:false，不阻断派发。
 */
export async function captureGitTree(workspace, options = {}) {
  const tempIndex = join(tmpdir(), `relay-dispatch-index-${process.pid}-${Date.now()}-${++seq}`)
  try {
    const root = (await execGit(workspace, ['rev-parse', '--show-toplevel'], {}, options.timeoutMs)).trim()
    if (!root) return { available: false, reason: 'not_git' }
    const realIndex = (await execGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], {}, options.timeoutMs)).trim()
    try { copyFileSync(realIndex, tempIndex) } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
    const env = { GIT_INDEX_FILE: tempIndex }
    await execGit(root, ['add', '-A', '--'], env, options.timeoutMs)
    const tree = (await execGit(root, ['write-tree'], env, options.timeoutMs)).trim()
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error(`write-tree 返回非法 tree：${tree}`)
    return { available: true, root, tree }
  } catch (err) {
    return { available: false, reason: String((err && err.message) || err).slice(0, 500) }
  } finally {
    try { unlinkSync(tempIndex) } catch {}
  }
}

/** 比较两个 captureGitTree 快照并列出实际路径差分；tree 相同不调用 git diff。 */
export async function diffGitTrees(workspace, before, after, options = {}) {
  const a = before && before.tree
  const b = after && after.tree
  if (!a || !b || !before.available || !after.available) return { available: false, changed: false, files: [], nameStatus: '', numstat: '', statText: '' }
  if (a === b) return { available: true, changed: false, files: [], nameStatus: '', numstat: '', statText: '', beforeTree: a, afterTree: b }
  const root = after.root || before.root || workspace
  const [nameStatus, numstat, statText] = await Promise.all([
    execGit(root, ['diff', '--name-status', '--no-renames', a, b, '--'], {}, options.timeoutMs),
    execGit(root, ['diff', '--numstat', '--no-renames', a, b, '--'], {}, options.timeoutMs),
    execGit(root, ['diff', '--stat', '--no-renames', a, b, '--'], {}, options.timeoutMs),
  ])
  return {
    available: true,
    changed: true,
    files: nameStatus.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\S+\s+/, '')).filter(Boolean),
    nameStatus,
    numstat,
    statText,
    beforeTree: a,
    afterTree: b,
  }
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
  const wakeTimers = new Set()
  const wakeStates = new WeakMap()
  const activePipelines = new Set()
  let capabilitiesCache = { at: 0, ids: null }

  function getWakeState(agent) {
    const events = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : null
    let st = wakeStates.get(agent)
    if (!st) {
      st = { count: 0, lastCheckedLen: events ? events.length : 0 }
      wakeStates.set(agent, st)
      return st
    }
    if (events) {
      for (let i = st.lastCheckedLen; i < events.length; i++) {
        const e = events[i]
        const src = (e && e.data && e.data.source) || (e && e.source)
        if (e && e.type === 'user/message' && src && src.kind === 'user') {
          st.count = 0
        }
      }
      st.lastCheckedLen = events.length
    }
    return st
  }

  if (ctx && typeof ctx.on === 'function') {
    try {
      ctx.on('agent/inbox/claimed', ({ agent: claimedAgent, message }) => {
        if (claimedAgent && message && message.source && message.source.kind === 'user') {
          wakeStates.delete(claimedAgent)
        }
      })
    } catch {}
  }

  /**
   * 后台 job 结算后的完成通知补唤醒。
   *
   * doneAt 时主会话可能正在运行一个更早开启的旧轮次：旧轮次随后输出的
   * assistant/message 不代表它已经处理了本次 job 通知。因此在主会话真正 idle
   * 之前按拍退避检查，并以 jobId + 新轮次起点共同判定通知是否已被响应。
   */
  function scheduleCompletionWake(owner, jobId) {
    if (disposed || !owner || typeof owner !== 'object') return
    const doneAt = Date.now()
    const wakeDelayMs = config.wakeDelayMs ?? DEFAULTS.wakeDelayMs
    const wakePollMs = Math.max(1, config.wakePollMs ?? 1500)
    const wakeMaxChecks = Math.max(1, Math.floor(config.wakeMaxChecks ?? 20))
    const maxWakes = config.maxConsecutiveWakes ?? DEFAULTS.maxConsecutiveWakes
    if (!(maxWakes > 0)) return
    const st = getWakeState(owner)
    let followedUp = false
    let injectedMsg = null
    let deliveredMsg = null
    let deliveredByThisWake = false
    let sawBusy = false
    let checks = 0
    let timer = null
    let finished = false
    const origFollowup = typeof owner.followup === 'function' ? owner.followup : null
    const origInject = typeof owner.inject === 'function' ? owner.inject : null
    let hooked = false
    const unhook = () => {
      if (!hooked) return
      hooked = false
      try {
        if (origFollowup && owner.followup === wrappedFollowup) owner.followup = origFollowup
        if (origInject && owner.inject === wrappedInject) owner.inject = origInject
      } catch {}
    }
    const wrappedFollowup = function (msg) {
      followedUp = true
      st.count += 1
      unhook()
      return origFollowup.call(this, msg)
    }
    const wrappedInject = function (msg) {
      injectedMsg = msg
      unhook()
      return origInject.call(this, msg)
    }
    try {
      if (origFollowup) owner.followup = wrappedFollowup
      if (origInject) owner.inject = wrappedInject
      hooked = true
    } catch {}
    Promise.resolve().then(() => Promise.resolve().then(unhook))

    const sessionForParent = (parentId) => {
      if (owner && owner.id === parentId && owner.session) return owner.session
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
        return (sessions && typeof sessions.get === 'function' && sessions.get(parentId)) ||
          (agents && typeof agents.get === 'function' && agents.get(parentId) && agents.get(parentId).session) ||
          owner.session
      } catch {
        return owner.session
      }
    }
    const eventTime = (e) => parseTimeMs(e && (e.time ?? e.time0 ?? (e.data && e.data.time)))

    /**
     * 只有 job 完成通知之后出现了有效响应，或 doneAt 后新开启的轮次已有响应，
     * 才视为已处理。doneAt 前已经开启的旧轮次即使随后输出 assistant/message，
     * 也绝不能吞掉本次完成通知。
     */
    const wasJobNoticeHandled = (parentId, jobId, doneAt) => {
      const session = sessionForParent(parentId)
      const events = session && Array.isArray(session.events) ? session.events : []
      if (events.length === 0) return false
      const turnStarts = new Map()
      const newTurnAnchors = []
      let noticeIdx = -1
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (!e || typeof e !== 'object') continue
        if (e.type === 'turn/start') {
          const key = String(e.data?.turn ?? '')
          const at = eventTime(e)
          if (key) turnStarts.set(key, { index: i, at })
          if (at !== undefined && at >= doneAt) newTurnAnchors.push(i)
          continue
        }
        if (e.type !== 'user/message' || !jobId) continue
        const content = e.data?.content ?? e.data?.message?.content ?? e.content
        const text = textOf(content) || ''
        if (text.includes(String(jobId))) noticeIdx = i
      }
      const anchors = noticeIdx >= 0 ? [noticeIdx, ...newTurnAnchors] : newTurnAnchors
      for (const anchor of anchors) {
        for (let j = anchor + 1; j < events.length; j++) {
          const e = events[j]
          if (!e || e.type !== 'assistant/message') continue
          const at = eventTime(e)
          if (at !== undefined && at < doneAt) continue
          if (anchor === noticeIdx) {
            const start = turnStarts.get(String(e.data?.turn ?? ''))
            if (start && start.at !== undefined && start.at < doneAt) continue
          }
          return true
        }
      }
      return false
    }

    const hasOpenTurn = () => {
      const session = sessionForParent(owner.id)
      const events = session && Array.isArray(session.events) ? session.events : []
      let lastStart = -1
      let lastEnd = -1
      for (let i = 0; i < events.length; i++) {
        if (events[i]?.type === 'turn/start') lastStart = i
        else if (events[i]?.type === 'turn/end') lastEnd = i
      }
      return lastStart > lastEnd
    }

    const cancelWake = () => {
      if (finished) return
      finished = true
      unhook()
      if (timer) clearTimeout(timer)
      timer = null
      wakeTimers.delete(cancelWake)
    }
    const removeFromInbox = (msg) => {
      const inbox = owner.inbox
      if (!inbox || !msg) return
      for (const key of ['nextStep', 'nextTurn']) {
        const list = inbox[key]
        if (!Array.isArray(list)) continue
        const idx = list.findIndex((m) => m === msg || (m && msg && m.id && m.id === msg.id))
        if (idx < 0) continue
        const pendingMsg = list[idx]
        if (typeof inbox.remove === 'function' && pendingMsg && pendingMsg.id) inbox.remove(pendingMsg.id)
        else list.splice(idx, 1)
      }
    }
    const isPendingMessage = (msg) => {
      const inbox = owner.inbox
      if (!inbox || !msg) return false
      for (const key of ['nextStep', 'nextTurn']) {
        const list = inbox[key]
        if (!Array.isArray(list)) continue
        if (list.some((m) => m === msg || (m && msg && m.id && m.id === msg.id))) return true
      }
      return false
    }
    const queueCheck = (delay) => {
      if (finished) return
      if (checks >= wakeMaxChecks) {
        cancelWake()
        return
      }
      timer = setTimeout(runCheck, Math.max(0, delay))
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
    const runCheck = () => {
      timer = null
      if (finished) return
      checks += 1
      unhook()
      if (disposed || !owner) {
        cancelWake()
        return
      }
      if (wasJobNoticeHandled(owner.id, jobId, doneAt)) {
        cancelWake()
        return
      }
      if (owner.status !== 'idle' || hasOpenTurn()) {
        sawBusy = true
        queueCheck(wakePollMs)
        return
      }

      // 每个定时器只能处理自己这次结算的通知。前几个已由宿主 followup
      // 唤醒的定时器不得借后来的 pending 再唤醒一次；自己的 inject 通知
      // 若已被其他路径消费，也不得凭保存的消息副本重复补投。
      if (!deliveredByThisWake && followedUp) {
        cancelWake()
        return
      }
      if (!deliveredByThisWake && injectedMsg !== null && owner.inbox && !isPendingMessage(injectedMsg)) {
        cancelWake()
        return
      }

      // 已补投过的 schedule 只能重试自己那条仍滞留信箱的通知。
      // 若它已被消费，则立即收口；绝不能把后续 job 的 pending 通知抢来再投一次。
      if (deliveredByThisWake) {
        if (!deliveredMsg || !isPendingMessage(deliveredMsg)) {
          cancelWake()
          return
        }
        injectedMsg = deliveredMsg
      }

      const curState = getWakeState(owner)
      const pending = hasPendingInbox(owner)
      if (!pending && injectedMsg === null) {
        cancelWake()
        return
      }
      if (curState.count >= maxWakes) {
        // 连续派发上限仍防止 idle 会话无限自唤醒；但本次若曾被旧轮次阻塞，
        // 说明通知尚未得到任何处理机会，必须重置预算补发一次。
        if (!sawBusy) {
          cancelWake()
          return
        }
        curState.count = 0
      }

      let delivered = false
      try {
        if (injectedMsg !== null && typeof owner.followup === 'function') {
          const msg = injectedMsg
          removeFromInbox(msg)
          curState.count += 1
          owner.followup(msg)
          deliveredMsg = msg
          injectedMsg = null
          followedUp = true
          delivered = true
        } else if (pending && typeof owner.wakeDriver === 'function') {
          curState.count += 1
          owner.wakeDriver()
          delivered = true
        } else if (pending && owner.inbox && Array.isArray(owner.inbox.nextStep) && owner.inbox.nextStep.length > 0 && typeof owner.followup === 'function') {
          const msg = owner.inbox.nextStep[0]
          removeFromInbox(msg)
          curState.count += 1
          owner.followup(msg)
          deliveredMsg = msg
          followedUp = true
          delivered = true
        }
      } catch {}

      // 下一拍确认是否开启新轮次；仅当本 job 的通知仍滞留信箱时才重试，
      // 避免连续完成时旧定时器消费并重复投递后一个 job 的通知。
      if (delivered) {
        deliveredByThisWake = true
        queueCheck(wakePollMs)
      } else cancelWake()
    }
    queueCheck(wakeDelayMs)
    wakeTimers.add(cancelWake)
  }

  // 兼容插件内既有调用名；新调用应显式传入 jobId。
  const scheduleOwnerWake = (owner, jobId) => scheduleCompletionWake(owner, jobId)

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
    for (const cancel of [...wakeTimers]) {
      try { cancel() } catch {}
    }
    wakeTimers.clear()
    for (const cancel of [...activePipelines]) {
      try { cancel('relay_dispatch disposed') } catch {}
    }
    activePipelines.clear()
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
            // v2 默认保留确定性 fallback 标题；仅显式开启时才额外消耗一次 LLM 标题刷新。
            if (config.llmTitle === true && typeof titles.refresh === 'function') {
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

  // ───────── v2：tasks -> join -> gate 单聚合 Job 流水线 ─────────
  function pipelineManifestDir() {
    return config.manifestDir || join(homedir(), '.dsh', 'relay-pipelines')
  }

  /** list_capabilities 60s 缓存：同一插件实例内重复派发不重复拉取。 */
  async function getCapabilityIdsV2(exec) {
    const now = Date.now()
    if (capabilitiesCache.ids && now - capabilitiesCache.at < V2_CAPABILITIES_TTL_MS) return capabilitiesCache.ids
    const ids = collectModelIds(await call(TOOL_CAPS, {}, exec && exec.agent, exec && exec.signal))
    capabilitiesCache = { at: now, ids: ids || null }
    return ids || null
  }

  function filterCandidatesV2(candidates, ids, notes) {
    if (!candidates.length || !ids) return candidates
    const kept = candidates.filter((c) => ids.has(`${c.provider}/${c.model}`))
    for (const c of candidates) if (!kept.includes(c)) notes.push(`跳过 ${c.provider}/${c.model}：能力列表中不存在`)
    return kept.length ? kept : candidates
  }

  async function startPipelineV2(args, exec, jobs) {
    const agent = exec && exec.agent
    const { modes, warning, aliases } = loadModes(config.modesPath || MODES_PATH)
    // 同步预检：任何参数/写冲突错误都在此抛出，不调用 relay 工具、不注册 Job。
    const plan = preflightDispatchV2(args, config, { modes, aliases: aliases || {} })
    const notes = warning ? [warning] : []
    const pipelineId = `p-${Date.now().toString(36)}-${++seq}`
    const manifestPath = join(pipelineManifestDir(), `${pipelineId}.json`)
    let capabilityIds = null
    try { capabilityIds = await getCapabilityIdsV2(exec) } catch (e) { notes.push(`list_capabilities 失败，未过滤候选：${(e && e.message) || e}`) }
    const items = plan.tasks.map((t) => ({
      index: t.index, kind: 'task', label: t.label, status: 'pending',
      workspace: t.workspace, writable: t.writable, dependsOn: [...t.dependsOn],
      runId: undefined, sessionId: undefined, webUrl: undefined, model: undefined,
      output: '', error: undefined, startUnknown: false, notes: [], git: undefined,
    }))
    let jobId
    let finalRead = null
    let pipelinePhase = 'running'
    let pipelineResultHeader = V2_MACHINE_HEADER
    let cancelPipeline = () => {}
    const disposeCancel = (reason) => cancelPipeline(reason)
    const manifest = () => ({
      machineHeader: pipelineResultHeader,
      phase: pipelinePhase,
      pipelineId,
      jobId,
      updatedAt: new Date().toISOString(),
      onWriteConflict: plan.onWriteConflict,
      gateUserAsk: plan.gate ? plan.gate.userAsk : undefined,
      notes,
      items: items.map((i) => ({
        index: i.index, kind: i.kind, label: i.label, status: i.status,
        runId: i.runId, sessionId: i.sessionId, webUrl: i.webUrl, model: i.model,
        startUnknown: i.startUnknown || undefined, error: i.error,
        verdict: i.verdict, selfReview: i.selfReview || undefined,
        dependsOn: i.dependsOn, git: i.git,
      })),
    })
    const writeManifest = () => {
      if (config.writeManifest === false) return
      try {
        mkdirSync(dirname(manifestPath), { recursive: true })
        const tmp = `${manifestPath}.tmp`
        writeFileSync(tmp, JSON.stringify(manifest(), null, 2))
        renameSync(tmp, manifestPath)
      } catch {}
    }
    const modelNote = () => `实际使用：${items.map((i) => i.model).filter(Boolean).join(', ') || '(待定)'}（pipeline ${pipelineId}）` + (notes.length ? '；' + notes.join('；') : '')

    const getNow = typeof config.now === 'function' ? config.now : () => Date.now()
    const maxWaitMs = (args.maxWaitMinutes || config.maxWaitMinutes) * 60000
    // Stage 1 与 Stage 2 gate 共享同一个总 deadline，避免 gate 重新获得一整段等待预算。
    const pipelineDeadline = getNow() + maxWaitMs
    const waitRetrySleep = (ms, abort) => new Promise((resolve) => {
      if (!(ms > 0) || abort.signal.aborted) { resolve(); return }
      let timer
      const onAbort = () => { clearTimeout(timer); resolve() }
      abort.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        abort.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
    })

    async function waitRunV2(item, started, abort) {
      let snap = started
      let cancelRequestedAt = snap && snap.cancelRequested ? (parseTimeMs(snap.cancelRequestedAt ?? snap.canceledAt) ?? getNow()) : null
      while (!abort.signal.aborted) {
        const remaining = pipelineDeadline - getNow()
        if (remaining <= 0) throw new Error('wait timeout')
        const sliceTimeout = Math.max(1, Math.min(config.sliceMs, remaining))
        let pollAttempt = 0
        while (true) {
          try {
            snap = await call(TOOL_WAIT, { runId: item.runId, timeoutMs: sliceTimeout }, agent, abort.signal)
            break
          } catch (pollErr) {
            if (abort.signal.aborted || !isTransientPollError(pollErr) || pollAttempt >= (config.waitMaxRetries ?? DEFAULTS.waitMaxRetries)) throw pollErr
            pollAttempt++
            await waitRetrySleep(config.waitRetryDelayMs ?? DEFAULTS.waitRetryDelayMs, abort)
            if (abort.signal.aborted) throw pollErr
          }
        }
        const cRes = isRunCancelled(snap, {
          cancelRequestedAt,
          now: getNow(),
          cancelGraceMs: config.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
          sessionTerminated: isChildSessionTerminated(ctx, snap && snap.sessionId),
        })
        cancelRequestedAt = cRes.cancelRequestedAt
        if (cRes.cancelled) return { snap, cancelled: true }
        if (isTerminalSnap(snap)) return { snap, cancelled: false }
      }
      return { snap, cancelled: true }
    }

    async function runOne(t, item, abort) {
      item.status = 'running'
      writeManifest()
      try {
        if (disposed) throw new Error('relay_dispatch disposed')
        const before = item.writable ? await captureGitTree(t.workspace) : { available: false }
        const startTool = t.review ? TOOL_START_REVIEW : TOOL_START_RUN
        const attempts = t.candidates.length ? filterCandidatesV2(t.candidates, capabilityIds, item.notes) : [null]
        let started, used, lastErr
        for (const c of attempts) {
          const sa = c ? { ...t.baseArgs, provider: c.provider, model: c.model } : t.baseArgs
          try {
            started = await startLinked(startTool, fillStartArgs(sa, config, t.review), exec, t.rawTask, t.modePrefix)
            // start_run 已返回但等待启动期间发生用户取消：立即取消刚拿到的远端 run，防孤儿写任务。
            if (abort.signal.aborted) {
              const orphanRunId = started && (started.runId || (started.run && started.run.runId))
              if (orphanRunId && !disposed && !isDisposeCancelReason(abort.signal.reason)) {
                await call(TOOL_CANCEL, { runId: orphanRunId }, agent, new AbortController().signal).catch(() => {})
              }
              throw new Error('启动完成后检测到已取消')
            }
            used = c ? `${c.provider}/${c.model}` : `${sa.provider || config.defaultProvider}/${sa.model || config.defaultModel}`
            lastErr = undefined
            break
          } catch (err) {
            const msg = String((err && err.message) || err)
            lastErr = new Error(msg)
            if (t.writable && isUnknownStartError(err)) {
              // start_unknown：写任务可能已被对端接受，换模型重试会造成双写。
              item.startUnknown = true
              item.notes.push('start_unknown：写任务启动结果不可知，为防止双写不再换模型重试')
              break
            }
            if (c && isPreStartRejection(err, t.writable)) break
            if (c) item.notes.push(`跳过 ${c.provider}/${c.model}：启动失败 ${clip(msg, 200)}`)
            if (abort.signal.aborted || disposed) break
          }
        }
        if (lastErr) throw lastErr
        const runId = started && (started.runId || (started.run && started.run.runId))
        if (!runId) throw new Error(`start 未返回 runId：${clip(started, 600)}`)
        item.runId = runId
        item.sessionId = started.sessionId || (started.run && started.run.sessionId)
        item.webUrl = started.webUrl
        item.model = used
        writeManifest()
        const { snap, cancelled: runCancelled } = await waitRunV2(item, started, abort)
        item.output = runCancelled ? buildCancelConclusion(snap, 'cancelled') : fullConclusion(snap)
        item.status = runCancelled || (snap && snap.status === 'cancelled')
          ? 'cancelled'
          : (snap && snap.status === 'succeeded' ? 'succeeded' : 'failed')
        if (item.writable) {
          const after = await captureGitTree(t.workspace)
          const diff = await diffGitTrees(t.workspace, before, after)
          item.git = {
            available: diff.available, changed: diff.changed, files: diff.files,
            nameStatus: diff.nameStatus, numstat: diff.numstat, statText: diff.statText,
            beforeTree: diff.beforeTree, afterTree: diff.afterTree,
          }
        }
      } catch (err) {
        item.status = abort.signal.aborted || disposed ? 'cancelled' : 'failed'
        item.error = String((err && err.message) || err)
        if (item.startUnknown) item.error = `start_unknown: ${item.error}`
        if (!item.output) item.output = item.error
      } finally {
        writeManifest()
      }
    }

    jobId = jobs.start({
      kind: 'relay-dispatch',
      label: `pipeline ${pipelineId}`,
      owner: agent,
      run: () => {
        const abort = new AbortController()
        let cancelled = false
        cancelPipeline = (reason) => {
          if (cancelled) return
          cancelled = true
          const detachOnly = disposed || isDisposeCancelReason(reason)
          if (detachOnly) pipelinePhase = 'detached'
          try { abort.abort(reason || 'cancelled') } catch {}
          // DSH 关闭/插件热重载只分离本地等待，远端 run 必须继续存活；仅用户显式取消才 cancel_run。
          if (!detachOnly) {
            for (const item of items) {
              if (item.status === 'running' && item.runId) {
                call(TOOL_CANCEL, { runId: item.runId }, agent, new AbortController().signal).catch(() => {})
              }
            }
          }
          writeManifest()
        }
        activePipelines.add(disposeCancel)
        const snapshotText = () => {
          const lines = [V2_MACHINE_HEADER, `pipeline_id: ${pipelineId}`, 'state: running']
          for (const item of items) {
            lines.push(`#${item.index} ${item.label}: ${item.status}${item.runId ? ` runId=${item.runId}` : ''}${item.model ? ` model=${item.model}` : ''}`)
          }
          return lines.join('\n')
        }
        const finish = (r) => {
          activePipelines.delete(disposeCancel)
          if (pipelinePhase !== 'detached') pipelinePhase = 'completed'
          finalRead = `${pipelineResultHeader}\n${r.output || ''}\n${modelNote()}`
          writeManifest()
          if (!cancelled) scheduleOwnerWake(agent, jobId)
          return r
        }
        const done = (async () => {
          const running = new Map()
          const maxConc = Math.max(1, config.maxConcurrentTasks ?? DEFAULTS.maxConcurrentTasks)
          const launch = (t) => {
            const item = items[t.index]
            const p = runOne(t, item, abort).finally(() => { running.delete(t.index) })
            running.set(t.index, p)
          }
          while (!abort.signal.aborted && !disposed) {
            let changed = false
            for (const t of plan.tasks) {
              const item = items[t.index]
              if (item.status !== 'pending') continue
              const deps = [...t.dependsOn]
              if (deps.some((d) => ['failed', 'cancelled', 'skipped'].includes(items[d].status))) {
                item.status = 'skipped'
                item.output = '依赖任务未成功，已跳过'
                changed = true
                continue
              }
              if (deps.every((d) => items[d].status === 'succeeded') && running.size < maxConc) {
                launch(t)
                changed = true
              }
            }
            writeManifest()
            if (running.size > 0) { await Promise.race(running.values()); continue }
            if (plan.tasks.every((t) => items[t.index].status !== 'pending')) break
            if (!changed) break
          }
          if (running.size > 0) await Promise.allSettled([...running.values()])
          for (const item of items) {
            if (item.status === 'pending') { item.status = 'cancelled'; item.output = '已取消' }
          }

          let gateSelfReview = false
          if (plan.gate) {
            const gateItem = {
              index: items.length, kind: 'gate', label: 'gate', status: 'pending',
              workspace: plan.tasks[0] && plan.tasks[0].workspace, writable: false, dependsOn: [],
              output: '', error: undefined, startUnknown: false, notes: [], git: undefined,
              verdict: 'unknown', selfReview: 0,
            }
            items.push(gateItem)
            const succeeded = plan.tasks.filter((t) => items[t.index].status === 'succeeded')
            const partial = succeeded.length < plan.tasks.length
            if (!succeeded.length) {
              gateItem.status = 'skipped'
              gateItem.output = '没有成功的子任务，gate 跳过'
            } else if (partial && plan.gate.onPartial === 'skip') {
              gateItem.status = 'skipped'
              gateItem.output = '部分子任务未成功，onPartial=skip，gate 跳过'
            } else if (abort.signal.aborted || disposed) {
              gateItem.status = 'cancelled'
              gateItem.output = '已取消'
            } else {
              const usedModels = new Set(succeeded.map((t) => items[t.index].model).filter(Boolean))
              const usedVendors = new Set([...usedModels].map((id) => {
                const slash = id.indexOf('/')
                return vendorOf(slash >= 0 ? id.slice(0, slash) : '', slash >= 0 ? id.slice(slash + 1) : id)
              }))
              const verifyCfg = (modes && modes.verify) || BUILTIN_MODES.verify
              const evidence = succeeded.map((t) => {
                const it = items[t.index]
                const git = it.git && it.git.available ? it.git : null
                const gitText = [
                  `变更文件：${(git && git.files && git.files.join(', ')) || '(无快照证据)'}`,
                  `numstat:\n${(git && git.numstat) || '(无)'}`,
                  `statText:\n${(git && git.statText) || '(无)'}`,
                ].join('\n')
                return `## ${it.label} (${it.model || '?'})\n${conclusion({ assistantText: it.output }, 1500)}\n${gitText}`
              }).join('\n\n')
              const gateTaskText = [
                plan.gate.criteria,
                `用户原始需求：${plan.gate.userAsk}`,
                '输出要求：第一行必须且只能是 `verdict: pass`、`verdict: fail` 或 `verdict: partial` 之一；随后再列证据。会话自身成功不代表验收通过，必须依据标准与真实 Git 证据作判断。',
                plan.gate.commands.length ? `请执行以下验证命令并报告结果：\n${plan.gate.commands.map((c) => `- ${c}`).join('\n')}` : '',
                evidence,
              ].filter(Boolean).join('\n\n')
              const applied = applyMode(verifyCfg, { workspace: succeeded[0].workspace, task: gateTaskText }, aliases || {})
              // 优先剔除同厂商模型；若无异构候选，也必须回退原链真正跑一次守门员，并明确标记自审。
              const originalGateCandidates = filterCandidatesV2(applied.candidates, capabilityIds, [])
              let gateCandidates = applied.candidates.filter((c) =>
                !usedModels.has(`${c.provider}/${c.model}`) && !usedVendors.has(vendorOf(c.provider, c.model)))
              gateCandidates = filterCandidatesV2(gateCandidates, capabilityIds, gateItem.notes)
              if (!gateCandidates.length) {
                gateSelfReview = true
                gateItem.selfReview = 1
                gateCandidates = originalGateCandidates
                gateItem.notes.push('self_review=1：无异构厂商候选，已回退原 gate 候选链实际执行守门员；主会话仍须复核')
              }
              const gt = {
                index: gateItem.index, label: 'gate', mode: 'verify', review: false,
                rawTask: gateTaskText, modePrefix: '', baseArgs: applied.args,
                candidates: gateCandidates, workspace: succeeded[0].workspace, writable: false,
              }
              await runOne(gt, gateItem, abort)
              gateItem.verdict = parseGateVerdict(gateItem.output)
              if (gateItem.verdict === 'unknown') gateItem.notes.push('守门员输出未包含可解析 verdict，验收状态记为 unknown')
              writeManifest()
            }
            writeManifest()
          }

          const lines = [`pipeline_id: ${pipelineId}`]
          if (plan.gate) lines.push(`gate_user_ask: ${plan.gate.userAsk}`)
          for (const item of items) {
            lines.push(`\n[${item.kind}#${item.index}] ${item.label} -> ${item.status}${item.model ? ` (${item.model})` : ''}${item.runId ? ` runId=${item.runId}` : ''}`)
            if (item.startUnknown) lines.push('start_unknown=1')
            if (item.git && item.git.available) lines.push(`changed_files: ${item.git.files.join(', ') || '(无)'}`)
            if (item.notes.length) lines.push(item.notes.join('；'))
            lines.push(conclusion({ assistantText: item.output || item.error || '(无)' }, config.maxResultChars))
          }
          const failedN = items.filter((i) => i.status === 'failed').length
          const succN = items.filter((i) => i.status === 'succeeded').length
          const isCancelled = cancelled || abort.signal.aborted
          const taskItems = items.filter((i) => i.kind === 'task')
          const allTasksSucceeded = taskItems.length > 0 && taskItems.every((i) => i.status === 'succeeded')
          const anyTaskUnsuccessful = taskItems.some((i) => i.status !== 'succeeded')
          const gateItem = items.find((i) => i.kind === 'gate')
          const gateVerdict = (gateItem && gateItem.verdict) || 'unknown'
          let result = 'UNVERIFIED'
          if (!isCancelled) {
            if (anyTaskUnsuccessful || gateVerdict === 'fail') result = 'FAIL'
            else if (allTasksSucceeded && plan.gate && gateVerdict === 'pass' && !gateSelfReview) result = 'PASS'
            else if (gateVerdict === 'pass' || gateVerdict === 'partial') result = 'PARTIAL'
          }
          const needsMainAttention = result === 'PASS' ? 'no' : 'yes'
          pipelineResultHeader = `${V2_MACHINE_HEADER} | RESULT: ${result} | needs_main_attention: ${needsMainAttention} | self_review: ${gateSelfReview ? 1 : 0}`
          // 机器头只由 buildDelivery/finalRead 添加一次，output 保持正文，避免 detail 重复两行 RESULT。
          const output = lines.join('\n')
          const deliveryStatus = isCancelled ? 'cancelled' : (failedN === 0 ? 'succeeded' : (succN > 0 ? 'partial' : 'failed'))
          const deliv = buildDelivery(deliveryStatus, output, DETAIL_BUDGET_BYTES, true, pipelineResultHeader)
          return { status: isCancelled ? 'killed' : (failedN ? 'failed' : 'completed'), ...deliv, output }
        })().then(finish)
        return {
          cancel: (reason) => cancelPipeline(reason),
          done,
          // 运行中返回实时状态快照；终态返回机器头 + 完整结论（可重复读取）。
          readOutput: () => (finalRead != null ? finalRead : snapshotText()),
        }
      },
    })
    return {
      jobId,
      pipelineId,
      tasks: plan.tasks.length,
      gate: Boolean(plan.gate),
      note: `已创建 v2 流水线（${plan.tasks.length} 个任务${plan.gate ? ' + gate' : ''}，onWriteConflict=${plan.onWriteConflict}）。清单：${manifestPath}`,
      manifestPath,
      machineHeader: V2_MACHINE_HEADER,
    }
  }

  ctx.effect(() => tools.register({
    name: 'relay_dispatch',
    description:
      '派发 Harness relay 任务并在后台等待：立即返回 jobId，结束时通过 job 完成通知回传精简结论。' +
      '【startArgs 默认值】最少只需 workspace+task（workspace 须为 Harness 已注册工作区）。未传时自动补：provider/model=' + config.defaultProvider + '/' + config.defaultModel +
      '；sessionMode=fresh；authorizationBasis=explicit-user-request；reviewTargets 与 contextReadScope=[workspace]；permissionPreset 为 workspace-write/danger-full-access 且无 writeScope 时 writeScope=[workspace]；danger-full-access 时 confirmedDangerousPermission=true；' +
      'agentPreset 可透传' + (config.defaultAgentPreset ? '（默认 ' + config.defaultAgentPreset + '）' : '（默认不设，用官方 preset）') + '；显式传入的字段不被覆盖。' +
      '【mode】可选：investigate/implement/verify/review/heavy/rp（键取自 ~/.dsh/dispatch-modes.yaml，每次派发热读）；套用其 permission/workspace/agentPreset/reasoningEffort，并拼 taskPrefix+task+deliverable；未显式给 provider/model 时按 models 候选链依次尝试（跳过不存在的模型，start_run 报错换下一个）；返回里写明实际模型。最简用法：{mode, startArgs:{workspace, task}}。' +
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
        tasks: { type: 'array', description: 'v2：多任务流水线；每项 {startArgs?, mode?, review?, label?, workspace/task/provider/model/writeScope 快捷字段}；与顶层 startArgs 合并。单个聚合 Job，完成通知首行为 relay_dispatch_v2: 1', items: { type: 'object', additionalProperties: true } },
        gate: { type: 'object', description: "v2：全部子任务 join 后的异构验证门；{userAsk, criteria, commands?, onPartial?: 'skip'|'gate'}；自动剔除已参与实现的模型，无可用异构模型时 self_review=1 兜底", additionalProperties: true },
        onWriteConflict: { type: 'string', description: "v2：同 workspace 写范围重叠时 'error'（默认，同步预检直接报错）或 'serial'（自动串行）", enum: ['error', 'serial'] },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.pipelineId
          ? `已派发 v2 流水线 pipelineId=${value.pipelineId}（${value.tasks} 个任务${value.gate ? ' + gate' : ''}，jobId=${value.jobId}）。 ${value.note || ''} 结束时会收到通知，不要轮询。`
          : `已派发 runId=${value.runId}，后台等待中（jobId=${value.jobId}）。` +
            (value.webUrl ? ` 会话：${value.webUrl}。` : '') +
            ' ' + (value.note || '') + ' 结束时会收到通知，不要轮询。',
      }],
    },
    async execute(args, exec) {
      const jobs = ctx.get('jobs')
      if (!jobs) throw new Error('background jobs unavailable')
      if (args.tasks != null || args.gate != null) return startPipelineV2(args, exec, jobs)
      if (!args.startArgs) throw new Error('缺少 startArgs；多任务/gate 流水线请使用 tasks[]')
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
          const writableAttempt = !args.review && V2_WRITABLE_PRESETS.has((sa && sa.permissionPreset) || '')
          if (writableAttempt && isUnknownStartError(err)) {
            // 旧单任务路径同样禁止写任务 start_unknown 换模型重试，避免远端已接受后双写。
            lastErr = new Error(`start_unknown：写任务启动结果不可知，为防止双写不再换模型重试：${msg}`)
            break
          }
          if (c && isPreStartRejection(err, writableAttempt)) break // 请求/环境类或写任务结果不可知：换模型无意义/有双写风险
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
      if (agent && typeof agent === 'object') getWakeState(agent)
      let jobId

      jobId = jobs.start({
        kind: 'relay-dispatch',
        label: `relay ${String(runId).slice(0, 8)}`,
        owner: agent,
        run: () => {
          const abort = new AbortController()
          let cancelled = false
          let pending = ''
          const finish = (r) => {
            pending += (r.output || '') + '\n' + modelNote
            if (!cancelled) scheduleOwnerWake(agent, jobId)
            return r
          }
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
                  const effectiveWebUrl = (snap && snap.webUrl) || webUrl || (sid ? `http://127.0.0.1:3080/?sessionId=${sid}` : undefined)
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
                // job_list 只接受 running|stopping|completed|killed|failed；取消语义留在 detail 的 status: cancelled。
                const deliv = buildDelivery('cancelled', output)
                return { status: 'killed', ...deliv, output }
              }
              const output = fullConclusion(snap)
              const ok = snap && snap.status === 'succeeded'
              const deliv = buildDelivery(String(snap && snap.status), output)
              return { status: ok ? 'completed' : 'failed', ...deliv, output }
            } catch (err) {
              if (cancelled || cancelledRun || (snap && snap.status === 'cancelled')) {
                const output = buildCancelConclusion(snap, cancelReason)
                const deliv = buildDelivery('cancelled', output)
                return { status: 'killed', ...deliv, output }
              }
              const output = fullConclusion(snap)
              return { status: 'failed', detail: String((err && err.message) || err), output }
            }
          })().then(finish)
          return {
            cancel: (reason) => {
              if (cancelled) return
              cancelled = true
              abort.abort(reason || 'cancelled')
              // jobs 服务关闭或插件卸载只中止本地等待，绝不误杀仍在执行的远端会话。
              if (!(disposed || isDisposeCancelReason(reason))) {
                call(TOOL_CANCEL, { runId }, agent, new AbortController().signal).catch(() => {})
              }
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
