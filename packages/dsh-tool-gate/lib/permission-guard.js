import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'

export const OUT_OF_SCOPE = 'DSH_E_OUT_OF_SCOPE'
export { SELF_FIX, SHELL_BUDGET } from './orchestrator-guard.js'
export const HIGH_RISK = 'DSH_HIGH_RISK_APPROVAL_REQUIRED'
// These are HTTP endpoints, not permission to manage their host processes or reconfigure ports.
export const DEFAULT_LOOPBACK_PORTS = Object.freeze([3080, 4098, 4141, 4142, 8318])
const NODE_SMOKE_SCRIPTS = new Set(['live-gateway-smoke.mjs'])
const APPROVED_NODE_SMOKE_SHA256 = new Set(['c41df4ec48b14d006321cd7681ffd0dde0780d14fff358382b2639ffdf0bec3c'])
const ESCALATION_KEYS = ['sandbox_permissions', 'amend', 'extend', 'escalate']
const FILE_TOOLS = new Set(['read', 'write', 'edit'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'cmd'])
const SENSITIVE = /(?:^|[\\/])(?:\.env(?:\..*)?|\.credentials\.yaml|secrets?)(?:[\\/]|$)/i
const HIGH_RISK_COMMANDS = /^(?:remove-item|ri|rm|del|erase|rmdir|stop-process|kill|restart-service|stop-service|start-process|set-acl|takeown|icacls|format|clear-disk|shutdown|restart-computer|stop-computer|set-executionpolicy|new-localuser|net)$/i
const DYNAMIC = /(?:\$\(|\$\{|\$[A-Za-z_]|\binvoke-expression\b|\biex\b|&\s*['"]|\.\s*['"]|encodedcommand|\bcomobject\b|::|\bwmi|\bcim|scheduledtask|Start-Process|Invoke-Command|Start-Job|\*\*)/i

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const rootsOf = (manifest, kind) => manifest?.[`${kind}_roots`]?.length ? manifest[`${kind}_roots`] : (kind === 'read' ? manifest?.allowed_roots : manifest?.write_scope) || []
const rootPath = (root) => typeof root === 'string' ? root : root?.canonical_path
const pathKey = (path) => {
  let value = String(path || '').trim().replace(/[\\/]+/g, '\\').replace(/[. ]+$/g, '')
  if (/^[A-Za-z]:/.test(value)) value = value[0].toUpperCase() + value.slice(1)
  return value.toLowerCase()
}
export function lexicalPath(path, cwd = process.cwd()) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return null
  const value = path.trim().replace(/^['"]|['"]$/g, '')
  if (/^[A-Za-z]:[^\\/]/.test(value) || value.slice(2).includes(':') || /^\\\\[^\\]+\\[^\\]+:/.test(value)) return null
  if (/(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[. ]|$)/i.test(value)) return null
  return win32.resolve(isAbsolute(value) || win32.isAbsolute(value) ? value : win32.resolve(cwd, value))
}
export function pathWithin(path, root, cwd) {
  const candidate = lexicalPath(path, cwd)
  const base = lexicalPath(rootPath(root), cwd)
  if (!candidate || !base) return false
  const a = pathKey(candidate), b = pathKey(base)
  return a === b || a.startsWith(b.endsWith('\\') ? b : `${b}\\`)
}
function nearestRealPath(path) {
  let current = path
  while (current && current !== win32.dirname(current)) {
    try { return realpathSync.native(current) } catch { current = win32.dirname(current) }
  }
  return null
}
export function pathWithinVerified(path, root, cwd) {
  if (!pathWithin(path, root, cwd)) return false
  const candidate = lexicalPath(path, cwd), base = rootPath(root)
  const resolvedCandidate = nearestRealPath(candidate), resolvedRoot = nearestRealPath(lexicalPath(base, cwd))
  if (!resolvedCandidate || !resolvedRoot) return false
  try {
    if (lstatSync(resolvedRoot).isSymbolicLink()) return false
  } catch { return false }
  return pathWithin(resolvedCandidate, resolvedRoot, cwd)
}
function rootsHint(manifest) {
  return {
    write_roots: rootsOf(manifest, 'write').map((r) => r.root_id || rootPath(r)),
    read_roots: rootsOf(manifest, 'read').map((r) => r.root_id || rootPath(r)),
    exec_profiles: manifest.exec_profiles || [],
  }
}
export function localDeny(reason, manifest, details = {}) {
  const error = {
    ok: false,
    code: OUT_OF_SCOPE,
    retryable: false,
    escalation: 'forbidden',
    directive: 'skip_and_continue',
    reason,
    task_id: manifest?.task_id || null,
    policy_digest: manifest?.policy_digest || null,
    risk_ref: `rk_${sha256(canonical({ reason, ...details })).slice(0, 16)}`,
    allowed_hint: rootsHint(manifest),
    ...details,
  }
  return { kind: 'deny', decision: 'DENY_LOCAL', error, reason: JSON.stringify(error) }
}

export function manifestOf(session) {
  const h = session?.header || {}
  const direct = h.capabilityManifest || h.capability_manifest || session?.capabilityManifest || session?.capability_manifest
  if (direct) return direct
  const reg = globalThis[Symbol.for('@dsh-external/capability-manifests')]
  if (reg && typeof reg.get === 'function') {
    return reg.get(h) || (h.id ? reg.get(h.id) : null) || null
  }
  return null
}
export function isChildSession(session) {
  return Boolean(session?.header?.parentSession || manifestOf(session))
}
export function validateCapabilityManifest(manifest, now = Date.now()) {
  if (!manifest || manifest.schema_version !== 'capability/v1') return 'missing_or_invalid_manifest'
  if (manifest.escalation !== 'forbidden' || !Array.isArray(manifest.forbidden_ports) || !manifest.forbidden_ports.includes(3080)) return 'invalid_static_boundaries'
  const expires = Date.parse(manifest.expires_at)
  if (!Number.isFinite(expires) || expires <= now) return 'manifest_expired'
  if (!Array.isArray(rootsOf(manifest, 'read')) || !Array.isArray(rootsOf(manifest, 'write'))) return 'invalid_roots'
  if (manifest.policy_digest) {
    const unsigned = { ...manifest }; delete unsigned.policy_digest
    if (manifest.policy_digest !== `sha256:${sha256(canonical(unsigned))}`) return 'policy_digest_mismatch'
  }
  return null
}
function fallbackManifest(session) {
  const cwd = session?.header?.cwd
  return {
    schema_version: 'capability/v1', task_id: null, role: 'legacy-child',
    read_roots: cwd ? [{ root_id: 'ws', canonical_path: cwd }] : [], allowed_roots: cwd ? [{ root_id: 'ws', canonical_path: cwd }] : [],
    write_roots: [], write_scope: [], forbidden_ports: [3080], loopback_ports: [...DEFAULT_LOOPBACK_PORTS], protected_host_processes: ['dsh', 'kimi-bridge', 'kimi-bridge-v2'],
    escalation: 'forbidden', exec_profiles: [], expires_at: '9999-12-31T23:59:59.999Z',
  }
}

// Conservative literal lexer. It deliberately is not a PowerShell AST substitute:
// anything dynamic or unparseable is UNKNOWN and denied locally (never auto-approved).
export function tokenizeLiteral(command) {
  const tokens = []; let token = '', quote = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) {
        if (quote === '"' && command[i + 1] === '"') { token += '"'; i++; continue }
        quote = null; continue
      }
      if (quote === "'" && c === "'" && command[i + 1] === "'") { token += "'"; i++; continue }
      token += c; continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (/\s/.test(c)) { if (token) { tokens.push(token); token = '' } ; continue }
    if (/[;|&<>`]/.test(c)) return null
    token += c
  }
  if (quote || !token && !tokens.length) return null
  if (token) tokens.push(token)
  return tokens
}
export function isAllowedLoopbackUrl(value) {
  try {
    const url = new URL(String(value))
    const host = url.hostname.replace(/^\[|\]$/g, '')
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(host) && DEFAULT_LOOPBACK_PORTS.includes(Number(url.port || 80))
  } catch { return false }
}

function protectedCommand(tokens) {
  const text = tokens.join(' ')
  const ports = [3080].filter((p) => new RegExp(`(?:^|[^0-9])${p}(?:[^0-9]|$)`).test(text))
  if (ports.length) return { reason: 'forbidden_host_port', ports }
  const processPattern = /(?:^|[\\/_.-])(?:dsh|kimi-bridge|kimi-bridge-v2)(?:$|[\\/_.-])/i
  if (/^(?:stop-process|kill|taskkill|restart-service|stop-service)$/i.test(tokens[0])) return { reason: 'protected_host_process', processes: ['dsh', 'kimi-bridge'] }
  if (/^(?:stop-computer|restart-computer)$/i.test(tokens[0]) && tokens.slice(1).some((t) => processPattern.test(t))) {
    return { reason: 'protected_host_process', processes: ['dsh', 'kimi-bridge'] }
  }
  return null
}
function pathArgs(executable, argv) {
  const targets = []
  let positional = 0
  const maxPositional = ['copy-item', 'move-item'].includes(executable) ? 2 : 1
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i], previous = String(argv[i - 1] || '').toLowerCase()
    if (['-path', '-literalpath', '-destination'].includes(previous)) { targets.push(t); continue }
    if (t.startsWith('-')) continue
    if (positional < maxPositional) { targets.push(t); positional++ }
  }
  return targets
}
function loopbackHttpPort(value) {
  try { return Number(new URL(String(value)).port || 80) } catch { return NaN }
}
function urlsAreReadOnlyLoopback(urls) {
  return urls.length > 0 && urls.every((value) => isAllowedLoopbackUrl(value) && loopbackHttpPort(value) !== 3080)
}
function readOnlyCurlArgs(argv) {
  const urls = []
  const boolFlags = new Set(['s', 'S', 'k', 'i', 'f', 'g'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') return null
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase()
      const inline = eq === -1 ? null : body.slice(eq + 1)
      if (['silent', 'show-error', 'insecure', 'include', 'fail', 'globoff'].includes(name)) {
        if (inline != null) return null
        continue
      }
      if (['max-time', 'connect-timeout', 'retry', 'retry-delay'].includes(name)) {
        const value = inline ?? argv[++i]
        if (!/^\d+(?:\.\d+)?$/.test(String(value ?? ''))) return null
        continue
      }
      if (name === 'request') {
        if (String(inline ?? argv[++i] ?? '').toUpperCase() !== 'GET') return null
        continue
      }
      if (name === 'url') {
        const value = inline ?? argv[++i]
        if (!value) return null
        urls.push(value)
        continue
      }
      return null
    }
    if (arg.startsWith('-')) {
      const cluster = arg.slice(1)
      if (cluster === 'X') {
        if (String(argv[++i] ?? '').toUpperCase() !== 'GET') return null
        continue
      }
      if (cluster === 'm' || /^m\d+(?:\.\d+)?$/.test(cluster)) {
        if (cluster === 'm' && !/^\d+(?:\.\d+)?$/.test(String(argv[++i] ?? ''))) return null
        continue
      }
      if (cluster && [...cluster].every((ch) => boolFlags.has(ch))) continue
      return null
    }
    urls.push(arg)
  }
  return urlsAreReadOnlyLoopback(urls) ? true : null
}
function readOnlyPowerShellHttp(argv) {
  const urls = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (/^https?:\/\//i.test(arg)) { urls.push(arg); continue }
    if (arg.toLowerCase() === 'get') continue
    const flag = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(arg)
    if (!flag) return null
    const name = flag[1].toLowerCase()
    const inline = flag[2]
    const take = () => inline != null ? inline : argv[++i]
    if (name === 'uri') {
      const value = take()
      if (value == null || value === '') return null
      urls.push(value)
      continue
    }
    if (name === 'method') {
      if (String(take() ?? '').toUpperCase() !== 'GET') return null
      continue
    }
    if (name === 'timeoutsec') {
      if (!/^\d+$/.test(String(take() ?? ''))) return null
      continue
    }
    if (name === 'usebasicparsing' && inline == null) continue
    return null
  }
  return urlsAreReadOnlyLoopback(urls) ? true : null
}
function isReadOnlyLoopbackGet(executable, argv) {
  if (executable === 'curl') return readOnlyCurlArgs(argv) != null
  if (['invoke-restmethod', 'irm', 'invoke-webrequest', 'iwr'].includes(executable)) return readOnlyPowerShellHttp(argv) != null
  return false
}
export function normalizeCommand(command, cwd) {
  const tokens = tokenizeLiteral(String(command || '').trim())
  if (!tokens) return { risk: 'UNKNOWN', executable: null, argv: [], cwd }
  const [raw, ...argv] = tokens
  const executable = raw.replace(/\.(?:exe|ps1|cmd|bat)$/i, '').toLowerCase()
  const aliases = { ri: 'remove-item', rm: 'remove-item', del: 'remove-item', rmdir: 'remove-item', gc: 'get-content', cat: 'get-content', kill: 'stop-process' }
  const normalized = { executable: aliases[executable] || executable, argv, cwd }
  const forbidden = protectedCommand([normalized.executable, ...argv])
  if (forbidden) return { ...normalized, risk: 'OUT_OF_SCOPE', ...forbidden }
  if (isReadOnlyLoopbackGet(normalized.executable, argv)) return { ...normalized, risk: 'PORT_PROBE' }
  const withoutWindowsPaths = command.replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>')
  if (DYNAMIC.test(withoutWindowsPaths) || /[*?]/.test(command) && ['remove-item', 'stop-process'].includes(normalized.executable)) return { ...normalized, risk: 'UNKNOWN' }
  if (HIGH_RISK_COMMANDS.test(normalized.executable)) return { ...normalized, risk: 'HIGH_RISK' }
  if (['node', 'npm', 'git'].includes(normalized.executable)) {
    if (normalized.executable === 'node' && !['--test', '--check'].includes(argv[0]) && !(argv.length === 1 && NODE_SMOKE_SCRIPTS.has(win32.basename(argv[0]).toLowerCase())) && !(argv.length === 1 && /\.mjs$/i.test(argv[0]) && /(?:^|[\\/])(?:unit|[^\\/]+\.test)\.mjs$/i.test(argv[0]))) return { ...normalized, risk: 'UNKNOWN' }
    if (normalized.executable === 'npm') {
      const validPrefixTest = argv[0] === '--prefix' && argv.length === 3 && argv[2] === 'test' && typeof argv[1] === 'string'
      if (argv[0] === 'run' && !(argv.length === 2 && ['check', 'bench'].includes(argv[1]))) return { ...normalized, risk: 'UNKNOWN' }
      if (!['test', 'run', 'ls'].includes(argv[0]) && !validPrefixTest) return { ...normalized, risk: 'UNKNOWN' }
    }
    if (normalized.executable === 'git' && !['diff', 'status', 'show', 'log', 'rev-parse'].some((c) => argv.includes(c))) return { ...normalized, risk: 'UNKNOWN' }
    return { ...normalized, risk: 'SAFE_READ' }
  }
  if (['get-content', 'get-childitem', 'get-location', 'get-filehash', 'get-item', 'test-path'].includes(normalized.executable)) return { ...normalized, risk: 'SAFE_READ' }
  if (normalized.executable === 'ssh') return { ...normalized, risk: 'SSH_TEST' }
  if (['get-nettcpconnection', 'test-netconnection'].includes(normalized.executable)) return { ...normalized, risk: 'PORT_PROBE' }
  if (['set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item'].includes(normalized.executable)) return { ...normalized, risk: 'SCOPED_WRITE' }
  return { ...normalized, risk: 'UNKNOWN' }
}

/** Approval is bound to normalized executable/argv/cwd plus task, roots and validity. */
export function approvalSummary(input) {
  const normalized = {
    schema_version: 'approval-command/v1',
    executable: String(input.executable || '').toLowerCase(),
    argv: [...(input.argv || [])],
    cwd: lexicalPath(input.cwd || process.cwd()),
    env: Object.fromEntries(Object.entries(input.env || {}).sort()),
    read_roots: (input.read_roots || rootsOf(input.manifest, 'read').map(rootPath)).map((p) => lexicalPath(p)),
    write_roots: (input.write_roots || rootsOf(input.manifest, 'write').map(rootPath)).map((p) => lexicalPath(p)),
    task_id: input.manifest?.task_id || input.task_id || null,
    policy_digest: input.manifest?.policy_digest || input.policy_digest || null,
    expires_at: input.expires_at || input.manifest?.expires_at || null,
  }
  const digest = sha256(canonical(normalized))
  return { ...normalized, digest, approval_summary: `${normalized.executable} ${normalized.argv.join(' ')}`.trim(), digest_algorithm: 'SHA-256' }
}
export function verifyApprovalSummary(proposed, approved) {
  if (!proposed || !approved || proposed.digest !== approved.digest) return false
  const expected = approvalSummary(proposed).digest
  if (expected !== proposed.digest) return false
  const a = Buffer.from(proposed.digest), b = Buffer.from(approved.digest)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function permissionDecision(toolName, args = {}, session, options = {}) {
  if (!isChildSession(session)) return { kind: 'allow' }
  const supplied = manifestOf(session)
  const manifest = supplied || fallbackManifest(session)
  const invalid = supplied && validateCapabilityManifest(manifest, options.now)
  if (invalid) return localDeny(invalid, manifest, { field: 'capability_manifest' })
  const escalation = ESCALATION_KEYS.find((key) => Object.prototype.hasOwnProperty.call(args, key))
  if (escalation) return localDeny('escalation_forbidden', manifest, { field: escalation })
  const name = String(toolName || '').toLowerCase()
  if (['relay_dispatch', 'tool_unlock', 'update_goal', 'create_goal'].includes(name) || name.startsWith('mcp__harness_relay__')) return localDeny('role_boundary_forbidden', manifest, { tool: toolName })
  const cwd = args.workdir || args.cwd || session?.header?.cwd || rootPath(rootsOf(manifest, 'read')[0]) || process.cwd()
  if (FILE_TOOLS.has(name)) {
    const path = args.file_path || args.path
    const kind = name === 'read' ? 'read' : 'write'
    if (typeof path !== 'string' || SENSITIVE.test(path) || !rootsOf(manifest, kind).some((root) => pathWithinVerified(path, root, cwd))) {
      return localDeny(kind === 'write' ? 'path_outside_write_scope' : 'path_outside_read_scope', manifest, { operation: name, path: path || null })
    }
    return { kind: 'allow' }
  }
  if (SHELL_TOOLS.has(name)) {
    if (typeof args.command !== 'string' || !args.command.trim()) return localDeny('unparseable_command', manifest)
    if (!rootsOf(manifest, 'read').some((root) => pathWithinVerified(cwd, root, cwd))) return localDeny('cwd_outside_allowed_roots', manifest, { cwd })
    const command = normalizeCommand(args.command, cwd)
    if (command.risk === 'OUT_OF_SCOPE') return localDeny(command.reason, manifest, { operation: 'shell', ports: command.ports, processes: command.processes })
    if (command.risk === 'UNKNOWN' && command.executable === 'node' && command.argv.length === 1 && /(?:^|[\\/])(?:unit|[^\\/]+\.test)\.mjs$/i.test(command.argv[0])) {
      if (!rootsOf(manifest, 'read').some((root) => pathWithin(command.argv[0], root, cwd))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: command.argv[0] })
    }
    if (command.risk === 'UNKNOWN' && command.executable === 'node' && command.argv.length === 1 && /\.mjs$/i.test(command.argv[0]) && command.argv[0].includes('..')) {
      if (!rootsOf(manifest, 'read').some((root) => pathWithin(command.argv[0], root, cwd))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: command.argv[0] })
    }
    if (command.executable === 'node' && command.argv[0] === '--check') {
      if (command.argv.length !== 2 || !rootsOf(manifest, 'read').some((root) => pathWithinVerified(command.argv[1], root, cwd))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: command.argv[1] || null })
    }
    if (command.executable === 'node' && command.argv.length === 1 && /(?:^|[\\/])bin[\\/]bench\.mjs$/i.test(command.argv[0])) {
      if (!rootsOf(manifest, 'read').some((root) => pathWithinVerified(command.argv[0], root, cwd))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: command.argv[0] })
      else return { kind: 'allow', classification: 'SCOPED_BENCH' }
    }
    if (['get-item', 'get-childitem', 'get-filehash', 'test-path'].includes(command.executable)) {
      const paths = pathArgs(command.executable, command.argv)
      if (!paths.length || paths.some((p) => SENSITIVE.test(p) || !rootsOf(manifest, 'read').some((root) => pathWithinVerified(p, root, cwd)))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell' })
    }
    if (command.risk === 'PORT_PROBE') {
      const text = [command.executable, ...command.argv].join(' ')
      if (/(?:^|\D)3080(?:\D|$)/.test(text) || !/(?:^|\D)(?:8318|4098|4141|4142)(?:\D|$)/.test(text)) return localDeny('port_probe_not_allowed', manifest, { operation: 'shell' })
      if (command.executable === 'test-netconnection' && !/^(?:127\.0\.0\.1|localhost)$/.test(command.argv[0] || '')) return localDeny('port_probe_not_allowed', manifest, { operation: 'shell' })
    }
    if (command.risk === 'SSH_TEST') {
      if (command.argv.length !== 2 || command.argv[0] !== '100.64.0.2') return localDeny('ssh_test_not_allowed', manifest, { operation: 'shell' })
      const remote = normalizeCommand(command.argv[1], cwd), allowedCurl = remote.executable === 'curl' && remote.argv.length === 2 && remote.argv[0] === '-s' && /^http:\/\/127\.0\.0\.1:(?:8188|11434)\//.test(remote.argv[1] || '')
      const allowedTests = remote.executable === 'pytest' || remote.executable === 'python3' && remote.argv[0] === '-m' && remote.argv[1] === 'unittest' && remote.argv.length === 2
      if (!allowedCurl && !allowedTests) return localDeny('ssh_test_not_allowed', manifest, { operation: 'shell' })
    }
    if (command.risk === 'UNKNOWN') return localDeny('command_not_statically_verifiable', manifest, { operation: 'shell', classification: 'UNKNOWN', suggestion: 'use_literal_argv_or_declared_exec_profile' })
    if (command.executable === 'npm' && command.argv[0] === '--prefix') {
      if (!rootsOf(manifest, 'read').some((root) => pathWithinVerified(command.argv[1], root, cwd))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: command.argv[1] })
    }
    if (command.executable === 'node' && command.argv[0] === '--test') {
      const paths = command.argv.slice(1).filter((x) => !x.startsWith('-'))
      if (!paths.length || paths.some((p) => !/\.(?:mjs|cjs|js)$/i.test(p) || !rootsOf(manifest, 'read').some((root) => pathWithin(p, root, cwd)))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: paths.find((p) => !rootsOf(manifest, 'read').some((root) => pathWithin(p, root, cwd))) || null })
    }
    if (command.executable === 'node' && command.argv.length === 1 && /\.mjs$/i.test(command.argv[0]) && /(?:^|[\\/])(?:unit|[^\\/]+\.test)\.mjs$/i.test(command.argv[0]) && !NODE_SMOKE_SCRIPTS.has(win32.basename(command.argv[0]).toLowerCase())) {
      if (!rootsOf(manifest, 'read').some((root) => pathWithinVerified(command.argv[0], root, cwd))) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: command.argv[0] })
    }
    if (command.executable === 'node' && command.argv.length === 1 && NODE_SMOKE_SCRIPTS.has(win32.basename(command.argv[0]).toLowerCase())) {
      const script = command.argv[0]
      const approved = rootsOf(manifest, 'read').some((root) => pathWithinVerified(script, root, cwd))
      if (!approved) return localDeny('path_outside_read_scope', manifest, { operation: 'shell', path: script })
      let digest = ''
      try { digest = sha256(readFileSync(lexicalPath(script, cwd))) } catch {}
      if (!APPROVED_NODE_SMOKE_SHA256.has(digest)) return localDeny('unapproved_node_smoke_script', manifest, { operation: 'shell', path: script })
      return { kind: 'allow', classification: 'LOOPBACK_SMOKE', loopbackPorts: [...DEFAULT_LOOPBACK_PORTS] }
    }
    if (command.risk === 'SCOPED_WRITE') {
      const targets = pathArgs(command.executable, command.argv)
      if (!targets.length || targets.some((p) => SENSITIVE.test(p) || !rootsOf(manifest, 'write').some((root) => pathWithinVerified(p, root, cwd)))) return localDeny('command_path_outside_write_scope', manifest, { operation: 'shell' })
    }
    if (command.risk === 'HIGH_RISK') {
      const summary = approvalSummary({ ...command, manifest, env: options.env || {} })
      return { kind: 'deny', decision: 'HOLD_HIGH_RISK', reason: JSON.stringify({ ok: false, code: HIGH_RISK, retryable: false, escalation: 'human_approval_required', directive: 'continue_other_work', digest: summary.digest, approval_summary: summary.approval_summary, approval: summary }) }
    }
    return { kind: 'allow', classification: command.risk }
  }
  // Process, network, browser and arbitrary code tools cannot be constrained by
  // this static PEP and therefore fail closed for children.
  if (/^(?:subagent|subagent_fork|cursor_agent|claude_code|workflow|ralph|web_search|x_search|read_page|job_kill)$/.test(name) || /chrome|connector/.test(name)) return localDeny('tool_not_in_role_boundary', manifest, { tool: toolName })
  return { kind: 'allow' }
}
