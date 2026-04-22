import { z } from "zod";
import type { Job } from "../normalize";
import { parseEmploymentType } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";
import { stripHtml } from "../util/html";

const HimalayasJob = z.object({
  title: z.string().min(1),
  excerpt: z.string().nullish(),
  companyName: z.string().min(1),
  companySlug: z.string().nullish(),
  employmentType: z.string().nullish(),
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  currency: z.string().nullish(),
  locationRestrictions: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  pubDate: z.number().nullish(),
  applicationLink: z.string().nullish(),
  guid: z.string().min(1),
});

const HimalayasResponse = z.object({
  jobs: z.array(z.unknown()),
  totalCount: z.number().nullish(),
});

export interface HimalayasConfig {
  maxPages?: number;   // default 3
  perPage?: number;    // default 100
}

const source = "himalayas";

export async function* fetchHimalayas(
  config: HimalayasConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const perPage = config.perPage ?? 100;
  const maxPages = config.maxPages ?? 3;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * perPage;
    const url = `https://himalayas.app/jobs/api/search?limit=${perPage}&offset=${offset}`;
    const resp = await retry(() =>
      deps.fetch(url, { headers: { "User-Agent": UA_GENERIC, Accept: "application/json" } }),
    );
    if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status} offset=${offset}`);

    const body = (await resp.json()) as unknown;
    const parsed = HimalayasResponse.safeParse(body);
    if (!parsed.success) throw new Error(`${source}: shape ${parsed.error.message}`);

    const jobs = parsed.data.jobs;
    if (jobs.length === 0) return;

    for (const raw of jobs) {
      const p = HimalayasJob.safeParse(raw);
      if (!p.success) {
        deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
        continue;
      }
      const j = p.data;
      const applyUrl = j.applicationLink ?? j.guid;
      if (!applyUrl) continue;

      yield {
        source,
        external_id: j.guid,
        company: j.companyName,
        title: j.title,
        location: j.locationRestrictions?.length ? j.locationRestrictions.join(", ") : "Remote",
        remote: true,  // Himalayas is remote-only.
        employment_type: parseEmploymentType(j.employmentType),
        department: null,
        description_html: j.description ?? null,
        description_text: j.description ? stripHtml(j.description) : j.excerpt ?? null,
        salary_min: j.minSalary ?? null,
        salary_max: j.maxSalary ?? null,
        salary_currency: j.currency ?? null,
        clearance: null,
        apply_url: applyUrl,
        posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
      };
    }

    if (jobs.length < perPage) return;
  }
}
