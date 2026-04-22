// Phase 1: primary-key dedup is handled by `ON CONFLICT(source, external_id)`
// in db.upsertJob. This file exists so Phase 3 can plug in the cross-source
// dedup hash without widespread refactoring.

import type { Job } from "./normalize";
import { sha256Hex } from "./util/hash";
import { normalizeCompany, normalizeLocation, normalizeTitle } from "./normalize";

export function dedupHashInput(job: Job): string {
  return [
    normalizeCompany(job.company),
    normalizeTitle(job.title),
    normalizeLocation(job.location),
  ].join("|");
}

export function dedupHash(job: Job): Promise<string> {
  return sha256Hex(dedupHashInput(job));
}
