import { Correction, Endpoint, Observation, Photo, Reference, Relation, RetrievalHint, StageError, bindUniqueTextEvidence, digest, endpointKey, pairKey, photoHash, validateSupports } from './stage-a-contract';
export interface CachedObservation {inputHash:string;version:string;value:Observation;}
export interface Edge extends Relation {deps:Record<string,string>;origin:'ai'|'user';}
export interface Group {groupId:string;kind:'person'|'event';members:Endpoint[];revision:number;state:'ai_organized';
  usableForOrganization:boolean;identity?:{personId:string;displayName:string;state:'reference_label_candidate'};supersedes:string[];}
export interface CandidateTrace {photoId:string;eligible:number;selected:string[];omitted:string[];coverage:'complete'|'truncated';reason:string;}
/** Local face IDs may change across model versions. User decisions anchor to image bytes + region. */
export function anchorEndpoint(endpoint:Endpoint,box:Reference['faceBox'],observations:Record<string,CachedObservation>):Endpoint|undefined {
  const matches=observations[endpoint.photoId]?.value.people.filter(p=>{
    const b=p.box;const intersection=Math.max(0,Math.min(box.x+box.width,b.x+b.width)-Math.max(box.x,b.x))*Math.max(0,Math.min(box.y+box.height,b.y+b.height)-Math.max(box.y,b.y));
    return intersection/(box.width*box.height+b.width*b.height-intersection)>=0.7;
  })??[];
  return matches.length===1?{photoId:endpoint.photoId,faceId:matches[0].faceId}:undefined;
}
export function resolveReferences(photos:Photo[],observations:Record<string,CachedObservation>,references:Reference[]){
  return references.flatMap(r=>{const endpoint=anchorEndpoint(r.endpoint,r.faceBox,observations);
    return photos.some(p=>p.active&&p.photoId===r.endpoint.photoId&&p.sourceHash===r.photoHash)&&endpoint?[{...r,endpoint}]:[];});
}
export function candidates(changed:string[],photos:Photo[],observations:Record<string,CachedObservation>,references:Reference[],limit:number,hints:RetrievalHint[]=[] ) {
  const traces:CandidateTrace[]=[];const pairs:[string,string][]=[];const seen=new Set<string>();
  for(const id of changed){
    const current=observations[id]?.value;if(!current)continue;
    const eligible=photos.filter(p=>p.active&&p.photoId!==id&&observations[p.photoId]);
    const retrievalTier=(p:Photo)=>{
      const o=observations[p.photoId].value;
      const reference=references.some(r=>r.endpoint.photoId===p.photoId);
      const event=current.events.some(a=>o.events.some(b=>a.type===b.type));
      const currentEventTimes=current.times.filter(time=>time.role==='event'||time.role==='capture');
      const otherEventTimes=o.times.filter(time=>time.role==='event'||time.role==='capture');
      const time=currentEventTimes.some(a=>otherEventTimes.some(b=>a.value===b.value&&a.precision===b.precision));
      const place=current.places.some(a=>o.places.some(b=>a.label===b.label));
      // Categorical recall lanes only. These tiers decide which small set is
      // worth comparing; they are never interpreted as relation confidence.
      if(reference)return 0;
      if(event&&time&&place)return 1;
      if(event&&time)return 2;
      if(event&&place)return 3;
      if(event)return 4;
      if(time&&place)return 5;
      if(time)return 6;
      if(place)return 7;
      return 8;
    };
    eligible.sort((a,b)=>retrievalTier(a)-retrievalTier(b)||a.photoId.localeCompare(b.photoId));
    const hintedIds=hints.filter(hint=>hint.leftPhotoId===id||hint.rightPhotoId===id)
      .sort((a,b)=>a.rank-b.rank||stableHint(a).localeCompare(stableHint(b)))
      .map(hint=>hint.leftPhotoId===id?hint.rightPhotoId:hint.leftPhotoId)
      .filter(otherId=>eligible.some(photo=>photo.photoId===otherId));
    const orderedIds=[...new Set([...hintedIds,...eligible.map(photo=>photo.photoId)])];
    const ordered=orderedIds.map(photoId=>eligible.find(photo=>photo.photoId===photoId)!);
    // Keep a fallback slot even when metadata is missing / people are decades apart.
    let selected=ordered.slice(0,limit);
    if(!hintedIds.length&&eligible.length>limit&&limit>1){const fallback=eligible[eligible.length-1];selected=[...eligible.slice(0,limit-1),fallback];}
    const selectedIds=selected.map(p=>p.photoId);
    traces.push({photoId:id,eligible:eligible.length,selected:selectedIds,omitted:eligible.filter(p=>!selectedIds.includes(p.photoId)).map(p=>p.photoId),
      coverage:eligible.length>limit?'truncated':'complete',reason:hintedIds.length?'embedding_topk_then_categorical':eligible.length>limit?'bounded_categorical_retrieval_with_discovery_fallback':'all_authorized_candidates'});
    for(const p of selected){const pair=[id,p.photoId].sort() as [string,string];const key=pair.join('/');if(!seen.has(key)){seen.add(key);pairs.push(pair);}}
  }
  return {pairs,traces};
}
function stableHint(hint:RetrievalHint):string{return `${hint.kind}/${hint.leftPhotoId}/${hint.rightPhotoId}/${hint.modelId}/${hint.modelRevision}`;}
function relationRationalePolarity(rationale:string):'same'|'different'|'unspecified' {
  const value=rationale.normalize('NFKC').toLocaleLowerCase();
  const uncertain=/(?:无法|不能|难以)(?:判断|确定|确认|辨别)|(?:不确定|尚不明确|并不明确|不清楚|看不出)|是否(?:属于|是|为)?同一|(?:可能|也许|或许).*(?:也可能|也许|或许)|\b(?:unclear|uncertain|indeterminate|unknown|not sure)\b|\b(?:cannot|can't|can not|unable to)\s+(?:determine|tell|confirm)\b|\bwhether\b/.test(value);
  if(uncertain)return 'unspecified';
  const negatedSamePattern=/(?:并不是|不是|并非|不属于|不算|不能算)(?:属于|是|为)?同一(?:个|次|场|趟)?(?:事件|旅行|行程|经历|故事|活动|庆典|聚会)|\bnot\s+(?:the\s+)?same\s+(?:event|trip|journey|experience|story|occasion)\b|\b(?:isn't|aren't|wasn't|weren't)\s+(?:the\s+)?same\s+(?:event|trip|journey|experience|story|occasion)\b/gi;
  const negatedSame=negatedSamePattern.test(value);
  negatedSamePattern.lastIndex=0;
  const withoutNegatedSame=value.replace(negatedSamePattern,' ');
  const same=/(?:属于|是|为)?同一(?:个|次|场|趟)?(?:事件|旅行|行程|经历|故事|活动|庆典|聚会)|\b(?:same|one)\s+(?:event|trip|journey|experience|story|occasion)\b/.test(withoutNegatedSame);
  const different=/(?:属于|是|为)?(?:不同|另一|另一次|另一场|另一趟|无关|彼此独立)(?:的|个|次|场|趟)?(?:事件|旅行|行程|经历|故事|活动|庆典|聚会)|\b(?:different|separate|distinct|unrelated)\s+(?:events?|trips?|journeys?|experiences?|stories|occasions?)\b/.test(value);
  const explicitDifferent=negatedSame||different;
  if(same===explicitDifferent)return 'unspecified';
  return same?'same':'different';
}
export function validateRelation(raw:Relation,photos:Photo[],observations:Record<string,CachedObservation>,pair:[string,string]):Edge {
  const normalized:Relation={...raw,supports:raw.supports.map(support=>{
    const photo=photos.find(candidate=>candidate.photoId===support.photoId);
    return photo?bindUniqueTextEvidence(support,photo):support;
  })};
  if(normalized.left.photoId===normalized.right.photoId||!pair.every(p=>[normalized.left.photoId,normalized.right.photoId].includes(p)))throw new StageError('UNREQUESTED_PAIR');
  const rationalePolarity=normalized.kind==='event'?relationRationalePolarity(normalized.rationale):'unspecified';
  if((normalized.decision==='different'&&rationalePolarity==='same')||(normalized.decision==='same'&&rationalePolarity==='different'))throw new StageError('MODEL_RELATION_CONTRADICTION');
  validateSupports(normalized.supports,photos);
  for(const side of [normalized.left,normalized.right]){
    if(!normalized.supports.some(s=>s.photoId===side.photoId))throw new StageError('RELATION_MISSING_SOURCE');
    if(normalized.kind==='person'){
      if(!side.faceId||!observations[side.photoId]?.value.people.some(p=>p.faceId===side.faceId))throw new StageError('UNKNOWN_FACE');
      if(!normalized.supports.some(s=>s.photoId===side.photoId&&s.source==='visual'))throw new StageError('IDENTITY_WITHOUT_VISUAL');
    }else if(side.faceId)throw new StageError('EVENT_WITH_FACE');
  }
  return {...normalized,deps:Object.fromEntries(photos.map(p=>[p.photoId,photoHash(p)])),origin:'ai'};
}
function eventWindow(o:Observation|undefined):[number,number]|undefined {
  if(!o||o.conflicts.includes('time'))return;
  const ranges=o.times.filter(t=>['event','capture'].includes(t.role)&&t.precision!=='relative').map(t=>{
    const year=Number(t.value.slice(0,4));
    if(t.precision==='date')return [Date.parse(t.value),Date.parse(t.value)] as [number,number];
    return [Date.UTC(year,0,1),Date.UTC(year+(t.precision==='decade'?10:1),0,1)-1] as [number,number];
  });
  if(!ranges.length)return;
  const lo=Math.max(...ranges.map(r=>r[0])),hi=Math.min(...ranges.map(r=>r[1]));return lo<=hi?[lo,hi]:undefined;
}
export function reconcile(photos:Photo[],observations:Record<string,CachedObservation>,aiEdges:Edge[],corrections:Correction[],references:Reference[],previous:Group[],scopeHash:string) {
  const issues:string[]=[];const current=new Map(photos.map(p=>[p.photoId,p]));
  const validEndpoint=(e:Endpoint,kind:string)=>Boolean(observations[e.photoId]&&(kind==='event'?!e.faceId:observations[e.photoId].value.people.some(p=>p.faceId===e.faceId)));
  const validRefs=resolveReferences(photos,observations,references);
  for(const r of references)if(!validRefs.some(v=>v.personId===r.personId&&v.endpoint.photoId===r.endpoint.photoId&&v.revision===r.revision))issues.push(`STALE_PERSON_REFERENCE:${r.personId}`);
  const userEdges:Edge[]=[];
  const quarantinedPersonPhotos=new Set<string>();
  for(const c of corrections.filter(c=>c.active)){
    const left=current.get(c.left.photoId),right=current.get(c.right.photoId);
    const leftEndpoint=c.kind==='person'?anchorEndpoint(c.left,c.leftFaceBox!,observations):c.left;
    const rightEndpoint=c.kind==='person'?anchorEndpoint(c.right,c.rightFaceBox!,observations):c.right;
    if(!left||!right||left.sourceHash!==c.leftPhotoHash||right.sourceHash!==c.rightPhotoHash||!leftEndpoint||!rightEndpoint||!validEndpoint(leftEndpoint,c.kind)||!validEndpoint(rightEndpoint,c.kind)){
      issues.push(`STALE_CORRECTION:${c.correctionId}`);
      if(c.kind==='person'){quarantinedPersonPhotos.add(c.left.photoId);quarantinedPersonPhotos.add(c.right.photoId);}continue;
    }
    userEdges.push({kind:c.kind,left:leftEndpoint,right:rightEndpoint,decision:c.decision,supports:[],rationale:c.correctionId,
      deps:{[left.photoId]:photoHash(left),[right.photoId]:photoHash(right)},origin:'user'});
  }
  // A rejected pair persists independently of model output, until the trusted correction is explicitly deactivated.
  const byPair=new Map<string,Edge[]>();
  for(const edge of userEdges){const key=pairKey(edge.kind,edge.left,edge.right);byPair.set(key,[...(byPair.get(key)??[]),edge]);}
  const edges=aiEdges.filter(e=>!byPair.has(pairKey(e.kind,e.left,e.right))&&!(e.kind==='person'&&(quarantinedPersonPhotos.has(e.left.photoId)||quarantinedPersonPhotos.has(e.right.photoId))));
  for(const values of byPair.values()){
    if(new Set(values.map(v=>v.decision)).size>1)issues.push(`CORRECTION_CONFLICT:${values[0].rationale}`);
    edges.push(values.find(e=>e.decision==='different')??values[0]);
  }
  const groups:Group[]=[];
  for(const kind of ['event','person'] as const){
    const endpoints:Endpoint[]=kind==='event'?Object.keys(observations).map(photoId=>({photoId})):
      Object.values(observations).flatMap(o=>o.value.people.map(p=>({photoId:o.value.photoId,faceId:p.faceId})));
    const parent=new Map(endpoints.map(e=>[endpointKey(e),endpointKey(e)]));
    const find=(k:string):string=>{const p=parent.get(k)!;return p===k?k:find(p);};
    const members=(k:string)=>endpoints.filter(e=>find(endpointKey(e))===k);
    const subset=edges.filter(e=>e.kind===kind&&validEndpoint(e.left,kind)&&validEndpoint(e.right,kind));
    for(const edge of subset.filter(e=>e.decision==='same').sort((a,b)=>(a.origin==='user'?-1:1)-(b.origin==='user'?-1:1)||pairKey(kind,a.left,a.right).localeCompare(pairKey(kind,b.left,b.right)))){
      const a=find(endpointKey(edge.left)),b=find(endpointKey(edge.right));if(a===b)continue;
      const combined=[...members(a),...members(b)],keys=new Set(combined.map(endpointKey));
      let veto=subset.some(e=>e.decision==='different'&&keys.has(endpointKey(e.left))&&keys.has(endpointKey(e.right)));
      if(kind==='person'){
        if(new Set(combined.map(e=>e.photoId)).size!==combined.length)veto=true;
        const names=new Set(validRefs.filter(r=>keys.has(endpointKey(r.endpoint))).map(r=>r.personId));if(names.size>1)veto=true;
      }else if(edge.origin==='ai'){
        if(combined.some(e=>observations[e.photoId]?.value.conflicts.some(f=>['event','time','place'].includes(f))))veto=true;
        // Date evidence never uses upload/scan timestamps. Check whole component to prevent bridge merges.
        const ranges=combined.map(e=>eventWindow(observations[e.photoId]?.value)).filter((r):r is [number,number]=>Boolean(r));
        if(ranges.length&&Math.max(...ranges.map(r=>r[0]))>Math.min(...ranges.map(r=>r[1])))veto=true;
      }
      if(veto){issues.push(`BLOCKED_ASSOCIATION:${pairKey(kind,edge.left,edge.right)}`);continue;}
      parent.set(b,a);
    }
    const components=[...new Set(endpoints.map(e=>find(endpointKey(e))))].map(k=>members(k).sort((a,b)=>endpointKey(a).localeCompare(endpointKey(b))));
    // Each old ID can survive in only one component; deterministic largest overlap for split, aliases for merge.
    const claims=new Map<string,number>();
    for(const old of previous.filter(g=>g.kind===kind)){
      const overlaps=components.map(c=>c.filter(e=>old.members.some(m=>endpointKey(m)===endpointKey(e))).length);
      const max=Math.max(0,...overlaps);if(max)claims.set(old.groupId,overlaps.indexOf(max));
    }
    components.forEach((component,index)=>{
      const olds=previous.filter(g=>claims.get(g.groupId)===index&&g.kind===kind).sort((a,b)=>a.groupId.localeCompare(b.groupId));
      const groupId=olds[0]?.groupId??`${kind}_${digest([scopeHash,component]).slice(7,31)}`;
      const componentRefs=validRefs.filter(r=>component.some(e=>endpointKey(e)===endpointKey(r.endpoint)));
      const referenceConflict=new Set(componentRefs.map(r=>`${r.personId}/${r.displayName}`)).size>1;
      if(referenceConflict)issues.push(`REFERENCE_CONFLICT:${groupId}`);
      const ref=referenceConflict?undefined:componentRefs[0];
      const changed=!olds[0]||digest(olds[0].members)!==digest(component)||olds[0].identity?.personId!==ref?.personId||olds[0].identity?.displayName!==ref?.displayName;
      const useful=kind==='person'||component.length>1||component.some(e=>observations[e.photoId].value.events.length);
      groups.push({groupId,kind,members:component,revision:olds[0]?olds[0].revision+(changed?1:0):1,state:'ai_organized',usableForOrganization:useful,
        ...(ref?{identity:{personId:ref.personId,displayName:ref.displayName,state:'reference_label_candidate' as const}}:{}),supersedes:olds.slice(1).map(g=>g.groupId)});
    });
  }
  return {groups,issues,edges};
}
/** Build portable merge/split/move pair constraints; caller validates user authority and assigns revisions. */
export function correctionPairs(kind:'person'|'event',operation:'merge'|'split'|'move',groups:Endpoint[][]) {
  const result:{kind:'person'|'event';decision:'same'|'different';left:Endpoint;right:Endpoint}[]=[];
  if(operation==='merge'){
    const all=groups.flat();for(let i=1;i<all.length;i++)result.push({kind,decision:'same',left:all[0],right:all[i]});
  }else {
    for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++)for(const left of groups[i])for(const right of groups[j])result.push({kind,decision:'different',left,right});
    for(const group of groups)for(let i=1;i<group.length;i++)result.push({kind,decision:'same',left:group[0],right:group[i]});
  }
  return result;
}
