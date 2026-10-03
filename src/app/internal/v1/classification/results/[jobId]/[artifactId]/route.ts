import { NextResponse } from 'next/server';
import { WorkerControlPlaneError } from '@/lib/algorithms/classification/worker-control-plane';
import {
  getClassificationWorkerControlPlane,
  workerControlErrorResponse,
} from '@/lib/algorithms/classification/worker-control-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  { params }: { params: { jobId: string; artifactId: string } },
) {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if(!token) throw new WorkerControlPlaneError('RESULT_UPLOAD_TOKEN_REQUIRED', 401);
    const control = getClassificationWorkerControlPlane();
    const declaredLength = Number(request.headers.get('content-length'));
    if(Number.isFinite(declaredLength) && declaredLength > control.resultMaxByteLength) {
      throw new WorkerControlPlaneError('RESULT_UPLOAD_SIZE_INVALID', 413);
    }
    const mimeType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const uploaded = await control.uploadResult({
      jobId: params.jobId,
      artifactId: params.artifactId,
      uploadToken: token,
      bytes: Buffer.from(await request.arrayBuffer()),
      mimeType,
    });
    return NextResponse.json(
      { ok: true, artifactId: params.artifactId, ...uploaded },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch(error) {
    return workerControlErrorResponse(error);
  }
}

