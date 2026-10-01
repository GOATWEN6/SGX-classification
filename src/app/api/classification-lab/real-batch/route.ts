import { NextResponse } from 'next/server';
import { requireLocalClassificationLab } from '@/lib/algorithms/classification/lab-http';
import {
  getAuthorizedRealBatchStatus,
  runAuthorizedRealBatch
} from '@/lib/algorithms/classification/lab-real-batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 1200;

function errorResponse(error: unknown): NextResponse {
  const value = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : error instanceof Error ? error.message : 'REAL_BATCH_INTERNAL_ERROR';
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : 'REAL_BATCH_INTERNAL_ERROR';
  const status = code.includes('NOT_CONFIGURED') || code.includes('DISABLED') ? 503
    : code.includes('EXPIRED') || code.includes('ALREADY_STARTED') ? 409
      : code.includes('FORBIDDEN') || code.includes('CHANGED') ? 403
        : 500;
  return NextResponse.json({ ok: false, error: { code } }, { status });
}

export async function GET(request: Request) {
  try {
    requireLocalClassificationLab(request);
    return NextResponse.json({ ok: true, status: await getAuthorizedRealBatchStatus() }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch(error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireLocalClassificationLab(request, true);
    const result = await runAuthorizedRealBatch();
    return NextResponse.json({
      ok: result.exitCode === 0,
      result: { exitCode: result.exitCode, signal: result.signal, batchId: result.pointer.batchId },
      status: await getAuthorizedRealBatchStatus()
    }, { status: result.exitCode === 0 ? 200 : 422, headers: { 'Cache-Control': 'no-store' } });
  } catch(error) { return errorResponse(error); }
}

