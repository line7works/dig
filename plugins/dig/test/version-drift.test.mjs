// Version drift guard (slice A punch-list MINOR, live at every release
// bump): plugin.json is the single source of truth — serverInfo already
// reads it at runtime (index.mjs), so this pins the one copy that can still
// drift, package.json. `claude plugin update` keys on plugin.json's version,
// so a stale sibling is a real release hazard, not cosmetics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

function readVersion(rel) {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, rel), "utf8")).version;
}

test("package.json version matches plugin.json (the release source of truth)", () => {
  const plugin = readVersion(".claude-plugin/plugin.json");
  const pkg = readVersion("package.json");
  assert.equal(pkg, plugin, "bump package.json and plugin.json together");
});

test("plugin.json version is a plain semver triple", () => {
  const plugin = readVersion(".claude-plugin/plugin.json");
  assert.match(plugin, /^\d+\.\d+\.\d+$/);
});
