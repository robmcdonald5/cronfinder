// Lever company slugs. The slug is the `{company}` in
// https://jobs.lever.co/{company} / https://api.lever.co/v0/postings/{company}.
//
// Most high-profile tech companies have migrated off Lever to Greenhouse or
// Ashby. This list is intentionally small — add a slug here only after
// confirming it returns 200 from the API.

export const LEVER_COMPANIES: readonly string[] = [
  "palantir",
  "ro",
] as const;
