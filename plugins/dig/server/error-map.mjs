// Errors are instructions (slice C R5, PRD §10): no raw Spotify error ever
// reaches the user. Every failure maps status + endpoint to a plain-language
// cause and next action, returned as an isError tool result — never a
// protocol error, which the model cannot see (research §6).

export const ALLOWLIST_403_MESSAGE = `**Spotify signed you in, but your app hasn't been told to let you use it.**
Even though you own this app, Spotify makes you add yourself to it by hand.

1. Open your app at developer.spotify.com/dashboard
2. Open the **User Management** tab (next to Basic Information)
3. Enter your name and **the email address on your Spotify account** (if you have several addresses, it has to be that one), then click **Add user**
4. Wait about 15 minutes, then try again

The 15 minutes is real. It won't work immediately.`;

export const PREMIUM_403_MESSAGE = `**Spotify requires a Premium subscription to run your own app.**
This changed in February 2026 and applies to everyone, even for something as simple as reading your own playlist. There's no workaround.

If you just subscribed, it can take a few hours before Spotify lets your app through.`;

// Thrown by the queue when Spotify asks for a wait longer than a tool call
// may block (research §9 rate limiting).
export class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(rateLimitMessage(retryAfterSeconds));
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function rateLimitMessage(seconds) {
  const human =
    seconds >= 3600 ? `about ${Math.round(seconds / 3600)} hour(s)` :
    seconds >= 60 ? `about ${Math.round(seconds / 60)} minute(s)` :
    `${seconds} seconds`;
  return `**Spotify is rate-limiting this app right now.**
Spotify asked Dig to wait ${human} before trying again, which is longer than a tool call may block. Nothing is broken and nothing was lost.

Wait that long, then try again. Doing lots of rapid requests makes the wait grow, so going slower helps.`;
}

// Carries the mapped, user-facing message for a failed Spotify call.
export class SpotifyApiError extends Error {
  constructor(message, { status, endpoint } = {}) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

// Maps an unexpected response to instructions. 401 is handled upstream by the
// client's refresh-then-retry-once; it lands here only when the retry failed.
export function mapSpotifyError(status, body, endpoint = "") {
  const apiMsg = typeof body?.error?.message === "string" ? body.error.message : "";
  if (status === 403) {
    if (/premium/i.test(apiMsg)) return PREMIUM_403_MESSAGE;
    // Only a SPECIFIC playlist's endpoints suggest an ownership problem.
    // /me/... endpoints (like /me/playlists) are the user's own data — a 403
    // there is the allowlist trap, the most likely first-run failure.
    if (/^\/playlists\//.test(endpoint)) {
      return `**Spotify refused access to that playlist.**
Dig can only work on playlists your account owns or collaborates on — Spotify closed everything else (friends' playlists, Discover Weekly and other editorial lists) to apps like this one.

If this IS your playlist, the likely cause is the User Management step: ${ALLOWLIST_403_MESSAGE}`;
    }
    return ALLOWLIST_403_MESSAGE;
  }
  if (status === 404) {
    return `**Spotify couldn't find that.**
The ID Dig asked about doesn't exist for your account — it may have been deleted, or the ID was copied wrong. List your playlists again and use an ID from that answer.`;
  }
  if (status === 401) {
    return `**Spotify stopped accepting Dig's sign-in.**
Refreshing the connection didn't help, so the cleanest fix is to reconnect: ask Dig to connect to Spotify again and approve the same screen you saw the first time.`;
  }
  if (status >= 500) {
    return `**Spotify itself is having trouble right now** (it answered ${status}).
Nothing is wrong on your side. Wait a minute and try again.`;
  }
  return `**Spotify answered with an unexpected error** (HTTP ${status}${apiMsg ? `: ${apiMsg}` : ""}).
Try again in a minute; if it keeps happening, ask Dig to check its own status.`;
}
