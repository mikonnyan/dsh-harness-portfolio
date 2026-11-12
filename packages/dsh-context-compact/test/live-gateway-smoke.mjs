// Opt-in live test. Run in an environment permitted to access the local gateways.
// No credentials are read; requests contain only synthetic content.
import assert from 'node:assert/strict'
const messages=[
  {role:'system',content:[{type:'text',text:'Return exactly OK. Use prior tool context as background.'}]},
  {role:'user',content:[{type:'text',text:'Historical compacted request '+ 'prefix-'.repeat(1600)}]},
  {role:'assistant',content:[{type:'text',text:'Calling read.'}],tool_calls:[{id:'synthetic-call',type:'function',function:{name:'read',arguments:'{}'}}]},
  {role:'tool',tool_call_id:'synthetic-call',content:[{type:'text',text:'Synthetic tool result; anchor retained.'}]},
  {role:'user',content:[{type:'text',text:'<compacted-summary>\n[Compact turns:1,3] first cluster [recall: @span:S1-2+S5-6 turns:1,3]\n</compacted-summary>'}]},
  {role:'user',content:[{type:'text',text:'Unselected island turn 2 remains distinct.'}]},
  {role:'user',content:[{type:'text',text:'[Compact elided turns:3 → summarized above, [recall: @span:S1-2+S5-6 turns:1,3]]'}]},
  {role:'assistant',content:[{type:'text',text:'Second call.'}],tool_calls:[{id:'synthetic-call-2',type:'function',function:{name:'read',arguments:'{}'}}]},
  {role:'tool',tool_call_id:'synthetic-call-2',content:[{type:'text',text:'Second synthetic result.'}]},
  {role:'user',content:[{type:'text',text:'Reply OK only.'}]},
]
async function call(base,model){const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages,max_tokens:16,stream:false})});const text=await r.text();let body;try{body=JSON.parse(text)}catch{body={raw:text}}return{status:r.status,requestId:r.headers.get('x-request-id'),body}}
const report={}
for(const [name,base,model,count] of [
  ['kimi','http://127.0.0.1:4098/v1/chat/completions','kimi-k3.1-pro',2],
  ['copilot','http://127.0.0.1:4141/v1/chat/completions',process.env.DSH_TEST_COPILOT_MODEL||'claude-fable-5.2',1],
]){
  const responses=[]
  for(let i=0;i<count;i++){const r=await call(base,model);assert.equal(r.status,200,`${name}: ${JSON.stringify(r.body)}`);responses.push(r)}
  if(count===2){const usage=responses[1].body.usage??{};const cached=usage.cached_tokens??usage.prompt_tokens_details?.cached_tokens??0;assert.ok(cached>0,`second request must report cached_tokens > 0; usage=${JSON.stringify(usage)}`)}
  report[name]={model,responses:responses.map(r=>({status:r.status,requestId:r.requestId,usage:r.body.usage??null}))}
}
console.log(JSON.stringify(report,null,2))
