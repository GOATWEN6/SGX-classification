export class LabHttpError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
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
