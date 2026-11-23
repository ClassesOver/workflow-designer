import type {AgentProvider,MaterialRef,ProviderEvent,Scope} from './ai-core.ts';

type Options={
 model:string;apiKey:string;fetchImpl?:typeof fetch;
 /** Resolves only from the caller's already-authorized material store. */
 resolveMaterial?(context:{scope:Scope;signal:AbortSignal},ref:MaterialRef):
  Promise<{mimeType:MaterialRef['mimeType'];bytes:Uint8Array}>;
};
type Obj=Record<string,unknown>;
type Request=Parameters<AgentProvider['stream']>[0];
type Call={item:Obj;event:Extract<ProviderEvent,{type:'tool'}>};
const endpoint='https://api.openai.com/v1/responses';
const maxFile=8*1024*1024,maxMaterials=16*1024*1024,maxStream=4*1024*1024;
const publicErrors=new Set(['PROVIDER_OUTPUT_LIMIT','PROVIDER_PROTOCOL','PROVIDER_FAILED',
 'PROVIDER_INCOMPLETE','PROVIDER_REFUSED','PROVIDER_UNAVAILABLE','MATERIAL_UNAVAILABLE','MATERIAL_INVALID']);
const problem=(code:string)=>Object.assign(new Error(code),{code});
const record=(x:unknown):x is Obj=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const checkAbort=(signal:AbortSignal)=>{if(signal.aborted)throw new DOMException('Agent run cancelled.','AbortError');};
const allowedEvents=new Set([
 'response.created','response.in_progress','response.output_item.added',
 'response.content_part.added','response.content_part.done','response.output_text.done','response.output_text.annotation.added',
 'response.function_call_arguments.delta','response.function_call_arguments.done','response.reasoning_summary_part.added',
 'response.reasoning_summary_part.done','response.reasoning_summary_text.delta','response.reasoning_summary_text.done',
 'response.reasoning_text.delta','response.reasoning_text.done','response.refusal.delta','response.refusal.done',
]);
function dataUrl(bytes:Uint8Array,mime:string){
 const chunks:string[]=[];
 for(let i=0;i<bytes.length;i+=8192)chunks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
 return 'data:'+mime+';base64,'+btoa(chunks.join(''));
}
async function inputMessage(request:Request,resolver:Options['resolveMaterial']){
 const content:Obj[]=[{type:'input_text',text:request.input}];
 let total=0;
 for(const [index,ref] of request.materials.entries()){
  checkAbort(request.signal);
  if(!resolver)throw problem('MATERIAL_UNAVAILABLE');
  let material;
  try{material=await resolver({scope:request.scope,signal:request.signal},ref);}
  catch{checkAbort(request.signal);throw problem('MATERIAL_UNAVAILABLE');}
  checkAbort(request.signal);
  if(!material||material.mimeType!==ref.mimeType||!(material.bytes instanceof Uint8Array)||
   !material.bytes.byteLength||material.bytes.byteLength>maxFile||
   (total+=material.bytes.byteLength)>maxMaterials)throw problem('MATERIAL_INVALID');
  const url=dataUrl(material.bytes,material.mimeType);
  if(ref.mimeType==='image/png'||ref.mimeType==='image/jpeg')content.push({type:'input_image',image_url:url,detail:'auto'});
  else content.push({type:'input_file',file_data:url,filename:'material-'+(index+1)+(ref.mimeType==='application/pdf'?'.pdf':'.docx')});
 }
 return {role:'user',content};
}
async function* parseSse(body:ReadableStream<Uint8Array>,signal:AbortSignal){
 const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let pending='',data:string[]=[],total=0,finished=false;
 const cancel=()=>{void reader.cancel().catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try{
  while(true){
   checkAbort(signal);
   const chunk=await reader.read();
   checkAbort(signal);
   if(!chunk.done&&(total+=chunk.value.byteLength)>maxStream)throw problem('PROVIDER_OUTPUT_LIMIT');
   pending+=chunk.done?decoder.decode():decoder.decode(chunk.value,{stream:true});
   let newline:number;
   while((newline=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,newline).replace(/\r$/,'');
    pending=pending.slice(newline+1);
    if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
    if(!line&&data.length){
     const payload=data.join('\n');data=[];
     if(payload==='[DONE]')return;
     let event:unknown;
     try{event=JSON.parse(payload);}catch{throw problem('PROVIDER_PROTOCOL');}
     if(!record(event)||typeof event.type!=='string')throw problem('PROVIDER_PROTOCOL');
     yield event;
    }
   }
   if(chunk.done){finished=true;return;}
  }
 }finally{
  signal.removeEventListener('abort',cancel);
  if(!finished)cancel();
  reader.releaseLock();
 }
}

const outputId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
const indexValue=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const annotationFields:Record<string,readonly string[]> = {
 file_citation:['file_id','filename','index'],
 url_citation:['url','title','start_index','end_index'],
 container_file_citation:['container_id','file_id','filename','start_index','end_index'],
 file_path:['file_id','index'],
};
function annotations(value:unknown){
 if(!Array.isArray(value))throw problem('PROVIDER_PROTOCOL');
 return value.map(annotation=>{
  if(!record(annotation)||typeof annotation.type!=='string'||
    !Object.hasOwn(annotationFields,annotation.type))throw problem('PROVIDER_PROTOCOL');
  const result:Obj={type:annotation.type};
  for(const key of annotationFields[annotation.type]){
   if(key==='index'||key.endsWith('_index')?!indexValue(annotation[key]):typeof annotation[key]!=='string')
    throw problem('PROVIDER_PROTOCOL');
   result[key]=annotation[key];
  }
  return result;
 });
}
function tokenLogprob(value:unknown,top=false):Obj{
 if(!record(value)||typeof value.token!=='string'||typeof value.logprob!=='number'||!Number.isFinite(value.logprob))
  throw problem('PROVIDER_PROTOCOL');
 const result:Obj={token:value.token,logprob:value.logprob};
 if(value.bytes!==undefined){
  if(!Array.isArray(value.bytes)||!value.bytes.every(byte=>indexValue(byte)&&byte<=255))throw problem('PROVIDER_PROTOCOL');
  result.bytes=value.bytes;
 }
 if(value.top_logprobs!==undefined){
  if(top||!Array.isArray(value.top_logprobs))throw problem('PROVIDER_PROTOCOL');
  result.top_logprobs=value.top_logprobs.map(token=>tokenLogprob(token,true));
 }
 return result;
}
function checkedOutput(raw:unknown):Obj{
 if(!record(raw)||(raw.id!==undefined&&!outputId(raw.id))||
   (raw.status!==undefined&&raw.status!=='completed'))throw problem('PROVIDER_PROTOCOL');
 const common={...(raw.id!==undefined?{id:raw.id}:{}),...(raw.status!==undefined?{status:raw.status}:{})};
 if(raw.type==='function_call'){
  if(!outputId(raw.call_id)||typeof raw.name!=='string'||!/^tool_(0|[1-9][0-9]?)$/.test(raw.name)||
     typeof raw.arguments!=='string'||raw.arguments.length>131072)throw problem('PROVIDER_PROTOCOL');
  return {type:raw.type,...common,call_id:raw.call_id,name:raw.name,arguments:raw.arguments};
 }
 if(raw.type==='reasoning'){
  if(!outputId(raw.id)||!Array.isArray(raw.summary))throw problem('PROVIDER_PROTOCOL');
  const parts=(list:unknown[],type:string)=>list.map(part=>{
   if(!record(part)||part.type!==type||typeof part.text!=='string')throw problem('PROVIDER_PROTOCOL');
   return {type,text:part.text};
  });
  const item:Obj={type:raw.type,...common,summary:parts(raw.summary,'summary_text')};
  if(raw.content!==undefined){
   if(!Array.isArray(raw.content))throw problem('PROVIDER_PROTOCOL');
   item.content=parts(raw.content,'reasoning_text');
  }
  if(raw.encrypted_content!==undefined&&raw.encrypted_content!==null){
   if(typeof raw.encrypted_content!=='string'||!raw.encrypted_content)throw problem('PROVIDER_PROTOCOL');
   item.encrypted_content=raw.encrypted_content;
  }
  return item;
 }
 if(raw.type==='message'&&raw.role==='assistant'&&Array.isArray(raw.content)){
  const content=raw.content.map(part=>{
   if(!record(part))throw problem('PROVIDER_PROTOCOL');
   if(part.type==='refusal'&&typeof part.refusal==='string')throw problem('PROVIDER_REFUSED');
   if(part.type!=='output_text'||typeof part.text!=='string')throw problem('PROVIDER_PROTOCOL');
   const checked:Obj={type:part.type,text:part.text,annotations:annotations(part.annotations)};
   if(part.logprobs!==undefined){
    if(!Array.isArray(part.logprobs))throw problem('PROVIDER_PROTOCOL');
    checked.logprobs=part.logprobs.map(value=>tokenLogprob(value));
   }
   return checked;
  });
  const item:Obj={type:raw.type,...common,role:raw.role,content};
  if(raw.phase!==undefined){
   if(raw.phase!==null&&raw.phase!=='commentary'&&raw.phase!=='final_answer')throw problem('PROVIDER_PROTOCOL');
   item.phase=raw.phase;
  }
  return item;
 }
 throw problem('PROVIDER_PROTOCOL');
}
function completedOutput(raw:unknown,tools:Request['tools'],streamedItems:Map<number,Obj>){
 if(!record(raw)||raw.status!=='completed'||!Array.isArray(raw.output)||!raw.output.length||raw.output.length>64)
  throw problem('PROVIDER_PROTOCOL');
 const calls:Call[]=[],items:Obj[]=[],seenCalls=new Set<string>(),seenIds=new Set<string>();
 let finalText='';
 for(const [index,output] of raw.output.entries()){
  const item=checkedOutput(output);
  if(typeof item.id==='string'){
   if(seenIds.has(item.id))throw problem('PROVIDER_PROTOCOL');
   seenIds.add(item.id);
  }
  const streamed=streamedItems.get(index);
  if(streamed){
   // Only the encrypted reasoning payload may be missing from the final copy.
   // ID, position, type and all other normalized fields must agree.
   const {encrypted_content:finalCipher,...finalRest}=item;
   const {encrypted_content:streamCipher,...streamRest}=streamed;
   if(JSON.stringify(finalRest)!==JSON.stringify(streamRest)||
      (finalCipher!==undefined&&streamCipher!==undefined&&finalCipher!==streamCipher))
    throw problem('PROVIDER_PROTOCOL');
   if(finalCipher===undefined&&streamCipher!==undefined)item.encrypted_content=streamCipher;
   streamedItems.delete(index);
  }
  items.push(item);
  if(item.type==='function_call'){
   const callId=item.call_id as string,wireName=item.name as string,serialized=item.arguments as string;
   const tool=tools[Number(wireName.slice(5))];
   if(!tool||seenCalls.has(callId))throw problem('PROVIDER_PROTOCOL');
   let args:unknown;
   try{args=JSON.parse(serialized);}catch{throw problem('PROVIDER_PROTOCOL');}
   seenCalls.add(callId);
   calls.push({item,event:{type:'tool',id:callId,name:tool.name,args}});
  }else if(item.type==='message'){
   for(const part of item.content as {text:string}[])finalText+=part.text;
  }
 }
 if(streamedItems.size||calls.length&&items.some(item=>item.type==='reasoning'&&!item.encrypted_content))
  throw problem('PROVIDER_PROTOCOL');
 return {items,calls,finalText};
}

export function createResponsesProvider({model,apiKey,fetchImpl=fetch,resolveMaterial}:Options):AgentProvider{
 if(!model.trim()||!apiKey.trim()||/[\r\n]/.test(apiKey))throw problem('INVALID_CONFIGURATION');
 // One in-memory conversation per core-run signal, never stored provider IDs.
 // Stateless requests repeat initial input parts, but resolve material bytes only once.
 const state=new WeakMap<AbortSignal,{scope:Scope;initial:Obj;history:Obj[];expected:Call[]}>();
 return {
  async *stream(request){
   const {signal,scope,prior,tools}=request;
   checkAbort(signal);
   try{
    let run=state.get(signal);
    if(!prior.length){
     if(run)throw problem('PROVIDER_PROTOCOL');
     run={scope,initial:await inputMessage(request,resolveMaterial),history:[],expected:[]};
     state.set(signal,run);
     signal.addEventListener('abort',()=>state.delete(signal),{once:true});
    }else{
     if(!run||run.scope!==scope)throw problem('PROVIDER_PROTOCOL');
     const results=prior.at(-1)?.results;
     if(!results||results.length!==run.expected.length||!results.length)throw problem('PROVIDER_PROTOCOL');
     for(const [i,result] of results.entries()){
      if(result.id!==run.expected[i].event.id||result.name!==run.expected[i].event.name)throw problem('PROVIDER_PROTOCOL');
      run.history.push({type:'function_call_output',call_id:result.id,output:result.ok?result.output:JSON.stringify({code:result.code})});
     }
    }
    checkAbort(signal);
    const wireTools=tools.map((tool,index)=>({
     type:'function',name:'tool_'+index,description:tool.name+': '+tool.description,strict:false,
     parameters:{type:'object',additionalProperties:false,
      required:Object.entries(tool.fields).filter(([,field])=>!field.optional).map(([name])=>name),
      properties:Object.fromEntries(Object.entries(tool.fields).map(([name,field])=>[
       name,field.type==='string'?{type:'string',maxLength:field.maxLength}:{type:field.type},
      ]))},
    }));
    let response:Response;
    try{
     response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal,headers:{
      authorization:'Bearer '+apiKey,'content-type':'application/json',accept:'text/event-stream',
     },body:JSON.stringify({model,stream:true,store:false,include:['reasoning.encrypted_content'],
      max_output_tokens:4096,input:[run.initial,...run.history],tools:wireTools})});
    }catch{checkAbort(signal);throw problem('PROVIDER_UNAVAILABLE');}
    checkAbort(signal);
    if(!response.ok||!response.body||!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')){
     void response.body?.cancel().catch(()=>{});
     throw problem('PROVIDER_UNAVAILABLE');
    }
    let settled:ReturnType<typeof completedOutput>|undefined,streamedText='';
    const streamedItems=new Map<number,Obj>();
    for await(const event of parseSse(response.body,signal)){
     if(event.type==='response.output_text.delta'){
      if(typeof event.delta!=='string')throw problem('PROVIDER_PROTOCOL');
      streamedText+=event.delta;
      yield {type:'text',text:event.delta};
     }else if(event.type==='response.output_item.done'){
      const index=event.output_index;
      if(!indexValue(index)||index>=64||streamedItems.has(index))throw problem('PROVIDER_PROTOCOL');
      const item=checkedOutput(event.item);
      if(!outputId(item.id))throw problem('PROVIDER_PROTOCOL');
      streamedItems.set(index,item);
     }else if(event.type==='response.completed'){
      settled=completedOutput(event.response,tools,streamedItems);break;
     }else if(event.type==='response.failed'||event.type==='error')throw problem('PROVIDER_FAILED');
     else if(event.type==='response.incomplete')throw problem('PROVIDER_INCOMPLETE');
     else if(!allowedEvents.has(String(event.type)))throw problem('PROVIDER_PROTOCOL');
    }
    if(!settled||(streamedText&&streamedText!==settled.finalText))throw problem('PROVIDER_PROTOCOL');
    if(!streamedText&&settled.finalText)yield {type:'text',text:settled.finalText};
    if(!settled.calls.length){state.delete(signal);yield {type:'final'};return;}
    run.history.push(...settled.items);run.expected=settled.calls;
    for(const call of settled.calls){checkAbort(signal);yield call.event;}
   }catch(error){
    state.delete(signal);
    checkAbort(signal);
    if(record(error)&&typeof error.code==='string'&&publicErrors.has(error.code))throw problem(error.code);
    throw problem('PROVIDER_PROTOCOL');
   }
  },
 };
}
