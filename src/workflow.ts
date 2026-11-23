/** Pure workflow graph operations. No network, persistence or approval execution. */
export type NodeKind = 'start' | 'approval' | 'decision' | 'merge' | 'end'
export interface FlowNode { id: string; kind: NodeKind; name: string; role?: string; x: number; y: number }
export interface FlowEdge {
  id: string; from: string; to: string; label?: string
  rule?: { op: 'gte' | 'gt' | 'lt' | 'lte'; value: number }; fallback?: boolean
}
export interface Workflow { name: string; nodes: FlowNode[]; edges: FlowEdge[] }
export interface Preview { nodeIds: string[]; edgeIds: string[]; explanation: string[] }

export const sampleWorkflow: Workflow = {
  name: '采购申请审批',
  nodes: [
    {id:'start',kind:'start',name:'提交采购申请',x:400,y:45},
    {id:'manager',kind:'approval',name:'部门负责人审批',role:'部门负责人',x:400,y:145},
    {id:'amount',kind:'decision',name:'按采购金额分流',x:400,y:245},
    {id:'finance',kind:'approval',name:'财务负责人审批',role:'财务负责人',x:200,y:355},
    {id:'direct',kind:'approval',name:'采购专员确认',role:'采购专员',x:600,y:355},
    {id:'merge',kind:'merge',name:'汇总审批结果',x:400,y:490},
    {id:'end',kind:'end',name:'审批完成',x:400,y:600},
  ],
  edges: [
    {id:'e1',from:'start',to:'manager'}, {id:'e2',from:'manager',to:'amount'},
    {id:'e3',from:'amount',to:'finance',label:'≥ 50,000 元',rule:{op:'gte',value:50000}},
    {id:'e4',from:'amount',to:'direct',label:'其他金额',fallback:true},
    {id:'e5',from:'finance',to:'merge'}, {id:'e6',from:'direct',to:'merge'},
    {id:'e7',from:'merge',to:'end'},
  ],
}
export const blankWorkflow: Workflow = {
  name:'新建审批流程',
  nodes:[{id:'start',kind:'start',name:'开始',x:400,y:145},{id:'end',kind:'end',name:'结束',x:400,y:490}],
  edges:[{id:'e1',from:'start',to:'end'}],
}

/** An editable draft may be invalid; only a fully valid graph can be simulated. */
export function validate(workflow: Workflow): string[] {
  const errors: string[] = []
  if (!workflow.name.trim()) errors.push('请输入流程名称')
  const ids = new Set<string>(), edgeIds = new Set<string>()
  const kinds: NodeKind[] = ['start','approval','decision','merge','end']
  for (const node of workflow.nodes) {
    if (!node.id || ids.has(node.id)) errors.push('节点标识不能为空或重复')
    ids.add(node.id)
    if (!kinds.includes(node.kind)) errors.push(`节点 ${node.name} 的类型无效`)
    if (!node.name.trim()) errors.push('节点名称不能为空')
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) errors.push(`节点 ${node.name} 的位置无效`)
  }
  const starts = workflow.nodes.filter(n => n.kind === 'start')
  const ends = workflow.nodes.filter(n => n.kind === 'end')
  if (starts.length !== 1) errors.push('流程必须有且仅有一个开始节点')
  if (ends.length !== 1) errors.push('流程必须有且仅有一个结束节点')
  for (const edge of workflow.edges) {
    if (!edge.id || edgeIds.has(edge.id)) errors.push('连线标识不能为空或重复')
    edgeIds.add(edge.id)
    if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push(`连线 ${edge.id} 指向不存在的节点`)
    if (edge.rule && (!['gte','gt','lt','lte'].includes(edge.rule.op) || !Number.isFinite(edge.rule.value) || edge.rule.value < 0)) errors.push(`连线 ${edge.id} 的金额条件无效`)
    if (edge.fallback && edge.rule) errors.push(`连线 ${edge.id} 不能同时是条件与默认分支`)
  }
  const outgoing = (id: string) => workflow.edges.filter(e => e.from === id)
  for (const node of workflow.nodes) {
    const out = outgoing(node.id), incoming = workflow.edges.filter(e => e.to === node.id)
    if (node.kind === 'start' && incoming.length) errors.push('开始节点不能有入线')
    if (node.kind === 'end') {
      if (out.length) errors.push('结束节点不能有出线')
    } else if (node.kind === 'decision') {
      if (out.length < 2) errors.push(`决策 ${node.name} 至少需要两个分支`)
      if (out.filter(e => e.fallback).length !== 1) errors.push(`决策 ${node.name} 必须有且仅有一个默认分支`)
      if (out.some(e => !e.fallback && !e.rule)) errors.push(`决策 ${node.name} 的非默认分支必须设置条件`)
    } else if (out.length !== 1) errors.push(`节点 ${node.name} 必须有且仅有一条出线`)
    if (node.kind !== 'decision' && out.some(e => e.rule || e.fallback)) errors.push(`只有决策节点可设置条件或默认分支：${node.name}`)
  }
  // Inspect every component, including unreachable cycles.
  const active = new Set<string>(), visited = new Set<string>()
  let cyclic = false
  const visit = (id: string) => {
    if (active.has(id)) { cyclic = true; return }
    if (visited.has(id)) return
    visited.add(id); active.add(id)
    for (const edge of outgoing(id)) if (ids.has(edge.to)) visit(edge.to)
    active.delete(id)
  }
  for (const id of ids) visit(id)
  if (cyclic) errors.push('流程存在环路，请移除循环连线')
  const reachable = new Set<string>()
  const reach = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const e of outgoing(id)) if (ids.has(e.to)) reach(e.to) }
  if (starts.length === 1) {
    reach(starts[0].id)
    for (const node of workflow.nodes) if (!reachable.has(node.id)) errors.push(`节点 ${node.name} 从开始节点不可达`)
  }
  return [...new Set(errors)]
}

export function simulate(workflow: Workflow, amount: number): Preview {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额必须是大于或等于零的有限数字')
  const errors = validate(workflow)
  if (errors.length) throw new Error(`流程校验失败：${errors.join('；')}`)
  const preview: Preview = {nodeIds:[],edgeIds:[],explanation:[]}
  let node = workflow.nodes.find(n => n.kind === 'start')!
  const matches = (rule: NonNullable<FlowEdge['rule']>) => {
    switch (rule.op) {
      case 'gte': return amount >= rule.value
      case 'gt': return amount > rule.value
      case 'lt': return amount < rule.value
      case 'lte': return amount <= rule.value
    }
  }
  while (true) {
    preview.nodeIds.push(node.id)
    preview.explanation.push(`经过：${node.name}`)
    if (node.kind === 'end') break
    const out = workflow.edges.filter(e => e.from === node.id)
    const edge = node.kind === 'decision' ? out.find(e => e.rule && matches(e.rule)) ?? out.find(e => e.fallback)! : out[0]
    if (node.kind === 'decision') {
      const operators = {gte:'≥',gt:'>',lt:'<',lte:'≤'}
      const condition = edge.rule ? `符合 ${operators[edge.rule.op]} ${edge.rule.value} 元的条件` : '未命中条件，走默认分支'
      preview.explanation.push(`采购金额 ${amount} 元，${condition}`)
    }
    preview.edgeIds.push(edge.id)
    node = workflow.nodes.find(n => n.id === edge.to)!
  }
  return preview
}
const clone = (workflow: Workflow): Workflow => structuredClone(workflow)
const uniqueId = (used: string[], prefix: string) => { let i = 1; while (used.includes(`${prefix}-${i}`)) i++; return `${prefix}-${i}` }

export function insertApproval(workflow: Workflow, edgeId: string): {workflow: Workflow; nodeId: string} {
  const next = clone(workflow), edge = next.edges.find(e => e.id === edgeId)
  if (!edge) throw new Error('找不到要插入审批的连线')
  const from = next.nodes.find(n => n.id === edge.from), to = next.nodes.find(n => n.id === edge.to)
  if (!from || !to) throw new Error('连线关联的节点不存在')
  const nodeId = uniqueId(next.nodes.map(n => n.id),'approval')
  next.nodes.push({id:nodeId,kind:'approval',name:'新增审批',role:'待指定',x:(from.x+to.x)/2,y:(from.y+to.y)/2})
  const target = edge.to; edge.to = nodeId
  next.edges.push({id:uniqueId(next.edges.map(e=>e.id),'edge'),from:nodeId,to:target})
  return {workflow:next,nodeId}
}

/** Add an arrow without silently repairing or rewriting decision semantics. */
export function connectNodes(workflow: Workflow, from: string, to: string): Workflow {
  if (from === to) throw new Error('节点不能连接自身')
  const source = workflow.nodes.find(n=>n.id===from), target = workflow.nodes.find(n=>n.id===to)
  if (!source || !target) throw new Error('连线的节点不存在')
  if (source.kind === 'end') throw new Error('结束节点不能作为连线起点')
  if (target.kind === 'start') throw new Error('开始节点不能作为连线终点')
  if (workflow.edges.some(e=>e.from===from && e.to===to)) throw new Error('不能添加重复连线')
  const next = clone(workflow)
  next.edges.push({id:uniqueId(next.edges.map(e=>e.id),'edge'),from,to})
  return next
}
