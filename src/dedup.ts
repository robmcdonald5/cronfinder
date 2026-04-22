// Cross-source dedup hash builder. Emitted when the same role appears on
// multiple ATSes (same normalized company/title/location) so a future
// join table can fold them into one canonical job. Not wired into the
// upsert path today — db.ts dedups on (source, external_id) only.

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
