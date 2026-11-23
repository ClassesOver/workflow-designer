import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient } from '../src/ai-client.ts';
import {sampleWorkflow} from '../src/workflow.ts';
const p={proposalId:'a'.repeat(64),workflowId:'purchase',expectedRevision:1,operation:{kind:'set_amount_threshold',edgeId:'e3',value:80000},expiresAt:Date.now()+60000};
const sse=(...events:unknown[])=>new Response(events.map(event=>JSON.stringify(event)+'\n').join(''),{headers:{'content-type':'application/x-ndjson'}});
test('only an ended turn with a well-formed proposal resolves; only explicit confirm calls the write route',async()=>{
 const c=createAiClient(async(url,init)=>{
  assert.ok(typeof url==='string'&&url.startsWith('/v1/ai/workflows/purchase'));
  if(url.endsWith('/turn')){
   assert.deepEqual(JSON.parse(String(init?.body)),{input:'请生成提案',materialIds:['synthetic-visual-policy']});
   return sse({type:'text',text:'预览'},{type:'proposal',proposal:p},{type:'done'});
  }
  if(url.endsWith('/confirm')){
   assert.deepEqual(JSON.parse(String(init?.body)),{expectedRevision:1});
   return Response.json({receipt:{proposalId:p.proposalId,workflowId:'purchase',previousRevision:1,revision:2,confirmedAt:Date.now()}});
  }
  return Response.json({draft:{workflowId:'purchase',revision:1,workflow:sampleWorkflow}});
 });
 const pieces:string[]=[];
 assert.equal((await c.getAiDraft()).revision,1);
 assert.deepEqual(await c.runAiTurn({input:'请生成提案',materialIds:['synthetic-visual-policy']},{onText:text=>pieces.push(text)}),p);
 assert.deepEqual(pieces,['预览']);
 assert.equal((await c.confirmAiProposal(p as Parameters<typeof c.confirmAiProposal>[0])).revision,2);
});
test('truncated, error, and off-route proposals never become confirmable',async()=>{
 for(const [frames,code] of [
  [[{type:'proposal',proposal:p}],'incomplete_turn'],
  [[{type:'proposal',proposal:p},{type:'error',code:'model_unavailable'}],'model_unavailable'],
  [[{type:'proposal',proposal:{...p,workflowId:'other'}},{type:'done'}],'invalid_response'],
  [[{type:'done'},{type:'proposal',proposal:p}],'invalid_response'],
 ] as const){
  const c=createAiClient(async()=>sse(...frames));
  await assert.rejects(c.runAiTurn({input:'test'}),{code});
 }
});
test('preserves meaningful conflict code and AbortSignal',async()=>{
 const controller=new AbortController();
 const c=createAiClient(async(_url,init)=>{
  assert.equal(init?.signal,controller.signal);
  return Response.json({error:'revision_conflict'},{status:409});
 });
 await assert.rejects(c.confirmAiProposal(p as Parameters<typeof c.confirmAiProposal>[0],controller.signal),{code:'revision_conflict',status:409});
});

test('draft decodes only recognized upload modes and leaves legacy drafts unchanged',async()=>{
 for(const [capability,expected] of [[{uploadMode:'openai'},'openai'],[{uploadMode:'scripted'},'scripted'],[{uploadMode:'unknown'},undefined],[{},undefined]] as const){
  const c=createAiClient(async()=>Response.json({draft:{workflowId:'purchase',revision:1,workflow:sampleWorkflow},...capability}));
  assert.equal((await c.getAiDraft()).uploadMode,expected);
 }
});

test('material turn requires explicit OpenAI consent before any request and uses same-origin multipart NDJSON',async()=>{
 const file=new File([new Uint8Array([137,80,78,71])],'synthetic.png',{type:'image/png'});
 const controller=new AbortController();
 let calls=0;
 const c=createAiClient(async(url,init)=>{
  calls++;
  assert.equal(url,'/v1/ai/workflows/purchase/turn-with-material');
  assert.equal(init?.credentials,'same-origin');
  assert.equal(init?.redirect,'error');
  assert.equal(init?.cache,'no-store');
  assert.equal(init?.signal,controller.signal);
  assert.equal(init?.method,'POST');
  assert.equal(new Headers(init?.headers).has('content-type'),false);
  assert.ok(init?.body instanceof FormData);
  assert.deepEqual([...init.body.keys()],calls===1?['input','file','consent','expectedRevision']:['input','file','expectedRevision']);
  assert.equal(init.body.get('input'),'用材料核对门槛');
  assert.equal(init.body.get('file'),file);
  assert.equal(init.body.get('consent'),calls===1?'openai':null);
  assert.equal(init.body.get('expectedRevision'),'1');
  return sse({type:'text',text:'材料已附上'},{type:'proposal',proposal:p},{type:'done'});
 });
 await assert.rejects(c.runAiMaterialTurn({input:'用材料核对门槛',file,expectedRevision:1,mode:'openai'}),{code:'material_consent_required'});
 assert.equal(calls,0);
 const options={signal:controller.signal,onText:(t:string)=>pieces.push(t)};
 const pieces:string[]=[];
 assert.deepEqual(await c.runAiMaterialTurn({input:'用材料核对门槛',file,expectedRevision:1,mode:'openai',consent:'openai'},options),p);
 assert.deepEqual(await c.runAiMaterialTurn({input:'用材料核对门槛',file,expectedRevision:1,mode:'scripted'},options),p);
 assert.deepEqual(pieces,['材料已附上','材料已附上']);
});

test('material turn rejects unsupported or oversized Files before fetch',async()=>{
 const c=createAiClient(async()=>assert.fail('must not fetch invalid local files'));
 for(const [file,code] of [
  [new File(['text'],'notes.docx',{type:'text/plain'}),'material_type_unsupported'],
  [new File([new Uint8Array(8*1024*1024+1)],'oversized.pdf',{type:'application/pdf'}),'material_too_large'],
  [new File([],'empty.jpg',{type:'image/jpeg'}),'material_empty'],
 ] as const){
  await assert.rejects(c.runAiMaterialTurn({input:'核对',file,expectedRevision:1,mode:'scripted'}),{code});
 }
});

test('material turns require a positive safe expected revision before fetch',async()=>{
 const c=createAiClient(async()=>assert.fail('no request with invalid revision'));
 const file=new File(['%PDF-'],'test.pdf',{type:'application/pdf'});
 for(const expectedRevision of [0,-1,0.5,2**53,NaN])
  await assert.rejects(c.runAiMaterialTurn({input:'核对',file,mode:'scripted',expectedRevision}),{code:'invalid_revision'});
});
