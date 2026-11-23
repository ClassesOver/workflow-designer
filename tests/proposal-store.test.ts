import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProposalStore, type Scope, type Operation } from '../src/proposal-store.ts'
import { sampleWorkflow } from '../src/workflow.ts'

const scope: Scope = { userId: 'alice', projectId: 'procurement', environment: 'test' }
const workflowId = 'purchase'
const change = (value: number): Operation => ({ kind: 'set_amount_threshold', edgeId: 'e3', value })
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-store-'))
  const path = join(dir, 'workflow.sqlite')
  let now = 100000
  let store = new ProposalStore(path, () => now)
  t.after(() => { store.close(); rmSync(dir, { recursive:true, force:true }) })
  const draft = store.putInitialDraft(scope, workflowId, sampleWorkflow)
  return { path, draft, get store() { return store }, reopen() { store.close(); store = new ProposalStore(path, () => now) }, advance(ms:number) { now += ms } }
}
test('prepare does not mutate draft; confirm, backup and replay persist across restart', t => {
  const env = setup(t)
  const p = env.store.prepare(scope, workflowId, env.draft.revision, change(80000))
  assert.match(p.proposalId, /^[a-f0-9]{64}$/)
  assert.deepEqual(env.store.getDraft(scope, workflowId), env.draft)
  env.reopen()
  const receipt = env.store.confirm(scope, p.proposalId, p.expectedRevision)
  const result = env.store.getDraft(scope, workflowId)!
  assert.equal(result.revision, env.draft.revision + 1)
  const before = structuredClone(env.draft.workflow)
  const edge = before.edges.find(e => e.id === 'e3')!
  edge.rule!.value = 80000; delete edge.label
  assert.deepEqual(result.workflow, before)
  env.reopen()
  assert.deepEqual(env.store.confirm(scope, p.proposalId, p.expectedRevision), receipt)
  assert.deepEqual(env.store.getDraft(scope, workflowId), result)
  const db = new DatabaseSync(env.path, {readOnly:true})
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM proposal_confirmations').get()?.count, 1)
    const saved = db.prepare('SELECT backup FROM proposal_confirmations').get()
    assert.deepEqual(JSON.parse(String(saved?.backup)), env.draft.workflow)
  } finally { db.close() }
})
test('foreign principal/project/environment cannot claim or replay a receipt', t => {
  const env = setup(t)
  const p = env.store.prepare(scope, workflowId, env.draft.revision, change(80000))
  const foreign = [{...scope,userId:'bob'}, {...scope,projectId:'another'}, {...scope,environment:'prod'}]
  for (const actor of foreign) {
    assert.equal(env.store.getDraft(actor,workflowId), null)
    assert.throws(() => env.store.confirm(actor,p.proposalId,p.expectedRevision), /提案不存在/)
  }
  env.store.confirm(scope,p.proposalId,p.expectedRevision)
  for (const actor of foreign) assert.throws(() => env.store.confirm(actor,p.proposalId,p.expectedRevision), /提案不存在/)
})
test('stale revision cannot replace a newer draft, including stale prepare', t => {
  const env = setup(t)
  const r = env.draft.revision
  const a = env.store.prepare(scope,workflowId,r,change(60000))
  const b = env.store.prepare(scope,workflowId,r,change(70000))
  assert.throws(() => env.store.confirm(scope,a.proposalId,r+1), /版本/)
  env.store.confirm(scope,a.proposalId,r)
  assert.throws(() => env.store.confirm(scope,b.proposalId,r), /版本/)
  assert.throws(() => env.store.prepare(scope,workflowId,r,change(80000)), /版本/)
  assert.equal(env.store.getDraft(scope,workflowId)?.workflow.edges.find(e=>e.id==='e3')?.rule?.value,60000)
})
test('expiry and malformed operations fail without editing the draft', t => {
  const env = setup(t)
  const r = env.draft.revision
  for (const op of [change(NaN),change(-1),{...change(5),edgeId:'e4'},{...change(5),kind:'write'}, {...change(5),execute:true}]) {
    assert.throws(() => env.store.prepare(scope,workflowId,r,op as Operation), /条件|操作/)
  }
  const p = env.store.prepare(scope,workflowId,r,change(60000))
  env.advance(p.expiresAt - 100000)
  assert.throws(() => env.store.confirm(scope,p.proposalId,r), /过期/)
  assert.deepEqual(env.store.getDraft(scope,workflowId),env.draft)
})
test('rolls back draft if writing the audit/snapshot fails, so confirm can be retried', t => {
  const env = setup(t)
  const p = env.store.prepare(scope,workflowId,env.draft.revision,change(60000))
  const db = new DatabaseSync(env.path)
  try {
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON proposal_confirmations BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    assert.throws(() => env.store.confirm(scope,p.proposalId,p.expectedRevision), /audit unavailable/)
    assert.deepEqual(env.store.getDraft(scope,workflowId),env.draft)
    db.exec('DROP TRIGGER fail_audit')
    assert.equal(env.store.confirm(scope,p.proposalId,p.expectedRevision).revision,p.expectedRevision+1)
  } finally { db.close() }
})

test('reload exposes scoped proposal and receipt and replay remains valid after expiry', t => {
  const env = setup(t)
  const p = env.store.prepare(scope,workflowId,env.draft.revision,change(65000))
  env.reopen()
  assert.deepEqual(env.store.getProposal(scope,p.proposalId),p)
  assert.equal(env.store.getProposal({...scope,userId:'bob'},p.proposalId),null)
  assert.equal(env.store.getProposal(scope,'not-an-opaque-id'),null)
  const receipt = env.store.confirm(scope,p.proposalId,p.expectedRevision)
  env.advance(p.expiresAt)
  env.reopen()
  assert.deepEqual(env.store.getProposal(scope,p.proposalId),{...p,receipt})
  assert.deepEqual(env.store.confirm(scope,p.proposalId,p.expectedRevision),receipt)
  assert.throws(() => env.store.confirm(scope,p.proposalId,p.expectedRevision+1), {code:'revision_conflict'})
})
test('bootstrapping cannot overwrite; equal workflow IDs in different scopes are independent', t => {
  const env = setup(t)
  assert.throws(() => env.store.putInitialDraft(scope,workflowId,sampleWorkflow), {code:'already_exists'})
  const other = {...scope,projectId:'other'}
  const otherDraft = env.store.putInitialDraft(other,workflowId,sampleWorkflow)
  const proposal = env.store.prepare(scope,workflowId,env.draft.revision,change(86000))
  const peer = new ProposalStore(env.path, () => 120000)
  try {
    const receipt = peer.confirm(scope,proposal.proposalId,proposal.expectedRevision)
    assert.deepEqual(env.store.confirm(scope,proposal.proposalId,proposal.expectedRevision),receipt)
    assert.deepEqual(peer.getDraft(other,workflowId),otherDraft)
  } finally { peer.close() }
})
