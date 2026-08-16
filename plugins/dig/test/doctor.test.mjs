// AC2 (slice G): dig_doctor distinguishes unconfigured, bad-shape ID,
// no token, expired token (mocked), and healthy — each failure carrying its
// research §12 instruction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDoctorTool } from "../server/doctor.mjs";
import { checkClientId, UNCONFIGURED_MESSAGE, BAD_CLIENT_ID_MESSAGE } from "../server/config.mjs";
import { AuthExpiredError, EXPIRED_CONNECTION_MESSAGE } from "../server/token-store.mjs";
import { SpotifyApiError, ALLOWLIST_403_MESSAGE, PREMIUM_403_MESSAGE } from "../server/error-map.mjs";

const GOOD_ID = "a".repeat(32);
const RECORD = { refresh_token: "r", obtained_at: Date.now() - 3 * 86_400_000, display_name: "Test User" };

function doctor({ id = GOOD_ID, record = RECORD, probe, signIn = () => null } = {}) {
  const client = {
    request: probe ?? (async () => ({ display_name: "Test User" })),
  };
  const [{ def, handler }] = createDoctorTool({
    client,
    deps: { check: () => checkClientId(id), readToken: () => record, signIn },
  });
  return { def, run: () => handler({}) };
}

test("tool definition: read access, dig_ name", () => {
  const { def } = doctor();
  assert.equal(def.name, "dig_doctor");
  assert.equal(def.annotations.readOnlyHint, true);
  assert.equal(def.annotations.destructiveHint, false);
});

test("unconfigured: reports it, carries the setup copy, stops early", async () => {
  const probe = async () => { throw new Error("must not probe"); };
  const res = await doctor({ id: "", probe }).run();
  assert.equal(res.isError, false);
  assert.match(res.text, /✗ Client ID: not configured/);
  assert.ok(res.text.includes(UNCONFIGURED_MESSAGE));
  assert.match(res.text, /stopped here/);
});

test("bad-shape ID: reports it with the that-doesn't-look-like copy", async () => {
  const res = await doctor({ id: "not-a-client-id", probe: async () => { throw new Error("must not probe"); } }).run();
  assert.match(res.text, /✗ Client ID: configured but the wrong shape/);
  assert.ok(res.text.includes(BAD_CLIENT_ID_MESSAGE));
});

test("no token: says sign in, includes the redirect-mismatch hint with the exact URI", async () => {
  const res = await doctor({ record: null, probe: async () => { throw new Error("must not probe"); } }).run();
  assert.match(res.text, /✗ Spotify connection: no sign-in stored/);
  assert.match(res.text, /dig_connect/);
  assert.match(res.text, /Redirect URIs/);
  assert.match(res.text, /http:\/\/127\.0\.0\.1:\d+\/callback/);
});

test("no token + failed last sign-in: surfaces that flow's failure message", async () => {
  const res = await doctor({
    record: null,
    probe: async () => { throw new Error("must not probe"); },
    signIn: () => ({ result: { ok: false, message: "You clicked Cancel on the Spotify screen." } }),
  }).run();
  assert.match(res.text, /last sign-in attempt did not finish/);
  assert.match(res.text, /clicked Cancel/);
});

test("expired token (mocked invalid_grant path): carries the expired-connection copy", async () => {
  const res = await doctor({ probe: async () => { throw new AuthExpiredError(); } }).run();
  assert.match(res.text, /✓ Spotify connection: signed in as Test User/);
  assert.match(res.text, /✗ Live Spotify call/);
  assert.ok(res.text.includes(EXPIRED_CONNECTION_MESSAGE));
});

test("allowlist 403 on the probe: carries the User Management copy", async () => {
  const res = await doctor({ probe: async () => { throw new SpotifyApiError(ALLOWLIST_403_MESSAGE, { status: 403, endpoint: "/me" }); } }).run();
  assert.ok(res.text.includes(ALLOWLIST_403_MESSAGE));
});

test("premium 403 on the probe: carries the Premium copy", async () => {
  const res = await doctor({ probe: async () => { throw new SpotifyApiError(PREMIUM_403_MESSAGE, { status: 403, endpoint: "/me" }); } }).run();
  assert.ok(res.text.includes(PREMIUM_403_MESSAGE));
});

test("five-month-old token: healthy run still carries the age warning", async () => {
  const old = { ...RECORD, obtained_at: Date.now() - 155 * 86_400_000 };
  const res = await doctor({ record: old }).run();
  assert.match(res.text, /over five months old/);
  assert.match(res.text, /✓ Live Spotify call: succeeded/);
});

test("healthy: all three checks pass and it says ready", async () => {
  const res = await doctor().run();
  assert.equal(res.isError, false);
  assert.match(res.text, /✓ Client ID/);
  assert.match(res.text, /✓ Spotify connection/);
  assert.match(res.text, /✓ Live Spotify call: succeeded \(connected account: Test User\)/);
  assert.match(res.text, /ready to use/);
  assert.doesNotMatch(res.text, /✗/);
});

test("unknown probe failure: honest fallback, not a crash", async () => {
  const res = await doctor({ probe: async () => { throw new TypeError("fetch failed"); } }).run();
  assert.equal(res.isError, false);
  assert.match(res.text, /✗ Live Spotify call: failed unexpectedly \(fetch failed\)/);
});
