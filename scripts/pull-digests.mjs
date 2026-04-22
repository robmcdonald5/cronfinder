#!/usr/bin/env node
// Pull daily digests from D1 into ./digests/ (gitignored).
// Usage:
//   npm run pull-digests                   # remote, missing only
//   npm run pull-digests -- --overwrite    # remote, overwrite local (npm eats --force)
//   npm run pull-digests -- --local        # local D1 (dev smoke test)
//
// wrangler's --json output with --remote can be preceded by progress lines
// (e.g. "├ Checking if file needs uploading"), so we extract the JSON array
// from the captured stdout by scanning from the last ']' backward to its
// matching '['.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIGESTS_DIR = "./digests";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCOPE_FLAG = process.argv.includes("--local") ? "--local" : "--remote";

function extractJsonArray(out) {
  const close = out.lastIndexOf("]");
  if (close === -1) {
    throw new Error(`no JSON array in wrangler output:\n${out.slice(0, 500)}`);
  }
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = out[i];
    if (ch === "]") depth++;
    else if (ch === "[") {
      depth--;
      if (depth === 0) {
        return JSON.parse(out.slice(i, close + 1));
      }
    }
  }
  throw new Error(`unbalanced brackets in wrangler output:\n${out.slice(0, 500)}`);
}

function runWranglerJson(sql) {
  // Pass the whole invocation as one string so the shell treats the SQL as a
  // single argument. All SQL is constructed in this file from validated date
  // ids (DATE_RE), so there are no double quotes or shell metachars to worry
  // about; the embedded `"${sql}"` stays intact.
  if (sql.includes('"')) {
    throw new Error(`refusing to pass SQL containing double quotes: ${sql}`);
  }
  const cmd = `npx wrangler d1 execute cronfinder ${SCOPE_FLAG} --json --command "${sql}"`;
  const out = execSync(cmd, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const parsed = extractJsonArray(out);
  return parsed[0]?.results ?? [];
}

function main() {
  // `--force` clashes with npm's own --force flag, which npm consumes before it
  // reaches the script. Use `--overwrite` instead.
  const force = process.argv.includes("--overwrite") || process.argv.includes("--force");
  if (!existsSync(DIGESTS_DIR)) mkdirSync(DIGESTS_DIR, { recursive: true });

  const local = new Set(
    readdirSync(DIGESTS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, "")),
  );

  const idRows = runWranglerJson("SELECT id FROM digests ORDER BY id");
  const remoteIds = idRows
    .map((r) => r.id)
    .filter((id) => typeof id === "string" && DATE_RE.test(id));

  const wanted = force ? remoteIds : remoteIds.filter((id) => !local.has(id));
  if (wanted.length === 0) {
    console.log(
      `digests: up to date (${remoteIds.length} remote, ${local.size} local).`,
    );
    return;
  }

  for (const id of wanted) {
    const rows = runWranglerJson(`SELECT body FROM digests WHERE id = '${id}'`);
    const body = rows[0]?.body;
    if (typeof body !== "string") {
      console.warn(`digests: no body for ${id}, skipping`);
      continue;
    }
    const path = join(DIGESTS_DIR, `${id}.md`);
    writeFileSync(path, body, "utf-8");
    console.log(`digests: wrote ${path}`);
  }
}

main();
