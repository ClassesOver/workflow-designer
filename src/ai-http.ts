import { randomUUID } from 'node:crypto';
import type { AgentProvider, MaterialRef, Scope } from './ai-core.ts';
import { createWorkflowAgent } from './workflow-agent.ts';
import { ProposalStoreError } from './proposal-store.ts';
import type { Operation, ProposalScope, ProposalStore } from './proposal-store.ts';

type Catalog = Parameters<typeof createWorkflowAgent>[0]['catalog'];
type Grant = {scope: ProposalScope; canRun: boolean; canConfirm: boolean; canPrepare?:boolean; canAudit?:boolean; canRead?:boolean};
type Dependencies = {
  store: ProposalStore;
  provider: AgentProvider;
  upload?: {
    mode: 'scripted'|'openai';
    bind(scope: Scope, ref: MaterialRef, bytes: Uint8Array): AgentProvider;
  };
  /** Must authenticate the request and authorize this workflow on every invocation.
   * For cookie auth also enforce origin/CSRF on POST. Never read scope from JSON. */
  authorize(request: Request, workflowId: string): Promise<Grant|null>;
  catalog(scope: Scope, workflowId: string, signal: AbortSignal): Promise<Catalog>;
  /** Resolve exactly the requested IDs against this authenticated workflow. */
  resolveMaterials(ids: readonly string[], scope: Scope, workflowId: string, signal: AbortSignal): Promise<readonly MaterialRef[]>;
};
const safeId=/^[a-zA-Z0-9_-]{1,128}$/;
const bodyLimit=64*1024;
const fileLimit=8*1024*1024;
export const uploadBodyLimit=fileLimit+192*1024;
const encode=new TextEncoder();
const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const only=(v: Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
class HttpError extends Error {
  readonly status: number; readonly code: string;
  constructor(status:number,code:string){super(code);this.status=status;this.code=code;}
}
const fail=(status:number,code:string):never=>{throw new HttpError(status,code);};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const sameScope=(a:ProposalScope,b:ProposalScope)=>a.userId===b.userId&&a.workspaceId===b.workspaceId&&
 a.projectId===b.projectId&&a.environment===b.environment;
const validRevision=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1;
function parseOperation(value:unknown):Operation {
 if(!isRecord(value)||!only(value,['kind','edgeId','value'])||value.kind!=='set_amount_threshold'||
  typeof value.edgeId!=='string'||!safeId.test(value.edgeId)||typeof value.value!=='number'||
  !Number.isFinite(value.value)||value.value<0)
   return fail(422,'invalid_operation');
 return {kind:value.kind,edgeId:value.edgeId,value:value.value};
}
function queryInteger(query:URLSearchParams,key:string):number|undefined {
 const values=query.getAll(key);
 if(!values.length)return;
 if(values.length!==1||!(/^[1-9][0-9]{0,15}$/).test(values[0])||!validRevision(Number(values[0])))
   return fail(400,'invalid_audit_query');
 return Number(values[0]);
}
function safeError(error:unknown):{status:number;code:string} {
  if(error instanceof HttpError)return error;
  if(error instanceof ProposalStoreError){
    const status=({invalid_scope:400,invalid_input:400,invalid_operation:422,not_found:404,revision_conflict:409,expired:410,already_exists:409})[error.code];
    return {status:status??500,code:status?error.code:'internal_error'};
  }
  if (error instanceof DOMException && error.name==='AbortError') return {status:499,code:'cancelled'};
  if (error instanceof DOMException && error.name==='TimeoutError') return {status:504,code:'turn_timeout'};
  if (error instanceof Error && 'code' in error) {
    if (error.code==='PROVIDER_UNAVAILABLE') return {status:502,code:'model_unavailable'};
    if (error.code==='MATERIAL_INVALID'||error.code==='MATERIAL_UNAVAILABLE') return {status:422,code:'material_unreadable'};
    if (error.code==='PROVIDER_INCOMPLETE'||error.code==='OUTPUT_LIMIT'||error.code==='PROVIDER_OUTPUT_LIMIT')
      return {status:502,code:'model_output_incomplete'};
    if (error.code==='PROVIDER_REFUSED') return {status:422,code:'model_refused'};
    if (error.code==='CALL_LIMIT'||error.code==='ROUND_LIMIT') return {status:422,code:'turn_budget_exceeded'};
  }
  return {status:500,code:'internal_error'};
}
async function readBody(request:Request):Promise<Record<string,unknown>> {
  if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return fail(415,'json_required');
  if(Number(request.headers.get('content-length'))>bodyLimit)return fail(413,'body_too_large');
  const reader=request.body?.getReader();
  if(!reader)return fail(400,'invalid_body');
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(10_000)]);
  const abortRead=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal.addEventListener('abort',abortRead,{once:true});
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let length=0, raw='',complete=false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const {done,value}=await reader.read();
      signal.throwIfAborted();
      if(done){complete=true;break;}
      length+=value.byteLength;
      if(length>bodyLimit)return fail(413,'body_too_large');
      raw+=decoder.decode(value,{stream:true});
    }
    raw+=decoder.decode();
    const body:unknown=JSON.parse(raw);
    if (!isRecord(body))return fail(400,'invalid_body');
    return body;
  } catch(error) {
    if(signal.aborted)throw signal.reason;
    if(error instanceof HttpError)throw error;
    return fail(400,'invalid_body');
  } finally {
    signal.removeEventListener('abort',abortRead);
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
async function readUpload(request:Request, mode:'scripted'|'openai', signal:AbortSignal):Promise<{input:string;revision:number;ref:MaterialRef;bytes:Uint8Array}> {
  const contentType=request.headers.get('content-type')??'';
  if(!/^multipart\/form-data\s*;\s*boundary=(?:"[A-Za-z0-9_-]{1,70}"|[A-Za-z0-9_-]{1,70})$/i.test(contentType))
    return fail(415,'multipart_required');
  if(Number(request.headers.get('content-length'))>uploadBodyLimit)return fail(413,'material_too_large');
  const reader=request.body?.getReader();
  if(!reader)return fail(400,'invalid_body');
  const abortRead=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal.addEventListener('abort',abortRead,{once:true});
  const chunks:Uint8Array<ArrayBuffer>[]=[];
  let size=0,complete=false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk=await reader.read();
      if(chunk.done){complete=true;break;}
      size+=chunk.value.byteLength;
      if(size>uploadBodyLimit)return fail(413,'material_too_large');
      chunks.push(new Uint8Array(chunk.value));
    }
    signal.throwIfAborted();
    let form:FormData;
    try {
      form=await new Response(new Blob(chunks),{headers:{'content-type':contentType}}).formData();
    } catch {
      return fail(400,'invalid_body');
    }
    signal.throwIfAborted();
    const inputs=form.getAll('input'),files=form.getAll('file'),consents=form.getAll('consent');
    const revisions=form.getAll('expectedRevision');
    const input=inputs[0],file=files[0],rawRevision=revisions[0];
    if([...form.keys()].some(key=>!['input','file','consent','expectedRevision'].includes(key))||
       inputs.length!==1||files.length!==1||consents.length>1||typeof input!=='string'||
       !input.trim()||input.length>32_768||!(file instanceof File))
       return fail(400,'invalid_turn');
    const revision=Number(rawRevision);
    if(revisions.length!==1||typeof rawRevision!=='string'||!(/^[1-9][0-9]{0,15}$/).test(rawRevision)||!Number.isSafeInteger(revision))
      return fail(400,'invalid_revision');
    if(mode==='openai'&&consents[0]!=='openai')return fail(400,'material_consent_required');
    if(mode==='scripted'&&consents.length)return fail(409,'material_mode_changed');
    if(file.size>fileLimit)return fail(413,'material_too_large');
    const mimeType=file.type;
    const header=new Uint8Array(await file.slice(0,8).arrayBuffer());
    const starts=(...signature:number[])=>signature.every((value,index)=>header[index]===value);
    if(!((mimeType==='image/png'&&starts(137,80,78,71,13,10,26,10))||
         (mimeType==='image/jpeg'&&starts(255,216,255))||
         (mimeType==='application/pdf'&&starts(37,80,68,70,45))))
      return fail(415,'unsupported_material');
    const bytes=new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    return {input,revision,ref:{id:randomUUID(),mimeType},bytes};
  } finally {
    signal.removeEventListener('abort',abortRead);
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
function acceptedOperation(output:string,target:{workflowId:string;revision:number;environment:string}):Operation|undefined {
  const data:unknown=JSON.parse(output);
  if(!isRecord(data)||data.workflowId!==target.workflowId||data.baseRevision!==String(target.revision)||
     data.environment!==target.environment||!Array.isArray(data.operations)||data.operations.length>1)return fail(502,'invalid_proposal');
  if(!data.operations.length)return;
  const op:unknown=data.operations[0];
  if(!isRecord(op)||!only(op,['op','edgeId','value'])||op.op!=='set_amount_threshold'||typeof op.edgeId!=='string'||
     typeof op.value!=='number'||!Number.isFinite(op.value)||op.value<0)return fail(502,'invalid_proposal');
  return {kind:op.op,edgeId:op.edgeId,value:op.value};
}

/** Fetch-compatible adapter. Deployment owns authentication, rate limits, HTTP hosting and object storage. */
export function createAiHttp(deps:Dependencies):(request:Request)=>Promise<Response> {
  return async request=>{
    try {
      const url=new URL(request.url);
      const parts=url.pathname.split('/');
      const [empty,version,app,resource,workflowId,action,proposalId,verb,...extra]=parts;
      if(empty!==''||version!=='v1'||app!=='ai'||resource!=='workflows'||!safeId.test(workflowId??'')||extra.length)return fail(404,'not_found');
      const isUpload=action==='turn-with-material'&&proposalId===undefined&&deps.upload!==undefined;
      const isTurn=(action==='turn'&&proposalId===undefined)||isUpload;
      const isDraft=action===undefined;
      const isProposal=action==='proposals'&&safeId.test(proposalId??'')&&(verb===undefined||verb==='confirm');
      const isPrepare=action==='proposals'&&proposalId===undefined;
      const isAudit=action==='audit'&&proposalId===undefined;
      const isConfirm=isProposal&&verb==='confirm';
      if(!isDraft&&!isTurn&&!isProposal&&!isPrepare&&!isAudit)return fail(404,'not_found');
      if (request.method!==((isTurn||isConfirm||isPrepare)?'POST':'GET'))return json({error:'method_not_allowed'},405);
      if(url.search&&!isAudit)return fail(404,'not_found');
      const grant=await deps.authorize(request,workflowId);
      if(!grant)return fail(404,'not_found');
      const scope:ProposalScope={userId:grant.scope.userId,projectId:grant.scope.projectId,environment:grant.scope.environment,
        ...(grant.scope.workspaceId!==undefined?{workspaceId:grant.scope.workspaceId}:{})};

      if(isAudit){
        if(!scope.workspaceId||!grant.canAudit)return fail(403,'audit_forbidden');
        if(Array.from(url.searchParams.keys()).some(key=>!['before','limit'].includes(key)))return fail(400,'invalid_audit_query');
        const before=queryInteger(url.searchParams,'before'),limit=queryInteger(url.searchParams,'limit')??25;
        if(limit>100)return fail(400,'invalid_audit_query');
        if(!deps.store.getDraft(scope,workflowId))return fail(404,'not_found');
        const events=deps.store.listAudit(scope,workflowId,{before,limit});
        return json({events,nextBefore:events.length===limit?events.at(-1)?.revision:null});
      }
      if(isPrepare){
        if(!scope.workspaceId||!grant.canPrepare)return fail(403,'preparation_forbidden');
        const body=await readBody(request);
        if(!only(body,['expectedRevision','operation'])||!validRevision(body.expectedRevision))return fail(400,'invalid_revision');
        const operation=parseOperation(body.operation);
        const current=await deps.authorize(request,workflowId);
        if(!current?.canPrepare||!sameScope(current.scope,scope))return fail(403,'preparation_forbidden');
        request.signal.throwIfAborted();
        return json({proposal:deps.store.prepare(scope,workflowId,body.expectedRevision,operation)},201);
      }

      if(scope.workspaceId&&grant.canRead!==true&&(isDraft||(isProposal&&!isConfirm)))return fail(403,'read_forbidden');
      if(isProposal){
        if(isConfirm&&!grant.canConfirm)return fail(403,'confirmation_forbidden');
        const proposal=deps.store.getProposal(scope,proposalId);
        if(!proposal||proposal.workflowId!==workflowId)return fail(404,'not_found');
        if(!isConfirm)return json({proposal});
        const body=await readBody(request);
        const revision=body.expectedRevision;
        if(!only(body,['expectedRevision'])||typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1)return fail(400,'invalid_revision');
        // Recheck after the await on the client-controlled body and immediately before SQLite CAS.
        const current=await deps.authorize(request,workflowId);
        if(!current?.canConfirm||!sameScope(current.scope,scope))
          return fail(403,'confirmation_forbidden');
        request.signal.throwIfAborted();
        return json({receipt:deps.store.confirm(scope,proposalId,revision)});
      }

      if(isTurn&&!grant.canRun)return fail(403,'run_forbidden');
      let draft=deps.store.getDraft(scope,workflowId);
      if(!draft)return fail(404,'not_found');
      if(isDraft)return json({draft,
        ...(deps.upload&&grant.canRun?{uploadMode:deps.upload.mode}:{}),
        ...(scope.workspaceId?{capabilities:{canPrepare:grant.canPrepare===true,canConfirm:grant.canConfirm===true}}:{})});
      const controller=new AbortController();
      const signal=AbortSignal.any([request.signal,controller.signal,AbortSignal.timeout(45000)]);
      let input:string,materials:readonly MaterialRef[],provider=deps.provider;
      if(isUpload&&deps.upload){
        const upload=await readUpload(request,deps.upload.mode,signal);
        const current=await deps.authorize(request,workflowId);
        if(!current?.canRun||!sameScope(current.scope,scope))
          return fail(403,'run_forbidden');
        signal.throwIfAborted();
        const latest=deps.store.getDraft(scope,workflowId);
        if(!latest)return fail(404,'not_found');
        if(latest.revision!==upload.revision)return fail(409,'revision_conflict');
        draft=latest;
        input=upload.input;
        materials=[upload.ref];
        provider=deps.upload.bind(scope,upload.ref,upload.bytes);
      }else{
        const body=await readBody(request);
        const value=body.input,selected=body.materialIds===undefined?[]:body.materialIds;
        if(!only(body,['input','materialIds'])||typeof value!=='string'||!value.trim()||value.length>32_768||
          !Array.isArray(selected)||selected.length>8||selected.some(id=>typeof id!=='string'||!safeId.test(id))||
          new Set(selected).size!==selected.length)return fail(400,'invalid_turn');
        input=value;
        materials=selected.length?await deps.resolveMaterials(selected,scope,workflowId,signal):[];
        if(materials.length!==selected.length||new Set(materials.map(m=>m.id)).size!==selected.length||
           materials.some(m=>!selected.includes(m.id)))return fail(403,'material_forbidden');
      }
      const catalog=await deps.catalog(scope,workflowId,signal);
      signal.throwIfAborted();
      const agent=createWorkflowAgent({scope,workflowId,revision:String(draft.revision),workflow:draft.workflow,catalog});
      const events=agent.run({input,materials,provider,signal});
      let operation:Operation|undefined,ended=false;
      // Pull-based streaming keeps buffering bounded by consumer demand.
      const stream=new ReadableStream<Uint8Array>({
        async pull(stream){
          const emit=(data:unknown)=>stream.enqueue(encode.encode(JSON.stringify(data)+'\n'));
          try {
            for(;;){
              const event=await events.next();
              if(event.done)return fail(502,'incomplete_turn');
              if(event.value.type==='text'){emit(event.value);return;}
              if(event.value.type==='tool-result'&&event.value.result.ok&&event.value.result.name==='workflow.propose_patch'){
                const next=acceptedOperation(event.value.result.output,{workflowId,revision:draft.revision,environment:scope.environment});
                if(next){
                  if(operation&&(operation.edgeId!==next.edgeId||operation.value!==next.value))return fail(422,'multiple_proposals');
                  operation=next;
                }
              }
              if(event.value.type==='final'){
                signal.throwIfAborted();
                if(operation)emit({type:'proposal',proposal:deps.store.prepare(scope,workflowId,draft.revision,operation)});
                emit({type:'done'});ended=true;stream.close();await events.return(undefined);return;
              }
            }
          }catch(error){
            if(!ended&&!controller.signal.aborted){
              const safe=safeError(signal.aborted?signal.reason:error);
              emit({type:'error',code:safe.code});ended=true;stream.close();
            }
            controller.abort();
            await events.return(undefined).catch(()=>{});
          }
        },
        async cancel(){
          ended=true;controller.abort();
          await events.return(undefined).catch(()=>{});
        },
      });
      return new Response(stream,{headers:{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
    }catch(error){
      const safe=safeError(error);
      return json({error:safe.code},safe.status===499?408:safe.status);
    }
  };
}
