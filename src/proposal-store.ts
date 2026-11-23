/** Server-only reference persistence. Scope and human confirmation come from a
 * trusted application adapter; this module does not authenticate a caller. */
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Scope } from './ai-core.ts'
import { proposeThresholdChange } from './assistant.ts'
import { validate, type Workflow } from './workflow.ts'

export type { Scope } from './ai-core.ts'
export type ProposalScope = Scope & {workspaceId?: string}
export type AuditEvent = Receipt & {
  actorUserId: string
  workspaceId: string
  projectId: string
  environment: string
  operation: Operation
}
export type Operation = { kind: 'set_amount_threshold'; edgeId: string; value: number }
export type Draft = { workflowId: string; revision: number; workflow: Workflow }
export type Receipt = { proposalId: string; workflowId: string; previousRevision: number; revision: number; confirmedAt: number }
export type Proposal = { proposalId: string; workflowId: string; expectedRevision: number; operation: Operation; expiresAt: number; receipt?: Receipt }
export type ProposalStoreErrorCode = 'invalid_scope'|'invalid_input'|'invalid_operation'|'not_found'|'revision_conflict'|'expired'|'already_exists'
export class ProposalStoreError extends Error {
  readonly code: ProposalStoreErrorCode
  constructor(code: ProposalStoreErrorCode, message: string) {
    super(message)
    this.name = 'ProposalStoreError'
    this.code = code
  }
}
type DraftRow = { revision: number; workflow: string }
type ProposalRow = { workflow_id: string; expected_revision: number; edge_id: string; threshold: number; expires_at: number }
type ConfirmationRow = { revision: number; confirmed_at: number }
const ttl = 15 * 60_000
const validId = (id: unknown): id is string => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 120
const assertRevision = (revision: number) => {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new ProposalStoreError('invalid_input', '版本号无效')
}
// Workspace owner keys deliberately exceed the maximum valid legacy user ID
// length, so an upgrade never aliases a legitimate per-user draft.
const workspacePrefix = 'workspace:' + '='.repeat(120) + ':'
const scopeKeys = (scope: ProposalScope): [string,string,string] => {
  if (!scope || !validId(scope.userId) || !validId(scope.projectId) || !validId(scope.environment) ||
      (scope.workspaceId !== undefined && !validId(scope.workspaceId))) {
    throw new ProposalStoreError('invalid_scope', '调用者范围无效')
  }
  return [scope.workspaceId === undefined ? scope.userId : workspacePrefix + scope.workspaceId, scope.projectId, scope.environment]
}
const assertWorkflowId = (workflowId: string) => {
  if (!validId(workflowId)) throw new ProposalStoreError('invalid_input', '流程标识无效')
}
const assertOperation = (operation: Operation) => {
  if (!operation || typeof operation !== 'object' || Object.keys(operation).length !== 3
      || !['kind','edgeId','value'].every(key => Object.hasOwn(operation, key))
      || operation.kind !== 'set_amount_threshold' || !validId(operation.edgeId)
      || !Number.isFinite(operation.value) || operation.value < 0) {
    throw new ProposalStoreError('invalid_operation', '无效的金额条件操作')
  }
}
const propose = (workflow: Workflow, operation: Operation) => {
  try { return proposeThresholdChange(workflow, operation.edgeId, operation.value) }
  catch { throw new ProposalStoreError('invalid_operation', '无法修改此流程的金额条件') }
}
const assertCurrent = (draft: Draft, expected: number) => {
  if (draft.revision !== expected) throw new ProposalStoreError('revision_conflict', '草稿版本已变化，请重新生成提案')
}

export class ProposalStore {
  readonly #db: DatabaseSync
  readonly #now: () => number
  constructor(path: string, now: () => number = Date.now) {
    this.#now = now
    this.#db = new DatabaseSync(path)
    try {
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS proposal_drafts (
          user_id TEXT NOT NULL, project_id TEXT NOT NULL, environment TEXT NOT NULL,
          workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, workflow TEXT NOT NULL,
          PRIMARY KEY (user_id, project_id, environment, workflow_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_proposals (
          proposal_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
          environment TEXT NOT NULL, workflow_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
          edge_id TEXT NOT NULL, threshold REAL NOT NULL, expires_at INTEGER NOT NULL,
          FOREIGN KEY (user_id, project_id, environment, workflow_id)
            REFERENCES proposal_drafts (user_id, project_id, environment, workflow_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proposals_by_draft ON
          workflow_proposals (user_id, project_id, environment, workflow_id);
        CREATE TABLE IF NOT EXISTS workspace_proposal_actors (
          proposal_id TEXT PRIMARY KEY REFERENCES workflow_proposals(proposal_id),
          actor_user_id TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS proposal_confirmations (
          proposal_id TEXT PRIMARY KEY REFERENCES workflow_proposals(proposal_id),
          revision INTEGER NOT NULL, confirmed_at INTEGER NOT NULL, backup TEXT NOT NULL
        ) STRICT;
      `)
    } catch (error) { this.#db.close(); throw error }
  }
  close(): void { this.#db.close() }
  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
  /** Authorized bootstrap only. Never overwrites an existing draft. */
  putInitialDraft(scope: ProposalScope, workflowId: string, workflow: Workflow): Draft {
    const keys = scopeKeys(scope)
    assertWorkflowId(workflowId)
    const issues = validate(workflow)
    if (issues.length) throw new ProposalStoreError('invalid_input', '草稿无效：'+issues.join('；'))
    const serialized = JSON.stringify(workflow)
    const result = this.#db.prepare(
      'INSERT INTO proposal_drafts VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING',
    ).run(...keys, workflowId, serialized)
    if (result.changes !== 1) throw new ProposalStoreError('already_exists', '流程草稿已存在')
    return {workflowId, revision: 1, workflow: JSON.parse(serialized) as Workflow}
  }
  getDraft(scope: ProposalScope, workflowId: string): Draft | null {
    const keys = scopeKeys(scope)
    assertWorkflowId(workflowId)
    const row = this.#db.prepare(
      'SELECT revision, workflow FROM proposal_drafts WHERE user_id=? AND project_id=? AND environment=? AND workflow_id=?',
    ).get(...keys, workflowId) as DraftRow | undefined
    return row ? {workflowId, revision: row.revision, workflow: JSON.parse(row.workflow) as Workflow} : null
  }
  prepare(scope: ProposalScope, workflowId: string, expectedRevision: number, operation: Operation): Proposal {
    const keys = scopeKeys(scope)
    assertWorkflowId(workflowId)
    assertRevision(expectedRevision)
    assertOperation(operation)
    return this.#transaction(() => {
      const draft = this.getDraft(scope, workflowId)
      if (!draft) throw new ProposalStoreError('not_found', '流程草稿不存在')
      assertCurrent(draft, expectedRevision)
      if (!propose(draft.workflow, operation).changes.length)
        throw new ProposalStoreError('invalid_operation', '该操作没有修改金额条件')
      const proposalId = randomBytes(32).toString('hex')
      const expiresAt = this.#now() + ttl
      this.#db.prepare('INSERT INTO workflow_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(proposalId, ...keys, workflowId, expectedRevision, operation.edgeId, operation.value, expiresAt)
      if (scope.workspaceId !== undefined) {
        this.#db.prepare('INSERT INTO workspace_proposal_actors VALUES (?, ?)').run(proposalId, scope.userId)
      }
      return {proposalId, workflowId, expectedRevision, operation: {...operation}, expiresAt}
    })
  }
  getProposal(scope: ProposalScope, proposalId: string): Proposal | null {
    const keys = scopeKeys(scope)
    if (typeof proposalId !== 'string' || !/^[a-f0-9]{64}$/.test(proposalId)) return null
    const row = this.#db.prepare(`
      SELECT p.workflow_id, p.expected_revision, p.edge_id, p.threshold, p.expires_at, c.revision, c.confirmed_at
      FROM workflow_proposals p LEFT JOIN proposal_confirmations c ON p.proposal_id=c.proposal_id
      LEFT JOIN workspace_proposal_actors a ON a.proposal_id=p.proposal_id
      WHERE p.proposal_id=? AND p.user_id=? AND p.project_id=? AND p.environment=? AND a.actor_user_id IS ?
    `).get(proposalId,...keys,scope.workspaceId===undefined?null:scope.userId) as (ProposalRow & (ConfirmationRow | {revision: null; confirmed_at: null})) | undefined
    if (!row) return null
    const proposal: Proposal = {
      proposalId, workflowId: row.workflow_id, expectedRevision: row.expected_revision,
      operation: {kind:'set_amount_threshold',edgeId:row.edge_id,value:row.threshold}, expiresAt: row.expires_at,
    }
    if (row.revision !== null) proposal.receipt = {
      proposalId, workflowId: row.workflow_id, previousRevision: row.expected_revision,
      revision: row.revision, confirmedAt: row.confirmed_at,
    }
    return proposal
  }
  /** The trusted adapter must authorize audit separately from ordinary draft reads. */
  listAudit(scope: ProposalScope, workflowId: string, {before,limit=25}: {before?:number;limit?:number} = {}): AuditEvent[] {
    const keys = scopeKeys(scope)
    assertWorkflowId(workflowId)
    if (before !== undefined) assertRevision(before)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProposalStoreError('invalid_input','审计页大小必须是 1 到 100 的整数')
    if (scope.workspaceId === undefined) return []
    const workspaceId = scope.workspaceId
    // Confirmations, the proposal metadata and its immutable actor binding are
    // the audit record. An uncommitted or rolled-back confirmation is invisible.
    const rows = this.#db.prepare(`
      SELECT p.proposal_id, p.expected_revision, p.edge_id, p.threshold, a.actor_user_id, c.revision, c.confirmed_at
      FROM workflow_proposals p
      JOIN workspace_proposal_actors a ON a.proposal_id=p.proposal_id
      JOIN proposal_confirmations c ON c.proposal_id=p.proposal_id
      WHERE p.user_id=? AND p.project_id=? AND p.environment=? AND p.workflow_id=?
        AND (? IS NULL OR c.revision < ?)
      ORDER BY c.revision DESC LIMIT ?
    `).all(...keys,workflowId,before??null,before??null,limit) as
      (Pick<ProposalRow,'expected_revision'|'edge_id'|'threshold'> & ConfirmationRow & {proposal_id:string;actor_user_id:string})[]
    return rows.map(row=>({
      proposalId:row.proposal_id,actorUserId:row.actor_user_id,workspaceId,projectId:scope.projectId,environment:scope.environment,
      workflowId,previousRevision:row.expected_revision,revision:row.revision,confirmedAt:row.confirmed_at,
      operation:{kind:'set_amount_threshold',edgeId:row.edge_id,value:row.threshold},
    }))
  }
  /** Call only after verifying an explicit human action in the trusted adapter. */
  confirm(scope: ProposalScope, proposalId: string, expectedRevision: number): Receipt {
    const keys = scopeKeys(scope)
    assertRevision(expectedRevision)
    return this.#transaction(() => {
      const proposal = this.getProposal(scope, proposalId)
      if (!proposal) throw new ProposalStoreError('not_found', '提案不存在')
      if (proposal.expectedRevision !== expectedRevision) throw new ProposalStoreError('revision_conflict', '提案版本不匹配')
      if (proposal.receipt) return proposal.receipt
      const confirmedAt = this.#now()
      if (confirmedAt >= proposal.expiresAt) throw new ProposalStoreError('expired', '提案已过期')
      const draft = this.getDraft(scope, proposal.workflowId)
      if (!draft) throw new ProposalStoreError('not_found', '流程草稿不存在')
      assertCurrent(draft, expectedRevision)
      const { candidate, changes } = propose(draft.workflow, proposal.operation)
      if (!changes.length) throw new ProposalStoreError('invalid_operation', '该操作没有修改金额条件')
      const revision = draft.revision + 1
      assertRevision(revision)
      const updated = this.#db.prepare(`
        UPDATE proposal_drafts SET revision=?, workflow=?
        WHERE user_id=? AND project_id=? AND environment=? AND workflow_id=? AND revision=?
      `).run(revision, JSON.stringify(candidate), ...keys, proposal.workflowId, expectedRevision)
      if (updated.changes !== 1) throw new ProposalStoreError('revision_conflict', '草稿版本已变化，请重新生成提案')
      this.#db.prepare('INSERT INTO proposal_confirmations VALUES (?, ?, ?, ?)')
        .run(proposalId, revision, confirmedAt, JSON.stringify(draft.workflow))
      return {proposalId, workflowId: proposal.workflowId, previousRevision: expectedRevision, revision, confirmedAt}
    })
  }
}
