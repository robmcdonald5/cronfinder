#!/usr/bin/env node
// Pull daily digests from remote D1 into ./digests/ (gitignored).
// Usage: npm run pull-digests [-- --force]
//
//   (no flag): fetch only digest ids that aren't already present locally.
//   --force:   overwrite local files.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIGESTS_DIR = "./digests";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SCOPE_FLAG = process.argv.includes("--local") ? "--local" : "--remote";

// Passes SQL via a temp file (--file) instead of --command to avoid
// shell-quoting pain on Windows vs. *nix when using `shell: true`.
function runWranglerJson(sql) {
  const dir = mkdtempSync(join(tmpdir(), "cronfinder-"));
  const file = join(dir, "query.sql");
  writeFileSync(file, sql, "utf-8");
  try {
    const out = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "cronfinder",
        SCOPE_FLAG,
        "--json",
        "--file",
        file,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        shell: true,
      },
    );
    const parsed = JSON.parse(out);
    return parsed[0]?.results ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const force = process.argv.includes("--force");
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
