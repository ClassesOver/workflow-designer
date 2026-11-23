/** Server-side reference loop. Scope and tool implementations come from trusted
 * application code, never from model output or request-body identity fields. */
export type Scope = Readonly<{userId:string;projectId:string;environment:string}>;
type MaterialMime = 'image/png'|'image/jpeg'|'application/pdf'|
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Opaque reference to material already authorized by the trusted caller. */
export type MaterialRef = Readonly<{id:string;mimeType:MaterialMime}>;
type Scalar = string | number | boolean;
type Fields = Readonly<Record<string, Readonly<
 {type:'string';maxLength:number;optional?:boolean} |
 {type:'number'|'boolean';optional?:boolean}
>>>;
type Args = Readonly<Record<string, Scalar>>;
type ToolDescriptor = Readonly<{name:string;description:string;effect:'read'|'proposal';fields:Fields}>;
export type AgentTool = ToolDescriptor & {
 execute(args:Args, context:{scope:Scope;signal:AbortSignal}):string|Promise<string>;
};
export type ProviderEvent =
 | {type:'text';text:string}
 | {type:'tool';id:string;name:string;args:unknown}
 | {type:'final'};
type ToolResult = Readonly<{id:string;name:string;args:Args} & (
 {ok:true;output:string;code?:never} |
 {ok:false;code:'UNKNOWN_TOOL'|'INVALID_ARGUMENTS'|'TOOL_FAILED';output?:never}
)>;
type Round = Readonly<{text:string;results:readonly ToolResult[]}>;
export interface AgentProvider {
 /** EOF after calls requests another round. A logical completion emits final. */
 stream(request:Readonly<{scope:Scope;input:string;tools:readonly ToolDescriptor[];
                          prior:readonly Round[];materials:readonly MaterialRef[];signal:AbortSignal}>):AsyncIterable<ProviderEvent>;
}
export type AgentEvent = {type:'text';text:string} | {type:'tool-result';result:ToolResult} | {type:'final'};

const toolName=/^[a-z][a-z0-9_.-]{0,79}$/;
const fieldName=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const reserved=new Set(['userId','projectId','environment','tenantId','subjectId','sessionId','scope','constructor','prototype']);
const materialMimes=new Set<MaterialMime>([
 'image/png','image/jpeg','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const emptyArgs:Args=Object.freeze(Object.create(null) as Args);
const fail=(code:string)=>Object.assign(new Error(code),{code});
const aborted=()=>new DOMException('Agent run cancelled.','AbortError');
function bound(value:number,min:number,max:number){
 if(!Number.isInteger(value)||value<min||value>max)throw fail('INVALID_CONFIGURATION');
 return value;
}
function checkAbort(signal:AbortSignal){if(signal.aborted)throw aborted();}
function abortable<T>(value:T|PromiseLike<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const cancel=()=>{signal.removeEventListener('abort',cancel);reject(aborted());}
  signal.addEventListener('abort',cancel,{once:true});
  Promise.resolve(value).then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));
  if(signal.aborted)cancel();
 });
}
function validArgs(raw:unknown,fields:Fields):Args|undefined{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
 const proto=Object.getPrototypeOf(raw);
 if(proto!==null&&proto!==Object.prototype)return;
 const source=raw as Record<string,unknown>;
 if(Object.keys(source).some(key=>!Object.hasOwn(fields,key)))return;
 const checked:Record<string,Scalar>=Object.create(null);
 for(const [key,field] of Object.entries(fields)){
  if(!Object.hasOwn(source,key)){if(field.optional)continue;return;}
  const value=source[key];
  if(field.type==='string'&&typeof value==='string'&&value.length<=field.maxLength)checked[key]=value;
  else if(field.type==='number'&&typeof value==='number'&&Number.isFinite(value))checked[key]=value;
  else if(field.type==='boolean'&&typeof value==='boolean')checked[key]=value;
  else return;
 }
 return Object.freeze(checked);
}

export function createAgentLoop(tools:readonly AgentTool[],{maxRounds=4,maxCalls=8}={}){
 bound(maxRounds,1,16);bound(maxCalls,1,64);bound(tools.length,0,64);
 const registry=new Map<string,{descriptor:ToolDescriptor;execute:AgentTool['execute']}>();
 for(const tool of tools){
  if(!toolName.test(tool.name)||registry.has(tool.name)||typeof tool.description!=='string'||
     tool.description.length>2000||typeof tool.execute!=='function'||
     (tool.effect!=='read'&&tool.effect!=='proposal'))throw fail('INVALID_CONFIGURATION');
  const fields:Record<string,Fields[string]>=Object.create(null);
  const entries=Object.entries(tool.fields);
  bound(entries.length,0,32);
  for(const [name,field] of entries){
   if(!fieldName.test(name)||reserved.has(name)||!field||
      !['string','number','boolean'].includes(field.type)||
      (field.optional!==undefined&&typeof field.optional!=='boolean'))throw fail('INVALID_CONFIGURATION');
   fields[name]=field.type==='string'
    ?Object.freeze({type:'string',maxLength:bound(field.maxLength,1,8192),optional:field.optional})
    :Object.freeze({type:field.type,optional:field.optional});
  }
  const descriptor=Object.freeze({name:tool.name,description:tool.description,effect:tool.effect,fields:Object.freeze(fields)});
  registry.set(tool.name,{descriptor,execute:tool.execute});
 }
 const descriptors=Object.freeze([...registry.values()].map(tool=>tool.descriptor));
 return {
  async *run({scope,input,provider,materials=[],signal:callerSignal}:{
   scope:Scope;input:string;provider:AgentProvider;materials?:readonly MaterialRef[];signal?:AbortSignal;
  }):AsyncGenerator<AgentEvent>{
   const {userId,projectId,environment}=scope;
   if([userId,projectId,environment].some(value=>typeof value!=='string'||!value.trim()||value.length>128)||
      typeof input!=='string'||!input.trim()||input.length>32_768)throw fail('INVALID_INPUT');
   if(!Array.isArray(materials)||materials.length>8)throw fail('INVALID_INPUT');
   const materialIds=new Set<string>();
   const trustedMaterials=Object.freeze(Array.from(materials,material=>{
    if(!material||typeof material.id!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/).test(material.id)||
       !materialMimes.has(material.mimeType)||materialIds.has(material.id))throw fail('INVALID_INPUT');
    materialIds.add(material.id);
    return Object.freeze({id:material.id,mimeType:material.mimeType}) as MaterialRef;
   }));
   const trustedScope=Object.freeze({userId,projectId,environment});
   const controller=new AbortController();
   const signal=callerSignal?AbortSignal.any([callerSignal,controller.signal]):controller.signal;
   const prior:Round[]=[];
   const seen=new Set<string>();
   let calls=0,characters=0,events=0;
   try {
    for(let round=0;round<maxRounds;round++){
     checkAbort(signal);
     const iterator=provider.stream({scope:trustedScope,input,tools:descriptors,prior:Object.freeze([...prior]),materials:trustedMaterials,signal})[Symbol.asyncIterator]();
     const results:ToolResult[]=[];
     let roundText='',done=false,finished=false;
     try{
      while(true){
       checkAbort(signal);
       const next=await abortable(iterator.next(),signal);
       checkAbort(signal);
       if(next.done){done=true;break;}
       if(++events>4096)throw fail('OUTPUT_LIMIT');
       const event=next.value;
       if(event?.type==='text'){
        if(typeof event.text!=='string')throw fail('PROVIDER_PROTOCOL');
        characters+=event.text.length;
        if(characters>131_072)throw fail('OUTPUT_LIMIT');
        roundText+=event.text;
        if(event.text)yield {type:'text',text:event.text};
       }else if(event?.type==='tool'){
        if(typeof event.id!=='string'||!event.id||event.id.length>128||seen.has(event.id)||
           typeof event.name!=='string'||!event.name||event.name.length>80)throw fail('PROVIDER_PROTOCOL');
        if(++calls>maxCalls)throw fail('CALL_LIMIT');
        seen.add(event.id);
        const tool=registry.get(event.name);
        const args=tool?validArgs(event.args,tool.descriptor.fields):undefined;
        const ref={id:event.id,name:event.name,args:args??emptyArgs};
        let result:ToolResult;
        if(!tool)result={...ref,ok:false,code:'UNKNOWN_TOOL'};
        else if(!args)result={...ref,ok:false,code:'INVALID_ARGUMENTS'};
        else {
         try {
          const output=await abortable(tool.execute(args,{scope:trustedScope,signal}),signal);
          checkAbort(signal);
          result=typeof output==='string'&&output.length<=8192
           ?{...ref,ok:true,output}:{...ref,ok:false,code:'TOOL_FAILED'};
         }catch{
          checkAbort(signal);
          result={...ref,ok:false,code:'TOOL_FAILED'};
         }
        }
        const safe=Object.freeze(result);
        results.push(safe);
        yield {type:'tool-result',result:safe};
       }else if(event?.type==='final'){
        if(results.length)throw fail('PROVIDER_PROTOCOL');
        finished=true;break;
       }else throw fail('PROVIDER_PROTOCOL');
      }
     }finally{
      // A non-cooperative adapter must not block cancellation by hanging in cleanup.
      if(!done){controller.abort();void Promise.resolve().then(()=>iterator.return?.()).catch(()=>{});}
     }
     if(finished){yield {type:'final'};return;}
     if(!results.length)throw fail('PROVIDER_PROTOCOL');
     prior.push(Object.freeze({text:roundText,results:Object.freeze(results)}));
    }
    throw fail('ROUND_LIMIT');
   }finally{controller.abort();}
  },
 };
}
