import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeGitEnvConfig, sanitizeProcessEnvGitConfig } from '../lib/index.js'

const withOrphaned = () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'false', PATH: 'x' })
const withIntact = () => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'a', PATH: 'x' })

test('sanitizeGitEnvConfig removes orphaned COUNT with missing KEY_0 (the scrubbedParentEnv shape)', () => {
  const out = sanitizeGitEnvConfig(withOrphaned())
  assert.equal(out.GIT_CONFIG_COUNT, undefined)
  assert.equal(out.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(out.PATH, 'x')
})

test('sanitizeGitEnvConfig keeps an intact KEY/VALUE set untouched', () => {
  const env = withIntact()
  const out = sanitizeGitEnvConfig(env)
  assert.equal(out, env)
  assert.equal(out.GIT_CONFIG_COUNT, '2')
  assert.equal(out.GIT_CONFIG_KEY_0, 'core.autocrlf')
})

test('sanitizeGitEnvConfig drops stray pairs when COUNT is missing or non-numeric', () => {
  const out = sanitizeGitEnvConfig({ GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'a', PATH: 'x' })
  assert.equal(out.GIT_CONFIG_KEY_0, undefined)
  assert.equal(out.GIT_CONFIG_VALUE_0, undefined)
  const out2 = sanitizeGitEnvConfig({ GIT_CONFIG_COUNT: 'abc', GIT_CONFIG_VALUE_0: 'false' })
  assert.equal(out2.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(out2.GIT_CONFIG_COUNT, undefined)
})

test('sanitizeGitEnvConfig drops stray pairs beyond COUNT and clears COUNT=0 pairs', () => {
  const out = sanitizeGitEnvConfig({ ...withIntact(), GIT_CONFIG_KEY_2: 'x', GIT_CONFIG_VALUE_2: 'y' })
  assert.equal(out.GIT_CONFIG_KEY_2, undefined)
  assert.equal(out.GIT_CONFIG_VALUE_2, undefined)
  assert.equal(out.GIT_CONFIG_KEY_0, 'core.autocrlf')
  const zero = sanitizeGitEnvConfig({ GIT_CONFIG_COUNT: '0', GIT_CONFIG_VALUE_0: 'false' })
  assert.equal(zero.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(zero.GIT_CONFIG_COUNT, undefined)
})

test('sanitizeProcessEnvGitConfig cleans the live process env in place and is idempotent', () => {
  const saved = { ...process.env }
  try {
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_VALUE_0 = 'false'
    delete process.env.GIT_CONFIG_KEY_0
    const before = sanitizeProcessEnvGitConfig()
    assert.equal(before, '1')
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined)
    assert.equal(process.env.GIT_CONFIG_VALUE_0, undefined)
    assert.equal(sanitizeProcessEnvGitConfig(), undefined) // idempotent on clean env
    // A complete trio on the host is still stripped: scrubbedParentEnv drops KEY_* via /KEY/i.
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
    process.env.GIT_CONFIG_VALUE_0 = 'false'
    sanitizeProcessEnvGitConfig()
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined)
    assert.equal(process.env.GIT_CONFIG_KEY_0, undefined)
    assert.equal(process.env.GIT_CONFIG_VALUE_0, undefined)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    for (const [k, v] of Object.entries(saved)) process.env[k] = v
  }
})
