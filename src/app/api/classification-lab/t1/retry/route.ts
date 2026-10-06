import { NextResponse } from 'next/server';
import { z } from 'zod';

import { LabHttpError, requireClassificationT1Access } from '@/lib/algorithms/classification/lab-http';
import {
  ClassificationT1LabService,
  classificationT1LabConfig,
} from '@/lib/algorithms/classification/t1-lab-service';
import { getClassificationWorkerControlPlane } from '@/lib/algorithms/classification/worker-control-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RetryRequestSchema = z.object({
  sessionId: z.string().min(1),
  jobId: z.string().min(1),
}).strict();

function errorResponse(error: unknown): NextResponse {
  const raw = error instanceof Error ? error.message : 'T1_LAB_INTERNAL_ERROR';
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(raw) ? raw : 'T1_LAB_INTERNAL_ERROR';
  const status = error instanceof LabHttpError ? error.status
    : code.endsWith('_NOT_FOUND') ? 404
    : code.includes('SCOPE') || code.includes('REVOKED') ? 403
      : code.includes('INVALID') || code.includes('REQUIRED') || code.includes('NOT_ALLOWED') ? 400
        : 500;
  return NextResponse.json({ ok: false, error: { code } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  try {
    requireClassificationT1Access(request, true);
    if(!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new Error('T1_JSON_REQUIRED');
    }
    const input = RetryRequestSchema.parse(await request.json());
    const lab = new ClassificationT1LabService(classificationT1LabConfig());
    const result = await lab.retry(input);
    const control = getClassificationWorkerControlPlane();
    return NextResponse.json({
      ok: true,
      capabilities: {
        ...lab.capabilities(),
        realCallBudget: control.realCallBudget
          ? { configured: true as const, ...(await control.realCallBudget.readStatus()) }
          : { configured: false as const },
      },
      result,
    }, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch(error) {
    if(error instanceof z.ZodError || error instanceof SyntaxError) {
      return errorResponse(new Error('T1_INPUT_INVALID'));
    }
    return errorResponse(error);
  }
}
