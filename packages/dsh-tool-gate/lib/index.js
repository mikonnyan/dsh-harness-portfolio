/**
 * dsh-tool-gate — hide rarely used tool groups; unlock on demand.
 * Layer: profile bundle. Hooks: system-prompt/assemble (filter tools & contexts, remove-only),
 * tools/pre-execute (zero-friction auto-unlock), tool `tool_unlock`, command `/tools`.
 * Remove-only filtering => coexists cleanly with upstream plugins that replace or clear the tool catalog.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-tool-gate'
export const inject = ['tools', 'commands']

export const DEFAULT_CONFIG = {
  groups: {
    dev: { prefixes: ['dev_'], names: [], contextMatch: ['dsh-super-injector（dev_'], hint: '插件开发/热重载/注入/staging/模式切换 (dev_*)' },
    relay: { prefixes: ['mcp__harness_relay__'], names: [], hint: 'Harness 会话管理、查看/取消/续用 run' },
    connector: { prefixes: ['mcp_connector_'], names: [], hint: 'MCP 连接器配置/连接/状态' },
    browser: { prefixes: ['mcp__chrome-devtools__'], names: [], hint: '浏览器操作 (chrome-devtools)' },
  },
  defaultOn: [],
  includeSubagents: false,
  alwaysVisible: ['tool_unlock', 'relay_dispatch'],
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')
export const configPath = () => join(home(), 'tool-gate', 'config.json')
export const statePath = () => join(home(), 'tool-gate', 'state.json')

/** Hot-read config (every call); missing/invalid file => defaults. */
export function loadConfig(path = configPath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw, groups: { ...DEFAULT_CONFIG.groups, ...(raw.groups || {}) } }
  } catch { return DEFAULT_CONFIG }
}

function loadState(path = statePath()) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}
function saveState(state, path = statePath()) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(state, null, 1)) } catch {}
}

/** Group a tool name belongs to, or undefined. */
export function groupOf(toolName, cfg) {
  if (typeof toolName !== 'string' || !toolName || cfg.alwaysVisible?.includes(toolName)) return undefined
  for (const [g, def] of Object.entries(cfg.groups)) {
    if (def.names?.includes(toolName) || def.prefixes?.some((p) => validPrefix(p) && toolName.startsWith(p))) return g
  }
  return undefined
}

const sidOf = (session) => session?.header?.id || ''

const validPrefix = (p) => typeof p === 'string' && p.length > 0
export function replaySources(session, cfg) {
  const out = {}
  const sid = sidOf(session)
  for (const ev of session?.events || []) {
    if (ev?.type !== 'tool/call') continue
    const d = ev.data
    if (!d || typeof d.name !== 'string' || !d.name) continue
    if (ev.sessionId && sid && ev.sessionId !== sid) continue
    if (d.parent || ev.parent || (typeof d.callId === 'string' && d.callId.startsWith('relay-dispatch-'))) continue
    if (d.name === 'tool_unlock') {
      let a; try { a = JSON.parse(d.arguments) } catch { continue }
      if (!a || !Array.isArray(a.groups)) continue
      const on = a.action !== 'off'
      for (const g of a.groups) if (typeof g === 'string' && cfg?.groups?.[g]) out[g] = { on, src: 'tool_unlock' }
      continue
    }
    const g = cfg ? groupOf(d.name, cfg) : undefined
    if (g) out[g] = { on: true, src: '自动放行' }
  }
  return out
}
export function replayUnlocks(session, cfg) {
  return Object.fromEntries(Object.entries(replaySources(session, cfg)).map(([g, v]) => [g, v.on]))
}

/** Per-group open state with source. defaults < replay < /tools state (this session only). */
export function openSources(session, cfg, state = loadState()) {
  const m = {}
  for (const g of cfg.defaultOn || []) if (cfg.groups[g]) m[g] = { on: true, src: 'config 默认' }
  Object.assign(m, replaySources(session, cfg))
  const sid = sidOf(session)
  const st = sid && state && Object.prototype.hasOwnProperty.call(state, sid) ? state[sid] : {}
  for (const [g, v] of Object.entries(st || {})) if (cfg.groups[g] && typeof v === 'boolean') m[g] = { on: v, src: '/tools 手动' }
  return m
}
export function openGroups(session, cfg, state = loadState()) {
  const m = openSources(session, cfg, state)
  return new Set(Object.keys(m).filter((g) => m[g].on))
}
function isGated(session, cfg) {
  return cfg.includeSubagents || (session?.header?.delegationDepth ?? 0) === 0
}

/** Pure filter used by the assemble hook (remove-only). */
export function filterTools(tools, session, cfg, state) {
  if (!Array.isArray(tools) || !isGated(session, cfg)) return tools
  const open = openGroups(session, cfg, state)
  return tools.filter((t) => { const g = groupOf(t.name, cfg); return g === undefined || open.has(g) })
}

/** Remove runtime contexts tied to a closed group (text contains a group's contextMatch marker). Remove-only. */
export function filterContexts(contexts, session, cfg, state) {
  if (!Array.isArray(contexts) || !contexts.length || !isGated(session, cfg)) return contexts
  const open = openGroups(session, cfg, state)
  const closed = Object.entries(cfg.groups).filter(([g, d]) => !open.has(g) && Array.isArray(d.contextMatch) && d.contextMatch.length)
  if (!closed.length) return contexts
  const textOf = (c) => typeof c === 'string' ? c : (typeof c?.text === 'string' ? c.text : (typeof c?.content === 'string' ? c.content : ''))
  return contexts.filter((c) => { const s = textOf(c); return !closed.some(([, d]) => d.contextMatch.some((m) => typeof m === 'string' && m && s.includes(m))) })
}

/** Plugin-internal calls (e.g. relay_dispatch, callId prefix relay-dispatch-) or nested sub-dispatches (parent set) are not model-direct: never gate them. */
export function isInternalCall(exec) {
  return !!(exec && (exec.parent || (typeof exec.callId === 'string' && exec.callId.startsWith('relay-dispatch-'))))
}

/** Pure pre-execute decision. */
export function gateDecision(toolName, session, cfg, state) {
  if (!isGated(session, cfg)) return { kind: 'allow' }
  const g = groupOf(toolName, cfg)
  if (g === undefined || openGroups(session, cfg, state).has(g)) return { kind: 'allow' }
  return { kind: 'allow', autoUnlock: g }
}

function setGroups(session, groups, on) {
  const sid = sidOf(session); if (!sid || !groups.length) return
  const state = loadState()
  state[sid] = { ...(state[sid] || {}) }
  for (const g of groups) state[sid][g] = on
  saveState(state)
}

function statusText(session, cfg) {
  const open = openGroups(session, cfg); const src = openSources(session, cfg)
  return ['### 工具组状态 (/tools)', ...Object.entries(cfg.groups).map(([g, d]) => `- **${g}**: ${open.has(g) ? '✅ 已开启（来源: ' + src[g].src + '）' : '🔒 隐藏'} — ${d.hint || ''}`),
    '', '用法: `/tools <组> on|off`、`/tools all on|off`'].join('\n')
}

export function apply(ctx) {
  const index = () => Object.entries(loadConfig().groups).map(([g, d]) => `- ${g}: ${d.hint || ''}`).join('\n')
  ctx.effect(() => ctx.tools.register({
    name: 'tool_unlock',
    description: ['打开/关闭被隐藏的工具组（下一轮请求起生效，会话内保持）。需要以下能力时先调用（知道工具名时也可直接调用，会自动解锁该组）：', index(), '参数 groups: 组名数组；action: on(默认)|off。'].join('\n'),
    parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['on', 'off'] } }, required: ['groups'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      const cfg = loadConfig()
      const on = args?.action !== 'off'
      const gs = (Array.isArray(args?.groups) ? args.groups : []).filter((g) => typeof g === 'string')
      const bad = gs.filter((g) => !cfg.groups[g]); const ok = gs.filter((g) => cfg.groups[g])
      setGroups(exec?.agent?.session, ok, on)
      if (!ok.length) return { text: `groups 为空或无效，未${on ? '开启' : '关闭'}任何组。${bad.length ? '未知组: ' + bad.join(', ') + '。' : ''}可选组名: ${Object.keys(cfg.groups).join(', ')}。\n当前状态: ${Object.keys(cfg.groups).map((g) => g + '=' + (openGroups(exec?.agent?.session, cfg).has(g) ? '开' : '隐藏')).join(', ')}` }
      return { text: `${on ? '已开启' : '已关闭'}: ${ok.join(', ') || '(无)'}${bad.length ? `；未知组: ${bad.join(', ')}（可用: ${Object.keys(cfg.groups).join(', ')}）` : ''}。下一轮起生效。` }
    },
  }), name + ': tool_unlock')

  ctx.on('system-prompt/assemble', async (_a, context, next) => {
    const assembled = await next()
    try { const s = context?.agent?.session, cfg = loadConfig(); const out = { ...assembled, tools: filterTools(assembled.tools, s, cfg) }; if (Array.isArray(assembled.contexts)) out.contexts = filterContexts(assembled.contexts, s, cfg); return out } catch { return assembled }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const prev = await next()
    if (prev.kind !== 'allow') return prev
    if (isInternalCall(exec)) return prev
    try {
      const d = gateDecision(exec.name, exec.agent?.session, loadConfig())
      if (d.autoUnlock) { setGroups(exec.agent?.session, [d.autoUnlock], true); try { ctx.logger('tool-gate').info('auto-unlocked group ' + d.autoUnlock + ' (call ' + exec.name + ')') } catch {} }
      return { kind: 'allow' }
    } catch { return prev }
  })

  ctx.effect(() => ctx.commands.register({
    name: 'tools',
    description: '工具组开关：/tools | /tools <组|all> on|off',
    input: { hint: '<group|all> on|off' },
    handler: ({ agent, rawInput }) => {
      const cfg = loadConfig(); const session = agent?.session
      const [t, a] = String(rawInput || '').trim().toLowerCase().split(/\s+/)
      if (!t) return { kind: 'success', text: statusText(session, cfg) }
      if (a !== 'on' && a !== 'off') return { kind: 'error', text: '用法: /tools <组|all> on|off' }
      const gs = t === 'all' ? Object.keys(cfg.groups) : [t]
      if (t !== 'all' && !cfg.groups[t]) return { kind: 'error', text: `未知组 ${t}，可用: ${Object.keys(cfg.groups).join(', ')}` }
      setGroups(session, gs, a === 'on')
      return { kind: 'success', text: statusText(session, cfg) + '\n\n（下一轮请求起生效）' }
    },
  }), name + ': /tools')
}
