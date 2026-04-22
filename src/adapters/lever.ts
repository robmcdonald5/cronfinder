import { z } from "zod";
import type { Job, EmploymentType } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";

const SalaryRange = z.object({
  min: z.number().nullish(),
  max: z.number().nullish(),
  currency: z.string().nullish(),
  interval: z.string().nullish(),
});

const LeverPosting = z.object({
  id: z.string(),
  text: z.string().min(1),
  hostedUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      commitment: z.string().nullish(),
      team: z.string().nullish(),
      department: z.string().nullish(),
    })
    .nullish(),
  workplaceType: z.string().nullish(),
  salaryRange: SalaryRange.nullish(),
  createdAt: z.number().nullish(),
  country: z.string().nullish(),
});

const LeverResponse = z.array(z.unknown());

export async function* fetchLever(
  company: string,
  deps: Deps,
): AsyncIterable<Job> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
  const resp = await retry(() =>
    deps.fetch(url, { headers: { "User-Agent": UA_GENERIC, Accept: "application/json" } }),
  );
  if (!resp.ok) {
    throw new Error(`lever ${company} HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as unknown;
  const outer = LeverResponse.safeParse(body);
  if (!outer.success) {
    throw new Error(`lever ${company} shape: ${outer.error.message}`);
  }

  for (const raw of outer.data) {
    const parsed = LeverPosting.safeParse(raw);
    if (!parsed.success) {
      deps.logger.log({ t: "adapter_skip", source: `lever:${company}`, reason: parsed.error.message });
      continue;
    }
    const j = parsed.data;
    const applyUrl = j.applyUrl ?? j.hostedUrl;
    if (!applyUrl) continue;

    yield {
      source: `lever:${company}`,
      external_id: j.id,
      company: toCompany(company),
      title: j.text,
      location: j.categories?.location ?? null,
      remote: parseRemote(j.workplaceType),
      employment_type: parseCommitment(j.categories?.commitment),
      department: j.categories?.department ?? j.categories?.team ?? null,
      description_html: j.description ?? null,
      description_text: j.descriptionPlain ?? null,
      salary_min: j.salaryRange?.min ?? null,
      salary_max: j.salaryRange?.max ?? null,
      salary_currency: j.salaryRange?.currency ?? null,
      clearance: null,
      apply_url: applyUrl,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    };
  }
}

function parseRemote(workplaceType: string | null | undefined): boolean | null {
  if (!workplaceType) return null;
  const t = workplaceType.toLowerCase();
  if (t === "remote") return true;
  if (t === "on-site" || t === "onsite") return false;
  return null;
}

function parseCommitment(value: string | null | undefined): EmploymentType {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("intern")) return "intern";
  if (v.includes("full")) return "full_time";
  if (v.includes("part")) return "part_time";
  if (v.includes("contract")) return "contract";
  if (v.includes("temp")) return "temp";
  return null;
}

function toCompany(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
