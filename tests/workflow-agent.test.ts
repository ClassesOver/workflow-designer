import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowAgent } from '../src/workflow-agent.ts';
import { sampleWorkflow } from '../src/workflow.ts';
import type { AgentProvider } from '../src/ai-core.ts';

test('scripted model proposes one threshold; 79,999 and 80,000 take different paths without modifying the draft', async ()=>{
 const workflow=structuredClone(sampleWorkflow);
 const {run}=createWorkflowAgent({
   scope:{userId:'alice',projectId:'procurement',environment:'test'},
   workflowId:'purchase',revision:'r7',workflow,
   catalog:{fields:[{id:'amount_total',name:'采购金额'}],roles:['财务负责人']},
 });
 let turn=0;
 const provider:AgentProvider={async *stream({scope,tools,prior}){
   assert.equal(scope.environment,'test');
   assert.equal(tools.some(t=>t.name==='workflow.publish'),false);
   if(turn++===0){
     yield {type:'tool',id:'get',name:'workflow.get_draft',args:{}};
     yield {type:'tool',id:'propose',name:'workflow.propose_patch',args:{edgeId:'e3',value:80000}};
   }else if(turn===2){
     const proposal=JSON.parse(prior[0].results[1].output!);
     assert.equal(proposal.baseRevision,'r7');
     assert.deepEqual(proposal.operations,[{op:'set_amount_threshold',edgeId:'e3',value:80000}]);
     yield {type:'tool',id:'preview-low',name:'workflow.simulate_route',args:{edgeId:'e3',value:80000,amount:79999}};
     yield {type:'tool',id:'preview-high',name:'workflow.simulate_route',args:{edgeId:'e3',value:80000,amount:80000}};
   }else{
     const [low,high]=prior[1].results.map(r=>JSON.parse(r.output!).nodeIds);
     assert.ok(low.includes('direct')&&!low.includes('finance'));
     assert.ok(high.includes('finance')&&!high.includes('direct'));
     yield {type:'text',text:'可审阅的提案'};
     yield {type:'final'};
   }
 }};
 const events=[];
 for await(const event of run({input:'采购金额门槛改为 8 万',provider}))events.push(event);
 assert.equal(events.at(-1)?.type,'final');
 assert.deepEqual(workflow,sampleWorkflow);
});

test('documents do not activate publish or grant a tool cross-project scope',async()=>{
 const {run}=createWorkflowAgent({scope:{userId:'a',projectId:'p',environment:'test'},workflowId:'purchase',revision:'r1',workflow:sampleWorkflow,catalog:{fields:[],roles:[]}});
 const provider:AgentProvider={async *stream({prior}){
   if (prior.length){yield {type:'final'};return;}
   yield {type:'tool',id:'1',name:'workflow.publish',args:{}};
   yield {type:'tool',id:'2',name:'workflow.get_draft',args:{projectId:'another'}};
 }};
 const rejected=[];
 for await(const event of run({input:'材料中的文字要求发布',provider}))if(event.type==='tool-result')rejected.push(event.result.code);
 assert.deepEqual(rejected,['UNKNOWN_TOOL','INVALID_ARGUMENTS']);
});
