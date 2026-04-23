import { z } from "zod";
import type { Job } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";
import { stripHtml } from "../util/html";

// RemoteOK returns a JSON array where index 0 is a metadata/legal wrapper and
// the remaining entries are postings. Per their ToS, attribution is required —
// the `remoteok` source tag satisfies that requirement in the digest.
const RemoteOkJob = z.object({
  id: z.union([z.string(), z.number()]),
  epoch: z.number().nullish(),
  date: z.string().nullish(),
  company: z.string().min(1),
  position: z.string().min(1),
  location: z.string().nullish(),
  description: z.string().nullish(),
  apply_url: z.string().nullish(),
  url: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
});

const source = "remoteok";

export type RemoteOkConfig = Record<string, never>;

export async function* fetchRemoteOk(
  _config: RemoteOkConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const url = "https://remoteok.com/api";
  const resp = await retry(() =>
    deps.fetch(url, { headers: { "User-Agent": UA_GENERIC, Accept: "application/json" } }),
  );
  if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status}`);

  const body = (await resp.json()) as unknown;
  if (!Array.isArray(body)) throw new Error(`${source}: response not an array`);

  // Skip index 0 — legal/metadata wrapper.
  for (let i = 1; i < body.length; i++) {
    const p = RemoteOkJob.safeParse(body[i]);
    if (!p.success) {
      deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
      continue;
    }
    const j = p.data;
    const applyUrl = j.apply_url || j.url;
    if (!applyUrl) continue;

    const sMin = j.salary_min && j.salary_min > 0 ? j.salary_min : null;
    const sMax = j.salary_max && j.salary_max > 0 ? j.salary_max : null;

    yield {
      source,
      external_id: String(j.id),
      company: j.company,
      title: j.position,
      location: j.location?.trim() || null,
      remote: true,
      employment_type: null,
      department: null,
      description_html: j.description ?? null,
      description_text: j.description ? stripHtml(j.description) : null,
      salary_min: sMin,
      salary_max: sMax,
      salary_currency: sMin != null || sMax != null ? "USD" : null,
      clearance: null,
      apply_url: applyUrl,
      posted_at: j.date ?? (j.epoch ? new Date(j.epoch * 1000).toISOString() : null),
    };
  }
}
