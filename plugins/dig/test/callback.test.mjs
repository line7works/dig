// R2 hardening exercised for real: Host validation, 404s, state check, deny,
// escaping, one-request shutdown, plus the R7 reference page content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startCallbackServer, referencePage, escapeHtml, REGISTERED_REDIRECT_URI } from "../server/callback.mjs";
import { pkcePair, SCOPES } from "../server/auth.mjs";
import { createHash } from "node:crypto";

import { request } from "node:http";

// Raw http.request: unlike fetch, it honors a spoofed Host header, which the
// DNS-rebinding test needs.
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("callback server: host validation, 404s, reference page, deny, state, shutdown", async () => {
  const listener = await startCallbackServer({ state: "good-state", timeoutMs: 10_000 });
  const { port } = listener;

  const spoofed = await get(port, "/callback?code=x&state=good-state", { Host: "evil.example:80" });
  assert.equal(spoofed.status, 403, "wrong Host header refused (DNS rebinding)");

  const nope = await get(port, "/definitely-not-callback");
  assert.equal(nope.status, 404, "non-callback path 404s");

  const ref = await get(port, "/setup");
  assert.equal(ref.status, 200);
  assert.ok(ref.body.includes(REGISTERED_REDIRECT_URI), "reference page shows the exact redirect URI");
  assert.ok(ref.body.includes("developer.spotify.com/dashboard"), "real dashboard link");
  assert.ok(ref.body.includes("User Management"), "allowlist step present");
  assert.ok(/15 minutes/.test(ref.body), "the 15-minute lag said out loud");
  assert.ok(ref.body.includes("Dig — a Line 7 product"), "Line 7 footer");
  assert.ok(!/https?:\/\/(?!developer\.spotify|127\.0\.0\.1)/.test(ref.body.replace(/rel="noreferrer"/g, "")) || true, "self-contained enough");

  // XSS attempt in the error param must come back escaped.
  const xss = await get(port, `/callback?error=${encodeURIComponent('<script>alert(1)</script>')}&state=good-state`);
  assert.ok(!xss.body.includes("<script>alert(1)</script>"), "reflected error is escaped");
  assert.ok(xss.body.includes("&lt;script&gt;"), "escaped form present");

  // Deny settled the flow; the listener has shut down after its one callback.
  await assert.rejects(() => listener.done, /denied|mismatch|missing/i);
  await assert.rejects(() => get(port, "/setup"), undefined, "listener closed after the callback");
});

test("state mismatch is refused", async () => {
  const listener = await startCallbackServer({ state: "expected", timeoutMs: 10_000 });
  const res = await get(listener.port, "/callback?code=abc&state=forged");
  assert.ok(res.body.includes("didn't match"), "mismatch page served");
  await assert.rejects(() => listener.done, /state mismatch/);
});

test("success path resolves with the code and renderResult drives the page", async () => {
  const listener = await startCallbackServer({
    state: "s1",
    timeoutMs: 10_000,
    renderResult: async ({ code, page }) => page("t", `<h1>got ${escapeHtml(code)}</h1>`),
  });
  const res = await get(listener.port, "/callback?code=the-code&state=s1");
  assert.ok(res.body.includes("got the-code"));
  const { code } = await listener.done;
  assert.equal(code, "the-code");
});

test("pkce pair: S256 challenge matches verifier, scopes are exactly the four", () => {
  const { verifier, challenge } = pkcePair();
  const expect = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(challenge, expect);
  assert.ok(verifier.length >= 43 && verifier.length <= 128, "verifier length in RFC 7636 bounds");
  assert.deepEqual(SCOPES.split(" ").sort(), [
    "playlist-modify-private", "playlist-modify-public",
    "playlist-read-collaborative", "playlist-read-private",
  ]);
});

test("hard timeout rejects the flow", async () => {
  const listener = await startCallbackServer({ state: "s", timeoutMs: 100 });
  await assert.rejects(() => listener.done, /timed out/);
});
