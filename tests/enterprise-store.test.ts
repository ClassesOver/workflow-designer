import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ProposalStore, type ProposalScope } from '../src/proposal-store.ts'
import { sampleWorkflow } from '../src/workflow.ts'

const alice: ProposalScope = {userId:'alice', workspaceId:'tenant', projectId:'procurement', environment:'test'}
const bob: ProposalScope = {...alice,userId:'bob'}
const workflowId = 'purchase'
const change = (value: number) => ({kind:'set_amount_threshold',edgeId:'e3',value} as const)

test('workspace drafts are shared but proposals are actor-bound across file restarts', t=>{
 const dir=mkdtempSync(join(tmpdir(),'enterprise-proposals-'))
 const path=join(dir,'workflow.sqlite')
 let store=new ProposalStore(path,()=>1000)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const base=store.putInitialDraft(alice,workflowId,sampleWorkflow)
 assert.deepEqual(store.getDraft(bob,workflowId),base)
 assert.throws(()=>store.putInitialDraft(bob,workflowId,sampleWorkflow),{code:'already_exists'})
 const a=store.prepare(alice,workflowId,1,change(60000))
 const b=store.prepare(bob,workflowId,1,change(70000))
 for(const other of [bob,{...alice,workspaceId:'tenant2'},{...alice,projectId:'other'},{...alice,environment:'prod'},{...alice,workspaceId:undefined}]){
  assert.equal(store.getProposal(other,a.proposalId),null)
  assert.throws(()=>store.confirm(other,a.proposalId,1),{code:'not_found'})
 }
 assert.deepEqual(store.listAudit(alice,workflowId),[])
 store.close();store=new ProposalStore(path,()=>1100)
 assert.equal(store.getProposal(alice,a.proposalId)?.operation.value,60000)
 const receipt=store.confirm(alice,a.proposalId,1)
 assert.equal(store.getDraft(bob,workflowId)?.revision,2)
 assert.throws(()=>store.confirm(bob,b.proposalId,1),{code:'revision_conflict'})
 store.close();store=new ProposalStore(path,()=>1200)
 assert.deepEqual(store.confirm(alice,a.proposalId,1),receipt)
 assert.equal(store.getProposal(bob,a.proposalId),null)
 assert.deepEqual(store.listAudit(bob,workflowId),[{
  proposalId:a.proposalId,actorUserId:'alice',workspaceId:'tenant',projectId:'procurement',environment:'test',
  workflowId,previousRevision:1,revision:2,operation:change(60000),confirmedAt:1100,
 }])
 const reader=new DatabaseSync(path,{readOnly:true})
 try {
  const row=reader.prepare('SELECT backup FROM proposal_confirmations WHERE proposal_id=?').get(a.proposalId)
  assert.deepEqual(JSON.parse(String(row?.backup)),base.workflow)
 }finally{reader.close()}
})

test('audit cursor is exclusive, metadata only, and partitioned from other legacy and workspace drafts', t=>{
 const store=new ProposalStore(':memory:',()=>1000)
 t.after(()=>store.close())
 const legacy={...alice,workspaceId:undefined}
 const variants=[legacy,{...alice,workspaceId:'tenant2'},{...alice,projectId:'other'},{...alice,environment:'prod'}]
 for(const scope of [alice,...variants]){
  const initial=store.putInitialDraft(scope,workflowId,sampleWorkflow)
  if(scope!==alice)assert.equal(initial.revision,1)
 }
 for(let rev=1;rev<=27;rev++){
  const actor=rev%2?alice:bob
  const p=store.prepare(actor,workflowId,rev,change(50000+rev))
  store.confirm(actor,p.proposalId,rev)
 }
 for(const scope of variants)assert.deepEqual(store.listAudit(scope,workflowId),[])
 const page=store.listAudit(alice,workflowId)
 assert.equal(page.length,25)
 assert.equal(page[0].revision,28)
 assert.deepEqual(store.listAudit(alice,workflowId,{before:page[24].revision,limit:100}).map(x=>x.revision),[3,2])
 assert.deepEqual(store.listAudit(alice,workflowId,{before:28,limit:1}).map(x=>x.revision),[27])
 for(const limit of [0,-1,101,1.5,NaN])assert.throws(()=>store.listAudit(alice,workflowId,{limit}),{code:'invalid_input'})
 assert.throws(()=>store.listAudit(alice,workflowId,{before:0}),{code:'invalid_input'})
 assert.deepEqual(store.listAudit(alice,'other-workflow'),[])
 assert.deepEqual(Object.keys(page[0]).sort(), ['proposalId','actorUserId','workspaceId','projectId','environment','workflowId','previousRevision','revision','operation','confirmedAt'].sort())
})

test('legacy file data survives additive schema upgrade, and failed workspace audit never advances a draft', t=>{
 const dir=mkdtempSync(join(tmpdir(),'enterprise-proposals-'))
 const path=join(dir,'workflow.sqlite')
 const legacy={...alice,workspaceId:undefined}
 let store=new ProposalStore(path,()=>1000)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 store.putInitialDraft(legacy,workflowId,sampleWorkflow)
 const p=store.prepare(legacy,workflowId,1,change(62000))
 const receipt=store.confirm(legacy,p.proposalId,1)
 store.close()
 let db=new DatabaseSync(path)
 try {db.exec('DROP TABLE workspace_proposal_actors; DROP INDEX proposals_by_draft;')} finally {db.close()}
 store=new ProposalStore(path,()=>1100)
 assert.deepEqual(store.getProposal(legacy,p.proposalId)?.receipt,receipt)
 assert.equal(store.getDraft(alice,workflowId),null)
 const base=store.putInitialDraft(alice,workflowId,sampleWorkflow)
 const proposal=store.prepare(alice,workflowId,1,change(65000))
 db=new DatabaseSync(path)
 try {
  db.exec("CREATE TRIGGER deny_confirm BEFORE INSERT ON proposal_confirmations BEGIN SELECT RAISE(ABORT,'test failure'); END;")
  assert.throws(()=>store.confirm(alice,proposal.proposalId,1),/test failure/)
  assert.deepEqual(store.getDraft(bob,workflowId),base)
  assert.deepEqual(store.listAudit(bob,workflowId),[])
  assert.equal(store.getProposal(alice,proposal.proposalId)?.receipt,undefined)
  db.exec('DROP TRIGGER deny_confirm')
  store.confirm(alice,proposal.proposalId,1)
  assert.equal(store.listAudit(bob,workflowId).length,1)
 } finally {db.close()}
})
