// PKCE sign-in flow (research §5): Client ID only, never a secret. The
// redirect URI is registered portless; the live port is chosen free at auth
// time by the callback server.
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { startCallbackServer, escapeHtml } from "./callback.mjs";
import { TokenStore, tokenFilePath } from "./token-store.mjs";
import { log } from "./log.mjs";

const AUTHORIZE_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const API_ME = "https://api.spotify.com/v1/me";

// Exactly these four scopes; notably not user-read-email (research §9).
export const SCOPES = "playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public";

export const ALLOWLIST_403_MESSAGE = `**Spotify signed you in, but your app hasn't been told to let you use it.**
Even though you own this app, Spotify makes you add yourself to it by hand.

1. Open your app at developer.spotify.com/dashboard
2. Click **Settings**, then the **User Management** tab
3. Add your name and **the email address on your Spotify account**. If you have several addresses, it has to be that one.
4. Wait about 15 minutes, then try again

The 15 minutes is real. It won't work immediately.`;

const PREMIUM_403_MESSAGE = `**Spotify requires a Premium subscription to run your own app.**
This changed in February 2026 and applies to everyone, even for something as simple as reading your own playlist. There's no workaround.

If you just subscribed, it can take a few hours before Spotify lets your app through.`;

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkcePair() {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  // macOS is the verified platform; xdg-open keeps it portable elsewhere.
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch (err) {
    log(`could not open browser: ${err?.message}`);
    return false;
  }
}

// Maps the post-exchange probe's failure to instructions (research §12).
export function mapProbeFailure(status, body) {
  if (status === 403) {
    const msg = typeof body?.error?.message === "string" ? body.error.message : "";
    if (/premium/i.test(msg)) return PREMIUM_403_MESSAGE;
    return ALLOWLIST_403_MESSAGE; // the most likely first-run failure
  }
  return `Spotify answered the first test call with an unexpected error (HTTP ${status}). Try again in a minute; if it keeps happening, ask Dig to run its checks.`;
}

// Active sign-in flow state, so dig_status can report an in-flight attempt
// and a second dig_connect can supersede a stalled one.
let activeFlow = null;
export function activeSignIn() {
  return activeFlow;
}

// Starts the browser sign-in. Returns immediately with the URLs; the
// exchange + probe complete inside the callback request, and the result
// lands in the token file and in activeFlow for dig_status to report.
export async function beginSignIn({ clientId, fetchImpl = fetch, store }) {
  if (activeFlow?.close) activeFlow.close();

  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(24));
  const tokenStore = store ?? new TokenStore({ file: tokenFilePath(), fetchImpl });

  const listener = await startCallbackServer({
    state,
    renderResult: async ({ code, page }) => {
      const res = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.refresh_token) {
        const e = new Error(`token exchange failed (${res.status}): ${body?.error_description || body?.error || "no refresh token"}`);
        e.publicMessage = "Spotify rejected the sign-in handshake. Go back to Claude and ask Dig to connect again.";
        throw e;
      }

      // Probe immediately (R5): the allowlist 403 is the most likely
      // first-run failure and must surface here, not on the first real call.
      const probe = await fetchImpl(API_ME, { headers: { Authorization: `Bearer ${body.access_token}` } });
      if (!probe.ok) {
        const probeBody = await probe.json().catch(() => ({}));
        const e = new Error(`probe failed (${probe.status})`);
        e.publicMessage = mapProbeFailure(probe.status, probeBody);
        activeFlow = { ...activeFlow, result: { ok: false, message: e.publicMessage } };
        throw e;
      }
      const me = await probe.json().catch(() => ({}));
      const displayName = me?.display_name || me?.id || "your Spotify account";

      // Persist only now: refresh token, absolute timestamp, client binding,
      // display name for status. Access token stays in memory.
      tokenStore.persist({
        refresh_token: body.refresh_token,
        obtained_at: Date.now(),
        client_id: clientId,
        display_name: displayName,
      });
      tokenStore.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000 };
      activeFlow = { ...activeFlow, result: { ok: true, displayName } };

      // R6: show who connected and offer the wrong-account retry.
      return page("Dig — connected", `<h1>Connected as ${displayName === "your Spotify account" ? "you" : `<strong>${escapeHtml(displayName)}</strong>`}.</h1>
<p>You can close this tab and go back to Claude.</p>
<p>Wrong account? Sign out of Spotify in your browser, then ask Dig to connect again.</p>`);
    },
  });

  const redirectUri = listener.redirectUri;
  const authUrl = new URL(AUTHORIZE_ENDPOINT);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();

  activeFlow = { startedAt: Date.now(), close: listener.close, result: null, referenceUrl: listener.referenceUrl };
  listener.done
    .then(() => log("sign-in flow completed"))
    .catch((e) => log(`sign-in flow ended: ${e?.message}`))
    .finally(() => { if (activeFlow) activeFlow.close = null; });

  const opened = openBrowser(authUrl.toString());
  return { authUrl: authUrl.toString(), referenceUrl: listener.referenceUrl, opened };
}
