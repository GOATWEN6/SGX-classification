import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {preflight,validateApproval,scoreTask,bytesHash,scoreLabels,iou} from './stage-a-evaluation.mjs';
import {photo,observation,setup,png} from './fixtures/stage-a.mjs';
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'sgx-eval-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const photos=[photo('a','2008 生日'),photo('b','2008 生日')];
  const s=setup(photos,Object.fromEntries(photos.map(p=>[p.photoId,observation(p,{event:'生日',time:'2008',face:true})])),{eventDecision:()=> 'same',personDecision:()=> 'same'});
  const truth={version:'sgx-truth.1',reviewedBy:'fixture_author_not_model',photos:photos.map(p=>({photoId:p.photoId,sourceHash:p.sourceHash,
    facets:{time:[{value:'event:year:2008',aliases:[]}],place:[],event:[{value:'生日',aliases:[]}],scene:[{value:'室内',aliases:[]}]},
    faces:[{faceId:`gt_${p.photoId}`,personId:'person_a',box:{x:0.1,y:0.1,width:0.2,height:0.2}}],eventInstance:'birthday2008',expectedUnknownFacets:['place'],expectedConflicts:[]}))};
  const truthBytes=Buffer.from(JSON.stringify(truth));await writeFile(path.join(root,'truth.json'),truthBytes);await writeFile(path.join(root,'fixture.png'),png);
  const manifest={version:'sgx-eval.1',batchId:'local_fixture',status:'ready',partition:'exploration',provider:'qwen',model:'qwen3.5-flash-2026-02-23',providerUseReviewRef:'test_only_no_external_authority',
    prices:{inputCnyPerMillion:1.2,outputCnyPerMillion:12,source:'https://help.aliyun.com/zh/model-studio/qwen3-5-flash',checkedAt:new Date().toISOString()},
    caps:{maxRequests:10,maxInputTokens:1000000,maxOutputTokens:30000,maxCostCny:2,maxDurationSeconds:60,maxRetries:0},
    truth:{path:'truth.json',sha256:bytesHash(truthBytes)},photos:photos.map(p=>({photo:p,path:'fixture.png',split:'exploration',leakageGroup:'synthetic1',externalConsentRef:'test_only',personConsentRef:'test_only'})),
    tasks:[{taskId:'initial',request:s.req,evaluatePhotoIds:['a','b'],expectedUnchangedPhotoIds:[]}]};
  const manifestPath=path.join(root,'batch.json');const save=()=>writeFile(manifestPath,JSON.stringify(manifest));await save();
  return {root,manifest,manifestPath,save,truth,s};
}
test('offline preflight checks hashed materials and truth without invoking mock or network',async t=>{
  const f=await fixture(t);const b=await preflight(f.manifestPath);assert.equal(b.ready,true);assert.equal(b.summary.externalCalls,0);assert.equal(f.s.calls.length,0);assert.equal(b.summary.coldCacheRequestEstimate,3);
  f.manifest.status='draft';await f.save();assert.deepEqual((await preflight(f.manifestPath)).blockers,['MANIFEST_DRAFT']);
});
test('preflight rejects split leakage, material modification and missing independent truth',async t=>{
  const f=await fixture(t);f.manifest.photos[1].split='holdout';await f.save();await assert.rejects(preflight(f.manifestPath),/SPLIT_LEAKAGE/);
  f.manifest.photos[1].split='exploration';await f.save();await writeFile(path.join(f.root,'fixture.png'),'changed');await assert.rejects(preflight(f.manifestPath),/PHOTO_HASH_MISMATCH/);
  await writeFile(path.join(f.root,'fixture.png'),png);await writeFile(path.join(f.root,'truth.json'),'{}');await assert.rejects(preflight(f.manifestPath),/TRUTH_HASH_MISMATCH/);
});
test('preflight rejects duplicated unknown or conflict facets in independent truth',async t=>{
  const f=await fixture(t);f.truth.photos[0].expectedUnknownFacets=['place','place'];
  let bytes=Buffer.from(JSON.stringify(f.truth));await writeFile(path.join(f.root,'truth.json'),bytes);f.manifest.truth.sha256=bytesHash(bytes);await f.save();
  await assert.rejects(preflight(f.manifestPath),/DUPLICATE_FACET/);
  f.truth.photos[0].expectedUnknownFacets=['place'];f.truth.photos[0].expectedConflicts=['time','time'];
  bytes=Buffer.from(JSON.stringify(f.truth));await writeFile(path.join(f.root,'truth.json'),bytes);f.manifest.truth.sha256=bytesHash(bytes);await f.save();
  await assert.rejects(preflight(f.manifestPath),/DUPLICATE_FACET/);
});
test('approval binds exact batch hash, model, image set, cap and future expiration',async t=>{
  const f=await fixture(t);const b=await preflight(f.manifestPath);const a={version:'sgx-eval-approval.1',batchId:b.manifest.batchId,manifestHash:b.manifestHash,
    approvedBy:'test_only',authorizationEvidenceRef:'fixture_not_permission',expiresAt:new Date(Date.now()+60000).toISOString(),provider:b.manifest.provider,model:b.manifest.model,photoIds:b.usedPhotoIds,caps:b.manifest.caps,allowExternalImages:true,allowPersonMatching:true};
  assert.ok(validateApproval(b,a));assert.throws(()=>validateApproval(b,{...a,model:'another'}),/APPROVAL_MODEL_MISMATCH/);
  assert.throws(()=>validateApproval(b,{...a,photoIds:['a']}),/APPROVAL_PHOTO_MISMATCH/);assert.throws(()=>validateApproval(b,{...a,caps:{...a.caps,maxRequests:20}}),/APPROVAL_CAP_MISMATCH/);
  assert.throws(()=>validateApproval(b,{...a,expiresAt:'2000-01-01T00:00:00.000Z'}),/APPROVAL_EXPIRED/);
});
test('fixed denominators retain all failed photos and missed person/event pairs',async t=>{
  const f=await fixture(t);const score=scoreTask(f.manifest.tasks[0],undefined,f.truth);
  assert.equal(score.plannedPhotos,2);assert.equal(score.failedPhotos.length,2);assert.equal(score.facets.time.missed,2);assert.equal(score.facets.person.missed,2);
  assert.equal(score.personPairs.expectedSame,1);assert.equal(score.personPairs.missedSame,1);assert.equal(score.eventPairs.missedSame,1);assert.equal(score.historicalRetrieval.event.missed,1);
});
test('matching uses face boxes rather than assuming model face IDs equal truth IDs',async t=>{
  const f=await fixture(t);const result=await f.s.engine.process(f.s.req,f.s.getAuth);const score=scoreTask(f.manifest.tasks[0],result,f.truth);
  assert.equal(score.facets.person.correct,2);assert.equal(score.personPairs.correctSame,1);assert.equal(score.eventPairs.correctSame,1);assert.equal(score.facets.time.correct,2);
  result.snapshot.observations.b.value.people[0].box={x:0.6,y:0.6,width:0.2,height:0.2};const wrong=scoreTask(f.manifest.tasks[0],result,f.truth);
  assert.equal(wrong.facets.person.missed,1);assert.equal(wrong.facets.person.extra,1);assert.equal(wrong.personPairs.missedSame,1);
});
test('false merges count non-event photos and different people; omitted candidates still penalized',async t=>{
  const f=await fixture(t);const result=await f.s.engine.process(f.s.req,f.s.getAuth);f.truth.photos[1].eventInstance=null;f.truth.photos[1].faces[0].personId='different';
  const wrong=scoreTask(f.manifest.tasks[0],result,f.truth);assert.equal(wrong.eventPairs.falseMerge,1);assert.equal(wrong.personPairs.falseMerge,1);
  f.truth.photos[1].eventInstance='birthday2008';result.candidateTraces=[];result.snapshot.edges=[];result.snapshot.groups=[];
  const omitted=scoreTask(f.manifest.tasks[0],result,f.truth);assert.equal(omitted.historicalRetrieval.event.missed,1);assert.equal(omitted.eventPairs.missedSame,1);
});
test('frozen aliases do not erase extra labels and IoU is independently geometric',()=>{
  assert.deepEqual(scoreLabels([' birthday ','旅行'],[{value:'生日',aliases:['birthday']}]),{expected:1,correct:1,missed:0,extra:1});
  assert.equal(iou({x:0,y:0,width:0.2,height:0.2},{x:0.8,y:0.8,width:0.2,height:0.2}),0);
});
test('evaluation CLI runs offline preflight and blocks execute without a batch approval',async t=>{
  const f=await fixture(t);const cli=new URL('./stage-a-eval.mjs',import.meta.url);
  const offline=spawnSync(process.execPath,[cli.pathname,'--manifest',f.manifestPath,'--out',path.join(f.root,'offline')],{encoding:'utf8',env:process.env});
  assert.equal(offline.status,0,offline.stderr);const report=JSON.parse(await readFile(path.join(f.root,'offline','preflight.json'),'utf8'));assert.equal(report.externalCalls,0);assert.equal(report.credentialsRead,false);
  const blocked=spawnSync(process.execPath,[cli.pathname,'--manifest',f.manifestPath,'--out',path.join(f.root,'blocked'),'--execute'],{encoding:'utf8',env:process.env});
  assert.equal(blocked.status,2);assert.equal(JSON.parse(await readFile(path.join(f.root,'blocked','blocked.json'),'utf8')).code,'APPROVAL_REQUIRED');
});
test('incremental tasks score against the evidence available at that task, without future-label leakage',async t=>{
  const f=await fixture(t);const early=structuredClone(f.truth.photos);for(const p of early){p.facets.time=[];p.expectedUnknownFacets.push('time');}
  f.truth.taskOverrides=[{taskId:'early',photos:early}];const earlyScore=scoreTask({...f.manifest.tasks[0],taskId:'early'},undefined,f.truth);
  const lateScore=scoreTask({...f.manifest.tasks[0],taskId:'late'},undefined,f.truth);assert.equal(earlyScore.facets.time.expected,0);assert.equal(lateScore.facets.time.expected,2);
});
for(const [name,usage] of [['input',{inputTokens:50000,outputTokens:100}],['output',{inputTokens:100,outputTokens:2049}]]){
  test(`real-mode batch CLI stops remaining tasks on ${name} reservation overrun (local invoke stub only)`,async t=>{
    const f=await fixture(t);f.manifest.tasks.push({...structuredClone(f.manifest.tasks[0]),taskId:'later',request:{...structuredClone(f.s.req),runId:'run_later',trigger:'view'}});await f.save();
    const b=await preflight(f.manifestPath);const approval={version:'sgx-eval-approval.1',batchId:b.manifest.batchId,manifestHash:b.manifestHash,
      approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',expiresAt:new Date(Date.now()+60000).toISOString(),
      provider:b.manifest.provider,model:b.manifest.model,photoIds:b.usedPhotoIds,caps:b.manifest.caps,allowExternalImages:true,allowPersonMatching:true};
    const approvalPath=path.join(f.root,'test-approval.json');await writeFile(approvalPath,JSON.stringify(approval));
    const callsPath=path.join(f.root,'local-calls.jsonl'),loader=path.join(f.root,'stub.cjs');
    // Invoke is replaced before CLI imports it. Neither image resolution, credential access nor fetch is reachable.
    await writeFile(loader,`const {appendFileSync}=require('node:fs');
      global.fetch=()=>{throw new Error('NETWORK_FORBIDDEN_IN_TEST');};
      const {ApiVisionProvider}=require(process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification/stage-a-provider.js');
      ApiVisionProvider.prototype.invoke=async function(call){
        appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({stage:call.stage})+'\\n');
        const supports=call.photos.map(p=>({photoId:p.photoId,source:'visual',quote:'controlled local observation'}));
        const value=call.stage==='extract'?{observations:call.photos.map(p=>({photoId:p.photoId,people:[],mentions:[],times:[],places:[],events:[],scenes:[{label:'室内',supports:[supports[0]]}],unknownFacets:['person','time','place','event'],conflicts:[]}))}:
          {relations:[{kind:'event',left:{photoId:call.photos[0].photoId},right:{photoId:call.photos[1].photoId},decision:'unknown',supports,rationale:'controlled unknown'}]};
        return {value,usage:${JSON.stringify(usage)},responseId:'local_only',model:'qwen3.5-flash-2026-02-23'};
      };`);
    const out=path.join(f.root,'results');const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,
      '--manifest',f.manifestPath,'--out',out,'--execute','--approval',approvalPath],{encoding:'utf8',env:process.env});
    assert.equal(child.status,2,child.stderr);const ledger=JSON.parse(await readFile(path.join(out,'ledger.json'),'utf8'));
    assert.equal(ledger.stopped,'RESERVATION_OVERRUN');assert.equal(ledger.tasks.length,2);assert.equal(ledger.tasks[0].status,'failed');
    assert.equal(ledger.tasks[1].status,'not_run');assert.equal(ledger.tasks[1].reason,'RESERVATION_OVERRUN');
    assert.equal(ledger.totals.requests,1);assert.equal(ledger.totals.inputTokens,usage.inputTokens);assert.equal(ledger.totals.outputTokens,usage.outputTokens);
    assert.equal((await readFile(callsPath,'utf8')).trim().split('\n').length,1);
    const metrics=JSON.parse(await readFile(path.join(out,'metrics.json'),'utf8'));assert.equal(metrics.length,2);assert.equal(metrics[1].failedPhotos.length,2);
  });
}
