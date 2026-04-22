export interface StripHtmlOptions {
  // Convert <p>, </p>, and <br> to newlines and collapse spaces (not all
  // whitespace) so paragraph structure survives. HN comment text relies on
  // this; most API descriptions don't.
  preserveBreaks?: boolean;
}

export function stripHtml(html: string, opts?: StripHtmlOptions): string {
  let s = html;
  if (opts?.preserveBreaks) {
    s = s.replace(/<\/?p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  }
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  if (opts?.preserveBreaks) {
    return s.replace(/ +/g, " ").replace(/\n{2,}/g, "\n\n").trim();
  }
  return s.replace(/\s+/g, " ").trim();
}

export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}
