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
Status: not started

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
Status: built

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
Status: not started

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
Status: not started

## Slice G — Onboarding skills, digging skill, doctor
Goal: The ten minutes before Dig works, made survivable by a non-developer, plus the taste layer that makes digging good.
Requirements:
- R1: Setup skill (`plugins/dig/skills/setup/SKILL.md`): the PRD §9 order of operations — step 0 Premium ask (stop on no), create app, paste exact redirect URI, copy Client ID (with the never-paste-your-Client-Secret warning), User Management self-add stated LOUDLY with the up-to-15-minutes lag said out loud, browser sign-in. Exact URLs and exact button names verified against the live dashboard during this slice. Ends by telling the user to start a new chat if tools are missing (plugin servers connect at session start — verified finding, PRD §12).
- R2: The reference page content finalized to mirror the skill (built in slice B; this slice makes the two agree).
- R3: Digging skill (`plugins/dig/skills/digging/SKILL.md`): Claude proposes from its own knowledge, Dig verifies, present the found/not-found list before adding, report misses honestly, never pad, honor explicit version requests, uncertain matches come back as questions with the matcher's evidence (PRD §5, §6).
- R4: `dig_doctor` tool: checks Client ID shape, token presence/age (five-month warning), and one live probe call; maps each failure to its research §12 instruction (Premium, allowlist, expired, redirect mismatch) (PRD §10).
- R5: All six research §12 draft error messages wired to their actual trigger points across the server.
Acceptance criteria:
- AC1: Fresh-eyes run: with the skill as the only guide, a from-scratch setup on the Mac Studio completes without improvising (Tony or a fresh Claude session following only the skill text) — verify: manual.
- AC2: `dig_doctor` distinguishes at least: unconfigured, bad-shape ID, no token, expired token (mocked), healthy — verify: new tests at `plugins/dig/test/doctor.test.mjs` plus one live healthy run.
- AC3: The no-localhost test still passes; the skill files carry exact dashboard URLs — verify: existing test + manual read.
Footprint: `plugins/dig/skills/`, `plugins/dig/server/` (doctor, error copy), reference page content, `plugins/dig/test/`.
Not in this slice: README/marketplace copy (slice H).
Depends on: Slices B–F (documents and doctors what exists)
Status: not started

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
