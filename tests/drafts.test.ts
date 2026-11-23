import { strict as assert } from 'node:assert';
import test from 'node:test';
import { makeSnapshot, parseSavedDraft, restoreSnapshot } from '../src/drafts.ts';
const workflow = { name: '采购', nodes: [{id:'start',name:'开始',kind:'start',x:100,y:20}] as const, edges: [] };
test('invalid persisted payloads do not load', () => {
 assert.equal(parseSavedDraft('not json'), undefined)
 assert.equal(parseSavedDraft('{"version":1,"workflow":{"name":"old","nodes":[],"edges":[null]},"snapshots":[]}'), undefined)
})
test('saving and restoring a snapshot uses a copy, not a shared draft object', () => {
 const input = structuredClone(workflow) as unknown as Parameters<typeof makeSnapshot>[0]
 const snapshot = makeSnapshot(input, '基线')
 input.nodes[0].name = '修改一';
 const restored = restoreSnapshot(snapshot)
 assert.equal(restored.nodes[0].name, '开始')
 restored.nodes[0].name = '修改二';
 assert.equal(snapshot.workflow.nodes[0].name, '开始')
 assert.equal(parseSavedDraft(JSON.stringify({version:1, workflow:input, snapshots:[snapshot]}))?.snapshots[0].label, '基线')
})
