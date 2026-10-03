import { NextResponse } from 'next/server';

import {
  getClassificationT1AsrService,
  workerControlErrorResponse,
} from '@/lib/algorithms/classification/worker-control-http';
import { WorkerControlPlaneError } from '@/lib/algorithms/classification/worker-control-plane';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { jobId: string } }) {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if(!token) throw new WorkerControlPlaneError('ASR_ARTIFACT_TOKEN_REQUIRED', 401);
    const artifact = await getClassificationT1AsrService().readAudio(params.jobId, token);
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
  } catch(error) { return workerControlErrorResponse(error); }
}
