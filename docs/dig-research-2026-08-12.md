# Dig — research report

**A white-label Spotify playlist tool, shipped as a Claude Code plugin.**
Researched 2026-08-12. Six parallel research tracks: existing implementations, Spotify Web API state, MCP server design, Claude Code plugin packaging, track matching, and failure modes.

Nothing has been built. This document exists to decide what to build.

---

## 1. Bottom line

**The project is viable, but three constraints are non-negotiable and one of them may exclude some of your friends.**

1. **Every user needs Spotify Premium.** Not because of playback, which we cut, but because development-mode apps require it. There is no way around this.
2. **Each user's tool only works on their own playlists.** Reading someone else's playlist, or any Spotify editorial playlist, is no longer possible for a new app.
3. **Authorization expires after six months** and must be renewed. Build re-auth in from day one.

There is also **one unresolved question that could invalidate the delivery method**: an open bug report, filed the same day as this research, claims plugin MCP servers do not start in the Claude desktop app. It could not be reproduced in a terminal and nobody has tested the desktop app itself. That test comes before anything else gets built.

Against that, the opportunity is real and larger than expected. A Spotify API migration in February 2026 broke most of the existing ecosystem, and **almost nothing has migrated**. The most-starred Spotify MCP server (611 stars) is declared inactive and its playlist writes call removed endpoints. There is exactly one Spotify MCP packaged as a Claude Code plugin, it does one narrow thing, and it has zero stars. **Being simply correct against the current API would put Dig ahead of every server with more than ten stars.**

---

## 2. The frame: February 2026 changed everything

Every friend registering their own app creates a **new development-mode app**, and new apps get a restricted API surface. This is the single dominant fact of the project.

Spotify's documentation site shows the union of the old and new worlds, so an endpoint that merely looks deprecated may be fully removed for our users. The changelog is the authority, not the reference pages.

### What was removed for new apps

| Change | Impact on Dig |
|---|---|
| `/playlists/{id}/tracks` → `/playlists/{id}/items`, all four verbs | Confirms the prior session's finding |
| Response fields renamed: `tracks`→`items`, `tracks.tracks`→`items.items`, **`.track`→`.item`** | A URL-only migration compiles, runs, and returns `undefined` for every row |
| Search `limit` max **50 → 10**, default 20 → 5 | Fewer candidates per query, so verified matching matters much more |
| All batch fetches removed (`GET /tracks`, `/albums`, `/artists`) | One request per ID now. Biggest performance regression |
| `POST /users/{id}/playlists` removed → `POST /me/playlists` | Your existing script already does this correctly |
| Follow/unfollow playlist → `PUT`/`DELETE /me/library` (takes URIs, not IDs) | Deleting a playlist is unfollowing it, and the endpoint moved |
| Track fields removed: `popularity`, `available_markets`, `linked_from` | Kills the "pick the most popular version" heuristic and relink detection |
| `GET /me` no longer returns `product`, `country`, `email` | Cannot check Premium status via the API |
| `/recommendations`, `/audio-features`, `/related-artists` (dead since Nov 2024) | Spotify's recommendation engine is unavailable |
| Editorial and algorithmic playlists (Discover Weekly, etc.) off-limits | Cannot read or analyze them |

`external_ids.isrc` was listed as removed in February and **reverted in March**. It survives, and it is now the most reliable track identity signal left.

---

## 3. Hard constraints

### Premium is required for every user

Verbatim from Spotify's quota-modes documentation:

> "**Note:** The app owner must have a Spotify Premium account for apps in development mode to function."

Each friend owns their own app, so each friend needs Premium. If their subscription lapses, their Dig stops working.

### Five authorized users per app, and the allowlist trap

> "Up to 5 authenticated Spotify users can use an app that is in development mode."

> "Users may be able to log into a development mode app without having been allowlisted by the developer. However, API requests with an access token associated to that user and app will receive a **403 status code error**."

Since each friend has their own app with one user, the five-user cap is irrelevant. **The allowlist step is the real risk**: OAuth succeeds, the token looks valid, and every call fails with a 403 that reads like a scope bug. This is the single most likely first-run failure, and it must be handled explicitly in onboarding.

Path: Dashboard → app → Settings → Users Management → Add new user (name + Spotify email).

### Extended quota mode is permanently closed to you

Since May 2025 Spotify accepts applications from **organizations only**, not individuals. Requirements include a registered business entity, a launched service, and a **minimum of 250,000 monthly active users**. Spotify's own statement: "over 95% of the applications we receive for extended Web API access fall short."

**Design Dig permanently around development-mode constraints.** There is no growth path out of them, and no route that serves a free-tier user.

### Refresh tokens expire after six months

New as of June 2026, and it contradicts every older tutorial:

> "Refreshing an access token does not extend the refresh token's lifetime... After 6 months, the refresh token can no longer be used... Build reauthorization into your app before refresh tokens expire."

Expiry surfaces as a `400` with `invalid_grant`. On that error, discard the refresh token and restart the authorization flow. Without this, every install dies silently about six months after setup.

### Only the user's own playlists

`GET /playlists/{id}/items` returns 403 for any playlist the user does not own or collaborate on, and `GET /playlists/{id}` silently omits the items object entirely. "Clean up that playlist my friend sent me" is not possible.

---

## 4. What already exists

Twenty-one Spotify MCP servers surveyed. The landscape is in worse shape than expected.

### The headline numbers

- **Only 6 of 21 use PKCE with a client ID and no secret.** The majority ask users for a client secret they do not need, which then lands in a plaintext config file people paste into chat and issue trackers.
- **The most-starred server (611 stars, 131 forks) is broken for playlist writes** and declares itself inactive. Every unpatched fork inherits that.
- **Tool counts range from 5 to 100** for essentially the same API, a twentyfold spread.
- **Reorder is entirely absent from 7 of 12** mid-tier servers.
- **Nobody exposes positional removal.** Consequence: you cannot remove the second copy of a duplicated track. Every dedup tool either removes both or is silently wrong.
- **One server scores match confidence.** It has 2 stars.
- **One Spotify MCP is packaged as a Claude Code plugin.** It only reorders, has 0 stars, and was last touched in May.

### The best one, and what to take from it

`martin-gomola/spotify-mcp` is the best-engineered server found, despite 0 stars and being packaged for a different tool entirely. Worth copying:

- **A result vocabulary instead of a boolean.** `verified` (re-read confirmed it), `accepted` (API said OK but contents were not re-read), `ambiguous` (write may have landed, cannot prove it), `partial`. No other server distinguishes "the API returned 200" from "the playlist is now what you asked for."
- **`dry_run` defaulting to true** on destructive operations, with a receipt ID enabling a real undo.
- **Search verification as a hard gate** — writes only when the results contain exactly one exact match, otherwise returns candidates for explicit selection.
- **Tokens bound to the client ID that issued them**, so a mismatched grant forces fresh authorization instead of failing confusingly.

From others: a confidence-scored matcher with a CSV review loop (`khglynn`); server instructions shipped once per session rather than per tool, plus a cron-able script that watches Spotify's changelog and fails when a month goes unreviewed (`jamiew`); a two-minute onboarding wizard and the principle that **"errors are instructions"** (`XavierFabregat`); and server-computed summaries instead of dumping hundreds of tracks into context (`markandeyay`).

### Gaps Dig can own

1. **Occurrence-aware removal.** Nobody does it. The cleanest single differentiator available.
2. **Arbitrary reorder as one operation.** Spotify's endpoint is a move-slice primitive; an arbitrary permutation needs N calls with shifting indices. Escape hatches exist and are in no mainstream server.
3. **Optimistic concurrency.** Only one server uses `snapshot_id` as a precondition. Every other one silently clobbers a concurrent edit from the Spotify app.
4. **Undo.** Two implementations exist in the entire ecosystem.
5. **Match verification.** A 2-star repo is the only prior art, and the new 10-result search cap makes it far more important than it used to be.
6. **Simply being correct** against the current API.

---

## 5. Architecture

### Delivery: a Claude Code plugin, no hosting

Nobody hosts anything. The plugin ships from your GitHub repo, users install with two lines typed into Claude, and the MCP server runs on their machine so the Spotify sign-in reaches the local callback normally.

**Install flow:**
```
/plugin marketplace add tonycoon/dig
/plugin install dig@dig
```
Then a configuration dialog opens and they paste their Client ID.

**Constraint:** plugins are a Claude Code feature, not a plain-chat feature. Claude Code runs in a terminal, an IDE, the desktop app, and a browser. Your friends need to be in Claude Code, most naturally inside the desktop app.

### Language: Node, and the reason is dependency install

**Claude Code installs Node dependencies automatically, with no terminal command from the user** — but only if the plugin root contains **both** a `package.json` **and** a committed lockfile. With a lockfile it runs `npm ci --ignore-scripts` in the plugin cache. Without one, `node_modules` is never created and **nothing tells you**.

Python has no equivalent. Every published Python plugin depends on `uv` being on the user's PATH, which a non-technical desktop user will not have.

This decides the language. Your existing Python code gets translated, not discarded — the value in it is the API knowledge, not the syntax.

### Auth: PKCE, client ID only

Confirmed against Spotify's docs: PKCE requires no client secret. Your existing script already implements PKCE correctly and then sends a secret anyway, which is what makes the "friends bring only a Client ID" plan provably workable.

**Correction to the prior session's finding:** the redirect URI does *not* have to be port 8888. `localhost` is genuinely rejected, but Spotify explicitly supports registering a **portless loopback address** and supplying the port at authorization time:

> "If you don't know the port number in advance, register your redirect URI with a loopback IP literal, but without any port number."

Register `http://127.0.0.1/callback` and bind whatever port is free. This removes an entire class of "something else is using that port" failures.

**Scopes needed:** `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, `playlist-modify-public`, and `ugc-image-upload` if cover art is in scope.

Three scope traps:
- Cover upload needs **three** scopes, not one.
- Which modify scope applies is decided by the playlist's public flag, not your intent. Creating defaults to public, so it needs `playlist-modify-public`. Request both.
- Listing is scope-**filtered**, not scope-gated. Omitting a read scope silently returns a *shorter list*, not an error.

### Configuration: how the Client ID gets captured

Plugins have a `userConfig` mechanism. Claude Code prompts the user with a form dialog at install time and substitutes the value into the MCP server's environment. Verified working.

**Two settings to avoid, both due to live bugs:**

- **Do not set `required: true`.** With a required field unset, the plugin's MCP server is **silently dropped** — `claude mcp list` shows nothing, and even debug mode logs no explanation. The user sees a plugin that installed successfully and does nothing. With `required` omitted, a blank value substitutes as an empty string and the server still starts, giving you a chance to print a helpful error. One plugin author's conclusion: `required` is "currently a net-negative manifest feature."
- **Do not set `sensitive: true`.** There is an open bug where pressing Enter on a sensitive field does not open a text input at all. A Client ID is a public identifier anyway.

Validate inside the server and fail loudly with instructions.

**Also worth knowing:** skill content supports `${user_config.*}` substitution for non-sensitive values. That gives the onboarding skill a recovery hatch — it can read the configured value and, if empty, tell the user exactly what to run.

### File layout

```
dig/                                  # repo root = its own marketplace
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── dig/
        ├── .claude-plugin/
        │   └── plugin.json           # name, version, userConfig
        ├── .mcp.json                 # stdio server declaration
        ├── skills/
        │   ├── setup/SKILL.md        # the guided walkthrough
        │   └── digging/SKILL.md      # the taste and judgment layer
        ├── server/index.mjs
        ├── package.json
        └── package-lock.json         # REQUIRED or deps silently do not install
```

Two rules that bite: **only `plugin.json` goes inside `.claude-plugin/`**, everything else at the plugin root; and a `CLAUDE.md` at the plugin root is **not** loaded as context, so instructions must ship as a skill.

Write state to `${CLAUDE_PLUGIN_DATA}`, never `${CLAUDE_PLUGIN_ROOT}` — the latter changes on every update.

**Set an explicit `version` and bump it on release.** Otherwise every push to main ships to every user. Note also that **auto-update is off by default for third-party marketplaces**, so users will not get updates unless you tell them how to enable it.

---

## 6. Tool design

### Size

Target **12 to 16 tools**, never more than 20. Anthropic's guidance is to design around workflows rather than wrapping endpoints one-to-one: "Too many tools or overlapping tools can also distract agents from pursuing efficient strategies."

Under Claude Code's default tool search, tool schemas are deferred and only names plus **server instructions** load at session start. So the real budget is the server instructions text, not the tool count. Keep it under 2 KB, and put the cross-cutting rules there once instead of repeating them in twenty descriptions.

### Proposed surface

**Read (7):** search catalog · list playlists · get playlist metadata (no tracks) · list playlist tracks (paginated, projected) · **find in playlist** · diff two playlists · hydrate specific tracks

**Write, additive (4):** create playlist · add tracks · update details · reorder

**Write, destructive (2):** plan removal → apply removal

**Escape hatch (1):** unfollow playlist, **off by default**

Namespace everything `dig_`, lowercase snake_case only — Claude Code rewrites any other character to an underscore.

### The one architectural decision that matters most

**Spotify has no way to search inside a playlist.** Its search endpoint is catalog-scoped, with no parameter to limit results to one playlist's contents.

So Dig must page a playlist into a server-side index once, keyed by playlist ID plus `snapshot_id` for invalidation, and expose a real `find_in_playlist`. This is Anthropic's "use `search_logs`, not `read_logs`" guidance applied literally, and it is what makes a 4,000-track playlist tractable.

### Never return a whole playlist

At roughly 40 to 60 tokens per minimally projected track, 4,000 tracks is about 200,000 tokens — eight times Claude Code's 25,000-token cap. Past the cap, results get written to disk and replaced with a file reference, and the model gets nothing.

Techniques, all confirmed in production servers:

- **Project at the API boundary.** Spotify's `fields` parameter drops album art, external URLs, and market arrays. Easily a tenfold reduction. Expose it as `compact | standard | full`, defaulting to compact.
- **Paginate with an explicit continuation message** naming the exact next call, and a distinct message when exhausted.
- **Answer aggregate questions with aggregates.** "How many songs from the 90s?" returns a count and a ten-track sample, not 412 rows.
- **Make the expensive payload opt-in.** Every mature server converged on cheap-by-default.
- **Report truncation as data**, not just prose.

### Destructive operations

Spotify gives you an unusually good primitive: `snapshot_id` validates that the specified items exist in the specified positions before making changes. That is server-side optimistic concurrency, free.

**Two-step pattern:**

1. `dig_plan_removal(playlist_id, criteria)` — read-only. Returns the snapshot ID, an opaque expiring token bound to the user and to a digest of the exact track list, a count, a sample of up to ten tracks, and a one-sentence human summary.
2. `dig_apply_removal(removal_token, summary)` — validates the token against the caller and the digest, then executes against the captured snapshot. If the playlist changed underneath, Spotify's own validation fails and you tell the model to re-plan.

The `summary` argument carries no functional payload. It exists so the permission prompt reads "Remove 47 tracks added before 2020 from Road Trip" instead of an opaque token. This trick is borrowed from Playwright's MCP server.

**Stack the gates:** server-side token, Spotify's snapshot validation, `_meta["anthropic/requiresUserInteraction"]: true` on the apply tool (which prompts even under bypass-permissions modes and denies rather than auto-approving), honest annotations, and a plugin hook as a policy backstop.

**Do not expose replace-all.** Passing an empty array to Spotify's replace endpoint silently clears the playlist. No user request needs this as a single call.

### Annotations

Set all four on every tool, and derive them from one authored field so they cannot drift. **`destructiveHint` and `openWorldHint` both default to `true`** — an unannotated tool is, by specification, assumed destructive.

But treat them as documentation and as input to your own filtering, **not as a safety mechanism**. The spec says clients must distrust them, Claude Code's documentation never mentions them, and one real-world report notes "one client gates `send_email`, another auto-executes it on the same server."

### Errors are instructions

Return input validation failures as tool results with `isError: true`, never as protocol errors — the model never sees protocol errors and retries identically. Every error message should name the fix. Distinguish expired authorization (re-auth) from insufficient scope (different fix) from rate limited (retry after N).

---

## 7. Track matching

The current matcher in `claude-radio` uses bidirectional substring containment, which is why "Grass" matches "Sweetgrass". The replacement is designed, implemented, and tested: **31 of 31 cases pass**, verified by running it.

### Why the obvious fixes do not work

Substring containment is not a similarity measure. It is a boolean with no length awareness, and its confidence is **inverted** — the shorter the wanted title, the likelier a false hit. So it fails worst exactly where the risk is highest.

Measured on the actual failure cases:

| Wanted vs candidate | Substring | Levenshtein | Jaro-Winkler | token_set_ratio |
|---|---|---|---|---|
| sweetgrass / grass | **match** | 0.50 | 0.53 | 0.67 |
| sweet grass / grass | **match** | 0.45 | 0.43 | **1.00** |
| alive / stayin alive | **match** | 0.42 | 0.52 | **1.00** |
| love / love song | **match** | 0.44 | **0.89** | **1.00** |

`token_set_ratio` — the popular fuzzy-matching choice — scores three of these at a **perfect 1.00**. It has the identical defect at token granularity. Jaro-Winkler's prefix boost actively rewards the failure mode. Swapping one for the other fixes nothing.

### What actually works

A gated pipeline, not a single score. Four hard gates, then a weighted score, then three buckets.

**Gate 0 — ISRC short-circuit.** If both sides have an ISRC and they match, accept immediately. If they differ, note it and continue — ISRC equality is strong positive evidence, but ISRC inequality is weak negative evidence, because the same recording routinely carries several ISRCs.

**Gate 1 — version class.** Set equality on tags that denote a genuinely different recording: live, acoustic, demo, remix, instrumental, karaoke, cover, Taylor's Version. Set equality, not a blocklist — a user asking for the live version must be able to get it.

**Gate 2 — artist.** Reject below 0.60 similarity on the primary artist. This is the only thing standing between you and every cover version, because Spotify's own style guide requires covers to carry the same title under a different artist.

**Gate 3 — title.** Two conditions, both required: symmetric similarity at or above 0.87, **and zero unmatched meaningful words on either side**. The second condition is what kills the bug. "Sweet Grass" versus "Grass" fails because "sweet" has no partner, even though token-set scoring calls it perfect.

**Gate 4 — duration**, but only as a hard veto when the duration came from a trusted source rather than the model's memory.

Then a weighted score (title 0.40, artist 0.30, duration 0.20, album 0.05, year 0.05) and three buckets: **confident** at 0.90 and above (auto-add), **uncertain** from 0.70 (never auto-add, return with evidence), **rejected** below.

### The cases that only multi-signal checking gets right

- **Purple Rain by Prince.** Same title, same artist, no version tag anywhere. The 8:41 album cut and the 4:05 single are different recordings, and duration is the only discriminator.
- **The Sound of Silence vs The Sounds of Silence.** 98% string similarity, genuinely different recordings from different years.
- **Covers.** "Hurt" by Nine Inch Nails and "Hurt" by Johnny Cash are identical on title and close on everything except artist.

### Spotify-specific trap

Spotify's style guide says version titles go in a separate field, but the API composes a display name, so you receive `Bohemian Rhapsody - Remastered 2011` with a dash rather than parentheses. The most widely used music matching library discounts parentheticals but has **no pattern for the dash form**, so identical content scores over three times worse in the format Spotify actually returns. Handle both.

### Never auto-add an uncertain match

The asymmetry is stark. A missing track is a mild annoyance the user fixes in one message. A wrong track in a curated playlist is a silent corruption they may not notice for weeks. Bias hard toward omission, and return structured evidence so the model can explain the doubt rather than re-deriving it.

---

## 8. What to carry from claude-radio

Your existing `spotify_playlist.py` is better than most of what's published. Worth carrying forward:

- **The PKCE + loopback pattern** (`:126-129`, `:162-190`) — proven working
- **Atomic 0600 writes from the first byte** (`:85-92`) — better than most surveyed servers, several of which write tokens to the current working directory
- **`/playlists/{id}/items` for both PUT and POST** (`:302-304`) — already on the current API
- **The never-blind-fallback principle** in `pick_track` — the right instinct, wrong implementation
- **The empty-results guard** (`:299-300`) that refuses to wipe a playlist when every search fails

Not worth carrying: the client secret (`:183-187`, `:206-209`), the hardcoded track list, both matchers, the wholesale-replace strategy (correct for a generated playlist, wrong for a user's own), and the complete absence of rate-limit handling.

### Correction to the handoff

The supplementary handoff said roughly ten first-review MINORs should be presumed open. Checked against the code, **eight are fixed**: PKCE and state, the tokens.json permission window, the callback server never closing, bare argv dispatch, missing request timeouts, the dead `/me` call, the config directory mode, and the unescaped search query (neutralized by normalization stripping non-alphanumerics before the query is built).

Two are genuinely open: the four-copy track data drift, and the stale Cherry Blossom flag in the docs.

---

## 9. Failure modes and security

The failure-modes research went through real issue trackers and CVE databases rather than documentation. Several of the findings are precisely the code Dig would write.

### Security issues with published CVEs, in Dig's exact components

**Token files written world-readable.** `CVE-2025-27154`, severity HIGH. The most popular Python Spotify library wrote its token cache at `rw-r--r--`, meaning any other user or process on the machine could read it and take over the Spotify account. A shipping Spotify MCP server distributed the vulnerable version. Even the patched library writes at the default mode and *then* changes it, leaving a window.

Your existing script already does this correctly at `spotify_playlist.py:85-92` — it opens the file at `0600` from the first byte and creates the directory at `0700`. That is better than the library that had the CVE. Carry the pattern forward, add self-healing on read, and prefer the macOS Keychain where available.

**The local callback page is an attack surface.** `CVE-2025-66040` — the same library's OAuth callback server reflected an error parameter into its HTML without escaping, allowing script injection during authentication. Dig runs the identical component.

Correct practice: bind `127.0.0.1` explicitly, validate the `Host` header, escape everything reflected into the page, serve a fully self-contained page with no external images or fonts so the authorization code cannot leak through a referrer header, 404 every path but the callback, and shut the listener down after one request.

**DNS rebinding hit both MCP SDKs** — `CVE-2025-66414` and `CVE-2026-42559`. Binding to localhost is necessary but not sufficient.

**Claude Code project files have been an exfiltration vector.** `CVE-2025-59536` — a repository-local settings file redirected the API base URL and shipped the user's key to an attacker before the user had decided to trust the directory. **Dig must never read tokens from, or honor configuration overrides in, project-local files.**

### Secrets leak here and nothing catches them

**Spotify is not a GitHub secret-scanning partner.** Discord, Telegram, and hundreds of others are; Spotify is not. If a user commits a Spotify token there is no push protection, no notification, and no auto-revocation.

This is not hypothetical. GitHub code search returns roughly **1,700 files** containing leaked Spotify token caches. The root cause is a one-line footgun: the popular library defaults its cache to a **relative** path, so running it from inside a repository drops the token file in the repo root, and nothing adds it to `.gitignore`.

**Resolve an absolute path from the home directory at startup. Never derive a token path from the working directory.**

### One `console.log` breaks everything

A real bug in a shipping Spotify MCP server: the **success path of the token refresh function logged to stdout**. On a stdio server, stdout *is* the protocol channel. The token refreshed fine and the transport broke, producing a mystifying error popup roughly hourly.

**All logging to stderr, enforced by a lint rule.** This is the single most on-the-nose precedent found — it is the exact code path Dig will write.

### Never trust a 200 on a destructive write

A removal can return `200` with a fresh snapshot ID and remove nothing. The documented cause is track relinking, where you must pass a different URI than the one you read — and the field that gave you that URI **was removed in February 2026**, so the documented workaround may no longer exist.

Worse, from the most widely used Spotify dedup tool's issue tracker: a user reported that the track count dropped but the duplicates remained, and *the songs deleted were the ones just above the duplicates*. Their follow-up question is the one you never want to receive: whether there is any way to recover them. There is not.

Two rules follow:

1. **Re-read the playlist after every destructive write and verify the intended change actually landed.** Report honestly when it did not. This is the most important behavioral rule in this document.
2. **Snapshot the full track list to disk before every destructive write**, and offer a restore. Spotify's 90-day recovery covers *deleted playlists*, which are really unfollows. It does **not** help when tracks were removed from a surviving playlist.

### Single-occurrence removal: settled, and the answer is no

The earlier track flagged this as undocumented. It is worse than undocumented. **Spotify dropped support for the `positions` field in 2024 and never restored it.** From a developer who maintains a Spotify tool:

> "Prior to this Spotify Change: if you have Multiple Copies of the Same Track in a playlist and you selected ONE of them to be removed, just the selected track would be removed. After this Spotify Change: now ALL copies of the selected track will be removed... It is no longer possible to remove duplicates from a playlist using the web api."

So do not offer "remove this one duplicate." The only correct implementation is remove-all-then-re-add, and Dig must tell the user that the re-added copy **moves to the end of the playlist**, because position cannot be preserved.

### Token lifecycle, and what a long-running server gets wrong

A script runs for ninety seconds. An MCP server lives for days, which exposes bugs a script never would:

- **The refresh token rotates on every use under PKCE**, and the old one dies immediately. Persist the new one atomically *before* making any API call with the resulting access token. A crash between refresh and persist bricks the install permanently.
- **Two Claude Code sessions can run two copies of the server**, both refreshing against the same token file. That is a lost-update race where one rotation clobbers the other and both die. Use an exclusive lock around read-refresh-write.
- **The machine sleeps.** Never cache "seconds remaining"; store an absolute expiry.
- **Treat a 401 as authoritative** and refresh-then-retry-once regardless of what the local clock believes.
- **Never persist the access token.** It is good for an hour. Only the refresh token needs to survive a restart, and it is the asset worth up to six months of silent access.

One real bug worth avoiding: a shipping server stored the token lifetime as thirty days when Spotify access tokens live one hour, so it never refreshed and broke after sixty minutes every time.

### Rate limiting has two ceilings, and only one is documented

Beyond the documented rolling 30-second window, there is a second, much larger window that can trigger after a few thousand requests and return a `Retry-After` measured in **hours**. One reporter received a 22-hour timeout. Another's app appeared permanently poisoned and they created a new one.

Naive retry **escalates the ban** — one developer's `Retry-After` grew to two hours because they kept requesting. And sleeping blindly for a multi-hour retry is indistinguishable from a crash.

Correct behavior for Dig: serialize requests, never parallelize, honor `Retry-After` exactly, but **cap the wait at about 60 seconds** and then stop and tell the user how long Spotify wants. A tool call must never block for hours. And **never blind-retry an add** — retry only after re-reading the playlist to confirm the write did not land.

### Scope minimization and blast radius

Request exactly four scopes: `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, `playlist-modify-public`. Notably **not** `user-read-email` — no playlist endpoint needs it.

Be clear-eyed about what those scopes permit, because OAuth cannot enforce Dig's safety boundary. There is no add-only scope; modify bundles add, remove, reorder, replace, and rename into one grant. **The tool surface is the only enforcement mechanism there is.** An attacker with those scopes could replace a playlist's entire contents, which is unrecoverable, since the playlist object survives and there is nothing to restore.

### Don't take a Spotify SDK dependency

Spotify has broken third-party tools four times in eighteen months, and wrappers lag by months. One popular TypeScript SDK is still on retired paths, which is why a 423-star MCP server remains broken six months after the migration. Its maintainer's verdict: it would probably be easier to start from scratch.

Dig needs roughly eight endpoints. Call the REST API directly. A wrapper buys little and couples your outage window to someone else's release cadence.

**Also: the error Spotify returns for a retired endpoint is misleading.** Users saw `403 Forbidden` with a message about bad OAuth requests, which sent them chasing authentication for days. Never surface a raw Spotify error — map status plus endpoint to a plain-English cause.

### Ship a self-test

A `/dig-doctor` command that checks Client ID validity, allowlist status, Premium status, token freshness, and one live call per endpoint. When Spotify changes something, the user gets a diagnosis instead of a mystery.

---

## 10. Ranked risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Every user needs Spotify Premium; friends on Free cannot use Dig at all | Critical, may kill the project | Ask before anything else, and say plainly it cannot work without it |
| 2 | Plugin MCP servers may not start in the Claude desktop app, which is where your friends are | Critical | **Test in the real desktop app before promising anything** |
| 3 | Using the retired endpoints returns a misleading auth error | Critical | Call `/items` and `POST /me/playlists` directly via REST, no SDK |
| 4 | A missed refresh-token rotation bricks the install permanently | Critical | Persist atomically before use; exclusive lock around read-refresh-write |
| 5 | A destructive write reports success but did the wrong thing | Critical | Re-read and verify after every write; snapshot before every destructive op |
| 6 | Token file written world-readable (the published CVE) | High | Create at `0600` atomically; self-heal on read; prefer Keychain |
| 7 | A stray `console.log` corrupts the protocol stream | High | All logging to stderr, enforced by lint |
| 8 | Redirect URI mismatch, the most common setup wall | High | Dig generates the exact string; the word `localhost` appears nowhere in the repo |
| 9 | The 403 after apparently-successful sign-in | High | Probe immediately after token exchange and map the 403 to the allowlist explanation |
| 10 | Wrong Client ID causes an indefinite hang with no error | High | Validate the 32-character shape before opening a browser; hard timeout on the listener |
| 11 | A playlist read blows the 25,000-token limit | High | Project every item down; paginate by default; never return raw Spotify JSON |
| 12 | `required: true` silently drops the whole MCP server | High | Do not use it; validate in the server instead |
| 13 | Refresh token expires at six months, absolute | Medium-High | Handle `invalid_grant` by re-authing, never retrying; warn at five months |
| 14 | Rate-limit escalation into multi-hour bans | Medium | Serialize, honor `Retry-After`, cap the wait at 60s and report |
| 15 | The browser authorizes the wrong Spotify account | Medium | Show the connected account's name after auth and offer one-click retry |

---

## 11. Smaller open questions

- **Search quoting and escaping are entirely undocumented.** No published rules for a title containing a colon, or an artist like AC/DC. Test empirically.
- **Whether the relinking workaround still exists** now that the field it depended on has been removed. Test before shipping any remove feature.
- **Dependency install on Windows and Linux** was verified only on macOS. If `npm` is not on the user's PATH, install is silently skipped and the server fails with no message outside debug mode.
- **Cloud and web sessions cannot supply plugin configuration** — an open issue confirms it. Dig will not work in Claude Code on the web, which matches the local-callback reasoning and settles it.

---

## 12. Onboarding

Getting the Client ID needs a guided walkthrough, not a README paragraph. Two pieces:

**A local reference page.** The tool already runs a local web server for the sign-in callback, so serving a static page from it costs nearly nothing. Read-only, no form, no capture — the whole picture at once with real links and the redirect address available to copy. Line 7 branding.

**A setup skill.** Claude walks them through conversationally in their own Claude Code chat, one step at a time, and points them at the page.

The skill must carry **exact URLs and exact button names**, verified against the dashboard as it actually looks. A vague skill means Claude fills gaps by guessing, and a confidently wrong instruction is worse for a non-technical user than no instruction.

**Put the allowlist step early and loud.** It is the step that will break the most people, and its only symptom is a 403 that looks like something else entirely.

Avoid pixel screenshots of Spotify's dashboard — they go stale the moment a button moves, and a stale screenshot misleads more than plain text.

### Draft error messages

Written for someone who does not code. Each names the cause and gives the next action.

**Redirect address rejected by the dashboard**

> **Spotify won't accept that web address.**
> Spotify stopped allowing `localhost` in 2025. It needs the numeric version instead.
>
> Copy this exactly into the **Redirect URIs** box on your app's Settings page, click **Add**, then **Save**:
>
> `http://127.0.0.1:8888/callback`
>
> It has to match character for character. No extra slash at the end, and `http` not `https`.

**Wrong or mistyped Client ID**

> **That doesn't look like a Client ID.**
> A Client ID is 32 characters of letters and numbers. Two things people paste by mistake:
>
> - The **Client Secret**, which sits right underneath and looks almost identical. Dig never needs it. Don't paste it anywhere.
> - The **app name** you typed when you created the app.
>
> Open your app on the Spotify dashboard, click **Settings**, and copy the value labelled **Client ID**.

**403 after signing in, not on the allowlist**

> **Spotify signed you in, but your app hasn't been told to let you use it.**
> Even though you own this app, Spotify makes you add yourself to it by hand.
>
> 1. Open your app at developer.spotify.com/dashboard
> 2. Click **Settings**, then the **User Management** tab
> 3. Add your name and **the email address on your Spotify account**. If you have several addresses, it has to be that one.
> 4. Wait about 15 minutes, then try again
>
> The 15 minutes is real. It won't work immediately.

**Premium required**

> **Spotify requires a Premium subscription to run your own app.**
> This changed in February 2026 and applies to everyone, even for something as simple as reading your own playlist. There's no workaround.
>
> If you just subscribed, it can take a few hours before Spotify lets your app through.

**Expired connection**

> **Your Spotify connection expired.**
> Spotify makes every connection expire after six months and yours has hit that mark. Nothing is wrong and nothing was lost.
>
> Reconnect and approve the same screen you saw the first time. Your playlists are untouched.

---

## 13. Sources

Spotify: [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) · [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) · [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) · [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) · [redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri) · [playlists concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists) · [rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits) · [refresh token expiration](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration)

MCP and Claude Code: [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) · [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [plugins reference](https://code.claude.com/docs/en/plugins-reference) · [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

Matching: [IFPI ISRC FAQ](https://isrc.ifpi.org/faqs) · Spotify Music Metadata Style Guide v2.2 · source read directly from beets 2.13.1, MusicBrainz Picard 3.0.0b9, spotDL v4.5.2, spotify-dedup

Security: [CVE-2025-27154](https://github.com/advisories/GHSA-pwhh-q4h6-w599) (token file permissions) · [CVE-2025-66040](https://github.com/spotipy-dev/spotipy/security/advisories/GHSA-r77h-rpp9-w2xm) (callback page injection) · CVE-2025-66414 and CVE-2026-42559 (DNS rebinding in the MCP SDKs) · [CVE-2025-59536](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/) (Claude Code project-file exfiltration) · [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/2025/MCP01-2025-Token-Mismanagement-and-Secret-Exposure)

Failure modes were mined from issue trackers on spotipy, spotify-dedup, and the two most-used Spotify MCP servers, plus Claude Code's own tracker.

Reference implementation of the matching algorithm with its 31-case test suite is saved alongside this document as `dig-matching-reference.py`.
