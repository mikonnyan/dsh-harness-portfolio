// Live e2e: reproduce the orphaned GIT_CONFIG_COUNT git failure, then prove sanitizeGitEnvConfig
// fixes it against the real portfolio repo. Runs under `node --test` like the rest of the suite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { sanitizeGitEnvConfig } from '../lib/index.js'

const workspace = 'C:\\Users\\mikon\\Desktop\\asd\\dsh-harness-portfolio'
const runGit = (args, env) => {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out: String(out).trim() }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stderr || e.message).trim() }
  }
}

test('live: git status --short and git log -1 --oneline exit 0 under sanitized env', () => {
  console.log('inherited GIT_CONFIG_COUNT =', JSON.stringify(process.env.GIT_CONFIG_COUNT ?? null),
    'KEY_0 =', JSON.stringify(process.env.GIT_CONFIG_KEY_0 ?? null),
    'VALUE_0 =', JSON.stringify(process.env.GIT_CONFIG_VALUE_0 ?? null))
  const orphanedHere = process.env.GIT_CONFIG_COUNT !== undefined && process.env.GIT_CONFIG_KEY_0 === undefined
  if (orphanedHere) {
    const raw = runGit(['status', '--short'], process.env)
    console.log('raw git status exit =', raw.code, raw.code === 0 ? '' : `(${raw.out.split('\n')[0]})`)
    assert.notEqual(raw.code, 0, 'expected the orphaned env to still break git here')
  }
  const cleaned = sanitizeGitEnvConfig(process.env)
  if (orphanedHere) {
    assert.equal(cleaned.GIT_CONFIG_COUNT, undefined)
    assert.equal(cleaned.GIT_CONFIG_VALUE_0, undefined)
  }
  const status = runGit(['status', '--short'], cleaned)
  assert.equal(status.code, 0, `git status --short failed: ${status.out}`)
  const log = runGit(['log', '-1', '--oneline'], cleaned)
  assert.equal(log.code, 0, `git log -1 --oneline failed: ${log.out}`)
  console.log('git status --short:', status.out.split('\n').slice(0, 3).join(' | ') || '(clean)')
  console.log('git log -1 --oneline:', log.out)
})
