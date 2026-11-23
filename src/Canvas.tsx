import React, { useState, type KeyboardEvent } from 'react'
import { Background, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, getBezierPath,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance, type XYPosition } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './canvas.css'

type Kind = 'start' | 'approval' | 'decision' | 'merge' | 'end'
type FlowNode = { id: string; kind: Kind; name: string; role?: string; x: number; y: number }
type FlowEdge = { id: string; from: string; to: string; label?: string; rule?: { op: 'gte' | 'gt' | 'lt' | 'lte'; value: number }; fallback?: boolean }
type Props = {
  workflow: { nodes: FlowNode[]; edges: FlowEdge[] }
  selected: string | null
  preview?: { nodeIds: string[]; edgeIds: string[] } | null
  onSelect(id: string): void
  onMove?(id: string, x: number, y: number): void
  onInsert?(edgeId: string): void
  onSelectRule?(edgeId: string): void
  selectedRule?: string | null
  onConnect?(from: string, to: string): void
}

const captions: Record<Kind, string> = { start: '开始', approval: '审批', decision: '条件分流', merge: '汇合', end: '结束' }
const opLabels = { gte: '≥', gt: '>', lt: '<', lte: '≤' }
const dimensions: Record<Kind, [number, number]> = { start: [126, 38], approval: [180, 58], decision: [180, 58], merge: [138, 38], end: [126, 38] }
const money = (n: number) => new Intl.NumberFormat('zh-CN').format(n)

function Glyph({ kind }: { kind: Kind }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'start' ? <path d="M8 5.5v13l10-6.5z"/> : kind === 'end' ? <rect x="7" y="7" width="10" height="10" rx="1"/>
      : kind === 'decision' ? <><path d="m12 3 4 4-4 4-4-4zM12 11v3m0 0H6v4m6-4h6v4"/><path d="M4 18h4m8 0h4"/></>
      : kind === 'merge' ? <path d="M5 5h3l4 6m7-6h-3l-4 6m0 0v8m-3-3 3 3 3-3"/>
      : <><path d="M7 4h8l3 3v13H7zM14 4v4h4"/><path d="m10 13 2 2 4-4"/></>}
  </svg>
}

type CanvasNode = Node<{
  node: FlowNode; active: boolean; connecting: boolean; canConnect: boolean; select: () => void;
  keyAction: (event: KeyboardEvent<HTMLButtonElement>) => void
}, 'approval'>
type CanvasEdge = Edge<{ edge: FlowEdge; fromName: string; toName: string; active: boolean; insert?: () => void; selectRule?: () => void; ruleSelected: boolean }, 'approval'>

function NodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const { node, active, connecting, canConnect, keyAction, select } = data
  const [width, height] = dimensions[node.kind]
  return <>
    {node.kind !== 'start' && <Handle id="incoming" type="target" position={Position.Top} className="wf-handle" isConnectable={canConnect}/>}
    <button type="button" data-node-id={node.id} data-kind={node.kind} data-preview={active} data-connect={connecting}
      aria-pressed={Boolean(selected)} className="wf-node" style={{ width, height }} onClick={select} onKeyDown={keyAction}>
      <span className="wf-node-icon"><Glyph kind={node.kind}/></span>
      <span className="wf-node-text"><strong title={node.name}>{node.name || captions[node.kind]}</strong>{(node.kind === 'approval' || node.kind === 'decision') && <small>{node.role || (node.kind === 'approval' ? '待配置审批人' : '根据条件选择分支')}</small>}</span>
    </button>
    {node.kind !== 'end' && <Handle id="outgoing" type="source" position={Position.Bottom} className="wf-handle" isConnectable={canConnect}/>}
  </>
}

function InsertableEdge({ data, id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, markerEnd }: EdgeProps<CanvasEdge>) {
  if (!data) return null
  const { edge, fromName, toName, active, insert, selectRule, ruleSelected } = data
  const [d, x, y] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.22 })
  const label = edge.label || (edge.fallback ? '默认分支' : edge.rule ? `金额 ${opLabels[edge.rule.op]} ${money(edge.rule.value)} 元` : '')
  return <>
    <g data-edge-id={edge.id} data-preview={active}>
      <BaseEdge id={id} path={d} markerEnd={markerEnd} interactionWidth={0} className={edge.fallback ? 'wf-edge wf-edge-fallback' : 'wf-edge'}/>
    </g>
    <EdgeLabelRenderer>
      <div className="wf-edge-action nopan nodrag" data-rule-action={Boolean(selectRule)} style={{ left: x, top: y }}>
        {insert && <button type="button" className="wf-edge-add" aria-label={`在连接线上插入节点：${fromName} → ${toName}`} onClick={insert}>+</button>}
        {label && (selectRule ? <button type="button" className="wf-edge-label wf-rule-action" data-rule-id={edge.id} aria-label={`选择金额规则：${fromName} → ${toName}，${label}`} aria-pressed={ruleSelected} onClick={selectRule}>{label}</button> : <span className="wf-edge-label" data-fallback={edge.fallback || undefined}>{label}</span>)}
      </div>
    </EdgeLabelRenderer>
  </>
}

const nodeTypes = { approval: NodeCard }
const edgeTypes = { approval: InsertableEdge }
const origin: [number, number] = [0.5, 0.5]

export default function Canvas({ workflow, selected, onSelect, onMove, onInsert, preview, onConnect, onSelectRule, selectedRule }: Props) {
  const [view, setView] = useState<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const [zoom, setZoom] = useState(1)
  const [dragPositions, setDragPositions] = useState<Record<string, XYPosition>>({})
  const [connecting, setConnecting] = useState(false)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const nodeMap = new Map(workflow.nodes.map(node => [node.id, node]))
  const previewNodes = new Set(preview?.nodeIds), previewEdges = new Set(preview?.edgeIds)
  const cancelConnection = () => { setConnectFrom(null); setConnecting(false) }

  function select(id: string) {
    onSelect(id)
    if (!connecting || !onConnect) return
    if (!connectFrom) { setConnectFrom(id); return }
    if (connectFrom !== id) onConnect(connectFrom, id)
    cancelConnection()
  }

  function keyboard(event: KeyboardEvent<HTMLButtonElement>, node: FlowNode) {
    if (event.key === 'Escape' && connecting) { cancelConnection(); event.stopPropagation(); return }
    if (!event.altKey || connecting || !onMove) return
    const step: Record<string, [number, number]> = { ArrowUp: [0,-8], ArrowDown: [0,8], ArrowLeft: [-8,0], ArrowRight: [8,0] }
    const offset = step[event.key]
    if (offset) {
      event.preventDefault(); event.stopPropagation()
      onSelect(node.id); onMove(node.id, Math.round(node.x + offset[0]), Math.round(node.y + offset[1]))
    }
  }

  const nodes: CanvasNode[] = workflow.nodes.map(node => {
    const [width, height] = dimensions[node.kind]
    return { id: node.id, type: 'approval', position: dragPositions[node.id] ?? { x: node.x, y: node.y },
      style: { width, height }, width, height,
      handles: [
        ...(node.kind !== 'start' ? [{ id:'incoming', type:'target' as const, position:Position.Top, x: width / 2 - 4, y:-4, width:8, height:8 }] : []),
        ...(node.kind !== 'end' ? [{ id:'outgoing', type:'source' as const, position:Position.Bottom, x: width / 2 - 4, y: height - 4, width:8, height:8 }] : [])
      ],
      selected: node.id === selected, draggable: Boolean(onMove) && !connecting,
      focusable: false, deletable: false,
      data: { node, active: previewNodes.has(node.id), connecting: connecting && connectFrom === node.id,
        canConnect: Boolean(onConnect), select: () => select(node.id), keyAction: event => keyboard(event, node) } }
  })
  const edges: CanvasEdge[] = workflow.edges.flatMap(edge => {
    const a = nodeMap.get(edge.from), b = nodeMap.get(edge.to)
    if (!a || !b) return []
    const ruleSelected = selectedRule === edge.id
    const active = previewEdges.has(edge.id) || ruleSelected
    return [{ id: edge.id, type: 'approval', source: edge.from, target: edge.to, sourceHandle: 'outgoing', targetHandle: 'incoming', selectable: false, deletable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: active ? '#3774f5' : '#98a9c2' },
      data: { edge, fromName: a.name, toName: b.name, active, insert: onInsert ? () => onInsert(edge.id) : undefined,
        selectRule: edge.rule && onSelectRule ? () => onSelectRule(edge.id) : undefined, ruleSelected } }]
  })

  return <section className="wf-canvas" aria-label="审批流程画布">
    <div className="wf-canvas-top">
      <div className="wf-canvas-heading"><span className="wf-canvas-heading-dot"/><span>审批流程</span></div>
      <span className="wf-canvas-count">{nodes.length} 个节点<span aria-hidden="true"> · </span>{edges.length} 条连接</span>
    </div>
    {connecting && <div className="wf-connect-notice" role="status">{connectFrom ? '选择目标节点完成连接' : '选择连接的起始节点'} <span>Esc 取消</span></div>}
    <div className="wf-canvas-viewport">
      <ReactFlow<CanvasNode, CanvasEdge> nodes={nodes} edges={edges} nodeOrigin={origin} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onInit={setView} onMove={(_event, next) => setZoom(next.zoom)}
        onNodeDragStart={(_event, node) => onSelect(node.id)}
        onNodeDrag={(_event, node) => setDragPositions(prev => ({ ...prev, [node.id]: node.position }))}
        onNodeDragStop={(_event, node) => {
          onMove?.(node.id, Math.round(node.position.x), Math.round(node.position.y))
          setDragPositions(prev => { const next = { ...prev }; delete next[node.id]; return next })
        }}
        onConnect={onConnect ? connection => onConnect(connection.source, connection.target) : undefined}
        nodesConnectable={Boolean(onConnect) && !connecting} elementsSelectable={false} edgesFocusable={false}
        fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }} minZoom={0.35} maxZoom={2}
        nodeDragThreshold={3} deleteKeyCode={null} zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}>
        <Background gap={18} size={1.15} color="#d4dfee"/>
      </ReactFlow>
    </div>
    <div className="wf-canvas-tools" aria-label="画布工具">
      {onConnect && <button type="button" title="连接两个节点" aria-label="连接节点" aria-pressed={connecting} onClick={() => connecting ? cancelConnection() : setConnecting(true)}>连线</button>}
      <button type="button" aria-label="缩小画布" onClick={() => void view?.zoomOut({ duration: 130 })} disabled={!view || zoom <= 0.35}>−</button>
      <span className="wf-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大画布" onClick={() => void view?.zoomIn({ duration: 130 })} disabled={!view || zoom >= 2}>+</button>
      <span className="wf-tool-divider"/>
      <button type="button" title="适应画布" aria-label="适应画布" onClick={() => void view?.fitView({ padding: 0.22, maxZoom: 1, duration: 180 })}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M9 5H5v4m10-4h4v4m-4 10h4v-4m-10 4H5v-4"/></svg></button>
    </div>
    <div className="wf-canvas-hint">{onSelectRule ? '点击金额连线选择规则' : onMove ? '拖动节点调整位置' : '只读审批流程'}</div>
  </section>
}
