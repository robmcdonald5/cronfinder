import { z } from "zod";
import type { Job } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";
import { stripHtml } from "../util/html";

const MuseJob = z.object({
  id: z.number(),
  name: z.string().min(1),
  company: z.object({ name: z.string().min(1), short_name: z.string().nullish() }).nullish(),
  locations: z.array(z.object({ name: z.string() })).nullish(),
  categories: z.array(z.object({ name: z.string() })).nullish(),
  levels: z.array(z.object({ name: z.string(), short_name: z.string().nullish() })).nullish(),
  publication_date: z.string().nullish(),
  refs: z.object({ landing_page: z.string() }).nullish(),
  contents: z.string().nullish(),
});

const MuseResponse = z.object({
  page: z.number().nullish(),
  page_count: z.number().nullish(),
  results: z.array(z.unknown()),
});

// TheMuse uses these exact canonical labels — arbitrary strings like
// "Engineering" or "Software Engineer" return zero results. Verified 2026-04.
const DEFAULT_CATEGORIES = [
  "Software Engineering",
  "Data and Analytics",
  "Product Management",
];

const source = "themuse";
const PER_PAGE = 20;

export interface MuseConfig {
  categories?: readonly string[];
  location?: string;
  maxPages?: number;
  apiKey?: string;
}

export async function* fetchMuse(
  config: MuseConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const categories = config.categories ?? DEFAULT_CATEGORIES;
  const location = config.location ?? "United States";
  const maxPages = config.maxPages ?? 5;
  const yielded = new Set<string>();

  for (const category of categories) {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL("https://www.themuse.com/api/public/jobs");
      url.searchParams.set("page", String(page));
      url.searchParams.set("category", category);
      if (location) url.searchParams.set("location", location);
      if (config.apiKey) url.searchParams.set("api_key", config.apiKey);

      const resp = await retry(() =>
        deps.fetch(url.toString(), {
          headers: { "User-Agent": UA_GENERIC, Accept: "application/json" },
        }),
      );
      if (!resp.ok) {
        throw new Error(
          `${source}: HTTP ${resp.status} category="${category}" page=${page}`,
        );
      }

      const body = (await resp.json()) as unknown;
      const parsed = MuseResponse.safeParse(body);
      if (!parsed.success) throw new Error(`${source}: shape ${parsed.error.message}`);

      const results = parsed.data.results;
      if (results.length === 0) break;

      for (const raw of results) {
        const p = MuseJob.safeParse(raw);
        if (!p.success) {
          deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
          continue;
        }
        const j = p.data;
        const externalId = String(j.id);
        if (yielded.has(externalId)) continue;
        yielded.add(externalId);

        const applyUrl = j.refs?.landing_page;
        const company = j.company?.name;
        if (!applyUrl || !company) {
          deps.logger.log({
            t: "adapter_skip",
            source,
            reason: "missing_apply_or_company",
            id: externalId,
          });
          continue;
        }

        const locationNames = j.locations?.map((l) => l.name) ?? [];
        const locationStr = locationNames.length ? locationNames.join(" / ") : null;
        const remote = locationNames.some((n) => /\bremote\b|\bflexible\b/i.test(n));

        const contents = j.contents ?? null;

        yield {
          source,
          external_id: externalId,
          company,
          title: j.name,
          location: locationStr,
          remote: remote ? true : null,
          employment_type: null,
          department: j.categories?.[0]?.name ?? null,
          description_html: contents,
          description_text: contents ? stripHtml(contents) : null,
          salary_min: null,
          salary_max: null,
          salary_currency: null,
          clearance: null,
          apply_url: applyUrl,
          posted_at: j.publication_date ?? null,
        };
      }

      if (results.length < PER_PAGE) break;
    }
  }
}
