import type {FlowNode,Preview,Workflow} from './workflow.ts'

export type ApprovalImpact={
 kind:'same'|'routing'|'approval'|'reordered'
 added:FlowNode[]
 removed:FlowNode[]
}

function sameSequence<T>(left:readonly T[],right:readonly T[]):boolean{
 return left.length===right.length&&left.every((value,index)=>value===right[index])
}

/** Compare the simulator's traces for two conditions on the same workflow graph. */
export function compareApprovalPaths(workflow:Workflow,current:Preview,updated:Preview):ApprovalImpact{
 const nodes=new Map(workflow.nodes.map(node=>[node.id,node]))
 const approvals=(trace:Preview)=>trace.nodeIds.flatMap(id=>{
  const node=nodes.get(id)
  if(!node)throw new Error('Approval trace references an unknown workflow node')
  return node.kind==='approval'?[node]:[]
 })
 const before=approvals(current),after=approvals(updated)
 const beforeIds=before.map(node=>node.id),afterIds=after.map(node=>node.id)
 const previous=new Set(beforeIds),next=new Set(afterIds)
 const added=after.filter(node=>!previous.has(node.id))
 const removed=before.filter(node=>!next.has(node.id))
 if(added.length||removed.length)return {kind:'approval',added,removed}
 if(!sameSequence(beforeIds,afterIds))return {kind:'reordered',added,removed}
 const sameRoute=sameSequence(current.nodeIds,updated.nodeIds)&&sameSequence(current.edgeIds,updated.edgeIds)
 return {kind:sameRoute?'same':'routing',added,removed}
}
