import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskBudget,ApiVisionProvider,png,photo,setup,contract} from './fixtures/stage-a.mjs';

const cases=[{name:'input',usage:{inputTokens:50000,outputTokens:100},dimension:'inputTokens'},
  {name:'output',usage:{inputTokens:100,outputTokens:2049},dimension:'outputTokens'}];
const limits=()=>({maxRequests:300,maxInputTokens:10000000,maxOutputTokens:614400,maxCostCny:20,
  deadlineAt:new Date(Date.now()+10000).toISOString(),candidatesPerPhoto:4,maxOutputPerRequest:2048,maxCallDurationMs:1000});
const call={stage:'extract',photos:[photo('a')],context:{}};
function provider(usage){let calls=0;return {version:'test',mode:'real_api',inputCnyPerMillion:1.2,outputCnyPerMillion:12,
  get calls(){return calls;},invoke:async()=>{calls++;return {value:{},usage,responseId:`local_${calls}`,model:'test'};}};}

for(const c of cases){
  test(`per-call ${c.name} overrun below total cap preserves actual usage and permanently stops this TaskBudget`,async()=>{
    const budget=new TaskBudget(limits()),p=provider(c.usage);
    await assert.rejects(budget.run(p,call),/RESERVATION_OVERRUN/);
    assert.equal(p.calls,1);assert.equal(budget.records.length,1);
    const record=budget.records[0];assert.equal(record.status,'RESERVATION_OVERRUN');assert.equal(record.accounting,'reported_usage');
    assert.deepEqual(record.reservationExceeded,[c.dimension]);assert.equal(record.reservation.inputTokens,24580);assert.equal(record.reservation.outputTokens,2048);
    assert.equal(budget.inputTokens,c.usage.inputTokens);assert.equal(budget.outputTokens,c.usage.outputTokens);
    const actual=(c.usage.inputTokens*1.2+c.usage.outputTokens*12)/1e6;
    assert.ok(Math.abs(budget.costCny-actual)<1e-12);assert.equal(record.costCny,actual);assert.ok(budget.costCny<20);
    await assert.rejects(budget.run(p,call),/RESERVATION_OVERRUN/);assert.equal(p.calls,1);assert.equal(budget.records.length,1);
  });
  test(`real-mode engine stops after first ${c.name} reservation overrun`,async()=>{
    const s=setup([photo('a'),photo('b')]);const p=provider(c.usage);
    // Replace only invoke with a local stub; no network method or credential getter executes.
    s.provider.mode='real_api';s.provider.invoke=p.invoke;
    const result=await s.engine.process(s.req,s.getAuth);
    assert.equal(p.calls,1);assert.equal(result.workflowStatus,'failed');assert.equal(result.snapshot,undefined);
    assert.equal(result.errors[0].code,'RESERVATION_OVERRUN');assert.equal(result.usage.inputTokens,c.usage.inputTokens);
    assert.equal(result.usage.outputTokens,c.usage.outputTokens);assert.equal(result.usage.records[0].accounting,'reported_usage');
  });
}
test('usage exactly equal to reservation is allowed and does not latch a stop',async()=>{
  const b=new TaskBudget(limits()),p=provider({inputTokens:24580,outputTokens:2048});
  await b.run(p,call);await b.run(p,call);assert.equal(p.calls,2);assert.equal(b.records[0].status,'succeeded');
});
test('failure without usage keeps conservative reservation accounting',async()=>{
  const b=new TaskBudget(limits()),p=provider({inputTokens:1,outputTokens:1});p.invoke=async()=>{throw new contract.StageError('MISSING_USAGE_OR_PROVENANCE');};
  await assert.rejects(b.run(p,call),/MISSING_USAGE_OR_PROVENANCE/);
  const r=b.records[0];assert.equal(r.accounting,'conservative_reservation');assert.equal(b.inputTokens,24580);assert.equal(b.outputTokens,2048);
  assert.equal(r.costCny,(24580*1.2+2048*12)/1e6);assert.equal(b.costCny,r.costCny);
});
for(const [name,content,finishReason,code] of [
  ['schema','{"observations":[]}','stop','INVALID_OUTPUT'],
  ['json','{','stop','INVALID_OUTPUT'],
  ['length','{','length','OUTPUT_TRUNCATED'],
]){
  test(`provider ${name} failure settles reported billing without hiding its failure`,async()=>{
    const b=new TaskBudget(limits());
    const p=new ApiVisionProvider({provider:'qwen',model:'test',resolver:async()=>({bytes:png,mimeType:'image/png'}),
      transport:async()=>new Response(JSON.stringify({id:'billed_failure',model:'test',usage:{prompt_tokens:100,completion_tokens:50},
        choices:[{finish_reason:finishReason,message:{content}}]})),inputCnyPerMillion:1.2,outputCnyPerMillion:12});
    await assert.rejects(b.run(p,call),error=>error.code===code);
    assert.equal(b.records[0].status,code);assert.equal(b.records[0].accounting,'reported_usage');
    assert.equal(b.inputTokens,100);assert.equal(b.outputTokens,50);
    assert.ok(Math.abs(b.costCny-0.00072)<1e-12);assert.equal(b.records[0].responseId,'billed_failure');
  });
}
test('invalid output with reported reservation overrun stops every subsequent call',async()=>{
  const b=new TaskBudget(limits()),p=provider({inputTokens:1,outputTokens:1});let calls=0;
  p.invoke=async()=>{calls++;throw new contract.StageError('INVALID_OUTPUT',undefined,{inputTokens:100,outputTokens:2049,responseId:'overrun',model:'test'});};
  await assert.rejects(b.run(p,call),/INVALID_OUTPUT/);
  assert.equal(b.outputTokens,2049);assert.equal(b.records[0].accounting,'reported_usage');
  await assert.rejects(b.run(p,call),/RESERVATION_OVERRUN/);assert.equal(calls,1);
});
test('missing provenance and a mismatched returned model retain conservative billing',async()=>{
  for(const raw of [
    {model:'test',usage:{prompt_tokens:100,completion_tokens:50}},
    {id:'other_model',model:'unexpected',usage:{prompt_tokens:100,completion_tokens:50}},
  ]){
    const b=new TaskBudget(limits());
    const p=new ApiVisionProvider({provider:'qwen',model:'test',resolver:async()=>({bytes:png,mimeType:'image/png'}),
      transport:async()=>new Response(JSON.stringify({...raw,choices:[{finish_reason:'stop',message:{content:'{"observations":[]}'}}]})),
      inputCnyPerMillion:1.2,outputCnyPerMillion:12});
    await assert.rejects(b.run(p,call),error=>['MISSING_USAGE_OR_PROVENANCE','MODEL_VERSION_MISMATCH'].includes(error.code));
    assert.equal(b.records[0].accounting,'conservative_reservation');assert.equal(b.inputTokens,24580);
  }
});
test('stage-specific output limits reserve extraction and relation calls independently',async()=>{
  const staged={...limits(),stageOutputTokens:{extract:4096,relate:1024}};
  const b=new TaskBudget(staged),p=provider({inputTokens:100,outputTokens:100});
  await b.run(p,call);
  await b.run(p,{stage:'relate',photos:[photo('a'),photo('b')],context:{}});
  assert.equal(b.records[0].reservation.outputTokens,4096);
  assert.equal(b.records[1].reservation.outputTokens,1024);
  assert.equal(b.records[0].status,'succeeded');assert.equal(b.records[1].status,'succeeded');
});
