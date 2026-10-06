import { NextResponse } from 'next/server';

import { LabHttpError, requireClassificationT1Access } from '@/lib/algorithms/classification/lab-http';
import {
  ClassificationT1LabService,
  classificationT1LabConfig,
} from '@/lib/algorithms/classification/t1-lab-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { jobId: string; evidenceId: string } },
) {
  try {
    requireClassificationT1Access(request);
    if(process.env.CLASSIFICATION_T1_LAB_ENABLED !== 'true') throw new Error('T1_LAB_DISABLED');
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if(!sessionId) throw new Error('T1_SESSION_REQUIRED');
    const asset = await new ClassificationT1LabService(classificationT1LabConfig())
      .readAsset(sessionId, params.jobId, params.evidenceId);
    return new NextResponse(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch(error) {
    const raw = error instanceof Error ? error.message : 'T1_ASSET_INTERNAL_ERROR';
    const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(raw) ? raw : 'T1_ASSET_INTERNAL_ERROR';
    const status = error instanceof LabHttpError ? error.status
      : code.endsWith('_NOT_FOUND') ? 404
      : code.includes('REQUIRED') ? 400
        : code.includes('AUTHORIZED') || code.includes('SCOPE') ? 403
          : code.includes('DISABLED') ? 503
            : 500;
    return NextResponse.json({ ok: false, error: { code } }, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
