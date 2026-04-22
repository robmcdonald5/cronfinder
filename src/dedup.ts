// Canonical dedup grouping key. Two callers:
//   - digest.ts collapses cross-source duplicates at render time.
//   - dedupHash() below returns a sha256 of the same key — kept for a
//     future cross-source upsert path that persists into a join table.

import type { Job } from "./normalize";
import { sha256Hex } from "./util/hash";
import { normalizeCompany, normalizeLocation, normalizeTitle } from "./normalize";

export function dedupKey(
  company: string,
  title: string,
  location: string | null,
): string {
  return [
    normalizeCompany(company),
    normalizeTitle(title),
    normalizeLocation(location),
  ].join("|");
}

export function dedupHash(job: Job): Promise<string> {
  return sha256Hex(dedupKey(job.company, job.title, job.location));
}
