import { z } from "zod";
import type { Job } from "../normalize";
import { humanizeSlug, parseEmploymentType, parseWorkplaceType } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";

const CompensationTier = z.object({
  salaryMin: z.number().nullish(),
  salaryMax: z.number().nullish(),
  currency: z.string().nullish(),
});

// Ashby's public Job Board API returns `department`, `team`, and `location` as
// plain strings on the job object. Accept either string or object-with-name to
// stay resilient to minor shape drift.
const nameOrString = z.union([
  z.string(),
  z.object({ name: z.string().nullish() }),
]);

const AshbyJob = z.object({
  id: z.string(),
  title: z.string().min(1),
  department: nameOrString.nullish(),
  team: nameOrString.nullish(),
  location: nameOrString.nullish(),
  workplaceType: z.string().nullish(),
  employmentType: z.string().nullish(),
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  publishedAt: z.string().nullish(),
  jobUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  compensationTiers: z.array(CompensationTier).nullish(),
  summaryComponents: z
    .object({
      currency: z.string().nullish(),
      salaryMin: z.number().nullish(),
      salaryMax: z.number().nullish(),
    })
    .nullish(),
});

function pickName(value: z.infer<typeof nameOrString> | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value || null;
  return value.name ?? null;
}

const AshbyResponse = z.object({
  jobs: z.array(z.unknown()),
});

export async function* fetchAshby(
  org: string,
  deps: Deps,
): AsyncIterable<Job> {
  const source = `ashby:${org}`;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`;
  const resp = await retry(() =>
    deps.fetch(url, { headers: { "User-Agent": UA_GENERIC, Accept: "application/json" } }),
  );
  if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status}`);

  const body = (await resp.json()) as unknown;
  const outer = AshbyResponse.safeParse(body);
  if (!outer.success) throw new Error(`${source}: shape ${outer.error.message}`);

  for (const raw of outer.data.jobs) {
    const parsed = AshbyJob.safeParse(raw);
    if (!parsed.success) {
      deps.logger.log({ t: "adapter_skip", source, reason: parsed.error.message });
      continue;
    }
    const j = parsed.data;
    if (j.isListed === false) continue;
    const applyUrl = j.applyUrl ?? j.jobUrl;
    if (!applyUrl) continue;

    const comp = j.compensationTiers?.[0] ?? j.summaryComponents ?? null;

    yield {
      source,
      external_id: j.id,
      company: humanizeSlug(org),
      title: j.title,
      location: pickName(j.location),
      remote: j.isRemote ?? parseWorkplaceType(j.workplaceType),
      employment_type: parseEmploymentType(j.employmentType),
      department: pickName(j.department) ?? pickName(j.team),
      description_html: j.description ?? null,
      description_text: j.descriptionPlain ?? null,
      salary_min: comp?.salaryMin ?? null,
      salary_max: comp?.salaryMax ?? null,
      salary_currency: comp?.currency ?? null,
      clearance: null,
      apply_url: applyUrl,
      posted_at: j.publishedAt ?? null,
    };
  }
}
