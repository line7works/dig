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
// past it, stop and tell the user how long Spotify asked for.
const MAX_WAIT_MS = 60_000;

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
    const run = () => this.#execute(path, opts);
    const result = this.chain.then(run, run);
    // The chain itself never rejects; callers see errors on `result`.
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  async #execute(path, { method = "GET", query } = {}) {
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
        headers: { Authorization: `Bearer ${token}` },
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
        if (retried429 || retryAfter * 1000 > MAX_WAIT_MS) {
          throw new RateLimitError(retryAfter);
        }
        log(`429 on ${path}, waiting ${retryAfter}s (Retry-After)`);
        retried429 = true;
        await this.sleep(retryAfter * 1000);
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
      return res.json();
    }
  }
}

// The single shared instance every tool uses — module-level so no code path
// can construct a second, parallel queue by accident.
export const spotify = new SpotifyClient();
