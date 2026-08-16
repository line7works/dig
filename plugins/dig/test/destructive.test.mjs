// Slice F (AC2/AC3): destructive operations against a mocked API —
// expired/mismatched tokens refused, digest mismatch refused, empty plans
// refused (R4), a changed snapshot_id turns into a re-plan answer (R1), the
// dedupe plan discloses moved-to-end BEFORE approval (R5), and
// dig_unfollow_playlist is absent from registration until opted in (R6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpotifyClient } from "../server/spotify-client.mjs";
import { createDestructiveTools, PlanRegistry, MOVES_TO_END_DISCLOSURE, writeSnapshot } from "../server/destructive-tools.mjs";
import { FindIndex } from "../server/find-index.mjs";

process.env.SPOTIFY_CLIENT_ID = "a".repeat(32);
// Snapshots land in a throwaway data dir, cleaned at the end.
const DATA_DIR = mkdtempSync(join(tmpdir(), "dig-destructive-"));
process.env.CLAUDE_PLUGIN_DATA = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

// ---------- mock Spotify world with removable playlists ----------

function makeTrack(i, name = `Track ${i}`, artists = ["The Placeholder Band"]) {
  return { id: `t${i}`, name, uri: `spotify:track:t${i}`, duration_ms: 180_000, artists: artists.map((n) => ({ name: n })) };
}

function makeWorld({ playlists = {} } = {}) {
  const writes = [];
  const world = { playlists, writes, silentDeletes: false, library: Object.keys(playlists) };
  world.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method ?? "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (method !== "GET") writes.push({ method, path: u.pathname, body });
    const respond = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => (payload === null ? "" : JSON.stringify(payload)),
    });

    let m;
    if (u.pathname === "/v1/me/library" && method === "DELETE") {
      for (const uri of body.uris) {
        const id = uri.split(":").pop();
        world.library = world.library.filter((x) => x !== id);
      }
      return respond(200, null);
    }
    if (u.pathname === "/v1/me/playlists") {
      const rows = world.library.map((id) => ({ id, name: playlists[id]?.name }));
      return respond(200, { total: rows.length, items: rows });
    }
    if ((m = u.pathname.match(/^\/v1\/playlists\/([^/]+)$/))) {
      const p = playlists[m[1]];
      if (!p) return respond(404, { error: { status: 404, message: "Not found." } });
      // world.staleMetaSnapshot simulates the live finding: metadata reads
      // right after a write can still serve the PRE-write snapshot_id.
      return respond(200, { id: m[1], name: p.name, snapshot_id: world.staleMetaSnapshot ?? p.snapshot_id });
    }
    if ((m = u.pathname.match(/^\/v1\/playlists\/([^/]+)\/items$/))) {
      const p = playlists[m[1]];
      if (!p) return respond(404, { error: { status: 404, message: "Not found." } });
      if (method === "GET" && world.failItemsGets) {
        return respond(429, { error: { status: 429, message: "rate limited" } });
      }
      if (method === "DELETE") {
        if (body.snapshot_id && body.snapshot_id !== p.snapshot_id) {
          return respond(400, { error: { status: 400, message: "Snapshot mismatch" } });
        }
        if (world.failItemsGetsAfterDelete) world.failItemsGets = true;
        if (!world.silentDeletes) {
          const gone = new Set(body.items.map((x) => x.uri));
          p.tracks = p.tracks.filter((t) => !t || !gone.has(t.uri));
          p.snapshot_id = `snap-d${writes.length}`;
        } else {
          p.snapshot_id = `snap-silent${writes.length}`;
        }
        return respond(200, { snapshot_id: p.snapshot_id });
      }
      if (method === "POST") {
        const items = body.uris.map((uri) => world.byUri?.[uri] ?? { id: uri.split(":").pop(), uri, name: uri, artists: [] });
        p.tracks.push(...items);
        p.snapshot_id = `snap-a${writes.length}`;
        return respond(201, { snapshot_id: p.snapshot_id });
      }
      if (method === "PUT") {
        // restore's replace
        p.tracks = body.uris.map((uri) => world.byUri?.[uri] ?? { id: uri.split(":").pop(), uri, name: uri, artists: [] });
        p.snapshot_id = `snap-r${writes.length}`;
        return respond(201, { snapshot_id: p.snapshot_id });
      }
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 20);
      const rows = p.tracks.slice(offset, offset + limit).map((t) => ({ item: t }));
      return respond(200, { total: p.tracks.length, limit, offset, items: rows });
    }
    return respond(500, { error: { message: `unmocked ${method} ${u.pathname}` } });
  };
  return world;
}

function makeRig(world, { now, enableUnfollow } = {}) {
  const store = { getAccessToken: async () => "tok", invalidateAccess() {} };
  const client = new SpotifyClient({ store, fetchImpl: (url, opts) => world.fetch(url, opts), sleep: async () => {} });
  const index = new FindIndex(client);
  const registry = new PlanRegistry({ now: now ?? Date.now });
  const tools = createDestructiveTools({ client, index, registry, enableUnfollow });
  const call = async (name, args) => {
    const t = tools.find((x) => x.def.name === name);
    assert.ok(t, `tool ${name} registered`);
    return t.handler(args);
  };
  return { client, tools, registry, call };
}

const parse = (r) => JSON.parse(r.text);

function standardWorld() {
  return makeWorld({
    playlists: {
      pl1: {
        name: "Test List",
        snapshot_id: "snap-0",
        tracks: [makeTrack(1, "Alpha"), makeTrack(2, "Beta"), makeTrack(3, "Gamma"), makeTrack(2, "Beta"), makeTrack(4, "Delta")],
      },
    },
  });
}

// ---------- R1/R4: plan validation ----------

test("empty plan refused: no track_ids and no mode", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_plan_removal", { playlist_id: "pl1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /refuses empty removal plans/);
});

test("empty plan refused: empty track_ids array", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_plan_removal", { playlist_id: "pl1", track_ids: [] });
  assert.equal(r.isError, true);
});

test("a plan that would empty the playlist is refused (no code path empties)", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1", "t2", "t3", "t4"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /remove every playable track/);
});

test("plan for tracks not in the playlist is refused", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t99"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /aren't in the playlist/);
});

test("plan returns snapshot_id, count, sample, summary, and an expiring token", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1", "t3"] });
  assert.equal(r.isError, false);
  const p = parse(r);
  assert.equal(p.plan.snapshot_id, "snap-0");
  assert.equal(p.plan.tracks_to_remove, 2);
  assert.equal(p.plan.sample.length, 2);
  assert.match(p.plan.summary, /Remove 2 track/);
  assert.ok(typeof p.removal_token === "string" && p.removal_token.length >= 16);
  assert.equal(p.expires_in_minutes, 15);
});

test("multi-copy removal is disclosed in the plan (all copies go)", async () => {
  const { call } = makeRig(standardWorld());
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t2"] }));
  assert.equal(p.plan.rows_removed, 2);
  assert.match(p.note, /ALL copies/);
});

// ---------- R5: dedupe plan discloses moved-to-end BEFORE approval ----------

test("dedupe plan text contains the moves-to-end disclosure", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_plan_removal", { playlist_id: "pl1", mode: "duplicates" });
  assert.equal(r.isError, false);
  const p = parse(r);
  assert.equal(p.disclosure, MOVES_TO_END_DISCLOSURE);
  assert.match(p.disclosure, /MOVES TO THE END/);
  assert.equal(p.plan.re_added_at_end, 1);
});

test("dedupe with no duplicates plans nothing", async () => {
  const world = makeWorld({ playlists: { pl1: { name: "No Dupes", snapshot_id: "s", tracks: [makeTrack(1), makeTrack(2)] } } });
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", mode: "duplicates" }));
  assert.equal(p.result, "no_plan");
  assert.equal(world.writes.length, 0);
});

// ---------- R1: token validation on apply ----------

test("unknown token refused, nothing written", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  const r = await call("dig_apply_removal", { removal_token: "deadbeef".repeat(4), summary: "x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no longer valid/);
  assert.equal(world.writes.length, 0);
});

test("expired token refused, nothing written", async () => {
  const world = standardWorld();
  let t = 1_000_000;
  const { call } = makeRig(world, { now: () => t });
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  t += 16 * 60 * 1000; // past the 15-minute TTL
  const r = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(r.isError, true);
  assert.match(r.text, /no longer valid/);
  assert.equal(world.writes.length, 0);
});

test("token is single-use: a second apply is refused", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  const first = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(first.isError, false);
  const again = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(again.isError, true);
  assert.match(again.text, /no longer valid/);
});

test("token bound to a different client id refused, nothing written", async () => {
  const world = standardWorld();
  const { call, registry } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  // The connection changed apps between plan and apply.
  for (const record of registry.plans.values()) record.clientId = "b".repeat(32);
  const r = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(r.isError, true);
  assert.match(r.text, /different Spotify connection/);
  assert.equal(world.writes.length, 0);
});

test("digest mismatch refused, nothing written", async () => {
  const world = standardWorld();
  const { call, registry } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  // The stored track list was tampered with after minting.
  for (const record of registry.plans.values()) record.uris = ["spotify:track:t3"];
  const r = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(r.isError, true);
  assert.match(r.text, /integrity check/);
  assert.equal(world.writes.length, 0);
});

// ---------- R1: changed snapshot_id -> re-plan, R3: snapshot file ----------

test("changed snapshot_id: Spotify rejects, tool answers re-plan, nothing removed", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  // The playlist changes underneath between plan and apply.
  world.playlists.pl1.snapshot_id = "snap-CHANGED";
  const r = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(r.isError, false);
  const out = parse(r);
  assert.equal(out.result, "no_write");
  assert.match(out.note, /[Rr]e-plan/);
  assert.equal(world.playlists.pl1.tracks.length, 5, "no tracks were removed");
});

test("apply removes exactly the planned tracks, writes a 0600 snapshot first, verifies by re-read", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  let filesBefore = new Set();
  try { filesBefore = new Set(readdirSync(join(DATA_DIR, "snapshots"))); } catch { /* not created yet */ }
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1", "t3"] }));
  const r = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  assert.equal(r.result, "verified");
  assert.equal(r.removed, 2);
  assert.deepEqual(world.playlists.pl1.tracks.map((t) => t.id), ["t2", "t2", "t4"]);
  // The snapshot file exists, is 0600, and holds the PRE-change track list.
  const file = join(DATA_DIR, "snapshots", r.snapshot);
  assert.ok(!filesBefore.has(r.snapshot));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const snap = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(snap.playlist_id, "pl1");
  assert.equal(snap.total_rows, 5);
  assert.deepEqual(snap.tracks.map((t) => t.id), ["t1", "t2", "t3", "t2", "t4"]);
});

test("verify bypasses the snapshot cache: stale post-write metadata cannot fail a landed removal", async () => {
  // Live finding (2026-08-15): right after a DELETE, Spotify's metadata read
  // can still serve the pre-delete snapshot_id; a cache-keyed verify then
  // returns the pre-delete track list and a landed removal reads as failed.
  const world = standardWorld();
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  world.staleMetaSnapshot = "snap-0"; // metadata frozen at the pre-write value
  const r = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  assert.equal(r.result, "verified");
  assert.equal(world.playlists.pl1.tracks.some((t) => t.id === "t1"), false);
});

test("silent-failure removal (200 but nothing removed) reports ambiguous, never verified", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  world.silentDeletes = true;
  const r = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  assert.equal(r.result, "ambiguous");
  assert.match(r.note, /relinking/);
});

test("dedupe apply: removes all copies, re-adds one at the end, verified", async () => {
  const world = standardWorld();
  world.byUri = { "spotify:track:t2": makeTrack(2, "Beta") };
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", mode: "duplicates" }));
  const r = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  assert.equal(r.result, "verified");
  assert.deepEqual(world.playlists.pl1.tracks.map((t) => t.id), ["t1", "t3", "t4", "t2"], "kept copy moved to the end");
});

// ---------- R3: restore rebuilds from a snapshot ----------

test("restore: preview then execute rebuilds the snapshot's track list", async () => {
  const world = standardWorld();
  world.byUri = Object.fromEntries(world.playlists.pl1.tracks.map((t) => [t.uri, t]));
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1", "t3"] }));
  const applied = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  assert.deepEqual(world.playlists.pl1.tracks.map((t) => t.id), ["t2", "t2", "t4"]);

  // Listing names the snapshot; preview shows the plan; execute restores.
  const listing = parse(await call("dig_restore_snapshot", {}));
  assert.ok(listing.snapshots.some((s) => s.snapshot === applied.snapshot));
  const preview = parse(await call("dig_restore_snapshot", { snapshot: applied.snapshot }));
  assert.equal(preview.plan.tracks_restored, 5);
  assert.ok(preview.restore_token);
  assert.match(preview.warning, /REPLACES/);
  const done = parse(await call("dig_restore_snapshot", { restore_token: preview.restore_token }));
  assert.equal(done.result, "verified");
  assert.deepEqual(world.playlists.pl1.tracks.map((t) => t.id), ["t1", "t2", "t3", "t2", "t4"]);
  // The state being replaced was snapshotted first (a restore is undoable).
  assert.ok(done.pre_restore_snapshot);
});

test("restore preview of an unknown snapshot name is refused", async () => {
  const { call } = makeRig(standardWorld());
  const r = await call("dig_restore_snapshot", { snapshot: "nope.json" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No snapshot named/);
});

// ---------- R2: apply carries requiresUserInteraction ----------

test("dig_apply_removal declares _meta anthropic/requiresUserInteraction", async () => {
  const { tools } = makeRig(standardWorld());
  const apply = tools.find((t) => t.def.name === "dig_apply_removal");
  assert.equal(apply.def._meta["anthropic/requiresUserInteraction"], true);
  assert.equal(apply.def.annotations.destructiveHint, true);
  assert.equal(apply.def.annotations.readOnlyHint, false);
  const plan = tools.find((t) => t.def.name === "dig_plan_removal");
  assert.equal(plan.def.annotations.readOnlyHint, true, "planning is read-only");
});

// ---------- R6 / AC3: unfollow is absent until opted in ----------

test("dig_unfollow_playlist absent from registration by default", async () => {
  delete process.env.DIG_ENABLE_UNFOLLOW;
  const tools = createDestructiveTools({ client: {}, index: new FindIndex({}) });
  assert.equal(tools.some((t) => t.def.name === "dig_unfollow_playlist"), false);
  assert.deepEqual(tools.map((t) => t.def.name), ["dig_plan_removal", "dig_apply_removal", "dig_restore_snapshot"]);
});

test("dig_unfollow_playlist registered when opted in, and is two-step with a snapshot", async () => {
  const world = standardWorld();
  const { call, tools } = makeRig(world, { enableUnfollow: true });
  const def = tools.find((t) => t.def.name === "dig_unfollow_playlist").def;
  assert.equal(def._meta["anthropic/requiresUserInteraction"], true);
  const preview = parse(await call("dig_unfollow_playlist", { playlist_id: "pl1" }));
  assert.ok(preview.confirm_token);
  assert.match(preview.warning, /deletion/);
  assert.ok(world.library.includes("pl1"), "preview changed nothing");
  const done = parse(await call("dig_unfollow_playlist", { playlist_id: "pl1", confirm_token: preview.confirm_token }));
  assert.equal(done.result, "verified");
  assert.ok(!world.library.includes("pl1"));
  assert.ok(done.snapshot, "snapshot written before the unfollow");
  const deletes = world.writes.filter((w) => w.method === "DELETE" && w.path === "/v1/me/library");
  assert.deepEqual(deletes[0].body, { uris: ["spotify:playlist:pl1"] });
});

test("env opt-in string enables unfollow registration", async () => {
  process.env.DIG_ENABLE_UNFOLLOW = "true";
  try {
    const tools = createDestructiveTools({ client: {}, index: new FindIndex({}) });
    assert.equal(tools.some((t) => t.def.name === "dig_unfollow_playlist"), true);
  } finally {
    delete process.env.DIG_ENABLE_UNFOLLOW;
  }
});

// ---------- fix pins: kind binding, summary binding, verify failures, ----------
// ---------- never-empty on playable rows, name uniqueness, retarget ----------

test("kind binding: a removal token is refused by restore and unfollow, nothing written", async () => {
  const world = standardWorld();
  const { call } = makeRig(world, { enableUnfollow: true });
  const p1 = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  const asRestore = await call("dig_restore_snapshot", { restore_token: p1.removal_token });
  assert.equal(asRestore.isError, true);
  assert.match(asRestore.text, /different operation/);
  const p2 = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  const asUnfollow = await call("dig_unfollow_playlist", { playlist_id: "pl1", confirm_token: p2.removal_token });
  assert.equal(asUnfollow.isError, true);
  assert.match(asUnfollow.text, /different operation/);
  assert.equal(world.writes.length, 0, "no write of any kind fired");
  assert.equal(world.playlists.pl1.tracks.length, 5);
});

test("kind binding: a restore token is refused by dig_apply_removal", async () => {
  const world = standardWorld();
  world.byUri = Object.fromEntries(world.playlists.pl1.tracks.map((t) => [t.uri, t]));
  const { call } = makeRig(world);
  // Make a snapshot via a real removal, then preview a restore.
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  const applied = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  const preview = parse(await call("dig_restore_snapshot", { snapshot: applied.snapshot }));
  const writesBefore = world.writes.length;
  const r = await call("dig_apply_removal", { removal_token: preview.restore_token, summary: preview.plan.summary });
  assert.equal(r.isError, true);
  assert.match(r.text, /different operation/);
  assert.equal(world.writes.length, writesBefore, "the restore token executed nothing as a removal");
});

test("summary binding: a summary that differs from the plan's sentence is refused, nothing written", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  const r = await call("dig_apply_removal", { removal_token: p.removal_token, summary: "Remove 1 duplicate" });
  assert.equal(r.isError, true);
  assert.match(r.text, /doesn't match the plan's sentence/);
  assert.equal(world.writes.length, 0);
});

test("verify failure after a landed removal reports accepted with the snapshot pointer, not a bare error", async () => {
  const world = standardWorld();
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  world.failItemsGetsAfterDelete = true; // every re-read after the DELETE rate-limits
  const r = await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(r.isError, false, "not a bare error");
  const out = parse(r.text === undefined ? r : r);
  assert.equal(out.result, "accepted");
  assert.ok(out.snapshot, "snapshot pointer survives the verify failure");
  assert.match(out.note, /re-read failed/i);
  assert.equal(world.playlists.pl1.tracks.some((t) => t.id === "t1"), false, "the removal itself landed");
});

test("dedupe of an all-duplicates playlist is refused at plan time (would pass through empty)", async () => {
  const world = makeWorld({
    playlists: { pl1: { name: "All Dupes", snapshot_id: "s", tracks: [makeTrack(1, "Alpha"), makeTrack(1, "Alpha"), makeTrack(2, "Beta"), makeTrack(2, "Beta")] } },
  });
  const { call } = makeRig(world);
  const r = await call("dig_plan_removal", { playlist_id: "pl1", mode: "duplicates" });
  assert.equal(r.isError, true);
  assert.match(r.text, /fully empty playlist/);
  assert.equal(world.writes.length, 0);
});

test("never-empty guard counts playable rows only: ghost rows cannot keep a playlist 'alive'", async () => {
  const world = makeWorld({
    playlists: { pl1: { name: "Ghosts", snapshot_id: "s", tracks: [null, makeTrack(1, "Alpha"), null] } },
  });
  const { call } = makeRig(world);
  const r = await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /remove every playable track/);
});

test("snapshot filenames are unique even for identical inputs in the same millisecond", () => {
  const entry = { tracks: [], totalRows: 0 };
  const a = writeSnapshot({ playlistId: "plX", playlistName: "Same", snapshotId: "s", indexEntry: entry, reason: "test" });
  const b = writeSnapshot({ playlistId: "plX", playlistName: "Same", snapshotId: "s", indexEntry: entry, reason: "test" });
  assert.notEqual(a, b);
});

test("restore into_playlist_id rebuilds the snapshot into a different playlist", async () => {
  const world = standardWorld();
  world.playlists.pl2 = { name: "Fresh Target", snapshot_id: "s2", tracks: [makeTrack(9, "Seed")] };
  world.library.push("pl2");
  world.byUri = Object.fromEntries(world.playlists.pl1.tracks.map((t) => [t.uri, t]));
  const { call } = makeRig(world);
  const p = parse(await call("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  const applied = parse(await call("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary }));
  const preview = parse(await call("dig_restore_snapshot", { snapshot: applied.snapshot, into_playlist_id: "pl2" }));
  assert.equal(preview.plan.restores_into, "pl2");
  const done = parse(await call("dig_restore_snapshot", { restore_token: preview.restore_token }));
  assert.equal(done.result, "verified");
  assert.deepEqual(world.playlists.pl2.tracks.map((t) => t.id), ["t1", "t2", "t3", "t2", "t4"], "target playlist holds the snapshot's list");
  assert.deepEqual(world.playlists.pl1.tracks.map((t) => t.id), ["t2", "t3", "t2", "t4"], "source playlist untouched by the retargeted restore");
});

test("verify cache invalidation reaches a SHARED index (the one read tools would serve from)", async () => {
  const world = standardWorld();
  const store = { getAccessToken: async () => "tok", invalidateAccess() {} };
  const client = new SpotifyClient({ store, fetchImpl: (url, opts) => world.fetch(url, opts), sleep: async () => {} });
  const shared = new FindIndex(client);
  const tools = createDestructiveTools({ client, index: shared, registry: new PlanRegistry() });
  const call2 = (name, args) => tools.find((x) => x.def.name === name).handler(args);
  const p = parse(await call2("dig_plan_removal", { playlist_id: "pl1", track_ids: ["t1"] }));
  assert.ok(shared.cache.has("pl1"), "planning populated the shared cache");
  await call2("dig_apply_removal", { removal_token: p.removal_token, summary: p.plan.summary });
  assert.equal(shared.cache.has("pl1"), false, "apply dropped the shared cache entry");
});
