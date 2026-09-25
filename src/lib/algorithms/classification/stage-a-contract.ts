import { z } from 'zod';
import { createHash } from 'node:crypto';
export const STAGE_A_VERSION = 'classification-stage-a.1';
export const PROMPT_VERSION = 'sgx-five-facets.5';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ScopeSchema = z.object({ householdId:id, subjectId:id }).strict();
const support = z.object({ photoId:id, source:z.enum(['visual','caption','exif','ocr','user_text','final_asr']), evidenceId:id.optional(), quote:z.string().min(1).max(1000) }).strict();
const supports = z.array(support).min(1).max(12);
export const BoxSchema = z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict()
  .refine(b=>b.x+b.width<=1&&b.y+b.height<=1,'INVALID_REGION');
export const PhotoSchema = z.object({ photoId:id, scope:ScopeSchema, revision:z.number().int().positive(),
  sourceRef:id, sourceHash:hash, mimeType:z.enum(['image/jpeg','image/png','image/webp']),
  caption:z.string().max(16000).default(''), textEvidence:z.array(z.object({evidenceId:id,revision:z.number().int().positive(),sourceHash:hash,source:z.enum(['user_text','final_asr']),text:z.string().min(1).max(65536)}).strict()).max(24).optional(), exif:z.object({capturedAt:z.string().datetime({offset:true}).optional(), originalCapture:z.boolean()}).strict().optional(),
  active:z.boolean() }).strict();
export const FacetSchema = z.enum(['person','time','place','event','scene']);
export const ObservationSchema = z.object({ photoId:id,
  people:z.array(z.object({ faceId:id, description:z.string().max(600), box:BoxSchema, supports }).strict()).max(30),
  mentions:z.array(z.object({text:z.string().min(1).max(128),supports}).strict()).max(30),
  times:z.array(z.object({value:z.string().min(1).max(128), precision:z.enum(['date','year','decade','relative']),
    role:z.enum(['event','capture','scan','upload']), supports}).strict()).max(8),
  places:z.array(z.object({label:z.string().min(1).max(128),canonical:z.string().max(128).optional(),supports}).strict()).max(8),
  events:z.array(z.object({type:z.string().min(1).max(128),instanceHint:z.string().max(256).optional(),supports}).strict()).max(8),
  scenes:z.array(z.object({label:z.string().min(1).max(128),supports}).strict()).max(12),
  unknownFacets:z.array(FacetSchema).max(5), conflicts:z.array(FacetSchema).max(5)
}).strict();
export const EndpointSchema = z.object({photoId:id,faceId:id.optional()}).strict();
export const RelationSchema = z.object({kind:z.enum(['person','event']),left:EndpointSchema,right:EndpointSchema,
  decision:z.enum(['same','different','unknown']),supports,rationale:z.string().min(1).max(1000)}).strict();
export const ExtractSchema = z.object({observations:z.array(ObservationSchema).min(1).max(6)}).strict();
export const RelateSchema = z.object({relations:z.array(RelationSchema).max(120)}).strict();
export const ReferenceSchema = z.object({ personId:id, displayName:z.string().min(1).max(128), revision:z.number().int().positive(),
  endpoint:EndpointSchema,faceBox:BoxSchema, photoHash:hash, confirmed:z.literal(true)}).strict();
export const CorrectionSchema = z.object({ correctionId:id, revision:z.number().int().positive(), authorityRef:id,
  kind:z.enum(['person','event']), decision:z.enum(['same','different']),left:EndpointSchema,right:EndpointSchema,
  leftPhotoHash:hash,rightPhotoHash:hash,leftFaceBox:BoxSchema.optional(),rightFaceBox:BoxSchema.optional(),active:z.boolean() }).strict()
  .refine(c=>c.kind!=='person'||Boolean(c.leftFaceBox&&c.rightFaceBox),'PERSON_CORRECTION_REQUIRES_REGIONS');
export const BudgetSchema = z.object({ maxRequests:z.number().int().min(0).max(1000), maxInputTokens:z.number().int().positive(),
  maxOutputTokens:z.number().int().positive(), maxCostCny:z.number().nonnegative(), deadlineAt:z.string().datetime({offset:true}),
  candidatesPerPhoto:z.number().int().min(1).max(12), maxOutputPerRequest:z.number().int().min(256).max(8192),
  stageOutputTokens:z.object({extract:z.number().int().min(256).max(8192),relate:z.number().int().min(256).max(8192)}).strict().optional(),
  maxCallDurationMs:z.number().int().min(1).max(60000).default(60000) }).strict();
export const RequestSchema = z.object({contractVersion:z.literal(STAGE_A_VERSION),runId:id,scope:ScopeSchema,
  authorizationRevision:id, trigger:z.enum(['upload','information_changed','correction','view']),
  photos:z.array(PhotoSchema).max(5000),references:z.array(ReferenceSchema).max(100),corrections:z.array(CorrectionSchema).max(1000),budget:BudgetSchema}).strict();
export type Scope=z.infer<typeof ScopeSchema>;
export type Photo=z.infer<typeof PhotoSchema>;
export type Observation=z.infer<typeof ObservationSchema>;
export type Relation=z.infer<typeof RelationSchema>;
export type Endpoint=z.infer<typeof EndpointSchema>;
export type Reference=z.infer<typeof ReferenceSchema>;
export type Correction=z.infer<typeof CorrectionSchema>;
export type Request=z.infer<typeof RequestSchema>;
export type Budget=z.infer<typeof BudgetSchema>;
export type Support=z.infer<typeof support>;
export interface StageDiagnosticIssue {path:string;code:string;keys?:string[];expected?:string;}
export interface StageDiagnostic {phase:'provider_envelope'|'content_json'|'schema';issues:StageDiagnosticIssue[];}
export class StageError extends Error {constructor(public code:string,public diagnostic?:StageDiagnostic){super(code);}}
export const stable = (v:unknown):string => Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'
  ?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable((v as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(v);
export const digest=(v:unknown)=>`sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;
export const photoHash=(p:Photo)=>digest(p);
export const endpointKey=(e:Endpoint)=>`${e.photoId}/${e.faceId??''}`;
export const pairKey=(kind:string,a:Endpoint,b:Endpoint)=>stable([kind,...[endpointKey(a),endpointKey(b)].sort()]);
export const sameScope=(a:Scope,b:Scope)=>a.householdId===b.householdId&&a.subjectId===b.subjectId;
export function ensure(condition:unknown,code:string):asserts condition {if(!condition)throw new StageError(code);}

export function validateSupports(items:Support[], photos:Photo[]) {
  for(const s of items){const p=photos.find(p=>p.photoId===s.photoId);if(!p)throw new StageError('FOREIGN_SOURCE');
    if(s.source==='caption'&&!p.caption.includes(s.quote))throw new StageError('UNSUPPORTED_QUOTE');
    if(s.source==='exif'&&(!p.exif||!stable(p.exif).includes(s.quote)))throw new StageError('UNSUPPORTED_EXIF');
    if(s.source==='user_text'||s.source==='final_asr'){
      if(!s.evidenceId)throw new StageError('TEXT_SUPPORT_REQUIRES_EVIDENCE');
      const evidence=(p.textEvidence??[]).find(e=>e.evidenceId===s.evidenceId&&e.source===s.source);
      if(!evidence)throw new StageError('FOREIGN_SOURCE');
      if(!evidence.text.includes(s.quote))throw new StageError('UNSUPPORTED_QUOTE');
    }
  }
}
export function validateObservation(raw:unknown, photo:Photo):Observation {
  const parsed=ObservationSchema.parse(raw);
  const times=parsed.times.map(time=>{
    const value=time.value.normalize('NFKC').trim();
    if(time.precision==='year')return {...time,value:value.replace(/^(\d{4})年$/,'$1')};
    if(time.precision==='date'){
      const match=value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
      return match?{...time,value:`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`}:{...time,value};
    }
    if(time.precision==='decade')return {...time,value:value.replace(/^(\d{3}0)年代$/,'$1s')};
    return {...time,value};
  });
  const nonempty={person:parsed.people.length+parsed.mentions.length,time:times.length,place:parsed.places.length,event:parsed.events.length,scene:parsed.scenes.length};
  // unknownFacets is a deterministic projection of the accepted arrays, not a model judgement.
  const o:Observation={...parsed,times,unknownFacets:FacetSchema.options.filter(f=>!nonempty[f])};
  if(o.photoId!==photo.photoId)throw new StageError('FOREIGN_PHOTO');
  if(new Set(o.people.map(p=>p.faceId)).size!==o.people.length)throw new StageError('DUPLICATE_FACE');
  const all=[...o.people,...o.mentions,...o.times,...o.places,...o.events,...o.scenes];
  all.forEach(x=>validateSupports(x.supports,[photo]));
  if(o.people.some(p=>!p.supports.some(s=>s.source==='visual')))throw new StageError('FACE_WITHOUT_VISUAL');
  if(o.mentions.some(m=>!m.supports.every(s=>s.source==='caption'||s.source==='user_text'||s.source==='final_asr')))throw new StageError('MENTION_WITHOUT_TEXT');
  for(const time of o.times){
    if(time.supports.every(s=>s.source==='visual'))throw new StageError('UNSUPPORTED_TIME');
    if(time.precision==='year'&&!/^\d{4}$/.test(time.value))throw new StageError('INVALID_TIME');
    if(time.precision==='decade'&&!/^\d{3}0s$/.test(time.value))throw new StageError('INVALID_TIME');
    if(time.precision==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(time.value)||!Number.isFinite(Date.parse(time.value))||new Date(time.value).toISOString().slice(0,10)!==time.value))throw new StageError('INVALID_TIME');
    if(time.precision!=='relative') {
      const year=time.value.slice(0,4);
      const grounded=time.supports.some(s=>{
        if(s.source==='visual')return false;
        if(time.precision==='year')return s.quote.includes(year);
        if(time.precision==='decade')return s.quote.includes(year)||s.quote.includes(`${year.slice(2,3)}0年代`);
        const [y,m,d]=time.value.split('-');return s.quote.includes(time.value)||s.quote.includes(`${y}年${Number(m)}月${Number(d)}日`);
      });
      if(!grounded)throw new StageError('UNSUPPORTED_TIME_PRECISION');
    }
    if(time.role==='capture'&&time.supports.some(s=>s.source==='exif')&&!photo.exif?.originalCapture)throw new StageError('SCAN_NOT_CAPTURE');
  }
  for(const f of FacetSchema.options){if(Boolean(nonempty[f])===o.unknownFacets.includes(f))throw new StageError('FACET_COVERAGE');}
  if(new Set(o.unknownFacets).size!==o.unknownFacets.length)throw new StageError('DUPLICATE_FACET');
  if(new Set(o.conflicts).size!==o.conflicts.length)throw new StageError('DUPLICATE_CONFLICT');
  return o;
}
