import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifySession } from '../lib/session-archetype.js'
import { DEFAULT_CONFIG, loadConfig } from '../lib/index.js'

const parent = { header: { id: 'parent', provider: 'google-vertex', model: 'gemini-4-argon' }, events: [] }
const getSession = (id) => id === 'parent' ? parent : null
const forkDescriptor = (agentProvider, agentModel) => ({
  type: 'subagent/descriptor',
  data: { version: 2, mode: 'one-shot', provider: 'fork', ...(agentProvider ? { agentProvider } : {}), ...(agentModel ? { agentModel } : {}) },
})

test('same-model subagent_fork is WORKER_FORK', () => {
  const child = {
    header: { id: 'same', parentSession: 'parent', provider: 'google-vertex', model: 'gemini-4-argon' },
    events: [forkDescriptor('google-vertex', 'gemini-4-argon')],
  }
  assert.equal(classifySession(child, null, { getSession }).archetype, 'WORKER_FORK')
  const seeded = {
    header: { id: 'seeded', parentSession: 'parent', seedLength: 1, provider: 'google-vertex', model: 'gemini-4-argon' },
    events: [{ type: 'request/header', data: { header: { config: { provider: 'google-vertex', model: 'gemini-4-argon' } } } }],
  }
  assert.equal(classifySession(seeded, null, {}).archetype, 'WORKER_FORK')
})

test('cross-model subagent_fork is WORKER_FRESH', () => {
  const grok = {
    header: { id: 'grok', parentSession: 'parent' },
    events: [forkDescriptor('cursor', 'grok-4.7-fast')],
  }
  assert.equal(classifySession(grok, null, { getSession }).archetype, 'WORKER_FRESH')
  const kimi = {
    header: { id: 'kimi', parentSession: 'parent', seedLength: 1, provider: 'kimi', model: 'kimi-k2' },
    events: [{ type: 'request/context', data: { provider: 'google-vertex', model: 'gemini-4-argon' } }, forkDescriptor('kimi', 'kimi-k2')],
  }
  assert.equal(classifySession(kimi, null, {}).archetype, 'WORKER_FRESH')
  const blank = {
    header: { id: 'blank', parentSession: 'parent', seedLength: 2 },
    events: [forkDescriptor('cursor', '')],
  }
  assert.equal(classifySession(blank, null, { getSession }).archetype, 'WORKER_FRESH')
})

test('R2 deep: missing/unknown metadata always degrades to WORKER_FRESH', () => {
  const variants = [
    { child: { header: { id: 'missing-both', parentSession: 'missing' }, events: [forkDescriptor()] }, deps: { getSession: () => null } },
    { child: { header: { id: 'missing-parent', parentSession: 'parent' }, events: [forkDescriptor('google-vertex', 'gemini-4-argon')] }, deps: { getSession: () => null } },
    { child: { header: { id: 'partial-child', parentSession: 'parent', provider: 'google-vertex' }, events: [forkDescriptor('google-vertex')] }, deps: { getSession } },
    { child: { header: { id: 'partial-parent', parentSession: 'parent', provider: 'google-vertex', model: 'gemini-4-argon' }, events: [forkDescriptor()] }, deps: { getSession: () => ({ header: { id: 'parent', provider: 'google-vertex' }, events: [] }) } },
  ]
  for (const { child, deps } of variants) assert.equal(classifySession(child, null, deps).archetype, 'WORKER_FRESH', child.header.id)
})

test('R2 deep: cross-provider identical model and same-provider different tiers stay fresh', () => {
  const crossProvider = { header: { id: 'cross-provider', parentSession: 'parent' }, events: [forkDescriptor('kimi', 'gemini-4-argon')] }
  assert.equal(classifySession(crossProvider, null, { getSession }).archetype, 'WORKER_FRESH')
  const tierParent = { header: { id: 'tier-parent', provider: 'kimi', model: 'kimi-k3.1-pro' }, events: [] }
  const differentTier = { header: { id: 'different-tier', parentSession: 'tier-parent' }, events: [forkDescriptor('kimi', 'glm-5.3')] }
  assert.equal(classifySession(differentTier, null, { getSession: (id) => id === 'tier-parent' ? tierParent : null }).archetype, 'WORKER_FRESH')
})

test('R2 deep: request/context, request/header, explicit header and live ctx route extraction', () => {
  const make = (id, event) => ({ header: { id, parentSession: 'parent', seedLength: 1 }, events: [event] })
  const cases = [
    make('request-context', { type: 'request/context', data: { provider: 'google-vertex', model: 'gemini-4-argon' } }),
    make('request-header-config', { type: 'request/header', data: { header: { config: { provider: 'google-vertex', model: 'gemini-4-argon' } } } }),
    make('request-header-direct', { type: 'request/header', data: { provider: 'google-vertex', model: 'gemini-4-argon' } }),
    make('explicit-header', forkDescriptor('google-vertex', 'gemini-4-argon')),
  ]
  cases[3].header.provider = 'google-vertex'; cases[3].header.model = 'gemini-4-argon'
  for (const child of cases) assert.equal(classifySession(child, null, {}).archetype, 'WORKER_FORK', child.header.id)
  const routed = { header: { id: 'live-route', parentSession: 'parent' }, events: [forkDescriptor()] }
  assert.equal(classifySession(routed, null, { route: { provider: 'google-vertex', model: 'gemini-4-argon' }, getSession }).archetype, 'WORKER_FORK')
})

test('promptGovernanceV2 defaults on and explicit false still wins', () => {
  assert.equal(DEFAULT_CONFIG.promptGovernanceV2, true)
  const dir = mkdtempSync(join(tmpdir(), 'tool-gate-r1-cfg-'))
  const file = join(dir, 'config.json')
  try {
    assert.equal(loadConfig(join(dir, 'missing.json')).promptGovernanceV2, true)
    writeFileSync(file, JSON.stringify({ promptGovernanceV2: false, compactSchema: true }))
    assert.equal(loadConfig(file).promptGovernanceV2, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
