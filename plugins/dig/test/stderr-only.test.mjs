// R5: the lint-as-test. Fails on console use or stdout access in server
// source — including bracket-access evasions, dot-form aliases that write to
// stdout (dir, table), destructured stdout, and files in subdirectories.
// process.stdout stays allowed ONLY in the transport file (server/index.mjs),
// which is the single sanctioned protocol writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(mjs|cjs|js)$/.test(e.name) ? [p] : [];
  });
}

// Scan code, not prose: drop full-line and trailing // comments (no string in
// the server legitimately contains "//", so the cheap strip is safe here).
function stripComments(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const sources = walk(SERVER_DIR).map((p) => ({
  file: relative(SERVER_DIR, p),
  text: stripComments(readFileSync(p, "utf8")),
}));

test("server source files were found", () => {
  assert.ok(sources.length >= 4, `expected server sources, found ${sources.length}`);
});

test("no console use anywhere in server source", () => {
  for (const { file, text } of sources) {
    // Any mention of console at all: catches console.log, console["log"],
    // console.dir/table, aliasing (const c = console), and node:console imports.
    assert.ok(
      !/\bconsole\b/.test(text) && !text.includes("node:console"),
      `${file} references console; all logging must go through log.mjs to stderr`,
    );
  }
});

test("stdout only touchable from the transport file", () => {
  for (const { file, text } of sources) {
    if (file === "index.mjs") continue;
    assert.ok(
      !/\bstdout\b/.test(text),
      `${file} references stdout; only server/index.mjs may write the protocol channel`,
    );
  }
});

test("transport file touches stdout only via process.stdout.write", () => {
  const index = sources.find((s) => s.file === "index.mjs");
  const mentions = index.text.match(/\bstdout\b/g) ?? [];
  const sanctioned = index.text.match(/process\.stdout\.write\(/g) ?? [];
  assert.equal(
    mentions.length,
    sanctioned.length,
    "every stdout mention in index.mjs must be a direct process.stdout.write call (no aliasing/destructuring)",
  );
});
