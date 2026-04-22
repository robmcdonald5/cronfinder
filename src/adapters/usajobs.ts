import { z } from "zod";
import type { Job } from "../normalize";
import { parseEmploymentType } from "../normalize";
import type { Deps } from "../util/deps";
import { retry } from "../util/retry";

export interface UsaJobsConfig {
  apiKey: string;
  userAgent: string;              // must be the email registered with OPM
  keyword?: string;               // default "software"
  resultsPerPage?: number;        // max 500
  maxPages?: number;              // cap subrequest usage
}

const Remuneration = z.object({
  MinimumRange: z.string().nullish(),
  MaximumRange: z.string().nullish(),
  RateIntervalCode: z.string().nullish(),
});

const Descriptor = z.object({
  PositionID: z.string(),
  PositionTitle: z.string().min(1),
  OrganizationName: z.string().nullish(),
  DepartmentName: z.string().nullish(),
  PositionLocationDisplay: z.string().nullish(),
  PositionRemoteIndicator: z.string().nullish(),
  ApplyURI: z.array(z.string()).nullish(),
  PublicationStartDate: z.string().nullish(),
  PositionSchedule: z.array(z.object({ Name: z.string().nullish() })).nullish(),
  PositionRemuneration: z.array(Remuneration).nullish(),
  QualificationSummary: z.string().nullish(),
  UserArea: z
    .object({ Details: z.object({ JobSummary: z.string().nullish() }).nullish() })
    .nullish(),
});

const SearchItem = z.object({
  MatchedObjectId: z.string().nullish(),
  MatchedObjectDescriptor: Descriptor,
});

const SearchResponse = z.object({
  SearchResult: z.object({
    SearchResultCount: z.number(),
    SearchResultCountAll: z.number(),
    SearchResultItems: z.array(z.unknown()),
  }),
});

const source = "usajobs";

export async function* fetchUsaJobs(
  config: UsaJobsConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const keyword = config.keyword ?? "software";
  const perPage = config.resultsPerPage ?? 500;
  const maxPages = config.maxPages ?? 4;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL("https://data.usajobs.gov/api/Search");
    url.searchParams.set("Keyword", keyword);
    url.searchParams.set("Fields", "Full");
    url.searchParams.set("ResultsPerPage", String(perPage));
    url.searchParams.set("Page", String(page));

    const resp = await retry(() =>
      deps.fetch(url.toString(), {
        headers: {
          Host: "data.usajobs.gov",
          "User-Agent": config.userAgent,
          "Authorization-Key": config.apiKey,
          Accept: "application/json",
        },
      }),
    );
    if (!resp.ok) throw new Error(`${source}: HTTP ${resp.status} page=${page}`);

    const body = (await resp.json()) as unknown;
    const outer = SearchResponse.safeParse(body);
    if (!outer.success) throw new Error(`${source}: shape ${outer.error.message}`);

    const items = outer.data.SearchResult.SearchResultItems;
    if (items.length === 0) return;

    for (const raw of items) {
      const parsed = SearchItem.safeParse(raw);
      if (!parsed.success) {
        deps.logger.log({ t: "adapter_skip", source, reason: parsed.error.message });
        continue;
      }
      const d = parsed.data.MatchedObjectDescriptor;
      const applyUrl = d.ApplyURI?.[0];
      if (!applyUrl) continue;

      const pay = d.PositionRemuneration?.[0];
      const descText = d.UserArea?.Details?.JobSummary ?? d.QualificationSummary ?? null;

      yield {
        source,
        external_id: d.PositionID,
        company: d.OrganizationName ?? d.DepartmentName ?? "US Federal Government",
        title: d.PositionTitle,
        location: d.PositionLocationDisplay ?? null,
        remote: parseRemoteIndicator(d.PositionRemoteIndicator),
        employment_type: parseEmploymentType(d.PositionSchedule?.[0]?.Name),
        department: d.DepartmentName ?? null,
        description_html: null,
        description_text: descText,
        salary_min: parseMoney(pay?.MinimumRange),
        salary_max: parseMoney(pay?.MaximumRange),
        salary_currency: pay?.MinimumRange ? "USD" : null,
        clearance: null,
        apply_url: applyUrl,
        posted_at: d.PublicationStartDate ?? null,
      };
    }

    // Stop early when the last page was partial.
    if (items.length < perPage) return;
  }
}

// USAJobs' PositionRemoteIndicator is a plain "Yes"/"No" string rather than a
// workplaceType enum, so it gets its own parser instead of parseWorkplaceType.
function parseRemoteIndicator(indicator: string | null | undefined): boolean | null {
  if (!indicator) return null;
  const t = indicator.toLowerCase();
  if (t === "yes") return true;
  if (t === "no") return false;
  return null;
}

function parseMoney(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Math.round(parseFloat(value));
  return Number.isFinite(n) ? n : null;
}
