import { z } from "zod";
import type { Job } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";
import { stripHtml } from "../util/html";

const Hit = z.object({
  objectID: z.string(),
  title: z.string().nullish(),
  created_at: z.string().nullish(),
  author: z.string().nullish(),
});

const SearchResponse = z.object({
  hits: z.array(Hit),
});

interface HnItem {
  id: number;
  text: string | null;
  author: string | null;
  created_at: string | null;
  children: HnItem[];
}

const HnItemSchema: z.ZodType<HnItem> = z.lazy(() =>
  z.object({
    id: z.number(),
    text: z.string().nullish().transform((v) => v ?? null),
    author: z.string().nullish().transform((v) => v ?? null),
    created_at: z.string().nullish().transform((v) => v ?? null),
    children: z.array(HnItemSchema).nullish().transform((v) => v ?? []),
  }),
) as z.ZodType<HnItem>;

export interface HnConfig {
  maxComments?: number;  // default 150 -> cap how much we parse per run
}

const source = "hn";

export async function* fetchHn(
  config: HnConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const maxComments = config.maxComments ?? 150;
  const headers = { "User-Agent": UA_GENERIC, Accept: "application/json" };

  const searchResp = await retry(() =>
    deps.fetch(
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10",
      { headers },
    ),
  );
  if (!searchResp.ok) throw new Error(`${source}: search HTTP ${searchResp.status}`);
  const searchBody = (await searchResp.json()) as unknown;
  const searchParsed = SearchResponse.safeParse(searchBody);
  if (!searchParsed.success) throw new Error(`${source}: search shape ${searchParsed.error.message}`);

  const hiring = searchParsed.data.hits
    .filter((h) => /who is hiring/i.test(h.title ?? ""))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const latest = hiring[0];
  if (!latest) {
    deps.logger.log({ t: "adapter_warn", source, reason: "no hiring thread found" });
    return;
  }

  const treeResp = await retry(() =>
    deps.fetch(`https://hn.algolia.com/api/v1/items/${latest.objectID}`, { headers }),
  );
  if (!treeResp.ok) throw new Error(`${source}: items HTTP ${treeResp.status}`);
  const treeBody = (await treeResp.json()) as unknown;
  const treeParsed = HnItemSchema.safeParse(treeBody);
  if (!treeParsed.success) throw new Error(`${source}: items shape ${treeParsed.error.message}`);

  const threadSource = `${source}:${latest.objectID}`;
  let emitted = 0;
  for (const child of treeParsed.data.children) {
    if (emitted >= maxComments) break;
    const job = parseComment(child, threadSource);
    if (!job) {
      deps.logger.log({ t: "adapter_skip", source, reason: "not a job post", comment_id: child.id });
      continue;
    }
    emitted++;
    yield job;
  }
}

// HN's format convention (not enforced): first line is
// "Company | Location | Role | REMOTE/ONSITE/HYBRID | link".
// Extract what we can; fall back to the whole line when parsing fails.
function parseComment(comment: HnItem, threadSource: string): Job | null {
  const raw = comment.text;
  if (!raw) return null;

  const text = stripHtml(raw, { preserveBreaks: true });
  if (text.length < 40) return null;

  const firstUrl = extractFirstUrl(raw);
  const firstLine = text.split(/[\r\n]/)[0]?.trim() ?? text.slice(0, 200).trim();
  const looksLikeJob =
    /\|/.test(firstLine) ||
    /^[A-Z][\w&.'\- ]{1,60}\s*[-—–|:]/.test(firstLine) ||
    /remote|onsite|hybrid/i.test(firstLine);
  if (!looksLikeJob && firstUrl === null) return null;

  let remote: boolean | null;
  if (/\bremote\b/i.test(text) && !/no\s+remote/i.test(text)) remote = true;
  else if (/\bonsite\b/i.test(text)) remote = false;
  else remote = null;

  return {
    source: threadSource,
    external_id: String(comment.id),
    company: extractCompany(firstLine),
    title: truncate(firstLine, 140) || "HN listing",
    location: extractLocation(firstLine),
    remote,
    employment_type: /\bintern(ship)?\b/i.test(text) ? "intern" : null,
    department: null,
    description_html: raw,
    description_text: text,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    clearance: null,
    apply_url: firstUrl ?? `https://news.ycombinator.com/item?id=${comment.id}`,
    posted_at: comment.created_at ?? null,
  };
}

function extractCompany(firstLine: string): string {
  const pipeIdx = firstLine.indexOf("|");
  if (pipeIdx > 0) return firstLine.slice(0, pipeIdx).trim().slice(0, 80);
  const dashMatch = firstLine.match(/^([^-—–:]{2,60})\s*[-—–:]/);
  if (dashMatch) return dashMatch[1]!.trim();
  return firstLine.slice(0, 50).trim() || "HN";
}

function extractLocation(firstLine: string): string | null {
  const segments = firstLine.split(/\|/).map((s) => s.trim());
  for (const seg of segments.slice(1, 4)) {
    if (/(remote|anywhere|onsite|hybrid)/i.test(seg)) return seg;
    if (/[A-Z]{2}\b|[A-Z][a-z]+,/.test(seg)) return seg;
  }
  return null;
}

function extractFirstUrl(text: string): string | null {
  const hrefMatch = text.match(/href="(https?:\/\/[^"]+)"/);
  if (hrefMatch) return hrefMatch[1]!;
  const bareMatch = text.match(/https?:\/\/[^\s<>"']+/);
  return bareMatch ? bareMatch[0] : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
