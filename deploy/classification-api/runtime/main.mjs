#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createDirectService } from './service.mjs';

const env = process.env;
if ((await stat(env.SGX_API_TOKEN_FILE)).mode & 0o077) throw new Error('API_TOKEN_PERMISSIONS_INVALID');
const token = (await readFile(env.SGX_API_TOKEN_FILE, 'utf8')).trim();
const service = await createDirectService({
  buildDir: env.SGX_CLASSIFICATION_BUILD_DIR, dataRoot: env.SGX_API_DATA_ROOT,
  budgetDataRoot: env.SGX_API_BUDGET_DATA_ROOT,
  authorizationPath: env.CLASSIFICATION_REAL_CALL_AUTHORIZATION_PATH || undefined,
  token, gitCommit: env.SGX_GIT_COMMIT,
  model: env.SGX_VLM_MODEL, featureEndpoint: env.SGX_FEATURE_ENDPOINT ?? 'http://127.0.0.1:8766',
});
await new Promise((resolve, reject) => {
  service.server.once('error', reject);
  service.server.listen(8765, '127.0.0.1', resolve);
});
console.log(JSON.stringify({ event: 'direct_api_listening', port: 8765, gitCommit: env.SGX_GIT_COMMIT }));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // Let the active attempt settle. A forced platform exit is recovered on the next start.
    void service.close().then(() => process.exit(0));
  });
}
