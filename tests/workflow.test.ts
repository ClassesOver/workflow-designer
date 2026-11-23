import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleWorkflow, blankWorkflow, validate, simulate, insertApproval, connectNodes, type Workflow } from '../src/workflow.ts'
const copy = (w: Workflow) => structuredClone(w)
test('样例与空白流程合法，五万元进入财务审批', () => {
  assert.deepEqual(validate(sampleWorkflow), [])
  assert.deepEqual(validate(blankWorkflow), [])
  const high = simulate(sampleWorkflow, 50000)
  const low = simulate(sampleWorkflow, 49999)
  const finance = sampleWorkflow.nodes.find(n => n.name.includes('财务'))!
  assert.ok(high.nodeIds.includes(finance.id))
  assert.ok(!low.nodeIds.includes(finance.id))
  assert.equal(high.edgeIds.length, high.nodeIds.length - 1)
  assert.ok(high.explanation.length > 0)
})
test('金额非法拒绝模拟', () => {
  for (const amount of [-1, NaN, Infinity]) assert.throws(() => simulate(sampleWorkflow, amount), /金额/)
})
test('拒绝悬空、重复节点和环', () => {
  const dangling = copy(blankWorkflow); dangling.edges[0].to = 'missing'
  assert.ok(validate(dangling).length)
  const duplicate = copy(blankWorkflow); duplicate.nodes.push({...duplicate.nodes[0]})
  assert.ok(validate(duplicate).length)
  const cycle = copy(sampleWorkflow); cycle.edges.push({id:'cycle',from:cycle.nodes[1].id,to:cycle.nodes[0].id})
  assert.ok(validate(cycle).some(x => x.includes('环')))
  assert.throws(() => simulate(dangling, 10), /流程/)
})
test('拒绝不可达节点和决策缺省/条件错误', () => {
  const orphan = copy(blankWorkflow); orphan.nodes.push({id:'orphan',kind:'approval',name:'孤立',x:10,y:10})
  assert.ok(validate(orphan).some(x => x.includes('不可达')))
  for (const mutate of [
    (w:Workflow) => { w.edges.find(e => e.fallback)!.fallback = false },
    (w:Workflow) => { w.edges.find(e => e.rule)!.fallback = true },
    (w:Workflow) => { w.edges.find(e => e.rule)!.rule!.value = NaN },
  ]) { const w = copy(sampleWorkflow); mutate(w); assert.ok(validate(w).length) }
})
test('决策按边顺序匹配，支持四种比较符', () => {
  for (const [op, amount, expected] of [['gte',10,true],['gt',10,false],['lt',9,true],['lte',10,true]] as const) {
    const w = copy(sampleWorkflow); const edge = w.edges.find(e => e.rule)!
    edge.rule = {op,value:10}; assert.equal(simulate(w,amount).edgeIds.includes(edge.id),expected)
  }
  const w = copy(sampleWorkflow); const decision = w.nodes.find(n=>n.kind==='decision')!
  const conditioned = w.edges.find(e=>e.rule)!
  w.edges.splice(w.edges.indexOf(conditioned),0,{...conditioned,id:'first',rule:{op:'gte',value:0}})
  assert.ok(simulate(w,60000).edgeIds.includes('first'))
})
test('插入审批不修改原流程，保留条件/缺省语义，生成唯一标识', () => {
  for (const edge of sampleWorkflow.edges.filter(e=> e.rule || e.fallback)) {
    const before = copy(sampleWorkflow)
    const result = insertApproval(sampleWorkflow,edge.id)
    assert.deepEqual(sampleWorkflow,before)
    assert.deepEqual(validate(result.workflow),[])
    assert.equal(result.workflow.nodes.find(n=>n.id===result.nodeId)!.kind,'approval')
    const retained = result.workflow.edges.find(e=>e.id===edge.id)!
    assert.equal(retained.to,result.nodeId); assert.deepEqual(retained.rule,edge.rule)
    assert.equal(retained.fallback,edge.fallback)
    assert.notEqual(insertApproval(result.workflow,edge.id).nodeId,result.nodeId)
  }
  assert.throws(()=>insertApproval(sampleWorkflow,'missing'),/连线/)
})
test('添加连线拒绝重复、自连接及非法起终点，不重写已有分支', () => {
  const w = copy(blankWorkflow)
  assert.throws(()=>connectNodes(w,w.edges[0].from,w.edges[0].to),/重复/)
  assert.throws(()=>connectNodes(w,w.nodes[0].id,w.nodes[0].id),/自身/)
  assert.throws(()=>connectNodes(w,w.nodes[1].id,w.nodes[0].id),/结束|开始/)
  assert.throws(()=>connectNodes(w,'missing',w.nodes[1].id),/节点/)
  w.nodes.push({id:'extra',kind:'approval',name:'审批',x:400,y:300})
  const added = connectNodes(w,w.nodes[0].id,'extra')
  assert.equal(added.edges.length,w.edges.length+1)
  assert.deepEqual(added.edges.slice(0,-1),w.edges)
  assert.equal(w.edges.length,1)
})
test('默认分支在前也不会抢占匹配条件，模拟不修改源图', () => {
  const w = copy(sampleWorkflow), fallback = w.edges.find(e=>e.fallback)!
  w.edges = [fallback,...w.edges.filter(e=>e!==fallback)]
  const before = copy(w)
  assert.ok(simulate(w,50000).nodeIds.includes('finance'))
  assert.deepEqual(w,before)
})
test('缺失起终点、重复边标识、死路和非决策分叉均拒绝模拟', () => {
  const variants: Workflow[] = []
  let w = copy(blankWorkflow); w.nodes = w.nodes.filter(n=>n.kind!=='start'); variants.push(w)
  w = copy(blankWorkflow); w.nodes = w.nodes.filter(n=>n.kind!=='end'); variants.push(w)
  w = copy(sampleWorkflow); w.edges[1].id = w.edges[0].id; variants.push(w)
  w = copy(sampleWorkflow); w.edges = w.edges.filter(e=>e.from!=='finance'); variants.push(w)
  w = copy(sampleWorkflow); w.edges.push({id:'fork',from:'manager',to:'direct'}); variants.push(w)
  w = copy(blankWorkflow); w.edges[0].rule = {op:'gt',value:10}; variants.push(w)
  for (const graph of variants) {
    assert.ok(validate(graph).length)
    assert.throws(()=>simulate(graph,50000),/流程校验失败/)
  }
})
