function mergeChunks(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for(const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleMono(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if(sourceRate === targetRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for(let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for(let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

/**
 * Creates the uncompressed WAV accepted by the T1 SenseVoice pre-job.
 * Browser capture stays local until the user stops recording, then the
 * resulting file follows the same authorization and persistence path as a
 * selected WAV file.
 */
export function createMonoPcm16Wav(
  chunks: Float32Array[],
  sourceRate: number,
  targetRate = 16_000,
): Uint8Array {
  if(!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error('INVALID_SAMPLE_RATE');
  }
  const merged = mergeChunks(chunks);
  if(!merged.length) throw new Error('EMPTY_AUDIO');
  const samples = resampleMono(merged, sourceRate, targetRate);
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for(let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}
