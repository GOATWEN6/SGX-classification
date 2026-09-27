import { TextDecoder } from 'node:util';

export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export class MediaInspectionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new MediaInspectionError(code); }
function uint24le(bytes: Buffer, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if(bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if(bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while(offset + 8 < bytes.length) {
    if(bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if(marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if(length < 2 || offset + 2 + length > bytes.length) return undefined;
    if(startOfFrame.has(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if(bytes.length < 30 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return undefined;
  const kind = bytes.subarray(12, 16).toString('ascii');
  if(kind === 'VP8X') return { width: uint24le(bytes, 24) + 1, height: uint24le(bytes, 27) + 1 };
  if(kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if(kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21]; const b2 = bytes[22]; const b3 = bytes[23]; const b4 = bytes[24];
    return { width: 1 + b1 + ((b2 & 0x3f) << 8), height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10) };
  }
  return undefined;
}

export function inspectImagePayload(bytes: Buffer, mimeType: SupportedImageMime): { width: number; height: number } {
  const dimensions = mimeType === 'image/png' ? pngDimensions(bytes) : mimeType === 'image/jpeg' ? jpegDimensions(bytes) : webpDimensions(bytes);
  if(!dimensions || dimensions.width <= 0 || dimensions.height <= 0) fail('MIME_SIGNATURE_OR_DIMENSIONS_MISMATCH');
  return dimensions;
}

export function decodeUtf8Payload(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('INVALID_UTF8_TEXT'); }
}
