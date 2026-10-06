import { timingSafeEqual } from 'node:crypto';

export class LabHttpError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLocaleLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1';
}

export function requireLocalClassificationLab(request: Request, mutation = false): void {
  if(process.env.CLASSIFICATION_LAB_ENABLED !== 'true') throw new LabHttpError('CLASSIFICATION_LAB_DISABLED', 404);
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); } catch { throw new LabHttpError('INVALID_REQUEST_URL', 400); }
  if(!isLoopback(requestUrl.hostname)) throw new LabHttpError('CLASSIFICATION_LAB_LOOPBACK_ONLY', 403);
  const origin = request.headers.get('origin');
  if(origin) {
    try { if(!isLoopback(new URL(origin).hostname)) throw new LabHttpError('CLASSIFICATION_LAB_ORIGIN_REJECTED', 403); }
    catch(error) { if(error instanceof LabHttpError) throw error; throw new LabHttpError('CLASSIFICATION_LAB_ORIGIN_REJECTED', 403); }
  }
  if(mutation && request.headers.get('x-sgx-classification-lab') !== '1') throw new LabHttpError('CLASSIFICATION_LAB_HEADER_REQUIRED', 403);
}

/**
 * T1 staging access boundary. Loopback keeps the local browser workflow. A
 * non-loopback request is server-to-server only and requires a separate bearer
 * token; it never reuses the model credential or Worker credential.
 */
export function requireClassificationT1Access(request: Request, mutation = false): void {
  if(process.env.CLASSIFICATION_LAB_ENABLED !== 'true') throw new LabHttpError('CLASSIFICATION_LAB_DISABLED', 404);
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); } catch { throw new LabHttpError('INVALID_REQUEST_URL', 400); }
  const origin = request.headers.get('origin');
  const forwardedHost = request.headers.get('x-forwarded-host');
  const cloudflareForwarded = Boolean(request.headers.get('cf-ray') || request.headers.get('cf-connecting-ip'));
  const forwardedExternally = cloudflareForwarded
    || request.headers.get('x-sgx-t1-gateway') === '1'
    || Boolean(forwardedHost && !isLoopback(forwardedHost.split(':', 1)[0]));
  if(isLoopback(requestUrl.hostname) && !forwardedExternally) {
    if(origin) {
      try { if(!isLoopback(new URL(origin).hostname)) throw new LabHttpError('CLASSIFICATION_LAB_ORIGIN_REJECTED', 403); }
      catch(error) { if(error instanceof LabHttpError) throw error; throw new LabHttpError('CLASSIFICATION_LAB_ORIGIN_REJECTED', 403); }
    }
  } else {
    if(process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_ENABLED !== 'true') {
      throw new LabHttpError('CLASSIFICATION_T1_EXTERNAL_ACCESS_DISABLED', 403);
    }
    const expected = process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN ?? '';
    if(expected.length < 32) throw new LabHttpError('CLASSIFICATION_T1_EXTERNAL_ACCESS_MISCONFIGURED', 503);
    const supplied = bearerToken(request);
    if(!supplied || !sameSecret(supplied, expected)) {
      throw new LabHttpError('CLASSIFICATION_T1_EXTERNAL_ACCESS_UNAUTHORIZED', 401);
    }
    // Browser origins must use the product backend. This staging boundary is
    // intentionally server-to-server and therefore exposes no CORS policy.
    if(origin) throw new LabHttpError('CLASSIFICATION_T1_EXTERNAL_ORIGIN_REJECTED', 403);
  }
  if(mutation && request.headers.get('x-sgx-classification-lab') !== '1') {
    throw new LabHttpError('CLASSIFICATION_LAB_HEADER_REQUIRED', 403);
  }
}
