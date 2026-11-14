import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { harness, makeSession, turn, cleanup } from '../../dsh-context-compact/test/v4-deep-helpers.mjs'
import * as compact from '../../dsh-context-compact/lib/index.js'
import * as gate from '../lib/index.js'
const OLD=path.join(os.homedir(),'AppData','Roaming','npm','node_modules','@deepseek-ai','dsh','node_modules','@deepseek-ai')
const {Context}=await import(pathToFileURL(path.join(OLD,'cordis','lib','index.js')).href)
const {default:SessionStore}=await import(pathToFileURL(path.join(OLD,'dsh-session','lib','index.js')).href)
const {TokenMeter}=await import(pathToFileURL(path.join(OLD,'dsh-token-meter','lib','index.js')).href)
test.after(cleanup)
const NOW=1_700_000_000_000
const catalog=['read','dev_reload_package','dev_mode_set','tool_unlock'].map(name=>({name}))
async function assembledTools(ctx,catalog,agent){
  ctx.on('system-prompt/assemble',async(_a,_c,next)=>next())
  return (await ctx.serial('system-prompt/assemble',{}, {agent}, async()=>({tools:catalog,contexts:[]}))).tools
}
function toolsFor(s,cfg=gate.DEFAULT_CONFIG){return gate.filterTools(catalog,s,cfg,{},NOW)}
function activity(s,n,time=NOW){s.append('turn/start',{turn:n});s.append('step/start',{turn:n,step:1});s.append('assistant/message',{turn:n,step:1,stream:[],time,message:{id:`act-${n}`,role:'assistant',source:{kind:'model',provider:'x',model:'y'},content:[{type:'text',text:'activity'}]}}, {surfaceOp:'append'});s.append('step/end',{turn:n,step:1});s.append('turn/end',{turn:n,reason:{kind:'completed'}})}
function unlock(s,n=1){s.append('turn/start',{turn:n});s.append('tool/call',{turn:n,name:'tool_unlock',arguments:JSON.stringify({groups:['dev'],action:'on'})});s.append('turn/end',{turn:n,reason:{kind:'completed'}})}
function commands(ctx){ctx.provide('commands',{register(){return()=>{}}})}

test('same-process real plugins + v4 SessionStore: append-only keeps exact tools JSON; boundaries relock',async()=>{
  const h=await harness(true);commands(h.ctx);const s=makeSession(h.sessions,'cross-real-v4')
  gate.apply(h.ctx) // mount both actual apply entry points in this process
  for(let n=1;n<=6;n++)turn(s,n,`CACHE_${n}`,{bytes:1400})
  unlock(s,7);activity(s,8);activity(s,9);activity(s,10);activity(s,11)
  const before=JSON.stringify(toolsFor(s));assert.ok(before.includes('dev_reload_package'))
  compact.commitSpanCompaction(s,h.tokenMeter,compact.planSpanCompaction(s,h.tokenMeter,{turns:[1,3],summary:'cross append'},1))
  assert.equal(JSON.stringify(toolsFor(s)),before,'append compaction must not relock/mutate tools schema')
  activity(s,12);assert.equal(JSON.stringify(toolsFor(s)),before)
  const recentActivity=s.snapshotEvents().filter(e=>e.type==='assistant/message').at(-1)?.time??NOW
  const cold=gate.filterTools(catalog,s,gate.DEFAULT_CONFIG,{},recentActivity+300001)
  assert.ok(!cold.some(t=>t.name==='dev_reload_package'),'cold cache closes candidate')
  unlock(s,13);activity(s,14);activity(s,15);activity(s,16);activity(s,17)
  compact.commitSpanCompaction(s,h.tokenMeter,compact.planSpanCompaction(s,h.tokenMeter,{from:'turn:1',to:'turn:3',summary:'cross L1',mergeSummaries:true},1))
  assert.ok(!toolsFor(s).some(t=>t.name==='dev_reload_package'),'rewrite immediately closes')
  unlock(s,18);activity(s,19);activity(s,20);activity(s,21);activity(s,22)
  const toolHeader=s.append('request/header',{header:{config:{provider:'x',model:'y'},tools:[{name:'dev_new',description:'test',parameters:{type:'object'}}]},reason:'series',startsSeries:true})
  s.append('developer/message',{headerSeq:toolHeader.seq,message:{id:'d',role:'developer',source:{kind:'tool-addition'},content:[{type:'tool-addition',toolName:'dev_new'}]}},{surfaceOp:'append'})
  compact.commitSpanCompaction(s,h.tokenMeter,compact.planSpanCompaction(s,h.tokenMeter,{from:'auto',to:'turn:6',summary:'rebase'},1))
  assert.ok(!toolsFor(s).some(t=>t.name==='dev_reload_package'),'v4 rebase immediately closes')
  assert.equal(typeof h.ctx.systemPrompt,'object')
  const assembled=await assembledTools(h.ctx,catalog,{session:s})
  assert.ok(!assembled.some(t=>t.name==='dev_reload_package'),'real assemble hook applies same tools schema')
})

test('same-process real plugins + v3 SessionStore: hard cap and once have exact timing',async()=>{
  const ctx=new Context(),sessions=new SessionStore(ctx),meter=new TokenMeter(ctx);ctx.sessions=sessions;ctx.tokenMeter=meter
  const tools=new Map();ctx.provide('tools',{register(d){tools.set(d.name,d);return()=>tools.delete(d.name)}})
  ctx.provide('systemPrompt',{section(){return()=>{}},context(){return()=>{}}})
  commands(ctx);compact.apply(ctx);gate.apply(ctx)
  const s=sessions.prepare('cross-real-v3',{meta:{cwd:'C:/Users/mikon/workspace'}})
  for(let n=1;n<=5;n++){
    s.append('turn/start',{turn:n});s.append('user/message',{id:`u${n}`,role:'user',source:{kind:'human'},content:[{type:'text',text:'cache history '.repeat(500)}]},{surfaceOp:'append'});s.append('turn/end',{turn:n,reason:{kind:'completed'}})
  }
  unlock(s,6);for(let n=7;n<=17;n++)activity(s,n)
  assert.ok(toolsFor(s).some(t=>t.name==='dev_reload_package'))
  activity(s,18);assert.ok(toolsFor(s).some(t=>t.name==='dev_reload_package'),'hot cache keeps the idle group until PMW')
  assert.ok(!gate.filterTools(catalog,s,gate.DEFAULT_CONFIG,{},NOW+gate.DEFAULT_CONFIG.cacheExpiryMs+1).some(t=>t.name==='dev_reload_package'))
  s.append('turn/start',{turn:19});s.append('tool/call',{turn:19,name:'tool_unlock',arguments:JSON.stringify({groups:['dev'],action:'once'})});s.append('turn/end',{turn:19,reason:{kind:'completed'}})
  assert.ok(toolsFor(s).some(t=>t.name==='dev_reload_package'))
  activity(s,20)
  compact.commitSpanCompaction(s,meter,compact.planSpanCompaction(s,meter,{from:'turn:1',to:'turn:5',summary:'v3 append'},1))
  assert.ok(toolsFor(s).some(t=>t.name==='dev_reload_package'),'once waits for PMW while cache is hot')
  assert.ok(!gate.filterTools(catalog,s,gate.DEFAULT_CONFIG,{},NOW+gate.DEFAULT_CONFIG.cacheExpiryMs+1).some(t=>t.name==='dev_reload_package'))
  assert.ok(tools.has('tool_unlock')&&tools.has('context_compact'))
})
