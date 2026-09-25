import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));const build=await mkdtemp(path.join(tmpdir(),'sgx-stage-a-'));
let child;
function run(args,env=process.env,forwardExit=false){return new Promise((resolve,reject)=>{child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',env});child.once('error',reject);child.once('exit',(code,signal)=>{
  if(code===0||signal==='SIGINT'||signal==='SIGTERM')resolve();else if(forwardExit){process.exitCode=code??2;resolve();}else reject(new Error(`STAGE_A_EXIT_${code}`));
});});}
const forward=signal=>child?.kill(signal);const int=()=>forward('SIGINT'),term=()=>forward('SIGTERM');process.on('SIGINT',int);process.on('SIGTERM',term);
try{
  const source='src/lib/algorithms/classification';const files=(await readdir(path.join(root,source))).filter(f=>f.endsWith('.ts')).map(f=>`${source}/${f}`);
  await run(['node_modules/typescript/bin/tsc','--outDir',build,'--rootDir','.','--module','commonjs','--moduleResolution','node','--target','es2022','--lib','es2022,dom','--esModuleInterop','--resolveJsonModule','--strict','--skipLibCheck','--noEmit','false','--incremental','false',...files]);
  const evalMode=process.argv.includes('--eval');
  await run([evalMode?'harness/classification/stage-a-eval.mjs':'harness/classification/stage-a-demo.mjs',...process.argv.slice(2).filter(a=>a!=='--eval')],{...process.env,CLASSIFICATION_BUILD_DIR:build,NODE_PATH:path.join(root,'node_modules')},evalMode);
}finally{process.removeListener('SIGINT',int);process.removeListener('SIGTERM',term);await rm(build,{recursive:true,force:true});}
