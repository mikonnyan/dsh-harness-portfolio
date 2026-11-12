import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileCapabilityManifest } from '../../dsh-relay-dispatch/lib/index.js'
import { normalizeCommand, permissionDecision, DEFAULT_LOOPBACK_PORTS, isAllowedLoopbackUrl } from '../lib/index.js'

const work = mkdtempSync(join(tmpdir(), 'loopback-probe-'))
const NOW = Date.now()
const manifest = compileCapabilityManifest(
  { workspace: work, contextReadScope: [work], writeScope: [work], permissionPreset: 'workspace-write' },
  { taskId: 'loopback-probe', parentSession: 'parent', now: NOW },
)
const session = { header: { id: 'child', parentSession: 'parent', cwd: work, capabilityManifest: manifest } }
const decide = (command) => permissionDecision('pwsh', { command, workdir: work }, session, { now: NOW + 1 })

test('default loopback ports include 4142 and still name 3080', () => {
  assert.deepEqual(DEFAULT_LOOPBACK_PORTS, [3080, 4098, 4141, 4142, 8318])
  assert.equal(isAllowedLoopbackUrl('http://127.0.0.1:4142/health'), true)
  assert.equal(isAllowedLoopbackUrl('http://[::1]:8318/status'), true)
  assert.equal(isAllowedLoopbackUrl('http://127.0.0.1:3080/status'), true)
})

test('read-only loopback HTTP GET probes are allowed', () => {
  const allow = [
    'curl -s http://127.0.0.1:8318/status',
    'curl.exe -ks --max-time 5 http://127.0.0.1:4142/health',
    'curl -s -i http://localhost:4098/v1',
    'curl -X GET http://127.0.0.1:4141/status',
    'curl -s http://[::1]:8318/status',
    'Invoke-RestMethod -Uri http://127.0.0.1:8318/status -Method Get -TimeoutSec 5',
    'irm -Uri http://127.0.0.1:4142/health',
    'Invoke-WebRequest http://127.0.0.1:4098/v1 -Method GET',
    'iwr -Uri http://127.0.0.1:4141/status -UseBasicParsing',
  ]
  for (const command of allow) {
    assert.equal(normalizeCommand(command, work).risk, 'PORT_PROBE', command)
    assert.equal(decide(command).kind, 'allow', command)
  }
})

test('mutating, off-loopback, and port 3080 HTTP probes are denied', () => {
  const deny = [
    'curl -X POST http://127.0.0.1:8318/status',
    'curl -X PUT http://127.0.0.1:8318/status',
    'curl -X DELETE http://127.0.0.1:4142/status',
    'curl -d {} http://127.0.0.1:8318/status',
    'curl --data foo http://127.0.0.1:8318/status',
    'curl -o out.txt http://127.0.0.1:8318/status',
    'curl -s http://127.0.0.1:3080/status',
    'curl -s http://127.0.0.1:4099/status',
    'curl -s https://127.0.0.1:8318/status',
    'Invoke-RestMethod -Uri http://127.0.0.1:8318/status -Method Post',
    'irm -Uri http://127.0.0.1:8318/status -Body hi',
    'iwr -Uri http://127.0.0.1:8318/status -OutFile out.txt',
    'Invoke-WebRequest -Uri http://example.com:8318/status',
  ]
  for (const command of deny) assert.equal(decide(command).kind, 'deny', command)
})
