# Dig — build plan (2026-08-15)

Intent: Dig is a Line 7 product — a Claude Code plugin that lets Tony's non-technical friends manage their own Spotify playlists by talking to Claude: create, rename, add verified tracks, reorder, find-in-playlist, diff, dedupe, and the signature "grow a playlist by feel" flow where Claude proposes tracks from its own music knowledge and Dig verifies each one against Spotify before adding. Each user registers their own Spotify developer app and authenticates with PKCE; Tony hosts nothing and holds nothing of theirs. The product bar: a friend who does not code goes from never having heard of Dig to a working playlist edit in under fifteen minutes, with no terminal, no file editing, and no help from Tony.

Full product requirements: `docs/dig-prd-2026-08-12.md`. Full research with sources: `docs/dig-research-2026-08-12.md` (authoritative where the two disagree). Both live in this repo. The builder MUST read both before slice A; requirements below cite them rather than restate every detail.

Constraints:
- Repo: `~/Developer/dig`, standalone. Public GitHub repo `line7works/dig` comes later (the `line7works` org exists as of 2026-08-15, created by Tony; his personal account is `tiny-tunnel-dot`) — **creating the GitHub repo and any push happens only on Tony's explicit word** (his global git gates). All slices work locally.
- Language: Node, no Spotify SDK — call the REST API directly (research §5, §9). MCP protocol layer is the builder's choice (hand-rolled stdio was proven in `~/Developer/dig-plugin-test`; the official MCP SDK is acceptable since lockfile deps auto-install).
- Plugin layout per research §5 "File layout": repo root is its own marketplace (`.claude-plugin/marketplace.json`), plugin at `plugins/dig/` with `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `server/`, `package.json` **plus committed lockfile** (without it, deps silently never install).
- Spotify API: the **February 2026 surface only** — `/playlists/{id}/items` (never `/tracks`), `items`/`item` response fields, `POST /me/playlists`, search limit max 10, no batch fetches, no `/recommendations`. The changelog is the authority, not the reference pages (research §2).
- Auth: PKCE, Client ID only, never a client secret. Redirect URI uses a loopback IP literal; the word `localhost` appears nowhere in the repo (research §5, PRD §9). Scopes: exactly `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, `playlist-modify-public`.
- Client ID capture: plugin `userConfig`, with `required` and `sensitive` both OMITTED (each trips a live bug that silently breaks install — research §5). Validate in the server, fail loudly with instructions.
- All logging to stderr, enforced by a lint rule; one stdout write corrupts the stdio protocol (research §9).
- Persistent state (tokens, snapshots, index cache) in the plugin data directory (`CLAUDE_PLUGIN_DATA`), absolute path, never derived from the working directory, never `CLAUDE_PLUGIN_ROOT` (changes on update), never project-local files (CVE-2025-59536).
- Tool naming: `dig_` prefix, lowercase snake_case. Target 12–16 tools. Server instructions text under 2 KB carrying the cross-cutting rules once.
- Test command: `npm test` in `plugins/dig/` running `node --test` (zero test-framework dependencies).
- Live verification uses a **fresh Spotify app Tony registers by following Dig's own instructions** as they are built — this dogfoods onboarding. Do not reuse the claude-radio app or `~/.config/spotify` credentials.
- Platform: macOS is the verified platform; keep code portable but no Windows/Linux verification.
- Errors are instructions: no raw Spotify error ever reaches the user; map status + endpoint to plain-language cause and next action (PRD §10, research §12 draft copy).

Out of scope:
- Playback, library management, other people's playlists, editorial playlists, non-Spotify services — PRD §4, product decisions and API restrictions.
- Cover art — cut from v1 to v1.1, Tony's decision 2026-08-14.
- Claude Radio integration — permanently separate, Tony's decision 2026-08-14.
- macOS Keychain token storage — deferred; v1 uses the 0600 atomic file pattern (already stronger than the library that drew CVE-2025-27154). Keychain adds a native dependency for marginal gain on a loopback-only secret.
- Anthropic community-marketplace submission — possible later step, not a launch requirement (PRD §8).
- Windows/Linux install verification — Tony's decision 2026-08-15; README states macOS is what's tested.
- Creating the GitHub repo / pushing / publishing — gated on Tony's word; no slice includes it.
- Single-occurrence duplicate removal — impossible since Spotify dropped `positions` in 2024; the only implementation is remove-all-then-re-add with the position loss disclosed BEFORE acting (research §9).

## Slice A — Plugin skeleton that installs and answers
Goal: A real installable plugin whose MCP server starts from a marketplace install and answers a status tool, with the config, logging, and layout rules locked in from the first commit.
Requirements:
- R1: Repo layout per Constraints (marketplace root + `plugins/dig/`), with `package.json` + committed lockfile (research §5).
- R2: Stdio MCP server starting clean with no Client ID configured — a missing/blank ID must NOT prevent startup; tools respond with setup instructions instead (research §5 userConfig bugs).
- R3: `userConfig` field for the Spotify Client ID, `required`/`sensitive` omitted; server-side shape validation (32 chars alphanumeric) with an error message per research §12 draft copy ("That doesn't look like a Client ID").
- R4: One tool: `dig_status` — reports Client ID configured/valid-shape, auth state (none yet in this slice), data directory path and permissions.
- R5: All logging to stderr, with a lint/test that fails on any `console.log`/stdout write in server source.
- R6: Plugin `version` set explicitly (`0.1.0`), bumped per release thereafter (research §5).
Acceptance criteria:
- AC1: From a clean state, `claude plugin marketplace add ~/Developer/dig` + `claude plugin install dig@dig` succeed, and in a NEW session `dig_status` answers — verify: manual: run the two commands, start a new session, call the tool.
- AC2: With Client ID unset, the server still starts and `dig_status` explains what to configure — verify: manual: uninstall/reinstall with blank config, call the tool.
- AC3: Stdout-purity check passes — verify: new test at `plugins/dig/test/stdout-purity.test.mjs` (drives the server over stdio through a full init + tool call and asserts every stdout byte parses as JSON-RPC).
- AC4: `npm test` runs and passes in `plugins/dig/` — verify: run it.
Footprint: `.claude-plugin/marketplace.json`, `plugins/dig/.claude-plugin/plugin.json`, `plugins/dig/.mcp.json`, `plugins/dig/server/`, `plugins/dig/package.json`, lockfile, `plugins/dig/test/`, `.gitignore`.
Not in this slice: any Spotify call, auth, skills.
Depends on: nothing
Status: signed off

## Slice B — Auth: PKCE, loopback callback, token lifecycle, reference page
Goal: A user with only a Client ID signs in through the browser and stays signed in across restarts, with the token-handling rules that prevent bricked installs.
Requirements:
- R1: PKCE flow, Client ID only. Redirect URI registered as a portless loopback literal (`http://127.0.0.1/callback`) with the port chosen free at auth time (research §5).
- R2: Callback server: bind 127.0.0.1 explicitly, validate Host header, escape everything reflected into the page, fully self-contained HTML (no external resources), 404 every non-callback path, validate `state`, handle Deny cleanly, shut down after one request, hard timeout on the listener (CVE-2025-66040 mitigations, research §9; the claude-radio recheck history in that repo's punch list is prior art).
- R3: Token storage: refresh token only (access token memory-only), absolute expiry timestamps, file created 0600 atomically from the first byte in the plugin data directory, self-heal permissions on read, exclusive lock around read-refresh-write, rotated refresh token persisted BEFORE first use of the new access token (research §9 token lifecycle — all five rules).
- R4: `invalid_grant` (six-month expiry) → discard token, prompt one-step re-auth with the research §12 "Expired connection" copy; warn when the token is over five months old.
- R5: Immediately after token exchange, probe one API call; map a 403 to the allowlist explanation (research §12 draft copy) — this is the most likely first-run failure.
- R6: After auth, show the connected account's display name and offer retry (wrong-account risk, research §10 #15).
- R7: The local reference page: served from the same local server during setup, read-only, captures nothing, shows the whole setup picture with real links and the exact redirect URI to copy, footer line "Dig — a Line 7 product" (PRD §9, branding decision 2026-08-14).
- R8: `dig_status` extended with auth state and token age.
Acceptance criteria:
- AC1: Live end-to-end: Tony registers a FRESH Spotify app following only the reference page + instructions, signs in, and a live API call succeeds — verify: manual: full walkthrough on the Mac Studio.
- AC2: Token file is 0600 and inside the plugin data directory; nothing token-like appears anywhere in the repo tree — verify: manual: `ls -l` the data dir; `git status` clean of state files.
- AC3: Server restart reuses the stored refresh token without re-auth — verify: manual: restart session, call an authed tool.
- AC4: Rotation ordering and lock behavior covered by unit tests with a mocked token endpoint (crash-between-refresh-and-persist leaves a usable token file; concurrent refresh does not clobber) — verify: new tests at `plugins/dig/test/token-store.test.mjs`.
- AC5: The string `localhost` appears nowhere in the repo — verify: new test at `plugins/dig/test/no-localhost.test.mjs` (greps the tree).
Footprint: `plugins/dig/server/` (auth, token store, callback+reference page), `plugins/dig/test/`.
Not in this slice: playlist tools, setup skill prose (slice G polishes the walkthrough; this slice's instructions just have to be correct enough to complete AC1).
Depends on: Slice A
Status: signed off

## Slice C — Read tools and context discipline
Goal: Every read the product needs, live against Spotify, with responses that never flood the context window.
Requirements:
- R1: Tools: `dig_search_catalog`, `dig_list_playlists`, `dig_get_playlist` (metadata, no tracks), `dig_list_playlist_tracks` (paginated), `dig_find_in_playlist`, `dig_diff_playlists`, `dig_get_tracks` (hydrate specific IDs, one request per ID — batch endpoints are gone) (research §6 proposed surface).
- R2: `dig_find_in_playlist` works from a server-side index built by paging the playlist once, keyed by playlist ID + `snapshot_id` for invalidation (research §6 — Spotify cannot search within a playlist).
- R3: Projection via Spotify's `fields` parameter, `compact | standard | full` with compact default; no tool may return an unpaginated full playlist; pagination replies name the exact next call and say plainly when exhausted; aggregate questions get aggregates (count + sample), and truncation is reported as data (research §6).
- R4: One serialized request queue for ALL Spotify calls — never parallel. Honor `Retry-After` exactly, cap in-tool waiting at 60 seconds, then stop and tell the user how long Spotify asked for (research §9 rate limiting).
- R5: Error mapping layer used by every tool: Premium-required 403 → research §12 copy; allowlist 403 → its copy; expired auth → re-auth instruction; rate limit → retry-after message; validation failures returned as tool results with `isError: true`, never protocol errors (research §6, §9).
- R6: Tool annotations on every tool (readOnlyHint etc.), derived from one authored field so they cannot drift (research §6).
- R7: Server instructions (the ≤2 KB session-start text) written, carrying the cross-cutting rules once.
Acceptance criteria:
- AC1: Live: list Tony's playlists, page a real playlist, find a known track in it, diff two playlists — verify: manual against the fresh test account.
- AC2: Projection and pagination bounds covered by unit tests over a mocked 4,000-item playlist: compact projection stays under 60 tokens/track equivalent (assert on serialized size), page responses carry continuation, no code path returns all items at once — verify: new tests at `plugins/dig/test/read-tools.test.mjs`.
- AC3: Rate-limit behavior: mocked 429 with `Retry-After: 3` retries once after the wait; `Retry-After: 7200` stops immediately and reports the wait time — verify: same test file.
- AC4: Index invalidation: changed `snapshot_id` rebuilds the find index — verify: unit test with mocked responses.
Footprint: `plugins/dig/server/` (spotify client, queue, error map, index, read tools), `plugins/dig/test/`.
Not in this slice: any write.
Depends on: Slice B
Status: signed off

## Slice D — Matching engine, ported and proven
Goal: The gated matching pipeline from `docs/dig-matching-reference.py` running in Node with its full test suite passing.
Requirements:
- R1: Port the reference implementation faithfully: ISRC short-circuit (equality accepts; inequality is only weak evidence), version-class set equality (live/acoustic/remix/etc. — agreement required, not a blocklist, so an explicitly requested live version passes), artist gate ≥0.60, title gate (symmetric similarity ≥0.87 AND zero unmatched meaningful words on either side), duration veto only from trusted sources, weighted score (title .40 / artist .30 / duration .20 / album .05 / year .05), three buckets: confident ≥0.90 auto-add, uncertain ≥0.70 never auto-add returns evidence, rejected below (research §7).
- R2: Handle BOTH parenthetical and Spotify's dash-composed version forms (`Title - Remastered 2011`) (research §7 trap).
- R3: Port all 31 reference test cases; the Python file stays in `docs/` as the annotated reference.
- R4: Matcher returns structured evidence (per-gate outcomes, score, alternatives) so tools can explain doubt without re-deriving it.
Acceptance criteria:
- AC1: All 31 ported cases pass — verify: new test at `plugins/dig/test/matching.test.mjs`, run by `npm test`.
- AC2: The named regression cases pass explicitly: Sweetgrass/Grass rejected, Purple Rain album-vs-single separated by duration, Sound/Sounds of Silence separated, NIN/Cash "Hurt" separated by artist, requested-live-version accepted — verify: same suite (subset of the 31; assert they are present by name).
Footprint: `plugins/dig/server/matching.mjs` (or similar), `plugins/dig/test/matching.test.mjs`.
Not in this slice: wiring into add-tracks (slice E).
Depends on: Slice A (repo only — independent of B/C; may run in parallel)
Status: signed off

## Slice E — Additive writes
Goal: Create, describe, add, and reorder — every add verified by the matcher first and every write verified by re-read after.
Requirements:
- R1: Tools: `dig_create_playlist` (`POST /me/playlists`; request notes creating defaults to public so both modify scopes matter), `dig_add_tracks`, `dig_update_playlist_details`, `dig_reorder` (arbitrary permutation composed from Spotify's move-slice primitive with shifting indices) (research §2, §4, §6).
- R2: `dig_add_tracks` accepts proposed tracks (title/artist/version/duration as known), searches, runs each through the slice-D matcher: confident → add; uncertain → returned with evidence, NEVER added; missing → reported honestly. No padding to hit a requested count (PRD §5, §6).
- R3: Verify after every write: re-read and confirm the change landed; report with the result vocabulary `verified | accepted | ambiguous | partial`, never a bare success boolean (research §4, §9). Never blind-retry an add — re-read first.
- R4: Writes use `snapshot_id` preconditions where the API supports it; a concurrent-edit failure tells the model to re-plan (research §6).
Acceptance criteria:
- AC1: Live: create a playlist, add a proposed track list containing at least one deliberately uncertain match, confirm the uncertain one came back as a question and was not added, reorder, confirm by re-read — verify: manual on the test account.
- AC2: Unit tests with mocked API: uncertain never auto-added; verify-after-write flags a mocked silent-failure (200 but unchanged contents) as not-verified; reorder permutation logic lands the mocked list in the requested order — verify: new tests at `plugins/dig/test/write-tools.test.mjs`.
Footprint: `plugins/dig/server/`, `plugins/dig/test/`.
Not in this slice: removal of any kind.
Depends on: Slice C, Slice D
Status: signed off

## Slice F — Destructive operations
Goal: Removal that cannot fire by accident, cannot wipe a playlist, and can always be rolled back from a local snapshot.
Requirements:
- R1: Two-step: `dig_plan_removal` (read-only: snapshot_id, expiring token bound to user + digest of the exact track list, count, ≤10-track sample, one-sentence human summary) → `dig_apply_removal` (validates token + digest, executes against the captured snapshot; a changed playlist fails Spotify's own validation and the tool says re-plan). The `summary` argument exists so the permission prompt reads as a human sentence (research §6).
- R2: `dig_apply_removal` carries `_meta["anthropic/requiresUserInteraction"]: true` (research §6).
- R3: Full track-list snapshot written to the plugin data directory before EVERY destructive write, plus a restore path that rebuilds from a snapshot; snapshots named so a user can pick one (PRD §7, research §9).
- R4: An empty or zero-track plan is refused — there is no code path that empties a playlist; no replace-all tool exists (PRD §7).
- R5: Dedupe: only remove-all-then-re-add exists; the position-moves-to-end consequence is disclosed in the plan BEFORE approval (PRD §7, research §9 — `positions` is gone).
- R6: `dig_unfollow_playlist` ships disabled by default (config opt-in), since for the owner it is deletion (PRD §7). Note: actual deletion is `DELETE /me/library` taking URIs (research §2).
- R7: Before shipping removal, empirically test whether the track-relinking failure (200-yet-nothing-removed; the workaround field was removed in Feb 2026) reproduces; record the finding in this doc's Discovered section (research §11).
Acceptance criteria:
- AC1: Live on a throwaway playlist: plan → apply removes exactly the planned tracks, verified by re-read; the snapshot file exists; restore rebuilds the playlist — verify: manual on the test account.
- AC2: Unit tests: expired/mismatched token refused; digest mismatch refused; empty plan refused; changed snapshot_id → re-plan error; dedupe plan text contains the moves-to-end disclosure — verify: new tests at `plugins/dig/test/destructive.test.mjs`.
- AC3: `dig_unfollow_playlist` absent from the tool list until explicitly enabled — verify: unit test on tool registration.
Footprint: `plugins/dig/server/`, `plugins/dig/test/`.
Not in this slice: nothing adjacent — this is the last tool slice.
Depends on: Slice C (E recommended first so the result vocabulary exists)
Status: signed off

## Slice G — Onboarding skills, digging skill, doctor
Goal: The ten minutes before Dig works, made survivable by a non-developer, plus the taste layer that makes digging good.
Requirements:
- R1: Setup skill (`plugins/dig/skills/setup/SKILL.md`): the PRD §9 order of operations — step 0 Premium ask (stop on no), create app, paste exact redirect URI, copy Client ID (with the never-paste-your-Client-Secret warning), User Management self-add stated LOUDLY with the up-to-15-minutes lag said out loud, browser sign-in. Exact URLs and exact button names verified against the live dashboard during this slice. Ends by telling the user to start a new chat if tools are missing (plugin servers connect at session start — verified finding, PRD §12).
- R2: The reference page content finalized to mirror the skill (built in slice B; this slice makes the two agree).
- R3: Digging skill (`plugins/dig/skills/digging/SKILL.md`): Claude proposes from its own knowledge, Dig verifies, present the found/not-found list before adding, report misses honestly, never pad, honor explicit version requests, uncertain matches come back as questions with the matcher's evidence (PRD §5, §6).
- R4: `dig_doctor` tool: checks Client ID shape, token presence/age (five-month warning), and one live probe call; maps each failure to its research §12 instruction (Premium, allowlist, expired, redirect mismatch) (PRD §10).
- R5: All six research §12 draft error messages wired to their actual trigger points across the server.
- R6: A non-developer path to enable `dig_unfollow_playlist` (playlist deletion): a plugin userConfig field (or equivalent no-terminal flow) that sets the slice-F opt-in, documented in the setup/skill text with the deletion warning — Tony's ruling 2026-08-15 (slice-F review question 2).
Acceptance criteria:
- AC1: Fresh-eyes run: with the skill as the only guide, a from-scratch setup on the Mac Studio completes without improvising (Tony or a fresh Claude session following only the skill text) — verify: manual.
- AC2: `dig_doctor` distinguishes at least: unconfigured, bad-shape ID, no token, expired token (mocked), healthy — verify: new tests at `plugins/dig/test/doctor.test.mjs` plus one live healthy run.
- AC3: The no-localhost test still passes; the skill files carry exact dashboard URLs — verify: existing test + manual read.
- AC4: With the R6 opt-in set through the non-developer path, dig_unfollow_playlist appears in the tool list; unset, it stays absent — verify: unit test plus one manual flip.
Footprint: `plugins/dig/skills/`, `plugins/dig/server/` (doctor, error copy), reference page content, `plugins/dig/test/`.
Not in this slice: README/marketplace copy (slice H).
Depends on: Slices B–F (documents and doctors what exists)
Status: signed off with conditions

## Slice G2 — Desktop-proof configuration
Goal: Dig configures itself from chat on the desktop app, where plugin userConfig never arrives — the Client ID (and the unfollow opt-in) persist in Dig's own data directory, effective without a new chat.
Requirements:
- R1: Config file fallback: the server resolves the Client ID as env (existing usable() rules) first, then a persisted `config.json` in CLAUDE_PLUGIN_DATA (0600, atomic, via the existing writeFileAtomic0600). Env wins when usable. Same resolution for the unfollow opt-in (env names first, then the file).
- R2: New tool `dig_set_client_id`: validates the 32-char shape (reuse checkClientId's validation and BAD_CLIENT_ID_MESSAGE), persists to the config file, takes effect IMMEDIATELY in the same session (no restart, no new chat), and its success text names the next step (dig_connect). Unconfigured state must remain non-fatal exactly as before.
- R3: The unfollow opt-in becomes settable without userConfig: `dig_set_client_id` stays single-purpose; a separate `dig_enable_playlist_deletion` tool (enable/disable argument) writes the flag to the config file, carries `_meta["anthropic/requiresUserInteraction"]: true` and the destructive access class, and its text repeats the deletion warning. Tool registration for dig_unfollow_playlist re-evaluates per tools/list call OR the enable text says to start a new chat — builder verifies which is achievable and records it.
- R4: dig_status and dig_doctor report which config source is active (env vs Dig's config file vs none) so support conversations can tell them apart.
- R5: Copy + skill fixes riding this slice (all per Tony's 2026-08-16 rulings, in the ledger):
  (a) UNCONFIGURED_MESSAGE: drop the /plugin path; instruct paste-the-Client-ID-in-chat (dig_set_client_id) with the setup skill as the fallback.
  (b) Setup skill step 0: DEMAND the Premium answer before proceeding (no "assuming yes").
  (c) Setup skill step 1-2: instruction order must match the live Create app form: App name → App description → Website optional → Redirect URIs (paste + click Add) → Web API checkbox → tick the Developer Terms agreement checkbox → Save at the form bottom.
  (d) Setup skill step 4: "don't navigate away — on the same page, click the User Management tab (next to Basic Information)".
  (e) Setup skill config step: replace the `claude plugin install --config` flow with dig_set_client_id in chat; "start a new chat" remains ONLY for the post-install step.
  (f) New opening note (privacy/trust, per user): everything — Spotify app, Client ID, sign-in — stays on the user's machine, talks only to Spotify, nothing stored by or visible to Line 7; warm framing ("something we built for ourselves and like sharing"). Reference page gets the same note.
  (g) Setup skill/README seam: the attached folder does not matter (user-level plugin, writes nothing into the folder) — note where the skill covers pre-install context; the full install story is still slice H's.
- R6: userConfig stays declared in plugin.json (terminal installs still work); the file fallback must not fight it — env-wins ordering is the contract, and a mismatch between the two sources is reported by dig_status/doctor, not silently resolved.
Acceptance criteria:
- AC1: Unit tests: env-wins precedence; file fallback used when env blank/placeholder; dig_set_client_id validates shape, persists 0600, and the SAME server process serves authed-path config immediately after; unfollow flag file fallback + both env names still honored; dig_enable_playlist_deletion carries requiresUserInteraction meta and destructive annotations — verify: new tests at plugins/dig/test/config-file.test.mjs (plus extensions to unfollow-config.test.mjs).
- AC2: Live on THIS Mac in the DESKTOP app (Tony): paste Client ID in chat → dig_set_client_id → dig_connect signs in and a live call succeeds, all in one chat — verify: manual (this is the resumed fresh-eyes run's unblocking step).
- AC3: Full suite green including stdout-purity, stderr-only, no-localhost, instructions budget — verify: npm test.
- AC4: dig_status/dig_doctor name the active config source in all three states (env, file, none) — verify: unit tests + one manual read.
Footprint: plugins/dig/server/ (config.mjs, new config-file module or extension, status.mjs, doctor.mjs, destructive-tools.mjs wiring, connect path untouched), plugins/dig/skills/setup/SKILL.md, reference page in callback.mjs, plugins/dig/test/.
Not in this slice: README/marketplace copy (slice H); any Spotify API behavior change; the digging skill.
Depends on: Slice G (its conditions stand — this slice does not need G's open AC1, it unblocks it)
Status: rejected

## Slice H — Ship preparation
Goal: Everything a public day-one repo needs, ready for Tony's publish word — which this slice does NOT include.
Requirements:
- R1: README: Premium requirement in the first paragraph above install instructions; own-playlists-only limit; six-month reconnect; macOS-is-what's-tested note; install = paste-one-sentence flow with the new-chat step; "Dig — a Line 7 product" footer (PRD §3, §8; decisions 2026-08-14/15).
- R2: Premium stated in all five PRD §3 places — README, marketplace.json description, plugin.json description, setup skill step 0, runtime error (verify the first four here; the last two landed in G).
- R3: Marketplace metadata final: names such that the install lines `/plugin marketplace add line7works/dig` and `/plugin install dig@dig` work as printed (supersedes the PRD §8 `tonycoon/dig` lines); version bumped to `1.0.0`.
- R4: A LICENSE file — Tony picks the license at this slice if not before (open question below).
- R5: Auto-update is off by default for third-party marketplaces — README tells users how to get updates (research §5).
- R6: Final sweeps: no-localhost test green, stdout-purity green, no token/state files in git history, full `npm test` green.
Acceptance criteria:
- AC1: A clean-machine-style dry run: uninstall everything, reinstall from the local repo by pasting the README's one sentence, new chat, complete one real playlist edit, timed under fifteen minutes including a fresh Spotify app registration — verify: manual (this is PRD §13 rehearsed, minus the friend).
- AC2: Premium text present in all four artifact locations — verify: new test at `plugins/dig/test/premium-copy.test.mjs` (greps the four files).
- AC3: `npm test` fully green — verify: run it.
Footprint: `README.md`, `LICENSE`, `.claude-plugin/marketplace.json`, `plugins/dig/.claude-plugin/plugin.json`, `plugins/dig/test/`.
Not in this slice: creating the GitHub repo, pushing, or any publish action — gated on Tony's explicit word.
Depends on: Slice G
Status: not started

## Open questions
- License for the public repo (MIT is the conventional default for this kind of tool; Tony decides by slice H).

## Build assumptions

### 2026-08-15 · Slice A
- userConfig field key is `spotify_client_id`; `title` is a required attribute per the plugins reference, added (spec silent on titles) · builder call
- Server also reads `CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID` as a fallback alongside the `.mcp.json` env substitution, since Claude Code auto-exports options under that name · builder call
- An unsubstituted `${user_config...}` placeholder in the env is treated as "unconfigured", same as blank · builder call
- `dig_status` reports the data directory (`CLAUDE_PLUGIN_DATA`) path/existence/mode but does not create it — slice A stores nothing yet · builder call
- `npm test` script is `node --test "test/*.test.mjs"` — the bare directory form errors on node v22 · builder call
- Tool annotations already set on `dig_status` (R6 of slice C formalizes derivation later) · builder call

### 2026-08-15 · Slice B
- Added `dig_connect` tool to trigger the sign-in — the spec names no trigger; something must start the browser flow · builder call
- `dig_connect` returns immediately; exchange + probe complete inside the callback HTTP request and the success page shows the connected name (R6), with dig_status reporting the outcome — avoids a tool call that blocks for minutes of browser time · builder call
- Token file also stores `display_name` (non-secret) so dig_status can show who is connected without an API call · builder call
- Token file stores `client_id` binding; a mismatch forces clean re-auth (research §4 pattern) · builder call
- Reference page served at `/` and `/setup`; deny/state-mismatch also close the one-shot listener (a settled flow is over) · builder call
- Wrong-account retry (R6) = success page instructs "sign out of Spotify in the browser, then dig_connect again" — no dedicated retry endpoint · builder call
- Callback hard timeout 5 minutes; lock timeout 5s with 30s stale-break · builder call
- Added `test/callback.test.mjs` (not named by an AC) to exercise the R2 hardening list for real · builder call

### 2026-08-15 · Slice D
- Port covers exactly the functions `verify()` reaches (lev, SequenceMatcher ratio, token_sort, norm, split_title, gates, scoring); the Python file's measurement-only metric zoo (jaro, token_set, jaccard, trigram, bidi_substring, metric_table) is harness, not pipeline, and was not ported · builder call
- difflib autojunk not replicated — it only engages at candidate strings ≥200 chars, beyond any normalized title compared here; noted in a code comment · builder call
- The reference's feat-artist split on a bare `x` (splits inside words containing x) preserved verbatim as part of the faithful port · builder call
- R4 "alternatives": added `verifyCandidates(wanted, candidates)` returning best + scored alternatives, each with verdict/score/reasons — the reference has no multi-candidate rank, but R4 names alternatives as evidence tools need · builder call
- Python's dead `core_strict_full` branch in split_title (computed, never used) not ported · builder call

### 2026-08-15 · Slice C
- Feb 2026 renamed response shapes read with a legacy fallback (`row.item ?? row.track`; search container `body.items ?? body.tracks`) since the docs show the union of old and new worlds; live calls succeeded through the lenient reader · builder call
- AC2's "under 60 tokens/track equivalent" asserted as <240 serialized chars per compact track (~4 chars/token) · builder call
- `dig_find_in_playlist` matching is case- and accent-insensitive substring over title + artist names (spec silent on semantics; the slice-D matcher verifies proposals, not user find text, so it was not reused here) · builder call
- Bounds chosen: playlist/list page cap 50 (the endpoint max), aggregate samples cap 10, `dig_get_tracks` cap 20 IDs per call (each ID is one request) · builder call
- Find index is in-memory per server process, rebuilt on snapshot_id change — spec requires server-side, not persistent · builder call
- Error copy's one home is `error-map.mjs`; the slice-B allowlist/Premium 403 strings moved there and `auth.mjs` imports/re-exports them (R5's "layer used by every tool") · builder call
- `TokenStore.invalidateAccess()` added as the sanctioned 401-invalidation API (clears the in-memory access token only); the client treats a 401 as authoritative and refresh-retries exactly once (research §9; clears slice-B MINOR token-store.mjs:31's missing-API half) · builder call
- 429 handling retries at most once per request: a second 429 after a honored short wait stops and reports rather than looping · builder call
- `dig_status`/`dig_connect` tool defs rebuilt through the R6 derivation (`defineTool` access classes local/connect) so every tool, not just the read seven, derives its annotations · builder call
- Server instructions delivered via the `instructions` field of the initialize result (1,667 bytes of the 2,048 budget) · builder call

### 2026-08-15 · Slice E
- dig_add_tracks proposal shape is {title, artist, version?, duration_seconds?}; a version is folded into the title as a parenthetical so the matcher's version-class gate sees it, and a proposed duration is never duration_trusted (a duration from the model's memory must not veto — research §7 G4) · builder call
- Bounds: 20 proposals per dig_add_tracks call (each costs one search request); dig_reorder capped at 200 rows (each out-of-place row is one move request) with a clear refusal above it · builder call
- When no proposal clears the confidence bar, dig_add_tracks reports result "no_write" — the four-word vocabulary describes writes that happened; a call that wrote nothing says so plainly instead of borrowing "verified" · builder call
- Never-blind-retry implemented as: an add whose POST fails with an unknown outcome (timeout/network drop) is not resent; the confirming re-read decides verified/partial/ambiguous. A definite SpotifyApiError still surfaces as the mapped instruction · builder call
- R4 concurrency: snapshot_id passed on every reorder move (the one additive items op that supports a precondition), chained from each move's response; a 400/409 on /items mid-reorder is treated as a concurrent edit and returns the re-plan message with moves_applied · builder call
- dig_update_playlist_details compares descriptions after unescaping the HTML entities Spotify applies on read; a description-only residual mismatch reports "accepted", field mismatches report "ambiguous" · builder call
- In-scope plumbing (named by the handoff): spotify-client gained method/body support and empty-200-body tolerance; read-tools' ValidationError/requireString/wrapTools exported and shared so write tools validate and error identically; tool-def gained the `write` access class (readOnly false, destructive false, idempotent false) · builder call
- Server instructions extended with two write-rule lines (uncertain-never-added, result vocabulary); the 2 KB budget test still passes · builder call
- index.mjs EOF exit now drains stdout before exiting — the larger tools/list frame exposed a truncation the old synchronous process.exit caused (caught by the existing stdout-purity suite) · builder call
- Tony's standing ruling held: the matcher's free-text reason strings were passed through as evidence unchanged; slice E did not need structured fields · builder call

### 2026-08-15 · Slice F
- Plan tokens are an in-memory single-use registry with a 15-minute expiry; "bound to user" implemented as bound to the connected app's client_id (the only stable local user identity) — a token does not survive a server restart and is consumed by the first apply attempt · builder call
- Unfollow opt-in mechanism is the env var `DIG_ENABLE_UNFOLLOW` (or `CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW`) — plugin.json/userConfig is outside this slice's footprint; a config field can land in G/H · builder call
- A plan that would remove every track is refused, same class as the empty plan (R4's no-code-path-empties) · builder call
- Bounds: one removal plan carries at most 100 distinct tracks (one DELETE request); restore writes batches of 100 uris (PUT-replace first batch, POST appends after) · builder call
- dig_restore_snapshot is itself destructive, so it got the same preview→token two-step, the requiresUserInteraction _meta, and a pre-restore snapshot of the current state (a restore is undoable); called with no arguments it lists saved snapshots · builder call
- Unavailable/local rows in a snapshot cannot be restored (no uri); the restore preview reports how many are lost · builder call
- dig_unfollow_playlist two-step like removal; its verify pages /me/playlists up to 200 entries, beyond that reports "accepted" · builder call
- plan_removal input is `track_ids` (ALL copies removed — disclosed when multi-copy) or `mode:"duplicates"`; a dedupe with no duplicates returns result "no_plan" and mints no token · builder call
- Snapshot files: `snapshots/<ISO-timestamp>-<name-slug>-<playlistId>.json` in the data dir, 0600 atomic via the slice-B writer; .gitignore's existing `snapshots/` pattern covers the repo-side risk · builder call
- Server instructions: three existing lines tightened (and the now-false "writes are additive only" claim removed) to fit the two new destructive-rules lines inside the 2 KB budget · builder call

### 2026-08-15 · Slice G
- dig_doctor is an ordered checklist that stops after a failed gate (later checks would only echo the same cause); a completed diagnosis returns isError:false — the failures ride inside the checklist with their mapped copy · builder call
- The redirect-rejected §12 copy has no runtime trigger (Spotify's dashboard rejects the URI, Dig never sees it) — carried as setup-skill step-2 text plus a doctor hint on the no-token branch showing the exact URI, since a mismatch's only Dig-side symptom is a sign-in that never completes · builder call
- R6 field key is `dig_enable_unfollow` (type string, value "true") so BOTH paths hit the env names slice F already reads: explicit `.mcp.json` substitution to DIG_ENABLE_UNFOLLOW, and the CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW auto-export — zero changes to the opt-in's read site semantics · builder call
- destructive-tools' opt-in env read hardened: a blank or unsubstituted-placeholder primary env var no longer masks the auto-export fallback (the slice-A config lesson; in-scope as R6's "sets the slice-F opt-in") · builder call
- Server instructions untouched (2033/2048 bytes): dig_doctor is discoverable from its own description and the skills; nothing G ships needs an instructions line · builder call
- Digging skill also instructs reading the playlist before proposing and names the 20-proposal bound — restatements of the live tool contracts, not new rules · builder call

### 2026-08-16 · Slice G2
- R3's "re-evaluates per tools/list OR new-chat text" resolved as BOTH achievable and shipped: the unfollow entry registers unconditionally with an `enabled()` predicate re-evaluated on every tools/list AND tools/call (a disabled tool answers -32602 like an unknown one), the server declares `capabilities.tools.listChanged` and dig_enable_playlist_deletion emits notifications/tools/list_changed, and the enable text still carries the new-chat fallback for hosts that don't refresh · builder call
- Config file is `config.json` in CLAUDE_PLUGIN_DATA holding string values ({ spotify_client_id, dig_enable_unfollow }), merge-written via writeFileAtomic0600; a corrupt/unparseable file reads as absent (never fatal), permissions self-heal on read like token.json · builder call
- Unfollow-flag resolution centralized into config.mjs resolveUnfollowFlag() (env names under the shared usable() rules, then the file) and destructive-tools consumes it — this also removes the slice-G MINOR's trim-order asymmetry (destructive-tools.mjs:212) since there is now one reader · builder call
- dig_set_client_id trims the pasted value before validating (paste-with-whitespace is the common chat case, same leniency checkClientId already applies) · builder call
- New tool-def access class `configure` (readOnly false, destructive false, idempotent true, openWorld false) for dig_set_client_id — no existing class describes a local, non-destructive settings write · builder call
- R6 mismatch reporting: dig_status/dig_doctor flag env-vs-file Client ID divergence ("plugin settings win") and dig_set_client_id's success text warns when a different env value stays in charge; the values are never reconciled automatically · builder call
- Proceeded over slice G's open AC1 MAJOR on the handoff's explicit carve-out (this slice unblocks that run) · per user

## Deviations

### 2026-08-15 · Slice A
- none

### 2026-08-15 · Slice B (live walkthrough fix)
- R1 changed: redirect URI registered WITH an explicit port (`http://127.0.0.1:8888/callback`), callback server pinned to 8888 (`DIG_CALLBACK_PORT` override; tests run with port 0) — Spotify's dashboard rejects the portless form the research promised ("This redirect URI is not secure"), verified live by Tony 2026-08-15; fix applied mid-walkthrough by the walkthrough session, adopted · per user
- AC1 performed live by Tony 2026-08-15: fresh Spotify app registered following Dig's instructions (with mid-run improvisation noted in Discovered), sign-in completed — token persisted only after the post-exchange probe succeeded, observed in real time. AC2 verified: token.json in the plugin data dir at 0600, repo tree clean of state files

### 2026-08-15 · Slice B
- AC5 test excludes `docs/dig-research-*.md` and `docs/dig-prd-*.md` from the tree grep (they quote Spotify's rules) · per user
- AC5 exclusion extended to `docs/dig-build-plan.md` — its own AC5 line names the forbidden word; same class as the two ruled-on docs · builder call
- Slice A MINOR punch-list items folded into this build (config fallback, version single-source, EOF flush, buffer cap, notification-with-id, unknown tool -32602, data-dir diagnostics, .gitignore patterns, runSession timeout/exit-code) · per user

### 2026-08-15 · Slice D
- none

### 2026-08-15 · Slice C
- none

### 2026-08-15 · Slice E
- none

### 2026-08-15 · Slice F
- none

### 2026-08-15 · Slice G
- Default tool count is now 17 (18 with unfollow enabled) vs the constraint's 12–16 target — R4 mandates dig_doctor and every other tool is spec-mandated; still under research §6's never-more-than-20 hard line · builder call
- AC1 performed as: (a) live read-only verification of every dashboard URL and button name reachable without clicking (Dashboard, Create app, Basic Information, User Management/Add user), and (b) a fresh-context agent walkthrough of the skill text with its improvisation gaps folded back in — a true from-scratch human run still needs Tony at the browser (this session cannot click in browsers or enter credentials); AC1 reported unexercised-in-full · builder call
- Below-the-fold Basic Information content (Redirect URIs box, Add/Save buttons) carried from the slice-B same-day live record rather than re-verified — read-tier browsing cannot scroll; everything above the fold was re-verified live today · builder call

### 2026-08-16 · Slice G2
- Default tool surface now 19 (20 with unfollow enabled) vs the constraint's 12–16 target — both new tools are spec-mandated (R2, R3); still under research §6's never-more-than-20 hard line, but at it when unfollow is on · builder call
- destructive.test.mjs's slice-F AC3 factory test updated to the new contract (entry registered, `enabled()` false by default); absence from the real tool list is still proven at the server boundary in unfollow-config.test.mjs · builder call

## Discovered

### 2026-08-15 · Slice A
- Live install stores the userConfig value in `~/.claude/settings.json` under `pluginConfigs["dig@dig"].options` in plaintext — fine for a public Client ID, worth remembering before any future field
- `claude plugin install dig@dig --config spotify_client_id=` refuses an empty value; there is no CLI path to clear a configured option, only editing settings.json — relevant to slice G's recovery instructions
- The data directory `~/.claude/plugins/data/dig-dig` is created by Claude Code itself at 0755 — slice B's token file must rely on its own 0600 file mode, not the directory

### 2026-08-15 · Slice B live walkthrough (Tony, AC1 in progress)
- Spotify's dashboard now REJECTS portless loopback redirect URIs ("This redirect URI is not secure") despite the docs still describing them — research §5's portless plan is dead; fixed port 8888 adopted mid-walkthrough (see Deviations)
- The reference page is unreachable during the step it matters most: it is served by the callback server, which needs a valid Client ID first — the setup instructions for app creation currently depend on the session's Claude improvising (it grepped the plugin source). Slice G's setup skill must carry the full pre-config instructions itself
- Tony, on config UX: the user should never have to open /plugin → settings by hand. Slice G's setup skill should ask for the Client ID in chat and have Claude run `claude plugin install dig@dig --config spotify_client_id=<id>` itself
- Config changes don't reach a running server — every config step needs an explicit "start a new chat" instruction (matches PRD §12's session-start finding)

### 2026-08-15 · Slice C live AC1
- Slice B's waived AC3 got its live exercise as planned: four separate fresh server processes reused the stored refresh token without re-auth (dig_status showed the connected account; all authed reads succeeded)
- Live catalog search returned two distinct track IDs for the same recording (identical title, artist, and duration_ms) — the slice-D verifyCandidates tie-order MINOR (matching.mjs:342) is a real-world case, relevant when slice E wires the matcher

### 2026-08-15 · Slice E live AC1
- Creating a playlist with public:false read back public:true — Spotify's public flag reflects "shown on profile", not the privacy setting, a known quirk; dig_create_playlist verifies existence + name, and slice G's docs should word this so users aren't alarmed
- Spotify's dash-composed version form confirmed in the wild: a proposal for "(2011 remaster)" matched "Wish You Were Here - 2011 Remaster" cleanly through the add flow (slice-D R2 proven live)
- The slice-D tie-order MINOR (matching.mjs:342) reproduced live: two distinct "Bohemian Rhapsody" track IDs at identical verdict+score; "best" was input order, exactly as flagged
- AC1 left a throwaway playlist "Dig slice-E throwaway" (2XqanBFQWKCZC178vHS91A) on the test account — safe to delete, useful for slice F's live AC

### 2026-08-15 · Slice F live AC1 (R7 finding)
- R7 answered: the track-relinking silent failure (200-yet-nothing-removed; workaround field removed Feb 2026) did NOT reproduce — two live DELETEs against the throwaway playlist both removed the planned track and verified by re-read. The apply path still reports it honestly (ambiguous/partial + never-blind-retry + snapshot pointer) if it ever appears in the wild
- NEW live failure mode: immediately after a DELETE, `GET /playlists/{id}?fields=snapshot_id` can still serve the PRE-delete snapshot_id (read-after-write staleness). The first live apply reported "ambiguous" on a removal that HAD landed, because its verify re-read went through the snapshot-keyed find-index cache, which the stale metadata validated. Fixed in-slice: destructive verifies page the rows directly (never the cache) and drop the playlist's cache entry; regression test added. Any future consumer that verifies a write through FindIndex is exposed to the same staleness (slice E's write verifies read windows directly and are unaffected)
- AC1 restored the throwaway playlist to its 3-track state; the run's snapshot files remain in the data dir as real restore candidates

### 2026-08-16 · Slice G AC1 fresh-eyes run (Tony, in progress)
- Two pre-install gaps caught before the setup skill's first step, both belonging to slice H's install story: (1) a brand-new user who asks "help me setup dig" in a session WITHOUT the plugin gets a "dig DNS tool?" guess — the README's paste-one-sentence install prompt is load-bearing and must be the very first thing a friend receives; (2) the desktop app requires attaching a folder before a local chat exists, and a non-developer has no repo — the install instructions must say to use "Open folder…" and create/pick an empty folder — and say explicitly (per Tony 2026-08-16) that the folder does not matter: Dig installs at user level, is available from every folder, and writes nothing into the attached folder. Tony hit both live 2026-08-16
- Tony's first attempt also ran in a CLOUD session, where Dig cannot work — the friend prompt must say plainly: the Claude app on your computer, Local, not cloud/web
- Uninstall behavior observed live: `claude plugin uninstall` alone left pluginConfigs (Client ID) and the data dir (token + snapshots) in place; the fuller cleanup (marketplace removal path) deleted the data dir including all snapshot files. Slice H README should say: uninstalling Dig deletes your local snapshots. The dig-test account's token was lost this way (reconnect = one dig_connect); throwaway playlist unaffected
- AC1 run, walkthrough pacing: the skill's step-0 Premium gate was asked but not WAITED on — the guiding Claude continued "assuming yes" into step 1. Skill copy should demand an answer before step 1 (setup-skill fix, end of run)
- AC1 run, Create app form verified live (Pour Guys dummy account, 2026-08-16): field order is App name* → App description* → Website (optional) → Redirect URIs* (paste + click Add; entry then lists with a Remove button) → "Which API/SDKs are you planning to use?" checkboxes (Web API) → "I understand and agree with Spotify's Developer Terms of Service and Design Guidelines" checkbox → Save button at form bottom. Tony's findings: (1) the skill's instruction order should match the form's layout; (2) the skill never said to tick the terms checkbox and click Save to finish the form; (3) NEW REQUIREMENT per Tony 2026-08-16: an early privacy/trust note — everything (Spotify app, Client ID, token) stays on the user's machine, nothing stored by or visible to Line 7, framed warmly as "something we built for ourselves and like sharing" — goes at the start of the setup walkthrough, and slice H should mirror it on the reference page + README · per user.
- AC1 run, CRITICAL FINDING 2026-08-16: the DESKTOP APP does not deliver plugin userConfig to the plugin's server. Client ID stored correctly (settings.json pluginConfigs["dig@dig"], verified), plugin installed/enabled at user scope, yet desktop-app chats — including after a full app quit+reopen — report unconfigured; a terminal session (`claude -p`, same store, same moment) reports "Client ID: configured and looks valid". The ${user_config...} substitution AND the CLAUDE_PLUGIN_OPTION auto-export both fail to arrive in desktop sessions. PRD §12's desktop verification used a zero-config plugin, so this path was never exercised until this run. Impact: the friend flow (desktop-first) cannot configure Dig at all as shipped — needs a Tony decision (candidate fix: a config path that bypasses env substitution, e.g. the Client ID persisted to the data dir by a Dig tool)
- AC1 run, step-4 navigation gap (Tony): after copying the Client ID the skill says "open the User Management tab" without saying WHERE — a new user doesn't know to stay put. The tab is right there on the page they're already on (next to Basic Information, above the Client ID box). Skill fix: "don't navigate away — on the same page, click the User Management tab" (setup-skill fix, end of run) Installer note also observed: install prints "2 userConfig options aren't set... /plugin configure" — README/skill should say to ignore config prompts at install time (setup-skill fixes, end of run)

### 2026-08-15 · Slice G live dashboard verification
- The dashboard restructured since the research snapshot: there is NO "Settings" page anymore. An app's page is **Basic Information** (URL `/dashboard/<client-id>`) with two tabs, **Basic Information** and **User Management** (`/dashboard/<client-id>/users`). Client ID sits at the top of Basic Information with a copy button and a "View client secret" link beneath; "Refresh Token Lifetime 180 days" is now displayed. User Management fields are **Full Name** / **Email** with an **Add user** button (research §3 said "Add new user") and a "maximum of 5 users" note. Skill + reference page written to this
- The dig test app shows **0/5 users added** under User Management, yet every live call all day succeeded — the owner self-add requirement (research §3's allowlist trap) appears NOT to be enforced for the app owner, or owners are implicitly allowed. The skill keeps step 4 loud per R1/PRD §9 (harmless if unnecessary, and the 403 mapping still covers it); worth a Tony ruling before slice H copy leans on the trap being real
- `claude plugin install dig@dig --config X=Y` against an installed plugin MERGES with stored options (spotify_client_id survived the dig_enable_unfollow flips) — enable/recovery flows can pass a single flag
- dig_doctor's first live run hit a stale token.json.lock left by a killed test harness; the 30s stale-break recovered on the next run exactly as designed ("broke stale lock" logged), and the doctor surfaced the interim failure honestly

### 2026-08-16 · Slice G2
- wrapTools (read-tools.mjs:330) rebuilt each entry as bare {def, handler}, silently dropping any extra key — it ate the unfollow entry's `enabled` gate until fixed to spread the rest through; any future per-entry metadata would have vanished the same way

## Punch list

### 2026-08-15 — review: Slice A
- MAJOR · plugins/dig/server/index.mjs:83-88 · malformed/invalid input silently dropped (no -32700/-32600) and handler throws mislabeled as parse failures with no reply · a corrupted or non-object request (e.g. `not json\n`, `null\n`, a batch array with ids) leaves the client hanging on that id forever · slice A review
- MAJOR · plugins/dig/test/stdout-purity.test.mjs · a stdout write confined to an unexercised branch (ping, unknown-tool) passes the suite 9/9 green; `console["log"]` evades the stderr-only lint regex; server/ subdirectories are never scanned · proven by mutation: `process.stdout.write("junk\n")` in the ping handler runs green, then corrupts the protocol on the first real ping · slice A review
- MAJOR · plugins/dig/server/index.mjs:46 · initialize echoes the client's protocolVersion instead of clamping to a supported set · a future host sends a breaking protocol version, the server claims to speak it, and divergence surfaces as silent misbehavior instead of a clean mismatch · slice A review
- MINOR · plugins/dig/server/config.mjs:24 · `??` masks the CLAUDE_PLUGIN_OPTION fallback when SPOTIFY_CLIENT_ID is "" or an unsubstituted placeholder · a valid fallback value is ignored and the user is told to configure · slice A review
- MINOR · plugins/dig/server/index.mjs:10 · VERSION duplicated across index.mjs/plugin.json/package.json with no drift guard · slice H bumps plugin.json to 1.0.0, serverInfo still says 0.1.0 · slice A review
- MINOR · plugins/dig/server/index.mjs:74-90 · final request without trailing newline is discarded at stdin EOF · client that half-closes after last write loses that request · slice A review
- MINOR · plugins/dig/server/index.mjs:74-77 · unbounded stdin buffer, no line-length cap · a broken client streaming without newlines OOMs the server · slice A review
- MINOR · plugins/dig/server/status.mjs:33-36 · all statSync failures conflated with "not created yet", and a plain file reported as if a directory · status tool reports wrong diagnostics on EACCES/ENOTDIR · slice A review
- MINOR · plugins/dig/server/index.mjs:52 · a notification-method request carrying an id gets no reply · misbehaving client hangs on it · slice A review
- MINOR · plugins/dig/server/index.mjs:37 · unknown tool returned as isError tool result instead of -32602 protocol error · host-facing error lands in the model-facing channel · slice A review
- MINOR · .gitignore:1-6 · no pattern for slice C's index cache or slice F's user-named snapshots · state file could be committed if ever written repo-side · slice A review
- MINOR · plugins/dig/test/stdout-purity.test.mjs:16-32 · runSession asserts no exit code and has no timeout · nonzero-exit server passes; hung server stalls the suite indefinitely · slice A review

### 2026-08-15 — recheck: Slice A
- MAJOR · plugins/dig/server/index.mjs:83-88 · (malformed/invalid input silently dropped (no -32700/-32600) and handler throws mislabeled as parse failures with no reply) · fixed — verified live: parse error → -32700 id null, non-object/batch → -32600, forced handler throw → -32603; error paths now at index.mjs:105-121 (dispatch)
- MAJOR · plugins/dig/test/stdout-purity.test.mjs · (a stdout write confined to an unexercised branch passes the suite green; console["log"] evades the lint; server/ subdirectories never scanned) · fixed — verified by mutation on copies: stdout.write in ping branch fails suite, console["log"] in unknown-tool fails, subdirectory file caught by recursive walk
- MAJOR · plugins/dig/server/index.mjs:46 · (initialize echoes the client's protocolVersion instead of clamping to a supported set) · fixed — verified live: "1999-01-01" answered with "2025-06-18"; negotiation now at index.mjs:71-73 with regression test

### 2026-08-15 — review: Slice B
- MAJOR · plugins/dig/server/auth.mjs:145 · dig_status reports "sign-in in progress" forever after deny/state-mismatch/timeout/exchange-failure — activeFlow.result set only on success and probe-403 · user clicks Cancel then checks dig_status per dig_connect's own instruction and is told to keep waiting, permanently · slice B review
- MAJOR · plugins/dig/server/token-store.mjs:59-83 · lock release has no ownership check, stale-break is TOCTOU, 30s staleness vs unbounded refresh fetch, no mtime heartbeat · >30s Spotify stall with two sessions → concurrent refresh of the same token → invalid_grant signOut deletes the fresh token file, both sessions signed out · slice B review
- MAJOR · plugins/dig/server/auth.mjs:75 · superseded flow's in-flight callback writes its result and refresh token into the NEW flow's state — close() cannot cancel an accepted request · dig_connect twice, approve the first tab: old approval overwrites the newer sign-in and status reports the wrong outcome · slice B review
- MAJOR · plugins/dig/server/token-store.mjs:40 · with CLAUDE_PLUGIN_DATA unset, TokenStore builds "null.lock" and writes it into the cwd — only dig_connect guards, not the store · slice C calls getAccessToken per request; unset-env config writes lock files into the user's project directory (banned class) · slice B review
- MAJOR · plugins/dig/test/token-store.test.mjs:53 · rotation-ordering test cannot distinguish persist-before-use from persist-after — the R3-forbidden inversion passes 27/27 · future refactor inverts ordering, suite stays green, crash window bricks installs · slice B review
- MAJOR · docs/dig-build-plan.md:65 · AC3's named verification cannot be performed — no authed tool exists in slice B, refresh machinery unproven against the live product · restart-reuses-token is only unit-tested; open question to Tony: defer to slice C or add a standalone exercise path · slice B review
- MINOR · plugins/dig/test/callback.test.mjs:42 · `|| true` makes the self-contained-HTML assertion unconditionally pass · mitigation has no effective automated guard while reading as covered · slice B review
- MINOR · plugins/dig/test/token-store.test.mjs:66 · crash-persist test verifies skipped-persist, not mid-write crash; atomicity itself unexercised · truncate-then-write mutant survives all but the incidental mode check · slice B review
- MINOR · plugins/dig/test/no-localhost.test.mjs:29 · SKIP_FILES basename-matched at any depth, and walker scans untracked/ignored files · future same-named file anywhere is exempt; local scratch files can flake the suite · slice B review
- MINOR · plugins/dig/test/token-store.test.mjs:14 · mkdtemp dirs never cleaned up · tmpdir accumulation per run · slice B review
- MINOR · plugins/dig/server/token-store.mjs:105 · past six months ageWarning still says "about 0 days left" — no expired branch before invalid_grant fires · 8-month-old token reads as merely low on days · slice B review
- MINOR · plugins/dig/server/callback.mjs:109 · state-mismatch-with-code and exchange-failure pages return HTTP 200 · scripted callers read errors as success · slice B review
- MINOR · plugins/dig/server/callback.mjs:127 · no 'error' listener on the http server and no reject path for listen failure · dig_connect hangs (or process crashes) on EACCES/port exhaustion · slice B review
- MINOR · plugins/dig/server/auth.mjs:97 · spawn ENOENT is an async error event with no listener — openBrowser try/catch doesn't cover it · on non-macOS without xdg-open the first dig_connect kills the whole MCP server · slice B review
- MINOR · plugins/dig/server/index.mjs:150 · EOF-flush of a final unterminated line + synchronous process.exit loses async tool replies · trailing dig_connect at half-close gets zero replies — the fold's own guarantee broken for async tools · slice B review
- MINOR · plugins/dig/server/auth.mjs:117 · sign-in persist and signOut write the token file outside the exclusive lock · completing sign-in interleaves with another session's locked read-refresh-write; file can describe the wrong account · slice B review
- MINOR · plugins/dig/server/callback.mjs:88 · any local process hitting /callback consumes the one-shot listener via state-mismatch · sign-in denied by a localhost port-scan during the 5-minute window; recovery is rerunning dig_connect · slice B review
- MINOR · plugins/dig/test/stderr-only.test.mjs:22 · comment stripper truncates lines at "//" inside URL string literals · a stdout write after a URL on the same line escapes the lint · slice B review
- MINOR · .gitignore:1 · no pattern for *.lock or token.json.tmp-* — the tmp file holds the plaintext refresh token · in-repo data-dir configuration plus a crash leaves an unignored token-bearing file one git add away · slice B review
- MINOR · plugins/dig/server/token-store.mjs:31 · CLAUDE_PLUGIN_DATA trusted verbatim, no absolute-path/sanity validation; no token-invalidation API authored for slice C's 401-retry rule · hostile/odd env lands state in unexpected places; C must reach into store.access undocumented · slice B review

WAIVED (per user) · 2026-08-15 · MAJOR · docs/dig-build-plan.md:65 · AC3's named verification cannot be performed — no authed tool exists in slice B, refresh machinery unproven against the live product — deferred by Tony to a later slice ("slice d"; the first slice shipping an authed live call exercises it)

### 2026-08-15 — recheck: Slice B
- MAJOR · plugins/dig/server/auth.mjs:145 · (dig_status reports "sign-in in progress" forever after deny/state-mismatch/timeout/exchange-failure) · fixed — executed: deny, forged state, and exchange failure each leave a reportable failed result rendered by dig_status; mechanism now at auth.mjs:180-188 (done.catch → failureMessage)
- MAJOR · plugins/dig/server/token-store.mjs:59-83 · (lock release has no ownership check, stale-break is TOCTOU, 30s staleness vs unbounded refresh fetch, no mtime heartbeat) · fixed — executed: ownership-checked release leaves a foreign lock in place, stale-break claims by rename, refresh fetch bounded at 20s, heartbeat refreshes mtime every 5s (verified live); lock logic now at token-store.mjs:63-103
- MAJOR · plugins/dig/server/auth.mjs:75 · (superseded flow's in-flight callback writes its result and refresh token into the NEW flow's state) · fixed — executed the exact race with a gated exchange: old approval persisted nothing, results land on per-flow records only
- MAJOR · plugins/dig/server/token-store.mjs:40 · (with CLAUDE_PLUGIN_DATA unset, TokenStore writes "null.lock" into the cwd) · fixed — executed in a scratch cwd: getAccessToken/persist refuse with a clear error, signOut no-ops, cwd stays empty; guard at token-store.mjs:146-150
- MAJOR · plugins/dig/test/token-store.test.mjs:53 · (rotation-ordering test cannot distinguish persist-before-use from persist-after) · fixed — the forbidden inversion mutation now fails the suite (32/34 on the mutated copy); ordering observed at token-store.test.mjs:59-70

### 2026-08-15 — review: Slice D
- MAJOR · plugins/dig/server/matching.mjs:97 · norm()'s leading-track-number strip uses /(?=\w)/ without the u flag — JS \w is ASCII-only vs Python's Unicode \w · "07 東京" normalizes unchanged in Node (Python strips to "東京"): a CJK/Hangul title with a leading track number is REJECTED where the reference returns CONFIDENT · slice D review
- MINOR · plugins/dig/server/matching.mjs:336 · Math.round (half-up) vs Python banker's rounding on the reported score; can emit -0 · exact .0005-boundary score reports 0.813 vs reference 0.812 (verdict itself computed pre-round) · slice D review
- MINOR · plugins/dig/server/matching.mjs:265 · reason strings use JSON.stringify list formatting vs Python list repr · downstream copy or tests written against the reference's reason strings won't match · slice D review
- MINOR · plugins/dig/server/matching.mjs:71 · toks() splits on a literal space vs Python's any-whitespace split · a future caller passing a non-norm'd string ("a\tb") gets one token instead of two, silently changing similarity · slice D review
- MINOR · plugins/dig/server/matching.mjs:87 · toLowerCase substituted for Python casefold without a ledger entry · no divergent input found (LIG+NFKD absorb known deltas) but the substitution is unrecorded · slice D review
- MINOR · plugins/dig/test/matching.test.mjs:1 · suite asserts verdicts only, never scores or metric-primitive outputs · a future regression in levSim/sequenceMatcherRatio that shifts scores within a verdict bucket passes green · slice D review
- MINOR · plugins/dig/server/matching.mjs:149 · verify() throws a raw TypeError on missing title/name/artists, and no adapter/typedef pins the candidate shape vs Spotify's raw item ({artists:[{name}]}, album object) · slice E passing an unmapped API item or a proposal missing a title crashes the tool instead of returning a verdict or validation error (faithful to reference; seam undocumented) · slice D review
- MINOR · plugins/dig/server/matching.mjs:342 · verifyCandidates ties (equal verdict + score) resolve by input order, undocumented · two CONFIDENT masters of one song: "best" is whichever Spotify listed first · slice D review
- MINOR · plugins/dig/server/matching.mjs:250 · R4's "per-gate outcomes" delivered as free-text reason strings; passing gates leave no numeric trace ("clean") · tool logic needing which-gate-failed or a score breakdown must parse strings — flagged as an open interpretation question to Tony, graded MINOR (faithful to reference; prose evidence likely suffices for slice E) · slice D review

### 2026-08-15 — recheck: Slice D
- MAJOR · plugins/dig/server/matching.mjs:97 · (norm()'s leading-track-number strip uses /(?=\w)/ without the u flag — JS \w is ASCII-only vs Python's Unicode \w) · fixed — executed in both runtimes: lookahead now [\p{L}\p{N}_]/u at matching.mjs:99, "07 東京"→"東京" and the 東京 verify case returns CONFIDENT matching Python; eight probe inputs (CJK, Hangul, ASCII, underscore, digit-after-number, 3-digit no-strip) byte-identical across Node and Python; regression test at matching.test.mjs:131-137; suite 70/70; no fix-introduced defects

WAIVED (per user) · 2026-08-15 · MINOR · plugins/dig/server/matching.mjs:250 · R4's "per-gate outcomes" delivered as free-text reason strings; passing gates leave no numeric trace ("clean") — Tony ruled keep as-is (reference-faithful prose evidence suffices; structured fields only if slice E proves to need them)

### 2026-08-15 — review: Slice C
- BLOCKER · plugins/dig/server/read-tools.mjs:177-182 · null playlist rows (local/unavailable tracks) filtered out BEFORE position numbering and page accounting · a page containing null rows returns shifted positions (feeding them back as offset lands on the wrong track), a duplicated row on the next page (next offset advances by filtered count, not raw rows), and a page of all-null rows yields next_call with the SAME offset — an infinite pagination loop the server instructions tell the model to follow exactly; probe-verified with [null,A,B,C] limit=2 · slice C review
- MAJOR · plugins/dig/server/find-index.mjs:51 · index positions renumbered over the null-stripped array (same root as the BLOCKER) · dig_find_in_playlist tells the user to page the returned positions, but they disagree with real playlist offsets for any playlist containing local/unavailable tracks — the write slices will consume these positions · slice C review
- MAJOR · plugins/dig/server/spotify-client.mjs:59-67 · R4's 60-second wait cap is enforced per REQUEST (retried429 is per-#execute), not per tool call · a multi-request tool (index build = 81 requests on a 4,000-track playlist) under alternating 429/success with Retry-After ≤60 can block one tool call ~80 minutes (81 × 59s) with no report · slice C review
- MAJOR · plugins/dig/server/error-map.mjs:58 · /playlist/ substring-matches "/me/playlists", so an allowlist 403 on dig_list_playlists — the most likely first-run failure — leads with the "Spotify refused access to that playlist / owns or collaborates" ownership copy instead of R5's allowlist copy (the allowlist steps only appear as an embedded afterthought) · user's very first read after connecting misdiagnoses the User Management trap · slice C review
- MINOR · plugins/dig/server/read-tools.mjs:333-346 · error wrapper maps only the four known classes: fetch TimeoutError/network TypeError, acquireLock timeout, ensureFile, and non-invalid_grant refresh failures surface as "Dig hit an internal error: …" instead of R5 instructions · Spotify hanging 30s — an expected failure mode — reads as a Dig bug · slice C review
- MINOR · plugins/dig/server/spotify-client.mjs:60 · Retry-After in HTTP-date form parses to NaN → 1s wait, then RateLimitError(1) says "wait 1 seconds" when the real ask may be hours · slice C review
- MINOR · plugins/dig/server/read-tools.mjs:77-80 · search-cap note fires on tracks.length === limit, so limit:5 with 5 results claims Spotify's 10-cap was hit and says refine-not-page when raising limit would return more · slice C review
- MINOR · plugins/dig/server/read-tools.mjs:344 · out-of-range offset (5000 on a 4,000-track playlist) renders "Showing 5000-5000 of 4000" — exhaustion stated, range fictional · slice C review
- MINOR · plugins/dig/server/find-index.mjs:22 · index cache unbounded (one full compact tracklist per playlist ever touched, never evicted) and no in-flight dedup — two overlapping get()s for one playlist page it twice; index build itself has no request-count ceiling (10k tracks = 200 sequential requests, mid-build 429 discards everything) · slice C review
- MINOR · plugins/dig/server/index.mjs:47-49 · tools/call arriving as a notification (no id) emits an id-less result frame (JSON.stringify drops id: undefined) — invalid JSON-RPC; pre-existing shape from slice A, kept through the registry refactor · slice C review
- MINOR · plugins/dig/server/read-tools.mjs:69 · non-numeric limit/offset (limit:"abc") passes Math.min/max as NaN and reaches Spotify as limit=NaN → 400 surfaced as the generic unexpected-error copy instead of a validation message; probe-verified · slice C review
- MINOR · plugins/dig/server/read-tools.mjs:112,178 · when Spotify omits total (full-detail has no fields filter; /me/playlists relies on default shape) the fallback total equals rows-served and pageNote falsely declares the end · slice C review
- MINOR · plugins/dig/server/auth.mjs:132 · sign-in exchange + /v1/me probe fetch directly, outside the serialized queue — R4 says ALL Spotify calls; a callback firing mid-read-tool runs two api.spotify.com requests in parallel · slice C review
- MINOR · plugins/dig/server/index.mjs:113 · all tool replies now resolve async, so responses can land out of request order (verified live: 3,4,5 answered 4,3,5) — legal JSON-RPC, but a wire-order behavior change from slice A · slice C review
- MINOR · plugins/dig/server/find-index.mjs:27-54 · snapshot fetched before paging: a playlist edit mid-build yields one torn answer (mixed pages stamped with the pre-change snapshot); self-heals on the next call since the meta re-fetch sees the newer snapshot · slice C review
- MINOR · plugins/dig/server/token-store.mjs:215-219 · a 200 refresh response missing access_token caches {token: undefined} for ~1h — every call sends "Bearer undefined", burns its one 401 retry, re-refreshes each time · slice C review

### 2026-08-15 — recheck: Slice C
- BLOCKER · plugins/dig/server/read-tools.mjs:177-182 · (null playlist rows filtered out BEFORE position numbering and page accounting) · fixed — probed [null,A,B,C] limit=2: A at raw position 1, next offset advances by raw rows, no duplicate on page 2; all-null page reports unavailable_rows and still advances (no loop); mechanism now at read-tools.mjs:179-196
- MAJOR · plugins/dig/server/find-index.mjs:51 · (index positions renumbered over the null-stripped array) · fixed — probed [null,X,null,Y]: find X returns raw playlist offset 1; positions assigned offset+rowIndex at find-index.mjs:48-51
- MAJOR · plugins/dig/server/spotify-client.mjs:59-67 · (60-second wait cap enforced per request, not per tool call) · fixed — one waitBudget() per tool call threaded through every request (read-tools.mjs:327, find-index paging included); probed: first 429 RA=40 honored, second in the same call throws instead of sleeping; single-request RA>60 still stops immediately; budget logic at spotify-client.mjs:68-80
- MAJOR · plugins/dig/server/error-map.mjs:58 · (/playlist/ substring-matches "/me/playlists" — allowlist 403 got the ownership copy) · fixed — anchored to ^\/playlists\/ at error-map.mjs:61; probed: /me/playlists 403 leads with the allowlist copy, /playlists/{id} keeps the ownership framing
No fix-introduced defects found; suite 94/94

### 2026-08-15 — review: Slice E
- BLOCKER · plugins/dig/test/write-tools.test.mjs:132-158 · AC2(a)'s verification is vacuous — the "uncertain" fixture scores REJECTED (title-gate 0.67), questions stays empty, evidence assertions sit behind `if (res.questions.length)` and never run · mutating write-tools.mjs to auto-add UNCERTAIN passes all 13 tests and the full suite · slice E review
- MAJOR · plugins/dig/server/write-tools.mjs:407 · mid-reorder RateLimitError rethrown to the wrapper's "nothing was lost" boilerplate with moves already applied and no moves_applied count · 150-row reorder 429s at move 40 → playlist scrambled, user told nothing changed · slice E review
- MAJOR · plugins/dig/server/write-tools.mjs:407 · mid-reorder unknown-outcome failure (timeout/network) → "Dig hit an internal error", no re-read, no partial report — the case R3 says must end in a re-read · slice E review
- MAJOR · plugins/dig/server/write-tools.mjs:261 · add's catch rethrows only SpotifyApiError, so a RateLimitError on the POST (write definitively not executed) is swallowed, a re-read fires into the active rate limit, and the result says "ambiguous" instead of relaying the wait · slice E review
- MAJOR · plugins/dig/server/write-tools.mjs:268 · add verification is uri-membership in the re-read window, so a silent-failure add of a track already in the window reports "verified" · re-add a track near its existing copy + silent 200 → false success · slice E review
- MAJOR · plugins/dig/test/write-tools.test.mjs:245 · reorder's verify-after-write layer unpinned — hardcoding "verified" and deleting the re-read comparison passes 13/13; no reorder silent-failure test exists · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:246 · result "no_write" is a fifth token outside R3's vocabulary, pinned by tests while the slice's Deviations block says "none" · downstream consumer switching on four values hits a fifth · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:85 · isConcurrentEditError treats ANY 400/409 on /items as a concurrent edit · a malformed-move regression is reported as "re-plan" instead of the real error · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:372 · dig_reorder pages the entire playlist via findIndex.get before enforcing MAX_REORDER; total is on the first page · 10k-row playlist costs ~200 serialized GETs to produce a refusal · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:321 · HTML-unescape replaces &amp; first, double-unescaping literal "&lt;"-like sequences · description containing "&lt;" verifies as "accepted"/masks mismatches · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:317 · name compared raw while description is unescaped (create's re-read name check too) · renaming to "Dust & Echoes" reports "ambiguous" on a landed write · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:250 · totalBefore falls back "?? 0" (and the tracks.total fallback can never receive data the fields string didn't request) · projection mismatch turns an explicit position into a top-of-playlist insert reported "verified" · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:255 · duplicate proposals resolving to one URI are POSTed twice and both report "verified" off one seen-hit · two proposals, one recording → track added twice, reported as two successes · slice E review
- MINOR · plugins/dig/server/index.mjs:177 · EOF drain callback never fires if the client half-closes stdin but stops reading stdout (immortal orphan); no stdout 'error' handler for EPIPE · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:377 · empty-playlist reorder message renders "permutation of 0--1" · cosmetic nonsense on n=0 · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:262 · queue serializes per-request, not per-tool-call: another call's write can interleave between add's POST and its verify re-read, flipping the verdict either way · near-theoretical single-client today, bites under concurrent sessions · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:143 · create silent-failure path reports "accepted" with a populated playlist object and the re-read failure is swallowed by a bare catch; untested · create that never landed reads like success · slice E review
- MINOR · plugins/dig/test/write-tools.test.mjs:209 · `doesNotMatch(/retry blindly.*safe/i)` can essentially never match — decorative assertion · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:392 · reorder proceeds without a snapshot precondition when the pre-read lacks snapshot_id, silently degrading R4 · slice E review
- MINOR · plugins/dig/server/spotify-client.mjs:98 · non-JSON 2xx body throws a raw SyntaxError, escaping the error-map contract · proxy/captive-portal 200 → "Dig hit an internal error: Unexpected token" · slice E review
- MINOR · plugins/dig/server/write-tools.mjs:251 · out-of-range add position silently clamped to playlist length instead of reported · slice E review
- MINOR · plugins/dig/test/write-tools.test.mjs:91 · the mock's insert_before>range_start shift branch is dead relative to the implementation (moves always have insert_before<range_start) — untested surface if composition changes · slice E review

### 2026-08-15 — recheck: Slice E
- BLOCKER · plugins/dig/test/write-tools.test.mjs:132-158 · (AC2(a)'s verification is vacuous — the "uncertain" fixture scores REJECTED, questions stays empty, evidence assertions sit behind a conditional and never run) · fixed — new fixture (same title/artist, untrusted wrong duration) probed at 0.778 UNCERTAIN with unconditional question-path assertions at write-tools.test.mjs:132-162; mutation auto-adding UNCERTAIN now fails the suite
- MAJOR · plugins/dig/server/write-tools.mjs:407 · (mid-reorder RateLimitError rethrown to the wrapper's "nothing was lost" boilerplate with moves already applied) · fixed — executed: 429 after move 1 returns partial with moves_applied and the rate-limit message in a re-plan note; catch now at write-tools.mjs:416-434, test at write-tools.test.mjs:351
- MAJOR · plugins/dig/server/write-tools.mjs:407 · (mid-reorder unknown-outcome failure surfaces "Dig hit an internal error" with no partial report) · fixed — executed: mid-move TypeError returns partial with moves_applied and "could not be confirmed" re-plan guidance; test at write-tools.test.mjs:371
- MAJOR · plugins/dig/server/write-tools.mjs:261 · (add's catch rethrows only SpotifyApiError, so a RateLimitError on the POST is swallowed and a re-read fires into the active rate limit reporting "ambiguous") · fixed — executed: 429 on the POST surfaces the rate-limit instruction as isError, nothing written; rethrow now covers SpotifyApiError/RateLimitError/AuthExpiredError at write-tools.mjs:267, test at write-tools.test.mjs:273
- MAJOR · plugins/dig/server/write-tools.mjs:268 · (add verification is uri-membership in the re-read window, so a silent-failure add of a track already in the window reports "verified") · fixed — executed: verification now positional + count-based at write-tools.mjs:272-283; pre-existing copy at the insert position + silent 200 lands "ambiguous", test at write-tools.test.mjs:258
- MAJOR · plugins/dig/test/write-tools.test.mjs:245 · (reorder's verify-after-write layer unpinned — hardcoding "verified" passes the suite) · fixed — mutation hardcoding the result line now fails the derangement silent-failure test at write-tools.test.mjs:337
No fix-introduced defects found; suite 113/113

### 2026-08-15 — review: Slice F
- BLOCKER · plugins/dig/server/destructive-tools.mjs:151 · plan tokens are not bound to their operation kind — PlanRegistry.take validates expiry/clientId/digest but never record.kind, and no consumer checks it · a removal_token passed as dig_restore_snapshot's restore_token PUT-replaces the playlist's entire contents with only the planned-removal tracks (a de-facto replace-all, forbidden by R4); a restore token passed to dig_apply_removal DELETEs every snapshot uri and can empty the playlist; a removal token for the same playlist also passes dig_unfollow_playlist's confirm — one approval executes a different destructive act · slice F review (3 lenses converged)
- MAJOR · plugins/dig/server/destructive-tools.mjs:374 · dig_apply_removal's summary argument is never compared to plan.summary — the one string the human sees at the approval prompt has no integrity binding · model presents "Remove 1 duplicate" while the token covers 100 tracks; the approved sentence and the executed plan diverge · slice F review
- MAJOR · plugins/dig/server/destructive-tools.mjs:426 · a RateLimitError/SpotifyApiError thrown during the post-write verify re-read escapes to wrapTools as a bare error — result and snapshot pointer lost, token already consumed; in dedupe, a throw between removal-verify and the re-add POST leaves the playlist missing tracks with no partial report at all · a landed removal reads as a failed call and the user is told not to retry, with the snapshot name existing only on disk · slice F review
- MAJOR · plugins/dig/server/index.mjs:36 · the three tool factories each build their own FindIndex; verifyRead clears only the destructive instance's cache · after a verified removal, Spotify's stale post-delete snapshot_id validates the read tools' cached entry and dig_find_in_playlist reports the removed track still present — inviting a second removal of already-gone rows · slice F review (2 lenses converged)
- MAJOR · plugins/dig/server/destructive-tools.mjs:682 · unfollow's messages promise the snapshot is "restorable into a new playlist" but no such path exists — dig_restore_snapshot only PUTs to the snapshot's original playlist_id, which 404s after owner-unfollow · user deletes a 300-track playlist trusting the message and cannot recover it through Dig's surface · slice F review (2 lenses converged)
- MAJOR · plugins/dig/server/destructive-tools.mjs:312 · dedupe of a playlist whose every row is a duplicate copy passes the rowsKept check (re-adds counted), so the DELETE empties the playlist transiently, and a re-add failure or crash in the window leaves it empty · violates R4's "no code path empties a playlist" in the failure case (snapshot exists, so recoverable) · slice F review (3 lenses converged)
- MAJOR · plugins/dig/server/destructive-tools.mjs:75 · snapshot filenames have millisecond resolution and writeFileAtomic0600 rename-overwrites — two snapshots of one playlist in the same ms silently destroy the earlier rollback point · breaks R3's always-restorable promise exactly when writes cluster (retry loops); the restore test's apply-then-restore is the collision window and only asserts truthiness · slice F review (2 lenses converged)
- MINOR · plugins/dig/server/destructive-tools.mjs:164 · digest check is self-referential (recomputed from the same record that stores it) — can only fail on in-process mutation; satisfies R1's letter but adds no integrity beyond the Map lookup · slice F review (4 lenses converged)
- MINOR · plugins/dig/server/destructive-tools.mjs:143 · PlanRegistry never prunes expired plans; abandoned plans accumulate for the server's lifetime · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:125 · readSnapshot lets JSON.parse throw a raw SyntaxError (escapes wrapTools as "internal error") and never validates the snapshot's shape — undefined playlist_id would target /playlists/undefined · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:312 · rowsKept counts unavailable/local rows as "kept" — a playlist of 1 real track + N ghost rows lets the last playable track be removed · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:515 · restore's PUT/POST carry no snapshot_id precondition and no staleness warning — a playlist edited during the 15-minute token window is silently clobbered (pre-restore snapshot softens it) · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:664 · unfollow has no unknown-outcome fallthrough — a timeout on DELETE /me/library surfaces as a raw internal error with no verify and no snapshot pointer even though the unfollow may have landed · slice F review
- MINOR · plugins/dig/test/destructive.test.mjs:365 · AC3 proven at the factory layer, not the server's tools/list; the default-absence test deletes DIG_ENABLE_UNFOLLOW but not CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW — ambient env flips it · slice F review (2 lenses converged)
- MINOR · plugins/dig/test/destructive.test.mjs:239 · snapshot-before-write ordering unpinned — content comes from the pre-read, so moving writeSnapshot after the DELETE still passes · slice F review
- MINOR · plugins/dig/test/destructive.test.mjs:46 · the /me/playlists mock ignores limit/offset, so unfollow's 200-row paging, checkedAll, and "accepted" branch never execute · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:514 · restore's multi-batch path (>100 uris) and its partial mid-restore branch are unexercised by any test · slice F review
- MINOR · plugins/dig/server/instructions.mjs:5 · instructions sit at 2033 of 2048 bytes — 15 bytes of headroom before the budget test breaks · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:63 · listSnapshots routes through requireSnapshotsDir, so the read-only listing errors with destructive-write copy when CLAUDE_PLUGIN_DATA is unset · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:186 · isConcurrentEditError duplicated verbatim from write-tools.mjs:86 · slice F review
- MINOR · plugins/dig/server/destructive-tools.mjs:434 · dedupe re-add verifies by original URI, so track-relinking could mark a landed re-add partial and the note nudges toward a manual re-add that would duplicate · slice F review

### 2026-08-15 — recheck: Slice F
- BLOCKER · plugins/dig/server/destructive-tools.mjs:151 · (plan tokens not bound to operation kind — cross-tool reuse turns one approval into a different destructive act) · fixed — take(token, clientId, kinds) rejects kind mismatches (now destructive-tools.mjs:157-169); consumers pass ["removal","dedupe"] / ["restore"] / ["unfollow"]; executed: a removal token passed as a restore was refused with "minted for a different operation"
- MAJOR · plugins/dig/server/destructive-tools.mjs:374 · (apply's summary never compared to plan.summary) · fixed — mismatch throws before any write (now :402-409); the approval sentence is bound to the plan verbatim
- MAJOR · plugins/dig/server/destructive-tools.mjs:426 · (verify-failure after a landed write escapes as a bare error, losing result + snapshot pointer; dedupe left no partial report) · fixed — removal verify wrapped (now :454-467, dedupe-aware partial), re-add failure returns partial with recovery options (:481-488), post-re-add and restore verifies return accepted with pointers (:489-500, :595-605); executed: 429 on the post-DELETE re-read yields result accepted with the snapshot name
- MAJOR · plugins/dig/server/index.mjs:36 · (three separate FindIndex caches; verify cleared only the destructive one) · fixed — one sharedIndex built at index.mjs:39 and injected into all three factories (:44-46); verifyRead's invalidation now reaches the cache read tools serve from
- MAJOR · plugins/dig/server/destructive-tools.mjs:682 · (unfollow promised "restorable into a new playlist" with no such path) · fixed — dig_restore_snapshot accepts into_playlist_id (retarget at :628, token/digest bound to the target :633-644) and the unfollow copy names the real path (:719) plus Spotify's 90-day recovery
- MAJOR · plugins/dig/server/destructive-tools.mjs:312 · (all-duplicates dedupe passes the kept check and empties the playlist transiently/permanently) · fixed — never-empty guard now measures playable rows before re-add (:329-335) with a dedupe-specific refusal; executed: [A,A,B,B] mode:duplicates refused at plan time, no token minted
- MAJOR · plugins/dig/server/destructive-tools.mjs:75 · (same-millisecond snapshot names rename-overwrite the earlier rollback point) · fixed — random suffix appended (now :78); executed: back-to-back snapshots of one playlist produced distinct files
No fix-introduced defects found; suite 146/146

### 2026-08-15 · Slice F post-review rulings
- Tony ruled (question 1): the removal-token "bound to user" implementation stays bound to the connected app's client_id — no account-level binding needed (one app = one person is Dig's design) · per user
- Tony ruled (question 2): playlist deletion (dig_unfollow_playlist) must become enableable by a non-developer — added to Slice G as R6/AC4 rather than reopening F · per user

### 2026-08-15 — review: Slice G
- MAJOR · plugins/dig/server/config.mjs:14 · BAD_CLIENT_ID_MESSAGE directs "click **Settings**" — the live dashboard has no Settings page (this slice's own verification) · user pastes a wrong ID, follows the copy, finds no Settings button; dig_doctor amplifies the message verbatim · slice G review (2 lenses converged)
- MAJOR · plugins/dig/server/error-map.mjs:10 · ALLOWLIST_403_MESSAGE step 2 says "Click **Settings**, then the **User Management** tab" — no Settings page exists; User Management is a tab on the app page (/dashboard/<id>/users) · the most-likely first-run 403's instructions dead-end at a missing button · slice G review (2 lenses converged)
- MAJOR · plugins/dig/test/doctor.test.mjs:65-80 · the expired/allowlist/premium probe-failure tests cannot tell which doctor branch fired — the generic fallback interpolates err.message, which equals the asserted copy · mutation replacing both mapped branches with `if (false)` passes 11/11 · slice G review (mutation-proven)
- MAJOR · plugins/dig/test/unfollow-config.test.mjs:49 · placeholder-must-not-mask-fallback is untested: no case combines a "${...}" primary with fallback "true" · mutation dropping the startsWith("${") guard passes 6/6 while the real userConfig-unset install scenario would lose the opt-in · slice G review (mutation-proven)
- MAJOR · docs/dig-build-plan.md (Deviations · Slice G, AC1 entry) · AC1's from-scratch fresh-eyes run unexercised-in-full (builder call) · the acceptance criterion "a from-scratch setup completes without improvising" was met only by live dashboard reads + a fresh-agent text walkthrough, not a real run · slice G review (rule-4 cap; Tony's call)
- MAJOR · docs/dig-build-plan.md (Build assumptions · Slice G, redirect-copy entry) · R5's "six §12 messages wired" met as five-at-triggers + redirect-rejected paraphrased in skill/doctor text (builder call; no runtime trigger exists, verbatim draft contains the repo-banned word) · R5's letter unmet as written · slice G review (rule-4 cap; Tony's call)
- MINOR · plugins/dig/server/config.mjs:19 · UNCONFIGURED_MESSAGE's "/plugin → settings" path contradicts the setup skill's CLI-only rule · doctor and skill give conflicting rescue advice in the same session · slice G review
- MINOR · plugins/dig/skills/setup/SKILL.md (step 2) · redirect URI hardcoded to port 8888 while DIG_CALLBACK_PORT exists · an override user registers a URI the server never serves; sign-in silently times out · slice G review (2 lenses)
- MINOR · plugins/dig/server/destructive-tools.mjs:212 · trim-order asymmetry vs config.usable(): whitespace-only primary masks the fallback; " true " now enables where it didn't before · divergent "same lesson" readers; enable-direction change on a destructive gate · slice G review (2 lenses)
- MINOR · plugins/dig/server/doctor.mjs:56 · doctor ignores an in-flight sign-in (result null) and advises dig_connect, which supersedes the live flow · user mid-approval gets their browser tab invalidated · slice G review
- MINOR · plugins/dig/server/doctor.mjs:63 · future/missing obtained_at renders "-1 days old" / claims "connected today" with no age warning · misleading age report on clock skew or a hand-edited record · slice G review
- MINOR · plugins/dig/server/doctor.mjs:69 · REDIRECT_HINT printed unconditionally on the no-token branch · a clean fresh install's first doctor run leads with failure copy · slice G review (2 lenses)
- MINOR · plugins/dig/server/doctor.mjs:1 · every failed diagnosis returns isError:false (documented builder call) · a client branching on isError treats a broken setup as success · slice G review
- MINOR · plugins/dig/server/index.mjs:44 · default tool surface now 17 (18 enabled) vs the constraint's 12–16 target · constraint drift, disclosed · slice G review (2 lenses)
- MINOR · plugins/dig/skills/digging/SKILL.md · "put it in the proposal's `version` field or title" vs write-tools schema's "title, without version tags" · following the "or title" branch fights the schema's design · slice G review
- MINOR · plugins/dig/test/doctor.test.mjs:14 · readToken always injected (default-deps wiring unproven); probe endpoint/budget unasserted; isError unasserted on several paths · narrow mutants survive · slice G review

### 2026-08-15 — recheck: Slice G
- MAJOR · plugins/dig/server/config.mjs:14 · (BAD_CLIENT_ID_MESSAGE directs "click Settings" — page no longer exists) · fixed — copy now names the Basic Information page + copy button; grep over server/ and skills/ finds no remaining Settings instruction in served copy
- MAJOR · plugins/dig/server/error-map.mjs:10 · (ALLOWLIST_403_MESSAGE step 2 says "Click Settings, then the User Management tab") · fixed — copy now: open the app, User Management tab (next to Basic Information), name + Spotify-account email, click Add user; matches the live-dashboard record
- MAJOR · plugins/dig/test/doctor.test.mjs:65-80 · (probe-failure tests can't tell which branch fired; branch-deleting mutant passed 11/11) · fixed — mutant re-executed on a /tmp copy: 3 of 11 now fail; branch-discriminating asserts landed
- MAJOR · plugins/dig/test/unfollow-config.test.mjs:49 · (placeholder-must-not-mask-fallback untested; guard-dropping mutant passed 6/6) · fixed — mutant re-executed on a /tmp copy: 1 of 7 now fails; combined placeholder+fallback case landed
- MAJOR · docs/dig-build-plan.md (Deviations · Slice G, AC1 entry) · (AC1 fresh-eyes run unexercised-in-full, builder call) · not fixed — awaiting Tony's ruling (accept the live-verified + fresh-agent walkthrough, waive, or run it himself)
- MAJOR · docs/dig-build-plan.md (Build assumptions · Slice G, redirect-copy entry) · (R5's "six §12 messages" met as five-at-triggers + paraphrased redirect hint, builder call) · not fixed — awaiting Tony's ruling
No fix-introduced defects; suite 164/164

### 2026-08-16 · Slice G post-recheck rulings
- Tony ruled (AC1): he will run the from-scratch fresh-eyes setup himself on a brand-new dummy Spotify account (new email, new person simulation) — the AC1 MAJOR stays OPEN until that run; not waived · per user
- Tony ruled (self-add question): the 2026-08-15 "0/5 users added yet calls work" observation is NOT evidence the trap is gone — he had already added himself before this work (the dashboard's 0/5 display vs his recollection is unreconciled; check during the new-account test). User Management step stays loud. The AC1 dummy-account run doubles as the live test of whether self-add is still required · per user

WAIVED (per user) · 2026-08-16 · MAJOR · docs/dig-build-plan.md (Build assumptions · Slice G, redirect-copy entry) · R5's "six §12 messages" met as five-at-triggers + paraphrased redirect hint in skill text and dig_doctor — Tony blessed skill/doctor as the copy's home (no runtime trigger exists)

### 2026-08-16 — review: Slice G2
- BLOCKER · plugins/dig/server/config-file.mjs:19-31 · non-string config.json value crashes the server at startup and every tools/list — usable() calls .trim() on unvalidated values · {"spotify_client_id": 123} or {"dig_enable_unfollow": true} (the natural hand edit) → TypeError at module load, server dead permanently with no recovery instruction; reproduced live · slice G2 review
- MAJOR · plugins/dig/server/index.mjs (handleToolCall gate) · tools/call gating of a disabled dig_unfollow_playlist is unpinned by tests — mutation removing entryActive() from the call path passed the full suite · a regression drops the call-side gate: tool hidden from tools/list but callable with no opt-in, suite green; also weakens slice F AC3 (destructive.test.mjs rewrite pins listing only) · slice G2 review (mutation-proven, 2 lenses)
- MAJOR · plugins/dig/server/config.mjs (resolveClientId) · invalid-shape env value masks a valid file value; dig_set_client_id says "active right now" falsely; status/doctor never surface the mismatch in the invalid state · env "my-app-name" + correct ID pasted in chat → success text, nothing works, no chat-reachable fix · slice G2 review (2 lenses converged)
- MAJOR · plugins/dig/server/config-file.mjs:36-44 · writeConfigPatch read-merge-write has no lock · two sessions: one sets Client ID while the other flips deletion → one write silently lost (acquireLock exists in the same module) · slice G2 review
- MAJOR · plugins/dig/server/config-tools.mjs (digSetClientId) · mid-session ID change silently destroys the stored connection with no warning · new valid-shape value (e.g. a pasted 32-hex Client Secret) → token-store client_id mismatch → signOut deletes token.json, full re-auth · slice G2 review
- MAJOR · plugins/dig/server/status.mjs / doctor.mjs · R4/R6 implemented for the Client ID only — unfollow flag's active source and env-vs-file mismatch never reported · "why won't deletion enable" support conversation gets no source info · slice G2 review
- MINOR · plugins/dig/server/callback.mjs (reference page step 5) · post-install "start a new chat" instruction dropped entirely · fresh installer reading the page standalone gets no new-chat hint · slice G2 review (2 lenses)
- MINOR · plugins/dig/server/index.mjs (handleToolCall) · disabled-but-registered tool answers bare -32602 like an unknown tool · model calling a just-disabled unfollow gets a protocol error, no "turned off" text · slice G2 review (2 lenses)
- MINOR · plugins/dig/server/config-file.mjs:22-27 · chmodSync failure inside the read try discards a readable config · group-readable file owned by another uid reads as absent while status says "not configured" · slice G2 review
- MINOR · plugins/dig/server/config-file.mjs:22-25 · a directory named config.json gets chmod'd 0600 on read (no isFile() check) · read path mutates directory permissions, then reads as absent · slice G2 review
- MINOR · plugins/dig/server/config-tools.mjs:74 · list_changed notification fires unconditionally, including no-op and env-overridden writes · hosts re-list for nothing; signal unreliable · slice G2 review
- MINOR · plugins/dig/server/destructive-tools.mjs (PlanRegistry) · disable→re-enable within 15 min does not invalidate an outstanding unfollow confirm token · stale approval executes after a revocation window · slice G2 review
- MINOR · plugins/dig/server/config-file.mjs:41 · merge re-persists garbage keys/non-string values from an existing file (amplifies the BLOCKER); corrupt file merges onto {} silently dropping the other setting · slice G2 review
- MINOR · plugins/dig/server/config.mjs (resolveClientId) · every checkClientId() now stats+reads config.json even when env is usable, including the per-request hot path (spotify-client.mjs:44) · hung/slow data-dir mount taxes every API call · slice G2 review
- MINOR · plugins/dig/server/config.mjs (resolveUnfollowFlag) · whitespace-only primary env no longer terminal: precedence flip can enable the destructive gate across the upgrade with no user action (deliberate, ledgered) · slice G2 review
- MINOR · plugins/dig/server/status.mjs · dig_status has no line saying playlist deletion is enabled · cross-session enable is invisible until a tools/list · slice G2 review
- MINOR · plugins/dig/server/config-tools.mjs (digSetClientId success text) · lacks the never-paste-the-Secret warning at the exact paste-in-chat moment; a pasted Secret passes the shape check · slice G2 review
- MINOR · plugins/dig/test/config-file.test.mjs:260-278 · enable-then-call path untested (only tools/list asserted after enable) · slice G2 review
- MINOR · plugins/dig/test/config-file.test.mjs:149 · alternation regex's second branch matches alone — near-vacuous assert · slice G2 review
