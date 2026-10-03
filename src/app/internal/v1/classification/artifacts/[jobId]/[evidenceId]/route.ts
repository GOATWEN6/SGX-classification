import { NextResponse } from 'next/server';
import { WorkerControlPlaneError } from '@/lib/algorithms/classification/worker-control-plane';
import {
  getClassificationWorkerControlPlane,
  workerControlErrorResponse,
} from '@/lib/algorithms/classification/worker-control-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { jobId: string; evidenceId: string } },
) {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if(!token) throw new WorkerControlPlaneError('ARTIFACT_TOKEN_REQUIRED', 401);
    const artifact = await getClassificationWorkerControlPlane().readArtifact(
      params.jobId,
      params.evidenceId,
      token,
    );
    return new NextResponse(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        'Content-Type': artifact.mimeType,
        'Content-Length': String(artifact.bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch(error) {
    return workerControlErrorResponse(error);
  }
}

