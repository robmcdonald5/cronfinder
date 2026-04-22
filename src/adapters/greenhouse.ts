import { z } from "zod";
import type { Job } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";

const PayRange = z.object({
  min_cents: z.number().nullish(),
  max_cents: z.number().nullish(),
  currency_type: z.string().nullish(),
});

const GreenhouseJob = z.object({
  id: z.number(),
  title: z.string().min(1),
  location: z.object({ name: z.string().nullish() }).nullish(),
  absolute_url: z.string().min(1),
  updated_at: z.string().nullish(),
  content: z.string().nullish(),
  departments: z.array(z.object({ name: z.string() })).nullish(),
  offices: z
    .array(z.object({ name: z.string().nullish(), location: z.string().nullish() }))
    .nullish(),
  pay_input_ranges: z.array(PayRange).nullish(),
});

const GreenhouseResponse = z.object({
  jobs: z.array(z.unknown()),
});

export async function* fetchGreenhouse(
  token: string,
  deps: Deps,
): AsyncIterable<Job> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  const resp = await retry(() =>
    deps.fetch(url, { headers: { "User-Agent": UA_GENERIC, Accept: "application/json" } }),
  );
  if (!resp.ok) {
    throw new Error(`greenhouse ${token} HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as unknown;
  const outer = GreenhouseResponse.safeParse(body);
  if (!outer.success) {
    throw new Error(`greenhouse ${token} shape: ${outer.error.message}`);
  }

  for (const raw of outer.data.jobs) {
    const parsed = GreenhouseJob.safeParse(raw);
    if (!parsed.success) {
      deps.logger.log({ t: "adapter_skip", source: `greenhouse:${token}`, reason: parsed.error.message });
      continue;
    }
    const j = parsed.data;
    const location = pickLocation(j);
    const officeNames = j.offices?.map((o) => o.location ?? o.name).filter(Boolean) ?? [];
    const isRemote = officeNames.some((s) => /remote/i.test(String(s))) || /remote/i.test(location ?? "");
    const pay = j.pay_input_ranges?.[0];
    const descHtml = j.content ? decodeHtmlEntities(j.content) : null;
    const descText = descHtml ? stripHtml(descHtml) : null;

    yield {
      source: `greenhouse:${token}`,
      external_id: String(j.id),
      company: toCompany(token),
      title: j.title,
      location,
      remote: isRemote || null,
      employment_type: null,
      department: j.departments?.[0]?.name ?? null,
      description_html: descHtml,
      description_text: descText,
      salary_min: pay?.min_cents ? Math.round(pay.min_cents / 100) : null,
      salary_max: pay?.max_cents ? Math.round(pay.max_cents / 100) : null,
      salary_currency: pay?.currency_type ?? null,
      clearance: null,
      apply_url: j.absolute_url,
      posted_at: j.updated_at ?? null,
    };
  }
}

function pickLocation(j: z.infer<typeof GreenhouseJob>): string | null {
  const primary = j.location?.name?.trim();
  if (primary) return primary;
  const office = j.offices?.[0];
  return office?.location ?? office?.name ?? null;
}

function toCompany(token: string): string {
  // Board tokens are slug-cased ("general-catalyst"); humanize.
  return token
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
