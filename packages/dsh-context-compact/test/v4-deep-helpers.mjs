import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { cpSync, mkdirSync, readdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'

const OLD_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const OLD = path.join(OLD_ROOT, '@deepseek-ai')
const here = path.dirname(fileURLToPath(import.meta.url))
export const runtime = path.join(os.tmpdir(), `dsh-deep-v4-runtime-${process.pid}`)
const scoped = path.join(runtime, 'node_modules', '@deepseek-ai')
rmSync(runtime, { recursive: true, force: true })
mkdirSync(scoped, { recursive: true })
for (const name of readdirSync(OLD)) {
  if (name.startsWith('dsh-')) cpSync(path.join(OLD, name), path.join(scoped, name), { recursive: true })
}
const brandDir = path.join(scoped, 'dsh-brand'); mkdirSync(brandDir, { recursive: true })
writeFileSync(path.join(brandDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-brand', type: 'module', exports: './index.js' }))
writeFileSync(path.join(brandDir, 'index.js'), `export const brandNumber = (x) => x; export const brandString = (x) => x`)
const llmDir = path.join(scoped, 'dsh-llm'); mkdirSync(path.join(llmDir, 'lib'), { recursive: true })
writeFileSync(path.join(llmDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', exports: './lib/index.js' }))
writeFileSync(path.join(llmDir, 'lib', 'index.js'), `import { randomUUID } from 'node:crypto'\nexport function CallId(id) { return id }\nexport function MessageId(id) { return id }\nexport function assertNever(x) { throw new Error('unexpected ' + x) }\nexport function deepFreeze(x) { return x }\nexport class BlockAssembler { constructor() {} push() { return null } get() { return null } }\nexport function freezeMessage(m) { return m }\nexport function createUserMessage(m) { return { ...m, id: randomUUID(), role: 'user' } }\nexport function createSystemMessage(text) { return { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } }\nexport function assembleAssistantStream() { return null }\nexport function lastAssistantStreamChunk() { return null }\nexport function callConfigEquals(a,b) { return JSON.stringify(a) === JSON.stringify(b) }`)
for (const name of readdirSync(OLD)) {
  if (name === 'dsh-util-values' || name === 'dsh-util-crypto' || name === 'dsh-session' || name === 'dsh-token-meter' || name === 'dsh-llm') continue
  const dest = path.join(scoped, name)
  try { symlinkSync(path.join(OLD, name), dest, 'junction') } catch (err) { if (err.code !== 'EEXIST') throw err }
}
const utilDir = path.join(scoped, 'dsh-util-values'); mkdirSync(utilDir, { recursive: true })
writeFileSync(path.join(utilDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-util-values', type: 'module', exports: './index.js' }))
const cryptoDir = path.join(scoped, 'dsh-util-crypto'); mkdirSync(path.join(cryptoDir, 'lib'), { recursive: true })
writeFileSync(path.join(cryptoDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-util-crypto', type: 'module', exports: './index.js' }))
writeFileSync(path.join(cryptoDir, 'index.js'), `export { randomUUID } from 'node:crypto'`)
writeFileSync(path.join(utilDir, 'index.js'), `export function assertNever(x) { throw new Error('unexpected '+x) }\nexport function snapshotJsonValue(x) { return x === undefined ? undefined : structuredClone(x) }\nexport function deepEqualJson(a,b) { return JSON.stringify(a) === JSON.stringify(b) }\nexport function deepFreeze(x, seen = new WeakSet()) { if (!x || typeof x !== 'object' || seen.has(x)) return x; seen.add(x); Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v, seen); return x }`)
symlinkSync(path.join(OLD_ROOT, 'zod'), path.join(runtime, 'node_modules', 'zod'), 'junction')
symlinkSync(OLD, path.join(runtime, 'node_modules', '.old-deepseek'), 'junction')
export const url = (p) => pathToFileURL(p).href
export const { Context } = await import(url(path.join(OLD, 'cordis', 'lib', 'index.js')))
export const { default: SessionStore } = await import(url(path.join(scoped, 'dsh-session', 'lib', 'index.js')))
const { estimateMessage } = await import(url(path.join(scoped, 'dsh-token-meter', 'lib', 'types', 'estimate.js')))
export class TokenMeter {
  estimateMessage(message) { return estimateMessage(message) }
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => {
      const ev = typeof session.eventAt === 'function' ? session.eventAt(seq) : session.events[seq]
      const tokens = estimateMessage(session.deriveEventMessage(ev))
      return { seq, tokens, heuristicTokens: tokens }
    })
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
    return { nodes, surfaceTokens, totalTokens: surfaceTokens }
  }
}
export async function harness(withCompact = false) {
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  const tokenMeter = new TokenMeter(ctx)
  ctx.sessions = sessions; ctx.tokenMeter = tokenMeter
  const registeredTools = new Map(), promptContexts = new Map(), promptSections = new Map()
  ctx.provide('tools', { register(def) { registeredTools.set(def.name, def); return () => registeredTools.delete(def.name) } })
  ctx.provide('systemPrompt', {
    section(sec) { promptSections.set(sec.name, sec); return () => promptSections.delete(sec.name) },
    context(def) { promptContexts.set(def.name, def); return () => promptContexts.delete(def.name) },
  })
  if (withCompact) (await import('../lib/index.js')).apply(ctx)
  return { ctx, sessions, tokenMeter, registeredTools, promptContexts, promptSections }
}
export function makeSession(sessions, id = `deep-${Math.random()}`) {
  const s = sessions.create(id, { meta: { cwd: 'C:/work/workspace' } })
  s.append('system/message', { message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'immutable system' }] } })
  return s
}
export function turn(s, n, marker, { calls = 1, bytes = 6000, omitResult = false } = {}) {
  s.append('turn/start', { turn: n }); s.append('step/start', { turn: n, step: 1 })
  if (n === 1) {
    s.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' })
    s.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 200000 })
  }
  s.append('user/message', { id: `u-${n}`, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: `${marker} user ${'u'.repeat(bytes)}` }] }, { surfaceOp: 'append' })
  const ids = []
  for (let k = 0; k < calls; k++) {
    const id = `call-${n}-${k}`; ids.push(id)
    s.append('assistant/message', { turn: n, step: 1, stream: [], message: { id: `a-${n}-${k}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: `invoke ${id}` }, { type: 'tool-call', id, name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' })
    const call = s.append('tool/call', { turn: n, step: 1, callId: id, name: 'read', arguments: '{}' })
    if (!omitResult || k < calls - 1) s.append('tool/result', { turn: n, step: 1, stream: [], message: { id: `r-${n}-${k}`, role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, content: [{ type: 'text', text: `${marker} original ${k} ${'x'.repeat(bytes)}` }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  s.append('step/end', { turn: n, step: 1 }); s.append('turn/end', { turn: n, reason: { kind: 'completed' } })
  return ids
}
export function cleanup() { rmSync(runtime, { recursive: true, force: true }) }
