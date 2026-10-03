import { workerAsrJsonPost } from '@/lib/algorithms/classification/worker-control-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return workerAsrJsonPost(request, (control, body) => control.lease(body));
}
