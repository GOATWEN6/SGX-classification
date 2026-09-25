import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {readFileSync,appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {preflight,validateApproval,scoreTask,bytesHash,contract} from './stage-a-evaluation.mjs';
const require=createRequire(import.meta.url);
const base=`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification`;
const {ClassificationEngine}=require(`${base}/stage-a-pipeline.js`);
const {ApiVisionProvider,PROVIDER_ENDPOINTS}=require(`${base}/stage-a-provider.js`);
const args=process.argv.slice(2);const option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const manifestPath=option('--manifest'),out=option('--out'),execute=args.includes('--execute');
const allowed=new Set(['--manifest','--out','--execute','--approval','--help']);
for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error('UNKNOWN_OPTION');if(['--manifest','--out','--approval'].includes(args[i]))i++;}
if(args.includes('--help')||!manifestPath||!out){
  console.log('默认离线预检（不读凭据、不发请求）：npm run classification:eval -- --manifest /absolute/batch.json --out /private/tmp/new-report-dir\n经具体批次授权后才可额外使用 --execute --approval /absolute/approval.json。审批文件不能代替真实用户授权；本轮不执行。\n报告目录必须不存在，避免覆盖已有证据。');
  process.exitCode=args.includes('--help')?0:2;
}else{
  try{await mkdir(path.resolve(out),{mode:0o700});}catch(error){if(error?.code==='EEXIST'){console.error('OUTPUT_DIRECTORY_EXISTS');process.exitCode=2;}else throw error;}
  if(process.exitCode===2)process.exit();
  const save=(name,value)=>writeFile(path.join(out,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  let batch,executionAuthorized=false;
  try{
    batch=await preflight(manifestPath);
    await save('preflight.json',{ready:batch.ready,blockers:batch.blockers,manifestHash:batch.manifestHash,...batch.summary});
    if(!execute){console.log(JSON.stringify({mode:'offline_preflight',ready:batch.ready,blockers:batch.blockers,out:path.resolve(out),...batch.summary},null,2));if(!batch.ready)process.exitCode=2;}
    else{
      const approvalPath=option('--approval');if(!approvalPath)throw new Error('APPROVAL_REQUIRED');
      const approvalBytes=await readFile(approvalPath);const approval=validateApproval(batch,JSON.parse(approvalBytes));const approvalHash=bytesHash(approvalBytes);
      executionAuthorized=true;
      const m=batch.manifest;await save('manifest.json',m);await save('approval-reference.json',{approvalHash,authorizationEvidenceRef:approval.authorizationEvidenceRef,expiresAt:approval.expiresAt});
      const start=Date.now(),deadline=Math.min(Date.parse(approval.expiresAt),start+m.caps.maxDurationSeconds*1000);
      const totals={requests:0,images:0,inputTokens:0,outputTokens:0,costCny:0,latencyMs:0};const ledger=[],scores=[];
      let stopped,activeTaskId;const controller=new AbortController();const interrupt=()=>{stopped='INTERRUPTED';controller.abort();};
      process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
      const timer=setTimeout(()=>{stopped='BATCH_TIMEOUT';controller.abort();},Math.max(0,deadline-Date.now()));
      const liveApproval=()=>{if(Date.now()>=deadline||controller.signal.aborted||bytesHash(readFileSync(approvalPath))!==approvalHash)throw new contract.StageError('AUTHORIZATION_CHANGED');};
      const provider=new ApiVisionProvider({provider:m.provider,model:m.model,inputCnyPerMillion:m.prices.inputCnyPerMillion,outputCnyPerMillion:m.prices.outputCnyPerMillion,
        grant:{destination:PROVIDER_ENDPOINTS[m.provider],model:m.model,expiresAt:approval.expiresAt,photoIds:approval.photoIds},
        // The only credential access in the CLI; unreachable in default offline mode.
        credential:()=>{liveApproval();return process.env.SGX_D4_API_KEY??'';},
        resolver:async photo=>{liveApproval();const item=m.photos.find(p=>p.photo.photoId===photo.photoId&&p.photo.sourceHash===photo.sourceHash);
          if(!item)throw new contract.StageError('CALL_NOT_AUTHORIZED');return {bytes:await readFile(path.resolve(batch.root,item.path)),mimeType:photo.mimeType};},
        record:entry=>appendFileSync(path.join(out,'provider-responses.jsonl'),JSON.stringify({taskId:activeTaskId,...entry})+'\n',{mode:0o600})});
      const engine=new ClassificationEngine(provider);const previousByScope=new Map();
      try{
        for(const task of m.tasks){
          activeTaskId=task.taskId;const remaining={maxRequests:m.caps.maxRequests-totals.requests,maxInputTokens:m.caps.maxInputTokens-totals.inputTokens,
            maxOutputTokens:m.caps.maxOutputTokens-totals.outputTokens,maxCostCny:Math.max(0,m.caps.maxCostCny-totals.costCny)};
          if(!stopped&&(Date.now()>=deadline||remaining.maxRequests<=0||remaining.maxInputTokens<=0||remaining.maxOutputTokens<=0||totals.costCny>m.caps.maxCostCny))stopped='BATCH_LIMIT';
          let result;
          if(!stopped){
            const r=structuredClone(task.request);r.budget={...r.budget,...remaining,deadlineAt:new Date(deadline).toISOString(),maxCallDurationMs:60000};
            const auth={scope:r.scope,authorizationRevision:r.authorizationRevision,active:true,allowPersonMatching:approval.allowPersonMatching,
              allowedPhotoIds:r.photos.filter(p=>p.active).map(p=>p.photoId),photoVersions:Object.fromEntries(r.photos.filter(p=>p.active).map(p=>[p.photoId,contract.photoHash(p)])),
              contextRevision:task.taskId,reviewContextHash:contract.digest([r.references,r.corrections])};
            result=await engine.process(r,()=>{try{liveApproval();return auth;}catch{return {...auth,active:false};}},controller.signal);
            for(const k of Object.keys(totals))totals[k]+=result.usage[k];
            await save(`result-${task.taskId}.json`,result);
            // Exploration keeps semantic unknowns; any engineering/provider error stops this batch, with the rest retained.
            if(result.errors.length)stopped=result.errors[0].code;
            if(result.usage.records.some(c=>c.returnedModel&&c.returnedModel!==m.model))stopped='MODEL_VERSION_MISMATCH';
          }
          const key=contract.digest(task.request.scope);const score=scoreTask(task,result,batch.truth,previousByScope.get(key));scores.push(score);
          if(!stopped&&(score.identities.wrongCandidate||score.personPairs.falseMerge||score.eventPairs.falseMerge||score.unchangedObservationChecks.some(c=>!c.pass)))stopped='SEMANTIC_REVIEW_REQUIRED';
          if(result?.snapshot)previousByScope.set(key,result);
          ledger.push({taskId:task.taskId,status:result?.workflowStatus??'not_run',reason:!result?stopped:undefined,usage:result?.usage??null});
          await save('ledger.json',{plannedTasks:m.tasks.length,completedEntries:ledger.length,stopped,totals,tasks:ledger});await save('metrics.json',scores);
        }
      }finally{clearTimeout(timer);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
      const resultDiagnostics=[],seenDiagnostics=new Set();
      for(const task of m.tasks){try{const saved=JSON.parse(await readFile(path.join(out,`result-${task.taskId}.json`),'utf8'));
        for(const error of saved.errors??[])for(const issue of error.diagnostic?.issues??[]){const key=JSON.stringify([task.taskId,error.code,error.diagnostic.phase,issue]);
          if(!seenDiagnostics.has(key)){seenDiagnostics.add(key);resultDiagnostics.push(`- ${task.taskId} / ${error.stage} / ${error.code}: \`${error.diagnostic.phase}\` at \`${issue.path}\` (${issue.code}${issue.keys?.length?`; keys=${issue.keys.join(',')}`:''})`);}}
      }catch{/* not-run tasks have no result file */}}
      const report=['# 自动分类真实 API 探索报告','',`批次：${m.batchId}；模型：${m.provider}/${m.model}；阶段：${m.partition}。`,
        `计划任务 ${m.tasks.length}，发起任务 ${ledger.filter(t=>t.usage).length}；停止原因：${stopped??'无工程错误'}。`,
        `请求 ${totals.requests}；图片发送次数（含重复参考）${totals.images}；输入 Token ${totals.inputTokens}；输出 Token ${totals.outputTokens}；记账费用 ¥${totals.costCny.toFixed(6)}；墙钟 ${(Date.now()-start)/1000}s。`,
        '', '费用按清单费率计算；失败无 usage 时保留预留值，供应商账单仍需核对。估计 Token 预留不是供应商硬限额，单次请求可能超出估计并触发停止。',
        '', '## 固定分母结果','', '|任务|状态|计划照片|未处理照片|人物错合并/漏同人|事件错合并/漏同次|', '|---|---|---:|---:|---:|---:|',
        ...scores.map(s=>`|${s.taskId}|${s.workflowStatus}|${s.plannedPhotos}|${s.failedPhotos.length}|${s.personPairs.evaluated?`${s.personPairs.falseMerge}/${s.personPairs.missedSame}`:'未评估'}|${s.eventPairs.evaluated?`${s.eventPairs.falseMerge}/${s.eventPairs.missedSame}`:'未评估'}|`),
        ...(resultDiagnostics.length?['','## 工程诊断','',...resultDiagnostics]:[]),
        '', '各任务启用的维度、身份候选、未知/冲突、候选召回和增量不变项详见 metrics.json；标记“未评估”的维度不计入通过或失败。每次请求和预留/实报区分见 ledger.json；原始响应见 provider-responses.jsonl。',
        '', '这是一轮探索结果，不自动等于家庭场景达标或产品可用。语义错误须逐例复核，确认阻断错误后不得继续下一批。'];
      await writeFile(path.join(out,'REPORT.md'),report.join('\n')+'\n',{mode:0o600});
      console.log(JSON.stringify({out:path.resolve(out),stopped,plannedTasks:m.tasks.length,totals}));if(stopped)process.exitCode=2;
    }
  }catch(error){
    // Preserve an actionable error code, never dump environment, headers or arbitrary upstream response text.
    const code=error instanceof contract.StageError?error.code:error.name==='ZodError'?'INVALID_MANIFEST_OR_APPROVAL':/^[A-Z_]+$/.test(error.message)?error.message:error.code??'PREFLIGHT_OR_RUN_ERROR';
    await save('blocked.json',{code,mode:execute?'execute_requested':'offline_preflight',externalExecutionAuthorized:executionAuthorized,externalCallsMayHaveOccurred:executionAuthorized});console.error(code);process.exitCode=2;
  }
}
