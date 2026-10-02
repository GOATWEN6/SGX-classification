import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
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
  assert.equal(b.summary.coldCacheOutputTokenReservation,6144);assert.equal(b.summary.capMayStopBeforeCompletion,false);
  f.manifest.status='draft';await f.save();assert.deepEqual((await preflight(f.manifestPath)).blockers,['MANIFEST_DRAFT']);
});
test('preflight accounts for stage-specific output reservations against the batch cap',async t=>{
  const f=await fixture(t);f.manifest.tasks[0].request.budget.stageOutputTokens={extract:4096,relate:1024};
  f.manifest.caps.maxOutputTokens=9000;f.manifest.tasks[0].request.budget.maxOutputTokens=9000;await f.save();
  const b=await preflight(f.manifestPath);assert.equal(b.summary.coldCacheOutputTokenReservation,9216);assert.equal(b.summary.capMayStopBeforeCompletion,true);
});
test('preflight and scoring honor an exact relation pair allowlist',async t=>{
  const f=await fixture(t);f.manifest.tasks[0].relationPairs=[];await f.save();
  let b=await preflight(f.manifestPath);assert.equal(b.summary.coldCacheRequestEstimate,2);assert.equal(b.summary.coldCacheImageOccurrences,2);
  let score=scoreTask(b.manifest.tasks[0],undefined,f.truth);assert.equal(score.eventPairs.expectedSame,0);assert.equal(score.personPairs.expectedSame,0);
  f.manifest.tasks[0].relationPairs=[['a','b']];await f.save();b=await preflight(f.manifestPath);
  assert.equal(b.summary.coldCacheRequestEstimate,3);score=scoreTask(b.manifest.tasks[0],undefined,f.truth);assert.equal(score.eventPairs.expectedSame,1);
  f.manifest.tasks[0].relationPairs=[['a','b'],['b','a']];await f.save();await assert.rejects(preflight(f.manifestPath),/DUPLICATE_RELATION_PAIR/);
  f.manifest.tasks[0].relationPairs=[['a','foreign']];await f.save();await assert.rejects(preflight(f.manifestPath),/INVALID_RELATION_PAIR/);
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
test('evaluation policy excludes ungrounded person metrics without hiding event and facet denominators',async t=>{
  const f=await fixture(t);f.manifest.tasks[0].evaluation={facets:['time','event','scene'],personPairs:false,eventPairs:true,identityCandidates:false};await f.save();
  const task=(await preflight(f.manifestPath)).manifest.tasks[0];
  const result=await f.s.engine.process(f.s.req,f.s.getAuth);const score=scoreTask(task,result,{...f.truth,photos:f.truth.photos.map(p=>({...p,faces:[]}))});
  assert.equal(score.facets.person.evaluated,false);assert.deepEqual({...score.facets.person},{evaluated:false,expected:0,correct:0,missed:0,extra:0});
  assert.equal(score.personPairs.evaluated,false);assert.equal(score.personPairs.falseMerge,0);assert.equal(score.identities.evaluated,false);
  assert.equal(score.eventPairs.evaluated,true);assert.equal(score.eventPairs.correctSame,1);assert.equal(score.facets.time.correct,2);assert.equal(score.unknown.extra,0);
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
test('evaluation CLI rejects an existing evidence directory with a stable code and no stack',async t=>{
  const f=await fixture(t);const cli=new URL('./stage-a-eval.mjs',import.meta.url);const out=path.join(f.root,'existing');await mkdir(out);
  const child=spawnSync(process.execPath,[cli.pathname,'--manifest',f.manifestPath,'--out',out],{encoding:'utf8',env:process.env});
  assert.equal(child.status,2);assert.equal(child.stderr.trim(),'OUTPUT_DIRECTORY_EXISTS');assert.ok(!child.stderr.includes('EEXIST'));
});
test('evaluation report renders safe provider schema diagnostics',async t=>{
  const f=await fixture(t);const b=await preflight(f.manifestPath);const approval={version:'sgx-eval-approval.1',batchId:b.manifest.batchId,manifestHash:b.manifestHash,
    approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',expiresAt:new Date(Date.now()+60000).toISOString(),
    provider:b.manifest.provider,model:b.manifest.model,photoIds:b.usedPhotoIds,caps:b.manifest.caps,allowExternalImages:true,allowPersonMatching:true};
  const approvalPath=path.join(f.root,'approval.json');await writeFile(approvalPath,JSON.stringify(approval));const loader=path.join(f.root,'diagnostic-stub.cjs');
  await writeFile(loader,`const base=process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification';
    const {ApiVisionProvider}=require(base+'/stage-a-provider.js');const {StageError}=require(base+'/stage-a-contract.js');
    ApiVisionProvider.prototype.invoke=async()=>{throw new StageError('INVALID_OUTPUT',{phase:'schema',issues:[{path:'observations.0.places.0',code:'unrecognized_keys',keys:['canonical?']}]});};`);
  const out=path.join(f.root,'diagnostic-result');const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,
    '--manifest',f.manifestPath,'--out',out,'--execute','--approval',approvalPath],{encoding:'utf8',env:process.env});
  assert.equal(child.status,2,child.stderr);const report=await readFile(path.join(out,'REPORT.md'),'utf8');assert.match(report,/## 工程诊断/);
  assert.match(report,/observations\.0\.places\.0/);assert.match(report,/canonical\?/);assert.ok(!report.includes('test_only_not_external_permission'));
});
test('case-local invalid output preserves the denominator and continues the next independent task without retry',async t=>{
  const f=await fixture(t);const [a,b]=f.manifest.tasks[0].request.photos;
  f.manifest.tasks=[
    {...structuredClone(f.manifest.tasks[0]),taskId:'invalid_a',stateSequenceId:'sequence_a',request:{...structuredClone(f.s.req),runId:'run_invalid_a',photos:[a]},evaluatePhotoIds:['a']},
    {...structuredClone(f.manifest.tasks[0]),taskId:'dependent_a',stateSequenceId:'sequence_a',request:{...structuredClone(f.s.req),runId:'run_dependent_a',authorizationRevision:'auth2',photos:[a]},evaluatePhotoIds:['a']},
    {...structuredClone(f.manifest.tasks[0]),taskId:'valid_b',request:{...structuredClone(f.s.req),runId:'run_valid_b',authorizationRevision:'auth2',photos:[b]},evaluatePhotoIds:['b']}
  ];
  await f.save();const prepared=await preflight(f.manifestPath);const approval={version:'sgx-eval-approval.1',batchId:prepared.manifest.batchId,manifestHash:prepared.manifestHash,
    approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',expiresAt:new Date(Date.now()+60000).toISOString(),provider:prepared.manifest.provider,model:prepared.manifest.model,
    photoIds:prepared.usedPhotoIds,caps:prepared.manifest.caps,allowExternalImages:true,allowPersonMatching:false};
  const approvalPath=path.join(f.root,'case-approval.json');await writeFile(approvalPath,JSON.stringify(approval));const callsPath=path.join(f.root,'case-calls.jsonl'),loader=path.join(f.root,'case-stub.cjs');
  await writeFile(loader,`const {appendFileSync}=require('node:fs');
    const base=process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification';
    const {ApiVisionProvider}=require(base+'/stage-a-provider.js');const {StageError}=require(base+'/stage-a-contract.js');
    ApiVisionProvider.prototype.invoke=async function(call){const p=call.photos[0];appendFileSync(${JSON.stringify(callsPath)},p.photoId+'\\n');
      if(p.photoId==='a')throw new StageError('INVALID_OUTPUT');
      return {value:{observations:[{photoId:p.photoId,people:[],mentions:[],times:[],places:[],events:[],scenes:[{label:'室内',supports:[{photoId:p.photoId,source:'visual',quote:'controlled local observation'}]}],unknownFacets:['person','time','place','event'],conflicts:[]}]},usage:{inputTokens:100,outputTokens:50},responseId:'local_'+p.photoId,model:'qwen3.5-flash-2026-02-23'};};`);
  const out=path.join(f.root,'case-results');const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,
    '--manifest',f.manifestPath,'--out',out,'--execute','--approval',approvalPath],{encoding:'utf8',env:process.env});
  assert.equal(child.status,2,child.stderr);const ledger=JSON.parse(await readFile(path.join(out,'ledger.json'),'utf8'));
  assert.equal(ledger.globalStop,undefined);assert.deepEqual(ledger.caseFailures,[{taskId:'invalid_a',codes:['INVALID_OUTPUT']}]);
  assert.equal(ledger.tasks[0].reason,'INVALID_OUTPUT');assert.equal(ledger.tasks[1].status,'not_run');assert.equal(ledger.tasks[1].reason,'DEPENDENCY_FAILED');
  assert.equal(ledger.tasks[2].status,'succeeded');
  assert.deepEqual((await readFile(callsPath,'utf8')).trim().split('\n'),['a','b']);
});
test('case-local semantic time failure does not stop later independent real-model tasks',async t=>{
  const f=await fixture(t);const [a,b]=f.manifest.tasks[0].request.photos;
  f.manifest.tasks=[
    {...structuredClone(f.manifest.tasks[0]),taskId:'invalid_time_a',request:{...structuredClone(f.s.req),runId:'run_invalid_time_a',photos:[a]},evaluatePhotoIds:['a']},
    {...structuredClone(f.manifest.tasks[0]),taskId:'valid_after_time',request:{...structuredClone(f.s.req),runId:'run_valid_after_time',authorizationRevision:'auth2',photos:[b]},evaluatePhotoIds:['b']}
  ];
  await f.save();const prepared=await preflight(f.manifestPath);const approval={version:'sgx-eval-approval.1',batchId:prepared.manifest.batchId,manifestHash:prepared.manifestHash,
    approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',expiresAt:new Date(Date.now()+60000).toISOString(),provider:prepared.manifest.provider,model:prepared.manifest.model,
    photoIds:prepared.usedPhotoIds,caps:prepared.manifest.caps,allowExternalImages:true,allowPersonMatching:false};
  const approvalPath=path.join(f.root,'time-approval.json');await writeFile(approvalPath,JSON.stringify(approval));const callsPath=path.join(f.root,'time-calls.jsonl'),loader=path.join(f.root,'time-stub.cjs');
  await writeFile(loader,`const {appendFileSync}=require('node:fs');const base=process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification';
    const {ApiVisionProvider}=require(base+'/stage-a-provider.js');const {StageError}=require(base+'/stage-a-contract.js');
    ApiVisionProvider.prototype.invoke=async function(call){const p=call.photos[0];appendFileSync(${JSON.stringify(callsPath)},p.photoId+'\\n');if(p.photoId==='a')throw new StageError('INVALID_TIME');
      return {value:{observations:[{photoId:p.photoId,people:[],mentions:[],times:[],places:[],events:[],scenes:[{label:'室内',supports:[{photoId:p.photoId,source:'visual',quote:'controlled local observation'}]}],unknownFacets:['person','time','place','event'],conflicts:[]}]},usage:{inputTokens:100,outputTokens:50},responseId:'local_'+p.photoId,model:'qwen3.5-flash-2026-02-23'};};`);
  const out=path.join(f.root,'time-results');const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,
    '--manifest',f.manifestPath,'--out',out,'--execute','--approval',approvalPath],{encoding:'utf8',env:process.env});
  assert.equal(child.status,2,child.stderr);const ledger=JSON.parse(await readFile(path.join(out,'ledger.json'),'utf8'));
  assert.equal(ledger.globalStop,undefined);assert.deepEqual(ledger.caseFailures,[{taskId:'invalid_time_a',codes:['INVALID_TIME']}]);
  assert.equal(ledger.tasks[1].status,'succeeded');assert.deepEqual((await readFile(callsPath,'utf8')).trim().split('\n'),['a','b']);
});
test('global authorization error stops later tasks after one provider attempt',async t=>{
  const f=await fixture(t);const [a,b]=f.manifest.tasks[0].request.photos;
  f.manifest.tasks=[
    {...structuredClone(f.manifest.tasks[0]),taskId:'unauthorized_a',request:{...structuredClone(f.s.req),runId:'run_unauthorized_a',photos:[a]},evaluatePhotoIds:['a']},
    {...structuredClone(f.manifest.tasks[0]),taskId:'never_b',request:{...structuredClone(f.s.req),runId:'run_never_b',authorizationRevision:'auth2',photos:[b]},evaluatePhotoIds:['b']}
  ];
  await f.save();const prepared=await preflight(f.manifestPath);const approval={version:'sgx-eval-approval.1',batchId:prepared.manifest.batchId,manifestHash:prepared.manifestHash,
    approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',expiresAt:new Date(Date.now()+60000).toISOString(),provider:prepared.manifest.provider,model:prepared.manifest.model,
    photoIds:prepared.usedPhotoIds,caps:prepared.manifest.caps,allowExternalImages:true,allowPersonMatching:false};
  const approvalPath=path.join(f.root,'global-approval.json');await writeFile(approvalPath,JSON.stringify(approval));const callsPath=path.join(f.root,'global-calls.jsonl'),loader=path.join(f.root,'global-stub.cjs');
  await writeFile(loader,`const {appendFileSync}=require('node:fs');const base=process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification';
    const {ApiVisionProvider}=require(base+'/stage-a-provider.js');const {StageError}=require(base+'/stage-a-contract.js');
    ApiVisionProvider.prototype.invoke=async function(call){appendFileSync(${JSON.stringify(callsPath)},call.photos[0].photoId+'\\n');throw new StageError('CALL_NOT_AUTHORIZED');};`);
  const out=path.join(f.root,'global-results');const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,
    '--manifest',f.manifestPath,'--out',out,'--execute','--approval',approvalPath],{encoding:'utf8',env:process.env});
  assert.equal(child.status,2,child.stderr);const ledger=JSON.parse(await readFile(path.join(out,'ledger.json'),'utf8'));
  assert.equal(ledger.globalStop,'CALL_NOT_AUTHORIZED');assert.equal(ledger.tasks[0].reason,undefined);assert.equal(ledger.tasks[0].status,'failed');
  assert.equal(ledger.tasks[1].status,'not_run');assert.equal(ledger.tasks[1].reason,'CALL_NOT_AUTHORIZED');assert.equal((await readFile(callsPath,'utf8')).trim(),'a');
});
test('formal pointer execution reserves and finalizes the cumulative campaign ledger',async t=>{
  const f=await fixture(t);const datasetRootDigest=`sha256:${'d'.repeat(64)}`;f.manifest.datasetRootDigest=datasetRootDigest;await f.save();
  const prepared=await preflight(f.manifestPath);const expiresAt=new Date(Date.now()+60000).toISOString();
  const approval={version:'sgx-eval-approval.2',campaignId:'formal_campaign',phase:'exploration',batchId:prepared.manifest.batchId,
    manifestHash:prepared.manifestHash,datasetRootDigest,approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',
    expiresAt,provider:prepared.manifest.provider,model:prepared.manifest.model,photoIds:prepared.usedPhotoIds,caps:prepared.manifest.caps,
    campaignCaps:{maxRequests:150,maxCostCny:25,maxRetries:0},allowExternalImages:true,allowPersonMatching:true};
  const approvalBytes=Buffer.from(`${JSON.stringify(approval)}\n`),approvalPath=path.join(f.root,'formal-approval.json');await writeFile(approvalPath,approvalBytes);
  const out=path.join(f.root,'formal-results'),pointer={version:'classification-real-batch-pointer.2',campaignId:approval.campaignId,phase:'exploration',
    batchId:approval.batchId,manifestPath:f.manifestPath,approvalPath,outputPath:out,manifestHash:prepared.manifestHash,approvalHash:bytesHash(approvalBytes),
    datasetRootDigest,provider:approval.provider,model:approval.model,batchCaps:{maxRequests:approval.caps.maxRequests,maxCostCny:approval.caps.maxCostCny,maxRetries:0},
    campaignCaps:approval.campaignCaps,allowPersonMatching:true,expiresAt,authorizationEvidenceRef:approval.authorizationEvidenceRef};
  const pointerPath=path.join(f.root,'formal-pointer.json');await writeFile(pointerPath,`${JSON.stringify(pointer)}\n`);
  const loader=path.join(f.root,'formal-stub.cjs');await writeFile(loader,`global.fetch=()=>{throw new Error('NETWORK_FORBIDDEN_IN_TEST');};
    const {ApiVisionProvider}=require(process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification/stage-a-provider.js');
    ApiVisionProvider.prototype.invoke=async function(call){const supports=call.photos.map(p=>({photoId:p.photoId,source:'visual',quote:'controlled local observation'}));
      const value=call.stage==='extract'?{observations:call.photos.map(p=>({photoId:p.photoId,people:[],mentions:[],times:[],places:[],events:[],scenes:[{label:'室内',supports:[supports[0]]}],unknownFacets:['person','time','place','event'],conflicts:[]}))}:
        {relations:[{kind:'event',left:{photoId:call.photos[0].photoId},right:{photoId:call.photos[1].photoId},decision:'unknown',supports,rationale:'controlled unknown'}]};
      return {value,usage:{inputTokens:100,outputTokens:50},responseId:'formal_local',model:'qwen3.5-flash-2026-02-23'};};`);
  const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,'--manifest',f.manifestPath,
    '--out',out,'--execute','--approval',approvalPath,'--pointer',pointerPath],{encoding:'utf8',env:{...process.env,SGX_D4_API_KEY:'test_only_dummy',
      CLASSIFICATION_LAB_DATA_DIR:f.root,CLASSIFICATION_EVAL_ALLOW_EPHEMERAL_TEST_ROOT:'1'}});
  assert.equal(child.status,0,child.stderr);const campaignLedger=JSON.parse(await readFile(path.join(f.root,'real-batch','campaigns','formal_campaign','campaign-ledger.json'),'utf8'));
  assert.equal(campaignLedger.state,'active');assert.equal(campaignLedger.batches[0].status,'completed');assert.equal(campaignLedger.batches[0].actual.requests,3);
  await assert.rejects(readFile(path.join(f.root,'real-batch','campaigns','formal_campaign','campaign.lock')),error=>error.code==='ENOENT');
});
test('incremental tasks score against the evidence available at that task, without future-label leakage',async t=>{
  const f=await fixture(t);const early=structuredClone(f.truth.photos);for(const p of early){p.facets.time=[];p.expectedUnknownFacets.push('time');}
  f.truth.taskOverrides=[{taskId:'early',photos:early}];const earlyScore=scoreTask({...f.manifest.tasks[0],taskId:'early'},undefined,f.truth);
  const lateScore=scoreTask({...f.manifest.tasks[0],taskId:'late'},undefined,f.truth);assert.equal(earlyScore.facets.time.expected,0);assert.equal(lateScore.facets.time.expected,2);
});
test('incremental unchanged checks require an explicit state sequence and complete photo catalog',async t=>{
  const f=await fixture(t);f.manifest.tasks[0].expectedUnchangedPhotoIds=['a'];await f.save();
  await assert.rejects(preflight(f.manifestPath),/STATE_SEQUENCE_REQUIRED/);
  f.manifest.tasks[0].stateSequenceId='sequence_a';await f.save();await assert.rejects(preflight(f.manifestPath),/STATE_SEQUENCE_PREVIOUS_REQUIRED/);
  f.manifest.tasks[0].expectedUnchangedPhotoIds=[];
  f.manifest.tasks.push({...structuredClone(f.manifest.tasks[0]),taskId:'later',request:{...structuredClone(f.s.req),runId:'run_later',photos:[f.s.req.photos[1]]},evaluatePhotoIds:['b'],expectedUnchangedPhotoIds:['b']});
  await f.save();await assert.rejects(preflight(f.manifestPath),/STATE_SEQUENCE_REQUIRES_COMPLETE_CATALOG/);
});
test('independent tasks with the same product scope use isolated evaluation state',async t=>{
  const f=await fixture(t);const [a,b]=f.manifest.tasks[0].request.photos;
  f.manifest.tasks=[
    {...structuredClone(f.manifest.tasks[0]),taskId:'only_a',request:{...structuredClone(f.s.req),runId:'run_only_a',photos:[a]},evaluatePhotoIds:['a']},
    {...structuredClone(f.manifest.tasks[0]),taskId:'only_b',request:{...structuredClone(f.s.req),runId:'run_only_b',authorizationRevision:'auth2',photos:[b]},evaluatePhotoIds:['b']}
  ];
  await f.save();const prepared=await preflight(f.manifestPath);const approval={version:'sgx-eval-approval.1',batchId:prepared.manifest.batchId,manifestHash:prepared.manifestHash,
    approvedBy:'local_test_fixture',authorizationEvidenceRef:'test_only_not_external_permission',expiresAt:new Date(Date.now()+60000).toISOString(),provider:prepared.manifest.provider,model:prepared.manifest.model,
    photoIds:prepared.usedPhotoIds,caps:prepared.manifest.caps,allowExternalImages:true,allowPersonMatching:false};
  const approvalPath=path.join(f.root,'isolated-approval.json');await writeFile(approvalPath,JSON.stringify(approval));const loader=path.join(f.root,'isolated-stub.cjs');
  await writeFile(loader,`global.fetch=()=>{throw new Error('NETWORK_FORBIDDEN_IN_TEST');};
    const {ApiVisionProvider}=require(process.env.CLASSIFICATION_BUILD_DIR+'/src/lib/algorithms/classification/stage-a-provider.js');
    ApiVisionProvider.prototype.invoke=async function(call){const p=call.photos[0];return {value:{observations:[{photoId:p.photoId,people:[],mentions:[],times:[],places:[],events:[],scenes:[{label:'室内',supports:[{photoId:p.photoId,source:'visual',quote:'controlled local observation'}]}],unknownFacets:['person','time','place','event'],conflicts:[]}]},usage:{inputTokens:100,outputTokens:50},responseId:'local_'+p.photoId,model:'qwen3.5-flash-2026-02-23'};};`);
  const out=path.join(f.root,'isolated-results');const child=spawnSync(process.execPath,['--require',loader,new URL('./stage-a-eval.mjs',import.meta.url).pathname,
    '--manifest',f.manifestPath,'--out',out,'--execute','--approval',approvalPath],{encoding:'utf8',env:process.env});
  assert.equal(child.status,0,child.stderr);const second=JSON.parse(await readFile(path.join(out,'result-only_b.json'),'utf8'));
  assert.deepEqual(second.invalidatedPhotoIds,[]);assert.deepEqual(Object.keys(second.snapshot.observations),['b']);
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
    assert.equal(ledger.globalStop,'RESERVATION_OVERRUN');assert.deepEqual(ledger.caseFailures,[]);assert.equal(ledger.tasks.length,2);assert.equal(ledger.tasks[0].status,'failed');
    assert.equal(ledger.tasks[1].status,'not_run');assert.equal(ledger.tasks[1].reason,'RESERVATION_OVERRUN');
    assert.equal(ledger.totals.requests,1);assert.equal(ledger.totals.inputTokens,usage.inputTokens);assert.equal(ledger.totals.outputTokens,usage.outputTokens);
    assert.equal((await readFile(callsPath,'utf8')).trim().split('\n').length,1);
    const metrics=JSON.parse(await readFile(path.join(out,'metrics.json'),'utf8'));assert.equal(metrics.length,2);assert.equal(metrics[1].failedPhotos.length,2);
  });
}
