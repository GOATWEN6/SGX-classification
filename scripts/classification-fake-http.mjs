import { mkdtemp, readdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createFakeHttpServer } from '../harness/classification/fake-http-server.mjs';
import { syntheticState, syntheticEnvelope } from '../harness/classification/fixtures/http/synthetic.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const smoke = process.argv.includes('--smoke');
const example = process.argv.includes('--example');
const port = smoke ? 0 : Number(process.env.CLASSIFICATION_FAKE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_FAKE_PORT');
const build = await mkdtemp(path.join(tmpdir(), 'sgx-classification-http-'));
let server;
try {
  // Reuse installed dependencies for compiled CommonJS modules under tmp; no install/download.
  await symlink(path.join(root, 'node_modules'), path.join(build, 'node_modules'), 'dir');
  const source = 'src/lib/algorithms/classification';
  const files = (await readdir(path.join(root, source))).filter(f => f.endsWith('.ts')).map(f => `${source}/${f}`);
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--outDir', build, '--rootDir', '.', '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'es2022', '--lib', 'es2022,dom', '--esModuleInterop', '--resolveJsonModule', '--strict', '--skipLibCheck', '--noEmit', 'false', '--incremental', 'false', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('CLASSIFICATION_BUILD_FAILED');
  const require = createRequire(import.meta.url);
  const { prepareProviderRequest } = require(`${build}/${source}/guards.js`);
  const { FAKE_VERSIONS } = require(`${build}/${source}/fake.js`);
  const request = syntheticEnvelope(prepareProviderRequest, syntheticState(FAKE_VERSIONS), { deadlineAt: new Date(Date.now()+60000).toISOString() });
  if (example) console.log(JSON.stringify(request, null, 2));
  else {
    server = createFakeHttpServer({ buildDir: build, defaultScenario: process.env.CLASSIFICATION_FAKE_SCENARIO ?? 'success' });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    const url = `http://127.0.0.1:${server.address().port}`;
    if (smoke) {
      const health = await fetch(`${url}/healthz`); assert.equal(health.status,200);
      const r = await fetch(`${url}/v1/classify`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request) });
      assert.equal(r.status,200);assert.equal((await r.json()).resultStatus,'succeeded');
      await server.shutdown();server=undefined;
      await assert.rejects(fetch(`${url}/healthz`,{signal:AbortSignal.timeout(1000)}));
      console.log('SMOKE passed: start, healthz, POST, stop, closed port');
    } else {
      const requestPath = path.join(build,'example-request.json');
      await writeFile(requestPath,JSON.stringify(request,null,2));
      console.log(JSON.stringify({service:'sgx-classification-fake',url,exampleRequestPath:requestPath,exampleExpiresAt:request.deadlineAt}));
      await new Promise(resolve=>{
        const stop=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);resolve();};
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
      });
    }
  }
} finally {
  if(server) await server.shutdown();
  await rm(build,{recursive:true,force:true});
  if(smoke) { await assert.rejects(access(build)); console.log('SMOKE passed: temporary build removed'); }
}
