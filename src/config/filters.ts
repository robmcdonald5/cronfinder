// Personal filter criteria. Applied *after* normalization, before DB write.
// Phase 1: accept-all stub so the full pipeline is exercised end-to-end.
// Tighten up once enough postings land in D1 to see what's noise.

import type { Job } from "../normalize";

export interface FilterResult {
  accept: boolean;
  reason?: string;
}

export function shouldAccept(_job: Job): FilterResult {
  return { accept: true };
}
