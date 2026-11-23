import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotAccess, type PilotRole, type PilotTarget } from '../src/pilot-access.ts';

const origin='https://pilot.example.test';
const target:PilotTarget={workspaceId:'tenant-a',projectId:'procurement',environment:'pilot',workflowId:'purchase'};
const url=origin+'/v1/ai/workflows/purchase';

test('verified identities receive only their configured role grants for the exact target', async()=>{
  for(const [role,canPrepare,canConfirm,canAudit] of [
    ['viewer',false,false,false],['editor',true,false,false],
    ['approver',true,true,false],['auditor',false,false,true],
  ] as const satisfies readonly (readonly [PilotRole,boolean,boolean,boolean])[]){
    const authorize=createPilotAccess({origin,target,identify:async()=> 'issuer|actor',memberships:[{...target,actorId:'issuer|actor',role}]});
    const grant=await authorize(new Request(url),'purchase');
    assert.deepEqual(grant,{scope:{userId:'issuer|actor',workspaceId:'tenant-a',projectId:'procurement',environment:'pilot'},
      canRead:role!=='auditor',canRun:false,canPrepare,canConfirm,canAudit});
    assert.ok(Object.isFrozen(grant));
    assert.ok(Object.isFrozen(grant?.scope));
    assert.equal(await authorize(new Request(url),'other'),null);
  }
});

test('membership dimensions are matched exactly and unknown identities deny without reading the body', async()=>{
  for(const key of ['workspaceId','projectId','environment','workflowId'] as const){
    const authorize=createPilotAccess({origin,target,identify:async()=> 'actor',memberships:[{...target,[key]:'other',actorId:'actor',role:'approver'}]});
    assert.equal(await authorize(new Request(url),'purchase'),null,key);
  }
  for(const identify of [async()=>null,async()=> 'unknown',async()=>{throw new Error('adapter failure');}]){
    const authorize=createPilotAccess({origin,target,identify,memberships:[{...target,actorId:'actor',role:'approver'}]});
    const request=new Request(url+'?actorId=actor',{method:'POST',headers:{origin,'x-actor-id':'actor'},body:'{"actorId":"actor"}'});
    assert.equal(await authorize(request,'purchase'),null);
    assert.equal(request.bodyUsed,false);
  }
});

test('only same-origin targets and exact POST origin pass to the identity adapter',async()=>{
  let calls=0;
  const authorize=createPilotAccess({origin,target,identify:async()=>{calls++;return 'actor';},
    memberships:[{...target,actorId:'actor',role:'editor'}]});
  for(const request of [
    new Request('https://other.example.test/workflows/purchase'),
    new Request('blob:https://pilot.example.test/synthetic'),
    new Request(url,{method:'DELETE',headers:{origin}}),
    new Request(url,{method:'POST'}),
    new Request(url,{method:'POST',headers:{origin:origin+'/'}}),
    new Request(url,{method:'POST',headers:{origin,'sec-fetch-site':'same-site'}}),
  ]) assert.equal(await authorize(request,'purchase'),null);
  assert.equal(calls,0);
  assert.ok(await authorize(new Request(url,{method:'POST',headers:{origin,'sec-fetch-site':'same-origin'}}),'purchase'));
  assert.ok(await authorize(new Request(url,{method:'POST',headers:{origin}}),'purchase'));
});

test('authorization is unaffected by subsequent changes to its configuration',async()=>{
  const mutableTarget={...target};
  const membership={...target,actorId:'actor',role:'viewer' as PilotRole};
  const options={origin,target:mutableTarget,identify:async()=> 'actor',memberships:[membership]};
  const authorize=createPilotAccess(options);
  mutableTarget.workspaceId='other';
  membership.role='approver';
  options.identify=async()=> 'other';
  options.memberships.length=0;
  const grant=await authorize(new Request(url),'purchase');
  assert.equal(grant?.scope.workspaceId,target.workspaceId);
  assert.equal(grant?.canConfirm,false);
});

test('ambiguous or invalid configuration is rejected at initialization',()=>{
  const member={...target,actorId:'actor',role:'viewer' as PilotRole};
  const options={origin,target,identify:async()=> 'actor',memberships:[member]};
  for(const invalid of [
    {...options,origin:'http://pilot.example.test'},
    {...options,origin:origin+'/'},
    {...options,origin:origin+'?'},
    {...options,origin:origin+'#'},
    {...options,origin:'https://PILOT.example.test'},
    {...options,origin:origin+':443'},
    {...options,target:{...target,projectId:''}},
    {...options,target:{...target,workflowId:'invalid/workflow'}},
    {...options,memberships:[{...member,role:'administrator' as PilotRole}]},
    {...options,memberships:[member,{...member,role:'approver' as PilotRole}]},
  ]) assert.throws(()=>createPilotAccess(invalid));
});
