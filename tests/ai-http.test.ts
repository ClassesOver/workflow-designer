import {strict as assert} from 'node:assert';
import test from 'node:test';
import type {AgentProvider, Scope} from '../src/ai-core.ts';
import {createAiHttp} from '../src/ai-http.ts';
import {ProposalStore} from '../src/proposal-store.ts';
import {sampleWorkflow} from '../src/workflow.ts';

const scope: Scope = {userId:'designer',projectId:'procurement',environment:'test'};
const draftRoute='/v1/ai/workflows/purchase';
const post=(path:string, body:unknown, viewer=false)=>new Request('https://local.test'+path,{
 method:'POST',headers:{'content-type':'application/json','x-test-viewer':viewer?'yes':'no'},body:JSON.stringify(body),
});
function fixture(store: ProposalStore, provider: AgentProvider) {
 return createAiHttp({store,provider,authorize:async (req,workflowId)=>workflowId==='purchase'?{
  scope,canRun:true,canConfirm:req.headers.get('x-test-viewer')!=='yes',
 }:null, catalog:async()=>({fields:[],roles:[]}), resolveMaterials:async ids=>ids.map(id=>({id,mimeType:'application/pdf'}))});
}
test('stream proposal without changing draft; separate user confirmation is durable and idempotent',async()=>{
 const store=new ProposalStore(':memory:');
 try {
  const base=store.putInitialDraft(scope,'purchase',sampleWorkflow);
  const provider: AgentProvider={async *stream({prior,materials}){
   assert.deepEqual(materials,[{id:'policy',mimeType:'application/pdf'}]);
   if(prior.length){yield {type:'text',text:'请审阅'};yield {type:'final'};return;}
   yield {type:'tool',id:'threshold',name:'workflow.propose_patch',args:{edgeId:'e3',value:80000}};
  }};
  const handle=fixture(store,provider);
  const response=await handle(post(draftRoute+'/turn',{input:'门槛改为八万',materialIds:['policy']}));
  assert.match(response.headers.get('content-type')??'',/ndjson/);
  const stream=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(stream.map(e=>e.type),['text','proposal','done']);
  const {proposalId}=stream[1].proposal;
  const confirmPath=draftRoute+'/proposals/'+proposalId+'/confirm';
  assert.equal(store.getDraft(scope,'purchase')?.revision,base.revision);
  assert.equal((await handle(new Request('https://local.test'+draftRoute+'/proposals/'+proposalId))).status,200);
  assert.equal((await handle(post(confirmPath,{expectedRevision:base.revision},true))).status,403);
  assert.equal(store.getDraft(scope,'purchase')?.revision,base.revision);
  const first=await handle(post(confirmPath,{expectedRevision:base.revision}));
  assert.equal(first.status,200);
  const firstJson=await first.json();
  assert.equal(firstJson.receipt.revision,base.revision+1);
  assert.equal(store.getDraft(scope,'purchase')?.workflow.edges.find(e=>e.id==='e3')?.rule?.value,80000);
  assert.deepEqual(await (await handle(post(confirmPath,{expectedRevision:base.revision}))).json(),firstJson);
 }finally{store.close()}
});

test('text-only suggestion cannot register a proposal and overlong or untrusted scope bodies fail before provider',async()=>{
 const store=new ProposalStore(':memory:');
 let turns=0;
 const provider:AgentProvider={async *stream(){
  turns++;yield {type:'text',text:'{"operation":"set_amount_threshold","value":80000}'};yield {type:'final'};
 }};
 try{
  const base=store.putInitialDraft(scope,'purchase',sampleWorkflow);
  const handle=fixture(store,provider);
  assert.equal((await handle(post(draftRoute+'/turn',{input:'change',projectId:'other'}))).status,400);
  assert.equal((await handle(post(draftRoute+'/turn',{input:'x'.repeat(70000)}))).status,413);
  assert.equal((await handle(post('/v1/ai/workflows/other/turn',{input:'change'}))).status,404);
  assert.equal(turns,0);
  const result=await handle(post(draftRoute+'/turn',{input:'change'}));
  const events=(await result.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(events.map(e=>e.type),['text','done']);
  assert.equal(store.getDraft(scope,'purchase')?.revision,base.revision);
 }finally{store.close()}
});

test('wire-shaped multimodal SSE turns into a scoped proposal with no write until confirm',async()=>{
 const store=new ProposalStore(':memory:');
 const {createResponsesProvider}=await import('../src/responses-provider.ts');
 const completed=(output:unknown[])=>new Response(
   'data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output}})+'\n\n',
   {headers:{'content-type':'text/event-stream'}},
 );
 let rounds=0,reads=0;
 const provider=createResponsesProvider({model:'fixture-multimodal',apiKey:'unused',resolveMaterial:async(ctx,ref)=>{
   assert.deepEqual(ctx.scope,scope);assert.equal(ref.id,'policy');reads++;
   return {mimeType:ref.mimeType,bytes:new TextEncoder().encode('%PDF-1.7 placeholder fixture')};
 },fetchImpl:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));
   assert.equal(body.input[0].content[1].type,'input_file');
   assert.equal(body.store,false);
   rounds++;
   if(rounds===1) {
     const tool=body.tools.find((t:{description:string})=>t.description.startsWith('workflow.propose_patch:'));
     return completed([{type:'function_call',call_id:'call_change',name:tool.name,status:'completed',arguments:JSON.stringify({edgeId:'e3',value:80000})}]);
   }
   assert.equal(body.input.at(-1).call_id,'call_change');
   assert.equal(JSON.parse(body.input.at(-1).output).baseRevision,'1');
   return completed([{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'请审阅一处改动',annotations:[]}]}]);
 }});
 try {
   const base=store.putInitialDraft(scope,'purchase',sampleWorkflow);
   const handle=fixture(store,provider);
   const response=await handle(post(draftRoute+'/turn',{input:'按制度调整',materialIds:['policy']}));
   const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
   assert.deepEqual(events.map(event=>event.type),['text','proposal','done']);
   assert.equal(rounds,2);assert.equal(reads,1);
   assert.equal(store.getDraft(scope,'purchase')?.workflow.edges.find(e=>e.id==='e3')?.rule?.value,50000);
   const confirm=await handle(post(draftRoute+'/proposals/'+events[1].proposal.proposalId+'/confirm',{expectedRevision:base.revision}));
   assert.equal(confirm.status,200);
   assert.equal(store.getDraft(scope,'purchase')?.workflow.edges.find(e=>e.id==='e3')?.rule?.value,80000);
 } finally {store.close()}
});

test('confirmation authorization is rechecked after the request body is available',async()=>{
 const store=new ProposalStore(':memory:');
 try {
  const base=store.putInitialDraft(scope,'purchase',sampleWorkflow);
  const proposal=store.prepare(scope,'purchase',base.revision,{kind:'set_amount_threshold',edgeId:'e3',value:80000});
  let checked=0;
  const handle=createAiHttp({store,provider:{async *stream(){throw Error('unexpected model');}},
    authorize:async()=>({scope,canRun:true,canConfirm:++checked===1}),
    catalog:async()=>({fields:[],roles:[]}),resolveMaterials:async()=>[],
  });
  const response=await handle(post(draftRoute+'/proposals/'+proposal.proposalId+'/confirm',{expectedRevision:base.revision}));
  assert.equal(response.status,403);
  assert.equal(checked,2);
  assert.equal(store.getDraft(scope,'purchase')?.revision,base.revision);
 } finally{store.close()}
});
