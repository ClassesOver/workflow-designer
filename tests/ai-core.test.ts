import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentLoop } from '../src/ai-core.ts';
import type { AgentEvent, AgentProvider, Scope } from '../src/ai-core.ts';

const scope = {userId:'alice',projectId:'studio',environment:'local'} satisfies Scope;
const collect = async (events:AsyncIterable<AgentEvent>)=>{
 const result:AgentEvent[]=[];
 for await(const event of events)result.push(event);
 return result;
};

test('scripted provider streams text and receives validated proposal result on its next round',async()=>{
 const loop=createAgentLoop([{
  name:'workflow.propose_patch',description:'Stage a candidate without applying it',effect:'proposal',
  fields:{threshold:{type:'string',maxLength:24}},
  execute(args,context){
   assert.deepEqual(context.scope,scope);
   assert.equal(args.threshold,'20000.00');
   return 'candidate-1';
  },
 }]);
 const provider:AgentProvider={async *stream(request){
  assert.equal(request.input,'调整金额');
  assert.deepEqual(request.tools.map(tool=>tool.name),['workflow.propose_patch']);
  assert.equal('execute' in request.tools[0],false);
  if(!request.prior.length){
   yield {type:'text',text:'正在生成候选'};
   yield {type:'tool',id:'call-1',name:'workflow.propose_patch',args:{threshold:'20000.00'}};
  }else{
   assert.deepEqual(request.prior[0].results.map(result=>result.output),['candidate-1']);
   yield {type:'text',text:'请审阅'};
   yield {type:'final'};
  }
 }};
 const events=await collect(loop.run({scope,input:'调整金额',provider}));
 assert.deepEqual(events.map(event=>event.type),['text','tool-result','text','final']);
});

test('unknown tools and malformed or scope-bearing arguments never execute',async()=>{
 let executions=0;
 const loop=createAgentLoop([{
  name:'workflow.get_draft',description:'Read',effect:'read',
  fields:{id:{type:'string',maxLength:8}},execute(){executions++;return 'value';},
 }]);
 const provider:AgentProvider={async *stream({prior}){
  if(prior.length){yield {type:'final'};return;}
  yield {type:'tool',id:'1',name:'workflow.publish',args:{}};
  yield {type:'tool',id:'2',name:'workflow.get_draft',args:{id:12}};
  yield {type:'tool',id:'3',name:'workflow.get_draft',args:{id:'d',userId:'other'}};
  yield {type:'tool',id:'4',name:'workflow.get_draft',args:{id:'x'.repeat(9)}};
 }};
 const events=await collect(loop.run({scope,input:'read',provider}));
 assert.equal(executions,0);
 assert.deepEqual(events.flatMap(event=>event.type==='tool-result'?[event.result.code]:[]),
  ['UNKNOWN_TOOL','INVALID_ARGUMENTS','INVALID_ARGUMENTS','INVALID_ARGUMENTS']);
});

test('call and round budgets cannot be exceeded',async()=>{
 const provider:AgentProvider={async *stream({prior}){
  yield {type:'tool',id:String(prior.length),name:'unknown',args:{}};
 }};
 const run=(maxRounds:number,maxCalls:number)=>collect(createAgentLoop([],{maxRounds,maxCalls}).run({scope,input:'read',provider}));
 await assert.rejects(run(3,1),{code:'CALL_LIMIT'});
 await assert.rejects(run(1,3),{code:'ROUND_LIMIT'});
});

test('cancellation reaches a pending tool and prevents another provider round',async()=>{
 let started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 let observed:AbortSignal|undefined,rounds=0;
 const controller=new AbortController();
 const loop=createAgentLoop([{
  name:'workflow.get_draft',description:'Read',effect:'read',fields:{},
  execute(_args,context){observed=context.signal;started();return new Promise<string>(()=>{});},
 }]);
 const provider:AgentProvider={async *stream(){
  rounds++;
  yield {type:'tool',id:'read',name:'workflow.get_draft',args:{}};
 }};
 const run=collect(loop.run({scope,input:'read',provider,signal:controller.signal}));
 const rejected=assert.rejects(run,{name:'AbortError'});
 await ready;controller.abort();await rejected;
 assert.equal(observed?.aborted,true);
 assert.equal(rounds,1);
});

test('abort interrupts a waiting provider and an already-aborted call never starts it',async()=>{
 const controller=new AbortController();
 let started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 let observed:AbortSignal|undefined,count=0;
 const provider:AgentProvider={async *stream({signal}){
  count++;observed=signal;started();
  await new Promise<void>(()=>{});
  yield {type:'final'};
 }};
 const loop=createAgentLoop([]);
 const run=()=>collect(loop.run({scope,input:'read',provider,signal:controller.signal}));
 const result=assert.rejects(run(),{name:'AbortError'});
 await ready;controller.abort();await result;
 assert.equal(observed?.aborted,true);
 await assert.rejects(run(),{name:'AbortError'});
 assert.equal(count,1);
});

test('registry snapshots its contract and tool errors never expose raw details',async()=>{
 const fields={reference:{type:'string' as const,maxLength:5}};
 const loop=createAgentLoop([{
  name:'workflow.get_draft',description:'Read',effect:'read',fields,
  execute(){throw new Error('private server details');},
 }]);
 fields.reference.maxLength=99;
 const provider:AgentProvider={async *stream({tools,prior}){
  assert.equal(Object.isFrozen(tools[0].fields.reference),true);
  if(prior.length){yield {type:'final'};return;}
  yield {type:'tool',id:'1',name:'workflow.get_draft',args:{reference:'abcdef'}};
  yield {type:'tool',id:'2',name:'workflow.get_draft',args:{reference:'abc'}};
 }};
 const events=await collect(loop.run({scope,input:'read',provider}));
 assert.deepEqual(events.flatMap(event=>event.type==='tool-result'?[event.result.code]:[]),['INVALID_ARGUMENTS','TOOL_FAILED']);
 assert.doesNotMatch(JSON.stringify(events),/private server details/);
});

test('trusted material references reach adapter frozen; invalid types do not start provider',async()=>{
 const references=[{id:'material-1',mimeType:'image/png' as const},{id:'material-2',mimeType:'application/pdf' as const}];
 let calls=0;
 const provider:AgentProvider={async *stream({materials}){
  calls++;assert.deepEqual(materials,references);
  assert.ok(Object.isFrozen(materials)&&materials.every(Object.isFrozen));
  yield {type:'final'};
 }};
 const loop=createAgentLoop([]);
 assert.deepEqual(await collect(loop.run({scope,input:'read',provider,materials:references})),[{type:'final'}]);
 await assert.rejects(collect(loop.run({scope,input:'read',provider,
  materials:[{id:'material-1',mimeType:'text/html'}] as unknown as typeof references,
 })),{code:'INVALID_INPUT'});
 assert.equal(calls,1);
});
