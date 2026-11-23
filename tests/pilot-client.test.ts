import test from 'node:test';
import assert from 'node:assert/strict';
import {createPilotClient, type PilotProposal} from '../src/ai-client.ts';
import {sampleWorkflow} from '../src/workflow.ts';

const workflowId='purchase-pilot',base='/v1/ai/workflows/'+workflowId;
const draft={workflowId,revision:3,workflow:sampleWorkflow};
const proposal:PilotProposal={workflowId,proposalId:'a'.repeat(64),expectedRevision:3,
  operation:{kind:'set_amount_threshold',edgeId:'e3',value:80000},expiresAt:5000};
const receipt={workflowId,proposalId:proposal.proposalId,previousRevision:3,revision:4,confirmedAt:4500};

test('reads a validated authorized draft and preserves read-only capability',async()=>{
 const signal=new AbortController().signal;
 const capabilities={canPrepare:false,canConfirm:false};
 const c=createPilotClient(workflowId,async(path,init)=>{
  assert.equal(path,base);
  assert.equal(init?.method??'GET','GET');
  assert.equal(init?.signal,signal);
  assert.equal(init?.credentials,'same-origin');
  assert.equal(init?.redirect,'error');
  assert.equal(init?.cache,'no-store');
  return Response.json({draft,capabilities});
 });
 assert.deepEqual(await c.read(signal),{draft,capabilities});
});

test('rejects malformed draft, off-context workflow and capability flags',async()=>{
 for(const response of [
  {draft,capabilities:{canPrepare:true}},
  {draft,capabilities:{canPrepare:1,canConfirm:false}},
  {draft:{...draft,workflowId:'other'},capabilities:{canPrepare:true,canConfirm:false}},
  {draft:{...draft,workflow:{...sampleWorkflow,edges:[]}},capabilities:{canPrepare:true,canConfirm:true}},
 ]){
  const c=createPilotClient(workflowId,async()=>Response.json(response));
  await assert.rejects(c.read(),{code:'invalid_response'});
 }
 assert.throws(()=>createPilotClient('other/track'),{code:'invalid_workflow'});
});

test('prepare and explicit confirm are separate requests with exact payloads',async()=>{
 const calls:string[]=[];
 const signal=new AbortController().signal;
 const c=createPilotClient(workflowId,async(path,init)=>{
  calls.push(String(path));
  assert.equal(init?.signal,signal);
  assert.equal(init?.method,'POST');
  assert.equal(new Headers(init?.headers).get('content-type'),'application/json');
  const body=JSON.parse(String(init?.body));
  if(path===base+'/proposals'){
   assert.deepEqual(body,{expectedRevision:3,operation:proposal.operation});
   return Response.json({proposal},{status:201});
  }
  assert.equal(path,base+'/proposals/'+proposal.proposalId+'/confirm');
  assert.deepEqual(body,{expectedRevision:3});
  return Response.json({receipt});
 });
 assert.deepEqual(await c.prepare(3,'e3',80000,signal),proposal);
 assert.deepEqual(calls,[base+'/proposals']);
 assert.deepEqual(await c.confirm(proposal,signal),receipt);
 assert.equal(calls.length,2);
});

test('mismatched prepare responses and mismatched receipts fail without retry',async()=>{
 for(const other of [
  {...proposal,workflowId:'other'},{...proposal,expectedRevision:4},
  {...proposal,operation:{...proposal.operation,value:80001}},
  {...proposal,operation:{...proposal.operation,edgeId:'e4'}},
  {...proposal,operation:{...proposal.operation,kind:'publish'}},
 ]){
  let calls=0;
  const c=createPilotClient(workflowId,async()=>{calls++;return Response.json({proposal:other});});
  await assert.rejects(c.prepare(3,'e3',80000),{code:'invalid_response'});
  assert.equal(calls,1);
 }
 for(const other of [
  {...receipt,revision:5},{...receipt,previousRevision:4},{...receipt,workflowId:'other'},
  {...receipt,confirmedAt:0},{...receipt,proposalId:'b'.repeat(64)},
 ]){
  let calls=0;
  const c=createPilotClient(workflowId,async()=>{calls++;return Response.json({receipt:other});});
  await assert.rejects(c.confirm(proposal),{code:'invalid_response'});
  assert.equal(calls,1);
 }
});

test('rejects invalid writes locally and preserves a server revision conflict once',async()=>{
 let calls=0;
 const c=createPilotClient(workflowId,async()=>{calls++;return Response.json({error:'revision_conflict'},{status:409});});
 await assert.rejects(c.prepare(0,'e3',80000),{code:'invalid_revision'});
 await assert.rejects(c.prepare(3,'e3',Infinity),{code:'invalid_operation'});
 await assert.rejects(c.confirm({...proposal,workflowId:'other'}),{code:'invalid_response'});
 assert.equal(calls,0);
 await assert.rejects(c.confirm(proposal),{code:'revision_conflict',status:409});
 assert.equal(calls,1);
});
