import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LabHttpError, requireLocalClassificationLab } from '@/lib/algorithms/classification/lab-http';
import type { LabImageUpload, LabSubmission } from '@/lib/algorithms/classification/lab-contract';
import {
  REAL_SMOKE_MAX_IMAGE_BYTES,
  getRealSmokeStatus,
  realSmokeConfigFromEnv,
  runRealSmoke
} from '@/lib/algorithms/classification/lab-real-smoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function responseError(error: unknown): NextResponse {
  if(error instanceof LabHttpError) {
    return NextResponse.json({ ok: false, error: { code: error.code } }, { status: error.status });
  }
  const value = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : error instanceof Error ? error.message : 'REAL_SMOKE_INTERNAL_ERROR';
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : 'REAL_SMOKE_INTERNAL_ERROR';
  const status = code.includes('LIMIT') || code.includes('EXPIRED') ? 429
    : code.includes('DISABLED') || code.includes('NOT_CONFIGURED') ? 503
      : code.includes('INVALID') || code.includes('REQUIRED') || code.includes('TOO_LARGE') ? 400
        : 502;
  return NextResponse.json({ ok: false, error: { code } }, { status });
}

export async function GET(request: Request) {
  try {
    requireLocalClassificationLab(request);
    const config = realSmokeConfigFromEnv();
    return NextResponse.json({
      ok: true,
      status: await getRealSmokeStatus(config),
      limits: { maxImagesPerRun: 1, maxImageBytes: REAL_SMOKE_MAX_IMAGE_BYTES, automaticRetries: 0, personMatching: false }
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch(error) { return responseError(error); }
}

export async function POST(request: Request) {
  try {
    requireLocalClassificationLab(request, true);
    if(!(request.headers.get('content-type') ?? '').toLocaleLowerCase().startsWith('multipart/form-data')) {
      throw new LabHttpError('MULTIPART_REQUIRED', 415);
    }
    const form = await request.formData();
    const metadataValue = form.get('metadata');
    if(typeof metadataValue !== 'string') throw new LabHttpError('LAB_METADATA_REQUIRED', 400);
    let metadata: Omit<LabSubmission, 'images'>;
    try { metadata = JSON.parse(metadataValue) as Omit<LabSubmission, 'images'>; }
    catch { throw new LabHttpError('LAB_METADATA_INVALID_JSON', 400); }
    const imageValues = form.getAll('images');
    if(imageValues.length !== 1 || !(imageValues[0] instanceof File)) {
      throw new LabHttpError('REAL_SMOKE_ONE_IMAGE_REQUIRED', 400);
    }
    const file = imageValues[0];
    const image: LabImageUpload = {
      filename: file.name,
      mimeType: file.type as LabImageUpload['mimeType'],
      bytes: Buffer.from(await file.arrayBuffer())
    };
    const config = realSmokeConfigFromEnv();
    const apiKey = process.env.SGX_D4_API_KEY;
    if(!apiKey) throw new LabHttpError('MODEL_NOT_CONFIGURED', 503);
    const result = await runRealSmoke({ ...metadata, images: [image] }, config, {
      credential: () => apiKey
    });
    return NextResponse.json({ ok: true, result, status: await getRealSmokeStatus(config) }, {
      status: result.workflowStatus === 'needs_review' ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch(error) {
    if(error instanceof ZodError) return responseError(new LabHttpError('REAL_SMOKE_INVALID_INPUT', 400));
    return responseError(error);
  }
}
