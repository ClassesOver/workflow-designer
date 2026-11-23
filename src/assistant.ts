import { validate, type Workflow } from './workflow.ts';

export const workflowTools = [
  {name:'workflow.get_draft',mode:'read'},
  {name:'workflow.get_catalog',mode:'read'},
  {name:'workflow.propose_patch',mode:'proposal'},
  {name:'workflow.validate_patch',mode:'read'},
  {name:'workflow.preview_patch',mode:'read'},
  {name:'workflow.simulate_route',mode:'read'},
] as const;
const fingerprint = (workflow: Workflow) => JSON.stringify({
  name: workflow.name, nodes: workflow.nodes.map(({id,kind,name,role}) => ({id,kind,name,role})), edges: workflow.edges,
});
export type Proposal = {
  base: string;
  candidate: Workflow;
  changes: {name: string; kind: 'added'|'removed'|'updated'}[];
};
export const proposalIsCurrent = (workflow: Workflow, proposal: Proposal) => fingerprint(workflow) === proposal.base;
export function candidateForReview(workflow: Workflow, proposal: Proposal): Workflow {
  if (!proposalIsCurrent(workflow, proposal)) throw Error('草稿有新改动，请重新生成和审阅这个建议。');
  const issues=validate(proposal.candidate);
  if (issues.length) throw Error(issues.join('；'));
  return { ...structuredClone(proposal.candidate), nodes: proposal.candidate.nodes.map(n => {
    const existing = workflow.nodes.find(old=>old.id===n.id);
    return existing ? {...n,x:existing.x,y:existing.y} : {...n};
  }) };
}

export function proposeThresholdChange(base: Workflow, edgeId: string, value: number): Proposal {
  if (!Number.isFinite(value) || value < 0) throw Error('金额需要是非负数。');
  const candidate = structuredClone(base);
  const edge = candidate.edges.find(e=>e.id===edgeId);
  if (!edge?.rule || edge.fallback) throw Error('没有找到可修改的金额条件。');
  const prior = edge.rule.value;
  if (prior === value) return {base:fingerprint(base),candidate,changes:[]};
  edge.rule.value = value;
  delete edge.label;
  const errors = validate(candidate);
  if (errors.length) throw Error(errors.join('；'));
  return {base:fingerprint(base),candidate,changes:[{kind:'updated',name:`金额门槛：${prior} 元 → ${value} 元`}]};
}
