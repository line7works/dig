// R3: server-side Client ID shape validation (32 chars alphanumeric) with the
// research §12 message copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClientId } from "../server/config.mjs";

const VALID = "a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4";

test("valid 32-char alphanumeric id accepted", () => {
  const r = checkClientId(VALID);
  assert.equal(r.state, "ok");
  assert.equal(r.clientId, VALID);
});

test("blank, missing, and whitespace ids are unconfigured", () => {
  for (const raw of ["", "   ", undefined, null]) {
    assert.equal(checkClientId(raw).state, "unconfigured", `raw=${JSON.stringify(raw)}`);
  }
});

test("wrong-shape ids rejected with the draft copy", () => {
  for (const raw of ["not-an-id", VALID + "x", VALID.slice(0, 31), "a".repeat(31) + "-", "My Cool App"]) {
    const r = checkClientId(raw);
    assert.equal(r.state, "invalid", `raw=${raw}`);
    assert.match(r.message, /That doesn't look like a Client ID/);
    assert.match(r.message, /Client Secret/);
  }
});

test("valid id with surrounding whitespace is trimmed and accepted", () => {
  assert.equal(checkClientId(`  ${VALID}\n`).state, "ok");
});
