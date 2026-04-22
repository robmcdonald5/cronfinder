export interface RetryOptions {
  tries?: number;       // total attempts incl. first (default 3)
  baseMs?: number;      // initial backoff (default 250)
  maxMs?: number;       // cap on backoff (default 2000)
  shouldRetry?: (err: unknown) => boolean;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 2000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === tries - 1 || !shouldRetry(err)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** i);
      const jitter = Math.floor(Math.random() * (backoff / 2));
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
  throw lastErr;
}
