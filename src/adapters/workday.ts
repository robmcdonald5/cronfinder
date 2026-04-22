import { z } from "zod";
import type { Job } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_BROWSER } from "../util/ua";
import { retry } from "../util/retry";
import { PerKeyThrottle } from "../util/rate-limit";
import type { WorkdayTarget } from "../config/targets-workday";

// ---- response shapes --------------------------------------------------------

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

// ---- adapter ---------------------------------------------------------------

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
  if (!listResp.ok) {
    throw new Error(`workday ${target.slug} list HTTP ${listResp.status}`);
  }

  const listJson = (await listResp.json()) as unknown;
  const listParsed = ListResponse.safeParse(listJson);
  if (!listParsed.success) {
    throw new Error(`workday ${target.slug} list shape: ${listParsed.error.message}`);
  }

  const postings = listParsed.data.jobPostings.slice(0, maxPostings);
  for (const raw of postings) {
    const p = ListPosting.safeParse(raw);
    if (!p.success) {
      deps.logger.log({ t: "adapter_skip", source: `workday:${target.slug}`, reason: p.error.message });
      continue;
    }
    const posting = p.data;

    // Fetch detail for description. One-per-tenant throttle keeps us ~1 req/sec.
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
        source: `workday:${target.slug}`,
        reason: `detail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        externalPath: posting.externalPath,
      });
    }

    const externalId = posting.jobId ?? posting.bulletFields?.[0] ?? posting.externalPath;
    const applyUrl = `https://${target.tenant}.wd${target.wdN}.myworkdayjobs.com/${target.site}${posting.externalPath}`;

    yield {
      source: `workday:${target.slug}`,
      external_id: externalId,
      company: target.company,
      title: posting.title,
      location: posting.locationsText ?? null,
      remote: parseRemoteFromLocation(posting.locationsText),
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

function parseRemoteFromLocation(location: string | null | undefined): boolean | null {
  if (!location) return null;
  if (/remote/i.test(location)) return true;
  return null;
}

function parseClearance(
  title: string,
  description: string | null,
): "public_trust" | "secret" | "top_secret" | "ts_sci" | null {
  const blob = `${title} ${description ?? ""}`.toLowerCase();
  if (/ts\s*\/\s*sci|top\s*secret\s*\/\s*sci/.test(blob)) return "ts_sci";
  if (/top\s*secret/.test(blob)) return "top_secret";
  if (/\bsecret\b/.test(blob)) return "secret";
  if (/public\s*trust/.test(blob)) return "public_trust";
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
