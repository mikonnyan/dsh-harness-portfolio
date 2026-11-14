/**
 * @dsh-external/dsh-relay-dispatch
 * 派发 Harness relay 任务后立即返回，由后台 job 代为等待；任务结束时 DSH 的
 * job 完成通知只带回精简结论（状态 + 截断后的 assistantText），主会话不再循环 wait_run。
 * 纯 JS、零运行时依赖（宿主无 checkout 也能直接注入）。
 */

export const name = '@dsh-external/dsh-relay-dispatch'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const inject = ['tools']
export const PREPARE_SYM = Symbol.for('relay-dispatch.prepare')
export const API_HANDLER_SYM = Symbol.for('relay-dispatch.apiHandler')
export const SUBAGENT_CREATE_SYM = Symbol.for('relay-dispatch.subagentCreate')
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
  resumeDelayMs: 2500, // 启动后延时接管最近 4 小时内分离的 v2 流水线
  resumeWindowMs: 4 * 60 * 60 * 1000,
  parentWakeWindowMs: 120000, // 自重载后补唤醒已完成/失败流水线的时间窗
  manifestDir: undefined, // v2 清单目录；缺省 ~/.dsh/relay-pipelines，测试可覆盖
  llmTitle: false, // v2 默认只做确定性标题，不额外调用 LLM
  defaultProvider: 'cursor',
  defaultModel: 'grok-4.7-fast',
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

function isUpstreamBlockedOutput(text) {
  const s = String(text || '').trim()
  if (/^Request blocked by Anthropic\b/i.test(s)) return true
  if (/(?:^|\n)\s*Error:\s*(?:RetriableError:\s*)?\[(?:unavailable|internal|deadline_exceeded|resource_exhausted)\]\s*HTTP\s*(?:429|50\d)\b/i.test(s) && !/\bstatus:\s*(?:done|blocked)\b/i.test(s)) return true
  return false
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

export function squeezeNotificationText(text) {
  return String(text ?? '').replace(/(?:\r?\n\s*){3,}/g, '\n\n')
}

/** 预算内保留头 35% / 尾 65%；切点不破坏 Unicode 码点。 */
export function headTailPreview(text, max, unit = 'chars') {
  const source = squeezeNotificationText(text)
  const measure = (s) => unit === 'bytes' ? Buffer.byteLength(s, 'utf8') : Array.from(s).length
  if (measure(source) <= max) return source
  const omitted = Array.from(source).length
  let marker = `\n...[中间省略 ${omitted} 字]...\n`
  if (measure(marker) >= max) return Array.from(source).slice(-Math.max(1, max)).join('')
  const fit = (budget, tail) => {
    const units = Array.from(source)
    let out = '', used = 0
    const seq = tail ? [...units].reverse() : units
    for (const value of seq) {
      const size = measure(value)
      if (used + size > budget) break
      out = tail ? value + out : out + value
      used += size
    }
    return out
  }
  // Recompute the omitted count once: its digits are part of the fixed budget.
  let remaining = max - measure(marker)
  let head = fit(Math.floor(remaining * 0.35), false)
  let tail = fit(remaining - measure(head), true)
  const actualOmitted = Math.max(0, omitted - Array.from(head + tail).length)
  marker = `\n...[中间省略 ${actualOmitted} 字]...\n`
  remaining = max - measure(marker)
  head = fit(Math.floor(remaining * 0.35), false)
  tail = fit(remaining - measure(head), true)
  return head + marker + tail
}

/** 通知用结论：先压平空行，超长时保住末尾交付块。 */
export function conclusion(snap, max = 2000) {
  const t = snap && (snap.assistantText || snap.finalText || snap.result)
  const text = typeof t === 'string' ? t : t == null ? '' : JSON.stringify(t)
  if (!text) return snap && snap.error ? headTailPreview(snap.error, max) : '(无)'
  return headTailPreview(text, max)
}

export const DETAIL_BUDGET_BYTES = 5000
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
  const preview = headTailPreview(s, Math.max(1, budget - byteLen(head)), 'bytes')
  return { detail: head + preview, finalText: preview, truncated: true, fullLength, fullTextAvailable: avail }
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

/** 各 Provider 的默认主力模型映射（当只指定 provider 未指定 model 时优先匹配，避免把别家模型拼到错误 provider 上）。 */
export const PROVIDER_DEFAULT_MODELS = {
  kimi: 'kimi-k3.1-pro',
  cursor: 'grok-4.7-fast',
}

/** 判断 targetPath 是否位于 workspace 目录内（或就是 workspace 本身）。 */
function pathHasDotDshSegment(key) {
  return key.split('/').includes('.dsh')
}

export function isPathInsideWorkspace(workspace, targetPath) {
  if (!workspace || !targetPath) return true
  const wsKey = writePathKey(resolve(String(workspace)))
  const tpKey = writePathKey(resolve(String(workspace), String(targetPath)))
  if (!wsKey || !tpKey) return true
  if (pathHasDotDshSegment(tpKey) && !pathHasDotDshSegment(wsKey)) return false
  if (wsKey === tpKey) return true
  const wsPrefix = wsKey.endsWith('/') ? wsKey : `${wsKey}/`
  return tpKey.startsWith(wsPrefix)
}

/**
 * Single exit for start_run/start_review args.
 * sessionId means resume; it must never travel with sessionMode.
 */
export function normalizeStartArgs(input, config = DEFAULTS) {
  const a = { ...(input || {}) }
  if (a.sessionId != null && String(a.sessionId).length > 0) delete a.sessionMode
  else if (a.sessionMode == null && config.defaultSessionMode) a.sessionMode = config.defaultSessionMode
  if (a.sessionId != null && String(a.sessionId).length > 0 && a.sessionMode != null) {
    throw new Error('sessionId and sessionMode cannot be supplied together')
  }
  return a
}

function listedWriteScope(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter((p) => typeof p === 'string' && p.trim())
}

/** 只读任务正文是否明确要求改代码。单纯提到「审查修复」不算。 */
export function taskNeedsCodeFix(task) {
  const intent = String(task || '')
    .replace(/(?:不要|严禁|禁止|不得|不许|勿)(?:写入|修改|同步到|复制到|修复|改动|改代码)/g, '')
    .replace(/(?:不|未)(?:写入|修改|同步到|复制到|修复)/g, '')
  return /(?:(?:请|顺手|需要|去|并)修复|修复(?:代码|失败|这个|问题|报错|错误)|修改代码|改代码|写入|同步到|复制到)/.test(intent)
}

/**
 * start_run 在 permissionPreset=read-only 时拒绝非空 writeScope。
 * review / 纯核对：删掉 writeScope。verify 等只读预设若同时声明了 writeScope 且正文要求改代码，则升到 workspace-write。
 */
export function reconcileReadOnlyWriteScope(args, { review = false } = {}) {
  if (!args || typeof args !== 'object') return args
  const writes = listedWriteScope(args.writeScope)
  if (review) {
    delete args.writeScope
    return args
  }
  if (args.permissionPreset !== 'read-only') return args
  if (!writes.length || !taskNeedsCodeFix(args.task)) {
    delete args.writeScope
    return args
  }
  args.permissionPreset = 'workspace-write'
  args.writeScope = writes
  if (args.workspace && writes.some((p) => !isPathInsideWorkspace(args.workspace, p))) args.permissionPreset = 'danger-full-access'
  return args
}

/** 补全 startArgs 默认值（纯函数，便于测试）。显式传入的字段永不覆盖。 */
export function fillStartArgs(input, config = DEFAULTS, review = false) {
  const a = { ...(input || {}) }
  if (a.sessionId != null) delete a.sessionMode
  if (typeof a.writeScope === 'string') a.writeScope = [a.writeScope]
  const ws = a.workspace
  if (a.provider == null && config.defaultProvider) a.provider = config.defaultProvider
  if (a.model == null) {
    const provKey = typeof a.provider === 'string' ? a.provider.trim().toLowerCase() : ''
    const defaultProvKey = typeof config.defaultProvider === 'string' ? config.defaultProvider.trim().toLowerCase() : ''
    if (provKey && provKey !== defaultProvKey && PROVIDER_DEFAULT_MODELS[provKey]) {
      a.model = PROVIDER_DEFAULT_MODELS[provKey]
    } else if ((!provKey || provKey === defaultProvKey) && config.defaultModel) {
      a.model = config.defaultModel
    } else if (provKey && PROVIDER_DEFAULT_MODELS[provKey]) {
      a.model = PROVIDER_DEFAULT_MODELS[provKey]
    }
  }
  if (a.model === 'grok-4.7-fast' && a.reasoningEffort == null) a.reasoningEffort = 'xhigh'
  if (a.authorizationBasis == null) a.authorizationBasis = 'explicit-user-request'
  if (a.sessionMode == null && a.sessionId == null && config.defaultSessionMode) a.sessionMode = config.defaultSessionMode
  if (!review && a.agentPreset == null && config.defaultAgentPreset) a.agentPreset = config.defaultAgentPreset
  if (ws) {
    if (a.reviewTargets == null) a.reviewTargets = [ws]
    const writable = review ? false : (a.permissionPreset === 'workspace-write' || a.permissionPreset === 'danger-full-access')
    if (writable && Array.isArray(a.writeScope) && a.writeScope.length > 0) {
      const hasOutside = a.writeScope.some((p) => !isPathInsideWorkspace(ws, p))
      if (hasOutside) {
        if (a.permissionPreset === 'workspace-write') a.permissionPreset = 'danger-full-access'
      }
    }
    if (writable && a.writeScope == null) a.writeScope = [ws]
    // Harness Relay accepts registered workspaces only in contextReadScope. Preserve the
    // complete policy separately: compileCapabilityManifest unions write roots back in.
    if (a.contextReadScope == null) a.contextReadScope = [ws]
    else a.contextReadScope = a.contextReadScope.filter((p) => isPathInsideWorkspace(ws, p))
    if (!a.contextReadScope.length) a.contextReadScope = [ws]
  }
  reconcileReadOnlyWriteScope(a, { review })
  if (!review && a.permissionPreset === 'danger-full-access' && a.confirmedDangerousPermission == null) a.confirmedDangerousPermission = true
  return normalizeStartArgs(a, config)
}

/** Only the host-facing relay payload is narrowed; the immutable capability manifest is compiled first. */
export function sanitizeStartRunArgs(input, review = false) {
  const a = { ...(input || {}) }
  const ws = a.workspace
  if (!ws) return a
  if (!review && a.permissionPreset !== 'read-only' && [a.writeScope, a.contextReadScope].some((scope) => Array.isArray(scope) && scope.some((p) => !isPathInsideWorkspace(ws, p)))) {
    a.permissionPreset = 'danger-full-access'
    a.confirmedDangerousPermission = true
  }
  if (Array.isArray(a.writeScope)) {
    a.writeScope = a.writeScope.filter((p) => isPathInsideWorkspace(ws, p))
    if (!a.writeScope.length) a.writeScope = [ws]
  }
  if (Array.isArray(a.contextReadScope)) {
    a.contextReadScope = a.contextReadScope.filter((p) => isPathInsideWorkspace(ws, p))
    if (!a.contextReadScope.length) a.contextReadScope = [ws]
  }
  if (review || a.permissionPreset === 'read-only') delete a.writeScope
  return a
}

export async function flushBeforeColdWake(parentSessionId) {
  if (!parentSessionId) return false
  const hook = globalThis[Symbol.for('dsh.context-compact.hooks.v1')]?.flushBeforeColdWake
  if (typeof hook !== 'function') return false
  try { await hook(parentSessionId); return true } catch { return false }
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
    const roots = extractRoots(modes.roots)
    const hosts = isPlainObject(modes.hosts) ? { ...modes.hosts } : {}
    const mechCommands = Array.isArray(modes.mechCommands?.prefixes) ? modes.mechCommands.prefixes : ['npm test', 'npm --prefix', 'node --test', 'node test/unit.mjs']
    const targets = isPlainObject(modes.targets) ? { ...modes.targets } : null
    delete modes.aliases
    delete modes.roots
    delete modes.mechCommands
    delete modes.hosts
    delete modes.targets
    if (!Object.keys(modes).length) throw new Error('文件中没有任何模式')
    return { modes, aliases, roots, hosts, mechCommands, targets }
  } catch (e) {
    return { modes: BUILTIN_MODES, warning: `dispatch-modes.yaml 读取失败（${(e && e.message) || e}），已回退到插件内置默认模式` }
  }
}

const PREFIX = '通用禁令：不重启 DSH；不读 secrets、.credentials.yaml、.env；改文件前先备份；工作区外文件用绝对路径。\n'
const DELIV = '交付格式（尽量短；summary 先给结论，证据路径只列关键 3~5 条）：\nstatus: done | blocked\nchanged_files: [...]\nverification: …\nrisks: …\nrollback: …\nsummary: ≤10 行\n'
export const BUILTIN_MODES = {
  investigate: { permission: 'read-only', models: ['cursor/grok-4.7-fast', 'kimi/kimi-k3.1-pro', 'kimi/glm-5.3', 'strata/qwen3.8-flash-next-iq3_s', 'kimi/deepseek-v4.1-flash'], taskPrefix: PREFIX, deliverable: '交付格式：summary 先给结论；证据路径只列关键 3~5 条。\n' },
  implement: { permission: 'danger-full-access', models: ['kimi/kimi-k3.1-pro', 'cursor/grok-4.7-fast', 'kimi/glm-5.3', 'strata/qwen3.8-flash-next-iq3_s'], taskPrefix: PREFIX, deliverable: DELIV },
  verify: { permission: 'read-only', models: ['kimi/kimi-k3.1-pro', 'cursor/grok-4.7-fast', 'kimi/glm-5.3', 'strata/qwen3.8-flash-next-iq3_s', 'kimi/deepseek-v4.1-flash'], taskPrefix: PREFIX, deliverable: '交付格式：summary 先给结论；通过/不通过清单，证据路径只列关键 3~5 条。\n' },
  review: { permission: 'read-only', models: ['kimi/kimi-k3.1-pro', 'cursor/grok-4.7-fast', 'kimi/glm-5.3', 'strata/qwen3.8-flash-next-iq3_s'], taskPrefix: PREFIX, deliverable: '交付格式：summary 先给结论；问题按严重度列出，证据路径只列关键 3~5 条。\n' },
  heavy: { permission: 'danger-full-access', checkpoint: true, models: ['kimi/kimi-k3.1-pro', 'cursor/grok-4.7-fast', 'kimi/glm-5.3', 'strata/qwen3.8-flash-next-iq3_s'], taskPrefix: PREFIX, deliverable: DELIV },
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
  const modeList = (Array.isArray(modeCfg.models) ? modeCfg.models : []).map((s) => {
    s = al(s)
    const i = String(s).indexOf('/')
    return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : null
  }).filter(Boolean)
  let candidates = []
  if (a.provider == null && a.model == null) {
    candidates = modeList
  } else if (a.provider != null && a.model == null) {
    const provLower = String(a.provider).trim().toLowerCase()
    const matched = modeList.filter((c) => c.provider.toLowerCase() === provLower)
    if (matched.length > 0) {
      a.model = matched[0].model
      candidates = matched
    } else if (PROVIDER_DEFAULT_MODELS[provLower]) {
      a.model = PROVIDER_DEFAULT_MODELS[provLower]
    }
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

const SUBAGENT_UNHEALTHY_MS = 60_000
const SENSITIVE_SUBAGENT_RE = /dsh-rp-guardian|mac-v4-sync|(?:^|[\\/\s])xiaoshuo(?:[\\/\s]|$)|苏晚晴/i
const subagentUnhealthyUntil = new Map()
const subagentCreateStack = []
/** 路由审计：origin=subagent-free。会话头 origin 仍须是 DSH 接受的 "subagent"。 */
export const subagentFreeAudit = new Map()

/** 免费子代理池：默认 cursor/grok-4.7-fast + xhigh；kimi 只在 grok 不健康时兜底。 */
export function subagentFreePool() {
  return [
    { provider: 'cursor', model: PROVIDER_DEFAULT_MODELS.cursor, reasoningEffort: 'xhigh' },
    { provider: 'kimi', model: PROVIDER_DEFAULT_MODELS.kimi },
  ]
}

export function resetSubagentFreeRouting() {
  subagentUnhealthyUntil.clear()
  subagentFreeAudit.clear()
  subagentCreateStack.length = 0
}

function subagentKey(candidate) {
  return `${candidate?.provider || ''}/${candidate?.model || ''}`
}

export function markSubagentCandidateUnhealthy(candidate, now = Date.now()) {
  if (!candidate?.provider || !candidate?.model) return
  subagentUnhealthyUntil.set(subagentKey(candidate), now + SUBAGENT_UNHEALTHY_MS)
}

export function subagentCandidateHealthy(candidate, now = Date.now(), ctxInfo = {}) {
  if (!candidate?.provider || !candidate?.model) return false
  const until = subagentUnhealthyUntil.get(subagentKey(candidate)) || 0
  if (until > now) return false
  if (candidate.provider === 'kimi' && ctxInfo.kimiBridgeUp === false) return false
  return true
}

function mergeRouteCtx(route, ctxInfo) {
  const ctx = { ...(route?.ctxInfo || {}) }
  if (!ctxInfo || typeof ctxInfo !== 'object') return ctx
  if (ctxInfo.kimiBridgeUp === true || ctxInfo.kimiBridgeUp === false) ctx.kimiBridgeUp = ctxInfo.kimiBridgeUp
  if (ctxInfo.rpGuardianActive === true || ctxInfo.rpGuardian === true || ctxInfo.sensitive === true) ctx.rpGuardianActive = true
  return ctx
}

function rememberSubagentRoute(id, route, ctxInfo) {
  const key = String(id)
  const prev = subagentFreeAudit.get(key)
  if (prev?.failedKey && !route.failedKey) route.failedKey = prev.failedKey
  route.ctxInfo = mergeRouteCtx(prev, ctxInfo)
  if (subagentFreeAudit.size > 400) subagentFreeAudit.delete(subagentFreeAudit.keys().next().value)
  subagentFreeAudit.set(key, route)
}

export function readSubagentFreeAudit(id) {
  return subagentFreeAudit.get(String(id))
}

function metaOf(opts) {
  return opts && typeof opts.meta === 'object' && opts.meta ? opts.meta : {}
}

function depthOf(opts, ctxInfo = {}) {
  const meta = metaOf(opts)
  const header = (opts && opts.header) || ctxInfo.header || {}
  const raw = meta.delegationDepth ?? header.delegationDepth ?? opts?.delegationDepth ?? ctxInfo.delegationDepth
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function isForkPrepare(opts) {
  const meta = metaOf(opts)
  const header = opts?.header || {}
  return Boolean(opts && opts.seed !== undefined) || meta.seedLength !== undefined || header.seedLength !== undefined || meta.origin === 'fork' || header.origin === 'fork' || opts?.origin === 'fork'
}

function parentOfPrepare(opts, ctxInfo = {}) {
  const meta = metaOf(opts)
  const header = opts?.header || ctxInfo.header || {}
  return meta.parentSession || header.parentSession || ctxInfo.parentSession || ctxInfo.parentId || undefined
}

function sensitiveBlob(opts, ctxInfo = {}) {
  const meta = metaOf(opts)
  const header = opts?.header || ctxInfo.header || {}
  return [
    meta.cwd, meta.workspace, meta.prompt, meta.title, meta.project,
    opts?.prompt, opts?.task, opts?.cwd, opts?.workspace,
    header.cwd, header.title, header.workspace,
    ctxInfo.cwd, ctxInfo.workspace, ctxInfo.prompt, ctxInfo.title,
    ...(Array.isArray(ctxInfo.plugins) ? ctxInfo.plugins : []),
  ].filter(Boolean).join(' ')
}

export function isSensitiveSubagentContext(opts, ctxInfo = {}) {
  if (ctxInfo.rpGuardianActive === true || ctxInfo.rpGuardian === true || ctxInfo.sensitive === true) return true
  const meta = metaOf(opts)
  const header = opts?.header || ctxInfo.header || {}
  if (meta.rp === true || header.rp === true || meta.kind === 'rp' || header.kind === 'rp') return true
  return SENSITIVE_SUBAGENT_RE.test(sensitiveBlob(opts, ctxInfo))
}

function grokRoute() {
  return { provider: 'cursor', model: PROVIDER_DEFAULT_MODELS.cursor, reasoningEffort: 'xhigh' }
}

const SUBAGENT_AUDIT_ORIGINS = new Set(['subagent', 'subagent-free'])

function relayClaim(id, opts, ctxInfo = {}) {
  const meta0 = metaOf(opts)
  const origin = meta0.origin || opts?.origin || ''
  if (origin === 'relay-dispatch') return 'relay-dispatch'
  const slot = ctxInfo.slot
  if (!slot) return null
  const direct = evaluateRelayPrepare(id, opts, slot, ctxInfo)
  if (direct.ok) return 'relay-slot'
  // origin=subagent / subagent-free is free-routing bookkeeping, not a relay source.
  // A live slot still wins: strip that bookkeeping and match the explicit model.
  const soft = new Set(['has_parentSession', 'has_origin', 'has_seed_or_delegation'])
  if (!soft.has(direct.reason)) return null
  if (origin && !SUBAGENT_AUDIT_ORIGINS.has(origin)) return null
  if (!origin && direct.reason !== 'has_seed_or_delegation') return null
  if (meta0.parentSession && slot.parent && String(meta0.parentSession) !== String(slot.parent)) return null
  const meta = { ...meta0 }
  delete meta.delegationDepth
  delete meta.seedLength
  if (SUBAGENT_AUDIT_ORIGINS.has(meta.origin)) delete meta.origin
  delete meta.freeOrigin
  if (direct.reason === 'has_parentSession' || SUBAGENT_AUDIT_ORIGINS.has(origin)) delete meta.parentSession
  return evaluateRelayPrepare(id, { ...opts, meta }, slot, ctxInfo).ok ? 'relay-slot' : null
}

function healthyFreeCandidates(now, ctxInfo) {
  return subagentFreePool().filter((candidate) => subagentCandidateHealthy(candidate, now, ctxInfo))
}

function isGrokCandidate(candidate) {
  return candidate?.provider === 'cursor' && candidate?.model === PROVIDER_DEFAULT_MODELS.cursor
}

/** 健康池里优先 grok；grok 不在池中时用剩余的第一个（kimi）。 */
function primaryFreeCandidate(healthy) {
  const picked = healthy.find((candidate) => isGrokCandidate(candidate)) || healthy[0]
  if (!picked) return null
  if (isGrokCandidate(picked)) return { ...picked, reasoningEffort: 'xhigh' }
  return { provider: picked.provider, model: picked.model }
}

/**
 * sessions.prepare 上的子代理分流。敏感会话最先短路。
 * 普通 subagent 默认 cursor/grok-4.7-fast + xhigh；仅当 grok 不健康时改走 kimi。
 * rewrite 才改 provider/model；fork 与 relay 显式派单保持原样。
 */
export function evaluateSubagentPrepare(id, opts, ctxInfo = {}) {
  const now = ctxInfo.now ?? Date.now()
  const sensitive = isSensitiveSubagentContext(opts, ctxInfo)
  const base = {
    id,
    sensitive,
    fork: isForkPrepare(opts),
    depth: depthOf(opts, ctxInfo),
    parentSession: parentOfPrepare(opts, ctxInfo),
    origin: metaOf(opts).origin || null,
  }
  if (sensitive) {
    const verdict = { ...base, action: 'rewrite', reason: 'sensitive', candidate: grokRoute(), originAudit: 'subagent-free' }
    rememberSubagentRoute(id, { ...verdict, retries: 0 }, ctxInfo)
    return verdict
  }
  if (base.fork) return { ...base, action: 'keep', reason: 'fork' }
  const claim = relayClaim(id, opts, ctxInfo)
  if (claim) return { ...base, action: 'keep', reason: claim }
  if (base.depth < 1) return { ...base, action: 'keep', reason: 'not-subagent' }
  const pinned = ctxInfo.pinnedCandidate
  const pinAllowed = pinned && subagentCandidateHealthy(pinned, now, ctxInfo)
    && subagentFreePool().some((item) => item.provider === pinned.provider && item.model === pinned.model)
    && !/claude-fable-5-2/.test(String(pinned.model || ''))
  if (pinAllowed) {
    const candidate = pinned.model === PROVIDER_DEFAULT_MODELS.cursor ? { ...pinned, reasoningEffort: 'xhigh' } : { provider: pinned.provider, model: pinned.model }
    const verdict = { ...base, action: 'rewrite', reason: 'failover', candidate, originAudit: 'subagent-free' }
    rememberSubagentRoute(id, { ...verdict, retries: 1 }, ctxInfo)
    return verdict
  }
  const healthy = healthyFreeCandidates(now, ctxInfo)
  if (!healthy.length) {
    const verdict = { ...base, action: 'fail-open', reason: 'all-unhealthy', originAudit: null }
    rememberSubagentRoute(id, { ...verdict, retries: 0 }, ctxInfo)
    return verdict
  }
  const candidate = primaryFreeCandidate(healthy)
  const verdict = { ...base, action: 'rewrite', reason: isGrokCandidate(candidate) ? 'primary' : 'fallback', candidate, originAudit: 'subagent-free' }
  rememberSubagentRoute(id, { ...verdict, retries: 0 }, ctxInfo)
  return verdict
}

function writeCandidate(target, candidate) {
  if (!target || typeof target !== 'object' || !candidate) return
  target.provider = candidate.provider
  target.model = candidate.model
  if (candidate.model === PROVIDER_DEFAULT_MODELS.cursor) target.reasoningEffort = 'xhigh'
  else if (target.reasoningEffort === 'xhigh') delete target.reasoningEffort
}

/** 把免费路由写进 prepare opts 与 agentOptions。成功改写时 meta.origin 记 subagent-free。 */
export function applySubagentRoute(opts, verdict, agentOptions) {
  if (!opts || !verdict || verdict.action !== 'rewrite' || !verdict.candidate) return opts
  let candidate = { ...verdict.candidate }
  if (verdict.sensitive || candidate.provider === 'kimi' && verdict.sensitive || /claude-fable-5-2/.test(String(candidate.model || ''))) {
    if (verdict.sensitive || /claude-fable-5-2/.test(String(candidate.model || ''))) candidate = grokRoute()
  }
  if (candidate.model === PROVIDER_DEFAULT_MODELS.cursor) candidate.reasoningEffort = 'xhigh'
  writeCandidate(opts, candidate)
  writeCandidate(opts.agentOptions, candidate)
  writeCandidate(agentOptions, candidate)
  const meta = metaOf(opts)
  if (!opts.meta) opts.meta = meta
  if (verdict.parentSession) opts.meta.parentSession = verdict.parentSession
  opts.meta.origin = 'subagent-free'
  opts.meta.freeOrigin = 'subagent-free'
  return opts
}

/** A refused retry must not keep a same-instant fuse of the failover model; that empties the pool for the original 60s window. */
function releaseSameInstantFailover(route, now) {
  const key = subagentKey(route.candidate)
  if (!key || !route.failedKey || key === route.failedKey) return
  if ((subagentUnhealthyUntil.get(key) || 0) === now + SUBAGENT_UNHEALTHY_MS) subagentUnhealthyUntil.delete(key)
}

/**
 * 启动期模型错误：同步熔断 60s，并给出下一健康候选。参数/权限类错误不熔断、不重试。
 * 非敏感任务 grok 失败后只重试一次 kimi。敏感会话的重试仍是 cursor/grok-4.7-fast + xhigh。
 * ctxInfo 只覆盖已记录的健康上下文（如 kimiBridgeUp），不主动探测网络。
 */
export function noteSubagentStartFailure(sessionId, err, now = Date.now(), ctxInfo) {
  const msg = String(err?.message || err || '')
  if (!isModelError(msg)) return { retry: false, fused: false, reason: 'not-model-error' }
  const route = subagentFreeAudit.get(String(sessionId))
  if (!route || route.action !== 'rewrite' || !route.candidate) return { retry: false, fused: false, reason: 'no-route' }
  const ctx = mergeRouteCtx(route, ctxInfo)
  route.ctxInfo = ctx
  if ((route.retries || 0) >= 1) {
    releaseSameInstantFailover(route, now)
    return { retry: false, fused: true, reason: 'retry-spent' }
  }
  const failedKey = subagentKey(route.candidate)
  markSubagentCandidateUnhealthy(route.candidate, now)
  route.failedKey = failedKey
  if (route.sensitive || ctx.rpGuardianActive) {
    const candidate = grokRoute()
    route.retries = 1
    route.candidate = candidate
    return { retry: true, fused: true, candidate, reason: 'failover' }
  }
  const healthy = healthyFreeCandidates(now, ctx).filter((candidate) => subagentKey(candidate) !== failedKey)
  const candidate = primaryFreeCandidate(healthy)
  if (!candidate) return { retry: false, fused: true, reason: 'none-healthy' }
  route.retries = 1
  route.candidate = candidate
  return { retry: true, fused: true, candidate, reason: 'failover' }
}

function applyFreeRouteToRequest(resolved, route) {
  const candidate = route.sensitive ? grokRoute() : (route.candidate || grokRoute())
  const out = { ...(resolved || {}), provider: candidate.provider, model: candidate.model }
  if (candidate.model === PROVIDER_DEFAULT_MODELS.cursor) out.reasoningEffort = 'xhigh'
  if (route.sensitive || /claude-fable-5-2/.test(String(out.model || ''))) {
    out.provider = 'cursor'
    out.model = PROVIDER_DEFAULT_MODELS.cursor
    out.reasoningEffort = 'xhigh'
  }
  if (out.model !== PROVIDER_DEFAULT_MODELS.cursor && out.reasoningEffort === 'xhigh') delete out.reasoningEffort
  return out
}

function armSubagentRequestGuard(agentCtx, sessionId) {
  if (!agentCtx || typeof agentCtx.on !== 'function' || sessionId == null) return
  const bind = () => {
    try {
      agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        const route = subagentFreeAudit.get(String(sessionId))
        if (!route || route.action !== 'rewrite' || !route.candidate) return resolved
        return applyFreeRouteToRequest(resolved, route)
      })
    } catch {}
  }
  bind()
  queueMicrotask(bind)
}

function pushSubagentCreate(options) {
  subagentCreateStack.push(options || null)
}

function popSubagentCreate() {
  subagentCreateStack.pop()
}

function peekSubagentCreate() {
  return subagentCreateStack[subagentCreateStack.length - 1] || null
}

function detectRpGuardian(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return false
  for (const key of ['loader', 'plugins', 'packages']) {
    let svc
    try { svc = ctx.get(key) } catch { continue }
    if (!svc) continue
    try {
      const list = typeof svc.list === 'function' ? svc.list() : (svc.plugins || svc.entries || [])
      const items = Array.isArray(list) ? list : []
      for (const item of items) {
        const name = typeof item === 'string' ? item : (item?.name || item?.id || item?.packageName || '')
        if (String(name).includes('dsh-rp-guardian')) return true
      }
    } catch {}
  }
  return false
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
    const events = sessionEvents(childSession)
    if (events.length) {
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
  const hasSessionLog = session && (typeof session.snapshotEvents === 'function' || Array.isArray(session.events))
  const events = hasSessionLog
    ? sessionEvents(session)
    : ((snap && Array.isArray(snap.events) && snap.events) || null)
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
  const events = sessionEvents(session)
  if (!events.length) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
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

const ROOT_ID = /[^A-Za-z0-9_.-]/g
function rootId(prefix, value, index) {
  const raw = String(value || 'root').replace(ROOT_ID, '-').slice(-100)
  return `${prefix}${index + 1}:${raw || 'root'}`
}
function rootList(paths, prefix, workspace) {
  const values = Array.isArray(paths) ? paths : [workspace]
  return values.map((path, index) => ({ root_id: rootId(prefix, path, index), canonical_path: resolve(workspace, String(path)) }))
}

/** Canonical, deterministic policy representation used by both dispatcher and gate. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * Compile immutable, static child capabilities. This is policy metadata, not an OS sandbox;
 * ExecBroker remains responsible for final-handle and process isolation.
 */
export function compileCapabilityManifest(args, options = {}) {
  if (!isPlainObject(args) || typeof args.workspace !== 'string' || !args.workspace.trim()) throw new Error('capability manifest requires workspace')
  const now = options.now ?? Date.now()
  const issuedAt = typeof now === 'number' ? now : Date.parse(now)
  const ttlMs = options.ttlMs ?? 240 * 60 * 1000
  if (!Number.isFinite(issuedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid capability validity')
  const writable = ['workspace-write', 'danger-full-access'].includes(args.permissionPreset)
  const writePaths = writable ? (Array.isArray(args.writeScope) ? args.writeScope : [args.workspace]) : []
  const readPaths = [...new Set([
    ...(Array.isArray(args.contextReadScope) ? args.contextReadScope : []),
    args.workspace,
    ...(options.readScope || []),
    ...writePaths,
  ])]
  const role = options.role || (options.review ? 'reviewer' : (writable ? 'implementer' : 'investigator'))
  const manifest = {
    schema_version: 'capability/v1',
    task_id: options.taskId || randomUUID(),
    parent_session: options.parentSession || null,
    role,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(issuedAt + ttlMs).toISOString(),
    allowed_roots: rootList(readPaths, 'ws', args.workspace),
    read_roots: rootList(readPaths, 'ws', args.workspace),
    write_roots: rootList(writePaths, 'write', args.workspace),
    write_scope: [...writePaths],
    permission_preset: args.permissionPreset || 'read-only',
    agent_preset: args.agentPreset || null,
    role_boundaries: {
      may_write: writable,
      may_dispatch: false,
      may_change_permissions: false,
      allowed_tools: options.allowedTools || ['read', 'glob', 'grep', 'edit', 'write', 'pwsh'],
    },
    forbidden_ports: [3080],
    loopback_ports: [3080, 4098, 4141, 8318],
    protected_host_processes: ['dsh', 'kimi-bridge', 'kimi-bridge-v2'],
    protected_process_rules: { no_kill: true, no_restart: true, no_port_probe: true },
    exec_profiles: [...new Set(options.execProfiles || [])],
    network: 'none',
    escalation: 'forbidden',
    nested_dispatch: { enabled: false, max_depth: 0 },
    deny_budget: 8,
  }
  const unsigned = canonicalJson(manifest)
  const complete = { ...manifest, policy_digest: `sha256:${createHash('sha256').update(unsigned).digest('hex')}` }
  for (const value of Object.values(complete)) {
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item === 'object') Object.freeze(item); Object.freeze(value) }
    else if (value && typeof value === 'object') Object.freeze(value)
  }
  return Object.freeze(complete)
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

/** 内置根与 yaml roots 仅来自可信配置；调用参数不能新增宏。 */
export function extractRoots(raw) {
  const roots = {}
  for (const [name, value] of Object.entries(raw || {})) {
    if (!/^[A-Za-z][\w-]*$/.test(name) || typeof value !== 'string' || !isAbsolute(value) || /[\s;&|`$<>"']/.test(value)) throw new Error(`roots.${name} 必须是无空格/shell 元字符的绝对路径`)
    roots[name] = resolve(value).replace(/\\/g, '/')
  }
  return roots
}

export function expandPathMacro(value, roots = {}, workspace) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('路径必须是非空字符串')
  const text = value.trim()
  const match = /^@([\w-]+)(?:\/(.*))?$/.exec(text)
  if (match) {
    const root = match[1] === 'ws' ? workspace : match[1] === 'dsh' ? join(homedir(), '.dsh') : match[1] === 'plugins' ? join(homedir(), '.dsh', 'plugins') : roots[match[1]]
    if (!root) throw new Error(`未知路径宏 @${match[1]}`)
    const result = resolve(root, match[2] || '')
    if (!isPathInsideWorkspace(root, result)) throw new Error(`路径宏越界：${text}`)
    return result
  }
  if (/^@/.test(text)) throw new Error(`无效路径宏：${text}`)
  return isAbsolute(text) ? resolve(text) : resolve(workspace || process.cwd(), text)
}

export function expandTextMacros(text, roots = {}, workspace) {
  const map = { ...roots, dsh: join(homedir(), '.dsh'), plugins: join(homedir(), '.dsh', 'plugins'), ...(workspace ? { ws: workspace } : {}) }
  return String(text ?? '').replace(/@@([\w-]+)\//g, '\0$1/').replace(/(^|[\s'"`=])@([\w-]+)\/([^\s'"`;|&<>]*)/g, (all, lead, name, tail) => {
    if (!Object.prototype.hasOwnProperty.call(map, name)) return all
    return lead + expandPathMacro(`@${name}/${tail}`, map, workspace).replace(/\\/g, '/')
  }).replace(/\0([\w-]+)\//g, '@$1/')
}

export function expandTargets(input, modesInfo = {}) {
  const args = { ...input }
  const top = args.targets == null ? [] : args.targets
  if (!Array.isArray(top) || top.some((x) => typeof x !== 'string' || !x.trim())) throw new Error('targets 必须是插件名字符串数组')
  const tasks = args.tasks == null ? null : args.tasks
  if (tasks != null && !Array.isArray(tasks)) return args
  if (!top.length && !(tasks || []).some((t) => t?.targets != null)) return args
  if (args.followUp) throw new Error('targets 不支持 followUp；续修沿用原计划')
  if (top.length && tasks?.length > 1) throw new Error('多任务顶层 targets 不允许；请在各 task 内声明 targets')
  const template = modesInfo.targets
  if (!template) throw new Error('DSH_E_TARGET_CONFIG: dispatch-modes.yaml 缺少 targets 段')
  const names = Array.isArray(template.names) ? template.names : []
  const overrides = {}
  for (const line of Array.isArray(template.overrides) ? template.overrides : []) {
    const m = String(line).match(/^([\w-]+)\.([A-Za-z]+)=(.*)$/)
    if (!m || !['source', 'mirrors', 'files', 'test', 'minTests', 'reload'].includes(m[2])) throw new Error(`无效 targets override：${line}`)
    ;(overrides[m[1]] ||= {})[m[2]] = m[3]
  }
  const configFor = (name) => {
    if (!names.includes(name)) throw Object.assign(new Error(`DSH_E_TARGET_UNKNOWN: ${name}；可用：${names.join(', ')}`), { code: 'DSH_E_TARGET_UNKNOWN' })
    const raw = { ...template, ...overrides[name] }
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',').map((x) => x.trim()).filter(Boolean))
    const replace = (v) => String(v).replaceAll('{name}', name)
    const source = replace(raw.source || '')
    const mirrors = list(raw.mirrors).map(replace)
    const files = list(raw.files).map(replace)
    if (!source || !mirrors.length || !files.length || !raw.test) throw new Error(`targets.${name} 缺少 source/mirrors/files/test`)
    return { source, mirrors, files, test: replace(raw.test), minTests: raw.minTests ? Number(raw.minTests) : undefined, reload: replace(raw.reload || `dsh-${name}`) }
  }
  const expanded = []
  const one = (rawNames) => {
    const out = { syncTargets: [], checks: [], writeScope: [], reloadPlugins: [] }
    for (const name of rawNames) {
      const cfg = configFor(name)
      for (const file of cfg.files) for (const mirror of cfg.mirrors) {
        out.syncTargets.push({ source: `${cfg.source}/${file}`, target: `${mirror}/${file}`, mode: 'copy' })
      }
      for (const file of cfg.files) out.checks.push({ sha: [`${cfg.source}/${file}`, ...cfg.mirrors.map((m) => `${m}/${file}`)] })
      out.checks.push({ cmd: cfg.test, ...(cfg.minTests ? { minTests: cfg.minTests } : {}) })
      out.writeScope.push(cfg.source, ...cfg.mirrors)
      if (cfg.reload !== 'none') out.reloadPlugins.push(cfg.reload)
    }
    return out
  }
  const merge = (target, ext) => {
    const oldSync = Array.isArray(target.syncTargets) ? target.syncTargets : []
    target.syncTargets = [...oldSync]
    for (const item of ext.syncTargets) if (!target.syncTargets.some((x) => x.source === item.source && x.target === item.target)) target.syncTargets.push(item)
    const gate = isPlainObject(target.gate) ? { ...target.gate } : { llm: 'never' }
    gate.checks = Array.isArray(gate.checks) ? [...gate.checks] : []
    for (const item of ext.checks) if (!gate.checks.some((x) => JSON.stringify(x) === JSON.stringify(item))) gate.checks.push(item)
    target.gate = gate
    target.writeScope = [...new Set([...(Array.isArray(target.writeScope) ? target.writeScope : []), ...ext.writeScope])]
    expanded.push(...ext.writeScope)
    return ext.reloadPlugins
  }
  let reload = [...(args.reloadPlugins || [])]
  if (tasks) {
    args.tasks = tasks.map((task, i) => {
      const requested = task?.targets != null ? task.targets : top
      if (requested == null) return task
      if (!Array.isArray(requested) || requested.some((x) => typeof x !== 'string')) throw new Error(`tasks[${i}].targets 必须是字符串数组`)
      const t = { ...task, startArgs: { ...(task.startArgs || {}) } }
      const ext = one(requested)
      const explicitSync = Array.isArray(task.syncTargets) ? task.syncTargets : Array.isArray(args.syncTargets) ? args.syncTargets : []
      const mergedSync = [...explicitSync]
      for (const item of ext.syncTargets) if (!mergedSync.some((x) => x.source === item.source && x.target === item.target)) mergedSync.push(item)
      t.syncTargets = mergedSync
      const explicitGate = task.gate || args.gate
      const gate = isPlainObject(explicitGate) ? { ...explicitGate } : { llm: 'never' }
      gate.checks = Array.isArray(gate.checks) ? [...gate.checks] : []
      for (const item of ext.checks) if (!gate.checks.some((x) => JSON.stringify(x) === JSON.stringify(item))) gate.checks.push(item)
      t.gate = gate
      reload.push(...merge(t.startArgs, ext))
      if (Object.keys(t.startArgs).some((k) => ['workspace', 'task', 'provider', 'model', 'writeScope', 'contextReadScope'].includes(k))) {
        Object.assign(t, t.startArgs)
        t.startArgs = {}
      }
      return t
    })
  } else if (top.length) {
    args.startArgs = { ...(args.startArgs || {}) }
    reload.push(...merge(args.startArgs, one(top)))
  }
  args.reloadPlugins = [...new Set(reload)]
  args.targetWriteScope = [...new Set(expanded)]
  return args
}

/** v3 sessions keep a live `events` array; DSH 0.2.2-rc.2 Session v4 only has `snapshotEvents()`. */
function prefixEpochCompacting(session) {
  if (!session) return false
  try {
    return globalThis[Symbol.for('@dsh-external/prefix-epoch')]?.bySession?.get(session)?.compacting === true
  } catch { return false }
}

export function sessionEvents(s) {
  if (!s) return []
  if (typeof s.snapshotEvents === 'function') {
    try {
      const ev = s.snapshotEvents()
      if (Array.isArray(ev)) return ev
    } catch {}
  }
  return Array.isArray(s.events) ? s.events : []
}

export function sessionEventsOf(session) {
  if (!session || typeof session !== 'object') return null
  if (typeof session.snapshotEvents !== 'function' && !Array.isArray(session.events)) return null
  return sessionEvents(session)
}

function sessionEventCount(session) {
  if (!session || (typeof session.snapshotEvents !== 'function' && !Array.isArray(session.events))) return null
  return sessionEvents(session).length
}

function toolResultCallId(event) {
  const data = event?.data || {}
  const message = data.message || {}
  return data.callId || data.id || message.callId || message.source?.callId || message.toolCallId || message.id || null
}

function messageIndex(events, message) {
  if (!Array.isArray(events) || !message) return -1
  const direct = events.lastIndexOf(message)
  if (direct >= 0) return direct
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'assistant/message' && message.seq != null && events[i].seq === message.seq) return i
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'assistant/message') return i
  }
  return -1
}

function compactResultFailed(event) {
  const data = event?.data?.message ?? event?.data ?? {}
  const text = (Array.isArray(data.content) ? data.content : []).map((b) => b?.text || '').join('\n')
  return data.status === 'error' || data.isError === true || /^(?:Error:|Invalid)/.test(String(text || '').trim())
}

/** Only the current step's context_compact callId can close the wait. A stale success with another id stays pending. */
function selectCompactResult(events, message, assistantWantsCompact) {
  const list = Array.isArray(events) ? events : []
  const msgAt = messageIndex(list, message)
  const compact = []
  let lastCallAt = -1
  for (let i = msgAt + 1; i < list.length; i++) {
    const e = list[i]
    if (e?.type !== 'tool/call' || e.data?.name !== 'context_compact') continue
    const id = e.data.callId || e.data.id
    if (id) compact.push(id)
    lastCallAt = i
  }
  if (!assistantWantsCompact && lastCallAt < 0) return { applicable: false, result: null }
  const byId = new Map()
  const nameless = []
  const namelessAfter = lastCallAt >= 0 ? lastCallAt : msgAt
  for (let i = msgAt + 1; i < list.length; i++) {
    const e = list[i]
    if (e?.type !== 'tool/result') continue
    const callId = toolResultCallId(e)
    if (callId && compact.includes(callId)) byId.set(callId, e)
    else if (i > namelessAfter && e.data?.name === 'context_compact' && (!callId || compact.length === 0)) nameless.push(e)
  }
  const paired = compact.map((id) => byId.get(id)).filter(Boolean)
  const failed = [...paired, ...nameless].find(compactResultFailed)
  if (failed) return { applicable: true, result: failed }
  if (compact.length) {
    const missing = compact.filter((id) => !byId.has(id))
    if (!missing.length) return { applicable: true, result: byId.get(compact[compact.length - 1]) }
    if (nameless.length >= missing.length) return { applicable: true, result: nameless[nameless.length - 1] }
    return { applicable: true, result: null }
  }
  return { applicable: true, result: nameless.length ? nameless[nameless.length - 1] : null }
}

export function concludeRequested(exec) {
  const events = sessionEventsOf(exec?.agent?.session)
  if (!Array.isArray(events) || exec?.signal?.aborted) return { ok: false, reason: exec?.signal?.aborted ? 'C6 已取消' : 'C3 无会话事件' }
  let message
  let streaming = false
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (['step/end', 'turn/end', 'step/start', 'turn/start'].includes(e?.type)) break
    if (!message && e?.type === 'assistant/chunk') {
      const kind = e.data?.chunk?.type
      if (kind && kind !== 'stop' && kind !== 'message-stop') streaming = true
    }
    if (e?.type === 'assistant/message') { message = e; break }
  }
  if (streaming) return { ok: false, reason: 'C3 模型输出尚未结束' }
  if (!message) return { ok: false, reason: 'C3 当前步无助手消息' }
  const phase = exec.agent?.phase
  if ((message.turn != null && phase?.turn != null && message.turn !== phase.turn) || (message.step != null && phase?.step != null && message.step !== phase.step)) return { ok: false, reason: 'C3 消息不属于当前步' }
  const content = message.data?.message?.content ?? message.content ?? message.data?.content ?? []
  const hasText = Array.isArray(content) && content.some((b) => b?.type === 'text' && String(b.text || '').trim())
  if (!hasText) {
    const hasTool = Array.isArray(content) && content.some((b) => b?.type === 'tool-call')
    if (!hasTool) return { ok: false, reason: 'C3 助手文字为空' }
    const dispatches = content.filter((b) => b?.type === 'tool-call' && b.name === 'relay_dispatch').length
    const receipt = dispatches ? `已派发 ${dispatches} 个后台任务，完成后会通知。` : '已压缩上下文。'
    return { ok: true, content, events, message, receipt }
  }
  const sibling = [...content.filter((b) => b?.type === 'tool-call').map((b) => b.name), ...events.filter((e) => e?.type === 'tool/call' && e.seq > (message.seq ?? -1)).map((e) => e.data?.name)]
    .filter((n) => n && !['relay_dispatch', 'context_compact'].includes(n))
  if (sibling.length) return { ok: false, reason: `C4 非白名单工具：${[...new Set(sibling)].join(',')}` }
  return { ok: true, content, events, message }
}

const concludeInflight = new WeakMap()

export async function finishConclude(exec, notes = [], options = {}) {
  if (options?.failed === true || options?.error) return 'C1 派发失败，不结束本轮'
  if (notes.length) return 'C5 有派发警告'
  if (!exec || typeof exec !== 'object') return finishConcludeUnlocked(exec, options)
  const pending = concludeInflight.get(exec)
  if (pending) return pending
  let settle
  let fail
  const gate = new Promise((resolve, reject) => { settle = resolve; fail = reject })
  concludeInflight.set(exec, gate)
  finishConcludeUnlocked(exec, options).then(settle, fail).finally(() => { if (concludeInflight.get(exec) === gate) concludeInflight.delete(exec) })
  return gate
}

async function finishConcludeUnlocked(exec, options = {}) {
  const state = concludeRequested(exec)
  if (!state.ok) return state.reason
  const names = state.content.filter((b) => b?.type === 'tool-call').map((b) => b.name)
  const compactIds = (events) => events.filter((e) => e?.type === 'tool/call' && e.data?.name === 'context_compact').map((e) => e.data?.callId || e.data?.id).filter(Boolean)
  if (names.includes('context_compact') || compactIds(state.events).length) {
    const deadline = Date.now() + (options.timeoutMs ?? 50)
    const assistantWantsCompact = names.includes('context_compact')
    let result
    let applicable = false
    while (Date.now() <= deadline) {
      const events = sessionEventsOf(exec?.agent?.session) || state.events
      const found = selectCompactResult(events, state.message, assistantWantsCompact)
      applicable = found.applicable
      result = found.result
      if (!applicable || result) break
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 5))
    }
    if (applicable && !result) return 'C4 context_compact 超时未完成'
    if (result && compactResultFailed(result)) return 'C4 context_compact 执行失败'
  }
  if (exec?.signal?.aborted) return 'C6 已取消'
  const allEvents = sessionEventsOf(exec?.agent?.session) || []
  let stepAt = 0
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (allEvents[i]?.type === 'step/start' || allEvents[i]?.type === 'turn/start') { stepAt = i; break }
  }
  const stepEvents = allEvents.slice(stepAt)
  const otherToolError = stepEvents.some((e) => {
    if (e?.type !== 'tool/result') return false
    const name = e.data?.name || e.data?.message?.toolName
    if (name === 'context_compact') return false
    return e.data?.isError === true || e.data?.message?.isError === true || e.data?.status === 'error'
  })
  if (otherToolError) return 'C1 工具报错，不结束本轮'
  if (typeof exec?.concludeTurn !== 'function') return '宿主不支持 concludeTurn'
  try { if (state.receipt) landRelayReceipt(exec?.agent?.session, state.receipt) } catch {}
  try { exec.concludeTurn?.() } catch (err) {
    if (!/not extensible/i.test(String(err?.message || err))) throw err
  }
  return ''
}

export function buildAutoDispatchSummary(args = {}) {
  const clip = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48)
  const labels = []
  const push = (value) => { const text = clip(value); if (text) labels.push(text) }
  if (Array.isArray(args.tasks)) {
    for (const task of args.tasks) push(task?.label || task?.task || task?.startArgs?.task || task?.mode)
  }
  if (!labels.length) push(args.startArgs?.task || args.mode || (args.followUp ? '续修' : '') || (Array.isArray(args.targets) ? args.targets.filter((x) => typeof x === 'string').join('、') : ''))
  const taskLabels = labels.length ? labels.slice(0, 4).join('、') : '后台任务'
  return `已派发后台流水线（${taskLabels}），完成后自动汇报。`
}

/** User summary, or a one-line fallback when conclude needs a visible explanation. */
export function explainDispatchText(args) {
  if (!args || typeof args !== 'object') return ''
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (summary) return summary
  if (args.conclude === true) return buildAutoDispatchSummary(args)
  return ''
}

function assistantTextBlocks(event) {
  const content = event?.data?.message?.content ?? event?.content ?? event?.data?.content ?? []
  return Array.isArray(content) ? content : []
}

/** True when the current open turn already has visible assistant text. */
export function openTurnHasVisibleAssistantText(session) {
  const events = sessionEventsOf(session) || []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (['turn/end', 'step/end', 'turn/start', 'step/start'].includes(event?.type)) break
    if (event?.type !== 'assistant/message') continue
    if (assistantTextBlocks(event).some((block) => block?.type === 'text' && String(block.text || '').trim())) return true
  }
  return false
}

/**
 * Append a visible assistant message. Session v4's `append()` REQUIRES
 * `surfaceOp: "append"` on every surface-eligible event (assistant/message),
 * exactly like dsh-agent-loop's step(): without the marker the append throws
 * ("is surface-eligible and requires a surfaceOp marker") and the message
 * never lands — the root cause of the invisible conclude summary bubble.
 * `sourceEventSeqs` may be omitted for assistant/message (session validates
 * empty arrays only for that type); when known we cite the relay tool/call seq.
 * Reload (`Session` seed) also requires message.id plus source.kind=model with
 * provider/model; a bare `{role, content}` event is accepted live and then
 * rejected as `lacks an identified message` / `must have model source`.
 */
function modelSourceForExplanation(session) {
  const events = sessionEventsOf(session) || []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const src = event?.data?.message?.source
    if (event?.type === 'assistant/message' && src?.kind === 'model' && src.provider && src.model) {
      return { kind: 'model', provider: String(src.provider), model: String(src.model) }
    }
    const config = event?.data?.header?.config || event?.data?.config
    if (event?.type === 'request/header' && config?.provider && config?.model) {
      return { kind: 'model', provider: String(config.provider), model: String(config.model) }
    }
  }
  try {
    const config = session?.requestHeader?.()?.config
    if (config?.provider && config?.model) return { kind: 'model', provider: String(config.provider), model: String(config.model) }
  } catch { /* header fold is optional */ }
  return { kind: 'model', provider: 'relay-dispatch', model: 'dispatch-summary' }
}

function explanationSourceSeqs(sourceSeqs) {
  const list = Array.isArray(sourceSeqs) ? sourceSeqs : (Number.isSafeInteger(sourceSeqs) ? [sourceSeqs] : [])
  const seqs = list.filter((s) => Number.isSafeInteger(s) && s >= 0)
  return seqs.length && seqs.length === list.length ? seqs : undefined
}

export function injectAssistantExplanation(session, text, phase, sourceSeqs) {
  if (!session || typeof text !== 'string' || !text.trim()) return false
  const turn = phase?.turn
  const step = phase?.step
  const data = {
    ...(turn != null ? { turn } : {}),
    ...(step != null ? { step } : {}),
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: modelSourceForExplanation(session),
    },
  }
  const seqs = explanationSourceSeqs(sourceSeqs)
  if (typeof session.append === 'function') {
    try { session.append('assistant/message', data, { surfaceOp: 'append', ...(seqs ? { sourceEventSeqs: seqs } : {}) }); return true } catch { /* fall through to record/events */ }
  }
  if (typeof session.record === 'function') {
    try { session.record('assistant/message', data); return true } catch { /* try events */ }
  }
  if (Array.isArray(session.events)) {
    const event = { type: 'assistant/message', data, ...(turn != null ? { turn } : {}), ...(step != null ? { step } : {}), surfaceOp: 'append' }
    if (Object.isExtensible(session.events)) {
      try { session.events.push(event); return true } catch { /* replace below */ }
    }
    try {
      const next = session.events.concat([event])
      session.events = Object.isFrozen(session.events) ? Object.freeze(next) : next
      return true
    } catch { return false }
  }
  return false
}

/** Last relay_dispatch tool/call event seq in the current open turn, to cite as the explanation's source. */
export function lastRelayToolCallSeq(session) {
  const events = sessionEventsOf(session) || []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (['turn/start', 'turn/end'].includes(e?.type) && i < events.length - 1) break
    if (e?.type === 'tool/call' && (e.data?.name === 'relay_dispatch' || e.data?.name === 'context_compact') && Number.isSafeInteger(e.seq)) return e.seq
  }
  return undefined
}

/**
 * Fold explanation text into the open tool-call assistant message.
 * 'attached' means the text is on that message (or it already had text).
 * 'blocked' means the message is frozen and must not be followed by a new one.
 * 'absent' means this step has no tool-call message, so a new message is safe.
 * A new assistant message while the tool call is unanswered lands between the
 * call and its result. Gemini then returns 400 invalid_tool_call_format.
 */
function attachExplanationToOpenToolCall(session, text) {
  if (!session || typeof text !== 'string' || !text.trim()) return 'absent'
  const events = sessionEventsOf(session) || []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (['turn/end', 'step/end', 'turn/start', 'step/start'].includes(event?.type)) break
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    const hasText = content.some((block) => block?.type === 'text' && String(block.text || '').trim())
    const hasTool = content.some((block) => block?.type === 'tool-call' || block?.type === 'toolCall')
    if (!hasTool) continue
    if (hasText) return 'attached'
    try {
      content.unshift({ type: 'text', text })
      return 'attached'
    } catch {
      return 'blocked'
    }
  }
  return 'absent'
}

export function applyDispatchExplanation(args, exec, value = {}) {
  const explainText = explainDispatchText(args)
  if (!explainText) return value
  if (args?.conclude === true && !openTurnHasVisibleAssistantText(exec?.agent?.session)) {
    const session = exec?.agent?.session
    if (attachExplanationToOpenToolCall(session, explainText) === 'absent') {
      injectAssistantExplanation(session, explainText, exec?.agent?.phase, lastRelayToolCallSeq(session))
    }
  }
  return { ...value, explainText }
}

export function renderDispatchText(value = {}) {
  const head = value?.explainText ? `📋 ${value.explainText}\n` : ''
  const body = value?.pipelineId
    ? `OK pipelineId=${value.pipelineId} jobId=${value.jobId}${value.concludeReason ? ` conclude skipped: ${value.concludeReason}` : ''}`
    : `OK runId=${value.runId} jobId=${value.jobId}${value.concludeReason ? ` conclude skipped: ${value.concludeReason}` : ''}`
  return head + body
}

function landRelayReceipt(session, text) {
  if (attachExplanationToOpenToolCall(session, text) !== 'absent') return
  const data = { source: { kind: 'synthetic-receipt' }, message: { role: 'assistant', content: [{ type: 'text', text }] } }
  try {
    if (typeof session?.record === 'function') {
      session.record('assistant/message', data)
      return
    }
  } catch {}
  if (typeof session?.append === 'function') {
    try { session.append('assistant/message', data) } catch {}
    return
  }
  const events = session?.events
  if (!Array.isArray(events) || !Object.isExtensible(events)) return
  try { events.push({ type: 'assistant/message', data }) } catch {}
}

function sensitivePath(path) { return /(?:^|[\\/])(?:\.env(?:\..*)?|\.credentials\.yaml|secrets?)(?:[\\/]|$)/i.test(path) }

/** Infer external read roots from literal paths; sensitive paths are never propagated. */
export function inferScopes(text, checks = [], ctx = {}) {
  const rawSources = [text, ...(Array.isArray(checks) ? checks : []).map((c) => c?.cmd || '')].map(String)
  const sources = rawSources.map((source) => source.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`<>)]+/g, ' '))
  const readRoots = [], notes = []
  const add = (raw) => {
    let value = String(raw || '').trim().replace(/^["'`([{]+|["'`),;，。、；：\]）}]+$/g, '').replace(/\\/g, '/')
    if (!value) return
    if (sensitivePath(value)) { notes.push(`dropped_sensitive: ${value}`); return }
    if (/^~[\\/]/.test(value)) value = join(homedir(), value.slice(2)).replace(/\\/g, '/')
    else if (/^(?:\$env:USERPROFILE|%USERPROFILE%)/i.test(value)) value = join(homedir(), value.replace(/^(?:\$env:USERPROFILE|%USERPROFILE%)[\\/]?/i, '')).replace(/\\/g, '/')
    else if (/^@plugins[\\/]/i.test(value)) value = join(homedir(), '.dsh', 'plugins', value.slice(8)).replace(/\\/g, '/')
    else if (/^@dsh[\\/]/i.test(value)) value = join(homedir(), '.dsh', value.slice(5)).replace(/\\/g, '/')
    else if (/^@[\w-]+[\\/]/.test(value)) {
      const name = value.match(/^@([\w-]+)/)[1]
      if (ctx.roots?.[name]) value = join(ctx.roots[name], value.slice(name.length + 2)).replace(/\\/g, '/')
      else return
    }
    if (!isAbsolute(value)) return
    if (/^[A-Za-z]:\/?$/.test(value) || sameDir(value, homedir())) {
      notes.push(`dropped_too_broad: ${value}`)
      if (ctx.strictScopeInfer === true) throw Object.assign(new Error(`DSH_E_SCOPE_INFER_TOO_BROAD: ${value}`), { code: 'DSH_E_SCOPE_INFER_TOO_BROAD' })
      return
    }
    let root = value
    try { if (existsSync(value) && statSync(value).isFile()) root = dirname(value) } catch {}
    if (/\.[A-Za-z0-9]+$/.test(value)) root = dirname(value)
    readRoots.push(root)
  }
  for (const source of sources) for (const match of String(source || '').matchAll(/(?:\$env:USERPROFILE|%USERPROFILE%|~)[\\/][^\s'"`，。、；：]+|@[\w-]+\/[^\s'"`，。、；：]+|(?<![A-Za-z])[A-Za-z]:(?:\\|\/(?!\/))[^\s'"`]*|(?:^|[\s=(])\/(?:Users|home)\/[^\s'"`，。、；：]+/g)) add(match[0].replace(/^[\s=(]/, ''))
  const hosts = new Set(), loopbackPorts = new Set()
  for (const text of rawSources) {
    for (const match of text.matchAll(/\b(?:ssh|scp)\s+(?:-[^\s]+\s+)*(?:([\w.-]+)@)?([\w.-]+\.[\w.-]+)/gi)) hosts.add(match[2])
    for (const match of text.matchAll(/\b(?:127\.0\.0\.1|localhost):(\d{1,5})\b/gi)) loopbackPorts.add(Number(match[1]))
  }
  return { readRoots, hosts: [...hosts], loopbackPorts: [...loopbackPorts], notes }
}

function gateError(code, index, reason) {
  throw Object.assign(new Error(`${code}: gate.checks[${index}].cmd ${reason}；建议：改用 npm --prefix <dir> test 或目录参数`), { code })
}

/** Reject non-literal gate commands before a child run, and deterministically expand test globs. */
export function lintMechanicalChecks(checks, ctx = {}) {
  return (checks || []).map((input, index) => {
    const check = { ...input }
    if (check.exit != null && !Number.isInteger(check.exit)) gateError('DSH_E_GATE_CHECK_FIELD', index, 'exit 必须为整数')
    if (check.minTests != null && (!Number.isInteger(check.minTests) || check.minTests <= 0)) gateError('DSH_E_GATE_CHECK_FIELD', index, 'minTests 必须为正整数')
    if (check.timeoutMs != null && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1000 || check.timeoutMs > 1800000)) gateError('DSH_E_GATE_CHECK_FIELD', index, 'timeoutMs 必须为 1000..1800000ms 整数')
    if (!check.cmd) return check
    const tokens = parseMechanicalCommand(check.cmd)
    if (!allowedMechCommand(check.cmd, ctx.mechCommands)) gateError('DSH_E_GATE_CMD_NOT_ALLOWED', index, '命令不在白名单')
    if (tokens.some((t) => /^(?:&&|\|\||\||;|>|2>&1)$/.test(t) || /\$\(|`|\$env:|%[^%]+%/.test(t))) gateError('DSH_E_GATE_CMD_SHELL_SYNTAX', index, '不支持 shell 元字符')
    const globIndex = tokens.findIndex((t) => /[*?]/.test(t))
    if (globIndex >= 0) {
      if (!/^node(?:\.exe)?$/i.test(tokens[0]) || tokens[1] !== '--test' || tokens.length !== 3) gateError('DSH_E_GATE_CMD_GLOB', index, '通配符不会经 shell 展开')
      const token = tokens[2].replace(/\\/g, '/'), cut = token.search(/[*?]/)
      const dir = resolve(ctx.workspace || process.cwd(), token.slice(0, cut).replace(/\/[^/]*$/, '') || '.')
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => globRegex(basename(token)).test(f)).map((f) => join(dir, f)) : []
      if (!files.length) gateError('DSH_E_GATE_CMD_GLOB', index, '通配符没有匹配文件')
      if ((ctx.writeScopes || []).some((p) => isPathInsideWorkspace(p, dir))) check.cmdDeferredGlob = true
      else check.cmdResolved = ['node', '--test', ...files.map((f) => JSON.stringify(f))].join(' ')
    }
    return check
  })
}
function normalizePathList(value, roots, workspace, field, write = false) {
  if (value == null) return value
  if (field === 'writeScope' && typeof value === 'string') value = [value]
  if (!Array.isArray(value)) throw new Error(`${field} 必须是路径数组`)
  return value.map((p) => {
    const out = expandPathMacro(p, roots, workspace)
    if (write && sensitivePath(out)) throw new Error(`${field} 禁止敏感路径：${out}`)
    if (write && isAbsolute(String(p)) === false && !/^@/.test(String(p)) && !isPathInsideWorkspace(workspace, out)) throw new Error(`${field} 相对路径越出 workspace：${p}`)
    return out
  })
}

function validateGate(gate) {
  if (gate == null) return null
  if (!isPlainObject(gate)) throw new Error('gate 必须是对象')
  if (gate.userAsk != null && (typeof gate.userAsk !== 'string' || !gate.userAsk.trim())) throw new Error('gate.userAsk 必须是非空字符串')
  let normalizedCriteria = gate.criteria
  if (Array.isArray(normalizedCriteria)) {
    const items = normalizedCriteria.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
    normalizedCriteria = items.map((s, i) => (/^\d+[.)、]/.test(s) ? s : `${i + 1}. ${s}`)).join('\n')
  }
  if (normalizedCriteria != null && (typeof normalizedCriteria !== 'string' || !normalizedCriteria.trim())) throw new Error('gate.criteria 必须是非空字符串或非空字符串数组')
  if (normalizedCriteria == null && !(Array.isArray(gate.checks) && gate.checks.length)) throw new Error('gate.criteria 缺省时必须提供 gate.checks')
  if (gate.checks != null && (!Array.isArray(gate.checks) || gate.checks.some((x) => !isPlainObject(x)))) throw new Error('gate.checks 必须是检查对象数组')
  if (gate.llm != null && !['auto', 'never'].includes(gate.llm)) throw new Error("gate.llm 仅支持 'auto' 或 'never'")
  if (gate.llm === 'never') normalizedCriteria = ''
  if (gate.mode != null && gate.mode !== 'verify') throw new Error("gate.mode 目前仅支持 'verify'")
  if (gate.commands != null && (!Array.isArray(gate.commands) || gate.commands.some((x) => typeof x !== 'string' || !x.trim()))) {
    throw new Error('gate.commands 必须是非空字符串组成的数组')
  }
  if (gate.onPartial != null && gate.onPartial !== 'skip' && gate.onPartial !== 'gate') {
    throw new Error("gate.onPartial 仅支持 'skip' 或 'gate'")
  }
  const maxFixRounds = gate.maxFixRounds ?? 1
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0 || maxFixRounds > 5) throw new Error('gate.maxFixRounds 必须是 0..5 的整数')
  return { ...gate, criteria: normalizedCriteria || '', checks: gate.checks ? gate.checks.map((x) => ({ ...x })) : [], llm: gate.llm || 'auto', mode: 'verify', onPartial: gate.onPartial || 'skip', maxFixRounds, commands: gate.commands ? [...gate.commands] : [] }
}

/**
 * 在不调用任何 relay 工具、也不注册后台 Job 的前提下展开并校验 v2 参数。
 * 返回的 dependsOn 仅供 onWriteConflict:'serial' 调度；默认 error 会在首个冲突处直接失败。
 */
export function preflightDispatchV2(args, config = DEFAULTS, modesInfo = { modes: BUILTIN_MODES, aliases: {} }) {
  if (!isPlainObject(args)) throw new Error('relay_dispatch 参数必须是对象')
  if (args.followUp != null) {
    if (args.tasks != null || args.startArgs != null) throw new Error('followUp 与 tasks/startArgs 互斥')
    return preflightFollowUp(args.followUp, config, modesInfo)
  }
  args = expandTargets(args, modesInfo)
  const hasTasks = args.tasks != null
  if (hasTasks && (!Array.isArray(args.tasks) || args.tasks.length === 0)) throw new Error('tasks 必须是非空数组')
  if (args.startArgs != null && !isPlainObject(args.startArgs)) throw new Error('startArgs 必须是对象')
  if (args.onWriteConflict != null && args.onWriteConflict !== 'error' && args.onWriteConflict !== 'serial') {
    throw new Error("onWriteConflict 仅支持 'error' 或 'serial'")
  }
  const onWriteConflict = args.onWriteConflict || 'error'
  const gate = validateGate(hasTasks && args.tasks.some((t) => t?.gate != null) ? (args.tasks.find((t) => t?.gate != null)?.gate || args.gate) : args.gate)
  const roots = modesInfo.roots || {}
  if (args.syncTargets != null && (!Array.isArray(args.syncTargets) || args.syncTargets.some((x) => !isPlainObject(x) || typeof x.source !== 'string' || typeof x.target !== 'string'))) throw new Error('syncTargets 必须是 {source,target,root?,mode?} 数组')
  if (args.handoff != null && !isPlainObject(args.handoff)) throw new Error('handoff 必须是对象')
  const handoff = Object.fromEntries(Object.entries(args.handoff || {}).map(([name, value]) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`handoff.${name} 必须是 path#exports 字符串`)
    const [path, symbols = ''] = value.split('#')
    return [name, { name, path, names: symbols.split(',').map((s) => s.trim()).filter(Boolean) }]
  }))
  const items = hasTasks ? args.tasks : [null]
  const scopeErrors = []
  const tasks = items.map((item, index) => {
    if (item != null && !isPlainObject(item)) throw new Error(`tasks[${index}] 必须是对象`)
    if (item && item.startArgs != null && !isPlainObject(item.startArgs)) throw new Error(`tasks[${index}].startArgs 必须是对象`)
    const merged = { ...(args.startArgs || {}), ...((item && item.startArgs) || {}) }
    if (item) {
      for (const key of V2_TASK_SHORTCUTS) {
        if (item[key] !== undefined && key !== 'specMetadata') merged[key] = item[key]
      }
    }
    const modeName = (item && item.mode != null ? item.mode : args.mode) || undefined
    const review = Boolean(item && item.review != null ? item.review : args.review)
    if (merged.workspace != null) merged.workspace = expandPathMacro(merged.workspace, roots, merged.workspace)
    const specFile = item?.specFile ?? args.specFile
    if (specFile != null) {
      const specPath = expandPathMacro(specFile, roots, merged.workspace)
      if (!existsSync(specPath) || !statSync(specPath).isFile()) throw new Error(`specFile 不存在：${specPath}`)
      const sections = item?.specSections ?? args.specSections
      if (sections != null && (!Array.isArray(sections) || sections.some((s) => typeof s !== 'string'))) throw new Error('specSections 必须是字符串数组')
      const stat = statSync(specPath)
      merged.task = `${merged.task || ''}\n规格：${specPath} ${(sections || []).join(' ')}。先读再动手；与本任务文本冲突时以本任务文本为准。`
      merged.specMetadata = { path: specPath, mtime: stat.mtime.toISOString(), size: stat.size, sections: sections || [] }
    }
    for (const field of ['writeScope', 'contextReadScope', 'reviewTargets']) if (merged[field] != null) merged[field] = normalizePathList(merged[field], roots, merged.workspace, field, field === 'writeScope')
    if (merged.task != null) merged.task = expandTextMacros(merged.task, roots, merged.workspace)
    const rawTask = merged.task
    const inferredScope = inferScopes(rawTask, gate?.checks, { roots, strictScopeInfer: args.strictScopeInfer === true || item?.strictScopeInfer === true })
    const knownHosts = new Set(Object.values(modesInfo.hosts || {}).map(String))
    for (const host of inferredScope.hosts) {
      if (!knownHosts.has(host) && merged.permissionPreset !== 'danger-full-access') scopeErrors.push(Object.assign(new Error(`tasks[${index}] DSH_E_SCOPE_HOST_UNDECLARED: ${host}；请在 dispatch-modes.yaml hosts 声明或显式使用 danger-full-access`), { code: 'DSH_E_SCOPE_HOST_UNDECLARED' }))
      if (merged.permissionPreset === 'read-only') scopeErrors.push(Object.assign(new Error(`tasks[${index}] DSH_E_SCOPE_PRESET_INSUFFICIENT: SSH 需要 workspace-write 或 danger-full-access（host=${host}）`), { code: 'DSH_E_SCOPE_PRESET_INSUFFICIENT' }))
    }
    merged.contextReadScope = [...new Set([...(merged.contextReadScope || [merged.workspace]), ...inferredScope.readRoots])]
    const outNames = item?.out == null ? [] : item.out
    const inNames = item?.in == null ? [] : item.in
    if (!Array.isArray(outNames) || !Array.isArray(inNames) || [...outNames, ...inNames].some((n) => typeof n !== 'string' || !handoff[n.replace(/^~/, '')])) throw new Error(`tasks[${index}] out/in 引用了未知 handoff 名称`)
    if (outNames.length && new Set(outNames).size !== outNames.length) throw new Error(`tasks[${index}] out 重复`)
    const produced = outNames.map((name) => handoff[name])
    for (const contract of produced) {
      contract.path = expandPathMacro(contract.path, roots, merged.workspace)
      contract.producer = index
      merged.task += `\n交接产出（路径与导出名是契约，不得更改）：${contract.path}${contract.names.length ? ` 导出 ${contract.names.join(', ')}` : ''}`
    }
    for (const rawName of inNames) {
      const contract = handoff[rawName.replace(/^~/, '')]
      merged.task += `\n交接输入：${contract.path}${contract.names.length ? ` 导出 ${contract.names.join(', ')}` : ''}。只读不改；文件不存在或导出名不符即 blocked，不要自己补一个。`
    }
    if (item?.syncMode != null && item.syncMode !== 'copy') throw new Error("syncMode 仅支持 'copy'")
    if (item?.sync != null && (!Array.isArray(item.sync) || item.sync.some((x) => !['plugins', 'pf'].includes(x)))) throw new Error("sync 仅支持 'plugins' 与 'pf'")
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
      if (!candidates.length && baseArgs.provider && baseArgs.model && Array.isArray(cfg.models) && cfg.models.length > 0) {
        const modeCandidates = applyMode(cfg, { task: '' }, modesInfo.aliases || {}).candidates
        const first = { provider: String(baseArgs.provider), model: String(baseArgs.model) }
        const rest = modeCandidates.filter((c) => !(c.provider === first.provider && c.model === first.model))
        if (rest.length > 0) candidates = [first, ...rest]
      }
    }
    const readOnly = ['investigate', 'verify', 'review'].includes(modeName) || review || baseArgs.permissionPreset === 'read-only'
    if (!readOnly && baseArgs.permissionPreset !== 'danger-full-access') {
      const writes = normalizePathList(baseArgs.writeScope, roots, baseArgs.workspace, 'writeScope') || []
      const writeIntent = String(rawTask || '').replace(/(?:不要|严禁|禁止|不得|不|未)(?:写入|修改|同步到|复制到)/g, '')
      if (/(?:写入|修改|同步到|复制到)/.test(writeIntent)) for (const path of inferredScope.readRoots) {
        if (!isPathInsideWorkspace(baseArgs.workspace, path) && !writes.some((p) => isPathInsideWorkspace(p, path))) scopeErrors.push(Object.assign(new Error(`tasks[${index}] DSH_E_SCOPE_WRITE_UNDECLARED: ${path}；请补 writeScope: ["${path}"]`), { code: 'DSH_E_SCOPE_WRITE_UNDECLARED' }))
      }
    }
    delete baseArgs.specMetadata
    if (baseArgs.writeScope != null && (!Array.isArray(baseArgs.writeScope) || baseArgs.writeScope.some((p) => typeof p !== 'string' || !p.trim()))) {
      throw new Error(`tasks[${index}].writeScope 必须是非空路径字符串组成的数组`)
    }
    const rawWriteScope = Array.isArray(baseArgs.writeScope) ? [...baseArgs.writeScope] : null
    const previewArgs = fillStartArgs(baseArgs, config, review)
    if (typeof previewArgs.workspace !== 'string' || !previewArgs.workspace.trim()) {
      throw new Error(`tasks[${index}] 缺少 workspace（该模式未配置默认 workspace）`)
    }
    if (typeof previewArgs.task !== 'string' || !previewArgs.task.trim()) {
      throw new Error(`tasks[${index}] 缺少非空 task`)
    }
    const writable = !review && V2_WRITABLE_PRESETS.has(previewArgs.permissionPreset)
    const label = String((item && item.label) || cleanBodyTitle(rawTask, modePrefix) || `task-${index + 1}`)
    const explicitDeps = new Set()
    for (const rawName of inNames) {
      if (rawName.startsWith('~')) continue
      const producer = handoff[rawName].producer
      if (!Number.isInteger(producer) || producer >= index) throw new Error(`tasks[${index}].in ${rawName} 必须由更靠前的唯一 out 生产`)
      explicitDeps.add(producer)
    }
    const rawDeps = (item && item.dependsOn) ?? (item && item.startArgs && item.startArgs.dependsOn)
    if (Array.isArray(rawDeps)) {
      for (const dep of rawDeps) {
        const d = Number(dep)
        if (!Number.isInteger(d) || d < 0 || d >= index) {
          throw new Error(`tasks[${index}].dependsOn 包含无效的前置任务索引 ${JSON.stringify(dep)}（必须为 0..${index - 1} 的整数）`)
        }
        explicitDeps.add(d)
      }
    }
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
      writeScope: writable ? (rawWriteScope || previewArgs.writeScope || [previewArgs.workspace]) : [],
      writable,
      dependsOn: explicitDeps,
      handoffOut: outNames,
      handoffIn: inNames,
      sync: item?.sync || [],
      syncMode: item?.syncMode,
      specMetadata: merged.specMetadata,
      inferredScope,
    }
  })

  if (scopeErrors.length) throw Object.assign(new Error(scopeErrors.map((e) => e.message).join('\n')), { code: scopeErrors.length === 1 ? scopeErrors[0].code : 'DSH_E_SCOPE_PREFLIGHT', errors: scopeErrors })

  for (const [name, contract] of Object.entries(handoff)) {
    if (!Number.isInteger(contract.producer)) throw new Error(`handoff.${name} 没有 out 生产者`)
    const producer = tasks[contract.producer]
    if (!producer.writeScope.some((root) => isPathInsideWorkspace(root, contract.path))) throw new Error(`handoff.${name} 不在生产者 writeScope 内`)
    for (const task of tasks) if (task.handoffIn.some((n) => n.replace(/^~/, '') === name)) {
      if (task.writeScope.some((root) => isPathInsideWorkspace(root, contract.path))) throw new Error(`handoff.${name} 不得位于消费者 writeScope 内`)
      contract.consumers ||= []
      contract.consumers.push({ index: task.index, parallel: task.handoffIn.includes(`~${name}`) })
      task.baseArgs.task += `，由 ${producer.label} 实现`
    }
  }
  const rawSyncTargets = hasTasks ? args.tasks.flatMap((t) => t?.syncTargets || []) : args.syncTargets || []
  const uniqueSyncTargets = rawSyncTargets.filter((x, i) => rawSyncTargets.findIndex((y) => y.source === x.source && y.target === x.target) === i)
  const syncTargets = uniqueSyncTargets.map((x) => {
    const root = x.root ? expandPathMacro(x.root, roots, tasks[0]?.workspace) : undefined
    const source = expandPathMacro(x.source, roots, tasks[0]?.workspace)
    const target = expandPathMacro(x.target, roots, tasks[0]?.workspace)
    return { source, target, root: root || (x.target.startsWith('@plugins/') ? join(homedir(), '.dsh', 'plugins') : x.target.startsWith('@pf/') ? roots.pf : dirname(target)), mode: x.mode || 'copy' }
  }).filter((x, i, all) => all.findIndex((y) => sameDir(y.source, x.source) && sameDir(y.target, x.target)) === i)
  if (syncTargets.some((x) => x.mode !== 'copy' && x.mode !== 'verify')) throw new Error('syncTargets.mode 仅支持 copy 或 verify')
  if (gate) {
    const ws = tasks[0]?.workspace
    gate.commands = gate.commands.map((c) => expandTextMacros(c, roots, ws))
    gate.criteria = expandTextMacros(gate.criteria, roots, ws)
    if (gate.criteria && (/(^|\n)\s*\d+[.)、]?\s*@tasks\s*(?=\n|$)/.test(gate.criteria) || gate.criteria.trim() === '@tasks' || gate.criteria.trim() === 'same')) {
      const derived = tasks.map((t) => `## ${t.label}\n${t.rawTask}`).join('\n\n')
      gate.criteria = gate.criteria && gate.criteria.trim() !== '@tasks' && gate.criteria.trim() !== 'same' ? gate.criteria.replace(/(^|\n)(\s*\d+[.)、]?\s*)@tasks\s*(?=\n|$)/g, `$1$2${derived}`) : `逐条核对以下各任务的 Contract / Inv / Delta / Verify 是否成立\n${derived}`
    }
    gate.userAsk ||= tasks[0]?.rawTask?.split(/\r?\n/)[0] || '验收流水线'
    gate.checks = gate.checks.map((check) => {
      const out = { ...check }
      for (const key of ['sha', 'exists', 'gitClean']) if (out[key] != null) out[key] = Array.isArray(out[key]) ? out[key].map((p) => expandPathMacro(p, roots, ws)) : expandPathMacro(out[key], roots, ws)
      if (out.exports) out.exports = { ...out.exports, file: expandPathMacro(out.exports.file, roots, ws) }
      if (out.cmd) out.cmd = expandTextMacros(out.cmd, roots, ws)
      for (const key of ['cwd', 'dir', 'workdir']) if (typeof out[key] === 'string') out[key] = expandPathMacro(out[key], roots, ws)
      return out
    })
  }

  if (gate) gate.checks = lintMechanicalChecks(gate.checks, { workspace: tasks[0]?.workspace, mechCommands: modesInfo.mechCommands, writeScopes: tasks.flatMap((t) => t.writeScope) })

  const conflicts = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]
      const b = tasks[j]
      if (!a.writable || !b.writable) continue
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
  return { hasTasks, tasks, gate, handoff, syncTargets, roots, mechCommands: modesInfo.mechCommands, onWriteConflict, conflicts, reloadPlugins: normalizeReloadPlugins(args.reloadPlugins), targets: args.targets, targetWriteScope: args.targetWriteScope || [] }
}

export function classifyGateFailure(mech, verdict) {
  const failed = (mech?.results || []).filter((r) => !r.ok)
  if (failed.some((r) => /白名单|shell|glob|DSH_E_GATE_/i.test(r.detail || ''))) return 'mech_config_error'
  if (failed.some((r) => r.kind === 'sha' || r.kind === 'syncTargets')) return 'mech_sync_drift'
  if (failed.some((r) => ['exists', 'exports', 'handoff'].includes(r.kind))) return 'mech_missing_artifact'
  if (failed.some((r) => r.kind === 'cmd')) return 'mech_test_fail'
  return ['partial', 'fail'].includes(verdict) ? 'verdict_partial_fail' : null
}

export function preflightFollowUp(followUp, config = DEFAULTS, modesInfo = {}) {
  if (!isPlainObject(followUp) || typeof followUp.pipelineId !== 'string' || !/^[\w.-]+$/.test(followUp.pipelineId)) throw Object.assign(new Error('DSH_E_FOLLOWUP_NO_MANIFEST: 无效 pipelineId'), { code: 'DSH_E_FOLLOWUP_NO_MANIFEST' })
  const path = join(config.manifestDir || join(homedir(), '.dsh', 'relay-pipelines'), `${followUp.pipelineId}.json`)
  let previous
  try { previous = config.readManifest ? config.readManifest(path) : JSON.parse(readFileSync(path, 'utf8')) } catch { throw Object.assign(new Error(`DSH_E_FOLLOWUP_NO_MANIFEST: ${followUp.pipelineId}`), { code: 'DSH_E_FOLLOWUP_NO_MANIFEST' }) }
  const current = config.currentSessionId
  if (current == null || previous.parentSessionId !== current) throw Object.assign(new Error('DSH_E_FOLLOWUP_FOREIGN: 只能续修当前会话的流水线'), { code: 'DSH_E_FOLLOWUP_FOREIGN' })
  if (!['done', 'completed'].includes(previous.phase) || !/RESULT:\s*(?:FAIL|PARTIAL|UNVERIFIED)/.test(previous.machineHeader || '') || (previous.items || []).some((i) => i.startUnknown)) throw Object.assign(new Error(`DSH_E_FOLLOWUP_STATE: phase=${previous.phase}`), { code: 'DSH_E_FOLLOWUP_STATE' })
  if ((previous.followUps || []).length >= 3) throw Object.assign(new Error('DSH_E_FOLLOWUP_EXHAUSTED'), { code: 'DSH_E_FOLLOWUP_EXHAUSTED' })
  const plan = previous.plan
  if (!plan?.tasks?.length) throw Object.assign(new Error('DSH_E_FOLLOWUP_STATE: 清单缺少 plan'), { code: 'DSH_E_FOLLOWUP_STATE' })
  const items = previous.items || [], index = followUp.target === 'auto' || followUp.target == null ? Math.max(0, items.findIndex((i) => i.kind !== 'gate' && i.status !== 'succeeded')) : followUp.target
  const task = plan.tasks[index]
  if (!task || !Number.isInteger(index)) throw Object.assign(new Error('DSH_E_FOLLOWUP_STATE: 无效 target'), { code: 'DSH_E_FOLLOWUP_STATE' })
  if (followUp.patchTask != null && (typeof followUp.patchTask !== 'string' || !followUp.patchTask.trim() || followUp.patchTask.length > 2000)) throw new Error('patchTask 必须是不超过 2000 字符的非空字符串')
  const patchTask = followUp.patchTask || '请复核上次交付并重跑继承的机械门；若仍失败请报告具体原因。'
  const sessionId = items.find((i) => i.index === index && i.kind !== 'gate')?.sessionId
  const failed = items.find((i) => i.kind === 'gate')?.output || items.find((i) => i.kind !== 'gate' && i.status !== 'succeeded')?.error || ''
  const nextTasks = plan.tasks.map((t) => ({ ...t, candidates: Array.isArray(t.candidates) ? t.candidates : [], dependsOn: new Set(t.dependsOn || []) }))
  const followUpBaseArgs = normalizeStartArgs({ ...task.baseArgs, task: `${patchTask}\n上次失败明细：\n${String(failed).slice(-500)}`, ...(sessionId ? { sessionId } : { sessionMode: 'fresh' }) }, config)
  const followUpPreviewArgs = normalizeStartArgs({ ...task.previewArgs, ...followUpBaseArgs }, config)
  nextTasks[index] = { ...task, dependsOn: new Set(), rawTask: patchTask, baseArgs: followUpBaseArgs, previewArgs: followUpPreviewArgs }
  const nextPlan = { ...plan, tasks: nextTasks, gate: nextTasks[index].followUpGate || plan.gate, followUpOf: followUp.pipelineId, followUpTarget: index }
  if (followUp.patchGate != null) {
    if (!isPlainObject(followUp.patchGate)) throw new Error('patchGate 必须是对象')
    nextPlan.gate = validateGate({ ...plan.gate, ...followUp.patchGate })
    nextPlan.gate.checks = lintMechanicalChecks(nextPlan.gate.checks, { workspace: task.workspace, mechCommands: plan.mechCommands || modesInfo.mechCommands, writeScopes: task.writeScope || [] })
  } else nextPlan.gate.checks = lintMechanicalChecks(nextPlan.gate.checks, { workspace: task.workspace, mechCommands: plan.mechCommands || modesInfo.mechCommands, writeScopes: task.writeScope || [] })
  return { ...nextPlan, followUp: true, previous, scopeNotes: plan.tasks.flatMap((t) => t.inferredScope?.notes || []) }
}

export function normalizeReloadPlugins(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) throw new Error('reloadPlugins 必须是插件名字符串数组')
  return [...new Set(value.map((v) => v.trim()))]
}

export const V2_CAPABILITIES_TTL_MS = 60000

/** start_run 在写任务中结果不可知时不得换模型重试，避免同一任务被实际执行两次。 */
export function isUnknownStartError(err) {
  const s = String((err && err.message) || err || '')
  return /start_run 超时|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|connection (failed|refused|reset|closed)|timed? ?out|未返回 runId|\b50[0234]\b|overloaded|aborted|disposed/i.test(s)
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

/**
 * 热重载/卸载只把本地 job 标成已报告，抑制 [status:killed] 完成通知。
 * dsh-jobs kill(id, caller, reason) 会校验 owner，成功后把 reported 置真；
 * kill(id, reason) 会把 reason 当成 caller，owned job 抛错且 reported 保持 false。
 * 调用方必须先置上 cancelled，避免 kill 重入时再次取消远端 run。
 */
function quietDisposedJob(jobs, jobId, caller) {
  if (!jobId || !jobs || typeof jobs.kill !== 'function') return
  const reason = 'relay_dispatch disposed'
  try {
    jobs.kill(jobId, caller, reason)
  } catch {
    try { jobs.kill(jobId, reason) } catch {}
  }
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

/**
 * 格式化 v2 流水线汇总文本：
 * - 当存在 gate 时，把 [gate] 区块置于所有 [task#i] 之前（紧跟在 gate_user_ask 下方），
 *   并将每个 [task#i] 的内联文本预览上限从 2000 缩减为 300 字符（无 gate 时保持 1500~2000），
 *   使带 Gate 的 v2 完成通知稳定保持在预算内（full_in_detail=1）。
 */
export function formatPipelineSummary(manifest, maxResultChars = 2000, options = {}) {
  const m = manifest || {}
  const items = Array.isArray(m.items) ? m.items : []
  const slim = options.slim === true
  const brief = options.brief === true
  const gateObj = m.gate && typeof m.gate === 'object' ? m.gate : null
  const gateUserAsk = (gateObj && gateObj.userAsk) || m.gateUserAsk
  const gateItems = items.filter((i) => i && i.kind === 'gate')
  if (slim && !gateItems.length) gateItems.push({ kind: 'gate', status: 'pass', output: m.gateConclusion || 'pass' })
  if (gateItems.length === 0 && gateObj && (gateObj.status || gateObj.output || gateObj.verdict)) {
    gateItems.push({ index: gateObj.index ?? items.length, kind: 'gate', label: gateObj.label || 'gate', ...gateObj })
  }
  const taskItems = items.filter((i) => i && i.kind !== 'gate')
  const hasGate = Boolean(m.gate || gateUserAsk || gateItems.length > 0)
  const ordered = hasGate ? [...gateItems, ...taskItems] : items
  const noGateMax = Math.max(1500, Math.min(2000, maxResultChars || 2000))
  const lines = [`pipeline_id: ${m.pipelineId || '?'}`]
  if (m.reloaded) lines.push(`reloaded: ${m.reloaded}`)
  if (gateUserAsk && !slim) lines.push(`gate_user_ask: ${truncateUtf8(String(gateUserAsk), 60)}`)
  const oneLine = (value, max = 160) => {
    const text = String(value || '(无)').replace(/\s+/g, ' ').trim()
    const summaryLine = text.split(/(?:^|\s)(?:summary|总结)[:：]\s*/i).at(-1) || text
    return clip(summaryLine.replace(/^verdict:\s*\w+\s*/i, ''), max)
  }
  if (brief) {
    const gate = gateItems[0]
    const failureClass = gate ? classifyGateFailure(gate.mechanical, gate.verdict) : undefined
    if (gate) lines.push(`[gate] ${gate.status || 'unknown'}/${gate.verdict || 'unknown'} class=${failureClass || 'none'}`)
    const failures = gate?.mechanical?.results?.filter((r) => !r.ok) || []
    if (failures.length) {
      for (const result of failures.slice(0, 3)) {
        const flat = String(result.detail || '').replace(/\s+/g, ' ').trim()
        let tail = flat
        if (byteLen(flat) > 160) {
          tail = Array.from(flat).reverse().join('')
          tail = truncateUtf8(tail, 160)
          tail = Array.from(tail).reverse().join('')
          tail = `…${tail}`
        }
        lines.push(`  x ${result.kind}#${result.index}: ${tail}`)
      }
      if (failures.length > 3) lines.push(`  +${failures.length - 3} more`)
    } else if (gate) {
      const reason = oneLine(gate.output || gate.error, 300)
      if (reason && reason !== '(无)') lines.push(`[不通过] ${reason}`)
    }
    const unsuccessful = taskItems.filter((item) => item.status !== 'succeeded')
    for (const item of unsuccessful) {
      lines.push(`[task#${item.index ?? 0}] ${item.status || 'unknown'} ${oneLine(item.output || item.error, 100)}`)
      if (item.startUnknown) lines.push('start_unknown=1')
    }
    const files = [...new Set(unsuccessful.flatMap((item) => item.git?.available ? item.git.files || [] : []))]
    if (files.length) lines.push(`changed_files: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` +${files.length - 6}` : ''}`)
    if (m.phase === 'detached') lines.push('phase=detached')
    if (items.some((item) => item.selfReview)) lines.push('self_review=1')
    const cancelled = m.phase === 'cancelled' || unsuccessful.some((item) => item.status === 'cancelled')
    const result = /RESULT:\s*(\w+)/.exec(m.machineHeader || '')?.[1]
    if (!cancelled && result !== 'UNVERIFIED' && m.pipelineId && m.phase !== 'detached' && !items.some((item) => item.startUnknown)) {
      lines.push(`next: relay_dispatch({followUp:{pipelineId:${JSON.stringify(m.pipelineId)},patchTask:"修复上次失败检查"}})`)
    }
    if (m.pipelineId) lines.push(`detail: ~/.dsh/relay-pipelines/${m.pipelineId}.json`)
    return lines.join('\n')
  }
  for (const item of ordered) {
    const kind = item.kind || 'task'
    const idx = item.index ?? 0
    const label = item.label || (kind === 'gate' ? 'gate' : `task-${idx + 1}`)
    const notes = Array.isArray(item.notes) ? item.notes : []
    if (slim) {
      if (kind === 'gate') {
        lines.push(`[gate] ${item.status}${item.verdict ? `/${item.verdict}` : ''}: ${oneLine(item.output)}`)
      } else {
        const files = item.git?.available ? (item.git.files || []) : []
        lines.push(`[task#${idx}] ${item.status}${item.model ? ` ${item.model}` : ''}; changed_files: ${files.length ? files.join(', ') : '(none)'}; summary: ${oneLine(item.output || item.error, 120)}`)
      }
      continue
    }
    const itemMax = kind === 'gate' ? Math.min(1500, maxResultChars || 1500) : (hasGate ? 300 : noGateMax)
    lines.push(`\n[${kind}#${idx}] ${label} -> ${item.status}${item.model ? ` (${item.model})` : ''}${item.runId ? ` runId=${item.runId}` : ''}`)
    if (item.startUnknown) lines.push('start_unknown=1')
    if (item.git && item.git.available) lines.push(`changed_files: ${(item.git.files && item.git.files.join(', ')) || '(无)'}`)
    if (notes.length) lines.push(notes.join('；'))
    lines.push(conclusion({ assistantText: item.output || item.error || '(无)' }, itemMax))
  }
  const failed = items.some((i) => i.status === 'failed') || items.some((i) => i.kind === 'gate' && i.verdict !== 'pass')
  if (failed && m.pipelineId && !['running', 'gate', 'detached'].includes(m.phase) && !items.some((i) => i.startUnknown)) {
    const target = items.find((i) => i.kind !== 'gate' && i.status !== 'succeeded')?.index ?? 0
    lines.push(`repairable: yes  fix_target=${target}`)
    lines.push(`next: relay_dispatch({followUp:{pipelineId:${JSON.stringify(m.pipelineId)},patchTask:"修复上次失败检查"}})`)
  }
  return lines.join('\n')
}

function execGit(workspace, args, env = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-c', 'core.quotepath=off', ...args]
    execFile('git', fullArgs, {
      cwd: workspace,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG'))), ...env },
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

function filesUnder(path) {
  const stat = statSync(path)
  if (stat.isFile()) return [{ absolute: path, relative: basename(path) }]
  const out = []
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.includes('.bak')) continue
      const absolute = join(dir, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) out.push({ absolute, relative })
    }
  }
  walk(path)
  return out
}
function pathSha(path) {
  const files = filesUnder(path)
  return createHash('sha256').update(files.map((f) => `${f.relative}\0${createHash('sha256').update(readFileSync(f.absolute)).digest('hex')}\0`).join('')).digest('hex')
}
export function staticExports(file, names) {
  const source = readFileSync(file, 'utf8')
  return names.filter((raw) => {
    const name = raw.split('(')[0].trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false
    const escaped = name.replace(/[$]/g, '\\$')
    return new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${escaped}\\b|\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, 'm').test(source)
  })
}
export function verifyHandoffContract(contract) {
  if (!existsSync(contract.path)) return { ok: false, detail: `缺少交接产物：${contract.path}` }
  const missing = (contract.names || []).filter((name) => !staticExports(contract.path, [name]).length)
  return { ok: !missing.length, detail: missing.length ? `缺少导出：${missing.join(', ')}` : `交接产物有效：${contract.path}` }
}
function globRegex(glob) {
  return new RegExp('^' + String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '.') + '$', 'i')
}
function allowedMechCommand(command, prefixes) {
  if ((prefixes || []).some((prefix) => command === prefix || command.startsWith(`${prefix} `))) return true
  const tokens = parseMechanicalCommand(command)
  const executable = String(tokens[0] || '').replace(/\.(?:exe|cmd)$/i, '').toLowerCase()
  const args = tokens.slice(1)
  if (executable === 'node') {
    if (args[0] === '--check' && args.length === 2) return true
    if (args[0] === '--test') return true
    if (args.length === 1 && /(?:^|[\\/])(?:test[\\/][\w.-]+|[^\\/]+\.test)\.(?:m?js|cjs)$/i.test(args[0])) return true
  }
  if (['npm', 'pnpm'].includes(executable)) {
    if (args[0] === 'test' || args[0] === '--prefix' && args[2] === 'test') return true
    if (args[0] === 'run' && args.length === 2 && /^(?:test(?::[\w-]+)?|check(?::[\w-]+)?|lint|typecheck|type-check|validate)$/i.test(args[1])) return true
    if (executable === 'pnpm' && ['exec', 'dlx'].includes(args[0]) && /^(?:vitest|jest|tsc|eslint)$/i.test(args[1] || '')) return true
  }
  if (executable === 'git') return ['diff', 'status', 'show', 'log', 'rev-parse', 'fsck', 'ls-files'].includes(args[0])
  return false
}
export function parseMechanicalCommand(command) {
  const tokens = String(command).match(/"[^"]*"|'[^']*'|\S+/g) || []
  return tokens.map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'))
}
function execCheck(command, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const [rawExecutable, ...args] = parseMechanicalCommand(command)
    const isWinCmd = process.platform === 'win32' && /^(?:npm|npx|pnpm|yarn)(?:\.cmd)?$/i.test(rawExecutable)
    const cliName = `${rawExecutable.replace(/\.cmd$/i, '').toLowerCase()}-cli.js`
    const npmCliCandidates = isWinCmd ? [
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', cliName),
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', cliName) : '',
    ].filter(Boolean) : []
    const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate)) || ''
    const useNodeCli = Boolean(npmCli && existsSync(npmCli))
    // Node 22 blocks direct .cmd execution without a shell on Windows.
    const useCmd = isWinCmd && !useNodeCli
    // Bare `node` is a PATH lookup. The DSH host often has no node on PATH, so
    // execFile returns ENOENT in a few milliseconds and minTests stays unknown.
    const isNode = /^node(?:\.exe)?$/i.test(rawExecutable)
    const executable = (isNode || useNodeCli) ? process.execPath : useCmd ? (process.env.ComSpec || 'cmd.exe') : rawExecutable
    const finalArgs = isNode
      ? args
      : useNodeCli
        ? [npmCli, ...args]
        : useCmd
          ? ['/d', '/s', '/c', [rawExecutable, ...args].map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(' ')]
          : args
    // A gate often runs inside `node --test`. Inheriting NODE_TEST_CONTEXT makes the
    // child `node --test` treat itself as recursive and skip the file, so minTests sees no count.
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key === 'NODE_CHANNEL_FD' || key === 'NODE_CHANNEL_SERIALIZATION_MODE' || key.startsWith('NODE_TEST_')) delete env[key]
    }
    if (cwd && !existsSync(cwd)) {
      resolve({ code: 'ENOENT', output: `ENOENT: cwd not found: ${cwd}` })
      return
    }
    execFile(executable, finalArgs, { cwd, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const note = error && typeof error.code !== 'number' ? `\n${error.code}: ${error.message}` : ''
      resolve({ code: error?.code ?? 0, output: `${stdout || ''}${stderr || ''}${note}` })
    })
  })
}
export async function runMechanicalChecks(checks, ctx = {}) {
  const results = []
  for (const check of checks || []) {
    const started = Date.now()
    let kind = 'unknown', ok = false, detail = ''
    try {
      if (check.sha) {
        kind = 'sha'; const hashes = check.sha.map((p) => pathSha(p)); ok = new Set(hashes).size === 1; detail = check.sha.map((p, i) => `${p}=${hashes[i]}`).join(' ')
      } else if (check.gitClean) {
        kind = 'gitClean'; detail = await execGit(check.gitClean, ['status', '--porcelain']); ok = !detail.trim(); detail ||= 'clean'
      } else if (check.noDiff) {
        kind = 'noDiff'; const regexes = check.noDiff.map(globRegex); const bad = []
        for (const item of ctx.items || []) for (const line of String(item.git?.nameStatus || '').split(/\r?\n/).filter(Boolean)) {
          const [status, file] = line.split(/\s+/, 2)
          if (regexes.some((re) => re.test(file)) && !(check.allowAdded && status === 'A')) bad.push(file)
        }
        ok = !bad.length; detail = bad.length ? `禁止变更：${[...new Set(bad)].join(', ')}` : '无禁止差分'
      } else if (check.cmd) {
        kind = 'cmd'
        if (!allowedMechCommand(check.cmd, ctx.mechCommands)) throw new Error(`机械命令不在白名单：${check.cmd}`)
        let command = check.cmdResolved || check.cmd
        if (check.cmdDeferredGlob) command = lintMechanicalChecks([{ ...check, cmdDeferredGlob: false }], { ...ctx, writeScopes: [] })[0].cmdResolved
        const run = await execCheck(command, check.cwd || check.dir || check.workdir || ctx.workspace, check.timeoutMs)
        const matches = [...run.output.matchAll(/tests\s+(\d+)\s*$/gim)]
        const tests = matches.length ? matches.reduce((sum, m) => sum + Number(m[1]), 0) : null
        const failures = [...run.output.matchAll(/(?:^|\s)(?:fail|failed|failures)\s+(\d+)\s*$/gim)]
        const explicitFailure = failures.some((m) => Number(m[1]) > 0)
        const enoughTests = check.minTests == null || (run.code === 0 && !explicitFailure && tests == null) || (tests != null && tests >= check.minTests)
        ok = run.code === (check.exit ?? 0) && !explicitFailure && enoughTests
        detail = `exit=${run.code} tests=${tests ?? 'unknown'} ${run.output.slice(-500)}`
      } else if (check.exists) {
        kind = 'exists'; const paths = Array.isArray(check.exists) ? check.exists : [check.exists]; const missing = paths.filter((p) => !existsSync(p)); ok = !missing.length; detail = missing.length ? `不存在：${missing.join(', ')}` : '全部存在'
      } else if (check.exports) {
        kind = 'exports'; const found = staticExports(check.exports.file, check.exports.names || []); ok = found.length === (check.exports.names || []).length && existsSync(check.exports.file); detail = `导出 ${found.join(', ') || '(无)'}`
      } else throw new Error('未知机械检查')
    } catch (err) { ok = false; detail = String((err && err.message) || err) }
    results.push({ index: results.length, kind, ok, detail, ms: Date.now() - started })
  }
  return { pass: results.every((r) => r.ok), results }
}

export function syncTargetsNow(targets, pipelineId) {
  const copied = []
  for (const target of targets || []) {
    const source = resolve(target.source), destination = resolve(target.target)
    if (sensitivePath(destination) || !isPathInsideWorkspace(target.root, destination)) throw new Error(`syncTargets 目标越界或敏感：${destination}`)
    for (const file of filesUnder(source)) {
      const relative = statSync(source).isFile() ? basename(source) : file.relative
      const dest = statSync(source).isFile() ? destination : join(destination, relative)
      if (!isPathInsideWorkspace(target.root, dest)) throw new Error(`syncTargets 文件目标越界：${dest}`)
      mkdirSync(dirname(dest), { recursive: true })
      if (target.mode === 'copy') {
        if (existsSync(dest)) copyFileSync(dest, `${dest}.bak-${pipelineId}`)
        copyFileSync(file.absolute, dest)
      }
      copied.push({ source: file.absolute, target: dest })
    }
  }
  const mismatches = copied.filter((x) => !existsSync(x.target) || createHash('sha256').update(readFileSync(x.source)).digest('hex') !== createHash('sha256').update(readFileSync(x.target)).digest('hex'))
  return { pass: !mismatches.length, copied: copied.length, mismatches }
}

const COLLAPSED_SESSION_LIMIT = 5
const workspaceAttachInflight = new Map()
const INJECTED_CHILD_ID = /(?:^|\s)id=(session-[A-Za-z0-9_-]+)\b/
const INJECTED_CHILD_PARENT = /\bparentSession=(session-[A-Za-z0-9_-]+)\b/

function registryOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const got = ctx.get('workspaceRegistry')
      if (got) return got
    } catch {}
  }
  return ctx.workspaceRegistry
}

function asList(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value[Symbol.iterator] === 'function') {
    try { return [...value] } catch { return [] }
  }
  return []
}

function workspaceSessionIds(workspace) {
  if (!workspace || typeof workspace !== 'object') return []
  const raw = workspace.sessionIds ?? workspace.record?.sessionIds
  return asList(raw)
}

function cwdOfSession(session) {
  if (!session || typeof session !== 'object') return undefined
  return session.header?.cwd || session.meta?.cwd || session.cwd || session.session?.header?.cwd
}

function parentOfSession(session) {
  if (!session || typeof session !== 'object') return undefined
  const parent = session.header?.parentSession || session.meta?.parentSession || session.parentSession
  return parent != null && parent !== '' ? parent : undefined
}

function idOfSession(session) {
  if (!session || typeof session !== 'object') return undefined
  return session.id || session.header?.id
}

/** 诊断日志里最近若干条成功注入 parentSession 的子会话。 */
export function parseInjectedChildLines(text, limit = 50) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.includes('result=inject')) continue
    const id = line.match(INJECTED_CHILD_ID)
    const parent = line.match(INJECTED_CHILD_PARENT)
    if (!id || !parent) continue
    rows.push({ childId: id[1], parentSessionId: parent[1] })
  }
  const cap = limit > 0 ? limit : 50
  return rows.length > cap ? rows.slice(-cap) : rows
}

/**
 * 把派发出来的子会话挂进父会话所在工作区的 sessionIds。
 * 侧边栏只认 workspace.sessionIds，不认 session.cwd；漏挂就会掉进 Ungrouped。
 * attachSession 会把子会话插到最前。父会话若因此被挤出折叠后的前 5 行，再挪回子会话前面。
 * 失败只吞掉，派发本身不能因此中断。同一子会话的并发调用合并成一次。
 */
export function attachChildToWorkspace(ctx, childSessionId, parentSessionId, cwd) {
  if (!childSessionId) return Promise.resolve()
  const key = String(childSessionId)
  const existing = workspaceAttachInflight.get(key)
  if (existing) return existing
  const run = attachChildToWorkspaceNow(ctx, childSessionId, parentSessionId, cwd).catch(() => {}).finally(() => {
    if (workspaceAttachInflight.get(key) === run) workspaceAttachInflight.delete(key)
  })
  workspaceAttachInflight.set(key, run)
  return run
}

async function attachChildToWorkspaceNow(ctx, childSessionId, parentSessionId, cwd) {
  try {
    const reg = registryOf(ctx)
    if (!reg || typeof reg.list !== 'function') return
    let listed = []
    try { listed = asList(reg.list()) } catch { listed = [] }
    let workspace
    if (parentSessionId && cwd) {
      workspace = listed.find((ws) => ws && workspaceSessionIds(ws).includes(parentSessionId) && sameDir(ws.path, cwd))
    }
    if (!workspace && cwd && typeof reg.resolveByPath === 'function') {
      try { workspace = await reg.resolveByPath(cwd) } catch {}
    }
    if (!workspace && cwd) {
      workspace = listed.find((ws) => ws && sameDir(ws.path, cwd))
    }
    if (!workspace || typeof workspace.attachSession !== 'function') return
    try { await workspace.attachSession(childSessionId) } catch {}
    if (!parentSessionId || typeof workspace.insertSessionBefore !== 'function') return
    try {
      const visible = (ids) => {
        const childIdx = ids.indexOf(childSessionId)
        const parentIdx = ids.indexOf(parentSessionId)
        return childIdx >= 0 && parentIdx >= 0 && childIdx < COLLAPSED_SESSION_LIMIT && parentIdx < COLLAPSED_SESSION_LIMIT
      }
      let ids = workspaceSessionIds(workspace)
      if (!ids.includes(parentSessionId) || visible(ids)) return
      if (ids.indexOf(childSessionId) !== 0) {
        const anchor = ids.find((id) => id !== childSessionId)
        await workspace.insertSessionBefore(childSessionId, anchor)
        ids = workspaceSessionIds(workspace)
      }
      if (ids.includes(parentSessionId) && ids.includes(childSessionId) && ids.indexOf(parentSessionId) !== 0) {
        await workspace.insertSessionBefore(parentSessionId, childSessionId)
      }
    } catch {}
  } catch {}
}

/**
 * 插件加载时把已经派发出去、但还没进 workspace.sessionIds 的子会话补挂上。
 * 来源是当前 sessions 列表，外加诊断日志里最近 50 条 inject 记录。
 */
export async function reconcileStrayChildSessions(ctx, config = {}) {
  try {
    const reg = registryOf(ctx)
    if (!reg || typeof reg.list !== 'function') return
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const wanted = new Map()
    if (sessions && typeof sessions.list === 'function') {
      let live = []
      try { live = asList(sessions.list()) } catch { live = [] }
      for (const session of live) {
        const id = idOfSession(session)
        const parent = parentOfSession(session)
        const cwd = cwdOfSession(session)
        if (!id || !parent || !cwd) continue
        wanted.set(id, { parentSessionId: parent, cwd })
      }
    }
    const logPath = config.parentLogPath === undefined ? PARENT_LOG_PATH : config.parentLogPath
    if (logPath) {
      let text = ''
      try { if (existsSync(logPath)) text = readFileSync(logPath, 'utf8') } catch {}
      for (const row of parseInjectedChildLines(text, 50)) {
        let cwd = wanted.get(row.childId)?.cwd
        if (!cwd && sessions && typeof sessions.get === 'function') {
          try { cwd = cwdOfSession(sessions.get(row.childId)) } catch {}
        }
        if (!cwd) continue
        wanted.set(row.childId, { parentSessionId: row.parentSessionId, cwd })
      }
    }
    let listed = []
    try { listed = asList(reg.list()) } catch { listed = [] }
    for (const [childId, info] of wanted) {
      const home = listed.find((ws) => ws && sameDir(ws.path, info.cwd))
      if (!home) continue
      if (workspaceSessionIds(home).includes(childId)) continue
      await attachChildToWorkspace(ctx, childId, info.parentSessionId, info.cwd)
    }
  } catch {}
}

function clientPkgMatches(entryName, raw) {
  const name = String(entryName || '')
  const token = String(raw || '').trim()
  if (!name || !token) return false
  const short = token.includes('/') ? token.split('/').pop() : token
  return name === token || name === short || name.endsWith(`/${short}`)
}

const clientRevivePending = new Set()

function scheduleClientRevive(ctx, raw, entries) {
  if (!raw || clientRevivePending.has(raw)) return
  clientRevivePending.add(raw)
  Promise.resolve().then(async () => {
    try {
      const ghost = ctx && ctx.fiber
      const linked = entries.some((entry) => entry && entry.fiber === ghost)
      if (ghost && ghost.uid && !linked && typeof ghost.dispose === 'function') {
        try { await ghost.dispose() } catch {}
      }
      for (const entry of entries) {
        if (entry?.fiber?.state === 2) continue
        try { if (entry.fiber && typeof entry._dispose === 'function') await entry._dispose() } catch {}
        try { entry.fiber = undefined } catch {}
        try { if (entry.disabled) entry.disabled = false } catch {}
        try { if (entry.options && entry.options.disabled != null) delete entry.options.disabled } catch {}
        try {
          const parent = entry.parent
          if (parent && Array.isArray(parent.data)) {
            for (const row of parent.data) if (row && row.id === entry.id && row.disabled != null) delete row.disabled
          }
        } catch {}
        try { if (!entry.fiber && typeof entry.refresh === 'function') await entry.refresh() } catch {}
      }
      try { reloadPluginByName(ctx, raw) } catch {}
    } finally {
      clientRevivePending.delete(raw)
    }
  }).catch(() => {})
}

/**
 * 热重载后补登记 clientModules。
 * processOne 在 entry.disabled 或 pkgMeta 负缓存（null，且不过期）时会 table.delete，
 * /plugins/<pkg>/client.js 随之 404。先清 disabled 与 null 缓存；没有活 fiber 时不调用 processOne，避免误删。
 */
export function reloadPluginByName(ctx, pluginName) {
  const raw = String(pluginName || '').trim()
  if (!raw || !ctx) return { refreshed: false, reason: 'missing' }
  const entries = []
  let loader = ctx.loader
  try { if ((!loader || typeof loader.entries !== 'function') && typeof ctx.get === 'function') loader = ctx.get('loader') } catch {}
  try {
    if (loader && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        if (!entry || entry.options?.group) continue
        if (clientPkgMatches(entry.options?.name, raw)) entries.push(entry)
      }
    }
  } catch {}
  for (const entry of entries) {
    try { if (entry.disabled) entry.disabled = false } catch {}
    try { if (entry.options && entry.options.disabled != null) delete entry.options.disabled } catch {}
    try {
      const parent = entry.parent
      if (parent && Array.isArray(parent.data)) {
        for (const row of parent.data) {
          if (!row || row.disabled == null) continue
          if (row.id === entry.id || row.name === entry.options?.name) delete row.disabled
        }
      }
    } catch {}
  }
  const qualifying = entries.filter((entry) => entry.fiber != null && !entry.disabled && entry.options?.disabled == null)
  let cm
  try { cm = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined } catch { cm = undefined }
  if (!cm) return { refreshed: false, reason: 'no-clientModules', cleared: entries.length }
  if (!qualifying.length) {
    scheduleClientRevive(ctx, raw, entries)
    return {
      refreshed: false,
      reason: 'no-live-entry',
      cleared: entries.length,
      diag: entries.map((entry) => ({
        id: entry.id,
        fiber: entry.fiber ? entry.fiber.state : null,
        disabled: !!entry.disabled,
        optionsDisabled: entry.options?.disabled ?? null,
      })),
    }
  }
  const targets = [...new Set(qualifying.map((entry) => entry.options.name))]
  try {
    const meta = cm.pkgMeta
    if (meta && typeof meta.get === 'function' && typeof meta.delete === 'function') {
      const keys = typeof meta.keys === 'function' ? [...meta.keys()] : targets
      for (const key of keys) {
        if (!targets.includes(key) && !clientPkgMatches(key, raw)) continue
        if (meta.get(key) == null) meta.delete(key)
      }
    }
  } catch {}
  let changed = false
  if (typeof cm.processOne === 'function') {
    for (const pkgName of targets) {
      try { if (cm.processOne(pkgName)) changed = true } catch {}
    }
  }
  if (changed && typeof cm.compose === 'function') {
    try {
      cm.composed = cm.compose()
      if (typeof cm.notifyGraphChanged === 'function') cm.notifyGraphChanged()
    } catch {}
  }
  const present = !!(cm.table && typeof cm.table.has === 'function' && targets.some((pkgName) => cm.table.has(pkgName)))
  return { refreshed: present || changed, changed, names: targets }
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
  const activePipelines = new Map()
  const pendingPipelines = new Set()
  const resumerTimers = new Set()
  let capabilitiesCache = { at: 0, ids: null }

  function getWakeState(agent) {
    const events = agent && agent.session ? sessionEvents(agent.session) : null
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
  function scheduleCompletionWake(owner, jobId, hooks = {}) {
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
      const events = sessionEvents(session)
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
      const events = sessionEvents(session)
      let lastStart = -1
      let lastEnd = -1
      for (let i = 0; i < events.length; i++) {
        if (events[i]?.type === 'turn/start') lastStart = i
        else if (events[i]?.type === 'turn/end') lastEnd = i
      }
      return lastStart > lastEnd
    }

    const cancelWake = (delivered = false) => {
      if (finished) return
      finished = true
      unhook()
      if (timer) clearTimeout(timer)
      timer = null
      wakeTimers.delete(cancelWake)
      if (delivered) {
        try { hooks.onDelivered?.() } catch {}
      }
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
        cancelWake(true)
        return
      }
      if (owner.status !== 'idle' || hasOpenTurn() || prefixEpochCompacting(sessionForParent(owner.id))) {
        sawBusy = true
        queueCheck(wakePollMs)
        return
      }

      // 每个定时器只能处理自己这次结算的通知。前几个已由宿主 followup
      // 唤醒的定时器不得借后来的 pending 再唤醒一次；自己的 inject 通知
      // 若已被其他路径消费，也不得凭保存的消息副本重复补投。
      if (!deliveredByThisWake && followedUp) {
        cancelWake(true)
        return
      }
      if (!deliveredByThisWake && injectedMsg !== null && owner.inbox && !isPendingMessage(injectedMsg)) {
        cancelWake(true)
        return
      }

      // 已补投过的 schedule 只能重试自己那条仍滞留信箱的通知。
      // 若它已被消费，则立即收口；绝不能把后续 job 的 pending 通知抢来再投一次。
      if (deliveredByThisWake) {
        if (!deliveredMsg || !isPendingMessage(deliveredMsg)) {
          cancelWake(true)
          return
        }
        injectedMsg = deliveredMsg
      }

      const curState = getWakeState(owner)
      const pending = hasPendingInbox(owner)
      if (!pending && injectedMsg === null) {
        cancelWake(owner.status === 'idle' && !hasOpenTurn())
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
        try { hooks.onDelivered?.() } catch {}
        queueCheck(wakePollMs)
      } else cancelWake()
    }
    queueCheck(wakeDelayMs)
    wakeTimers.add(cancelWake)
  }

  function scheduleParentFollowupWake(owner, wakeJobId, hooks) {
    return scheduleCompletionWake(owner, wakeJobId, hooks || {})
  }
  // 兼容插件内既有调用名；新调用应显式传入 jobId。
  const scheduleOwnerWake = (owner, wakeJobId) => scheduleParentFollowupWake(owner, wakeJobId)

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
    // Detach synchronously before cancelling any job or other resource. A dispose
    // may run between asynchronous wait_run slices; the manifest must be durable
    // before the old generation can disappear.
    disposed = true
    for (const detach of [...pendingPipelines]) {
      try { detach() } catch (err) { emitWarn(`[relay-dispatch] dispose 清单落盘失败：${String(err?.message || err)}`) }
    }
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
    for (const timer of resumerTimers) clearTimeout(timer)
    resumerTimers.clear()
    for (const cancel of [...activePipelines.values()]) {
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
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      if (agents && typeof agents.create === 'function') {
        let createState = agents[SUBAGENT_CREATE_SYM]
        if (!createState || typeof createState.orig !== 'function') {
          createState = { orig: agents.create, generation: 0 }
          agents[SUBAGENT_CREATE_SYM] = createState
        } else {
          agents.create = createState.orig
        }
        const myCreateGen = ++createState.generation
        const origCreate = createState.orig
        agents.create = function (options) {
          const opts = options && typeof options === 'object' ? options : {}
          if (!opts[SUBAGENT_CREATE_SYM]) {
            const previous = opts.setup
            opts.setup = (agentCtx) => {
              armSubagentRequestGuard(agentCtx, opts.sessionId)
              return typeof previous === 'function' ? previous(agentCtx) : undefined
            }
            opts[SUBAGENT_CREATE_SYM] = true
          }
          if (!opts.__subagentCtx) opts.__subagentCtx = { rpGuardianActive: detectRpGuardian(ctx) }
          const fail = (err, asyncFailure) => {
            if (asyncFailure) return Promise.reject(err)
            throw err
          }
          const routeCtx = () => ({
            ...(opts.__subagentCtx || {}),
            now: typeof config.now === 'function' ? config.now() : Date.now(),
            slot,
            rpGuardianActive: detectRpGuardian(ctx) || opts.__subagentCtx?.rpGuardianActive === true,
          })
          const recover = (err, asyncFailure) => {
            const info = routeCtx()
            if (opts.__subagentRetried) {
              const spent = noteSubagentStartFailure(opts.sessionId, err, info.now, info)
              if (spent.fused && opts.__subagentPinned) markSubagentCandidateUnhealthy(opts.__subagentPinned, info.now)
              return fail(err, asyncFailure)
            }
            if (!readSubagentFreeAudit(opts.sessionId)) evaluateSubagentPrepare(opts.sessionId, opts, info)
            const decision = noteSubagentStartFailure(opts.sessionId, err, info.now, info)
            if (!decision.retry) return fail(err, asyncFailure)
            opts.__subagentRetried = true
            opts.__subagentPinned = decision.candidate
            writeCandidate(opts, decision.candidate)
            writeCandidate(opts.agentOptions, decision.candidate)
            pushSubagentCreate(opts)
            try {
              const retry = origCreate.call(this, opts)
              if (retry && typeof retry.then === 'function') {
                return Promise.resolve(retry).then((value) => value, (err2) => recover(err2, true))
              }
              return retry
            } catch (err2) {
              if (/already exists/i.test(String(err2?.message || err2))) return fail(err, asyncFailure)
              return recover(err2, asyncFailure)
            } finally {
              popSubagentCreate()
            }
          }
          pushSubagentCreate(opts)
          try {
            const result = origCreate.call(this, opts)
            if (result && typeof result.then === 'function') return Promise.resolve(result).then((value) => value, (err) => recover(err, true))
            return result
          } catch (err) {
            return recover(err, false)
          } finally {
            popSubagentCreate()
          }
        }
        ctx.effect(() => () => {
          if (agents[SUBAGENT_CREATE_SYM] && agents[SUBAGENT_CREATE_SYM].generation === myCreateGen) agents.create = origCreate
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
          let prepared
          let subVerdict = null
          try {
            const s = slot
            const stack = new Error().stack || ''
            const inDispatchContext = Boolean(s && dispatchAls.getStore() === s)
            const reqKind = httpAls.getStore()
            const frame = peekSubagentCreate()
            const owned = frame && frame.sessionId === id ? frame : null
            const savedCtx = (opts && opts.__subagentCtx) || (owned && owned.__subagentCtx) || {}
            const ctxInfo = {
              inDispatchContext,
              reqKind,
              stack,
              slot: s,
              now: typeof config.now === 'function' ? config.now() : Date.now(),
              rpGuardianActive: detectRpGuardian(ctx) || savedCtx.rpGuardianActive === true,
              pinnedCandidate: (opts && opts.__subagentPinned) || (owned && owned.__subagentPinned) || undefined,
              kimiBridgeUp: savedCtx.kimiBridgeUp,
            }
            subVerdict = evaluateSubagentPrepare(id, opts, ctxInfo)
            if (subVerdict.action === 'rewrite') {
              applySubagentRoute(opts, subVerdict, (owned && owned.agentOptions) || (opts && opts.agentOptions))
              const parent = subVerdict.parentSession
              const cwd = (opts && opts.meta && opts.meta.cwd) || (s && s.cwd)
              void attachChildToWorkspace(ctx, id, parent, cwd)
              const prompt = (opts && (opts.prompt || opts.task)) || (opts && opts.meta && (opts.meta.prompt || opts.meta.title)) || ''
              if (prompt) scheduleTitle(id, prompt, '')
              logParent(
                `subagent-free gen=${myGen} id=${id || '?'} action=rewrite provider=${opts && opts.provider} model=${opts && opts.model} ` +
                `reasoningEffort=${(opts && opts.reasoningEffort) || '-'} origin=subagent-free parentSession=${parent || 'none'} reason=${subVerdict.reason}`
              )
            } else if (subVerdict.action === 'fail-open') {
              logParent(`subagent-free gen=${myGen} id=${id || '?'} action=fail-open reason=all-unhealthy parentInherited=1 origin=parent parentSession=${subVerdict.parentSession || 'none'}`)
            }
            const runRelay = !subVerdict || subVerdict.reason === 'not-subagent' || (subVerdict.reason === 'relay-slot' && subVerdict.depth < 1)
            if (runRelay) {
              const verdict = evaluateRelayPrepare(id, opts, s, ctxInfo)
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
                void attachChildToWorkspace(ctx, id, s.parent, cleanMeta.cwd || s.cwd)
              }
              logParent(
                `prepare gen=${myGen} id=${id || '?'} slot=${verdict.slotStatus} cwdMatch=${verdict.cwdMatch} ` +
                `result=${verdict.ok ? 'inject' : 'reject'} reason=${verdict.reason} parentSession=${injectedParent}`
              )
            }
          } catch (err) {
            logParent(`prepare gen=${myGen} id=${id || '?'} slot=error cwdMatch=false result=reject reason=error:${(err && err.message) || err} parentSession=none`)
          }
          try {
            prepared = orig.call(this, id, opts)
          } catch (err) {
            if (opts && opts.meta && opts.meta.origin === 'subagent-free' && /origin must be/.test(String(err && err.message || err))) {
              opts.meta.origin = 'subagent'
              opts.meta.freeOrigin = 'subagent-free'
              prepared = orig.call(this, id, opts)
            } else {
              throw err
            }
          }
          // Session.prepare currently persists only a fixed header subset and freezes
          // prepared.header via Object.freeze(). Attach the immutable manifest onto a
          // WeakMap / symbol or extensible target without mutating a frozen header object.
          if (slot?.used && slot.sessionId === id && slot.capabilityManifest) {
            const manifest = slot.capabilityManifest
            const attachManifest = (obj) => {
              if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return
              try {
                if (Object.isExtensible(obj)) {
                  obj.capabilityManifest = manifest
                  obj.capability_manifest = manifest
                }
              } catch {}
            }
            attachManifest(prepared)
            attachManifest(prepared?.session)
            attachManifest(prepared?.header)
            attachManifest(prepared?.session?.header)
            try {
              const mapKey = Symbol.for('@dsh-external/capability-manifests')
              if (!globalThis[mapKey]) globalThis[mapKey] = new Map()
              globalThis[mapKey].set(id, manifest)
              if (prepared?.header && typeof prepared.header === 'object') {
                globalThis[mapKey].set(prepared.header, manifest)
              }
            } catch {}
          }
          return prepared
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
            const titleEvents = sessionEvents(session)
            if (!titleEvents.some((e) => e && e.type === 'user/message')) continue
            if (!titleEvents.some((e) => e && e.type === 'request/header')) continue
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
  function startLinked(toolName, args, exec, rawTask, prefix, capabilityReadScope, execProfiles = []) {
    if (disposed) return Promise.reject(new Error('relay_dispatch plugin disposed'))
    const parent = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.id
    const canLink = Boolean(parent && args && args.workspace && !args.sessionId && config.linkParentSession !== false)
    const isResume = Boolean(args.sessionId)
    const timeoutMs = config.startTimeoutMs ?? 120000
    const windowMs = config.slotWindowMs ?? timeoutMs
    const hasExternalWrite = toolName !== TOOL_START_REVIEW && args.permissionPreset !== 'danger-full-access' && Array.isArray(args.writeScope) && args.writeScope.some((p) => !isPathInsideWorkspace(args.workspace, p))
    const hasExternalRead = toolName !== TOOL_START_REVIEW && args.permissionPreset !== 'danger-full-access' && Array.isArray(args.contextReadScope) && args.contextReadScope.some((p) => !isPathInsideWorkspace(args.workspace, p))
    const capabilityManifest = compileCapabilityManifest(hasExternalWrite ? { ...args, permissionPreset: 'danger-full-access' } : args, {
      parentSession: parent || null,
      review: toolName === TOOL_START_REVIEW,
      readScope: capabilityReadScope,
      execProfiles,
      now: typeof config.now === 'function' ? config.now() : Date.now(),
      ttlMs: (config.capabilityTtlMinutes ?? config.maxWaitMinutes) * 60000,
    })
    // Do NOT pass capabilityManifest in start_run / start_review MCP arguments because
    // MCP tool schema sets additionalProperties: false. The in-process sessions.prepare
    // wrapper + Symbol.for('@dsh-external/capability-manifests') is the authoritative path.
    const cleanArgs = { ...args }
    if (!isResume && Array.isArray(cleanArgs.writeScope)) {
      cleanArgs.writeScope = cleanArgs.writeScope.filter((p) => isPathInsideWorkspace(args.workspace, p))
      if (!cleanArgs.writeScope.length) cleanArgs.writeScope = [args.workspace]
    }
    if (!isResume && Array.isArray(cleanArgs.contextReadScope)) {
      cleanArgs.contextReadScope = cleanArgs.contextReadScope.filter((p) => isPathInsideWorkspace(args.workspace, p))
      if (!cleanArgs.contextReadScope.length) cleanArgs.contextReadScope = [args.workspace]
    }
    delete cleanArgs.capabilityManifest
    if (hasExternalWrite || hasExternalRead) {
      cleanArgs.permissionPreset = 'danger-full-access'
      cleanArgs.confirmedDangerousPermission = true
    }
    if (args.sessionId) {
      cleanArgs.permissionPreset = args.permissionPreset
      cleanArgs.confirmedDangerousPermission = args.confirmedDangerousPermission
    }
    // 最后一道闸：read-only / start_review 绝不把 writeScope 送给 start_run。
    if (toolName === TOOL_START_REVIEW || cleanArgs.permissionPreset === 'read-only') delete cleanArgs.writeScope
    args = cleanArgs

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
            capabilityManifest,
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
          await attachChildToWorkspace(ctx, my.sessionId, my.parent, my.cwd)
          if (retSid && retSid !== my.sessionId) await attachChildToWorkspace(ctx, retSid, my.parent, my.cwd)
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

  async function runPluginReloads(plugins, agent, hasFailures, { beforeReload, afterReload, beforeSelfReload } = {}) {
    const names = normalizeReloadPlugins(plugins)
    if (!names.length) return ''
    if (disposed) return `reload_pending: ${names.join(', ')}`
    if (hasFailures || activePipelines.size > 1) return `reload_pending: ${names.join(', ')}`
    const results = []
    const ordered = [...names.filter((p) => p !== 'dsh-relay-dispatch'), ...names.filter((p) => p === 'dsh-relay-dispatch')]
    for (const pkg of ordered) {
      if (pkg === 'dsh-relay-dispatch' && beforeSelfReload) await beforeSelfReload()
      if (beforeReload) await beforeReload(pkg)
      try {
        const result = await tools.execute({ callId: `relay-dispatch-reload-${Date.now()}-${++seq}`, name: 'dev_reload_package', arguments: { packageName: pkg, package: pkg, name: pkg }, ...(agent ? { agent } : {}), signal: new AbortController().signal })
        const parsed = parseResult(result)
        if (parsed?.ok === false || parsed?.success === false) throw new Error(parsed.error || 'reload rejected')
        results.push(`${pkg}(ok)`)
        try { reloadPluginByName(ctx, pkg) } catch {}
        if (afterReload) await afterReload(pkg, true)
      } catch (err) {
        results.push(`${pkg}(failed:${clip(String(err?.message || err), 80)})`)
        if (afterReload) await afterReload(pkg, false)
      }
    }
    return `reloaded: ${results.join(', ')}`
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

  async function startPipelineV2(args, exec, jobs, restored = null) {
    if (disposed) throw new Error('relay_dispatch plugin disposed')
    const agent = exec && exec.agent
    const sessionId = agent?.session?.header?.id || null
    const faultPath = join(config.manifestDir || join(homedir(), '.dsh', 'relay-pipelines'), '.dispatcher-fault.json')
    const statsPath = join(config.manifestDir || join(homedir(), '.dsh', 'relay-pipelines'), '.guard-stats.json')
    const bumpStat = (name) => {
      if (config.writeManifest === false) return
      try { mkdirSync(dirname(statsPath), { recursive: true }); const data = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, 'utf8')) : {}; data[name] = (data[name] || 0) + 1; writeFileSync(statsPath, JSON.stringify(data, null, 2)) } catch (err) { emitWarn(`[relay-dispatch] guard stats 写入失败：${String(err?.message || err)}`) }
    }
    const clearFault = () => {
      if (config.writeManifest === false || !sessionId) return
      try { const old = existsSync(faultPath) ? JSON.parse(readFileSync(faultPath, 'utf8')) : {}; writeFileSync(faultPath, JSON.stringify({ sessionId, count: 0, lastCode: null, lastAt: new Date().toISOString(), previousCount: old.sessionId === sessionId ? old.count || 0 : 0 })) } catch (err) { emitWarn(`[relay-dispatch] dispatcher fault 清零失败：${String(err?.message || err)}`) }
    }
    const recordFault = (err) => {
      const code = String(err?.code || err?.message || 'dispatcher_fault').split(':')[0].slice(0, 100)
      bumpStat(`dispatch.preflight_reject.${code}`)
      if (config.writeManifest === false || !sessionId || err?.startUnknown || err?.kind === 'parameter' || /^DSH_E_(?:GATE|FOLLOWUP|SCOPE|PREFLIGHT)/.test(code) || /互斥|写范围冲突|非空数组|缺少 startArgs|未知 mode/.test(err?.message || '')) return
      try { mkdirSync(dirname(faultPath), { recursive: true }); const old = existsSync(faultPath) ? JSON.parse(readFileSync(faultPath, 'utf8')) : {}; const count = old.sessionId === sessionId ? (old.count || 0) + 1 : 1; writeFileSync(faultPath, JSON.stringify({ sessionId, count, lastCode: code, lastAt: new Date().toISOString() })) } catch (writeErr) { emitWarn(`[relay-dispatch] dispatcher fault 写入失败：${String(writeErr?.message || writeErr)}`) }
    }
    const { modes, warning, aliases, roots, hosts = {}, mechCommands = ['npm test', 'npm --prefix', 'node --test', 'node test/unit.mjs'], targets } = loadModes(config.modesPath || MODES_PATH)
    // 恢复时使用清单中的原始计划；新流水线仍在注册 Job 前同步预检。
    let plan
    let expansionNotes = []
    try {
      const expanded = restored ? args : expandTargets(args, { targets })
      expansionNotes = expanded.targetWriteScope?.length ? ['targets 展开含工作区外 writeScope；权限按既有规则升级'] : []
      plan = restored ? { ...restored.plan, gate: restored.plan.gate ? { ...restored.plan.gate, commands: Array.isArray(restored.plan.gate.commands) ? restored.plan.gate.commands : [], checks: Array.isArray(restored.plan.gate.checks) ? restored.plan.gate.checks : [] } : restored.plan.gate, tasks: restored.plan.tasks.map((t) => ({ ...t, dependsOn: new Set(Array.isArray(t.dependsOn) ? t.dependsOn : []) })) } : preflightDispatchV2(expanded, { ...config, currentSessionId: agent?.session?.header?.id }, { modes, aliases: aliases || {}, roots: roots || {}, hosts, mechCommands, targets })
    } catch (err) { recordFault(err); throw err }
    if (plan.followUp) bumpStat('dispatch.followup.started')
    if (plan.tasks.some((t) => t.inferredScope?.readRoots?.length)) bumpStat('dispatch.scope_inferred')
    const notes = restored ? (restored.notes || []) : [...(warning ? [warning] : []), ...expansionNotes]
    const pipelineId = restored ? restored.pipelineId : plan.followUp ? `${plan.followUpOf}-f${(plan.previous.followUps || []).length + 1}` : `p-${Date.now().toString(36)}-${++seq}`
    const manifestPath = join(pipelineManifestDir(), `${pipelineId}.json`)
    const parentSessionId = restored ? (restored.parentSessionId || null) : ((agent && agent.session && agent.session.header && agent.session.header.id) || null)
    const createdAt = restored ? restored.createdAt : new Date().toISOString()
    const preservedOriginalJobId = restored ? (restored.originalJobId || restored.jobId || null) : null
    let capabilityIds = null
    try { capabilityIds = await getCapabilityIdsV2(exec) } catch (e) { notes.push(`list_capabilities 失败，未过滤候选：${(e && e.message) || e}`) }
    const restoredItems = new Map((restored?.items || []).filter((item) => item.kind !== 'gate').map((item) => [item.index, item]))
    const restoredGate = (restored?.items || []).find((item) => item.kind === 'gate')
    const items = plan.tasks.map((t) => {
      const previous = restoredItems.get(t.index)
      return {
        index: t.index, kind: 'task', label: t.label, status: plan.followUp && t.index !== plan.followUpTarget ? 'succeeded' : (previous?.status || 'pending'),
        workspace: t.workspace, writable: t.writable, dependsOn: [...t.dependsOn],
        runId: previous?.runId, sessionId: previous?.sessionId, webUrl: previous?.webUrl, model: previous?.model,
        output: previous?.output || '', error: previous?.error, startUnknown: previous?.startUnknown || false, verdict: previous?.verdict, selfReview: previous?.selfReview || 0, reloadPending: previous?.reloadPending || false,
        midRunRetries: previous?.midRunRetries || 0, beforeGit: previous?.beforeGit,
        notes: previous?.notes || [], git: previous?.git,
      }
    })
    let jobId
    let finalRead = null
    let pipelinePhase = ['completed', 'cancelled', 'superseded'].includes(restored?.phase) ? restored.phase : 'running'
    let finishedAt = restored?.finishedAt
    let reloadedPlugins = [...(restored?.reloadedPlugins || [])]
    let parentWakeDelivered = restored?.parentWakeDelivered === true
    let parentWakeArmed = false
    let pipelineResultHeader = V2_MACHINE_HEADER
    let cancelPipeline = () => {}
    const disposeCancel = (reason) => cancelPipeline(reason)
    const manifest = () => ({
      machineHeader: pipelineResultHeader,
      phase: pipelinePhase,
      finishedAt,
      reloadedPlugins: reloadedPlugins.length ? reloadedPlugins : undefined,
      pipelineId,
      jobId,
      originalJobId: preservedOriginalJobId || jobId,
      parentWakeDelivered,
      parentSessionId,
      createdAt,
      plan: { ...plan, tasks: plan.tasks.map((t) => ({ ...t, dependsOn: [...(t.dependsOn || [])] })) },
      updatedAt: new Date().toISOString(),
      onWriteConflict: plan.onWriteConflict,
      parentPipelineId: plan.followUpOf,
      scopeNotes: plan.tasks.flatMap((t) => t.inferredScope?.notes || []),
      gateUserAsk: plan.gate ? plan.gate.userAsk : undefined,
      fixRound: items.find((i) => i.fixRound)?.fixRound || 0,
      notes,
      items: items.map((i) => ({
        index: i.index, kind: i.kind, label: i.label, status: i.status,
        runId: i.runId, sessionId: i.sessionId, webUrl: i.webUrl, model: i.model,
        startUnknown: i.startUnknown || undefined, error: i.error, output: i.output,
        verdict: i.verdict, selfReview: i.selfReview || undefined, gateKind: i.gateKind, mechanical: i.mechanical,
        reloadPending: i.reloadPending || undefined,
        midRunRetries: i.midRunRetries || 0, beforeGit: i.beforeGit, fixRound: i.fixRound || 0,
        dependsOn: i.dependsOn, git: i.git,
      })),
    })
    const writeManifest = () => {
      if (config.writeManifest === false) return
      try {
        mkdirSync(dirname(manifestPath), { recursive: true })
        const body = manifest()
        if (body.parentWakeDelivered !== true && existsSync(manifestPath)) {
          try {
            const prev = JSON.parse(readFileSync(manifestPath, 'utf8'))
            if (prev?.pipelineId === pipelineId && prev.parentWakeDelivered === true) {
              body.parentWakeDelivered = true
              parentWakeDelivered = true
            }
          } catch {}
        }
        const tmp = `${manifestPath}.tmp`
        writeFileSync(tmp, JSON.stringify(body, null, 2))
        renameSync(tmp, manifestPath)
      } catch {}
    }
    const detachPipeline = () => {
      if (!['completed', 'cancelled', 'superseded', 'detached'].includes(pipelinePhase)) {
        pipelinePhase = 'detached'
        writeManifest()
      }
    }
    // Register before the first asynchronous capability/start call, not only once
    // jobs.start begins. This closes the startup window of the reload lifecycle.
    pendingPipelines.add(detachPipeline)
    if (disposed) {
      pendingPipelines.delete(detachPipeline)
      detachPipeline()
      throw new Error('relay_dispatch plugin disposed')
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
      if (item.runId) {
        try {
          const { snap, cancelled: runCancelled } = await waitRunV2(item, { runId: item.runId }, abort)
          if (disposed || isDisposeCancelReason(abort.signal.reason)) return
          item.output = runCancelled ? buildCancelConclusion(snap, 'cancelled') : fullConclusion(snap)
          const blocked = !runCancelled && isUpstreamBlockedOutput(item.output)
          item.status = runCancelled || snap?.status === 'cancelled' ? 'cancelled' : (snap?.status === 'succeeded' && !blocked ? 'succeeded' : 'failed')
          if (blocked) item.error = clip(item.output, 300)
        } catch (err) {
          if (disposed || isDisposeCancelReason(abort.signal.reason)) return
          item.status = abort.signal.aborted ? 'cancelled' : 'failed'
          item.error = String((err && err.message) || err)
          item.output ||= item.error
        } finally { writeManifest() }
        return
      }
      const before = item.beforeGit || (item.writable ? await captureGitTree(t.workspace) : { available: false })
      item.beforeGit = before
      const attempts = Array.isArray(t.candidates) && t.candidates.length ? filterCandidatesV2(t.candidates, capabilityIds, item.notes) : [null]
      let attemptIndex = Math.min(item.midRunRetries || 0, Math.max(0, attempts.length - 1))
      while (!abort.signal.aborted && !disposed) {
        let beforeFailure = null
        try {
          const startTool = t.review ? TOOL_START_REVIEW : TOOL_START_RUN
          const c = attempts[attemptIndex]
          const sa = c ? { ...t.baseArgs, provider: c.provider, model: c.model } : t.baseArgs
          let started
          try {
            started = await startLinked(startTool, fillStartArgs(sa, config, t.review), { ...(exec || {}), signal: abort.signal }, t.rawTask, t.modePrefix, t.baseArgs.contextReadScope, t.inferredScope?.hosts.map((h) => `ssh:${h}`))
          } catch (err) {
            if (t.writable && isUnknownStartError(err)) {
              item.startUnknown = true
              item.notes.push('start_unknown：写任务启动结果不可知，为防止双写不再换模型重试')
            }
            throw err
          }
          const runId = started && (started.runId || (started.run && started.run.runId))
          if (!runId) throw new Error(`start 未返回 runId：${clip(started, 600)}`)
          // Persist the handle before observing abort/dispose so reload can always adopt it.
          item.runId = runId
          item.sessionId = started.sessionId || (started.run && started.run.sessionId)
          item.webUrl = started.webUrl
          item.model = c ? `${c.provider}/${c.model}` : `${sa.provider || config.defaultProvider}/${sa.model || config.defaultModel}`
          writeManifest()
          if (abort.signal.aborted) {
            if (!disposed && !isDisposeCancelReason(abort.signal.reason)) await call(TOOL_CANCEL, { runId }, agent, new AbortController().signal).catch(() => {})
            return
          }
          const { snap, cancelled: runCancelled } = await waitRunV2(item, started, abort)
          if (disposed || isDisposeCancelReason(abort.signal.reason)) return
          item.output = runCancelled ? buildCancelConclusion(snap, 'cancelled') : fullConclusion(snap)
          const blocked = !runCancelled && isUpstreamBlockedOutput(item.output)
          item.status = runCancelled || snap?.status === 'cancelled' ? 'cancelled' : (snap?.status === 'succeeded' && !blocked ? 'succeeded' : 'failed')
          if (blocked) item.error = clip(item.output, 300)
          if (item.status === 'failed') beforeFailure = item.output
        } catch (err) {
          if (disposed || isDisposeCancelReason(abort.signal.reason)) return
          item.status = abort.signal.aborted ? 'cancelled' : 'failed'
          item.error = String((err && err.message) || err)
          if (item.startUnknown) item.error = `start_unknown: ${item.error}`
          item.output ||= item.error
          beforeFailure = item.output
        }
        if (item.writable) {
          const after = await captureGitTree(t.workspace)
          const diff = await diffGitTrees(t.workspace, before, after)
          item.git = { available: diff.available, changed: diff.changed, files: diff.files, nameStatus: diff.nameStatus, numstat: diff.numstat, statText: diff.statText, beforeTree: diff.beforeTree, afterTree: diff.afterTree }
        }
        if (item.status === 'succeeded' && t.handoffOut?.length) {
          for (const name of t.handoffOut) {
            const verdict = verifyHandoffContract(plan.handoff[name])
            if (!verdict.ok) { item.status = 'failed'; item.error = verdict.detail; item.output += `\n${verdict.detail}`; break }
          }
        }
        const cleanWritable = !item.writable || (item.git?.available && !item.git.changed)
        if (item.status === 'failed' && !item.startUnknown && cleanWritable && (item.midRunRetries || 0) < 1 && attemptIndex + 1 < attempts.length) {
          item.midRunRetries = (item.midRunRetries || 0) + 1
          attemptIndex++
          item.notes.push(`mid_run_failover=1：${beforeFailure ? clip(beforeFailure, 160) : 'failed'}；切换 ${attempts[attemptIndex].provider}/${attempts[attemptIndex].model}`)
          item.runId = undefined; item.sessionId = undefined; item.error = undefined
          writeManifest()
          continue
        }
        if (item.status === 'failed' && item.writable && item.git && (!item.git.available || item.git.changed)) item.notes.push('mid_run_failover=0：写任务非零改动或 Git 快照不可用，禁止自动重试')
        writeManifest()
        return
      }
      if (!disposed && abort.signal.aborted) { item.status = 'cancelled'; writeManifest() }
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
          // 先落 detached 清单，再让本地 job 以 reported 结算。若流水线已进入终态则不得回退为 detached。
          if (detachOnly) {
            if (!['completed', 'cancelled', 'detached'].includes(pipelinePhase)) {
              pipelinePhase = 'detached'
              writeManifest()
            }
            if (jobId) quietDisposedJob(jobs, jobId, agent)
          }
          try { abort.abort(reason || 'cancelled') } catch {}
          // DSH 关闭/插件热重载只分离本地等待，远端 run 必须继续存活；仅用户显式取消才 cancel_run。
          if (!detachOnly) {
            for (const item of items) {
              if (item.status === 'running' && item.runId) {
                call(TOOL_CANCEL, { runId: item.runId }, agent, new AbortController().signal).catch(() => {})
              }
            }
            writeManifest()
          }
        }
        activePipelines.set(pipelineId, disposeCancel)
        pendingPipelines.delete(detachPipeline)
        const snapshotText = () => {
          const lines = [V2_MACHINE_HEADER, `pipeline_id: ${pipelineId}`, 'state: running']
          for (const item of items) {
            lines.push(`#${item.index} ${item.label}: ${item.status}${item.runId ? ` runId=${item.runId}` : ''}${item.model ? ` model=${item.model}` : ''}`)
          }
          return lines.join('\n')
        }
        const armParentWake = () => {
          if (parentWakeArmed || cancelled || disposed) return
          parentWakeArmed = true
          scheduleParentFollowupWake(agent, preservedOriginalJobId || jobId, {
            onDelivered() {
              parentWakeDelivered = true
              writeManifest()
            },
          })
        }
        const finish = (r) => {
          activePipelines.delete(pipelineId)
          if (pipelinePhase === 'detached' || (disposed && pipelinePhase !== 'completed' && pipelinePhase !== 'failed')) return { ...r, status: 'killed' }
          if (disposed) {
            if ((pipelinePhase === 'completed' || pipelinePhase === 'failed') && parentWakeDelivered !== true) {
              parentWakeDelivered = false
              if (!finishedAt) finishedAt = Date.now()
              writeManifest()
            }
            return { ...r, status: 'killed' }
          }
          if (r?.status === 'failed') pipelinePhase = 'failed'
          else if (pipelinePhase !== 'failed' && pipelinePhase !== 'cancelled') pipelinePhase = 'completed'
          if (!finishedAt) finishedAt = Date.now()
          if ((pipelinePhase === 'completed' || pipelinePhase === 'failed') && parentWakeDelivered !== true) parentWakeDelivered = false
          finalRead = `${pipelineResultHeader}\n${r.output || ''}\n${modelNote()}`
          writeManifest()
          if (!cancelled) armParentWake()
          return r
        }
        const done = (async () => {
          const running = new Map()
          const maxConc = Math.max(1, config.maxConcurrentTasks ?? DEFAULTS.maxConcurrentTasks)
          const launch = (t) => {
            const item = items[t.index]
            const upstream = [...t.dependsOn].map((d) => items[d]).filter((i) => i?.git?.files?.length)
            const launchTask = upstream.length ? { ...t, baseArgs: { ...t.baseArgs, task: `${t.baseArgs.task}\n上游实际变更：${upstream.flatMap((i) => i.git.files).join(', ')}` } } : t
            const p = runOne(launchTask, item, abort).finally(() => { running.delete(t.index) })
            running.set(t.index, p)
          }
          while (!abort.signal.aborted && !disposed) {
            let changed = false
            for (const t of plan.tasks) {
              const item = items[t.index]
              if (item.status !== 'pending' && !(item.status === 'running' && item.runId && !running.has(t.index))) continue
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
          // dispose 后 runOne 保留 running/runId；此处不得取消 pending 或创建假 gate 结果。
          if (disposed || pipelinePhase === 'detached' || isDisposeCancelReason(abort.signal.reason)) {
            if (disposed || isDisposeCancelReason(abort.signal.reason)) pipelinePhase = 'detached'
            writeManifest()
            return { status: 'killed', output: `pipeline ${pipelineId} detached` }
          }
          for (const item of items) {
            if (item.status === 'pending') { item.status = 'cancelled'; item.output = '已取消' }
          }

          let gateSelfReview = false
          let fixRound = restored?.fixRound || 0
          if (plan.gate) {
            const gateItem = restoredGate ? {
              ...restoredGate, notes: [...(restoredGate.notes || [])],
              index: items.length, kind: 'gate', label: 'gate',
              workspace: plan.tasks[0] && plan.tasks[0].workspace, writable: false, dependsOn: [],
              selfReview: restoredGate.selfReview || 0,
            } : {
              index: items.length, kind: 'gate', label: 'gate', status: 'pending',
              workspace: plan.tasks[0] && plan.tasks[0].workspace, writable: false, dependsOn: [],
              output: '', error: undefined, startUnknown: false, notes: [], git: undefined,
              verdict: 'unknown', selfReview: 0,
            }
            gateSelfReview = gateItem.selfReview === 1
            items.push(gateItem)
            if (disposed || pipelinePhase === 'detached' || isDisposeCancelReason(abort.signal.reason)) {
              if (disposed || isDisposeCancelReason(abort.signal.reason)) pipelinePhase = 'detached'
              writeManifest()
              return { status: 'killed', output: `pipeline ${pipelineId} detached` }
            }
            const succeeded = plan.tasks.filter((t) => items[t.index].status === 'succeeded')
            const partial = succeeded.length < plan.tasks.length
            if (restoredGate?.status === 'succeeded' && ['pass', 'fail', 'partial'].includes(restoredGate.verdict)) {
              gateItem.notes.push('热重载恢复：复用已完成的 Gate 结果，未重新发起子会话')
            } else if (restoredGate?.runId) {
              try {
                const { snap, cancelled: gateCancelled } = await waitRunV2(gateItem, { runId: gateItem.runId }, abort)
                gateItem.output = gateCancelled ? buildCancelConclusion(snap, 'gate cancelled') : fullConclusion(snap)
                gateItem.status = gateCancelled ? 'cancelled' : (snap?.status === 'succeeded' ? 'succeeded' : 'failed')
                gateItem.verdict = parseGateVerdict(gateItem.output)
                gateItem.notes.push('热重载恢复：复用原 Gate runId，未重新发起子会话')
              } catch (err) {
                gateItem.status = 'failed'; gateItem.error = String((err && err.message) || err); gateItem.output ||= gateItem.error
              }
            } else if (!succeeded.length) {
              gateItem.status = 'skipped'; gateItem.output = '没有成功的子任务，gate 跳过'
            } else if (partial && plan.gate.onPartial === 'skip') {
              gateItem.status = 'skipped'; gateItem.output = '部分子任务未成功，onPartial=skip，gate 跳过'
            } else if (abort.signal.aborted || disposed) {
              gateItem.status = 'cancelled'; gateItem.output = '已取消'
            } else {
              const usedModels = new Set(succeeded.map((t) => items[t.index].model).filter(Boolean))
              const usedVendors = new Set([...usedModels].map((id) => {
                const slash = id.indexOf('/')
                return vendorOf(slash >= 0 ? id.slice(0, slash) : '', slash >= 0 ? id.slice(slash + 1) : id)
              }))
              const verifyCfg = (modes && modes.verify) || BUILTIN_MODES.verify
              const runGate = async () => {
                const evidence = succeeded.map((t) => {
                  const it = items[t.index]
                  const git = it.git && it.git.available ? it.git : null
                  return `## ${it.label} (${it.model || '?'})\n${conclusion({ assistantText: it.output }, 1500)}\n变更文件：${(git && git.files && git.files.join(', ')) || '(无快照证据)'}\nnumstat:\n${(git && git.numstat) || '(无)'}\nstatText:\n${(git && git.statText) || '(无)'}`
                }).join('\n\n')
                const gateTaskText = [plan.gate.criteria, `用户原始需求：${plan.gate.userAsk}`, '输出要求：第一行必须且只能是 `verdict: pass`、`verdict: fail` 或 `verdict: partial` 之一；随后再列证据。会话自身成功不代表验收通过，必须依据标准与真实 Git 证据作判断。', plan.gate.commands.length ? `请执行以下验证命令并报告结果：\n${plan.gate.commands.map((c) => `- ${c}`).join('\n')}` : '', evidence].filter(Boolean).join('\n\n')
                const applied = applyMode(verifyCfg, { workspace: succeeded[0].workspace, task: gateTaskText, maxTurns: 6 }, aliases || {})
                const originalGateCandidates = filterCandidatesV2(applied.candidates, capabilityIds, [])
                let gateCandidates = applied.candidates.filter((c) => !usedModels.has(`${c.provider}/${c.model}`) && !usedVendors.has(vendorOf(c.provider, c.model)))
                gateCandidates = filterCandidatesV2(gateCandidates, capabilityIds, gateItem.notes)
                if (!gateCandidates.length) {
                  gateSelfReview = true; gateItem.selfReview = 1; gateCandidates = originalGateCandidates
                  gateItem.notes.push('self_review=1：无异构厂商候选，已回退原 gate 候选链实际执行守门员；主会话仍须复核')
                }
                const gt = { index: gateItem.index, label: 'gate', mode: 'verify', review: false, rawTask: gateTaskText, modePrefix: '', baseArgs: applied.args, candidates: gateCandidates, workspace: succeeded[0].workspace, writable: false }
                await runOne(gt, gateItem, abort)
                gateItem.verdict = parseGateVerdict(gateItem.output)
                if (gateItem.verdict === 'unknown') gateItem.notes.push('守门员输出未包含可解析 verdict，验收状态记为 unknown')
                writeManifest()
              }
              let gateKind = ''
              const runGateAll = async () => {
                gateItem.runId = undefined; gateItem.sessionId = undefined
                let syncResult = { pass: true, copied: 0, mismatches: [] }
                if (plan.syncTargets?.length) syncResult = syncTargetsNow(plan.syncTargets, pipelineId)
                const parallelFailures = Object.values(plan.handoff || {}).flatMap((contract) => (contract.consumers || []).filter((c) => c.parallel).map(() => verifyHandoffContract(contract))).filter((x) => !x.ok)
                const checks = [...(plan.gate.checks || []), ...(syncResult.mismatches.length ? [{ exists: syncResult.mismatches.map((x) => x.target) }] : [])]
                const mech = await runMechanicalChecks(checks, { workspace: succeeded[0].workspace, items, mechCommands: plan.mechCommands || mechCommands })
                if (!syncResult.pass) mech.results.push({ kind: 'syncTargets', ok: false, detail: `${syncResult.mismatches.length} 个目标 SHA256 不一致` })
                else if (plan.syncTargets?.length) mech.results.push({ kind: 'syncTargets', ok: true, detail: `${syncResult.copied} 个文件 SHA256 一致` })
                for (const failure of parallelFailures) mech.results.push({ kind: 'handoff', ok: false, detail: failure.detail })
                mech.pass = mech.results.every((r) => r.ok)
                gateItem.mechanical = mech
                if (!mech.pass) {
                  gateKind = 'mech'; gateItem.gateKind = gateKind; gateItem.status = 'succeeded'; gateItem.verdict = 'fail'
                  gateItem.output = `verdict: fail\n机械门失败：\n${mech.results.filter((r) => !r.ok).map((r) => `${r.kind}: ${r.detail}`).join('\n')}`
                } else if (!plan.gate.criteria.trim() || plan.gate.llm === 'never') {
                  gateKind = 'mech'; gateItem.gateKind = gateKind; gateItem.status = 'succeeded'; gateItem.verdict = 'pass'
                  gateItem.output = `verdict: pass\n机械门通过：${mech.results.map((r) => r.kind).join(', ') || 'none'}`
                } else {
                  await runGate()
                  gateKind = `${plan.gate.checks?.length || plan.syncTargets?.length ? 'mech+' : ''}llm`; gateItem.gateKind = gateKind
                }
              }
              await runGateAll()
              while (!abort.signal.aborted && !disposed && gateItem.status === 'succeeded' && ['partial', 'fail'].includes(gateItem.verdict) && fixRound < plan.gate.maxFixRounds) {
                const failureClass = classifyGateFailure(gateItem.mechanical, gateItem.verdict)
                if (failureClass?.startsWith('mech_')) bumpStat(`dispatch.autofix.${failureClass}`)
                if (failureClass === 'mech_config_error') { gateItem.notes.push('auto_fix=0：mech_config_error'); break }
                if (failureClass === 'mech_sync_drift' && plan.syncTargets?.length) {
                  fixRound++
                  gateItem.notes.push(`auto_fix_round=${fixRound}：mech_sync_drift 无 LLM 重同步`)
                  bumpStat('dispatch.autofix.mech_sync_drift')
                  syncTargetsNow(plan.syncTargets, pipelineId)
                  const failedIndices = gateItem.mechanical.results.filter((r) => !r.ok).map((r) => r.index).filter(Number.isInteger)
                  const previousChecks = plan.gate.checks || []
                  plan.gate.checks = failedIndices.map((i) => previousChecks[i]).filter(Boolean)
                  await runGateAll()
                  plan.gate.checks = previousChecks
                  continue
                }
                const target = [...succeeded].reverse().find((t) => items[t.index].writable && items[t.index].sessionId)
                if (!target) { gateItem.notes.push('auto_fix=0：没有可复用 sessionId 的写任务，fail-closed'); break }
                gateItem.fixTarget = target.index
                const targetItem = items[target.index]
                const findings = gateItem.output
                fixRound++
                targetItem.fixRound = fixRound
                targetItem.notes.push(`auto_fix_round=${fixRound}：复用原 sessionId 修复 Gate 结论`)
                const beforeFix = targetItem.beforeGit || await captureGitTree(target.workspace)
                try {
                  const fixTask = `请就地修复上一轮交付缺口，不扩大需求范围。以下为 Gate 完整审查结论（尤其处理所有[不通过]项）：\n${findings}`
                  const actualModel = targetItem.model || (target.candidates?.[0] && `${target.candidates[0].provider}/${target.candidates[0].model}`)
                  const [actualProvider, ...modelParts] = String(actualModel || '').split('/')
                  const actualModelName = modelParts.join('/')
                  const modelArgs = actualProvider && actualModelName ? {
                    ...(Object.hasOwn(target.baseArgs, 'provider') ? {} : { provider: actualProvider }),
                    ...(Object.hasOwn(target.baseArgs, 'model') ? {} : { model: actualModelName }),
                  } : {}
                  const rawFixArgs = fillStartArgs({
                    ...target.baseArgs,
                    ...modelArgs,
                    task: fixTask,
                    sessionMode: 'latest-idle',
                    sessionId: targetItem.sessionId,
                  }, config, false)
                  delete rawFixArgs.sessionMode
                  delete rawFixArgs.resumeSessionId
                  // 初次派发会把外部路径保留在 CapabilityManifest，但 start_run 只接受 workspace 内 scope。
                  // auto_fix 复用原始参数时也必须执行同一过滤，避免续跑被底层拒绝。
                  const hasExternalFixWrite = Array.isArray(rawFixArgs.writeScope) && rawFixArgs.writeScope.some((p) => !isPathInsideWorkspace(target.workspace, p))
                  if (Array.isArray(rawFixArgs.writeScope)) {
                    rawFixArgs.writeScope = rawFixArgs.writeScope.filter((p) => isPathInsideWorkspace(target.workspace, p))
                    if (!rawFixArgs.writeScope.length) rawFixArgs.writeScope = [target.workspace]
                  }
                  if (Array.isArray(rawFixArgs.contextReadScope)) {
                    rawFixArgs.contextReadScope = rawFixArgs.contextReadScope.filter((p) => isPathInsideWorkspace(target.workspace, p))
                    if (!rawFixArgs.contextReadScope.length) rawFixArgs.contextReadScope = [target.workspace]
                  }
                  if (hasExternalFixWrite) rawFixArgs.permissionPreset = 'danger-full-access'
                  const fixArgs = JSON.parse(JSON.stringify(rawFixArgs))
                  const resumed = await startLinked(TOOL_START_RUN, fixArgs, { ...(exec || {}), signal: abort.signal }, fixTask, target.modePrefix, target.baseArgs.contextReadScope, target.inferredScope?.hosts.map((h) => `ssh:${h}`))
                  targetItem.runId = resumed.runId || targetItem.runId
                  targetItem.sessionId = resumed.sessionId || targetItem.sessionId
                  targetItem.status = 'running'; writeManifest()
                  const { snap, cancelled: runCancelled } = await waitRunV2(targetItem, resumed, abort)
                  if (disposed || isDisposeCancelReason(abort.signal.reason)) break
                  targetItem.output = runCancelled ? buildCancelConclusion(snap, 'fix cancelled') : fullConclusion(snap)
                  targetItem.status = !runCancelled && snap?.status === 'succeeded' ? 'succeeded' : (runCancelled ? 'cancelled' : 'failed')
                  const afterFix = await captureGitTree(target.workspace)
                  const diff = await diffGitTrees(target.workspace, beforeFix, afterFix)
                  targetItem.git = { available: diff.available, changed: diff.changed, files: diff.files, nameStatus: diff.nameStatus, numstat: diff.numstat, statText: diff.statText }
                  if (targetItem.status !== 'succeeded') break
                  gateItem.runId = undefined; gateItem.sessionId = undefined; gateItem.midRunRetries = 0
                  gateItem.output = ''; gateItem.error = undefined; gateItem.verdict = 'unknown'
                  gateItem.notes.push(`auto_fix_round=${fixRound} 完成，仅重跑失败机械检查或复审`)
                  const failedIndices = gateItem.mechanical?.results?.filter((r) => !r.ok).map((r) => r.index).filter(Number.isInteger) || []
                  const previousChecks = plan.gate.checks || []
                  if (failureClass?.startsWith('mech_')) plan.gate.checks = failedIndices.map((i) => previousChecks[i]).filter(Boolean)
                  await runGateAll()
                  plan.gate.checks = previousChecks
                } catch (err) {
                  if (disposed || isDisposeCancelReason(abort.signal.reason)) break
                  targetItem.status = 'failed'; targetItem.error = `auto_fix failed: ${String((err && err.message) || err)}`
                  gateItem.notes.push(targetItem.error); writeManifest(); break
                }
              }
            }
            writeManifest()
          }

          const failedN = items.filter((i) => i.status === 'failed').length
          const succN = items.filter((i) => i.status === 'succeeded').length
          const detachOnly = disposed || isDisposeCancelReason(abort.signal.reason)
          if (detachOnly && !['completed', 'failed', 'superseded'].includes(pipelinePhase)) {
            pipelinePhase = 'detached'
            writeManifest()
            return { status: 'killed', output: `pipeline ${pipelineId} detached` }
          }
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
          if (plan.followUp) bumpStat(`dispatch.followup.${result === 'PASS' ? 'passed' : 'failed'}`)
          pipelinePhase = isCancelled ? 'cancelled' : (failedN > 0 ? 'failed' : 'completed')
          finishedAt = Date.now()
          if ((pipelinePhase === 'completed' || pipelinePhase === 'failed') && parentWakeDelivered !== true) parentWakeDelivered = false
          pipelineResultHeader = `${V2_MACHINE_HEADER} | RESULT: ${result} | needs_main_attention: ${needsMainAttention} | self_review: ${gateSelfReview ? 1 : 0} | gate_kind: ${gateItem?.gateKind || (plan.gate ? 'llm' : 'none')}${plan.followUpOf ? ` | followup_of=${plan.followUpOf}` : ''}`
          writeManifest()
          await flushBeforeColdWake(parentSessionId)
          if (disposed || isDisposeCancelReason(abort.signal.reason)) {
            if (!['completed', 'failed', 'cancelled'].includes(pipelinePhase)) pipelinePhase = 'detached'
            writeManifest()
            return { status: 'killed', output: `pipeline ${pipelineId} detached` }
          }
          const reloadNames = normalizeReloadPlugins(args.reloadPlugins ?? restored?.plan?.reloadPlugins)
          const hasFailures = failedN > 0 || isCancelled || items.some((i) => i.reloadPending)
          if (!hasFailures && activePipelines.size <= 1) {
            pipelinePhase = isCancelled ? 'cancelled' : (failedN > 0 ? 'failed' : 'completed')
            finishedAt = Date.now()
            if ((pipelinePhase === 'completed' || pipelinePhase === 'failed') && parentWakeDelivered !== true) parentWakeDelivered = false
            writeManifest()
          }
          const willSelfReload = !hasFailures && activePipelines.size <= 1 && reloadNames.includes('dsh-relay-dispatch')
          if (willSelfReload) {
            const prelim = formatPipelineSummary({
              pipelineId,
              gate: plan.gate,
              gateUserAsk: plan.gate ? plan.gate.userAsk : undefined,
              items,
              reloaded: '',
              phase: pipelinePhase,
              machineHeader: pipelineResultHeader,
            }, config.maxResultChars, { slim: result === 'PASS' && needsMainAttention === 'no', brief: result !== 'PASS' || needsMainAttention !== 'no' })
            finalRead = `${pipelineResultHeader}\n${prelim}\n${modelNote()}`
          }
          const reloadSummary = await runPluginReloads(reloadNames, agent, hasFailures, {
            async beforeSelfReload() {
              parentWakeDelivered = false
              if (!finishedAt) finishedAt = Date.now()
              if (!['completed', 'failed', 'cancelled'].includes(pipelinePhase)) pipelinePhase = failedN > 0 ? 'failed' : 'completed'
              writeManifest()
              scheduleParentFollowupWake(agent, preservedOriginalJobId || jobId, {
                onDelivered() { parentWakeDelivered = true; writeManifest() },
              })
              parentWakeArmed = true
            },
            beforeReload(pkg) {
              if (pkg === 'dsh-relay-dispatch') {
                reloadedPlugins = [...new Set([...reloadedPlugins, pkg])]
                if (!disposed) writeManifest()
              }
            },
            afterReload(pkg) {
              if (disposed) return
              reloadedPlugins = [...new Set([...reloadedPlugins, pkg])]
              writeManifest()
            },
          })
          if (disposed || isDisposeCancelReason(abort.signal.reason)) {
            return { status: 'killed', output: `pipeline ${pipelineId} self-reload` }
          }
          if (reloadSummary.startsWith('reload_pending:')) items.forEach((i) => { i.reloadPending = true })
          writeManifest()
          // 机器头只由 buildDelivery/finalRead 添加一次，output 保持正文，避免 detail 重复两行 RESULT。
          const output = formatPipelineSummary({
            pipelineId,
            gate: plan.gate,
            gateUserAsk: plan.gate ? plan.gate.userAsk : undefined,
            items,
            reloaded: reloadSummary,
            phase: isCancelled ? 'cancelled' : pipelinePhase,
            machineHeader: pipelineResultHeader,
          }, config.maxResultChars, { slim: result === 'PASS' && needsMainAttention === 'no', brief: result !== 'PASS' || needsMainAttention !== 'no' })
          const deliveryStatus = isCancelled ? 'cancelled' : (failedN === 0 ? 'succeeded' : (succN > 0 ? 'partial' : 'failed'))
          const budget = result === 'PASS' && needsMainAttention === 'no' ? 800 : 1200
          const deliv = buildDelivery(deliveryStatus, output, budget, true, pipelineResultHeader)
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
    clearFault()
    if (plan.followUp && config.writeManifest !== false) {
      try {
        const previousPath = join(pipelineManifestDir(), `${plan.followUpOf}.json`)
        const previous = JSON.parse(readFileSync(previousPath, 'utf8'))
        previous.followUps = [...new Set([...(previous.followUps || []), pipelineId])]
        writeFileSync(previousPath, JSON.stringify(previous, null, 2))
      } catch (err) { emitWarn(`[relay-dispatch] followUp 父清单关联失败：${String(err?.message || err)}`) }
    }
    const dispatched = applyDispatchExplanation(args, exec, {
      jobId,
      pipelineId,
      tasks: plan.tasks.length,
      gate: Boolean(plan.gate),
      note: `已创建 v2 流水线（${plan.tasks.length} 个任务${plan.gate ? ' + gate' : ''}，onWriteConflict=${plan.onWriteConflict}）。清单：${manifestPath}`,
      manifestPath,
      machineHeader: V2_MACHINE_HEADER,
    })
    if (args.conclude === true) dispatched.concludeReason = await finishConclude(exec, notes, config.concludeFence)
    return dispatched
  }

  /** 自重载会清掉本实例的唤醒定时器；新实例补投最近 120s 内已完成/失败但尚未送达的父会话唤醒。 */
  function deliverPendingParentWakes() {
    if (disposed || config.parentWakeRecovery === false) return
    let names = []
    try { names = readdirSync(pipelineManifestDir()).filter((n) => n.endsWith('.json') && !n.startsWith('.')) } catch { return }
    const cutoff = Date.now() - (config.parentWakeWindowMs ?? DEFAULTS.parentWakeWindowMs)
    for (const name of names) {
      try {
        const manifestFile = join(pipelineManifestDir(), name)
        const restoredWake = JSON.parse(readFileSync(manifestFile, 'utf8'))
        if (!['completed', 'failed'].includes(restoredWake.phase) || restoredWake.parentWakeDelivered === true || activePipelines.has(restoredWake.pipelineId)) continue
        const stamp = parseTimeMs(restoredWake.finishedAt) ?? parseTimeMs(restoredWake.updatedAt) ?? 0
        if (stamp < cutoff) continue
        const parent = restoredWake.parentSessionId
        const agents = ctx.get('agents')
        const owner = parent && agents && typeof agents.get === 'function' ? agents.get(parent) : undefined
        if (!owner || typeof owner !== 'object') continue
        const wakeId = restoredWake.originalJobId || restoredWake.jobId || restoredWake.pipelineId
        const text = `${restoredWake.machineHeader || V2_MACHINE_HEADER}\npipeline_id: ${restoredWake.pipelineId}\nphase: ${restoredWake.phase}\njobId: ${wakeId}`
        const settle = () => {
          try {
            const latest = JSON.parse(readFileSync(manifestFile, 'utf8'))
            if (latest.parentWakeDelivered === true) return
            latest.parentWakeDelivered = true
            latest.updatedAt = new Date().toISOString()
            const tmp = `${manifestFile}.tmp`
            writeFileSync(tmp, JSON.stringify(latest, null, 2))
            renameSync(tmp, manifestFile)
          } catch (err) { emitWarn(`[relay-dispatch] parent wake flag 写入失败：${String(err?.message || err)}`) }
        }
        if (hasPendingInbox(owner) || (owner.status && owner.status !== 'idle')) {
          if (!hasPendingInbox(owner)) sendSessionNotice(ctx, owner, text, `pipeline ${restoredWake.pipelineId}`)
          scheduleParentFollowupWake(owner, wakeId, { onDelivered: settle })
          continue
        }
        if (sendSessionNotice(ctx, owner, text, `pipeline ${restoredWake.pipelineId}`)) settle()
      } catch (err) {
        emitWarn(`[relay-dispatch] 补投父会话唤醒失败 ${name}：${String(err?.message || err)}`)
      }
    }
  }

  /** 接管插件重载/DSH 分离的流水线；沿用已有 runId 等待，绝不重复 start_run。 */
  function resumeDetachedPipelines() {
    const jobs = ctx.get('jobs')
    if (!jobs || disposed || config.resumeDetachedPipelines === false) return
    let names = []
    try { names = readdirSync(pipelineManifestDir()).filter((n) => n.endsWith('.json')) } catch { return }
    const cutoff = Date.now() - (config.resumeWindowMs ?? DEFAULTS.resumeWindowMs)
    for (const name of names) {
      try {
        const restored = JSON.parse(readFileSync(join(pipelineManifestDir(), name), 'utf8'))
        if (!['detached', 'running'].includes(restored.phase) || !restored.plan || activePipelines.has(restored.pipelineId)) continue
        if ((parseTimeMs(restored.updatedAt || restored.createdAt) ?? 0) < cutoff) continue
        const parent = restored.parentSessionId
        const agents = ctx.get('agents')
        const sessions = ctx.get('sessions')
        const owner = (parent && agents && typeof agents.get === 'function' && agents.get(parent)) || {
          id: parent || undefined,
          session: parent && sessions && typeof sessions.get === 'function' ? sessions.get(parent) : undefined,
        }
        const exec = { agent: owner, signal: new AbortController().signal }
        startPipelineV2({}, exec, jobs, restored).catch((err) => emitWarn(`[relay-dispatch] 恢复流水线失败：${String((err && err.message) || err)}`))
      } catch (err) {
        emitWarn(`[relay-dispatch] 读取分离流水线 ${name} 失败：${String((err && err.message) || err)}`)
      }
    }
    deliverPendingParentWakes()
  }
  const resumeTimer = setTimeout(resumeDetachedPipelines, config.resumeDelayMs ?? DEFAULTS.resumeDelayMs)
  resumeTimer.unref?.()
  resumerTimers.add(resumeTimer)

  ctx.effect(() => tools.register({
    name: 'relay_dispatch',
    description:
      '派发 Harness relay 任务，后台执行：立即返回 jobId，结束时通知回传结论；派发后不要轮询 wait_run/job_output，无事即结束本轮。\n' +
      '最少只需 {workspace, task}（workspace 须已在 Harness 注册）；未传的字段自动补默认，provider/model 默认 ' + config.defaultProvider + '/' + config.defaultModel + '，显式传入的不被覆盖。\n' +
      'mode：' + Object.keys(loadModes(config.modesPath || MODES_PATH).modes).join('/') + '；套用该模式的权限/模型候选链/交付格式。最简用法：{mode, startArgs:{workspace, task}}。',
    parameters: {
      type: 'object',
      properties: {
        startArgs: {
          type: 'object',
          additionalProperties: true,
          properties: {},
          description: '传给 start_run/start_review 的参数：workspace/task/provider/model 等',
        },
        mode: { type: 'string', description: 'investigate/implement/verify/review/heavy/rp/uncensored' },
        review: { type: 'boolean', description: 'true 用 start_review（只读）' },
        maxWaitMinutes: { type: 'integer', description: '最长等待分钟，默认 240' },
        conclude: { type: 'boolean', description: '重要：使用 conclude:true 时，必须在同一步 tool_call 之前同时输出简短的 assistant 正文回复向用户说明本次派发干什么；summary 字段作为兜底同步展示。同一步已写出最终回复文字时设为 true；派发成功且 context_compact 同步成功后结束本轮，省去后续一步' },
        summary: { type: 'string', description: '简短说明本次派发干什么；conclude:true 时若当步没有 assistant 正文，会以独立助手消息写入当前对话兜底展示后再结束本轮' },
        targets: { type: 'array', items: { type: 'string' }, description: '声明式插件套件宏；自动展开同步、机械 Gate、writeScope 与 reloadPlugins' },
        tasks: { type: 'array', description: '多任务；每项 {startArgs?,mode?,review?,label?,workspace/task/provider/model/writeScope}，与顶层 startArgs 合并', items: { type: 'object', additionalProperties: true, properties: {} } },
        specFile: { type: 'string', description: '规格文件；预检存在并给 task/Gate 拼指针，支持 @ws/@dsh/@plugins/yaml roots 宏' },
        specSections: { type: 'array', items: { type: 'string' } },
        handoff: { type: 'object', description: "交接契约 {name:'path#exportA,exportB'}；task.in/out 自动依赖并校验", additionalProperties: true, properties: {} },
        syncTargets: { type: 'array', description: "{source,target,root?,mode?:'verify'|'copy'}；copy 自动备份并同步后校验 SHA256", items: { type: 'object', additionalProperties: true, properties: {} } },
        gate: { type: 'object', description: "v2 验证门；criteria:'@tasks' 自动拼 task 原文；checks:[{sha/gitClean/noDiff/cmd+minTests/exists/exports}]，llm:'auto'|'never'", additionalProperties: true, properties: {} },
        onWriteConflict: { type: 'string', description: "同 workspace 写范围重叠时 'error'（默认）或 'serial'", enum: ['error', 'serial'] },
        reloadPlugins: { type: 'array', items: { type: 'string' }, description: '任务全部成功后静默热重载指定插件；有失败时仅列出待重载项' },
        followUp: { type: 'object', description: '基于失败流水线续修/重跑机械门：{pipelineId,patchTask?,patchGate?}；与 tasks/startArgs 互斥', additionalProperties: true, properties: {} },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderDispatchText(value) }],
    },
    async execute(args, exec) {
      const jobs = ctx.get('jobs')
      if (!jobs) throw new Error('background jobs unavailable')
      normalizeReloadPlugins(args.reloadPlugins)
      if (args.targets != null || args.tasks?.some((t) => t?.targets != null)) return startPipelineV2(args, exec, jobs)
      if (args.tasks != null || args.gate != null || args.followUp != null) return startPipelineV2(args, exec, jobs)
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
          started = await startLinked(startTool, fillStartArgs(sa, config, !!args.review), exec, rawTask, modePrefix, baseArgs.contextReadScope)
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
          const finalize = async (r) => {
              if (!r.output && r.detail) r.output = String(r.detail).replace(/^status:[^\n]*\n(?:full_in_detail=1\n)?/, '')
              if (r.output === '(无)' && r.detail && r.detail !== '(无)') r.output = String(r.detail).replace(/^status:[^\n]*\n(?:full_in_detail=1\n)?/, '')
              const coldHook = globalThis[Symbol.for('dsh.context-compact.hooks.v1')]?.flushBeforeColdWake
              if (!normalizeReloadPlugins(args.reloadPlugins).length && typeof coldHook !== 'function') return r
              const reloadSummary = await runPluginReloads(args.reloadPlugins, agent, r.status !== 'completed' || cancelled)
              await flushBeforeColdWake(agent?.session?.header?.id)
              if (reloadSummary) {
                const rebuilt = buildDelivery(r.detail?.startsWith('status: cancelled') ? 'cancelled' : (r.status === 'completed' ? 'succeeded' : 'failed'), r.output || '', DETAIL_BUDGET_BYTES, true, reloadSummary)
                r.detail = rebuilt.detail
                r.finalText = rebuilt.finalText
                r.truncated = rebuilt.truncated
                r.fullLength = rebuilt.fullLength
                r.fullTextAvailable = rebuilt.fullTextAvailable
              }
              return r
          }
          const done = (async () => {
            const finalize = async (r) => {
              const reloadSummary = await runPluginReloads(args.reloadPlugins, agent, r.status !== 'completed' || cancelled)
              await flushBeforeColdWake(agent?.session?.header?.id)
              if (reloadSummary) {
                const rebuilt = buildDelivery(r.detail?.startsWith('status: cancelled') ? 'cancelled' : (r.status === 'completed' ? 'succeeded' : 'failed'), r.output || '', DETAIL_BUDGET_BYTES, true, reloadSummary)
                Object.assign(r, rebuilt)
              }
              return r
            }
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
            const initEvCount = sessionEventCount(initChild.session)
            let hadSession = initEvCount != null
            let lastEvCount = initEvCount ?? 0
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
                const curEvCountOrNull = sessionEventCount(childSession)
                const hasCurSess = curEvCountOrNull != null
                const curEvCount = curEvCountOrNull ?? 0
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
              const blocked = isUpstreamBlockedOutput(output)
              const ok = snap && snap.status === 'succeeded' && !blocked
              const deliv = buildDelivery(blocked ? 'failed' : String(snap && snap.status), output)
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
          })().then(finalize).then(finish)
          return {
            cancel: (reason) => {
              if (cancelled) return
              cancelled = true
              const detachOnly = disposed || isDisposeCancelReason(reason)
              // v1 没有可接管的流水线清单，只把本地 job 标 reported，避免卸载后再投递 [status:killed]。
              if (detachOnly && jobId) quietDisposedJob(jobs, jobId, agent)
              try { abort.abort(reason || 'cancelled') } catch {}
              // jobs 服务关闭或插件卸载只中止本地等待，绝不误杀仍在执行的远端会话。
              if (!detachOnly) {
                call(TOOL_CANCEL, { runId }, agent, new AbortController().signal).catch(() => {})
              }
            },
            done,
            // 只在结束后一次性给出精简结论；运行中不吐任何中间输出。
            readOutput: () => { const t = pending; pending = ''; return t },
          }
        },
      })
      const dispatched = applyDispatchExplanation(args, exec, { jobId, runId, model: used, note: modelNote, ...(webUrl ? { webUrl } : {}) })
      if (args.conclude === true) dispatched.concludeReason = await finishConclude(exec, notes, config.concludeFence)
      return dispatched
    },
  }))

  queueMicrotask(() => {
    if (disposed) return
    reconcileStrayChildSessions(ctx, config).catch(() => {})
  })
  try {
    const loader = (ctx && ctx.loader) || (typeof ctx.get === 'function' ? ctx.get('loader') : undefined)
    if (loader && typeof ctx.get === 'function' && ctx.get('clientModules')) {
      const timer = setTimeout(() => {
        try { reloadPluginByName(ctx, '@dsh-external/dsh-relay-dispatch') } catch {}
      }, 80)
      if (typeof timer.unref === 'function') timer.unref()
    }
  } catch {}
}
