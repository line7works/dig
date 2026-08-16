// Server instructions (slice C R7): the ≤2 KB text loaded once at session
// start. Cross-cutting rules live HERE once, not repeated per tool
// (research §6 — the real context budget is this text, not the tool count).

export const SERVER_INSTRUCTIONS = `Dig manages the user's own Spotify playlists. Rules that apply to every tool:

- Works only on playlists the connected account owns or collaborates on. Friends' and Spotify editorial lists (Discover Weekly etc.) are closed to this app type — Spotify's rule.
- Setup: dig_status shows the current state; dig_connect starts the browser sign-in. If tools report a missing Client ID or expired connection, follow the instructions in the tool result rather than improvising.
- Reads are compact by default (pass detail:"standard"|"full" for more) and paginated. When a reply names a next call, use exactly that call to continue; when it says it reached the end, stop. For "how many / which ones" questions, use dig_find_in_playlist or dig_diff_playlists — they answer with counts plus a sample, and say when a sample is truncated.
- To find a track inside a playlist, use dig_find_in_playlist (Spotify itself cannot search within a playlist; catalog search is dig_search_catalog). Catalog search returns at most 10 results — refine the query rather than paging.
- dig_get_tracks costs one Spotify request per ID (batch lookups no longer exist); keep lists to a few tracks.
- All Spotify calls run through one serialized queue — issue them one at a time. If a result says Spotify asked for a wait (rate limit), stop calling and tell the user how long; retrying sooner makes the wait grow.
- dig_add_tracks verifies every proposal first: uncertain matches come back as questions, NEVER added — relay them, report misses honestly, never pad a list.
- Every write reports verified | accepted | ambiguous | partial from a re-read. Anything but verified: re-read before acting; never blind-retry a write.
- Removal is two-step: show dig_plan_removal's plan to the user; call dig_apply_removal only after they approve. A snapshot is saved first; dig_restore_snapshot rebuilds from one.
- Error results are instructions: they name the cause and the user's next action in plain language. Relay them; do not retry the same call unchanged.`;
