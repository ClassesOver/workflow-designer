import type { Draft, Proposal, Receipt } from './proposal-store.ts';
import { parseSavedDraft } from './drafts.ts';
import { validate } from './workflow.ts';
export type AiUploadMode = 'scripted' | 'openai';
export type AiDraft = Draft & {uploadMode?:AiUploadMode};
export type AiProposal = Proposal;
export type AiReceipt = Receipt;
type Turn = { input:string; materialIds?:readonly string[] };
type MaterialTurn = {input:string;file:File;expectedRevision:number;mode:AiUploadMode;consent?:'openai'};
export const AI_MATERIAL_MAX_BYTES=8*1024*1024;
export const AI_MATERIAL_ACCEPT='image/png,image/jpeg,application/pdf';
export function materialError(file:File):'material_type_unsupported'|'material_too_large'|'material_empty'|undefined{
 if(!AI_MATERIAL_ACCEPT.split(',').includes(file.type))return 'material_type_unsupported';
 if(file.size>AI_MATERIAL_MAX_BYTES)return 'material_too_large';
 if(file.size===0)return 'material_empty';
}
type TurnOptions = {signal?:AbortSignal;onText?:(text:string)=>void};
const base='/v1/ai/workflows/purchase';
const rec=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const rev=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const opaque=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
const codeOf=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value)?value:'invalid_response';
export class AiHttpClientError extends Error {
 readonly code:string; readonly status:number;
 constructor(code:string,status=0){super(code);this.name='AiHttpClientError';this.code=code;this.status=status;}
}
const invalid=()=>new AiHttpClientError('invalid_response');
function isProposal(v:unknown,workflowId='purchase'):v is AiProposal {
 if(!rec(v)||v.workflowId!==workflowId||!opaque(v.proposalId)||!rev(v.expectedRevision)||!rev(v.expiresAt)||!rec(v.operation))return false;
 const op=v.operation;
 return op.kind==='set_amount_threshold'&&typeof op.edgeId==='string'&&op.edgeId.length>0&&op.edgeId.length<=120&&
  typeof op.value==='number'&&Number.isFinite(op.value)&&op.value>=0;
}

function makeRequest(base:string,fetchImpl:typeof fetch){
 return async function request(path:string,signal?:AbortSignal,body?:unknown){
  const options:RequestInit={signal,credentials:'same-origin',redirect:'error',cache:'no-store'};
  if(body!==undefined){
   options.method='POST';
   if(body instanceof FormData){options.body=body;}
   else{options.headers={'content-type':'application/json'};options.body=JSON.stringify(body);}
  }
  const response=await fetchImpl(base+path,options);
  if(!response.ok){
   let code='request_failed';
   try{const error:unknown=await response.json();if(rec(error)&&error.error!==undefined)code=codeOf(error.error);}catch{}
   throw new AiHttpClientError(code,response.status);
  }
  return response;
 };
}

function readReceipt(v:unknown,proposal:Proposal):Receipt{
 if(!rec(v)||!rec(v.receipt))throw invalid();
 const r=v.receipt;
 if(r.proposalId!==proposal.proposalId||r.workflowId!==proposal.workflowId||r.previousRevision!==proposal.expectedRevision||
    !rev(r.revision)||r.revision!==proposal.expectedRevision+1||!rev(r.confirmedAt))throw invalid();
 return {proposalId:proposal.proposalId,workflowId:proposal.workflowId,previousRevision:proposal.expectedRevision,revision:r.revision,confirmedAt:r.confirmedAt};
}

export function createAiClient(fetchImpl:typeof fetch){
 const request=makeRequest(base,fetchImpl);
 async function getAiDraft(signal?:AbortSignal):Promise<AiDraft>{
  const v:unknown=await (await request('',signal)).json().catch(()=>null);
  if(!rec(v)||!rec(v.draft)||v.draft.workflowId!=='purchase'||!rev(v.draft.revision))throw invalid();
  const payload=parseSavedDraft(JSON.stringify({version:1,workflow:v.draft.workflow,snapshots:[]}));
  if(!payload)throw invalid();
  const uploadMode=v.uploadMode==='scripted'||v.uploadMode==='openai'?v.uploadMode:undefined;
  return {workflowId:'purchase',revision:v.draft.revision,workflow:payload.workflow,...(uploadMode?{uploadMode}:{})};
 }
 async function readTurn(response:Response,{signal,onText}:TurnOptions):Promise<AiProposal|undefined>{
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/x-ndjson')||!response.body)throw invalid();
  const reader=response.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='',total=0,ended=false,readAll=false;
  let proposal:AiProposal|undefined;
  const consume=(line:string)=>{
   if(!line.trim())return;
   if(ended)throw invalid();
   let frame:unknown;
   try{frame=JSON.parse(line);}catch{throw invalid();}
   if(!rec(frame))throw invalid();
   if(frame.type==='text'&&typeof frame.text==='string'&&!proposal){onText?.(frame.text);return;}
   if(frame.type==='proposal'&&!proposal&&isProposal(frame.proposal)){proposal=frame.proposal;return;}
   if(frame.type==='done'){ended=true;return;}
   if(frame.type==='error')throw new AiHttpClientError(codeOf(frame.code),response.status);
   throw invalid();
  };
  try{
   for(;;){
    const chunk=await reader.read();
    signal?.throwIfAborted();
    if(chunk.done){readAll=true;break;}
    total+=chunk.value.byteLength;
    if(total>1024*1024)throw invalid();
    buffer+=decoder.decode(chunk.value,{stream:true});
    let i=buffer.indexOf('\n');
    while(i>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);consume(line);i=buffer.indexOf('\n');}
   }
   buffer+=decoder.decode();
   if(buffer.trim())consume(buffer);
   if(!ended)throw new AiHttpClientError('incomplete_turn');
   return proposal;
  }finally{
   if(!readAll)void reader.cancel().catch(()=>{});
   reader.releaseLock();
  }
 }
 async function runAiTurn(payload:Turn,options:TurnOptions={}){
  return readTurn(await request('/turn',options.signal,payload),options);
 }
 async function runAiMaterialTurn(payload:MaterialTurn,options:TurnOptions={}){
  if(payload.mode!=='openai'&&payload.mode!=='scripted')throw new AiHttpClientError('material_upload_disabled');
  if(payload.mode==='openai'&&payload.consent!=='openai')throw new AiHttpClientError('material_consent_required');
  if(!rev(payload.expectedRevision))throw new AiHttpClientError('invalid_revision');
  const error=materialError(payload.file);
  if(error)throw new AiHttpClientError(error);
  const body=new FormData();
  body.append('input',payload.input);
  body.append('file',payload.file);
  if(payload.mode==='openai')body.append('consent','openai');
  body.append('expectedRevision',String(payload.expectedRevision));
  return readTurn(await request('/turn-with-material',options.signal,body),options);
 }
 async function confirmAiProposal(proposal:AiProposal,signal?:AbortSignal):Promise<AiReceipt>{
  if(!isProposal(proposal))throw invalid();
  const v:unknown=await (await request('/proposals/'+proposal.proposalId+'/confirm',signal,{expectedRevision:proposal.expectedRevision})).json().catch(()=>null);
  return readReceipt(v,proposal);
 }
 return {getAiDraft,runAiTurn,runAiMaterialTurn,confirmAiProposal};
}
export const {getAiDraft,runAiTurn,runAiMaterialTurn,confirmAiProposal}=createAiClient((...args)=>fetch(...args));

export type PilotDraft=Draft;
export type PilotCapabilities={canPrepare:boolean;canConfirm:boolean};
export type PilotDraftState={draft:PilotDraft;capabilities:PilotCapabilities};
export type PilotProposal=Proposal;
export type PilotReceipt=Receipt;

const pilotId=(id: unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(id);

export function createPilotClient(workflowId:string,fetchImpl:typeof fetch=(...args)=>fetch(...args)){
 if(!pilotId(workflowId))throw new AiHttpClientError('invalid_workflow');
 const request=makeRequest('/v1/ai/workflows/'+workflowId,fetchImpl);
 async function call(path:string,signal?:AbortSignal,body?:unknown):Promise<unknown>{
  signal?.throwIfAborted();
  const result:unknown=await (await request(path,signal,body)).json().catch(()=>null);
  signal?.throwIfAborted();
  return result;
 }
 async function read(signal?:AbortSignal):Promise<PilotDraftState>{
  const data=await call('',signal);
  if(!rec(data)||!rec(data.draft)||data.draft.workflowId!==workflowId||!rev(data.draft.revision)||
     !rec(data.capabilities)||typeof data.capabilities.canPrepare!=='boolean'||typeof data.capabilities.canConfirm!=='boolean')throw invalid();
  const payload=parseSavedDraft(JSON.stringify({version:1,workflow:data.draft.workflow,snapshots:[]}));
  if(!payload||validate(payload.workflow).length)throw invalid();
  return {draft:{workflowId,revision:data.draft.revision,workflow:payload.workflow},
   capabilities:{canPrepare:data.capabilities.canPrepare,canConfirm:data.capabilities.canConfirm}};
 }
 async function prepare(expectedRevision:number,edgeId:string,value:number,signal?:AbortSignal):Promise<PilotProposal>{
  if(!rev(expectedRevision))throw new AiHttpClientError('invalid_revision');
  if(!pilotId(edgeId)||typeof value!=='number'||!Number.isFinite(value)||value<0)throw new AiHttpClientError('invalid_operation');
  const operation={kind:'set_amount_threshold',edgeId,value} as const;
  const data=await call('/proposals',signal,{expectedRevision,operation});
  if(!rec(data)||!isProposal(data.proposal,workflowId)||data.proposal.expectedRevision!==expectedRevision||
     data.proposal.operation.edgeId!==edgeId||data.proposal.operation.value!==value)throw invalid();
  return {proposalId:data.proposal.proposalId,workflowId,expectedRevision,operation,expiresAt:data.proposal.expiresAt};
 }
 async function confirm(proposal:PilotProposal,signal?:AbortSignal):Promise<PilotReceipt>{
  if(!isProposal(proposal,workflowId)||!pilotId(proposal.operation.edgeId))throw invalid();
  const expected={...proposal};
  const data=await call('/proposals/'+expected.proposalId+'/confirm',signal,{expectedRevision:expected.expectedRevision});
  return readReceipt(data,expected);
 }
 return {read,prepare,confirm};
}
