import { workerJsonPost } from '@/lib/algorithms/classification/worker-control-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { jobId: string } }) {
  return workerJsonPost(request, (control, body) => control.executionContext(params.jobId, body));
}

