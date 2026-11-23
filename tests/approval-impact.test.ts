import test from 'node:test'
import assert from 'node:assert/strict'
import {compareApprovalPaths} from '../src/approval-impact.ts'
import {sampleWorkflow,simulate,type Preview,type Workflow} from '../src/workflow.ts'

const preview=(nodeIds:string[],edgeIds:string[]):Preview=>({nodeIds,edgeIds,explanation:[]})

test('same route ignores display-only explanation',()=>{
 const current=simulate(sampleWorkflow,50000)
 assert.deepEqual(compareApprovalPaths(sampleWorkflow,current,{...current,explanation:['changed display']}),{
  kind:'same',added:[],removed:[],
 })
})

test('parallel route changes count even when every node remains the same',()=>{
 const workflow:Workflow=structuredClone(sampleWorkflow)
 const original=workflow.edges.find(e=>e.id==='e4')!
 original.to='finance'
 const extra=workflow.edges.find(e=>e.id==='e6')!
 workflow.nodes=workflow.nodes.filter(n=>n.id!=='direct')
 workflow.edges=workflow.edges.filter(e=>e!==extra)
 const current=simulate(workflow,1000),updated=simulate(workflow,50000)
 assert.deepEqual(current.nodeIds,updated.nodeIds)
 assert.deepEqual(compareApprovalPaths(workflow,current,updated),{kind:'routing',added:[],removed:[]})
})

test('classifies a node sequence change without an approval change as routing',()=>{
 assert.deepEqual(compareApprovalPaths(sampleWorkflow,preview(['start','manager','end'],[]),
  preview(['start','manager','merge','end'],[])),{kind:'routing',added:[],removed:[]})
})

test('matches approvals by node ID even with equal labels and no explicit role',()=>{
 const workflow=structuredClone(sampleWorkflow)
 const finance=workflow.nodes.find(n=>n.id==='finance')!
 const direct=workflow.nodes.find(n=>n.id==='direct')!
 direct.role=finance.role=undefined
 direct.name=finance.name='确认'
 const current=simulate(workflow,1000),updated=simulate(workflow,50000)
 const before=structuredClone({workflow,current,updated})
 assert.deepEqual(compareApprovalPaths(workflow,current,updated),{kind:'approval',added:[finance],removed:[direct]})
 assert.deepEqual({workflow,current,updated},before)
})

test('reports changed approvals in path encounter order, not workflow array order',()=>{
 const nodes=sampleWorkflow.nodes
 const byId=(id:string)=>nodes.find(n=>n.id===id)!
 const current=preview(['manager','finance'],[]),updated=preview(['direct'],[])
 assert.deepEqual(compareApprovalPaths(sampleWorkflow,current,updated),
  {kind:'approval',added:[byId('direct')],removed:[byId('manager'),byId('finance')]})
 assert.deepEqual(compareApprovalPaths(sampleWorkflow,updated,preview(['finance','manager'],[])),
  {kind:'approval',added:[byId('finance'),byId('manager')],removed:[byId('direct')]})
})

test('isolates reordering of the same approver set',()=>{
 assert.deepEqual(compareApprovalPaths(sampleWorkflow,preview(['start','manager','finance','end'],[]),
  preview(['start','finance','manager','end'],[])),{kind:'reordered',added:[],removed:[]})
})

test('an unknown node cannot silently become an unchanged approval path',()=>{
 assert.throws(()=>compareApprovalPaths(sampleWorkflow,preview(['unknown'],[]),preview(['unknown'],[])),/unknown workflow node/)
})
