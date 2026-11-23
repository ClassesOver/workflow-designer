/** Server-side composition of the approval graph and a provider-neutral AgentLoop. */
import {createAgentLoop, type AgentTool, type Scope} from './ai-core.ts';
import {proposeThresholdChange} from './assistant.ts';
import {simulate, type Workflow} from './workflow.ts';

type Catalog = { fields: {id:string;name:string}[]; roles: string[] };
type Context = { scope: Scope; workflowId: string; revision: string; workflow: Workflow; catalog: Catalog };
type RunOptions = Omit<Parameters<ReturnType<typeof createAgentLoop>['run']>[0],'scope'>;

const thresholdFields = {edgeId:{type:'string',maxLength:120},value:{type:'number'}} as const;
const stringify = (value: unknown) => JSON.stringify(value);

/** All initial data must come from an authorized app service. The model cannot select another object scope. */
export function createWorkflowAgent(context: Context) {
  const {scope,workflowId,revision,workflow,catalog} = structuredClone(context);
  const target = {workflowId,baseRevision:revision,environment:scope.environment};
  function threshold(edgeId: unknown, value: unknown) {
    if (typeof edgeId!=='string'||typeof value!=='number') throw Error('Invalid change');
    const result=proposeThresholdChange(workflow,edgeId,value);
    return {result,data:{...target,operations:result.changes.length?[{op:'set_amount_threshold',edgeId,value}]:[],changes:result.changes}};
  }
  const tools: AgentTool[] = [
    {name:'workflow.get_draft',description:'读取固定版本草稿；布局坐标与业务规则无关。',effect:'read',fields:{},
      execute:()=>stringify({...target,workflow:{...workflow,nodes:workflow.nodes.map(({x:_x,y:_y,...n})=>n)}})},
    {name:'workflow.get_catalog',description:'读取当前环境中已经授权的字段和角色。',effect:'read',fields:{},
      execute:()=>stringify(catalog)},
    {name:'workflow.propose_patch',description:'提议修改指定金额条件，只返回建议，不保存。',effect:'proposal',fields:thresholdFields,
      execute:args=>stringify(threshold(args.edgeId,args.value).data)},
    {name:'workflow.validate_patch',description:'验证拟议的金额条件变更，不写入。',effect:'read',fields:thresholdFields,
      execute:args=>{
        try{threshold(args.edgeId,args.value);return stringify({valid:true});}
        catch(error){return stringify({valid:false,problem:error instanceof Error?error.message:'无效条件'});}
      }},
    {name:'workflow.preview_patch',description:'展示该建议对应的条件变更，不写入。',effect:'read',fields:thresholdFields,
      execute:args=>stringify(threshold(args.edgeId,args.value).data)},
    {name:'workflow.simulate_route',description:'预演路径；可选带一个未应用的金额变更，edgeId 和 value 必须同时给出。',effect:'read',
      fields:{amount:{type:'number'},edgeId:{...thresholdFields.edgeId,optional:true},value:{...thresholdFields.value,optional:true}},
      execute:args=>{
        if(typeof args.amount!=='number'|| (args.edgeId===undefined)!==(args.value===undefined)) throw Error('Invalid preview');
        const candidate=args.edgeId===undefined?workflow:threshold(args.edgeId,args.value).result.candidate;
        return stringify({...target,...simulate(candidate,args.amount)});
      }},
  ];
  const loop=createAgentLoop(tools);
  return { run: (options:RunOptions)=>loop.run({...options,scope}) };
}
