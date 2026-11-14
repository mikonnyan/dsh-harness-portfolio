import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fillStartArgs, preflightFollowUp } from '../lib/index.js'

const previous = {
  phase: 'completed', machineHeader: 'RESULT: FAIL', parentSessionId: 'parent',
  items: [{ index: 0, kind: 'task', status: 'failed', sessionId: 'child', error: 'failed' }],
  plan: { tasks: [{ index: 0, dependsOn: [], workspace: 'C:\\work', baseArgs: { workspace: 'C:\\work', task: 'old', sessionMode: 'fresh' }, previewArgs: { workspace: 'C:\\work', task: 'old', sessionMode: 'fresh' } }], gate: { checks: [], llm: 'never' } },
}

function followUp(items = previous.items) {
  const manifestDir = mkdtempSync(join(tmpdir(), 'followup-session-'))
  writeFileSync(join(manifestDir, 'p-fail.json'), JSON.stringify({ ...previous, items }))
  return preflightFollowUp({ pipelineId: 'p-fail', patchTask: 'repair' }, { manifestDir, currentSessionId: 'parent' }).tasks[0]
}

test('followUp reuses sessionId without sessionMode in baseArgs and previewArgs', () => {
  const task = followUp()
  assert.equal(task.baseArgs.sessionId, 'child')
  assert.equal(task.baseArgs.sessionMode, undefined)
  assert.equal(task.previewArgs.sessionId, 'child')
  assert.equal(task.previewArgs.sessionMode, undefined)
})

test('followUp without sessionId uses fresh mode', () => {
  const task = followUp([{ index: 0, kind: 'task', status: 'failed', error: 'failed' }])
  assert.equal(task.baseArgs.sessionId, undefined)
  assert.equal(task.baseArgs.sessionMode, 'fresh')
  assert.equal(task.previewArgs.sessionId, undefined)
  assert.equal(task.previewArgs.sessionMode, 'fresh')
})

test('fillStartArgs enforces Harness session parameter exclusivity', () => {
  const resumed = fillStartArgs({ sessionId: 'child', sessionMode: 'latest-idle' })
  assert.equal(resumed.sessionId, 'child')
  assert.equal(resumed.sessionMode, undefined)
  assert.equal(fillStartArgs({}).sessionMode, 'fresh')
})
