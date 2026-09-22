import { createServer, IncomingMessage } from 'node:http';
import { AuthorizationSnapshot, ClassificationEngine } from './stage-a-pipeline';
import { RequestSchema, STAGE_A_VERSION, StageError, digest, photoHash, sameScope } from './stage-a-contract';
/** Backend-owned authenticate callback is mandatory. This module does not implement accounts or trust body permissions. */
export function createStageHttpServer(options:{engine:ClassificationEngine;mode:'mock_transport'|'real_api'|'unconfigured';
  authorization:(req:IncomingMessage)=>AuthorizationSnapshot;maxRuns?:number;}) {
  const runs=new Map<string,{fingerprint:string;scope:AuthorizationSnapshot['scope'];controller:AbortController;pending?:Promise<unknown>}>();
  const server=createServer(async(req,res)=>{
    const send=(status:number,data:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const path=new URL(req.url??'/','http://localhost').pathname;
      if(req.method==='GET'&&path==='/healthz')return send(200,{ok:true,contractVersion:STAGE_A_VERSION,mode:options.mode,realModelValidated:false});
      const auth=()=>options.authorization(req);const initial=auth();if(!initial.active)throw new StageError('NOT_AUTHORIZED');
      if(req.method==='DELETE'&&path.startsWith('/v2/classification/runs/')){
        const id=path.slice('/v2/classification/runs/'.length);const run=runs.get(digest([initial.scope,id]));
        if(!run||!sameScope(run.scope,initial.scope))return send(404,{error:{code:'NOT_FOUND'}});
        run.controller.abort();return send(200,{runId:id,status:'cancel_requested'});
      }
      if(req.method!=='POST'||path!=='/v2/classification/run')return send(404,{error:{code:'NOT_FOUND'}});
      if(req.headers['content-type']?.split(';')[0]!=='application/json')return send(415,{error:{code:'UNSUPPORTED_MEDIA_TYPE'}});
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>2_000_000)throw new StageError('BODY_TOO_LARGE');chunks.push(chunk);}
      const body=RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const check=()=>{const a=auth();if(digest(a)!==digest(initial)||!sameScope(a.scope,body.scope)||a.authorizationRevision!==body.authorizationRevision||
        body.photos.some(p=>p.active&&(!a.allowedPhotoIds.includes(p.photoId)||a.photoVersions[p.photoId]!==photoHash(p))))throw new StageError('NOT_AUTHORIZED');};
      check();const runKey=digest([body.scope,body.runId]);const existing=runs.get(runKey);const fingerprint=digest(body);
      if(existing&&existing.fingerprint!==fingerprint)return send(409,{error:{code:'RUN_CONFLICT'}});
      if(existing?.controller.signal.aborted)return send(409,{error:{code:'RUN_CANCELLED'}});
      if(!existing&&runs.size>=(options.maxRuns??128))return send(429,{error:{code:'RUN_CAPACITY'}});
      const entry=existing??{fingerprint,scope:body.scope,controller:new AbortController()};runs.set(runKey,entry);
      entry.pending??=options.engine.process(body,auth,entry.controller.signal);
      let result:unknown;try{result=await entry.pending;}finally{entry.pending=undefined;}
      check();send(200,result);
    }catch(error){const code=error instanceof StageError?error.code:'INVALID_REQUEST';send(code==='NOT_AUTHORIZED'?403:code==='BODY_TOO_LARGE'?413:400,{error:{code}});}
  });
  server.headersTimeout=5000;server.requestTimeout=15000;server.keepAliveTimeout=1000;
  const shutdown=()=>new Promise<void>(resolve=>{for(const run of runs.values())run.controller.abort();server.close(()=>resolve());server.closeAllConnections();});
  return {server,shutdown};
}
