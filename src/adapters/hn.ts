import { z } from "zod";
import type { Job } from "../normalize";
import type { Deps } from "../util/deps";
import { UA_GENERIC } from "../util/ua";
import { retry } from "../util/retry";

// -- Algolia search response --

const Hit = z.object({
  objectID: z.string(),
  title: z.string().nullish(),
  created_at: z.string().nullish(),
  author: z.string().nullish(),
});

const SearchResponse = z.object({
  hits: z.array(Hit),
});

// -- Item tree --

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

// -- Adapter --

export interface HnConfig {
  maxComments?: number;  // default 150 -> cap how much we parse per run
}

export async function* fetchHn(
  config: HnConfig,
  deps: Deps,
): AsyncIterable<Job> {
  const maxComments = config.maxComments ?? 150;
  const headers = { "User-Agent": UA_GENERIC, Accept: "application/json" };

  // 1. Find the latest "Who is hiring?" thread.
  const searchResp = await retry(() =>
    deps.fetch(
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10",
      { headers },
    ),
  );
  if (!searchResp.ok) throw new Error(`hn search HTTP ${searchResp.status}`);
  const searchBody = (await searchResp.json()) as unknown;
  const searchParsed = SearchResponse.safeParse(searchBody);
  if (!searchParsed.success) throw new Error(`hn search shape: ${searchParsed.error.message}`);

  const hiring = searchParsed.data.hits
    .filter((h) => /who is hiring/i.test(h.title ?? ""))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const latest = hiring[0];
  if (!latest) {
    deps.logger.log({ t: "adapter_warn", source: "hn", reason: "no hiring thread found" });
    return;
  }

  // 2. Fetch the item tree for that thread.
  const treeResp = await retry(() =>
    deps.fetch(`https://hn.algolia.com/api/v1/items/${latest.objectID}`, { headers }),
  );
  if (!treeResp.ok) throw new Error(`hn items HTTP ${treeResp.status}`);
  const treeBody = (await treeResp.json()) as unknown;
  const treeParsed = HnItemSchema.safeParse(treeBody);
  if (!treeParsed.success) throw new Error(`hn items shape: ${treeParsed.error.message}`);

  const threadId = latest.objectID;
  let emitted = 0;
  for (const child of treeParsed.data.children) {
    if (emitted >= maxComments) break;
    const job = parseComment(child, threadId);
    if (!job) {
      deps.logger.log({ t: "adapter_skip", source: "hn", reason: "not a job post", comment_id: child.id });
      continue;
    }
    emitted++;
    yield job;
  }
}

// Best-effort parse of a single top-level comment into a Job.
// HN's format convention (not enforced): first line is
// "Company | Location | Role | REMOTE/ONSITE/HYBRID | link".
// We extract what we can and fall back to sane defaults.
function parseComment(comment: HnItem, threadId: string): Job | null {
  const raw = comment.text;
  if (!raw) return null;

  const text = stripHtml(raw);
  if (text.length < 40) return null;

  const firstLine = text.split(/[\r\n]/)[0]?.trim() ?? text.slice(0, 200).trim();
  const applyUrl = extractFirstUrl(raw) ?? `https://news.ycombinator.com/item?id=${comment.id}`;

  // Heuristic: a real job post usually has a URL or contains a pipe / colon meta.
  const looksLikeJob =
    /\|/.test(firstLine) ||
    /^[A-Z][\w&.'\- ]{1,60}\s*[-—–|:]/.test(firstLine) ||
    /remote|onsite|hybrid/i.test(firstLine);
  if (!looksLikeJob && extractFirstUrl(raw) === null) return null;

  const company = extractCompany(firstLine);
  const title = truncate(firstLine, 140) || "HN listing";
  const location = extractLocation(firstLine);
  const remote = /\bremote\b/i.test(text) && !/no\s+remote/i.test(text);

  return {
    source: `hn:${threadId}`,
    external_id: String(comment.id),
    company,
    title,
    location,
    remote: remote ? true : /\bonsite\b/i.test(text) ? false : null,
    employment_type: /\bintern(ship)?\b/i.test(text) ? "intern" : null,
    department: null,
    description_html: raw,
    description_text: text,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    clearance: null,
    apply_url: applyUrl,
    posted_at: comment.created_at ?? null,
  };
}

function extractCompany(firstLine: string): string {
  const pipeIdx = firstLine.indexOf("|");
  if (pipeIdx > 0) return firstLine.slice(0, pipeIdx).trim().slice(0, 80) || "HN";
  // Try "Company Name —" or "Company Name -"
  const dashMatch = firstLine.match(/^([^-—–:]{2,60})\s*[-—–:]/);
  if (dashMatch) return dashMatch[1]!.trim();
  // Fallback: first ~50 chars
  return firstLine.slice(0, 50).trim() || "HN";
}

function extractLocation(firstLine: string): string | null {
  // Look for a pipe-separated segment that contains a place-ish word.
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

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/ +/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}
