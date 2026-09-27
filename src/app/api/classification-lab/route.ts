import { NextResponse } from 'next/server';
import { LabHttpError, requireLocalClassificationLab } from '@/lib/algorithms/classification/lab-http';
import { FileClassificationLabStore } from '@/lib/algorithms/classification/lab-store';
import { classificationLabCapabilities, submitClassificationLabJob } from '@/lib/algorithms/classification/lab-service';
import type { LabImageUpload, LabSubmission } from '@/lib/algorithms/classification/lab-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function responseError(error: unknown): NextResponse {
  if(error instanceof LabHttpError) return NextResponse.json({ ok: false, error: { code: error.code } }, { status: error.status });
  const value = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : 'LAB_INTERNAL_ERROR';
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : 'LAB_INTERNAL_ERROR';
  const status = code === 'LAB_JOB_NOT_FOUND' ? 404 : code.includes('LIMIT') || code.includes('INVALID') || code.includes('EMPTY') || code.includes('UNSUPPORTED') ? 400 : 500;
  return NextResponse.json({ ok: false, error: { code } }, { status });
}

export async function GET(request: Request) {
  try {
    requireLocalClassificationLab(request);
    const store = new FileClassificationLabStore();
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');
    if(jobId) {
      const job = await store.get(jobId);
      if(!job) return NextResponse.json({ ok: false, error: { code: 'LAB_JOB_NOT_FOUND' } }, { status: 404 });
      return NextResponse.json({ ok: true, capabilities: classificationLabCapabilities(), job }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const jobs = await store.list(20);
    return NextResponse.json({ ok: true, capabilities: classificationLabCapabilities(), jobs }, { headers: { 'Cache-Control': 'no-store' } });
  } catch(error) { return responseError(error); }
}

export async function POST(request: Request) {
  try {
    requireLocalClassificationLab(request, true);
    const contentType = request.headers.get('content-type') ?? '';
    if(!contentType.toLocaleLowerCase().startsWith('multipart/form-data')) throw new LabHttpError('MULTIPART_REQUIRED', 415);
    const form = await request.formData();
    const metadataValue = form.get('metadata');
    if(typeof metadataValue !== 'string') throw new LabHttpError('LAB_METADATA_REQUIRED', 400);
    let metadata: Omit<LabSubmission, 'images'>;
    try { metadata = JSON.parse(metadataValue) as Omit<LabSubmission, 'images'>; }
    catch { throw new LabHttpError('LAB_METADATA_INVALID_JSON', 400); }
    const images: LabImageUpload[] = [];
    for(const value of form.getAll('images')) {
      if(!(value instanceof File)) throw new LabHttpError('LAB_IMAGE_FILE_REQUIRED', 400);
      images.push({ filename: value.name, mimeType: value.type as LabImageUpload['mimeType'], bytes: Buffer.from(await value.arrayBuffer()) });
    }
    const job = await submitClassificationLabJob({ ...metadata, images });
    return NextResponse.json({ ok: true, capabilities: classificationLabCapabilities(), job }, { status: job.status === 'failed' ? 422 : 201, headers: { 'Cache-Control': 'no-store' } });
  } catch(error) { return responseError(error); }
}
