import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
function argument(name) {
  const index = process.argv.indexOf(name);
  if(index < 0 || !process.argv[index + 1]) throw new Error('REPLAY_ARGUMENT_REQUIRED');
  return process.argv[index + 1];
}
const build = path.resolve(argument('--build-dir'));
const audit = path.resolve(argument('--audit'));
const { ApiVisionProvider } = require(path.join(build, 'src/lib/algorithms/classification/stage-a-provider.js'));
const { STAGE_A_VALIDATION_VERSION, BoxSchema, ExtractSchema } = require(path.join(build, 'src/lib/algorithms/classification/stage-a-contract.js'));
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(audit);
const rows = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const results = [];

for(const [index, entry] of rows.entries()) {
  const raw = entry.raw;
  const value = JSON.parse(raw.choices[0].message.content);
  if(!Array.isArray(value.observations)) {
    results.push({ line: index + 1, stage: 'relate', finishReason: raw.choices[0].finish_reason });
    continue;
  }
  const before = ExtractSchema.safeParse(value);
  const photos = value.observations.map(observation => ({
    photoId: observation.photoId,
    caption: '',
    mimeType: 'image/png',
    sourceHash: `sha256:${sha(png)}`,
  }));
  const provider = new ApiVisionProvider({
    provider: 'qwen',
    model: raw.model,
    mode: 'mock_transport',
    resolver: async () => ({ bytes: png, mimeType: 'image/png' }),
    transport: async () => new Response(JSON.stringify(raw), { status: 200 }),
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
  });
  let reply;
  let errorCode;
  try {
    reply = await provider.invoke({ stage: 'extract', photos, context: {} }, new AbortController().signal);
  } catch(error) {
    errorCode = error.code ?? 'INVALID_OUTPUT';
  }
  results.push({
    line: index + 1,
    stage: 'extract',
    finishReason: raw.choices[0].finish_reason,
    originalSchemaValid: before.success,
    originalIssues: before.success ? [] : before.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    replaySucceeded: Boolean(reply),
    ...(errorCode ? { errorCode } : {}),
    observations: value.observations.map((observation, observationIndex) => ({
      photoId: observation.photoId,
      originalPersonCount: observation.people?.length ?? 0,
      invalidRegionCount: observation.people?.filter(person => !BoxSchema.safeParse(person.box).success).length ?? 0,
      replayPersonCount: reply?.value.observations[observationIndex]?.people?.length ?? 0,
      replayFacetCounts: reply ? Object.fromEntries(['times', 'places', 'events', 'scenes'].map(facet => [facet, reply.value.observations[observationIndex][facet].length])) : {},
      ocrSupports: ['times', 'places', 'events', 'scenes'].flatMap(facet => (observation[facet] ?? []).flatMap(item =>
        item.supports.filter(support => support.source === 'ocr').map(support => ({
          facet,
          quoteLength: support.quote.length,
          quoteSha256: sha(support.quote),
          normalizedQuoteSha256: sha(support.quote.normalize('NFKC').replace(/\s+/gu, '')),
        })))),
    })),
  });
}
console.log(JSON.stringify({
  version: 'classification-provider-response-replay.1',
  validationVersion: STAGE_A_VALIDATION_VERSION,
  auditSha256: sha(bytes),
  responseCount: rows.length,
  actualProviderCalls: 0,
  results,
}, null, 2));
