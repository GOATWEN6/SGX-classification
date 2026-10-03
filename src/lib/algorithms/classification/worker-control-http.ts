import { NextResponse } from 'next/server';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';

import {
  ClassificationWorkerControlPlane,
  WorkerControlPlaneError,
  verifyWorkerBearer,
} from './worker-control-plane';
import {
  FileRealCallBudgetGate,
  loadRealCallAuthorizationSync,
} from './real-call-budget';
import { ClassificationT1AsrService } from './t1-asr-prejob';

type WorkerOperation = (control: ClassificationWorkerControlPlane, body: unknown) => Promise<unknown>;
type AsrWorkerOperation = (control: ClassificationT1AsrService, body: unknown) => Promise<unknown>;

let cached: { signature: string; control: ClassificationWorkerControlPlane } | undefined;
let asrCached: { signature: string; control: ClassificationT1AsrService } | undefined;

function noStore(headers: HeadersInit = {}): HeadersInit {
  return { ...headers, 'Cache-Control': 'no-store' };
}

function requireEnabled(): void {
  if(process.env.CLASSIFICATION_WORKER_CONTROL_ENABLED !== 'true') {
    throw new WorkerControlPlaneError('CONTROL_PLANE_DISABLED', 503);
  }
}

export function getClassificationWorkerControlPlane(): ClassificationWorkerControlPlane {
  requireEnabled();
  const dataRoot = process.env.CLASSIFICATION_LAB_DATA_DIR ?? '';
  const resolvedDataRoot = path.resolve(dataRoot || path.join(tmpdir(), 'sgx-classification-lab'));
  const publicBaseUrl = process.env.CLASSIFICATION_WORKER_PUBLIC_BASE_URL
    ?? `http://127.0.0.1:${process.env.PORT ?? '3137'}`;
  const authorizationPath = process.env.CLASSIFICATION_REAL_CALL_AUTHORIZATION_PATH ?? '';
  const authorization = authorizationPath ? loadRealCallAuthorizationSync(authorizationPath) : undefined;
  const signature = JSON.stringify({ dataRoot: resolvedDataRoot, publicBaseUrl, authorization });
  if(cached?.signature === signature) return cached.control;
  const control = new ClassificationWorkerControlPlane({
    dataRoot: resolvedDataRoot,
    publicBaseUrl,
    ...(authorization ? {
      realCallBudget: new FileRealCallBudgetGate({ dataRoot: resolvedDataRoot, authorization }),
    } : {}),
  });
  cached = { signature, control };
  return control;
}

export function getClassificationT1AsrService(): ClassificationT1AsrService {
  requireEnabled();
  const dataRoot = process.env.CLASSIFICATION_LAB_DATA_DIR ?? '';
  const publicBaseUrl = process.env.CLASSIFICATION_WORKER_PUBLIC_BASE_URL
    ?? `http://127.0.0.1:${process.env.PORT ?? '3137'}`;
  const signature = JSON.stringify({ dataRoot, publicBaseUrl });
  if(asrCached?.signature === signature) return asrCached.control;
  const control = new ClassificationT1AsrService({
    ...(dataRoot ? { dataRoot } : {}),
    publicBaseUrl,
  });
  asrCached = { signature, control };
  return control;
}

export function requireWorkerService(request: Request): ClassificationWorkerControlPlane {
  const control = getClassificationWorkerControlPlane();
  verifyWorkerBearer(
    request.headers.get('authorization'),
    process.env.CLASSIFICATION_WORKER_CONTROL_TOKEN ?? '',
  );
  return control;
}

export function requireAsrWorkerService(request: Request): ClassificationT1AsrService {
  const control = getClassificationT1AsrService();
  verifyWorkerBearer(
    request.headers.get('authorization'),
    process.env.CLASSIFICATION_WORKER_CONTROL_TOKEN ?? '',
  );
  return control;
}

export function workerControlErrorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkerControlPlaneError ? error.status
    : error instanceof ZodError || error instanceof SyntaxError ? 400
      : 500;
  const code = error instanceof WorkerControlPlaneError ? error.code
    : error instanceof ZodError ? 'CONTROL_PLANE_REQUEST_INVALID'
      : error instanceof SyntaxError ? 'CONTROL_PLANE_JSON_INVALID'
        : 'CONTROL_PLANE_INTERNAL_ERROR';
  return NextResponse.json(
    { ok: false, error: { code } },
    {
      status,
      headers: noStore(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
    },
  );
}

export async function workerJsonPost(request: Request, operation: WorkerOperation): Promise<NextResponse> {
  try {
    const control = requireWorkerService(request);
    const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if(contentType !== 'application/json') throw new WorkerControlPlaneError('CONTROL_PLANE_JSON_REQUIRED', 415);
    const body = await request.json();
    const result = await operation(control, body);
    return NextResponse.json(result, { headers: noStore() });
  } catch(error) {
    return workerControlErrorResponse(error);
  }
}

export async function workerAsrJsonPost(request: Request, operation: AsrWorkerOperation): Promise<NextResponse> {
  try {
    const control = requireAsrWorkerService(request);
    const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if(contentType !== 'application/json') throw new WorkerControlPlaneError('CONTROL_PLANE_JSON_REQUIRED', 415);
    const body = await request.json();
    const result = await operation(control, body);
    return NextResponse.json(result, { headers: noStore() });
  } catch(error) {
    return workerControlErrorResponse(error);
  }
}
