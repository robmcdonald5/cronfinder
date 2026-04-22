export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simple per-key throttler: ensures at least `minIntervalMs` between successive
// calls for the same key. Sequential within a key; different keys don't block
// each other. Used to keep ~1 req/sec per Workday tenant without serializing
// the 9 tenants against each other.
export class PerKeyThrottle {
  private lastAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  async wait(key: string): Promise<void> {
    const prev = this.lastAt.get(key) ?? 0;
    const now = Date.now();
    const delta = now - prev;
    if (prev > 0 && delta < this.minIntervalMs) {
      await sleep(this.minIntervalMs - delta);
    }
    this.lastAt.set(key, Date.now());
  }
}
