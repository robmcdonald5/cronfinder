import { z } from "zod";
import type { Job } from "../normalize";
import { parseEmploymentType } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";
import { stripHtml } from "../util/html";

const JobicyJob = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string().min(1),
  jobTitle: z.string().min(1),
  companyName: z.string().min(1),
  jobIndustry: z.array(z.string()).nullish(),
  jobType: z.array(z.string()).nullish(),
  jobGeo: z.string().nullish(),
  jobLevel: z.string().nullish(),
  jobExcerpt: z.string().nullish(),
  jobDescription: z.string().nullish(),
  pubDate: z.string().nullish(),
  salaryMin: z.number().nullish(),
  salaryMax: z.number().nullish(),
  salaryCurrency: z.string().nullish(),
});

const JobicyResponse = z.object({
  jobCount: z.number().nullish(),
  jobs: z.array(z.unknown()),
});

const source = "jobicy";

export interface JobicyConfig {
  geo?: string;   // default "usa"
  count?: number; // default 50 (Jobicy hard-caps per call at 50)
}

export async function* fetchJobicy(
  config: JobicyConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const geo = config.geo ?? "usa";
  const count = config.count ?? 50;

  const url = new URL("https://jobicy.com/api/v2/remote-jobs");
  url.searchParams.set("count", String(count));
  url.searchParams.set("geo", geo);

  const resp = await retry(() =>
    deps.fetch(url.toString(), {
      headers: { "User-Agent": UA_GENERIC, Accept: "application/json" },
    }),
  );
  if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status} geo=${geo}`);

  const body = (await resp.json()) as unknown;
  const parsed = JobicyResponse.safeParse(body);
  if (!parsed.success) throw new Error(`${source}: shape ${parsed.error.message}`);

  for (const raw of parsed.data.jobs) {
    const p = JobicyJob.safeParse(raw);
    if (!p.success) {
      deps.logger.log({ t: "adapter_skip", source, reason: p.error.message });
      continue;
    }
    const j = p.data;

    yield {
      source,
      external_id: String(j.id),
      company: j.companyName,
      title: j.jobTitle,
      location: j.jobGeo ?? null,
      remote: true,
      employment_type: parseEmploymentType(j.jobType?.[0]),
      department: j.jobIndustry?.[0] ?? null,
      description_html: j.jobDescription ?? null,
      description_text: j.jobDescription ? stripHtml(j.jobDescription) : j.jobExcerpt ?? null,
      salary_min: j.salaryMin ?? null,
      salary_max: j.salaryMax ?? null,
      salary_currency: j.salaryCurrency ?? null,
      clearance: null,
      apply_url: j.url,
      posted_at: j.pubDate ?? null,
    };
  }
}
