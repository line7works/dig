// Failure-path outcomes: every way a sign-in can end must leave a reportable
// result — dig_status may never claim "in progress" about a finished flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSignIn, activeSignIn } from "../server/auth.mjs";
import { TokenStore } from "../server/token-store.mjs";

process.env.DIG_NO_BROWSER = "1";
process.env.CLAUDE_PLUGIN_DATA ??= mkdtempSync(join(tmpdir(), "dig-authflow-"));

const CLIENT = "a".repeat(32);

function neutralStore(fetchImpl) {
  return new TokenStore({ file: join(mkdtempSync(join(tmpdir(), "dig-authflow-")), "token.json"), fetchImpl });
}

async function begin(fetchImpl = async () => { throw new Error("no network expected"); }) {
  // openBrowser spawns `open` on a URL; neutralize via PATH shim if present —
  // tests tolerate a browser NOT opening (opened flag unasserted here).
  return beginSignIn({ clientId: CLIENT, fetchImpl, store: neutralStore(fetchImpl) });
}

function callbackOrigin(authUrl) {
  return new URL(new URL(authUrl).searchParams.get("redirect_uri")).origin;
}

test("deny leaves a reportable failed result, not in-progress", async () => {
  const { authUrl } = await begin();
  const origin = callbackOrigin(authUrl);
  const state = new URL(authUrl).searchParams.get("state");
  await fetch(`${origin}/callback?error=access_denied&state=${encodeURIComponent(state)}`);
  await new Promise((r) => setTimeout(r, 50));
  const flow = activeSignIn();
  assert.ok(flow.result, "flow has a result");
  assert.equal(flow.result.ok, false);
  assert.match(flow.result.message, /Cancel/i);
});

test("state mismatch leaves a reportable failed result", async () => {
  const { authUrl } = await begin();
  await fetch(`${callbackOrigin(authUrl)}/callback?code=x&state=forged`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(activeSignIn().result?.ok, false);
  assert.match(activeSignIn().result.message, /didn't match/);
});

test("exchange failure leaves the mapped failure message", async () => {
  const failingFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
  const { authUrl } = await begin(failingFetch);
  const origin = callbackOrigin(authUrl);
  const state = new URL(authUrl).searchParams.get("state");
  await fetch(`${origin}/callback?code=abc&state=${encodeURIComponent(state)}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(activeSignIn().result?.ok, false);
  assert.match(activeSignIn().result.message, /rejected the sign-in handshake/);
});

test("superseding flow: old flow marked superseded, new flow untouched by old failure", async () => {
  const first = await begin();
  const firstFlow = activeSignIn();
  const second = await begin();
  const secondFlow = activeSignIn();
  assert.notEqual(firstFlow, secondFlow, "new flow record");
  assert.equal(firstFlow.superseded, true);
  assert.equal(secondFlow.superseded, false);
  assert.equal(secondFlow.result, null, "new flow reports fresh state");
  // Old flow's late failure lands on the OLD record only.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(secondFlow.result, null);
  assert.notEqual(second.authUrl, first.authUrl);
  secondFlow.close?.();
});
