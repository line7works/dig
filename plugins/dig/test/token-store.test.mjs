// AC4: rotation ordering and lock behavior against a mocked token endpoint.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TokenStore, writeFileAtomic0600, readTokenFile, acquireLock, ageWarning,
  AuthExpiredError, EXPIRED_CONNECTION_MESSAGE,
} from "../server/token-store.mjs";

const DAY = 86_400_000;
let dir, file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dig-token-"));
  file = join(dir, "token.json");
});

function seed(record) {
  writeFileAtomic0600(file, JSON.stringify(record));
}

// A mock Spotify token endpoint that rotates the refresh token on every use
// and kills the old one, like the real one does under PKCE.
function rotatingEndpoint() {
  const state = { current: "rt-1", calls: 0, dead: new Set() };
  const fetchImpl = async (url, opts) => {
    state.calls++;
    const sent = new URLSearchParams(opts.body).get("refresh_token");
    if (state.dead.has(sent) || sent !== state.current) {
      return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
    }
    state.dead.add(sent);
    state.current = `rt-${state.calls + 1}`;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `at-${state.calls}`, refresh_token: state.current, expires_in: 3600 }),
    };
  };
  return { state, fetchImpl };
}

test("token file is written 0600 atomically and self-heals on read", () => {
  seed({ refresh_token: "rt-1", obtained_at: Date.now() });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(file, 0o644);
  const rec = readTokenFile(file);
  assert.equal(rec.refresh_token, "rt-1");
  assert.equal(statSync(file).mode & 0o777, 0o600, "permissions healed back to 0600");
});

test("rotated refresh token is persisted before the access token is exposed", async () => {
  seed({ refresh_token: "rt-1", obtained_at: Date.now(), client_id: "c" });
  const { fetchImpl } = rotatingEndpoint();
  let persistedAtReturn = null;
  const store = new TokenStore({ file, fetchImpl });
  const origPersist = store.persist.bind(store);
  store.persist = (rec) => { origPersist(rec); persistedAtReturn = readTokenFile(file).refresh_token; };
  const token = await store.getAccessToken("c");
  assert.equal(token, "at-1");
  assert.equal(persistedAtReturn, "rt-2", "new refresh token hit disk during refresh");
  assert.equal(readTokenFile(file).refresh_token, "rt-2");
});

test("crash between refresh and persist leaves the previous file usable (atomic write)", async () => {
  seed({ refresh_token: "rt-1", obtained_at: Date.now() });
  // Simulate the crash: the persist step dies mid-write (before rename).
  const { fetchImpl } = rotatingEndpoint();
  const store = new TokenStore({ file, fetchImpl });
  store.persist = () => { throw new Error("simulated crash during persist"); };
  await assert.rejects(() => store.getAccessToken("c"), /simulated crash/);
  const rec = readTokenFile(file);
  assert.equal(rec.refresh_token, "rt-1", "file still parses and holds the pre-refresh token");
  assert.ok(!existsSync(`${file}.lock`), "lock released after failure");
});

test("concurrent refresh does not clobber: lock serializes and second caller reuses", async () => {
  seed({ refresh_token: "rt-1", obtained_at: Date.now() });
  const { state, fetchImpl } = rotatingEndpoint();
  // Two separate store instances = two server processes sharing the file.
  const a = new TokenStore({ file, fetchImpl });
  const b = new TokenStore({ file, fetchImpl });
  const [ta, tb] = await Promise.all([a.getAccessToken("c"), b.getAccessToken("c")]);
  assert.ok(ta && tb, "both callers got access tokens");
  assert.equal(readTokenFile(file).refresh_token, state.current, "file holds the latest rotation");
  // The loser of the lock race re-read the rotated token instead of sending
  // the dead one — if it had used its stale copy, invalid_grant would have
  // signed us out and deleted the file.
  assert.ok(existsSync(file), "no caller was signed out by a stale-token refresh");
});

test("invalid_grant discards the token and raises the expired-connection copy", async () => {
  seed({ refresh_token: "rt-dead", obtained_at: Date.now() - 200 * DAY });
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
  const store = new TokenStore({ file, fetchImpl });
  await assert.rejects(() => store.getAccessToken("c"), AuthExpiredError);
  assert.equal(readTokenFile(file), null, "token file discarded");
  assert.match(EXPIRED_CONNECTION_MESSAGE, /expire after six months/);
});

test("client id mismatch forces re-auth instead of confusing failures", async () => {
  seed({ refresh_token: "rt-1", obtained_at: Date.now(), client_id: "old-app" });
  const store = new TokenStore({ file, fetchImpl: async () => { throw new Error("endpoint must not be called"); } });
  await assert.rejects(() => store.getAccessToken("new-app"), AuthExpiredError);
  assert.equal(readTokenFile(file), null);
});

test("age warning fires past five months, silent before", () => {
  assert.equal(ageWarning({ obtained_at: Date.now() - 30 * DAY }), null);
  assert.match(ageWarning({ obtained_at: Date.now() - 160 * DAY }), /five months/);
});

test("stale lock is broken instead of deadlocking", async () => {
  writeFileSync(`${file}.lock`, "999999");
  const old = Date.now() / 1000 - 120;
  const { utimesSync } = await import("node:fs");
  utimesSync(`${file}.lock`, old, old);
  const release = await acquireLock(file, { timeoutMs: 1000, staleMs: 30_000 });
  release();
  assert.ok(!existsSync(`${file}.lock`));
});
