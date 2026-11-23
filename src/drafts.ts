import type { Workflow } from './workflow.ts';

export type Snapshot = { id: string; label: string; created: string; workflow: Workflow };
export type SavedDraft = { version: 1; workflow: Workflow; snapshots: Snapshot[] };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const string = (value: unknown) => typeof value === 'string';
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

function isWorkflow(value: unknown): value is Workflow {
  return isObject(value) && string(value.name) &&
    Array.isArray(value.nodes) && value.nodes.every(n => isObject(n) && string(n.id) && string(n.name) &&
      ['start','approval','decision','merge','end'].includes(String(n.kind)) && number(n.x) && number(n.y) &&
      (n.role === undefined || string(n.role))) &&
    Array.isArray(value.edges) && value.edges.every(e => isObject(e) && string(e.id) && string(e.from) &&
      string(e.to) && (e.label === undefined || string(e.label)) &&
      (e.fallback === undefined || typeof e.fallback === 'boolean') &&
      (e.rule === undefined || (isObject(e.rule) && ['gte','gt','lt','lte'].includes(String(e.rule.op)) && number(e.rule.value))));
}

export function parseSavedDraft(raw: string | null): SavedDraft | undefined {
  if (!raw) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value) && value.version === 1 && isWorkflow(value.workflow) && Array.isArray(value.snapshots) &&
      value.snapshots.every(s => isObject(s) && string(s.id) && string(s.label) && string(s.created) && isWorkflow(s.workflow))) {
      return { version: 1, workflow: value.workflow, snapshots: value.snapshots as Snapshot[] };
    }
  } catch { /* Ignore malformed local data. */ }
}
export function makeSnapshot(workflow: Workflow, label: string): Snapshot {
  return { id: crypto.randomUUID(), label, created: new Date().toISOString(), workflow: structuredClone(workflow) };
}
export function restoreSnapshot(snapshot: Snapshot): Workflow {
  return structuredClone(snapshot.workflow);
}
