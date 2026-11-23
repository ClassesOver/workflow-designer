export type PilotRole='viewer'|'editor'|'approver'|'auditor';
export type PilotTarget=Readonly<{workspaceId:string;projectId:string;environment:string;workflowId:string}>;
export type PilotMembership=Readonly<{actorId:string;role:PilotRole}> & PilotTarget;
export type PilotGrant=Readonly<{
  scope:Readonly<{userId:string;workspaceId:string;projectId:string;environment:string}>;
  canRead:boolean;
  canRun:false;
  canPrepare:boolean;
  canConfirm:boolean;
  canAudit:boolean;
}>;
export type PilotAccessOptions=Readonly<{
  origin:string;
  target:PilotTarget;
  /** The host must identify the actor from a verified SSO session, not caller-supplied identity fields. */
  identify(request:Request):Promise<string|null>;
  memberships:readonly PilotMembership[];
}>;

const roles:ReadonlySet<PilotRole>=new Set(['viewer','editor','approver','auditor']);
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&
  value.length<=120&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const targetKeys=['workspaceId','projectId','environment','workflowId'] as const;
const validTarget=(value:PilotTarget)=>value&&targetKeys.every(key=>validId(value[key]))&&
  /^[A-Za-z0-9_-]{1,120}$/.test(value.workflowId);
const invalid=()=>new TypeError('Invalid pilot access configuration');

export function createPilotAccess({origin,target,identify,memberships}:PilotAccessOptions){
  let configured:URL;
  try{configured=new URL(origin);}catch{throw invalid();}
  if(configured.protocol!=='https:'||configured.origin!==origin||!validTarget(target)||
    typeof identify!=='function'||!Array.isArray(memberships))throw invalid();

  const {workspaceId,projectId,environment,workflowId:configuredWorkflow}=target;
  const grants=new Map<string,PilotGrant>();
  const seen=new Set<string>();
  for(const member of memberships){
    if(!validTarget(member)||!validId(member.actorId)||!roles.has(member.role))throw invalid();
    const key=JSON.stringify([member.actorId,...targetKeys.map(field=>member[field])]);
    if(seen.has(key))throw invalid();
    seen.add(key);
    if(member.workspaceId!==workspaceId||member.projectId!==projectId||
      member.environment!==environment||member.workflowId!==configuredWorkflow)continue;
    const {actorId,role}=member;
    grants.set(actorId,Object.freeze({
      scope:Object.freeze({userId:actorId,workspaceId,projectId,environment}),
      canRead:role!=='auditor',
      canRun:false,
      canPrepare:role==='editor'||role==='approver',
      canConfirm:role==='approver',
      canAudit:role==='auditor',
    }));
  }

  async function authorize(request:Request,workflowId:string):Promise<PilotGrant|null>{
    if(workflowId!==configuredWorkflow||(request.method!=='GET'&&request.method!=='POST'))return null;
    const url=new URL(request.url);
    if(url.protocol!=='https:'||url.origin!==origin)return null;
    if(request.method==='POST'){
      const site=request.headers.get('sec-fetch-site');
      if(request.headers.get('origin')!==origin||(site!==null&&site!=='same-origin'))return null;
    }
    try{
      const actor=await identify(request);
      return validId(actor)?grants.get(actor)??null:null;
    }catch{return null;}
  }

  return Object.freeze(authorize);
}
