import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { harness, makeSession, turn, cleanup } from './v4-deep-helpers.mjs'
import { planSpanCompaction, commitSpanCompaction, planResultCompaction, commitResultCompaction, executeRecall, inspectSessionLog, resolveLeafSurfaceSeqs, parseTurnsToken, inspectSoftWatermark, getGlobalRuntimeState, apply } from '../lib/index.js'

test.after(cleanup)
const compact = (s,m,spec) => { const now=Date.now()+300000; const plan=planSpanCompaction(s,m,{...spec,now},1); return commitSpanCompaction(s,m,{...plan,now}) }
const spanTag = (s, seq) => s.eventAt(seq).data.content.map(b=>b.text??'').join('\n').match(/@span:[^\]\s]+(?:\s+turns:[\d,..-]+)?/)[0]

function strictOpenAI(messages) {
  const errors = [], pending = new Map()
  messages.forEach((m,i) => {
    if (!m || !['system','user','assistant','tool'].includes(m.role)) errors.push(`bad role ${i}`)
    if (m.role !== 'assistant' || !m.tool_calls) {
      if (typeof m.content === 'string' ? !m.content.length : !Array.isArray(m.content) || !m.content.length || m.content.some(b => b == null || (b.type === 'text' && typeof b.text !== 'string'))) errors.push(`empty content ${i}`)
    }
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) pending.set(c.id,i)
    if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id)) errors.push(`orphan result ${m.tool_call_id}`)
      else pending.delete(m.tool_call_id)
    } else if (pending.size && m.role !== 'assistant') errors.push(`dangling calls before ${i}`)
  })
  for (const [id] of pending) errors.push(`dangling call ${id}`)
  return errors
}
function strictAnthropic(messages) {
  // Native Anthropic has no role:'tool'; convert it to a tool_result block in user content.
  const native=messages.map(m=>m.role==='tool'?{role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]}:{role:m.role,content:m.content??[]})
  const errors=[]
  if (native.some(m=>m.role==='system')) errors.push('system must be top-level')
  const calls=new Set()
  for(const m of native){
    if(!Array.isArray(m.content)||!m.content.length||m.content.some(b=>b==null))errors.push('empty anthropic content')
    for(const b of m.content??[])if(b.type==='tool-call')calls.add(b.id)
    for(const b of m.content??[])if(b.type==='tool_result'){if(!calls.has(b.tool_use_id))errors.push('orphan tool_result');calls.delete(b.tool_use_id)}
  }
  if(calls.size)errors.push('dangling tool_use')
  return errors
}
function strictGemini(messages) {
  const errors = strictOpenAI(messages)
  if (messages[0]?.role !== 'system') errors.push('system instruction missing')
  if (messages.slice(1).some(m=>m.role==='system')) errors.push('embedded system')
  return errors
}
export function toOpenAI(s) {
  return s.deriveMessages().map(m => {
    if (m.role === 'tool') return { role:'tool', tool_call_id:m.toolCallId ?? m.source?.callId, content:m.content.map(b=>({type:'text',text:b.text??JSON.stringify(b)})) }
    const content = (m.content ?? []).filter(b=>b.type!=='tool-call').map(b=>b.type==='text'?{type:'text',text:b.text}:b)
    return { role:m.role, ...(content.length?{content}:{}), ...(m.role==='assistant'&&m.content?.some(b=>b.type==='tool-call')?{tool_calls:m.content.filter(b=>b.type==='tool-call').map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:b.arguments}}))}:{}) }
  })
}

test('strict OpenAI/Anthropic/Gemini contracts: multi-call boundaries and @call never orphan pairs', async () => {
  const {sessions,tokenMeter:m}=await harness(); const s=makeSession(sessions)
  for(let n=1;n<=7;n++) turn(s,n,`PROTO_${n}`,{calls:2,bytes:1800})
  for(const n of [1,2]) {
    commitResultCompaction(s,m,planResultCompaction(s,m,{callId:`call-${n}-0`,summary:`single ${n}`},undefined,1))
    compact(s,m,{turns:[n],summary:`whole defective-risk turn ${n}`})
  }
  compact(s,m,{turns:[3,5,6],summary:'noncontiguous with tombstone'})
  compact(s,m,{from:'auto',to:'turn:4',summary:'close island four'})
  compact(s,m,{from:'auto',to:'turn:7',summary:'finish all pairs'})
  const messages=toOpenAI(s)
  assert.deepEqual(strictOpenAI(messages),[])
  assert.deepEqual(strictAnthropic(messages.filter(x=>x.role!=='system')),[])
  assert.deepEqual(strictGemini(messages),[])
  assert.equal(s.eventAt(s.surface.nodes[0]).type,'system/message')
  for(const ev of s.snapshotEvents()) if(ev.surfaceOp!=='append'&&ev.type==='user/message') assert.ok(ev.data.content.length>0)
})

test('multi-cluster exact recall and pure L1 recursively reach bottom leaves without islands', async () => {
  const {sessions,tokenMeter:m}=await harness(); const s=makeSession(sessions)
  for(let n=1;n<=9;n++) turn(s,n,`LEAF_${n}`,{bytes:2600})
  const l0=compact(s,m,{turns:[1,3,4],summary:'cluster one three four'})
  const tag0=spanTag(s,l0.replaceEventSeq)
  assert.ok(tag0.includes('+S'))
  const r0=executeRecall(s,{target:tag0})
  assert.ok(r0.text.includes('LEAF_1')&&r0.text.includes('LEAF_3')&&r0.text.includes('LEAF_4'))
  assert.ok(!r0.text.includes('LEAF_2 original'))
  const before=s.eventAt(l0.replaceEventSeq)
  const auto=compact(s,m,{from:'auto',to:'turn:7',summary:'auto absorbs island two and tombstones'})
  assert.deepEqual(s.eventAt(l0.replaceEventSeq),before)
  assert.equal(s.surface.nodes.some(seq=>s.eventAt(seq).data?.source?.kind==='context-compact-elide'),false)
  const prefix0=executeRecall(s,{target:tag0})
  assert.ok(prefix0.text.includes('LEAF_1 original')&&prefix0.text.includes('LEAF_4 original'))
  const l1=compact(s,m,{from:'turn:1',to:'turn:7',summary:'pure nested L1',mergeSummaries:true})
  const nested=executeRecall(s,{target:spanTag(s,l1.replaceEventSeq)})
  assert.ok(nested.text.includes('LEAF_1 original'),'pure L1 must recurse to original leaves')
  assert.ok(nested.text.includes('LEAF_4 original'))
  const all=executeRecall(s,{target:'@search',query:'LEAF_[134]'})
  assert.ok(all.text.includes('LEAF_1')&&all.text.includes('LEAF_3')&&all.text.includes('LEAF_4'))
  const leaves=resolveLeafSurfaceSeqs(s.snapshotEvents(),[l1.replaceEventSeq])
  assert.equal(new Set(leaves).size,leaves.length)
})

test('all four abnormal turn/end statuses flush same-turn staged work exactly once, including next-turn tool result', async () => {
  for(const status of ['aborted','error','blocked','completed']) {
    const {ctx,sessions,tokenMeter:m,registeredTools}=await harness(true); const s=makeSession(sessions,`race-${status}`)
    turn(s,1,`RACE_OLD_${status}`); turn(s,2,`RACE_LARGE_${status}`,{bytes:22000})
    s.append('turn/start',{turn:3});s.append('step/start',{turn:3,step:1})
    const tool=registeredTools.get('context_compact'), agent={session:s}
    await tool.execute({spans:[{turns:[1],summary:'latched old span'}],results:[{callId:'call-1-0',summary:'latched old result'}]},{callId:'stage',agent,signal:new AbortController().signal})
    s.append('step/end',{turn:3,step:1})
    if(status==='completed') await ctx.serial('agent/turn-stopping',{agent,turn:3,signal:new AbortController().signal})
    s.append('turn/end',{turn:3,reason:{kind:status}})
    // Host synchronously opens the next turn and completes another large result before yielding.
    s.append('turn/start',{turn:4});s.append('step/start',{turn:4,step:1})
    const cid='next-turn-big'
    s.append('assistant/message',{turn:4,step:1,stream:[],message:{id:'na',role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:cid,name:'read',arguments:'{}'}]}},{surfaceOp:'append'})
    const call=s.append('tool/call',{turn:4,step:1,callId:cid,name:'read',arguments:'{}'})
    s.append('tool/result',{turn:4,step:1,stream:[],message:{id:'nr',role:'tool',source:{kind:'tool',callId:cid},content:[{type:'text',text:'NEW_TURN_MUST_SURVIVE '+'n'.repeat(20000)}]}},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
    await tool.execute({inspect:true},{callId:'inspect-reentry',agent,signal:new AbortController().signal})
    await tool.execute({results:[{callId:cid,summary:'NEW_TURN_STAGED_MUST_NOT_FLUSH'}]},{callId:'new-stage',agent,signal:new AbortController().signal})
    await Promise.resolve()
    assert.equal(s.snapshotEvents().filter(e=>e.type==='tool/result'&&e.data?.message?.source?.callId===cid&&e.surfaceOp!=='append').length,0,`${status}: no premature new-turn rewrite`)
    await ctx.serial('agent/turn-stopping',{agent,turn:4,signal:new AbortController().signal})
    const events=s.snapshotEvents()
    assert.equal(events.filter(e=>e.type==='tool/result'&&e.data?.message?.source?.callId===cid&&e.surfaceOp!=='append').length,1)
    const {getStagedQueueSnapshot}=await import('../lib/index.js')
    assert.equal(getStagedQueueSnapshot(s).results.length,0,`${status}: new-turn queue commits only at its own stopping`)
    const starts=events.filter(e=>e.type==='compaction/start').length
    assert.ok(starts>=0&&starts<=2,`${status}: no duplicate transaction; covered result may be skipped`)
    assert.equal(events.filter(e=>e.type==='compaction/end').length,starts,status)
    assert.ok(events.some(e=>e.type==='user/message'&&e.data?.source?.kind==='compact-checkpoint'))
  }
})

test('historical dangling call does not poison later safe-turn compaction',async()=>{
  const {sessions,tokenMeter:m}=await harness(true);const s=makeSession(sessions,'defect-race')
  turn(s,1,'DANGLING_OLD',{bytes:9000,omitResult:true})
  turn(s,2,'SAFE_NEW',{bytes:9000})
  assert.ok(inspectSessionLog(s).inFlightCalls.has('call-1-0'))
  compact(s,m,{turns:[2],summary:'safe turn compacts despite historical defect'})
  assert.ok(executeRecall(s,{target:'@call:call-2-0',query:'SAFE_NEW',context_lines:0}).returnedLines>0)
})

test('v4 JSONL roundtrip and fresh plugin/session restore: noncontiguous, @call, L1 and Symbol state', async () => {
  const {sessions,tokenMeter:m}=await harness(); const s=makeSession(sessions)
  for(let n=1;n<=10;n++) turn(s,n,`DISK_${n}`,{bytes:1800})
  commitResultCompaction(s,m,planResultCompaction(s,m,{callId:'call-2-0',summary:'disk single'},undefined,1))
  compact(s,m,{turns:[1,3,4],summary:'disk noncontiguous'})
  compact(s,m,{from:'auto',to:'turn:6',summary:'disk auto'})
  const l1=compact(s,m,{from:'turn:1',to:'turn:6',summary:'disk nested epoch',mergeSummaries:true})
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compact-v4-jsonl-')), file=path.join(dir,'session.jsonl')
  const rows=s.snapshotEvents().map(e=>JSON.stringify(e)).join('\n')+'\n'
  fs.writeFileSync(file,rows,{flag:'wx'})
  const parsed=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse)
  const restored=sessions.prepare('disk-restored',{seed:parsed,meta:structuredClone(s.header)})
  const detach=sessions.enter(restored);sessions.announce(restored)
  const fresh=await import(`../lib/index.js?cold=${Date.now()}`)
  assert.deepEqual(restored.surface.nodes,s.surface.nodes)
  assert.equal(fresh.inspectSessionLog(restored).openTurn,null)
  const report=fresh.buildInspectReport(restored,m)
  assert.ok(report.includes('Surface:')&&report.includes('surface tokens'))
  const recalled=fresh.executeRecall(restored,{target:spanTag(restored,l1.replaceEventSeq)})
  assert.ok(recalled.text.includes('DISK_1 original')&&recalled.text.includes('DISK_4 original'))
  const next=fresh.commitSpanCompaction(restored,m,fresh.planSpanCompaction(restored,m,{from:'auto',to:'turn:8',summary:'post restore append'},1))
  assert.equal(typeof restored.eventAt(next.replaceEventSeq).surfaceOp.startSeq,'number')
  const registry=fresh.getGlobalRuntimeState(); assert.equal(registry.bySession instanceof WeakMap,true)
  assert.equal(registry,fresh.getGlobalRuntimeState())
  fs.rmSync(dir,{recursive:true,force:true})
})

test('fuzz invalid/reversed/out-of-range/empty/all-compacted selectors fail closed without mutation', async () => {
  for(const token of ['270..265',-5,'','turnsBack:0','turn:0',NaN,Infinity,{},null]) assert.throws(()=>parseTurnsToken(token,10))
  const {sessions,tokenMeter:m}=await harness(); const s=makeSession(sessions); turn(s,1,'FUZZ')
  assert.throws(()=>planSpanCompaction(s,m,{turns:['turn:99999'],summary:'x'},1))
  const before=JSON.stringify(s.snapshotEvents())
  for(const spec of [{turns:[],summary:'x'},{turns:['270..265'],summary:'x'},{from:'turn:2',to:'turn:1',summary:'x'}]) assert.throws(()=>planSpanCompaction(s,m,spec,1))
  assert.equal(JSON.stringify(s.snapshotEvents()),before)
  compact(s,m,{turns:[1],summary:'already all compacted'})
  assert.throws(()=>planSpanCompaction(s,m,{turns:[1],summary:'again'},1))
})

test('50 summaries auto epoch suggestion and 200k cliff are observable; no hidden write', async () => {
  const {sessions,tokenMeter:m}=await harness(); const s=makeSession(sessions)
  for(let n=1;n<=50;n++){turn(s,n,`E${n}`,{bytes:700});compact(s,m,{turns:[n],summary:`epoch ${n}`})}
  turn(s,51,'WATERMARK_TRIGGER',{bytes:8000})
  const status=inspectSoftWatermark(s,m)
  assert.equal(status.summaryNodeCount,50)
  assert.equal(status.suggestedEpochMerge,null)
  const cold=inspectSoftWatermark(s,m,{now:Date.now()+300000})
  assert.ok(cold.suggestedEpochMerge.summaryCount>=8)
  assert.ok(cold.hint.includes('Epoch'))
  const big=makeSession(sessions,'cliff');turn(big,1,'CLIFF',{bytes:500000})
  const cliff=inspectSoftWatermark(big,m)
  assert.ok(cliff.tierCliffTriggered)
  assert.ok(cliff.hint.includes('200k'))
})

// Optional real corpus replay. Explicit env opt-in avoids accidental broad corpus reads.
test('real v4 JSONL fixture snapshot is cloned read-only before full replay', {skip:!process.env.DSH_TEST_SESSION_JSONL}, async () => {
  const source=process.env.DSH_TEST_SESSION_JSONL
  const hash=b=>createHash('sha256').update(b).digest('hex')
  const original=fs.readFileSync(source),before=hash(original)
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compact-real-jsonl-clone-')),clone=path.join(dir,'session.jsonl')
  fs.copyFileSync(source,clone,fs.constants.COPYFILE_EXCL)
  const {sessions,tokenMeter:m}=await harness()
  const restored=sessions.create('real-jsonl-clone',{seed:fs.readFileSync(clone,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.type!=='session'),meta:{cwd:'C:/Users/mikon/workspace'}})
  assert.ok(restored.snapshotEvents().some(e=>e.type==='user/message'&&e.surfaceOp!=='append'))
  const beforePrefix=restored.surface.nodes.filter(seq=>restored.eventAt(seq).data?.source?.kind==='compact-checkpoint').map(seq=>structuredClone(restored.eventAt(seq)))
  const info=inspectSessionLog(restored),target=Math.max(1,info.lastTurn-1)
  const next=compact(restored,m,{from:'auto',to:`turn:${target}`,summary:'real cloned snapshot auto closure'})
  const prefix=restored.surface.nodes.filter(seq=>restored.eventAt(seq).data?.source?.kind==='compact-checkpoint').map(seq=>restored.eventAt(seq))
  assert.deepEqual(prefix.slice(0,beforePrefix.length),beforePrefix)
  assert.deepEqual(strictOpenAI(toOpenAI(restored)),[])
  assert.equal(restored.surface.nodes.some(seq=>restored.eventAt(seq).data?.source?.kind==='context-compact-elide'),false)
  assert.ok(executeRecall(restored,{target:spanTag(restored,next.replaceEventSeq)}).returnedLines>0)
  assert.equal(hash(fs.readFileSync(source)),before)
  fs.rmSync(dir,{recursive:true,force:true})
})

test('real zstd session is cloned read-only before any replay', {skip:!process.env.DSH_TEST_SESSION_SNAPSHOT}, async () => {
  const source=process.env.DSH_TEST_SESSION_SNAPSHOT
  const hash=b=>createHash('sha256').update(b).digest('hex')
  const original=fs.readFileSync(source), before=hash(original)
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compact-real-clone-')), clone=path.join(dir,'session.jsonl.zstd')
  fs.copyFileSync(source,clone,fs.constants.COPYFILE_EXCL)
  assert.equal(hash(fs.readFileSync(source)),before)
  const bytes=fs.readFileSync(clone), MAGIC=Buffer.from([0x28,0xb5,0x2f,0xfd]), offsets=[]
  for(let i=bytes.indexOf(MAGIC);i>=0;i=bytes.indexOf(MAGIC,i+4)) offsets.push(i)
  const texts=[]
  for(let k=0;k<offsets.length;k++) {
    let out
    for(let j=k+1;j<=offsets.length;j++) try{out=zlib.zstdDecompressSync(bytes.subarray(offsets[k],offsets[j]??bytes.length));k=j-1;break}catch{}
    if(out)texts.push(out.toString('utf8'))
  }
  assert.ok(texts.length>0)
  const { Context } = await import(new URL('file:///C:/Users/mikon/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'))
  const OldSessionMod = await import(new URL('file:///C:/Users/mikon/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'))
  const OldSessionStore = OldSessionMod.default
  const decodeRecord = OldSessionMod.decodeStorageRecord
  const rawRecords=texts.join('\n').split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean).filter(e=>e.type!=='session')
  const parsedEvents=[]
  for (const r of rawRecords) {
    const decoded = decodeRecord ? decodeRecord(r) : [r]
    if (Array.isArray(decoded)) parsedEvents.push(...decoded)
    else if (decoded) parsedEvents.push(decoded)
  }
  const {tokenMeter:m}=await harness()
  const v3Sessions = new OldSessionStore(new Context())
  const restored=v3Sessions.create('real-zstd-clone',{seed:parsedEvents,meta:{cwd:'C:/Users/mikon/workspace'}})
  const info=inspectSessionLog(restored)
  assert.ok(info.lastTurn>=20, `expected >=20 turns in real snapshot, got ${info.lastTurn}`)
  const evAt=(s,seq)=>typeof s.eventAt==='function'?s.eventAt(seq):s.events[seq]
  const beforePrefix=restored.surface.nodes.filter(seq=>evAt(restored,seq).data?.source?.kind==='compact-checkpoint' || evAt(restored,seq).data?.source?.kind==='context-compact-summary').map(seq=>structuredClone(evAt(restored,seq)))
  const target=Math.max(1,info.lastTurn-1)
  const next=compact(restored,m,{from:'auto',to:`turn:${target}`,summary:'real zstd snapshot auto closure'})
  const prefix=restored.surface.nodes.filter(seq=>evAt(restored,seq).data?.source?.kind==='compact-checkpoint' || evAt(restored,seq).data?.source?.kind==='context-compact-summary').map(seq=>evAt(restored,seq))
  assert.deepEqual(prefix.slice(0,beforePrefix.length),beforePrefix)
  assert.equal(restored.surface.nodes.some(seq=>evAt(restored,seq).data?.source?.kind==='context-compact-elide'),false)
  const nextTag=evAt(restored,next.replaceEventSeq).data.content.map(b=>b.text??'').join('\n').match(/@span:[^\]\s]+(?:\s+turns:[\d,..-]+)?/)[0]
  assert.ok(executeRecall(restored,{target:nextTag}).returnedLines>0)
  assert.equal(hash(fs.readFileSync(source)),before)
  fs.rmSync(dir,{recursive:true,force:true})
})
