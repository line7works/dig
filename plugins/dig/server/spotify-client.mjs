// One Spotify client for the whole server (slice C R4): every API call goes
// through ONE serialized queue — never parallel, because Spotify's rate
// limiter escalates on concurrency and the second, undocumented ceiling can
// answer with a Retry-After measured in hours (research §9).
import { checkClientId } from "./config.mjs";
import { TokenStore } from "./token-store.mjs";
import { RateLimitError, SpotifyApiError, mapSpotifyError } from "./error-map.mjs";
import { log } from "./log.mjs";

const API_BASE = "https://api.spotify.com/v1";

// Honor Retry-After exactly, but never block a tool call longer than this;
// past it, stop and tell the user how long Spotify asked for. The cap is per
// TOOL CALL, not per request: multi-request tools pass one waitBudget()
// object through every request they make, and each honored wait draws it
// down, so a tool spanning many requests can never accumulate minutes of
// silent blocking out of sub-60s waits.
const MAX_WAIT_MS = 60_000;

export function waitBudget() {
  return { remainingMs: MAX_WAIT_MS };
}

export class SpotifyClient {
  constructor({ store, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.store = store ?? new TokenStore({ fetchImpl });
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.chain = Promise.resolve(); // the one queue; requests append here
  }

  // Serialization: each request waits for every previously enqueued one,
  // success or failure, before touching the network.
  request(path, opts = {}) {
    // opts.budget: a waitBudget() shared across one tool call's requests.
    const run = () => this.#execute(path, opts);
    const result = this.chain.then(run, run);
    // The chain itself never rejects; callers see errors on `result`.
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  async #execute(path, { method = "GET", query, body, budget } = {}) {
    const id = checkClientId();
    if (id.state !== "ok") throw new SpotifyApiError(id.message, { endpoint: path });

    const url = new URL(API_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let retried401 = false;
    let retried429 = false;
    for (;;) {
      const token = await this.store.getAccessToken(id.clientId);
      const res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && !retried401) {
        // A 401 is authoritative regardless of the local clock: refresh and
        // retry exactly once (research §9).
        retried401 = true;
        this.store.invalidateAccess();
        continue;
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        const waitMs = retryAfter * 1000;
        const remaining = budget ? budget.remainingMs : MAX_WAIT_MS;
        if (retried429 || waitMs > remaining) {
          throw new RateLimitError(retryAfter);
        }
        log(`429 on ${path}, waiting ${retryAfter}s (Retry-After)`);
        retried429 = true;
        if (budget) budget.remainingMs -= waitMs;
        await this.sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new SpotifyApiError(mapSpotifyError(res.status, body, path), {
          status: res.status,
          endpoint: path,
        });
      }
      if (res.status === 204) return null;
      // Some write endpoints (PUT /playlists/{id}) answer 200 with an empty
      // body; res.json() would throw on it. Read text when the response
      // supports it (test doubles may only implement json()).
      if (typeof res.text === "function") {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      return res.json();
    }
  }
}

// The single shared instance every tool uses — module-level so no code path
// can construct a second, parallel queue by accident.
export const spotify = new SpotifyClient();
