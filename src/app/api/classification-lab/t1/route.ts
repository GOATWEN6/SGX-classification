import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { LabHttpError, requireClassificationT1Access } from '@/lib/algorithms/classification/lab-http';
import type { LabImageUpload, LabSubmission } from '@/lib/algorithms/classification/lab-contract';
import {
  ClassificationT1LabService,
  classificationT1LabConfig,
} from '@/lib/algorithms/classification/t1-lab-service';
import { getClassificationWorkerControlPlane } from '@/lib/algorithms/classification/worker-control-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function service(): ClassificationT1LabService {
  if(process.env.CLASSIFICATION_T1_LAB_ENABLED !== 'true') throw new Error('T1_LAB_DISABLED');
  return new ClassificationT1LabService(classificationT1LabConfig());
}
async function capabilities(lab: ClassificationT1LabService) {
  const control = getClassificationWorkerControlPlane();
  return {
    ...lab.capabilities(),
    realCallBudget: control.realCallBudget
      ? { configured: true as const, ...(await control.realCallBudget.readStatus()) }
      : { configured: false as const },
  };
}
function errorResponse(error: unknown): NextResponse {
  const raw = error instanceof Error ? error.message : 'T1_LAB_INTERNAL_ERROR';
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(raw) ? raw : 'T1_LAB_INTERNAL_ERROR';
  const status = error instanceof LabHttpError ? error.status
    : code.endsWith('_NOT_FOUND') ? 404
    : code.includes('DISABLED') ? 503
      : code.includes('SCOPE') || code.includes('REVOKED') ? 403
        : code.includes('INVALID') || code.includes('REQUIRED') || code.includes('LIMIT')
          || code.includes('EMPTY') || code.includes('UNSUPPORTED') || code.includes('TOO_MANY') ? 400
          : 500;
  return NextResponse.json({ ok: false, error: { code } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  try {
    requireClassificationT1Access(request);
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    if(!sessionId) {
      const lab = service();
      return NextResponse.json({ ok: true, capabilities: await capabilities(lab) }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const jobId = url.searchParams.get('jobId');
    const lab = service();
    const result = jobId
      ? { job: await lab.get(sessionId, jobId) }
      : { jobs: await lab.list(sessionId) };
    return NextResponse.json({ ok: true, capabilities: await capabilities(lab), ...result }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch(error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireClassificationT1Access(request, true);
    if(!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
      throw new Error('T1_MULTIPART_REQUIRED');
    }
    const form = await request.formData();
    const metadataValue = form.get('metadata');
    if(typeof metadataValue !== 'string') throw new Error('T1_METADATA_REQUIRED');
    let metadata: Omit<LabSubmission, 'images'> & {
      sessionId?: string;
      personMatchingAuthorized?: boolean;
    };
    try { metadata = JSON.parse(metadataValue); }
    catch { throw new Error('T1_METADATA_INVALID'); }
    const images: LabImageUpload[] = [];
    for(const value of form.getAll('images')) {
      if(!(value instanceof File)) throw new Error('T1_IMAGE_REQUIRED');
      images.push({
        filename: value.name,
        mimeType: value.type as LabImageUpload['mimeType'],
        bytes: Buffer.from(await value.arrayBuffer()),
      });
    }
    const { sessionId, personMatchingAuthorized = false, ...submission } = metadata;
    const lab = service();
    const result = await lab.submit({
      ...(sessionId ? { sessionId } : {}),
      submission: { ...submission, images },
      personMatchingAuthorized: personMatchingAuthorized === true,
    });
    return NextResponse.json({ ok: true, capabilities: await capabilities(lab), result }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch(error) {
    if(error instanceof ZodError) return errorResponse(new Error('T1_INPUT_INVALID'));
    return errorResponse(error);
  }
}
