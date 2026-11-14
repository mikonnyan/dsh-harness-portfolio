import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCapabilityManifest } from '../../dsh-relay-dispatch/lib/index.js'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = mkdtempSync(join(tmpdir(), 'perm-gate-'))
const work = join(fixture, 'app'), src = join(fixture, 'app', 'src')
mkdirSync(src, { recursive: true })
import { apply, permissionDecision, validateCapabilityManifest, verifyApprovalSummary, OUT_OF_SCOPE, HIGH_RISK, lexicalPath, pathWithin, DEFAULT_LOOPBACK_PORTS, isAllowedLoopbackUrl } from '../lib/index.js'

const NOW = Date.now()
const baseArgs = { workspace: work, contextReadScope: [work], writeScope: [src], permissionPreset: 'workspace-write', agentPreset: 'standard-lean' }
const manifest = (extra = {}) => compileCapabilityManifest(baseArgs, { taskId: 'task-fixed', parentSession: 'parent', now: NOW, ...extra })
const session = (m = manifest()) => ({ header: { id: 'child', parentSession: 'parent', cwd: work, capabilityManifest: m }, events: [] })
const deny = (name, args, m) => {
  const d = permissionDecision(name, args, session(m), { now: NOW + 1000 })
  assert.equal(d.kind, 'deny'); assert.equal(d.error.code, OUT_OF_SCOPE)
  assert.equal(d.error.retryable, false); assert.equal(d.error.escalation, 'forbidden'); assert.equal(d.error.directive, 'skip_and_continue')
  assert.ok(d.allowed_hint || d.error.allowed_hint); return d
}

test('compiler emits static immutable roots, host protections and role boundaries', () => {
  const m = manifest()
  assert.equal(m.schema_version, 'capability/v1'); assert.equal(m.task_id, 'task-fixed')
  assert.deepEqual(m.forbidden_ports, [3080]); assert.deepEqual(m.loopback_ports, [3080, 4098, 4141, 8318]); assert.equal(m.escalation, 'forbidden')
  assert.equal(m.role_boundaries.may_write, true); assert.equal(m.role_boundaries.may_dispatch, false)
  assert.equal(m.write_scope[0], src); assert.match(m.policy_digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(validateCapabilityManifest(m, NOW + 1), null); assert.ok(Object.isFrozen(m))
  assert.equal(compileCapabilityManifest({ ...baseArgs, permissionPreset: 'read-only' }, { taskId: 'r', now: NOW }).write_roots.length, 0)
})

test('manifest expiry and any signed-field mutation fail closed', () => {
  assert.equal(validateCapabilityManifest(manifest(), NOW + 241 * 60000), 'manifest_expired')
  const tampered = { ...manifest(), write_scope: ['C:\\'] }
  assert.equal(validateCapabilityManifest(tampered, NOW + 1), 'policy_digest_mismatch')
  deny('read', { file_path: 'C:\\work\\app\\a.txt' }, tampered)
})

test('write and read boundaries are path-segment aware; parent, sibling, ADS and devices rejected', () => {
  assert.equal(permissionDecision('write', { file_path: join(src, 'ok.js') }, session(), { now: NOW + 1 }).kind, 'allow')
  assert.equal(deny('write', { file_path: join(src, '..', 'outside.txt') }).error.reason, 'path_outside_write_scope')
  deny('write', { file_path: src + '-evil\\x' }); deny('read', { file_path: 'D:\\other' })
  deny('write', { file_path: join(src, 'x.txt:secret') }); deny('read', { file_path: join(work, 'NUL') })
  deny('read', { file_path: join(work, 'secrets', 'key') }); deny('read', { file_path: join(work, '.env') })
  assert.equal(lexicalPath('C:relative'), null); assert.equal(pathWithin('C:\\root2', 'C:\\root'), false)
})

test('junction escape and protected host restart are denied', () => {
  const outside = mkdtempSync(join(tmpdir(), 'perm-outside-'))
  const junction = join(work, 'escape')
  symlinkSync(outside, junction, 'junction')
  assert.equal(deny('read', { file_path: join(junction, 'secret.txt') }).error.reason, 'path_outside_read_scope')
  assert.equal(deny('pwsh', { command: 'Restart-Service dsh' }).error.reason, 'protected_host_process')
  assert.equal(deny('pwsh', { command: 'Stop-Process -Name dsh' }).error.reason, 'protected_host_process')
})

test('legacy parent-only children are conservative read-only; parent sessions unchanged', () => {
  const old = { header: { parentSession: 'p', cwd: work } }
  assert.equal(permissionDecision('read', { file_path: join(work, 'a') }, old).kind, 'allow')
  assert.equal(permissionDecision('write', { file_path: join(work, 'a') }, old).error.code, OUT_OF_SCOPE)
  assert.equal(permissionDecision('pwsh', { command: `Remove-Item ${join(work, 'a')}` }, { header: { id: 'parent' } }).kind, 'allow')
})

test('protected ports and host process operations deny without approval', () => {
  for (const command of ['Test-NetConnection 127.0.0.1 -Port 3080', 'curl http://localhost:4099/health', 'Stop-Process -Name kimi-bridge']) {
    assert.equal(permissionDecision('pwsh', { command }, session(), { now: NOW + 1 }).kind, 'deny')
  }
  assert.equal(deny('pwsh', { command: 'Get-Content C:\\work\\app\\ok', sandbox_permissions: 'danger-full-access' }).error.field, 'sandbox_permissions')
  deny('relay_dispatch', {})
})

test('approved loopback gateways and pinned node smoke pass; other ports and arbitrary scripts deny', async () => {
  assert.deepEqual(DEFAULT_LOOPBACK_PORTS, [3080, 4098, 4141, 4142, 8318])
  for (const port of [4098, 4141, 4142, 8318]) assert.equal(isAllowedLoopbackUrl(`http://127.0.0.1:${port}/v1/chat/completions`), true)
  for (const url of ['http://127.0.0.1:4099/v1', 'http://example.com:4098/v1', 'https://127.0.0.1:4141/v1']) assert.equal(isAllowedLoopbackUrl(url), false)
  const { copyFileSync } = await import('node:fs')
  const smoke = join(work, 'live-gateway-smoke.mjs')
  copyFileSync(new URL('../../dsh-context-compact/test/live-gateway-smoke.mjs', import.meta.url), smoke)
  const decision = permissionDecision('pwsh', { command: `node ${smoke}`, workdir: work }, session(), { now: NOW + 1 })
  assert.equal(decision.kind, 'allow'); assert.equal(decision.classification, 'LOOPBACK_SMOKE')
  assert.equal(permissionDecision('pwsh', { command: `node ${join(work, 'other.mjs')}` }, session(), { now: NOW + 1 }).error.reason, 'command_not_statically_verifiable')
  const bench = join(work, 'grok-effort-bench.js')
  const benchSrc = new URL('../../kimi-bridge/grok-effort-bench.js', import.meta.url)
  const benchFallback = new URL('../kimi-bridge/grok-effort-bench.js', import.meta.url)
  copyFileSync(existsSync(benchSrc) ? benchSrc : benchFallback, bench)
  const benchDecision = permissionDecision('pwsh', { command: `node ${bench}`, workdir: work }, session(), { now: NOW + 1 })
  assert.equal(benchDecision.kind, 'allow'); assert.equal(benchDecision.classification, 'SCOPED_EFFORT_BENCH')
  writeFileSync(bench, 'console.log(1)\n')
  assert.equal(permissionDecision('pwsh', { command: `node ${bench}`, workdir: work }, session(), { now: NOW + 1 }).error.reason, 'unapproved_node_effort_bench')
  assert.equal(deny('pwsh', { command: 'node -e "fetch(\'http://127.0.0.1:4099\')"' }).error.reason, 'command_not_statically_verifiable')
  assert.equal(deny('pwsh', { command: 'curl http://127.0.0.1:4099/v1' }).error.reason, 'command_not_statically_verifiable')
})

test('standard npm and node test commands pass inside allowed roots only', () => {
  mkdirSync(join(work, 'test'), { recursive: true })
  writeFileSync(join(work, 'test', 'unit.mjs'), '')
  for (const command of ['npm test', `npm --prefix ${work} test`, 'node --test test/unit.mjs', 'node test/unit.mjs']) {
    assert.equal(permissionDecision('pwsh', { command, workdir: work }, session(), { now: NOW + 1 }).kind, 'allow', command)
  }
  assert.equal(deny('pwsh', { command: 'npm --prefix C:\\outside test', workdir: work }).error.reason, 'path_outside_read_scope')
  assert.equal(deny('pwsh', { command: 'node test/../../outside.mjs', workdir: work }).error.reason, 'path_outside_read_scope')
  assert.equal(deny('pwsh', { command: 'node arbitrary.mjs', workdir: work }).error.reason, 'command_not_statically_verifiable')
})

test('review and Gate manifests allow read-only test commands within read roots', () => {
  for (const role of ['reviewer', 'investigator']) {
    const m = compileCapabilityManifest({ ...baseArgs, permissionPreset: 'read-only' }, { taskId: `gate-${role}`, parentSession: 'parent', role, now: NOW })
    for (const command of ['npm test', `npm --prefix ${work} test`, `node ${join(work, 'test', 'unit.mjs')}`]) {
      assert.equal(permissionDecision('pwsh', { command, workdir: work }, session(m), { now: NOW + 1 }).kind, 'allow', `${role}: ${command}`)
    }
    assert.equal(permissionDecision('pwsh', { command: `node ${join(work, 'test', 'unit.mjs')}`, workdir: 'C:\\outside' }, session(m), { now: NOW + 1 }).error.reason, 'cwd_outside_allowed_roots')
    assert.equal(permissionDecision('pwsh', { command: 'npm --prefix C:\\outside test', workdir: work }, session(m), { now: NOW + 1 }).error.reason, 'path_outside_read_scope')
  }
})

test('literal reads and scoped writes allowed; dynamic/unknown/wildcards denied locally', () => {
  assert.equal(permissionDecision('pwsh', { command: `Get-Content ${join(src, 'a.txt')}` }, session(), { now: NOW + 1 }).kind, 'allow')
  assert.equal(permissionDecision('pwsh', { command: `Set-Content ${join(src, 'a.txt')} ok`, workdir: work }, session(), { now: NOW + 1 }).kind, 'allow')
  for (const command of [`Set-Content ${join(work, 'outside')} x`, `Remove-Item ${join(src, '*')}`, 'Invoke-Expression $cmd', 'pwsh -EncodedCommand !!!', 'Set-Content $path x', 'node -e "process.exit(0)"']) deny('pwsh', { command })
})

test('worker scoped check, bench and metadata commands are allowed', () => {
  mkdirSync(join(work, 'bin'), { recursive: true }); writeFileSync(join(work, 'bin', 'bench.mjs'), '')
  for (const command of ['npm run check', 'npm run bench', `node --check ${join(work, 'bin', 'bench.mjs')}`, `node ${join(work, 'bin', 'bench.mjs')}`]) assert.equal(permissionDecision('pwsh', { command, workdir: work }, session(), { now: NOW + 1 }).kind, 'allow', command)
  for (const executable of ['Get-Item', 'Get-ChildItem', 'Get-FileHash', 'Test-Path']) assert.equal(permissionDecision('pwsh', { command: `${executable} ${work}`, workdir: work }, session(), { now: NOW + 1 }).kind, 'allow', executable)
  assert.equal(permissionDecision('pwsh', { command: 'npm run build', workdir: work }, session(), { now: NOW + 1 }).kind, 'deny')
  assert.equal(permissionDecision('pwsh', { command: 'Get-Item C:\\outside', workdir: work }, session(), { now: NOW + 1 }).kind, 'deny')
})
test('only literal read-only loopback probes and approved remote tests pass', () => {
  for (const command of ['Get-NetTCPConnection -LocalPort 8318', 'Get-NetTCPConnection -LocalPort 4098', 'Get-NetTCPConnection -LocalPort 4142', 'Test-NetConnection 127.0.0.1 -Port 4141']) assert.equal(permissionDecision('pwsh', { command, workdir: work }, session(), { now: NOW + 1 }).kind, 'allow', command)
  for (const command of ['Get-NetTCPConnection -LocalPort 3080', 'Test-NetConnection example.com -Port 8318', 'ssh 100.64.0.2 "pytest"', 'ssh 100.64.0.2 "python3 -m unittest"', 'ssh 100.64.0.2 "curl -s http://127.0.0.1:8188/api"', 'ssh 100.64.0.2 "curl -s http://127.0.0.1:11434/api/tags"']) {
    const actual = permissionDecision('pwsh', { command, workdir: work }, session(), { now: NOW + 1 }).kind
    assert.equal(actual, command.includes('3080') || command.includes('example.com') ? 'deny' : 'allow', command)
  }
  for (const command of ['ssh 100.64.0.2 "rm x"', 'ssh example.com "pytest"', 'ssh 100.64.0.2 "kill 1"']) assert.equal(permissionDecision('pwsh', { command, workdir: work }, session(), { now: NOW + 1 }).kind, 'deny', command)
})

test('read-only git subcommands are SAFE_READ in write and read-only sessions', () => {
  const ro = session(compileCapabilityManifest({ ...baseArgs, permissionPreset: 'read-only' }, { taskId: 'ro-git', parentSession: 'parent', now: NOW }))
  for (const command of ['git status', 'git diff', 'git log --oneline -5', 'git show HEAD', 'git rev-parse --git-dir', 'git branch', 'git remote', 'git ls-files', 'git describe --tags', 'git tag', 'git --version', 'git version', 'git -C . status', 'git --no-pager log -1', 'git branch --list']) {
    assert.equal(permissionDecision('pwsh', { command, workdir: work }, session(), { now: NOW + 1 }).kind, 'allow', command)
    assert.equal(permissionDecision('pwsh', { command, workdir: work }, ro, { now: NOW + 1 }).kind, 'allow', `ro: ${command}`)
  }
})

test('read-only sessions deny git add/commit/push', () => {
  const roM = compileCapabilityManifest({ ...baseArgs, permissionPreset: 'read-only' }, { taskId: 'ro-git2', parentSession: 'parent', now: NOW })
  for (const command of ['git add -A', 'git commit -m "x"', 'git push origin main']) {
    assert.equal(deny('pwsh', { command, workdir: src }, roM).error.reason, 'command_path_outside_write_scope', command)
  }
})

test('write sessions allow git add/commit/push within write roots as SCOPED_WRITE', () => {
  for (const command of ['git add -A', 'git commit -m "feat: x"', 'git push origin main', 'git rm --cached x', 'git mv a b', 'git stash']) {
    const d = permissionDecision('pwsh', { command, workdir: src }, session(), { now: NOW + 1 })
    assert.equal(d.kind, 'allow', command)
    assert.equal(d.classification, 'SCOPED_WRITE', command)
  }
})

test('git force and rewrite variants are HOLD_HIGH_RISK', () => {
  for (const command of ['git push --force origin main', 'git push -f origin main', 'git reset --hard HEAD~1', 'git clean -fd']) {
    const d = permissionDecision('pwsh', { command, workdir: src }, session(), { now: NOW + 1 })
    assert.equal(d.kind, 'deny', command)
    assert.equal(d.decision, 'HOLD_HIGH_RISK', command)
  }
})

test('git writes outside write roots and unknown git subcommands deny', () => {
  assert.equal(deny('pwsh', { command: 'git add -A', workdir: work }).error.reason, 'command_path_outside_write_scope')
  assert.equal(deny('pwsh', { command: 'git notes add -m x', workdir: src }).error.reason, 'command_not_statically_verifiable')
})

test('high-risk approval digest is canonical and detects argv/cwd/task tampering', () => {
  const d = permissionDecision('pwsh', { command: `Remove-Item ${join(src, 'a.txt')}` }, session(), { now: NOW + 1 })
  assert.equal(d.kind, 'deny'); assert.equal(d.decision, 'HOLD_HIGH_RISK')
  const approval = JSON.parse(d.reason); assert.equal(approval.code, HIGH_RISK); assert.match(approval.digest, /^[a-f0-9]{64}$/)
  assert.equal(verifyApprovalSummary(approval.approval, { digest: approval.digest }), true)
  for (const change of [{ argv: ['C:\\Windows'] }, { cwd: 'C:\\' }, { task_id: 'other' }]) {
    const changed = { ...approval.approval, ...change }
    assert.equal(verifyApprovalSummary(changed, { digest: approval.digest }), false)
  }
  assert.equal(verifyApprovalSummary(approval.approval, { digest: '0'.repeat(64) }), false)
})

test('hook denies before upstream ask and never wakes parent; allowed calls still compose', async () => {
  let tool, hook, asks = 0
  const ctx = {
    effect: (fn) => fn(), tools: { register: (t) => { tool = t } }, commands: { register: () => {} },
    on: (name, fn) => { if (name === 'tools/pre-execute') hook = fn },
    logger: () => ({ info: () => {} }),
  }
  apply(ctx)
  assert.ok(tool)
  const exec = { name: 'write', arguments: { file_path: 'D:\\bad' }, agent: { session: session() } }
  const d = await hook(exec, async () => { asks++; return { kind: 'ask', reason: 'popup' } })
  assert.equal(d.kind, 'deny'); assert.equal(asks, 0); assert.equal(JSON.parse(d.reason).code, OUT_OF_SCOPE)
  const ok = await hook({ ...exec, arguments: { file_path: join(src, 'ok') } }, async () => ({ kind: 'allow' }))
  assert.equal(ok.kind, 'allow')
})
