import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPilotHttp} from '../src/pilot-http.ts';
import {ProposalStore} from '../src/proposal-store.ts';
import {sampleWorkflow} from '../src/workflow.ts';

const origin='https://approval.example.invalid';
const base='/v1/ai/workflows/purchase';
const target={workspaceId:'tenant-a',projectId:'purchasing',environment:'staging',workflowId:'purchase'};
const people=[
 {actorId:'alice',role:'approver',...target},
 {actorId:'bob',role:'editor',...target},
 {actorId:'cee',role:'auditor',...target},
 {actorId:'dee',role:'viewer',...target},
 {actorId:'elsewhere',role:'approver',...target,workspaceId:'tenant-b'},
] as const;
const scope={userId:'bootstrap',workspaceId:'tenant-a',projectId:'purchasing',environment:'staging'};
const op={kind:'set_amount_threshold',edgeId:'e3',value:80000};
function bind(store:ProposalStore) {
 const identities=new WeakMap<Request,string>();
 const handle=createPilotHttp({origin,target,store,memberships:people,identify:async request=>identities.get(request)??null});
 return (actor:string|null,path:string,body?:unknown,originHeader=origin)=>{
  const request=new Request(origin+base+path,{method:body===undefined?'GET':'POST',headers:{
   'content-type':'application/json',origin:originHeader,'sec-fetch-site':'same-origin',
  },body:body===undefined?undefined:JSON.stringify(body)});
  if(actor)identities.set(request,actor);
  return handle(request);
 };
}

test('enterprise workflow: shared revision, distinct roles, scoped audit and atomic persistence after file reopen',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'wf-pilot-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=join(dir,'workflow.sqlite');
 let store=new ProposalStore(db);t.after(()=>store.close());
 store.putInitialDraft(scope,'purchase',sampleWorkflow);
 let call=bind(store);
 assert.equal((await call(null,'')).status,404);
 assert.equal((await call('elsewhere','')).status,404);
 assert.equal((await call('dee','/turn',{input:'hi'})).status,403);
 assert.deepEqual((await (await call('dee','')).json()).capabilities,{canPrepare:false,canConfirm:false});
 assert.deepEqual((await (await call('bob','')).json()).capabilities,{canPrepare:true,canConfirm:false});
 assert.equal((await call('alice','/turn-with-material',{})).status,404);
 assert.equal((await call('dee','/proposals',{expectedRevision:1,operation:op})).status,403);
 const editorProposal=(await (await call('bob','/proposals',{expectedRevision:1,operation:op})).json()).proposal;
 assert.equal((await call('bob','/proposals/'+editorProposal.proposalId+'/confirm',{expectedRevision:1})).status,403);
 assert.equal((await call('alice','/proposals/'+editorProposal.proposalId+'/confirm',{expectedRevision:1})).status,404);
 assert.equal((await call('alice','/proposals',{expectedRevision:1,operation:op},'https://other.invalid')).status,404);
 const prepared=await call('alice','/proposals',{expectedRevision:1,operation:op});
 assert.equal(prepared.status,201);
 const {proposal}=await prepared.json();
 assert.equal((await (await call('dee','')).json()).draft.revision,1);
 assert.equal((await call('alice','/audit')).status,403);
 assert.equal((await call('cee','')).status,403);
 assert.equal((await call('cee','/proposals/'+proposal.proposalId)).status,403);
 assert.deepEqual((await (await call('cee','/audit')).json()).events,[]);
 const path='/proposals/'+proposal.proposalId+'/confirm';
 const confirmed=await call('alice',path,{expectedRevision:1});
 assert.equal(confirmed.status,200);
 const {receipt}=await confirmed.json();
 assert.equal(receipt.revision,2);
 store.close();
 store=new ProposalStore(db);call=bind(store);
 assert.equal((await (await call('bob','')).json()).draft.revision,2);
 assert.equal((await (await call('dee','')).json()).draft.workflow.edges.find((e:{id:string})=>e.id==='e3').rule.value,80000);
 assert.deepEqual((await (await call('alice',path,{expectedRevision:1})).json()).receipt,receipt);
 const audit=(await (await call('cee','/audit?limit=1')).json()).events;
 assert.equal(audit.length,1);
 assert.equal(audit[0].actorUserId,'alice');
 assert.equal(audit[0].revision,2);
 assert.deepEqual((await (await call('cee','/audit?before=2')).json()).events,[]);
 assert.equal((await call('cee','/audit?limit=101')).status,400);
});

test('revoked verified session cannot prepare after request body, and cancelled requests release the body reader',async t=>{
 const store=new ProposalStore(':memory:');t.after(()=>store.close());
 store.putInitialDraft(scope,'purchase',sampleWorkflow);
 let active=true,checks=0;
 const handle=createPilotHttp({origin,target,store,memberships:people,identify:async()=>{checks++;return active?'alice':null;}});
 const headers={'content-type':'application/json',origin,'sec-fetch-site':'same-origin'};
 const path=origin+base+'/proposals';
 const payload=new TextEncoder().encode(JSON.stringify({expectedRevision:1,operation:op}));
 let release!:ReadableStreamDefaultController<Uint8Array>;
 const revoked=new Request(path,{method:'POST',headers,body:new ReadableStream({start(c){release=c;}}),duplex:'half'});
 const waiting=handle(revoked);
 await new Promise(resolve=>setImmediate(resolve));
 active=false;
 release.enqueue(payload);release.close();
 assert.equal((await waiting).status,403);
 assert.equal(checks,2);
 active=true;
 const controller=new AbortController();
 let cancelled=false;
 const request=new Request(path,{method:'POST',headers,body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half',signal:controller.signal});
 const pending=handle(request);
 await new Promise(resolve=>setImmediate(resolve));
 controller.abort();
 const response=await Promise.race([pending,new Promise<null>(resolve=>setTimeout(()=>resolve(null),150))]);
 assert.equal(response?.status,408);
 assert.ok(cancelled);
 assert.equal(store.getDraft(scope,'purchase')?.revision,1);
});
