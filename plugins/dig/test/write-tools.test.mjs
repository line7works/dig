// Slice E (AC2): the four additive write tools against a mocked API —
// uncertain matches are never auto-added (R2), verify-after-write catches a
// silent failure (R3), the reorder permutation logic lands the mocked list
// in the requested order (R1/R4), and snapshot_id preconditions turn a
// concurrent edit into a re-plan instruction (R4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient } from "../server/spotify-client.mjs";
import { createWriteTools, toCandidate, toWanted } from "../server/write-tools.mjs";
import { FindIndex } from "../server/find-index.mjs";
import { verify } from "../server/matching.mjs";

process.env.SPOTIFY_CLIENT_ID = "a".repeat(32);

// ---------- mock Spotify world with WRITABLE playlists ----------

function makeTrack(i, name, artists = ["The Placeholder Band"], duration = 180_000) {
  return {
    id: `t${i}`,
    name,
    uri: `spotify:track:t${i}`,
    duration_ms: duration,
    artists: artists.map((n) => ({ name: n })),
    album: { name: `Album ${i}`, release_date: "1997-05-01" },
    external_ids: {},
  };
}

// Serves reads AND applies writes to in-memory playlists, recording every
// request. `world.silentWrites` makes writes answer 200 but change NOTHING —
// the R3 silent-failure case.
function makeWorld({ playlists = {} } = {}) {
  const writes = [];
  const world = { playlists, writes, searchHits: [], silentWrites: false, nextCreatedId: "newpl" };
  world.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method ?? "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (method !== "GET") writes.push({ method, path: u.pathname, body });
    const respond = (status, payload, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => payload,
      text: async () => (payload === null ? "" : JSON.stringify(payload)),
    });

    let m;
    if (u.pathname === "/v1/me/playlists" && method === "POST") {
      const id = world.nextCreatedId;
      if (!world.silentWrites) {
        playlists[id] = { name: body.name, description: body.description ?? "", public: body.public ?? true, collaborative: body.collaborative ?? false, snapshot_id: "snap-0", tracks: [] };
      }
      return respond(201, { id, name: body.name, public: body.public ?? true, snapshot_id: "snap-0" });
    }
    if ((m = u.pathname.match(/^\/v1\/playlists\/([^/]+)$/))) {
      const p = playlists[m[1]];
      if (!p) return respond(404, { error: { status: 404, message: "Not found." } });
      if (method === "PUT") {
        if (!world.silentWrites) {
          if (body.name !== undefined) p.name = body.name;
          if (body.description !== undefined) p.description = body.description;
          if (body.public !== undefined) p.public = body.public;
          if (body.collaborative !== undefined) p.collaborative = body.collaborative;
        }
        return respond(200, null);
      }
      return respond(200, {
        id: m[1], name: p.name, description: p.description ?? "", public: p.public ?? true,
        collaborative: p.collaborative ?? false, snapshot_id: p.snapshot_id, owner: { display_name: "Tony" },
        items: { total: p.tracks.length },
      });
    }
    if ((m = u.pathname.match(/^\/v1\/playlists\/([^/]+)\/items$/))) {
      const p = playlists[m[1]];
      if (!p) return respond(404, { error: { status: 404, message: "Not found." } });
      if (method === "POST") {
        if (!world.silentWrites) {
          const at = body.position ?? p.tracks.length;
          const items = body.uris.map((uri) => world.byUri?.[uri] ?? { id: uri.split(":").pop(), uri, name: uri, artists: [] });
          p.tracks.splice(at, 0, ...items);
          p.snapshot_id = `snap-${p.tracks.length}-${Date.now?.() ?? p.tracks.length}`;
        }
        return respond(201, { snapshot_id: p.snapshot_id });
      }
      if (method === "PUT") {
        // Spotify's move-slice primitive, with snapshot precondition.
        if (body.snapshot_id && body.snapshot_id !== p.snapshot_id) {
          return respond(400, { error: { status: 400, message: "Snapshot mismatch" } });
        }
        if (!world.silentWrites) {
          const moved = p.tracks.splice(body.range_start, body.range_length ?? 1);
          let at = body.insert_before;
          if (body.insert_before > body.range_start) at -= moved.length;
          p.tracks.splice(at, 0, ...moved);
          p.snapshot_id = `snap-m${world.writes.length}`;
        }
        return respond(200, { snapshot_id: p.snapshot_id });
      }
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 20);
      const rows = p.tracks.slice(offset, offset + limit).map((t) => ({ item: t }));
      return respond(200, { total: p.tracks.length, limit, offset, items: rows });
    }
    if (u.pathname === "/v1/search") {
      const limit = Number(u.searchParams.get("limit"));
      const hits = world.searchHits.slice(0, limit);
      return respond(200, { items: { items: hits, total: hits.length } });
    }
    return respond(500, { error: { message: `unmocked ${method} ${u.pathname}` } });
  };
  return world;
}

function makeRig(world) {
  const store = { getAccessToken: async () => "tok", invalidateAccess() {} };
  // Delegate so tests can swap world.fetch after the rig is built.
  const client = new SpotifyClient({ store, fetchImpl: (url, opts) => world.fetch(url, opts), sleep: async () => {} });
  const index = new FindIndex(client);
  const tools = createWriteTools({ client, index });
  const call = async (name, args) => {
    const t = tools.find((x) => x.def.name === name);
    return t.handler(args);
  };
  return { client, tools, call };
}

const parse = (r) => JSON.parse(r.text);

// ---------- R2: uncertain is NEVER auto-added ----------

test("AC2/R2: an uncertain match comes back as a question with evidence and is never added", async () => {
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks: [] } } });
  // "Grass" vs proposal "Sweetgrass" — the canonical near-miss: passes
  // nothing better than UNCERTAIN/REJECTED, must never be written.
  world.searchHits = [
    { item: makeTrack(1, "Grass", ["Prairie Sound"]) },
    { item: makeTrack(2, "Sweetgrass (Live)", ["Prairie Sound"]) },
  ];
  const { call } = makeRig(world);
  const res = parse(await call("dig_add_tracks", {
    playlist_id: "pl",
    tracks: [{ title: "Sweetgrass", artist: "Prairie Sound" }],
  }));
  assert.equal(res.result, "no_write");
  assert.equal(res.added.length, 0);
  assert.equal(world.writes.length, 0, "no write request may be issued for an unconfident batch");
  assert.equal(world.playlists.pl.tracks.length, 0);
  // Whether it surfaced as a question or a miss, it carries the matcher's
  // evidence; a version-tagged sibling must surface with verdict + reasons.
  const all = [...res.questions, ...res.missing];
  assert.equal(all.length, 1);
  if (res.questions.length) {
    const q = res.questions[0];
    assert.ok(q.closest.verdict === "UNCERTAIN");
    assert.ok(Array.isArray(q.closest.reasons) && q.closest.reasons.length > 0, "question carries evidence");
  }
});

test("AC2/R2: confident matches are added, uncertain ones held back, in ONE batch", async () => {
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks: [] } } });
  const exact = makeTrack(10, "Late Night Dub", ["Echo Chamber"]);
  world.byUri = { [exact.uri]: exact };
  const { call } = makeRig(world);

  // First proposal: exact match -> CONFIDENT. Second: near-miss -> held.
  const hitsByQuery = [
    [{ item: exact }],
    [{ item: makeTrack(11, "Grass", ["Prairie Sound"]) }],
  ];
  let i = 0;
  const origFetch = world.fetch;
  world.fetch = async (url, opts) => {
    if (new URL(url).pathname === "/v1/search") world.searchHits = hitsByQuery[i++] ?? [];
    return origFetch(url, opts);
  };

  const res = parse(await call("dig_add_tracks", {
    playlist_id: "pl",
    tracks: [
      { title: "Late Night Dub", artist: "Echo Chamber" },
      { title: "Sweetgrass", artist: "Prairie Sound" },
    ],
  }));
  assert.equal(res.result, "verified");
  assert.equal(res.added.length, 1);
  assert.match(res.added[0].track, /Late Night Dub/);
  const posts = world.writes.filter((w) => w.method === "POST");
  assert.equal(posts.length, 1, "one batched add");
  assert.deepEqual(posts[0].body.uris, [exact.uri], "only the confident uri is written");
  assert.equal(world.playlists.pl.tracks.length, 1);
});

// ---------- R3: verify-after-write flags a silent failure ----------

test("AC2/R3: a 200 that changed nothing is reported as not-verified (ambiguous), never success", async () => {
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks: [] } } });
  const exact = makeTrack(10, "Late Night Dub", ["Echo Chamber"]);
  world.searchHits = [{ item: exact }];
  world.silentWrites = true; // API answers 200/201 but the playlist never changes
  const { call } = makeRig(world);
  const res = parse(await call("dig_add_tracks", {
    playlist_id: "pl",
    tracks: [{ title: "Late Night Dub", artist: "Echo Chamber" }],
  }));
  assert.equal(res.result, "ambiguous");
  assert.equal(res.added.length, 0, "an unconfirmed add is not reported as added");
  assert.match(res.note, /re-?read/i);
  assert.doesNotMatch(res.note, /retry blindly.*safe/i);
});

test("AC2/R3: update_playlist_details verifies by re-read; a silent failure is ambiguous", async () => {
  const world = makeWorld({ playlists: { pl: { name: "Old Name", snapshot_id: "s1", tracks: [] } } });
  const { call } = makeRig(world);
  const ok = parse(await call("dig_update_playlist_details", { playlist_id: "pl", name: "New Name" }));
  assert.equal(ok.result, "verified");
  assert.equal(world.playlists.pl.name, "New Name");

  world.silentWrites = true;
  const bad = parse(await call("dig_update_playlist_details", { playlist_id: "pl", name: "Third Name" }));
  assert.equal(bad.result, "ambiguous");
  assert.match(bad.note, /re-plan|check/i);
});

test("R3: create_playlist verifies the new playlist by re-read", async () => {
  const world = makeWorld();
  const { call } = makeRig(world);
  const res = parse(await call("dig_create_playlist", { name: "Fresh Mix", public: false }));
  assert.equal(res.result, "verified");
  assert.equal(res.playlist.id, "newpl");
  assert.equal(world.playlists.newpl.name, "Fresh Mix");
  const post = world.writes.find((w) => w.method === "POST");
  assert.equal(post.body.public, false);
});

// ---------- R1/R4: reorder permutation + snapshot precondition ----------

test("AC2/R1: reorder composes moves that land the mocked list in the requested order", async () => {
  const tracks = ["A", "B", "C", "D", "E"].map((n, i) => makeTrack(i, n));
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks } } });
  const { call } = makeRig(world);
  // Reverse plus a swap: positions [4,3,2,0,1] -> E D C A B
  const res = parse(await call("dig_reorder", { playlist_id: "pl", new_order: [4, 3, 2, 0, 1] }));
  assert.equal(res.result, "verified");
  assert.deepEqual(world.playlists.pl.tracks.map((t) => t.name), ["E", "D", "C", "A", "B"]);
  // Every move carried the snapshot precondition (R4).
  const moves = world.writes.filter((w) => w.method === "PUT");
  assert.ok(moves.length > 0);
  for (const mv of moves) assert.ok(mv.body.snapshot_id, "each move passes snapshot_id");
});

test("R1: identity permutation issues no moves and still verifies", async () => {
  const tracks = ["A", "B", "C"].map((n, i) => makeTrack(i, n));
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks } } });
  const { call } = makeRig(world);
  const res = parse(await call("dig_reorder", { playlist_id: "pl", new_order: [0, 1, 2] }));
  assert.equal(res.result, "verified");
  assert.equal(res.moves_applied, 0);
  assert.equal(world.writes.filter((w) => w.method === "PUT").length, 0);
});

test("AC2/R4: a concurrent edit (snapshot mismatch) becomes a re-plan instruction, not a crash or a retry", async () => {
  const tracks = ["A", "B", "C"].map((n, i) => makeTrack(i, n));
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks } } });
  const { call } = makeRig(world);
  // Someone edits the playlist between Dig's pre-read and its first move.
  const origFetch = world.fetch;
  let armed = true;
  world.fetch = async (url, opts) => {
    if (armed && (opts?.method ?? "GET") === "PUT") {
      armed = false;
      world.playlists.pl.snapshot_id = "s2-moved-underneath";
    }
    return origFetch(url, opts);
  };
  const res = parse(await call("dig_reorder", { playlist_id: "pl", new_order: [2, 1, 0] }));
  assert.equal(res.result, "ambiguous");
  assert.match(res.note, /re-plan/i);
  assert.deepEqual(world.playlists.pl.tracks.map((t) => t.name), ["A", "B", "C"], "nothing was force-written past the mismatch");
});

test("R1: reorder validates the permutation and reports raw-row counts", async () => {
  const tracks = ["A", "B", "C"].map((n, i) => makeTrack(i, n));
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks } } });
  const { call } = makeRig(world);
  const short = await call("dig_reorder", { playlist_id: "pl", new_order: [0, 1] });
  assert.equal(short.isError, true);
  assert.match(short.text, /3 rows/);
  const dupes = await call("dig_reorder", { playlist_id: "pl", new_order: [0, 1, 1] });
  assert.equal(dupes.isError, true);
  assert.match(dupes.text, /not a permutation/);
});

// ---------- the matcher seam (slice-D trap: never pass raw API items) ----------

test("seam: raw Spotify items are adapted before reaching verify(), and the adapter output verifies", () => {
  const raw = makeTrack(1, "Late Night Dub", ["Echo Chamber"]);
  const cand = toCandidate(raw);
  assert.deepEqual(cand.artists, ["Echo Chamber"], "artists become plain strings");
  assert.equal(cand.year, 1997, "year derived from album release_date");
  const wanted = toWanted({ title: "Late Night Dub", artist: "Echo Chamber" });
  const v = verify(wanted, cand); // would throw a TypeError on a raw item
  assert.equal(v.verdict, "CONFIDENT");
});

test("seam: a proposed version rides into the matcher's version-class gate", () => {
  const cand = toCandidate(makeTrack(1, "Anthem - Live", ["Echo Chamber"]));
  const studio = verify(toWanted({ title: "Anthem", artist: "Echo Chamber" }), cand);
  assert.equal(studio.verdict, "REJECTED", "live candidate rejected for a studio ask");
  const live = verify(toWanted({ title: "Anthem", artist: "Echo Chamber", version: "live" }), cand);
  assert.equal(live.verdict, "CONFIDENT", "explicitly requested live version accepted");
});

test("validation: proposals missing title or artist are refused before any request", async () => {
  const world = makeWorld({ playlists: { pl: { name: "Mix", snapshot_id: "s1", tracks: [] } } });
  const { call } = makeRig(world);
  const res = await call("dig_add_tracks", { playlist_id: "pl", tracks: [{ title: "No Artist" }] });
  assert.equal(res.isError, true);
  assert.match(res.text, /artist/);
  assert.equal(world.writes.length, 0);
});

test("R6 carryover: write tools derive annotations from the write access class", async () => {
  const world = makeWorld();
  const { tools } = makeRig(world);
  assert.equal(tools.length, 4);
  for (const t of tools) {
    assert.equal(t.def.annotations.readOnlyHint, false);
    assert.equal(t.def.annotations.destructiveHint, false, "additive writes are not destructive");
    assert.equal(t.def.annotations.idempotentHint, false);
  }
});
