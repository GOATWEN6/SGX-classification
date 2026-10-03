import { CachedObservation, Edge, Group, candidates, reconcile, validateRelation,resolveReferences } from './stage-a-association';
import { Budget, ExtractSchema, Photo, RelateSchema, RequestSchema, Scope, STAGE_A_VERSION, StageDiagnostic, StageError, digest, pairKey, photoHash, sameScope, sanitizeObservationCandidate, validateObservation } from './stage-a-contract';
import { CallRecord, TaskBudget, VisionProvider } from './stage-a-provider';
export interface AuthorizationSnapshot {scope:Scope;authorizationRevision:string;allowedPhotoIds:string[];allowPersonMatching:boolean;
  photoVersions:Record<string,string>;contextRevision:string;reviewContextHash:string;active:boolean;}
export interface StageExecutionPolicy {relationPairAllowlist?:[string,string][];}
export interface AlgorithmSnapshot {scope:Scope;revision:number;version:string;authorizationRevision:string;contextHash:string;
  observations:Record<string,CachedObservation>;edges:Edge[];groups:Group[];referencesHash:string;correctionsHash:string;reviewItems:string[];candidateTraces:ReturnType<typeof candidates>['traces'];pendingPhotoIds:string[];workflowStatus:StageResult['workflowStatus'];}
export interface SnapshotStore {get(key:string):AlgorithmSnapshot|undefined;compareAndSet(key:string,expected:number,value:AlgorithmSnapshot):boolean;}
export class MemorySnapshotStore implements SnapshotStore {
  private data=new Map<string,AlgorithmSnapshot>();
  get(key:string){const v=this.data.get(key);return v?structuredClone(v):undefined;}
  compareAndSet(key:string,expected:number,value:AlgorithmSnapshot){if((this.data.get(key)?.revision??0)!==expected)return false;this.data.set(key,structuredClone(value));return true;}
}
export interface StageResult {contractVersion:string;providerVersion:string;runId:string;scope:Scope;workflowStatus:'succeeded'|'needs_review'|'failed'|'cancelled';
  evidenceStatus:'mock_transport'|'real_api'|'not_run';semanticValidation:'not_evaluated';snapshot?:AlgorithmSnapshot;organizationPolicy?:{facts:'supported_nonconflicted_candidates';groups:'exploratory_ai_candidates';calibrated:false};
  changedPhotoIds:string[];invalidatedPhotoIds:string[];retiredGroupIds:string[];candidateTraces:ReturnType<typeof candidates>['traces'];
  reviewItems:string[];errors:{stage:string;photoIds:string[];code:string;diagnostic?:StageDiagnostic}[];usage:{requests:number;images:number;inputTokens:number;outputTokens:number;costCny:number;latencyMs:number;records:CallRecord[]};}

export class ClassificationEngine {
  private generations=new Map<string,symbol>();
  constructor(private readonly provider:VisionProvider|undefined,private readonly store:SnapshotStore=new MemorySnapshotStore()){}
  async process(input:unknown,getAuthorization:()=>AuthorizationSnapshot,signal?:AbortSignal,executionPolicy?:StageExecutionPolicy):Promise<StageResult>{
    const r=RequestSchema.parse(input);const started=Date.now();const key=digest(r.scope);const budget=new TaskBudget(r.budget);
    const version=this.provider?.version??'unconfigured';
    const result:StageResult={contractVersion:STAGE_A_VERSION,providerVersion:version,runId:r.runId,scope:r.scope,workflowStatus:'failed',evidenceStatus:'not_run',semanticValidation:'not_evaluated',
      organizationPolicy:{facts:'supported_nonconflicted_candidates',groups:'exploratory_ai_candidates',calibrated:false},changedPhotoIds:[],invalidatedPhotoIds:[],retiredGroupIds:[],candidateTraces:[],reviewItems:[],errors:[],usage:{requests:0,images:0,inputTokens:0,outputTokens:0,costCny:0,latencyMs:0,records:budget.records}};
    const initialAuthorization=getAuthorization();const authFingerprint=digest(initialAuthorization);
    const token=Symbol(r.runId);
    let generationStarted=false;
    const fresh=()=>{
      if(signal?.aborted)throw new StageError('CANCELLED');
      if(Date.now()>=Date.parse(r.budget.deadlineAt))throw new StageError('TIMEOUT');
      const a=getAuthorization();
      if(!a.active||!sameScope(a.scope,r.scope)||a.authorizationRevision!==r.authorizationRevision||digest(a)!==authFingerprint)throw new StageError('AUTHORIZATION_CHANGED');
      for(const p of r.photos){
        if(!sameScope(p.scope,r.scope))throw new StageError('CROSS_SCOPE');
        if(p.active&&(!a.allowedPhotoIds.includes(p.photoId)||a.photoVersions[p.photoId]!==photoHash(p)))throw new StageError('SOURCE_OR_AUTHORIZATION_CHANGED');
      }
      if(generationStarted&&this.generations.get(key)!==token)throw new StageError('STALE_RUN');
    };
    try{
      fresh();
      if(initialAuthorization.reviewContextHash!==digest([r.references,r.corrections]))throw new StageError('UNTRUSTED_REVIEW_CONTEXT');
      if(digest(r.photos.filter(p=>p.active).map(p=>p.photoId).sort())!==digest([...initialAuthorization.allowedPhotoIds].sort()))throw new StageError('INCOMPLETE_AUTHORIZED_CATALOG');
      if(new Set(r.photos.map(p=>p.photoId)).size!==r.photos.length)throw new StageError('DUPLICATE_PHOTO');
      if(new Set(r.corrections.map(c=>c.correctionId)).size!==r.corrections.length)throw new StageError('DUPLICATE_CORRECTION');
      if((r.references.length||r.corrections.some(c=>c.kind==='person'))&&!initialAuthorization.allowPersonMatching)throw new StageError('PERSON_MATCHING_NOT_AUTHORIZED');
      const active=r.photos.filter(p=>p.active);const current=new Map(active.map(p=>[p.photoId,p]));
      for(const ref of r.references)if(!r.photos.some(p=>p.photoId===ref.endpoint.photoId))throw new StageError('FOREIGN_REFERENCE');
      for(const c of r.corrections)if(c.active&&(!r.photos.some(p=>p.photoId===c.left.photoId)||!r.photos.some(p=>p.photoId===c.right.photoId)))throw new StageError('FOREIGN_CORRECTION');
      const previous=this.store.get(key);
      if(previous&&!sameScope(previous.scope,r.scope))throw new StageError('CROSS_SCOPE');
      const contextHash=digest([r.photos,r.references,r.corrections,authFingerprint,version]);
      if(previous?.contextHash===contextHash||(r.trigger==='view'&&previous?.contextHash===`incomplete:${contextHash}`)){result.snapshot=previous;result.workflowStatus=previous.workflowStatus;result.reviewItems=previous.reviewItems;result.candidateTraces=previous.candidateTraces;return result;}
      this.generations.set(key,token);generationStarted=true;
      const observations:Record<string,CachedObservation>={};
      const changed:string[]=[];
      for(const p of active){const old=previous?.observations[p.photoId];
        if(old&&old.inputHash===photoHash(p)&&old.version===version&&previous?.authorizationRevision===r.authorizationRevision)observations[p.photoId]=old;
        else changed.push(p.photoId);
      }
      result.changedPhotoIds=changed;
      result.invalidatedPhotoIds=Object.keys(previous?.observations??{}).filter(id=>!observations[id]);
      let edges=(previous?.edges??[]).filter(e=>Object.entries(e.deps).every(([id,h])=>current.has(id)&&photoHash(current.get(id)!)===h)&&previous?.version===version&&previous?.authorizationRevision===r.authorizationRevision);
      const refChanged=previous?.referencesHash!==digest(r.references),correctionChanged=previous?.correctionsHash!==digest(r.corrections);
      // Reference/correction changes may affect historical faces, without rerunning visual extraction.
      const impacted=new Set([...changed,...(previous?.pendingPhotoIds??[])]);
      if(refChanged||correctionChanged){
        for(const ref of r.references)impacted.add(ref.endpoint.photoId);
        for(const c of r.corrections){impacted.add(c.left.photoId);impacted.add(c.right.photoId);}
        for(const edge of edges.filter(e=>e.kind==='person')){impacted.add(edge.left.photoId);impacted.add(edge.right.photoId);}
      }
      const call=async(stage:'extract'|'relate',photos:Photo[],context:unknown)=>{
        fresh();if(!this.provider)throw new StageError('MODEL_NOT_CONFIGURED');result.evidenceStatus=this.provider.mode;
        const value=await budget.run(this.provider,{stage,photos,context,checkAuthorization:fresh},signal);fresh();return value;
      };
      let stopFurtherCalls=false;
      const candidateReviewItems:string[]=[];
      const fatalCodes=new Set(['STALE_RUN','AUTHORIZATION_CHANGED','SOURCE_OR_AUTHORIZATION_CHANGED','CANCELLED','TIMEOUT','MODEL_VERSION_MISMATCH','BUDGET_OVERRUN','RESERVATION_OVERRUN','CALL_NOT_AUTHORIZED']);
      for(const photoId of changed){const photo=current.get(photoId)!;
        try{
          const raw=ExtractSchema.parse(await call('extract',[photo],{requestedPhotoIds:[photoId]}));
          if(raw.observations.length!==1)throw new StageError('OBSERVATION_COVERAGE');
          const sanitized=sanitizeObservationCandidate(raw.observations[0],photo);
          candidateReviewItems.push(...sanitized.reviewItems);
          observations[photoId]={inputHash:photoHash(photo),version,value:validateObservation(sanitized.candidate,photo)};
        }catch(error){const code=error instanceof StageError?error.code:'INVALID_OUTPUT';
          result.errors.push({stage:'extract',photoIds:[photoId],code,...(error instanceof StageError&&error.diagnostic?{diagnostic:error.diagnostic}:{})});
          if(fatalCodes.has(code))throw error instanceof StageError?error:new StageError(code);
          if(this.provider?.mode==='real_api'){stopFurtherCalls=true;break;}
        }
      }
      const validReferences=resolveReferences(active,observations,r.references);
      const selected=executionPolicy?.relationPairAllowlist
        ? explicitEvaluationPairs(executionPolicy.relationPairAllowlist,active,observations)
        : candidates([...impacted],active,observations,validReferences,r.budget.candidatesPerPhoto,r.retrievalHints??[]);
      result.candidateTraces=selected.traces;
      if(!stopFurtherCalls)for(const pair of selected.pairs){
        const photos=pair.map(id=>current.get(id)!);
        const oldPair=edges.filter(e=>[e.left.photoId,e.right.photoId].sort().join('/')===pair.join('/'));
        if(oldPair.length&&!pair.some(p=>changed.includes(p))&&!refChanged&&!correctionChanged)continue;
        // Old dependencies are removed before review; failed review cannot quietly reuse them.
        edges=edges.filter(e=>!oldPair.includes(e));
        try{
          const raw=RelateSchema.parse(await call('relate',photos,{requestedPairs:[pair],personMatchingEnabled:initialAuthorization.allowPersonMatching,
            observations:pair.map(id=>observations[id].value),references:validReferences.filter(ref=>pair.includes(ref.endpoint.photoId))}));
          const validated=raw.relations.map(e=>validateRelation(e,photos,observations,pair));
          if(!validated.some(e=>e.kind==='event'))throw new StageError('RELATION_COVERAGE');
          if(initialAuthorization.allowPersonMatching&&pair.every(id=>observations[id].value.people.length)&&!validated.some(e=>e.kind==='person')){
            // A missing identity comparison must not discard valid event and facet results.
            // Keep the people separate and surface an auditable review item; the model prompt
            // asks for an explicit unknown relation, but this fallback protects product flow.
            candidateReviewItems.push(`PERSON_RELATION_UNRESOLVED:${pair.join(':')}`);
          }
          if(new Set(validated.map(e=>pairKey(e.kind,e.left,e.right))).size!==validated.length)throw new StageError('DUPLICATE_RELATION');
          if(!initialAuthorization.allowPersonMatching&&validated.some(e=>e.kind==='person'))throw new StageError('PERSON_MATCHING_NOT_AUTHORIZED');
          edges.push(...validated);
        }catch(error){const code=error instanceof StageError?error.code:'INVALID_OUTPUT';result.errors.push({stage:'relate',photoIds:pair,code,...(error instanceof StageError&&error.diagnostic?{diagnostic:error.diagnostic}:{})});
          if(fatalCodes.has(code))throw error instanceof StageError?error:new StageError(code);
          if(this.provider?.mode==='real_api'){stopFurtherCalls=true;break;}}
      }
      if(this.provider?.mode==='real_api'&&!Object.keys(observations).length&&result.errors.length){
        const first=result.errors[0];throw new StageError(first.code,first.diagnostic);
      }
      fresh();
      const reconciled=reconcile(active,observations,edges,r.corrections,r.references,previous?.groups??[],key);
      // Unknown low-impact relations remain auditable in edges but do not create
      // a user task. Keeping two items separate is the safe reversible default.
      result.reviewItems=[...candidateReviewItems,...reconciled.issues,
        ...Object.values(observations).flatMap(o=>o.value.conflicts.map(f=>`CONFLICT:${o.value.photoId}:${f}`)),
        ...selected.traces.filter(t=>t.coverage==='truncated').map(t=>`CANDIDATE_TRUNCATED:${t.photoId}`)];
      const snapshot:AlgorithmSnapshot={scope:r.scope,revision:(previous?.revision??0)+1,version,authorizationRevision:r.authorizationRevision,contextHash,
        observations,edges,groups:reconciled.groups,referencesHash:digest(r.references),correctionsHash:digest(r.corrections),reviewItems:result.reviewItems,candidateTraces:result.candidateTraces,pendingPhotoIds:[...new Set([...active.filter(photo=>!observations[photo.photoId]).map(photo=>photo.photoId),...result.errors.flatMap(e=>e.photoIds)])],workflowStatus:result.errors.length||result.reviewItems.length?'needs_review':'succeeded'};
      // Incomplete runs can be re-entered to retry gaps; successful observations still cache by input hash.
      if(result.errors.length)snapshot.contextHash=`incomplete:${contextHash}`;
      if(!Object.keys(observations).length&&result.errors.length)snapshot.workflowStatus='failed';
      fresh();if(!this.store.compareAndSet(key,previous?.revision??0,snapshot))throw new StageError('STALE_RUN');
      result.snapshot=snapshot;result.retiredGroupIds=(previous?.groups??[]).filter(g=>!snapshot.groups.some(n=>n.groupId===g.groupId)).map(g=>g.groupId);
      result.workflowStatus=snapshot.workflowStatus;
      if(!Object.keys(observations).length&&result.errors.length)result.workflowStatus='failed';
    }catch(error){const code=error instanceof StageError?error.code:'INVALID_INPUT';result.errors.push({stage:'task',photoIds:[],code,...(error instanceof StageError&&error.diagnostic?{diagnostic:error.diagnostic}:{})});result.workflowStatus=code==='CANCELLED'?'cancelled':'failed';delete result.snapshot;}
    finally{Object.assign(result.usage,{requests:budget.records.length,images:budget.records.reduce((s,r)=>s+r.imageCount,0),inputTokens:budget.inputTokens,
      outputTokens:budget.outputTokens,costCny:budget.costCny,latencyMs:Date.now()-started});}
    return result;
  }
}

function explicitEvaluationPairs(allowlist:[string,string][],photos:Photo[],observations:Record<string,CachedObservation>){
  const activeIds=new Set(photos.filter(photo=>photo.active&&observations[photo.photoId]).map(photo=>photo.photoId));
  const seen=new Set<string>();const pairs:[string,string][]=[];
  for(const value of allowlist){
    const pair=[...value].sort() as [string,string];
    if(pair[0]===pair[1])throw new StageError('SELF_RELATION_PAIR');
    if(!pair.every(id=>activeIds.has(id)))throw new StageError('INVALID_RELATION_PAIR');
    const key=pair.join('/');if(seen.has(key))throw new StageError('DUPLICATE_RELATION_PAIR');seen.add(key);pairs.push(pair);
  }
  const traces=[...activeIds].sort().map(photoId=>{
    const selected=pairs.filter(pair=>pair.includes(photoId)).map(pair=>pair[0]===photoId?pair[1]:pair[0]).sort();
    const omitted=[...activeIds].filter(id=>id!==photoId&&!selected.includes(id)).sort();
    return {photoId,eligible:activeIds.size-1,selected,omitted,coverage:'complete' as const,reason:'explicit_evaluation_pair_allowlist'};
  });
  return {pairs,traces};
}
