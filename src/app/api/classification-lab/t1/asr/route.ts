import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { requireLocalClassificationLab } from '@/lib/algorithms/classification/lab-http';
import {
  ClassificationT1AsrService,
} from '@/lib/algorithms/classification/t1-asr-prejob';
import { WorkerControlPlaneError } from '@/lib/algorithms/classification/worker-control-plane';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function service(): ClassificationT1AsrService {
  if(process.env.CLASSIFICATION_T1_LAB_ENABLED !== 'true'
    || process.env.CLASSIFICATION_T1_ASR_ENABLED !== 'true') {
    throw new WorkerControlPlaneError('T1_ASR_DISABLED', 503);
  }
  const dataRoot = process.env.CLASSIFICATION_LAB_DATA_DIR;
  const publicBaseUrl = process.env.CLASSIFICATION_WORKER_PUBLIC_BASE_URL
    ?? `http://127.0.0.1:${process.env.PORT ?? '3137'}`;
  return new ClassificationT1AsrService({ ...(dataRoot ? { dataRoot } : {}), publicBaseUrl });
}

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkerControlPlaneError ? error.status
    : error instanceof ZodError || error instanceof SyntaxError ? 400
      : 500;
  const code = error instanceof WorkerControlPlaneError ? error.code
    : error instanceof ZodError ? 'T1_ASR_INPUT_INVALID'
      : error instanceof SyntaxError ? 'T1_ASR_METADATA_INVALID'
        : 'T1_ASR_INTERNAL_ERROR';
  return NextResponse.json({ ok: false, error: { code } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  try {
    requireLocalClassificationLab(request);
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const jobId = url.searchParams.get('jobId');
    if(!sessionId || !jobId) throw new WorkerControlPlaneError('T1_ASR_JOB_QUERY_REQUIRED');
    return NextResponse.json({ ok: true, job: await service().get(sessionId, jobId) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch(error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireLocalClassificationLab(request, true);
    if(!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
      throw new WorkerControlPlaneError('T1_ASR_MULTIPART_REQUIRED', 415);
    }
    const form = await request.formData();
    const metadataValue = form.get('metadata');
    const audioValue = form.get('audio');
    if(typeof metadataValue !== 'string') throw new WorkerControlPlaneError('T1_ASR_METADATA_REQUIRED');
    if(!(audioValue instanceof File)) throw new WorkerControlPlaneError('T1_ASR_AUDIO_REQUIRED');
    const metadata = JSON.parse(metadataValue) as {
      sessionId?: string;
      scope: { householdId: string; subjectId: string };
      actorId: string;
    };
    const result = await service().submit({
      ...metadata,
      filename: audioValue.name,
      mimeType: audioValue.type,
      bytes: Buffer.from(await audioValue.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, result }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch(error) { return errorResponse(error); }
}
