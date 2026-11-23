import test from 'node:test';
import assert from 'node:assert/strict';
import {createResponsesProvider} from '../src/responses-provider.ts';
import {createAgentLoop} from '../src/ai-core.ts';

const scope={userId:'user',projectId:'studio',environment:'test'};
const done=(output:unknown[])=>({type:'response.completed',response:{status:'completed',output}});
const sse=(...events:unknown[])=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
const text=(delta:string)=>({type:'response.output_text.delta',delta});
const message=(text:string)=>({type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}],status:'completed'});
const tool={name:'workflow.propose_patch',description:'Stage a proposal',effect:'proposal' as const,fields:{value:{type:'string' as const,maxLength:16}},execute:({value}:Readonly<Record<string,string|number|boolean>>)=>String(value)};
async function collect(events:AsyncIterable<unknown>){const all=[];for await(const event of events)all.push(event);return all;}

test('Responses tool call replay stays stateless and only resolves scoped attachments once',async()=>{
 const requests:any[]=[];let reads=0;
 const call={type:'function_call',id:'fc_1',call_id:'call_1',name:'tool_0',arguments:'{"value":"12.00"}',status:'completed'};
 const reasoning={type:'reasoning',id:'rs_1',summary:[],encrypted_content:'opaque-ciphertext',status:'completed'};
 const assistant={...message('提案'),id:'msg_1',content:[{type:'output_text',text:'提案',
  annotations:[{type:'file_citation',file_id:'file_1',filename:'source.pdf',index:0}]}]};
 const provider=createResponsesProvider({model:'configured-model',apiKey:'TEST_VALUE',
  async resolveMaterial(context,ref){
   assert.deepEqual(context.scope,scope);assert.equal(context.signal.aborted,false);reads++;
   return {mimeType:ref.mimeType,bytes:new Uint8Array([1,2,3])};
  },
  async fetchImpl(url,init){
   assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'error');
   const body=JSON.parse(String(init?.body));requests.push(body);
   return requests.length===1?sse(text('提案'),
    {type:'response.output_item.done',output_index:0,item:reasoning},
    {type:'response.output_item.done',output_index:1,item:assistant},
    {type:'response.output_item.done',output_index:2,item:call},
    done([{...reasoning,encrypted_content:null},assistant,call])):sse(text('完成'),done([message('完成')]));
  },
 });
 const materials=[{id:'img',mimeType:'image/png' as const},{id:'pdf',mimeType:'application/pdf' as const},
  {id:'doc',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const}];
 const events=await collect(createAgentLoop([tool]).run({scope,input:'调整阈值',provider,materials}));
 assert.equal(reads,3);assert.equal(requests.length,2);
 for(const body of requests){
  assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.model,'configured-model');
  assert.equal(body.previous_response_id,undefined);assert.deepEqual(body.include,['reasoning.encrypted_content']);
  assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,AQID');
  assert.equal(body.input[0].content[2].type,'input_file');assert.equal(body.input[0].content[2].filename,'material-2.pdf');
  assert.equal(body.input[0].content[3].filename,'material-3.docx');
  assert.equal(body.tools[0].name,'tool_0');assert.equal(body.tools[0].parameters.additionalProperties,false);
 }
 assert.deepEqual(requests[1].input[1],reasoning);
 assert.deepEqual(requests[1].input[2],assistant);
 assert.deepEqual(requests[1].input.at(-2),call);
 assert.deepEqual(requests[1].input.at(-1),{type:'function_call_output',call_id:'call_1',output:'12.00'});
 assert.deepEqual(events,[{type:'text',text:'提案'},{type:'tool-result',result:{id:'call_1',name:'workflow.propose_patch',args:Object.assign(Object.create(null),{value:'12.00'}),ok:true,output:'12.00'}},{type:'text',text:'完成'},{type:'final'}]);
});

test('failure, incomplete, unknown output and missing terminal never execute a tool',async()=>{
 let executions=0;
 const loop=createAgentLoop([{...tool,execute(){executions++;return'no';}}]);
 const call={type:'function_call',call_id:'call_1',name:'tool_0',arguments:'{"value":"12"}'};
 for(const [events,code] of [
  [[{type:'response.output_item.done',output_index:0,item:{...call,id:'fc_1'}},{type:'response.failed',response:{error:{message:'private'}}}],'PROVIDER_FAILED'],
  [[{type:'response.incomplete'}],'PROVIDER_INCOMPLETE'],
  [[done([{type:'web_search_call'}])],'PROVIDER_PROTOCOL'],
  [[text('partial')],'PROVIDER_PROTOCOL'],
 ] as const){
  const provider=createResponsesProvider({model:'configured-model',apiKey:'TEST_VALUE',fetchImpl:async()=>sse(...events)});
  await assert.rejects(collect(loop.run({scope,input:'read',provider})),{code,message:code});
 }
 assert.equal(executions,0);
});

test('caller cancellation reaches injected fetch without final success',async()=>{
 const controller=new AbortController();let started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 const provider=createResponsesProvider({model:'configured-model',apiKey:'TEST_VALUE',fetchImpl:async(_url,init)=>{
  started();return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));
 }});
 const pending=assert.rejects(collect(createAgentLoop([]).run({scope,input:'read',provider,signal:controller.signal})),{name:'AbortError'});
 await ready;controller.abort();await pending;
});

test('fragmented SSE UTF-8 and terminal-only text are accepted without duplicates',async()=>{
 const payload=new TextEncoder().encode(
  'event: response.output_text.delta\r\ndata: '+JSON.stringify(text('图'))+'\r\n\r\n'+
  'event: response.completed\r\ndata: '+JSON.stringify(done([message('图')]))+'\r\n\r\n',
 );
 const body=new ReadableStream<Uint8Array>({
  start(controller){for(const byte of payload)controller.enqueue(Uint8Array.of(byte));controller.close();},
 });
 const fake=[new Response(body,{headers:{'Content-Type':'text/event-stream'}}),sse(done([message('图')]))];
 const provider=createResponsesProvider({model:'configured-model',apiKey:'TEST_VALUE',fetchImpl:async()=>fake.shift()!});
 for(let i=0;i<2;i++)assert.deepEqual(await collect(createAgentLoop([]).run({scope,input:'read',provider})),
  [{type:'text',text:'图'},{type:'final'}]);
});

test('conflicting item IDs, order, tool arguments, or ciphertext fail before executing',async()=>{
 let calls=0;
 const loop=createAgentLoop([{...tool,execute(){calls++;return 'never';}}]);
 const fn={type:'function_call',id:'fc_1',call_id:'call_1',name:'tool_0',arguments:'{"value":"12"}',status:'completed'};
 const rs={type:'reasoning',id:'rs_1',summary:[],encrypted_content:'original'};
 for(const [output_index,item,output] of [
  [0,{...fn,id:'fc_other'},[fn]],
  [1,fn,[fn]],
  [0,{...fn,arguments:'{"value":"13"}'},[fn]],
  [0,rs,[{...rs,encrypted_content:'different'},fn]],
 ] as const){
  const provider=createResponsesProvider({model:'configured-model',apiKey:'TEST_VALUE',fetchImpl:async()=>
   sse({type:'response.output_item.done',output_index,item},done([...output]))});
  await assert.rejects(collect(loop.run({scope,input:'read',provider})),{code:'PROVIDER_PROTOCOL'});
 }
 assert.equal(calls,0);
});
