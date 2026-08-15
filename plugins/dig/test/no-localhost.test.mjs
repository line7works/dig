// AC5: the forbidden hostname word appears nowhere in the repo. Spotify
// rejects it, and stale examples containing it are a documented cause of
// failed setups. The two pre-existing reference docs (research + PRD) quote
// Spotify's rules and are excluded per user decision 2026-08-15.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, basename } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP_DIRS = new Set([".git", "node_modules"]);
const SKIP_FILES = [
  /^dig-research-\d{4}-\d{2}-\d{2}\.md$/,
  /^dig-prd-\d{4}-\d{2}-\d{2}\.md$/,
  // The build plan states the no-forbidden-hostname requirement, which takes
  // naming the word; same class as the two reference docs above.
  /^dig-build-plan\.md$/,
];

// Assembled so this test file itself stays clean under its own scan.
const FORBIDDEN = ["local", "host"].join("");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    if (SKIP_FILES.some((re) => re.test(basename(p)))) return [];
    return [p];
  });
}

test(`the string "${FORBIDDEN}" appears nowhere in the repo`, () => {
  const offenders = [];
  for (const p of walk(REPO_ROOT)) {
    const text = readFileSync(p, "utf8");
    if (text.toLowerCase().includes(FORBIDDEN)) offenders.push(relative(REPO_ROOT, p));
  }
  assert.deepEqual(offenders, [], `forbidden hostname found in: ${offenders.join(", ")}`);
});
