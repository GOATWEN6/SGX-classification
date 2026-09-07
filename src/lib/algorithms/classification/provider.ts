import type { ClassificationProviderRequest, ClassificationProviderResult, ProviderErrorCode } from './types';
import { validateProviderRequest, validateProviderResult } from './guards';

export interface AlgorithmProvider {
  classify(request: ClassificationProviderRequest, options: { signal: AbortSignal }): Promise<unknown>;
  cancel(runId: string): void | Promise<void>;
}

export function failureResult(request: ClassificationProviderRequest, code: ProviderErrorCode): ClassificationProviderResult {
  return { schemaVersion: '1.0', runId: request.runId, jobId: request.jobId,
    subjectId: request.subjectId, householdId: request.householdId, inputHash: request.inputHash,
    versions: { ...request.versions }, status: code === 'CANCELLED' ? 'cancelled' :
      ['TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(code) ? 'failed_retryable' : 'failed_terminal',
    assertions: [], facetErrors: [], abstentions: [], error: { code },
    usage: { latencyMs: 0, inputUnits: 0, outputUnits: 0 } };
}

/** Always use a bounded runner, including for the Fake timeout scenario. No retry or persistence. */
export async function executeProvider(input: ClassificationProviderRequest, provider: AlgorithmProvider,
  options: { signal?: AbortSignal; maxDurationMs?: number } = {}): Promise<ClassificationProviderResult> {
  const request = structuredClone(validateProviderRequest(input));
  const maxDuration = options.maxDurationMs ?? 60000;
  if (!Number.isFinite(maxDuration) || maxDuration < 1 || maxDuration > 60000) throw new RangeError('INVALID_DURATION');
  if (options.signal?.aborted) return failureResult(request, 'CANCELLED');
  const budget = Math.min(Date.parse(request.deadlineAt) - Date.now(), maxDuration);
  if (budget <= 0) return failureResult(request, 'TIMEOUT');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;
  let stopCode: 'TIMEOUT' | 'CANCELLED' | undefined;
  const started = Date.now();
  try {
    const stopped = new Promise<ClassificationProviderResult>(resolve => {
      const stop = (code: 'TIMEOUT' | 'CANCELLED') => {
        stopCode ??= code;
        // Resolve the authoritative product outcome before a cooperative provider settles.
        resolve(failureResult(request, stopCode));
        controller.abort();
        try { void Promise.resolve(provider.cancel(request.runId)).catch(() => {}); } catch { /* best effort */ }
      };
      cancelListener = () => stop('CANCELLED');
      options.signal?.addEventListener('abort', cancelListener, { once: true });
      timer = setTimeout(() => stop('TIMEOUT'), budget);
    });
    const running = Promise.resolve().then(() => stopCode ? failureResult(request, stopCode) :
      provider.classify(request, { signal: controller.signal }))
      .then(output => {
        if (stopCode) return failureResult(request, stopCode);
        if (Date.now() >= Date.parse(request.deadlineAt) || Date.now() - started >= budget) return failureResult(request, 'TIMEOUT');
        try { return validateProviderResult(request, output); }
        catch { return failureResult(request, 'INVALID_OUTPUT'); }
      }, () => failureResult(request, stopCode ?? 'PROVIDER_UNAVAILABLE'));
    return await Promise.race([running, stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancelListener) options.signal?.removeEventListener('abort', cancelListener);
  }
}
