import {setup,photo,observation,createStageHttpServer} from './fixtures/stage-a.mjs';
import assert from 'node:assert/strict';
const photos=[photo('photo_1','2008 奶奶生日'),photo('photo_2','2008 奶奶同一次生日')];
const s=setup(photos,Object.fromEntries(photos.map(p=>[p.photoId,observation(p,{time:'2008',event:'生日',face:true})])),{eventDecision:()=> 'same',personDecision:()=> 'same'});
s.req.budget.deadlineAt=new Date(Date.now()+3600000).toISOString();
const {server,shutdown}=createStageHttpServer({engine:s.engine,mode:'mock_transport',authorization:s.getAuth});
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(process.argv.includes('--smoke')?0:Number(process.env.CLASSIFICATION_STAGE_A_PORT??8788),'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  if(process.argv.includes('--smoke')){
    assert.equal((await fetch(`${url}/healthz`)).status,200);
    const r=await fetch(`${url}/v2/classification/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(s.req)});assert.equal(r.status,200);
    const result=await r.json();assert.equal(result.usage.requests,3);assert.equal(result.evidenceStatus,'mock_transport');
    console.log(JSON.stringify({status:'passed',check:'HTTP -> engine -> mocked API transport -> classification and association',usage:result.usage,eventGroups:result.snapshot.groups.filter(g=>g.kind==='event')},null,2));
  }else{
    console.log(JSON.stringify({url,contractVersion:s.req.contractVersion,mode:'mock_transport',request:s.req},null,2));
    await new Promise(resolve=>{const stop=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);resolve();};process.once('SIGINT',stop);process.once('SIGTERM',stop);});
  }
}finally{await shutdown();}
