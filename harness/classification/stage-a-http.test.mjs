import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,photo,observation,createStageHttpServer,groupMembers,contract} from './fixtures/stage-a.mjs';
async function serve(t,s){const app=createStageHttpServer({engine:s.engine,mode:'mock_transport',authorization:s.getAuth});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});t.after(()=>app.shutdown());
  return {url:`http://127.0.0.1:${app.server.address().port}`,app};}
async function post(url,body,headers={}){const r=await fetch(`${url}/v2/classification/run`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return {status:r.status,value:await r.json()};}
test('stage A HTTP -> actual engine -> API adapter with Mock transport -> event/person updates',async t=>{
  const photos=[photo('a','2008 生日'),photo('b','2008 生日')];const s=setup(photos,Object.fromEntries(photos.map(p=>[p.photoId,observation(p,{time:'2008',event:'生日',face:true})])),{eventDecision:()=> 'same',personDecision:()=> 'same'});
  const {url}=await serve(t,s);assert.equal((await (await fetch(`${url}/healthz`)).json()).mode,'mock_transport');
  const first=await post(url,s.req);assert.equal(first.status,200);assert.equal(first.value.usage.requests,3);assert.deepEqual(groupMembers(first.value,'event'),[['a','b']]);
  const reused=await post(url,s.req);assert.equal(reused.value.usage.requests,0);
  const altered=structuredClone(s.req);altered.budget.maxRequests=1;assert.equal((await post(url,altered)).status,409);
  s.req.runId='updated';s.req.photos[1].caption='2009 生日';s.bank.b=observation(s.req.photos[1],{time:'2009',event:'生日',face:true});s.sync();
  const next=await post(url,s.req);assert.equal(next.value.usage.requests,2);assert.equal(groupMembers(next.value,'event').length,2);
});
test('stage A HTTP rejects forged permission/source and additional fields',async t=>{
  const s=setup([photo('a')]);const {url}=await serve(t,s);const bad=structuredClone(s.req);bad.permissions='admin';assert.equal((await post(url,bad)).status,400);
  s.setAuth({...s.getAuth(),active:false});assert.equal((await post(url,s.req)).status,403);assert.equal(s.calls.length,0);
});
test('stage A HTTP cancel propagates and never saves late success',async t=>{
  let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const s=setup([photo('a')],{}, {beforeReply:async()=>{entered();await wait;}});const {url}=await serve(t,s);
  const pending=post(url,s.req);await started;const cancelled=await fetch(`${url}/v2/classification/runs/run1`,{method:'DELETE'});assert.equal(cancelled.status,200);
  const result=await pending;assert.equal(result.value.workflowStatus,'cancelled');assert.ok(!result.value.snapshot);release();
  assert.equal((await post(url,s.req)).status,409);
});
test('same runId in different authorized household scopes does not collide',async t=>{
  const s=setup([photo('a')]);const otherScope={householdId:'house_b',subjectId:'elder_b'};
  const other=structuredClone(s.req);other.scope=otherScope;other.authorizationRevision='auth_b';
  other.photos=other.photos.map(p=>({...p,scope:otherScope}));
  const authB={scope:otherScope,authorizationRevision:'auth_b',active:true,allowedPhotoIds:['a'],allowPersonMatching:true,
    photoVersions:{a:contract.photoHash(other.photos[0])},contextRevision:'ctx_b',reviewContextHash:contract.digest([other.references,other.corrections])};
  const app=createStageHttpServer({engine:s.engine,mode:'mock_transport',authorization:req=>req.headers['x-household']==='b'?authB:s.getAuth()});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});t.after(()=>app.shutdown());
  const url=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await post(url,s.req)).status,200);
  assert.equal((await post(url,other,{'x-household':'b'})).status,200);
});
