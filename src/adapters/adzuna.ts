import { z } from "zod";
import type { Job } from "../normalize";
import { parseEmploymentType } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";

const AdzunaJob = z.object({
  id: z.string(),
  title: z.string().min(1),
  company: z.object({ display_name: z.string().nullish() }).nullish(),
  location: z
    .object({
      display_name: z.string().nullish(),
      area: z.array(z.string()).nullish(),
    })
    .nullish(),
  description: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  // Adzuna sends "0"/"1" as a string in current responses but has returned
  // booleans historically. Accept both.
  salary_is_predicted: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  contract_type: z.string().nullish(),
  contract_time: z.string().nullish(),
  created: z.string().nullish(),
  redirect_url: z.string().min(1),
});

const AdzunaResponse = z.object({
  count: z.number().nullish(),
  results: z.array(z.unknown()),
});

export interface AdzunaConfig {
  appId: string;
  appKey: string;
  keyword?: string;        // default "software"
  resultsPerPage?: number; // default 50 (Adzuna max ~50)
  maxPages?: number;       // default 5 (≈250 jobs / run)
}

const source = "adzuna";

export async function* fetchAdzuna(
  config: AdzunaConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const keyword = config.keyword ?? "software";
  const perPage = config.resultsPerPage ?? 50;
  const maxPages = config.maxPages ?? 5;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/us/search/${page}`);
    url.searchParams.set("app_id", config.appId);
    url.searchParams.set("app_key", config.appKey);
    url.searchParams.set("what", keyword);
    url.searchParams.set("results_per_page", String(perPage));
    url.searchParams.set("content-type", "application/json");

    const resp = await retry(() =>
      deps.fetch(url.toString(), {
        headers: { "User-Agent": UA_GENERIC, Accept: "application/json" },
      }),
    );
    if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status} page=${page}`);

    const body = (await resp.json()) as unknown;
    const parsed = AdzunaResponse.safeParse(body);
    if (!parsed.success) throw new Error(`${source}: shape ${parsed.error.message}`);

    const results = parsed.data.results;
    if (results.length === 0) return;

    for (const raw of results) {
      const p = AdzunaJob.safeParse(raw);
      if (!p.success) {
        deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
        continue;
      }
      const j = p.data;
      const company = j.company?.display_name?.trim();
      if (!company) {
        deps.logger.log({ t: "adapter_skip", source, reason: "missing company", id: j.id });
        continue;
      }
      const predicted = isTruthyFlag(j.salary_is_predicted);

      yield {
        source,
        external_id: j.id,
        company,
        title: j.title,
        location: j.location?.display_name ?? null,
        // Adzuna doesn't surface a "remote" flag. The US-wide location include
        // list + the filter's description-based checks handle remote detection.
        remote: null,
        employment_type: parseEmploymentType(j.contract_time),
        department: null,
        description_html: null,
        description_text: j.description ?? null,
        salary_min: predicted ? null : j.salary_min ?? null,
        salary_max: predicted ? null : j.salary_max ?? null,
        salary_currency: !predicted && (j.salary_min != null || j.salary_max != null) ? "USD" : null,
        clearance: null,
        apply_url: j.redirect_url,
        posted_at: j.created ?? null,
      };
    }

    if (results.length < perPage) return;
  }
}

function isTruthyFlag(value: string | number | boolean | null | undefined): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  return false;
}
