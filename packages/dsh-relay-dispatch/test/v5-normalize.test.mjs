import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeStartArgs, fillStartArgs, finishConclude } from '../lib/index.js'

test('sessionId strips sessionMode on follow-up shaped args and on fillStartArgs', () => {
  const resumed = normalizeStartArgs({ sessionId: 'child-1', sessionMode: 'resume', task: 'fix' }, { defaultSessionMode: 'fresh' })
  assert.equal(resumed.sessionId, 'child-1')
  assert.equal(resumed.sessionMode, undefined)
  assert.equal('sessionMode' in resumed, false)
  const fresh = normalizeStartArgs({ task: 't' }, { defaultSessionMode: 'fresh' })
  assert.equal(fresh.sessionMode, 'fresh')
  const filled = fillStartArgs({ workspace: 'W', task: 't', sessionId: 's', sessionMode: 'latest-idle' }, { defaultSessionMode: 'fresh' })
  assert.equal(filled.sessionId, 's')
  assert.equal(filled.sessionMode, undefined)
})

test('conclude is skipped when dispatch failed', async () => {
  let concluded = 0
  const exec = { agent: { phase: { turn: 1, step: 1 }, session: { events: [{ type: 'assistant/message', content: [{ type: 'text', text: 'done' }] }] } }, signal: new AbortController().signal, concludeTurn: () => concluded++ }
  assert.match(await finishConclude(exec, [], { failed: true }), /C1/)
  assert.equal(concluded, 0)
  const errored = { events: [{ type: 'assistant/message', content: [{ type: 'text', text: 'done' }] }, { type: 'tool/result', data: { name: 'pwsh', isError: true } }] }
  assert.match(await finishConclude({ ...exec, agent: { ...exec.agent, session: errored } }), /C1/)
  assert.equal(concluded, 0)
})

test('client ring drops a projection once a newer usage seq exists', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /usageSeq >= projection\.atSeq/)
  assert.match(src, /surfaceTokens \* projection\.calibration/)
})
