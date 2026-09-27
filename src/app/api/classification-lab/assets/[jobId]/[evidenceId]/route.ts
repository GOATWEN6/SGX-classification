import { NextResponse } from 'next/server';
import { LabHttpError, requireLocalClassificationLab } from '@/lib/algorithms/classification/lab-http';
import { FileClassificationLabStore } from '@/lib/algorithms/classification/lab-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { jobId: string; evidenceId: string } }) {
  try {
    requireLocalClassificationLab(request);
    const asset = await new FileClassificationLabStore().readAsset(params.jobId, params.evidenceId);
    if(asset.ref.mimeType === 'text/plain') throw new LabHttpError('LAB_TEXT_ASSET_NOT_PUBLIC', 404);
    return new NextResponse(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        'Content-Type': asset.ref.mimeType,
        'Content-Length': String(asset.bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox"
      }
    });
  } catch(error) {
    const status = error instanceof LabHttpError ? error.status : error instanceof Error && error.message === 'LAB_JOB_NOT_FOUND' ? 404 : 404;
    const code = error instanceof LabHttpError ? error.code : error instanceof Error && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message) ? error.message : 'LAB_ASSET_NOT_FOUND';
    return NextResponse.json({ ok: false, error: { code } }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
