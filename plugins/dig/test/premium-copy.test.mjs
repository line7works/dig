// Slice H AC2: the Premium requirement is stated in all four artifact
// locations (PRD §3 — the fifth place, the runtime error, landed in slice G
// and is covered by the error-map tests). The README check is positional:
// Premium must appear in the first paragraph, above the install instructions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const LOCATIONS = [
  ["README.md", join(REPO_ROOT, "README.md")],
  [".claude-plugin/marketplace.json", join(REPO_ROOT, ".claude-plugin/marketplace.json")],
  ["plugins/dig/.claude-plugin/plugin.json", join(REPO_ROOT, "plugins/dig/.claude-plugin/plugin.json")],
  ["plugins/dig/skills/setup/SKILL.md", join(REPO_ROOT, "plugins/dig/skills/setup/SKILL.md")],
];

for (const [label, path] of LOCATIONS) {
  test(`Premium requirement stated in ${label}`, () => {
    const text = readFileSync(path, "utf8");
    assert.match(text, /Spotify Premium/, `${label} must state the Spotify Premium requirement`);
  });
}

test("README states Premium in the first paragraph, above the install instructions", () => {
  const text = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const premiumAt = text.indexOf("Spotify Premium");
  const installAt = text.search(/^## Install/m);
  assert.ok(premiumAt !== -1, "README must mention Spotify Premium");
  assert.ok(installAt !== -1, "README must have an Install section");
  assert.ok(
    premiumAt < installAt,
    "Spotify Premium must appear before the Install section",
  );
  // First paragraph = before the first section heading after the title.
  const firstHeadingAt = text.search(/^## /m);
  assert.ok(
    premiumAt < firstHeadingAt,
    "Spotify Premium must appear in the opening paragraph, before any section",
  );
});

test("setup skill states Premium in step 0", () => {
  const text = readFileSync(
    join(REPO_ROOT, "plugins/dig/skills/setup/SKILL.md"),
    "utf8",
  );
  const step0 = text.match(/^## Step 0[^\n]*\n([\s\S]*?)(?=^## )/m);
  assert.ok(step0, "setup skill must have a Step 0 section");
  assert.match(step0[1], /Spotify Premium/, "Step 0 must state the Premium requirement");
});
