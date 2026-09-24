import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {z}=require('zod');
export const contract=require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/stage-a-contract.js`);
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const sha=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const bytesHash=b=>`sha256:${createHash('sha256').update(b).digest('hex')}`;
const caps=z.object({maxRequests:z.number().int().positive().max(1000),maxInputTokens:z.number().int().positive(),maxOutputTokens:z.number().int().positive(),
  maxCostCny:z.number().nonnegative(),maxDurationSeconds:z.number().int().positive().max(3600),maxRetries:z.literal(0)}).strict();
const evaluationPolicy=z.object({facets:z.array(contract.FacetSchema).min(1).refine(values=>new Set(values).size===values.length,'DUPLICATE_FACET'),
  personPairs:z.boolean(),eventPairs:z.boolean(),identityCandidates:z.boolean()}).strict();
export const ManifestSchema=z.object({version:z.literal('sgx-eval.1'),batchId:id,status:z.enum(['draft','ready']),partition:z.enum(['exploration','holdout']),
  provider:z.enum(['qwen','glm']),model:z.string().min(1),providerUseReviewRef:z.string().min(1),
  prices:z.object({inputCnyPerMillion:z.number().nonnegative(),outputCnyPerMillion:z.number().nonnegative(),source:z.string().url(),checkedAt:z.string().datetime()}).strict(),
  caps,truth:z.object({path:z.string().min(1),sha256:sha}).strict(),
  photos:z.array(z.object({photo:contract.PhotoSchema,path:z.string().min(1),split:z.enum(['reference','exploration','holdout']),leakageGroup:id,
    externalConsentRef:z.string().min(1),personConsentRef:z.string().optional()}).strict()).min(1),
  tasks:z.array(z.object({taskId:id,request:contract.RequestSchema,evaluatePhotoIds:z.array(id).min(1),expectedUnchangedPhotoIds:z.array(id).default([]),
    evaluation:evaluationPolicy.optional()}).strict()).min(1).max(100)
}).strict();
const region=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict()
  .refine(b=>b.x+b.width<=1&&b.y+b.height<=1);
const expected=z.array(z.object({value:z.string().min(1),aliases:z.array(z.string()).default([])}).strict());
const facetSet=z.array(contract.FacetSchema).refine(values=>new Set(values).size===values.length,'DUPLICATE_FACET');
const BaseTruthSchema=z.object({version:z.literal('sgx-truth.1'),reviewedBy:z.string().min(1),photos:z.array(z.object({photoId:id,sourceHash:sha,
  facets:z.object({time:expected,place:expected,event:expected,scene:expected}).strict(),
  faces:z.array(z.object({faceId:id,personId:id,box:region}).strict()),eventInstance:id.nullable(),
  expectedUnknownFacets:facetSet,expectedConflicts:facetSet
}).strict()).min(1)}).strict();
export const TruthSchema=BaseTruthSchema.extend({taskOverrides:z.array(z.object({taskId:id,photos:BaseTruthSchema.shape.photos}).strict()).default([])}).strict();
export const ApprovalSchema=z.object({version:z.literal('sgx-eval-approval.1'),batchId:id,manifestHash:sha,approvedBy:z.string().min(1),
  authorizationEvidenceRef:z.string().min(1),expiresAt:z.string().datetime(),provider:z.enum(['qwen','glm']),model:z.string().min(1),
  photoIds:z.array(id).min(1),caps,allowExternalImages:z.literal(true),allowPersonMatching:z.boolean()}).strict();
function ensure(ok,code){if(!ok)throw new Error(code);}
const unique=(values,code)=>ensure(new Set(values).size===values.length,code);

/** Offline only: no credential access, request, image editing or extraction. */
export async function preflight(manifestPath){
  const raw=await readFile(manifestPath);const manifest=ManifestSchema.parse(JSON.parse(raw));
  const root=path.dirname(path.resolve(manifestPath));const blockers=[];
  if(manifest.status!=='ready')blockers.push('MANIFEST_DRAFT');
  if(Date.now()-Date.parse(manifest.prices.checkedAt)>7*86400000||Date.parse(manifest.prices.checkedAt)>Date.now()+60000)blockers.push('PRICING_RECHECK_REQUIRED');
  unique(manifest.photos.map(p=>p.photo.photoId),'DUPLICATE_PHOTO');unique(manifest.tasks.map(t=>t.taskId),'DUPLICATE_TASK');unique(manifest.tasks.map(t=>t.request.runId),'DUPLICATE_RUN');
  const gallery=new Map(manifest.photos.map(p=>[p.photo.photoId,p]));
  const partitions=new Map();
  for(const item of manifest.photos){
    const previous=partitions.get(item.leakageGroup);ensure(!previous||previous===item.split,'SPLIT_LEAKAGE');partitions.set(item.leakageGroup,item.split);
    const duplicate=manifest.photos.find(p=>p.photo.sourceHash===item.photo.sourceHash&&p.split!==item.split);ensure(!duplicate,'DUPLICATE_IMAGE_SPLIT_LEAKAGE');
    const filename=path.resolve(root,item.path);const size=(await stat(filename)).size;ensure(size>0&&size<=1048576,'IMAGE_INPUT_LIMIT');
    ensure(bytesHash(await readFile(filename))===item.photo.sourceHash,'PHOTO_HASH_MISMATCH');
  }
  const truthBytes=await readFile(path.resolve(root,manifest.truth.path));ensure(bytesHash(truthBytes)===manifest.truth.sha256,'TRUTH_HASH_MISMATCH');
  const truth=TruthSchema.parse(JSON.parse(truthBytes));unique(truth.photos.map(p=>p.photoId),'DUPLICATE_TRUTH');
  unique(truth.taskOverrides.map(t=>t.taskId),'DUPLICATE_TASK_TRUTH');
  for(const override of truth.taskOverrides){ensure(manifest.tasks.some(t=>t.taskId===override.taskId),'FOREIGN_TASK_TRUTH');unique(override.photos.map(p=>p.photoId),'DUPLICATE_TRUTH');}
  const allTruth=[...truth.photos,...truth.taskOverrides.flatMap(t=>t.photos)];
  for(const p of allTruth){ensure(gallery.get(p.photoId)?.photo.sourceHash===p.sourceHash,'TRUTH_SOURCE_MISMATCH');unique(p.faces.map(f=>f.faceId),'DUPLICATE_TRUTH_FACE');}
  // Event instances are independent split units, even if someone assigned different leakageGroup names.
  const eventSplits=new Map();
  for(const p of allTruth.filter(p=>p.eventInstance)){const split=gallery.get(p.photoId).split;const old=eventSplits.get(p.eventInstance);ensure(!old||old===split,'EVENT_SPLIT_LEAKAGE');eventSplits.set(p.eventInstance,split);}
  let upperRequests=0,imageOccurrences=0,outputTokenReservation=0;const usedIds=new Set();
  for(const task of manifest.tasks){
    const r=task.request;const active=r.photos.filter(p=>p.active);const activeIds=new Set(active.map(p=>p.photoId));unique(r.photos.map(p=>p.photoId),'DUPLICATE_TASK_PHOTO');
    for(const p of r.photos){const item=gallery.get(p.photoId);ensure(item&&p.sourceHash===item.photo.sourceHash&&p.sourceRef===item.photo.sourceRef&&p.mimeType===item.photo.mimeType,'UNAPPROVED_PHOTO');
      ensure(contract.sameScope(p.scope,r.scope)&&contract.sameScope(item.photo.scope,r.scope),'CROSS_SCOPE');ensure(item.split==='reference'||item.split===manifest.partition,'WRONG_PARTITION');usedIds.add(p.photoId);}
    for(const p of active){ensure(truth.photos.some(t=>t.photoId===p.photoId),'MISSING_TRUTH');}
    for(const ref of r.references)ensure(gallery.get(ref.endpoint.photoId)?.split==='reference','NON_REFERENCE_IDENTITY_INPUT');
    for(const photoId of task.evaluatePhotoIds)ensure(activeIds.has(photoId)&&gallery.get(photoId).split===manifest.partition,'INVALID_EVALUATION_PHOTO');
    for(const photoId of task.expectedUnchangedPhotoIds)ensure(activeIds.has(photoId),'INVALID_UNCHANGED_PHOTO');
    const pairs=Math.min(active.length*(active.length-1)/2,active.length*r.budget.candidatesPerPhoto);
    const calls=r.trigger==='view'?0:active.length+pairs;upperRequests+=calls;imageOccurrences+=r.trigger==='view'?0:active.length+2*pairs;
    if(r.trigger!=='view')outputTokenReservation+=active.length*(r.budget.stageOutputTokens?.extract??r.budget.maxOutputPerRequest)+pairs*(r.budget.stageOutputTokens?.relate??r.budget.maxOutputPerRequest);
    // This is a cold-cache planning ceiling, not an assertion that a changed view can never trigger work.
  }
  return {ready:blockers.length===0,blockers,manifestHash:bytesHash(raw),manifest,truth,root,usedPhotoIds:[...usedIds].sort(),
    summary:{tasks:manifest.tasks.length,photos:usedIds.size,evaluationPhotoOccurrences:manifest.tasks.reduce((n,t)=>n+t.evaluatePhotoIds.length,0),
      coldCacheRequestEstimate:upperRequests,coldCacheImageOccurrences:imageOccurrences,coldCacheOutputTokenReservation:outputTokenReservation,
      capMayStopBeforeCompletion:upperRequests>manifest.caps.maxRequests||outputTokenReservation>manifest.caps.maxOutputTokens,
      status:'offline_preflight_only',credentialsRead:false,externalCalls:0}};
}
export function validateApproval(batch,input){
  const a=ApprovalSchema.parse(input);const m=batch.manifest;
  ensure(batch.ready,'PREFLIGHT_BLOCKED');ensure(a.batchId===m.batchId&&a.manifestHash===batch.manifestHash,'APPROVAL_MANIFEST_MISMATCH');
  ensure(Date.parse(a.expiresAt)>Date.now(),'APPROVAL_EXPIRED');ensure(a.provider===m.provider&&a.model===m.model,'APPROVAL_MODEL_MISMATCH');
  ensure(contract.stable([...a.photoIds].sort())===contract.stable(batch.usedPhotoIds),'APPROVAL_PHOTO_MISMATCH');
  ensure(contract.stable(a.caps)===contract.stable(m.caps),'APPROVAL_CAP_MISMATCH');
  if(a.allowPersonMatching)ensure(batch.usedPhotoIds.every(id=>m.photos.find(p=>p.photo.photoId===id)?.personConsentRef),'PERSON_CONSENT_MISSING');
  if(!a.allowPersonMatching)ensure(m.tasks.every(t=>!t.request.references.length&&!t.request.corrections.some(c=>c.kind==='person')),'PERSON_CONSENT_MISSING');
  return a;
}
const normalize=s=>s.normalize('NFKC').trim().toLocaleLowerCase();
export function scoreLabels(predicted,expectedValues){
  const remaining=expectedValues.map((v,i)=>({v,i}));let correct=0,extra=0;
  for(const label of [...new Set(predicted.map(normalize))]){const index=remaining.findIndex(({v})=>[v.value,...v.aliases].some(s=>normalize(s)===label));
    if(index<0)extra++;else{correct++;remaining.splice(index,1);}}
  return {expected:expectedValues.length,correct,missed:remaining.length,extra};
}
export function iou(a,b){const area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return area/(a.width*a.height+b.width*b.height-area);}
function detectedFaces(observation,truth){
  const pairs=[];for(const p of observation?.people??[])for(const g of truth.faces)pairs.push({p,g,iou:iou(p.box,g.box)});
  pairs.sort((a,b)=>b.iou-a.iou);const predictions=new Set(),actuals=new Set(),matches=new Map();
  for(const pair of pairs)if(pair.iou>=0.5&&!predictions.has(pair.p.faceId)&&!actuals.has(pair.g.faceId)){
    predictions.add(pair.p.faceId);actuals.add(pair.g.faceId);matches.set(pair.g.faceId,pair.p.faceId);}
  return {matches,expected:truth.faces.length,correct:matches.size,missed:truth.faces.length-matches.size,extra:(observation?.people.length??0)-matches.size};
}
const pairCounters=()=>({expectedSame:0,expectedDifferent:0,correctSame:0,falseMerge:0,falseSplit:0,unassignedSame:0,missedSame:0});
function countPair(c,same,a,b){if(same)c.expectedSame++;else c.expectedDifferent++;
  if(same){if(a&&b&&a===b)c.correctSame++;else{c.missedSame++;if(a&&b)c.falseSplit++;else c.unassignedSame++;}}
  else if(a&&b&&a===b)c.falseMerge++;
}
/** Truth is never fed to the provider. Missing/failed photos remain in all denominators. */
export function scoreTask(task,result,truth,previous){
  const evaluation=task.evaluation??{facets:[...contract.FacetSchema.options],personPairs:true,eventPairs:true,identityCandidates:true};
  const evaluatedFacets=new Set(evaluation.facets);
  const target=new Set(task.evaluatePhotoIds);const active=new Set(task.request.photos.filter(p=>p.active).map(p=>p.photoId));
  const truthById=new Map(truth.photos.map(p=>[p.photoId,p]));
  for(const p of truth.taskOverrides?.find(t=>t.taskId===task.taskId)?.photos??[])truthById.set(p.photoId,p);
  const actual=[...truthById.values()].filter(p=>active.has(p.photoId));const observations=result?.snapshot?.observations??{};const groups=result?.snapshot?.groups??[];
  const facets=Object.fromEntries(['person','time','place','event','scene'].map(f=>[f,{evaluated:evaluatedFacets.has(f),expected:0,correct:0,missed:0,extra:0}]));
  const failures=[];const faceMatches=new Map();const unknown={expected:0,correct:0,extra:0};const conflicts={expected:0,correct:0,extra:0};
  for(const t of actual){const o=observations[t.photoId]?.value;const faces=detectedFaces(o,t);faceMatches.set(t.photoId,faces.matches);
    if(!target.has(t.photoId))continue;if(!o)failures.push(t.photoId);
    if(evaluatedFacets.has('person'))for(const k of ['expected','correct','missed','extra'])facets.person[k]+=faces[k];
    for(const f of ['time','place','event','scene']){const values=f==='time'?(o?.times??[]).map(x=>`${x.role}:${x.precision}:${x.value}`):
      f==='place'?(o?.places??[]).map(x=>x.canonical||x.label):f==='event'?(o?.events??[]).map(x=>x.type):(o?.scenes??[]).map(x=>x.label);
      if(evaluatedFacets.has(f)){const score=scoreLabels(values,t.facets[f]);for(const k of ['expected','correct','missed','extra'])facets[f][k]+=score[k];}}
    for(const [counter,predicted,expected] of [[unknown,o?.unknownFacets??[],t.expectedUnknownFacets],[conflicts,o?.conflicts??[],t.expectedConflicts]]){
      const scopedExpected=expected.filter(f=>evaluatedFacets.has(f)),scopedPredicted=predicted.filter(f=>evaluatedFacets.has(f));
      counter.expected+=scopedExpected.length;counter.correct+=scopedPredicted.filter(p=>scopedExpected.includes(p)).length;counter.extra+=scopedPredicted.filter(p=>!scopedExpected.includes(p)).length;}
  }
  const groupId=(kind,pid,fid)=>groups.find(g=>g.kind===kind&&g.members.some(e=>e.photoId===pid&&(kind==='event'||e.faceId===fid)))?.groupId;
  const person={evaluated:evaluation.personPairs,...pairCounters()},event={evaluated:evaluation.eventPairs,...pairCounters()};
  const retrieval={person:{evaluated:evaluation.personPairs,samePairs:0,selected:0,missed:0},event:{evaluated:evaluation.eventPairs,samePairs:0,selected:0,missed:0}};
  const selected=(a,b)=>(result?.candidateTraces??[]).some(t=>(t.photoId===a&&t.selected.includes(b))||(t.photoId===b&&t.selected.includes(a)))||
    (result?.snapshot?.edges??[]).some(e=>[e.left.photoId,e.right.photoId].includes(a)&&[e.left.photoId,e.right.photoId].includes(b));
  for(let i=0;i<actual.length;i++)for(let j=i+1;j<actual.length;j++){
    const a=actual[i],b=actual[j];if(!target.has(a.photoId)&&!target.has(b.photoId))continue;
    if(evaluation.eventPairs){const same=Boolean(a.eventInstance&&a.eventInstance===b.eventInstance);countPair(event,same,groupId('event',a.photoId),groupId('event',b.photoId));
      if(same){retrieval.event.samePairs++;retrieval.event[selected(a.photoId,b.photoId)?'selected':'missed']++;}}
    if(evaluation.personPairs)for(const af of a.faces)for(const bf of b.faces){const same=af.personId===bf.personId;const ap=faceMatches.get(a.photoId)?.get(af.faceId),bp=faceMatches.get(b.photoId)?.get(bf.faceId);
      countPair(person,same,ap?groupId('person',a.photoId,ap):undefined,bp?groupId('person',b.photoId,bp):undefined);
      if(same){retrieval.person.samePairs++;retrieval.person[selected(a.photoId,b.photoId)?'selected':'missed']++;}}
  }
  const unchanged=task.expectedUnchangedPhotoIds.map(id=>({photoId:id,pass:Boolean(previous?.snapshot?.observations[id]&&observations[id]&&
    contract.digest(previous.snapshot.observations[id])===contract.digest(observations[id]))}));
  const identities={evaluated:evaluation.identityCandidates,expectedFaces:0,correctCandidate:0,wrongCandidate:0,unnamedOrMissed:0};
  if(evaluation.identityCandidates)for(const t of actual.filter(t=>target.has(t.photoId)))for(const f of t.faces){identities.expectedFaces++;const faceId=faceMatches.get(t.photoId)?.get(f.faceId);
    const personId=faceId?groups.find(g=>g.kind==='person'&&g.members.some(e=>e.photoId===t.photoId&&e.faceId===faceId))?.identity?.personId:undefined;
    if(!personId)identities.unnamedOrMissed++;else if(personId===f.personId)identities.correctCandidate++;else identities.wrongCandidate++;}
  return {taskId:task.taskId,plannedPhotos:target.size,failedPhotos:failures,evaluation,facets,unknown,conflicts,personPairs:person,eventPairs:event,
    historicalRetrieval:retrieval,identities,unchangedObservationChecks:unchanged,workflowStatus:result?.workflowStatus??'not_run',
    labelMetric:`enabled facets only: ${evaluation.facets.join(',')}; ${evaluation.facets.includes('person')?'person detection via greedy IoU>=0.5':'person facet not evaluated'}; no model-written ground truth`,
    groupingMetric:'all cross-photo truth pairs involving evaluation photos, including candidate misses and failures'};
}
