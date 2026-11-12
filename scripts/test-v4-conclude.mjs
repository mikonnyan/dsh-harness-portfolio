#!/usr/bin/env node
// Real Session v4 integration against @deepseek-ai/dsh@0.2.2-rc.2. Not part of npm test.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkout = process.env.DSH_CHECKOUT || 'C:\\Users\\mikon\\Desktop\\asd\\dsh-canary-env\\node_modules\\@deepseek-ai\\dsh'
const scoped = path.dirname(checkout)
const url = (file) => pathToFileURL(file).href
const { Context } = await import(url(path.join(scoped, 'cordis', 'lib', 'index.js')))
const { default: SessionStore } = await import(url(path.join(scoped, 'dsh-session', 'lib', 'index.js')))
const gate = await import(url(path.join(root, 'packages', 'dsh-tool-gate', 'lib', 'index.js')))
const compact = await import(url(path.join(root, 'packages', 'dsh-context-compact', 'lib', 'index.js')))
const relay = await import(url(path.join(root, 'packages', 'dsh-relay-dispatch', 'lib', 'index.js')))

const ctx = new Context()
const sessions = new SessionStore(ctx)
ctx.sessions = sessions
const tools = new Map()
ctx.provide('tools', { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } })
ctx.provide('commands', { register() { return () => {} } })
ctx.provide('systemPrompt', {
  section(sec) { return () => { void sec } },
  context(def) { return () => { void def } },
})
ctx.provide('tokenMeter', { measure() { return { nodes: [], surfaceTokens: 0, totalTokens: 0 } }, estimateMessage() { return 1 } })
gate.apply(ctx)
compact.apply(ctx, { takeoverNativeCompaction: false })
relay.apply(ctx, { resumeDetachedPipelines: false })
for (const name of ['tool_unlock', 'context_compact', 'relay_dispatch']) {
  assert.ok(tools.has(name), `plugin tool not mounted: ${name}`)
}

const session = sessions.create('v4-conclude', { meta: { cwd: 'C:/work/workspace' } })
assert.equal(Array.isArray(session.events), false)
assert.equal(typeof session.snapshotEvents, 'function')
assert.equal(relay.sessionEventsOf(session).length >= 0, true)

session.append('assistant/message', {
  turn: 1,
  step: 1,
  stream: [],
  message: {
    id: 'a-plain',
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    content: [{ type: 'text', text: 'plain v4 done' }],
  },
}, { surfaceOp: 'append' })
let concluded = 0
const plain = {
  agent: { phase: { turn: 1, step: 1 }, session },
  signal: new AbortController().signal,
  concludeTurn: () => { concluded++ },
}
assert.equal(relay.concludeRequested(plain).ok, true, JSON.stringify(relay.concludeRequested(plain)))
assert.equal(await relay.finishConclude(plain), '')
assert.equal(concluded, 1)

const call = session.append('tool/call', { turn: 1, step: 1, callId: 'v4-cc', name: 'context_compact', arguments: '{}' })
session.append('assistant/message', {
  turn: 1,
  step: 1,
  stream: [],
  message: {
    id: 'a-compact',
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    content: [{ type: 'text', text: 'compacting' }, { type: 'tool-call', id: 'v4-cc', name: 'context_compact', arguments: '{}' }],
  },
}, { surfaceOp: 'append' })
const waiting = relay.finishConclude(plain, [], { timeoutMs: 300, intervalMs: 5 })
await new Promise((r) => setTimeout(r, 20))
session.append('tool/result', {
  turn: 1,
  step: 1,
  message: {
    id: 'r-v4-cc',
    role: 'tool',
    toolCallId: 'v4-cc',
    source: { kind: 'tool', callId: 'v4-cc' },
    content: [{ type: 'text', text: 'committed' }],
  },
}, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
assert.equal(await waiting, '')
assert.equal(concluded, 2)
assert.equal(session.snapshotEvents().some((event) => event.type === 'tool/result' && event.data?.message?.source?.callId === 'v4-cc'), true)
console.log('v4-conclude ok')
