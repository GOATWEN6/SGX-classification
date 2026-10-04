import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const build = process.env.CLASSIFICATION_BUILD_DIR;
if(!build) throw new Error('CLASSIFICATION_BUILD_DIR_REQUIRED');
const { createMonoPcm16Wav } = await import(path.join(build, 'src/lib/algorithms/classification/browser-wav.js'));

test('browser microphone encoder produces the frozen mono PCM WAV envelope', () => {
  const wav = createMonoPcm16Wav([new Float32Array([0, 0.5, -0.5, 1, -1])], 16_000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
});

test('T1 page exposes direct microphone ASR and a persisted smart album view', async () => {
  const page = await readFile(path.join(root, 'src/app/classification-lab/t1/page.tsx'), 'utf8');
  const album = await readFile(path.join(root, 'src/app/classification-lab/t1/album/page.tsx'), 'utf8');
  assert.match(page, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(page, /结束并识别/);
  assert.match(page, /await transcribe\(recorded\)/);
  assert.match(page, /href="\/classification-lab\/t1\/album"/);
  assert.match(album, /\/api\/classification-lab\/t1\?sessionId=/);
  assert.match(album, /\/api\/classification-lab\/t1\/assets\//);
  assert.match(album, /用户原文/);
  assert.match(album, /语音转写/);
});
