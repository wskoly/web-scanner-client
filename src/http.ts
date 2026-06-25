// Shared HTTP layer: injectable fetch + per-request timeout (AbortController)
// + retry-with-backoff on transient failures. Used by both ScannerClient and
// ScanJob so every network call gets the same fault-tolerance.

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
  text(): Promise<string>;
}

export type HttpLike = (input: string, init?: FetchInit) => Promise<HttpResponse>;

export interface RequestOptions {
  /** Abort a single attempt after this many ms. 0 disables. */
  timeoutMs: number;
  /** Extra attempts after the first on transient failure. */
  retries: number;
  /** Base backoff between attempts (doubles per attempt, capped 5s). */
  retryDelayMs: number;
}

// Gateway/overload/rate-limit statuses worth retrying. Note 503 covers the
// printer "busy/cooldown" responses (e.g. the HP eSCL throttle).
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const backoff = (base: number, attempt: number): number =>
  Math.min(base * 2 ** attempt, 5000);

/**
 * Run a request with timeout + transient retry. Returns the final response
 * (caller maps non-2xx to ScannerError). Throws only on network error /
 * timeout after exhausting retries.
 */
export async function request(
  fetchImpl: HttpLike,
  url: string,
  init: FetchInit,
  opts: RequestOptions,
): Promise<HttpResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const controller = opts.timeoutMs > 0 ? new AbortController() : null;
    const timer =
      controller && opts.timeoutMs > 0
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : null;

    try {
      const res = await fetchImpl(url, {
        ...init,
        signal: controller?.signal,
      });
      if (timer) clearTimeout(timer);

      if (RETRYABLE_STATUS.has(res.status) && attempt < opts.retries) {
        await delay(backoff(opts.retryDelayMs, attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastError = err;
      if (attempt < opts.retries) {
        await delay(backoff(opts.retryDelayMs, attempt));
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Request failed"));
}
