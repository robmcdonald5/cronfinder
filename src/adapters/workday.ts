import { z } from "zod";
import type { Job } from "../normalize";
import { parseClearance } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_BROWSER } from "../util/ua";
import { retry } from "../util/retry";
import { PerKeyThrottle } from "../util/rate-limit";
import { stripHtml } from "../util/html";

// Workday tuples live in src/seeds/workday-tenants.json and in the
// `meta` column of ats_tenants. Co-locating the type + runtime schema
// with the adapter keeps the seed→adapter contract in one place; run.ts
// parses the `meta` blob through this schema before dispatching.
export const WorkdayTargetSchema = z.object({
  company: z.string().min(1),
  slug: z.string().min(1),
  tenant: z.string().min(1),
  wdN: z.number().int().positive(),
  site: z.string().min(1),
});
export type WorkdayTarget = z.infer<typeof WorkdayTargetSchema>;

const ListPosting = z.object({
  title: z.string().min(1),
  externalPath: z.string().min(1),
  locationsText: z.string().nullish(),
  postedOn: z.string().nullish(),
  bulletFields: z.array(z.string()).nullish(),
  jobId: z.string().nullish(),
  startDate: z.string().nullish(),
});

const ListResponse = z.object({
  total: z.number().nullish(),
  jobPostings: z.array(z.unknown()),
});

const DetailResponse = z.object({
  jobPostingInfo: z
    .object({
      id: z.string().nullish(),
      jobPostingId: z.string().nullish(),
      title: z.string().nullish(),
      jobDescription: z.string().nullish(),
      location: z.string().nullish(),
      timeType: z.string().nullish(),
      startDate: z.string().nullish(),
      postedOn: z.string().nullish(),
      externalUrl: z.string().nullish(),
    })
    .nullish(),
});

export interface WorkdayConfig {
  target: WorkdayTarget;
  throttle: PerKeyThrottle;     // shared instance, keyed by tenant
  listLimit?: number;           // per list page, default 20
  maxPostings?: number;         // cap description fan-out, default 20
}

export async function* fetchWorkday(
  config: WorkdayConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const { target, throttle } = config;
  const listLimit = config.listLimit ?? 20;
  const maxPostings = config.maxPostings ?? 20;
  const source = `workday:${target.slug}`;

  const base = `https://${target.tenant}.wd${target.wdN}.myworkdayjobs.com/wday/cxs/${target.tenant}/${target.site}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": UA_BROWSER,
  };

  await throttle.wait(target.tenant);
  const listResp = await retry(() =>
    deps.fetch(`${base}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ appliedFacets: {}, limit: listLimit, offset: 0, searchText: "" }),
    }),
  );
  if (!listResp.ok) throw new Error(`${source}: list HTTP ${listResp.status}`);

  const listJson = (await listResp.json()) as unknown;
  const listParsed = ListResponse.safeParse(listJson);
  if (!listParsed.success) throw new Error(`${source}: list shape ${listParsed.error.message}`);

  const postings = listParsed.data.jobPostings.slice(0, maxPostings);
  for (const raw of postings) {
    const p = ListPosting.safeParse(raw);
    if (!p.success) {
      deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
      continue;
    }
    const posting = p.data;

    // One-per-tenant throttle keeps us ~1 req/sec to avoid Workday's bot detection.
    await throttle.wait(target.tenant);
    let description: string | null = null;
    try {
      const detailResp = await deps.fetch(`${base}${posting.externalPath}`, { headers });
      if (detailResp.ok) {
        const detailJson = (await detailResp.json()) as unknown;
        const detailParsed = DetailResponse.safeParse(detailJson);
        description = detailParsed.success
          ? detailParsed.data.jobPostingInfo?.jobDescription ?? null
          : null;
      }
    } catch (err) {
      deps.logger.log({
        t: "adapter_warn",
        source,
        reason: `detail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        externalPath: posting.externalPath,
      });
    }

    const externalId = posting.jobId ?? posting.bulletFields?.[0] ?? posting.externalPath;
    const applyUrl = `https://${target.tenant}.wd${target.wdN}.myworkdayjobs.com/${target.site}${posting.externalPath}`;

    yield {
      source,
      external_id: externalId,
      company: target.company,
      title: posting.title,
      location: posting.locationsText ?? null,
      remote: /remote/i.test(posting.locationsText ?? "") ? true : null,
      employment_type: null,
      department: null,
      description_html: description,
      description_text: description ? stripHtml(description) : null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      clearance: parseClearance(posting.title, description),
      apply_url: applyUrl,
      posted_at: posting.startDate ?? null,
    };
  }
}
