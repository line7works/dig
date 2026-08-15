// R5: the lint-as-test. Fails on any console.log/info/debug/warn/error in
// server source, and on any process.stdout touch outside the transport file
// (server/index.mjs), which is the single sanctioned protocol writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

const sources = readdirSync(SERVER_DIR).filter((f) => f.endsWith(".mjs"));

test("no console.* anywhere in server source", () => {
  for (const file of sources) {
    const text = readFileSync(join(SERVER_DIR, file), "utf8");
    assert.ok(
      !/\bconsole\s*\.\s*(log|info|debug|warn|error|trace)\b/.test(text),
      `${file} uses console.*; all logging must go through log.mjs to stderr`,
    );
  }
});

test("process.stdout only in the transport file", () => {
  for (const file of sources) {
    if (file === "index.mjs") continue;
    const text = readFileSync(join(SERVER_DIR, file), "utf8");
    assert.ok(
      !text.includes("process.stdout"),
      `${file} touches process.stdout; only server/index.mjs may write the protocol channel`,
    );
  }
});
