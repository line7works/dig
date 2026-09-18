# Dig
<!-- verified: 2026-09-18 -->

A public Claude Code plugin from Line 7 that manages a person's own Spotify
playlists through an MCP server. Marketplace manifest at
`.claude-plugin/marketplace.json`; the plugin is `plugins/dig/` (server, skills,
tests). Strangers install this from GitHub, so every tracked file carries repo
truth only. `README.md` is written for non-technical users and is the product's
front door; keep its voice.

## Commands
- Tests: `cd plugins/dig && npm test` (`node --test test/*.test.mjs`).
- One file: `node --test plugins/dig/test/write-tools.test.mjs`.
- Local install for a smoke test: `/plugin marketplace add <path-to-this-repo>`
  then `/plugin install dig@dig` in a fresh Claude Code session.

## Conventions and invariants
- The server logs to stderr only; a stray stdout write corrupts the MCP stream.
  `test/stderr-only.test.mjs` guards this.
- Writes are verified against Spotify by re-read and reported as verified,
  accepted, ambiguous, or partial. Never add a write path that skips the re-read.
- Removal is two-step (plan, then apply) with a snapshot first. Keep it.
- Uncertain track matches come back as questions, never additions. Padding a
  list to hit a count is a bug.
- Spotify's development-mode rule requires Premium and the user's own developer
  app; there is no free-tier path. Do not document workarounds.

## Footguns
- All Spotify calls run through one serialized queue. Parallel calls trip rate
  limits that grow on retry.
- Batch track lookup no longer exists in the Spotify API; `dig_get_tracks` costs
  one request per id.
- The word "localhost" appears nowhere in the repo; Spotify rejects it as a
  redirect host, so the callback uses the loopback IP. `test/no-localhost.test.mjs`
  enforces the ban.
