import { z } from "zod";
import type { Job } from "../normalize";
import { parseClearance, parseWorkplaceType } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_BROWSER } from "../util/ua";
import { retry } from "../util/retry";
import { stripHtml } from "../util/html";

// Eightfold tenants live in src/seeds/eightfold-tenants.json and in the
// `meta` column of ats_tenants. run.ts parses `meta` through this schema
// before dispatching so a malformed row skips cleanly instead of producing
// garbage URLs.
export const EightfoldTargetSchema = z.object({
  company: z.string().min(1),
  slug: z.string().min(1),
  host: z.string().min(1),
  domain: z.string().min(1),
});
export type EightfoldTarget = z.infer<typeof EightfoldTargetSchema>;

const Position = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  full_location: z.string().nullish(),
  location: z.string().nullish(),
  department: z.string().nullish(),
  business_unit: z.string().nullish(),
  description: z.string().nullish(),
  type: z.string().nullish(),
  work_location_option: z.string().nullish(),
  display_job_id: z.string().nullish(),
  canonicalPositionUrl: z.string().nullish(),
  t_update: z.number().nullish(),
  updated_at_ms: z.number().nullish(),
});

const ResponseSchema = z.object({
  count: z.number().nullish(),
  positions: z.array(z.unknown()),
});

export interface EightfoldConfig {
  target: EightfoldTarget;
  perPage?: number;   // default 50
  maxPages?: number;  // default 4 (200 postings)
}

export async function* fetchEightfold(
  config: EightfoldConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const { target } = config;
  const perPage = config.perPage ?? 50;
  const maxPages = config.maxPages ?? 4;
  const source = `eightfold:${target.slug}`;

  for (let page = 0; page < maxPages; page++) {
    const start = page * perPage;
    const url = `https://${target.host}/api/apply/v2/jobs?domain=${encodeURIComponent(target.domain)}&start=${start}&num=${perPage}`;
    const resp = await retry(() =>
      deps.fetch(url, {
        headers: { "User-Agent": UA_BROWSER, Accept: "application/json" },
      }),
    );
    if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status} start=${start}`);

    const body = (await resp.json()) as unknown;
    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error(`${source}: shape ${parsed.error.message}`);

    const positions = parsed.data.positions;
    if (positions.length === 0) return;

    for (const raw of positions) {
      const p = Position.safeParse(raw);
      if (!p.success) {
        deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
        continue;
      }
      const pos = p.data;
      const applyUrl = pos.canonicalPositionUrl ?? `https://${target.host}/position/${pos.id}`;

      yield {
        source,
        external_id: String(pos.id),
        company: target.company,
        title: pos.name,
        location: pos.full_location ?? pos.location ?? null,
        remote: parseWorkplaceType(pos.work_location_option),
        employment_type: null,
        department: pos.department ?? pos.business_unit ?? null,
        description_html: pos.description ?? null,
        description_text: pos.description ? stripHtml(pos.description) : null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        clearance: parseClearance(pos.name, pos.description),
        apply_url: applyUrl,
        posted_at: pos.updated_at_ms
          ? new Date(pos.updated_at_ms).toISOString()
          : pos.t_update
            ? new Date(pos.t_update * 1000).toISOString()
            : null,
      };
    }

    if (positions.length < perPage) return;
  }
}
