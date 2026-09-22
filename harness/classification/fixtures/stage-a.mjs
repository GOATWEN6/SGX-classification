import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const base=`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification`;
export const contract=require(`${base}/stage-a-contract.js`);
export const {ClassificationEngine,MemorySnapshotStore}=require(`${base}/stage-a-pipeline.js`);
export const {ApiVisionProvider,PROVIDER_ENDPOINTS,TaskBudget}=require(`${base}/stage-a-provider.js`);
export const {createStageHttpServer}=require(`${base}/stage-a-http.js`);
export const {correctionPairs}=require(`${base}/stage-a-association.js`);
// One-pixel PNG is a transport fixture, NEVER an image-recognition accuracy sample.
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1kAAAAASUVORK5CYII=','base64');
export const hash=`sha256:${createHash('sha256').update(png).digest('hex')}`;
export const scope={householdId:'house_a',subjectId:'elder_a'};
export function photo(photoId,caption=''){return {photoId,scope,revision:1,sourceRef:`object_${photoId}`,sourceHash:hash,mimeType:'image/png',caption,active:true};}
export function observation(p,extra={}){
  const visual=[{photoId:p.photoId,source:'visual',quote:'controlled mock visual observation'}];
  const text=[{photoId:p.photoId,source:'caption',quote:p.caption||'missing'}];
  const o={photoId:p.photoId,people:extra.face?[{faceId:'f1',description:'synthetic face',box:{x:0.1,y:0.1,width:0.2,height:0.2},supports:visual}]:[],mentions:[],
    times:extra.time?[{value:extra.time,precision:extra.precision??'year',role:'event',supports:text}]:[],
    places:extra.place?[{label:extra.place,supports:text}]:[],events:extra.event?[{type:extra.event,...(extra.hint?{instanceHint:extra.hint}:{}),supports:text}]:[],
    scenes:[{label:extra.scene??'室内',supports:visual}],unknownFacets:[],conflicts:extra.conflicts??[]};
  for(const [facet,field] of [['person','people'],['time','times'],['place','places'],['event','events'],['scene','scenes']])if(!o[field].length)o.unknownFacets.push(facet);
  return o;
}
export function relation(pair,kind,decision='unknown'){
  return {kind,left:{photoId:pair[0],...(kind==='person'?{faceId:'f1'}:{})},right:{photoId:pair[1],...(kind==='person'?{faceId:'f1'}:{})},decision,
    supports:pair.map(photoId=>({photoId,source:'visual',quote:'controlled comparison observation'})),rationale:'controlled transport test decision'};
}
export function setup(photos,bank={},options={}){
  let auth={scope,authorizationRevision:'auth1',active:true,allowedPhotoIds:photos.filter(p=>p.active).map(p=>p.photoId),allowPersonMatching:true,
    photoVersions:Object.fromEntries(photos.filter(p=>p.active).map(p=>[p.photoId,contract.photoHash(p)])),contextRevision:'ctx1',reviewContextHash:contract.digest([[],[]])};
  const calls=[];
  const transport=async(url,init)=>{
    const body=JSON.parse(init.body);calls.push({url,body});const context=JSON.parse(body.messages[1].content[0].text);const c=context.untrustedContext;
    if(options.beforeReply)await options.beforeReply(context,c,calls);
    let value;
    if(context.stage==='extract')value={observations:c.requestedPhotoIds.map(id=>bank[id]??observation(photos.find(p=>p.photoId===id)))};
    else {const pair=c.requestedPairs[0];value={relations:[relation(pair,'event',options.eventDecision?.(pair,c)??'unknown'),
      ...(c.personMatchingEnabled&&c.observations.every(o=>o.people.length)?[relation(pair,'person',options.personDecision?.(pair,c)??'unknown')]:[])]};}
    if(options.alterOutput)value=options.alterOutput(value,context.stage);
    return new Response(JSON.stringify({id:`mock_${calls.length}`,model:options.returnedModel??options.providerOverrides?.model??'qwen3.5-flash-2026-02-23',usage:{prompt_tokens:100,completion_tokens:50},
      choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{status:200});
  };
  const provider=new ApiVisionProvider({provider:'qwen',model:'qwen3.5-flash-2026-02-23',resolver:async()=>({bytes:png,mimeType:'image/png'}),transport,
    inputCnyPerMillion:0.2,outputCnyPerMillion:2,...options.providerOverrides});
  const store=options.store??new MemorySnapshotStore();const engine=new ClassificationEngine(provider,store);
  const req={contractVersion:contract.STAGE_A_VERSION,runId:'run1',scope,authorizationRevision:'auth1',trigger:'upload',photos,references:[],corrections:[],
    budget:{maxRequests:100,maxInputTokens:10000000,maxOutputTokens:1000000,maxCostCny:20,deadlineAt:new Date(Date.now()+10000).toISOString(),candidatesPerPhoto:4,maxOutputPerRequest:2048}};
  const sync=()=>{auth={...auth,contextRevision:`ctx${Math.random()}`,reviewContextHash:contract.digest([req.references,req.corrections]),allowedPhotoIds:req.photos.filter(p=>p.active).map(p=>p.photoId),photoVersions:Object.fromEntries(req.photos.filter(p=>p.active).map(p=>[p.photoId,contract.photoHash(p)]))};};
  return {req,engine,provider,store,calls,bank,getAuth:()=>auth,setAuth:a=>auth=a,sync};
}
export const groupMembers=(result,kind)=>result.snapshot.groups.filter(g=>g.kind===kind).map(g=>g.members.map(m=>m.photoId).sort());
export function correction(correctionId,kind,decision,a,b){return {correctionId,revision:1,authorityRef:'verified_user_action',kind,decision,
  left:{photoId:a.photoId,...(kind==='person'?{faceId:'f1'}:{})},right:{photoId:b.photoId,...(kind==='person'?{faceId:'f1'}:{})},leftPhotoHash:a.sourceHash,rightPhotoHash:b.sourceHash,...(kind==='person'?{leftFaceBox:{x:0.1,y:0.1,width:0.2,height:0.2},rightFaceBox:{x:0.1,y:0.1,width:0.2,height:0.2}}:{}),active:true};}
