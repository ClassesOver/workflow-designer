import React, { useEffect, useMemo, useRef, useState } from 'react'
import Canvas from './Canvas'
import { compareApprovalPaths } from './approval-impact'
import { AiHttpClientError, createPilotClient, type PilotDraftState, type PilotProposal } from './ai-client'
import { simulate, type FlowEdge, type Workflow } from './workflow'
import './pilot-workspace.css'

const comparison = { gte: '≥', gt: '>', lt: '<', lte: '≤' } as const
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 })
const money = (amount: number) => format.format(amount)
function amountFrom(text: string): number | null {
  if (!text.trim()) return null
  const amount = Number(text)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}
const ruleText = (rule: NonNullable<FlowEdge['rule']>) => `金额 ${comparison[rule.op]} ${money(rule.value)} 元`
function calculate(workflow: Workflow, amount: number | null) {
  if (amount === null) return null
  try { return simulate(workflow, amount) } catch { return null }
}

export default function PilotWorkspace({ workflowId }: { workflowId: string }) {
  const client = useMemo(() => createPilotClient(workflowId), [workflowId])
  const operation = useRef<AbortController | null>(null)
  const acknowledgedRevision = useRef<number | null>(null)
  const [state, setState] = useState<PilotDraftState | null>(null)
  const [edgeId, setEdgeId] = useState('')
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [threshold, setThreshold] = useState('')
  const [trial, setTrial] = useState('60000')
  const [proposal, setProposal] = useState<PilotProposal | null>(null)
  const [phase, setPhase] = useState<'load' | 'prepare' | 'confirm' | null>('load')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const workflow = state?.draft.workflow
  const rules = workflow?.edges.filter(edge => edge.rule) ?? []
  const selected = rules.find(edge => edge.id === edgeId)
  const candidate = amountFrom(threshold)
  const trialValue = amountFrom(trial)
  const name = (id: string) => workflow?.nodes.find(node => node.id === id)?.name || id
  const approver = selected && workflow?.nodes.find(node => node.id === selected.to)?.role
  const current = workflow && trialValue !== null ? calculate(workflow, trialValue) : null
  const updated = workflow && selected?.rule && candidate !== null
    ? calculate({ ...workflow, edges: workflow.edges.map(edge => edge.id === selected.id
        ? { ...edge, rule: { ...selected.rule!, value: candidate } } : edge) }, trialValue)
    : null
  const impact = workflow && current && updated ? compareApprovalPaths(workflow, current, updated) : null
  const impactLabel = { same: '审批路径不变', routing: '分支变化，审批环节不变', approval: '审批环节有增减', reordered: '审批顺序有变化' } as const
  const approvals = (ids: readonly string[]) => ids
    .map(id => workflow?.nodes.find(node => node.id === id))
    .filter(node => node?.kind === 'approval').map(node => node!.name).join(' → ') || '无审批环节'
  const canPrepare = Boolean(state?.capabilities.canPrepare)
  const canConfirm = Boolean(state?.capabilities.canConfirm)
  const reviewing = Boolean(proposal)
  const canStartReview = canPrepare && selected?.rule && candidate !== null && candidate !== selected.rule.value &&
    current && updated && !phase && !needsRefresh

  async function reload(preferred = '') {
    const requiredRevision = acknowledgedRevision.current
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setPhase('load')
    setProblem('')
    setNotice('')
    setProposal(null)
    try {
      const data = await client.read(controller.signal)
      if (controller.signal.aborted) return
      if (requiredRevision !== null && data.draft.revision < requiredRevision) throw new Error('unconfirmed_read')
      const validRules = data.draft.workflow.edges.filter(edge => edge.rule)
      const next = validRules.find(edge => edge.id === preferred) ?? validRules[0]
      setState(data)
      setEdgeId(next?.id ?? '')
      setThreshold(next?.rule ? String(next.rule.value) : '')
      setNodeId(null)
      setNeedsRefresh(false)
      if (requiredRevision !== null) {
        acknowledgedRevision.current = null
        setNotice(`已写入草稿 v${requiredRevision}；现已同步。改动未发布，也未执行审批。`)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      const access = error instanceof AiHttpClientError && [401, 403, 404].includes(error.status)
      if (access) setState(null)
      setNeedsRefresh(true)
      setProblem(requiredRevision !== null
        ? `已收到确认回执 v${requiredRevision}，但当前画布尚未同步。请刷新草稿，不要重复提交。`
        : access ? '你没有查看此流程的权限，或当前登录已失效。' : '未能加载最新草稿，请刷新后重试。')
    } finally { if (operation.current === controller && !controller.signal.aborted) { operation.current = null; setPhase(null) } }
  }

  useEffect(() => {
    setState(null)
    acknowledgedRevision.current = null
    void reload()
    return () => operation.current?.abort()
    // Reload on client identity only; preserve current form on other renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  function selectRule(id: string) {
    if (operation.current || id === edgeId) return
    const next = rules.find(edge => edge.id === id)
    if (!next?.rule) return
    setEdgeId(id)
    setThreshold(String(next.rule.value))
    setProposal(null)
    setNotice('')
  }

  function writeProblem(error: unknown, confirming: boolean) {
    const e = error instanceof AiHttpClientError ? error : null
    setProposal(null)
    if (e?.status === 409) {
      setNeedsRefresh(true)
      setProblem('草稿版本已变化。请先刷新草稿，再重新审阅改动。')
    } else if (confirming && (e?.status === 410 || e?.code === 'expired')) {
      setProblem('提案已过期，请重新审阅改动。')
    } else if (e && [401, 403, 404].includes(e.status)) {
      setNeedsRefresh(true)
      setProblem('登录或权限已变化。请刷新草稿重新检查权限。')
    } else if (confirming || !e || !e.status || e.status >= 500) {
      setNeedsRefresh(true)
      setProblem('未能核实操作结果。请先刷新草稿确认当前版本，不要重复提交。')
    } else {
      setProblem('无法准备此修改。请检查金额与条件，或刷新草稿。')
    }
  }

  async function startReview() {
    if (operation.current || !canStartReview || !state || !selected || candidate === null) return
    const controller = new AbortController()
    operation.current = controller
    setPhase('prepare')
    setProblem('')
    setNotice('')
    try {
      const result = await client.prepare(state.draft.revision, selected.id, candidate, controller.signal)
      if (!controller.signal.aborted) setProposal(result)
    } catch (error) { if (!controller.signal.aborted) writeProblem(error, false) }
    finally { if (operation.current === controller && !controller.signal.aborted) { operation.current = null; setPhase(null) } }
  }

  async function confirm() {
    if (operation.current || !canConfirm || !proposal || phase || needsRefresh) return
    const controller = new AbortController()
    operation.current = controller
    setPhase('confirm')
    setProblem('')
    try {
      const receipt = await client.confirm(proposal, controller.signal)
      if (!controller.signal.aborted) {
        acknowledgedRevision.current = receipt.revision
        await reload(edgeId)
      }
    } catch (error) { if (!controller.signal.aborted) writeProblem(error, true) }
    finally { if (operation.current === controller && !controller.signal.aborted) { operation.current = null; setPhase(null) } }
  }

  return <main className="pilot-workspace">
    <header className="pilot-toolbar"><div className="pilot-brand"><span aria-hidden="true">序</span> 审批工作台 <small>企业试点</small></div>
      <div className="pilot-meta">{state && <span className="pilot-revision">草稿 v{state.draft.revision}</span>}
        <button type="button" className="pilot-button" onClick={() => { if (!operation.current) void reload(edgeId) }} disabled={Boolean(phase)}>刷新草稿</button></div>
    </header>
    <div className="pilot-heading"><p className="pilot-kicker">流程管理 / 金额规则</p><h1>{workflow?.name ?? '审批规则'}</h1>
      <p>选择一条金额分支，先预演审批走向，再审阅和确认草稿改动。</p></div>
    {problem && <p className="pilot-alert" role="alert">{problem}</p>}
    {notice && <p className="pilot-notice" data-write-state="saved" role="status">{notice}</p>}
    {!workflow && phase === 'load' && <p className="pilot-alert" role="status">正在加载草稿…</p>}
    {workflow && <div className="pilot-grid">
      <aside className="pilot-panel" aria-labelledby="pilot-rules-heading">
        <div className="pilot-panel-head"><div><p className="pilot-kicker">规则检查器</p><h2 id="pilot-rules-heading">金额分支</h2></div>
          <span className="pilot-badge">{canConfirm ? '可确认草稿' : canPrepare ? '可准备提案' : '只读'}</span></div>
        {!selected?.rule ? <p>此流程没有可调整的金额规则。</p> : <>
          <label className="pilot-field">选择规则
            <select value={edgeId} onChange={event => selectRule(event.target.value)} disabled={Boolean(phase)}>
              {rules.map(edge => <option key={edge.id} value={edge.id}>{name(edge.from)} → {name(edge.to)}</option>)}
            </select>
          </label>
          <div className="pilot-current"><div><small>原分支条件</small><strong>{ruleText(selected.rule)}</strong></div>
            <div><small>流向 / 审批人</small><strong>{approver || name(selected.to)}</strong></div></div>
          <form onSubmit={event => { event.preventDefault(); if (canStartReview && !proposal) void startReview() }}>
            <div className="pilot-fields">
              {canPrepare && <label className="pilot-field">新门槛（元）
                <input id="pilot-threshold" type="number" min="0" step="any" value={threshold} onChange={event => {
                  setThreshold(event.target.value); setProposal(null); setNotice('')
                }} disabled={Boolean(phase) || needsRefresh}/>
              </label>}
              <label className="pilot-field">试算金额（元）
                <input id="pilot-test-amount" type="number" min="0" step="any" value={trial} onChange={event => {
                  setTrial(event.target.value)
                }} disabled={Boolean(phase)}/>
              </label>
            </div>
            <div className="pilot-boundary" aria-label="界值试算">
              <button id="pilot-boundary-current" type="button" className="pilot-button" disabled={Boolean(phase)}
                onClick={() => setTrial(String(selected.rule!.value))}>试算原门槛 · {money(selected.rule.value)} 元</button>
              {canPrepare && candidate !== null && candidate !== selected.rule.value &&
                <button id="pilot-boundary-candidate" type="button" className="pilot-button" disabled={Boolean(phase)}
                  onClick={() => setTrial(String(candidate))}>试算新门槛 · {money(candidate)} 元</button>}
            </div>
            <section className="pilot-impact" data-write-state={canPrepare ? (proposal ? "pending" : "preview") : "readonly"} aria-label="路径预演">
              <div className="pilot-impact-head"><h3>审批影响</h3>
                <span className="pilot-badge">{!canPrepare ? '只读试算' : proposal ? '待确认 · 未写入' : '本地试算 · 未写入'}</span></div>
              <p>只试算这个金额，不执行审批，不写入草稿。</p>
              {canPrepare && impact && trialValue !== null && <div className="pilot-delta" aria-label="审批变化" data-impact-kind={impact.kind} aria-live="polite">
                <strong>{money(trialValue)} 元 · {impactLabel[impact.kind]}</strong>
                {impact.added.length > 0 && <p className="pilot-delta-added"><b>新增审批</b> {impact.added.map(node => node.name).join('、')}</p>}
                {impact.removed.length > 0 && <p className="pilot-delta-removed"><b>移除审批</b> {impact.removed.map(node => node.name).join('、')}</p>}
              </div>}
              <dl className="pilot-compact-path"><dt>当前审批</dt><dd>{current ? approvals(current.nodeIds) : '请输入有效的试算金额，或检查流程规则。'}</dd>
                {canPrepare && <><dt>修改后审批</dt><dd>{updated ? approvals(updated.nodeIds) : '请输入有效的新门槛和试算金额，或检查流程规则。'}</dd></>}
              </dl>
              {(current || updated) && <details className="pilot-path-details"><summary>查看完整路径</summary>
                <dl>{current && <><dt>当前路径</dt><dd>{current.nodeIds.map(name).join(' → ')}</dd></>}
                  {canPrepare && updated && <><dt>修改后路径</dt><dd>{updated.nodeIds.map(name).join(' → ')}</dd></>}
                </dl>
              </details>}
            </section>
            {canPrepare && !reviewing && <div className="pilot-actions">
              <button type="submit" className="pilot-button pilot-primary" disabled={!canStartReview}>{phase === 'prepare' ? '正在准备…' : '审阅改动'}</button>
              <small>这一步只准备提案，不写草稿。</small>
            </div>}
          </form>
          {proposal && selected.rule && candidate !== null && <section className="pilot-review" aria-labelledby="pilot-review-heading">
            <div className="pilot-impact-head"><h3 id="pilot-review-heading">待确认的改动</h3><span className="pilot-badge">草稿 v{state?.draft.revision}</span></div>
            <p>{ruleText(selected.rule)} → <strong>{ruleText({ ...selected.rule, value: candidate })}</strong></p>
            <small>{canConfirm ? '只写入当前草稿，不发布流程。' : '已准备提案；你的角色不能确认或写入草稿。'}</small>
            <div className="pilot-actions">
              {canConfirm && <button type="button" className="pilot-button pilot-primary" disabled={Boolean(phase) || needsRefresh} onClick={() => void confirm()}>{phase === 'confirm' ? '正在确认…' : '确认写入草稿'}</button>}
              <button type="button" className="pilot-button" disabled={Boolean(phase)} onClick={() => setProposal(null)}>返回编辑</button>
            </div>
          </section>}
        </>}
      </aside>
      <div className="pilot-canvas"><Canvas workflow={workflow} selected={nodeId} onSelect={setNodeId}
        selectedRule={edgeId} onSelectRule={selectRule} /></div>
    </div>}
  </main>
}
