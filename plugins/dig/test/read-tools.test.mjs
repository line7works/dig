// Slice C: read tools, projection/pagination bounds (AC2), rate-limit
// behavior (AC3), index invalidation (AC4), error mapping (R5), annotation
// derivation (R6), and the server-instructions budget (R7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpotifyClient } from "../server/spotify-client.mjs";
import { createReadTools } from "../server/read-tools.mjs";
import { FindIndex } from "../server/find-index.mjs";
import { SERVER_INSTRUCTIONS } from "../server/instructions.mjs";
import { STATUS_TOOL } from "../server/status.mjs";
import { CONNECT_TOOL } from "../server/connect.mjs";
import { AuthExpiredError } from "../server/token-store.mjs";

process.env.SPOTIFY_CLIENT_ID = "a".repeat(32);

// ---------- mock Spotify world ----------

function makeTrack(i, name, artists = ["The Placeholder Band"]) {
  return {
    id: `t${i}`,
    name,
    uri: `spotify:track:t${i}`,
    duration_ms: 180_000 + i,
    artists: artists.map((n) => ({ name: n, id: `a-${n}` })),
    album: { name: `Album ${i}`, release_date: "1997-05-01", images: [{ url: "x".repeat(120) }] },
    external_ids: { isrc: `USXX17${String(i).padStart(5, "0")}` },
    external_urls: { spotify: `https://open.spotify.com/track/t${i}` },
    available_markets: undefined,
  };
}

// A fake fetch serving playlists + search + tracks, recording every request.
function makeWorld({ playlists = {}, tracks = {} } = {}) {
  const requests = [];
  const world = { playlists, tracks, requests };
  world.fetch = async (url) => {
    const u = new URL(url);
    requests.push(u);
    const respond = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    });
    if (world.nextResponses?.length) return respond(...world.nextResponses.shift());

    let m;
    if ((m = u.pathname.match(/^\/v1\/playlists\/([^/]+)$/))) {
      const p = playlists[m[1]];
      if (!p) return respond(404, { error: { status: 404, message: "Not found." } });
      return respond(200, {
        id: m[1], name: p.name, description: p.description, public: true, collaborative: false,
        snapshot_id: p.snapshot_id, owner: { display_name: "Tony" }, items: { total: p.tracks.length },
      });
    }
    if ((m = u.pathname.match(/^\/v1\/playlists\/([^/]+)\/items$/))) {
      const p = playlists[m[1]];
      if (!p) return respond(404, { error: { status: 404, message: "Not found." } });
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 20);
      const rows = p.tracks.slice(offset, offset + limit).map((t) => ({ added_at: "2026-01-01T00:00:00Z", item: t }));
      return respond(200, { total: p.tracks.length, limit, offset, items: rows });
    }
    if (u.pathname === "/v1/search") {
      const limit = Number(u.searchParams.get("limit"));
      const hits = (world.searchHits ?? []).slice(0, limit);
      return respond(200, { items: { items: hits, total: hits.length } });
    }
    if (u.pathname === "/v1/me/playlists") {
      const all = Object.entries(playlists).map(([id, p]) => ({
        id, name: p.name, public: true, collaborative: false,
        owner: { display_name: "Tony" }, items: { total: p.tracks.length },
      }));
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 20);
      return respond(200, { total: all.length, limit, offset, items: all.slice(offset, offset + limit) });
    }
    if ((m = u.pathname.match(/^\/v1\/tracks\/([^/]+)$/))) {
      const t = tracks[m[1]];
      return t ? respond(200, t) : respond(404, { error: { status: 404, message: "Not found." } });
    }
    return respond(500, { error: { message: `unmocked path ${u.pathname}` } });
  };
  return world;
}

function makeRig(world) {
  const sleeps = [];
  const store = {
    invalidations: 0,
    getAccessToken: async () => "tok",
    invalidateAccess() { this.invalidations += 1; },
  };
  const client = new SpotifyClient({ store, fetchImpl: world.fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const index = new FindIndex(client);
  const tools = createReadTools({ client, index });
  const call = async (name, args) => {
    const t = tools.find((x) => x.def.name === name);
    return t.handler(args);
  };
  return { client, index, tools, call, sleeps, store };
}

function bigPlaylist(n = 4000) {
  const tracks = [];
  for (let i = 0; i < n; i++) {
    tracks.push(makeTrack(i, i % 8 === 0 ? `Late Night Dub ${i}` : `Song Number ${i} (Deluxe Remaster)`));
  }
  return { name: "Big One", snapshot_id: "snap-1", tracks };
}

// ---------- AC2: projection + pagination bounds ----------

test("AC2: compact page of a 4000-track playlist stays under the token budget and carries continuation", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist() } });
  const { call } = makeRig(world);
  const r = await call("dig_list_playlist_tracks", { playlist_id: "big" });
  assert.equal(r.isError, false);
  const body = JSON.parse(r.text);
  assert.equal(body.tracks.length, 50, "one page, never the whole playlist");
  assert.equal(body.range.total, 4000);
  // 60 tokens/track equivalent at ~4 chars/token = 240 serialized chars.
  for (const t of body.tracks) {
    assert.ok(JSON.stringify(t).length < 240, `compact track too big: ${JSON.stringify(t)}`);
  }
  assert.match(body.next_call, /dig_list_playlist_tracks/, "continuation names the tool");
  assert.match(body.next_call, /offset=50/, "continuation names the exact next offset");
  assert.match(body.note, /More available/);
});

test("AC2: final page says plainly that it is exhausted", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist() } });
  const { call } = makeRig(world);
  const body = JSON.parse((await call("dig_list_playlist_tracks", { playlist_id: "big", offset: 3990 })).text);
  assert.equal(body.tracks.length, 10);
  assert.equal(body.next_call, null);
  assert.match(body.note, /end/i);
});

test("AC2: no code path requests an unbounded page from Spotify", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist(120), other: { name: "Other", snapshot_id: "o1", tracks: [makeTrack(9001, "Lonely")] } } });
  const { call } = makeRig(world);
  await call("dig_list_playlist_tracks", { playlist_id: "big", limit: 9999 }); // clamped
  await call("dig_find_in_playlist", { playlist_id: "big", query: "dub" }); // pages the index
  await call("dig_diff_playlists", { playlist_a: "big", playlist_b: "other" });
  const itemReqs = world.requests.filter((u) => u.pathname.endsWith("/items"));
  assert.ok(itemReqs.length > 0);
  for (const u of itemReqs) {
    const limit = Number(u.searchParams.get("limit"));
    assert.ok(Number.isFinite(limit) && limit <= 50, `unbounded or oversized page: limit=${u.searchParams.get("limit")}`);
  }
});

test("AC2/R3: find answers an aggregate question with a count plus capped sample, truncation as data", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist() } });
  const { call } = makeRig(world);
  const body = JSON.parse((await call("dig_find_in_playlist", { playlist_id: "big", query: "late night dub" })).text);
  assert.equal(body.total_matches, 500, "full count reported");
  assert.equal(body.matches.length, 10, "sample capped");
  assert.equal(body.truncated, true, "truncation reported as data");
  assert.equal(body.total_tracks_searched, 4000);
});

test("R1: diff reports per-side counts and capped samples", async () => {
  const a = { name: "A", snapshot_id: "a1", tracks: Array.from({ length: 40 }, (_, i) => makeTrack(i, `Shared ${i}`)) };
  const b = { name: "B", snapshot_id: "b1", tracks: [...a.tracks.slice(0, 25), ...Array.from({ length: 30 }, (_, i) => makeTrack(1000 + i, `Only B ${i}`))] };
  const world = makeWorld({ playlists: { a, b } });
  const { call } = makeRig(world);
  const body = JSON.parse((await call("dig_diff_playlists", { playlist_a: "a", playlist_b: "b" })).text);
  assert.equal(body.a.only_here, 15);
  assert.equal(body.b.only_here, 30);
  assert.equal(body.in_both, 25);
  assert.equal(body.b.sample.length, 10);
  assert.equal(body.b.sample_truncated, true);
});

test("R1: search respects Spotify's 10-result cap and projects compactly", async () => {
  const world = makeWorld({});
  world.searchHits = Array.from({ length: 10 }, (_, i) => makeTrack(i, `Hit ${i}`));
  const { call } = makeRig(world);
  const body = JSON.parse((await call("dig_search_catalog", { query: "hit", limit: 10 })).text);
  assert.equal(body.results.length, 10);
  assert.ok(body.results.every((t) => !t.album), "compact projection by default");
  const req = world.requests.find((u) => u.pathname === "/v1/search");
  assert.equal(req.searchParams.get("limit"), "10");
});

test("R1: dig_get_tracks makes exactly one request per ID and refuses oversized lists", async () => {
  const tracks = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`t${i}`, makeTrack(i, `Solo ${i}`)]));
  const world = makeWorld({ tracks });
  const { call } = makeRig(world);
  const ok = JSON.parse((await call("dig_get_tracks", { track_ids: ["t0", "t1", "t2"] })).text);
  assert.equal(ok.count, 3);
  assert.equal(world.requests.filter((u) => u.pathname.startsWith("/v1/tracks/")).length, 3);

  const before = world.requests.length;
  const refused = await call("dig_get_tracks", { track_ids: Array.from({ length: 25 }, (_, i) => `t${i}`) });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Too many tracks/);
  assert.equal(world.requests.length, before, "refused before touching the network");
});

// ---------- AC3: rate limiting ----------

test("AC3: 429 with Retry-After 3 waits exactly 3s and retries once", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist(5) } });
  world.nextResponses = [[429, {}, { "retry-after": "3" }]];
  const { call, sleeps } = makeRig(world);
  const r = await call("dig_get_playlist", { playlist_id: "big" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(sleeps, [3000], "honored Retry-After exactly, once");
});

test("AC3: Retry-After 7200 stops immediately and reports the wait", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist(5) } });
  world.nextResponses = [[429, {}, { "retry-after": "7200" }]];
  const { call, sleeps } = makeRig(world);
  const r = await call("dig_get_playlist", { playlist_id: "big" });
  assert.equal(r.isError, true);
  assert.match(r.text, /rate-limiting/i);
  assert.match(r.text, /2 hour/, "tells the user how long Spotify asked for");
  assert.deepEqual(sleeps, [], "did not block the tool call");
});

test("AC3: a second 429 after the retry stops rather than looping", async () => {
  const world = makeWorld({ playlists: { big: bigPlaylist(5) } });
  world.nextResponses = [[429, {}, { "retry-after": "2" }], [429, {}, { "retry-after": "30" }]];
  const { call, sleeps } = makeRig(world);
  const r = await call("dig_get_playlist", { playlist_id: "big" });
  assert.equal(r.isError, true);
  assert.deepEqual(sleeps, [2000], "retried exactly once");
});

// ---------- R4: one serialized queue ----------

test("R4: requests are serialized — the second never starts before the first finishes", async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  let n = 0;
  const fetchImpl = async () => {
    const me = ++n;
    order.push(`start${me}`);
    if (me === 1) await gate;
    order.push(`end${me}`);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
  };
  const store = { getAccessToken: async () => "tok", invalidateAccess() {} };
  const client = new SpotifyClient({ store, fetchImpl });
  const p1 = client.request("/me/playlists");
  const p2 = client.request("/me/playlists");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["start1"], "second request queued behind the first");
  releaseFirst();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
});

// ---------- AC4: index invalidation ----------

test("AC4: unchanged snapshot_id reuses the index; changed snapshot_id rebuilds it", async () => {
  const world = makeWorld({ playlists: { p: { name: "P", snapshot_id: "s1", tracks: [makeTrack(1, "Original Cut")] } } });
  const { call } = makeRig(world);

  const first = JSON.parse((await call("dig_find_in_playlist", { playlist_id: "p", query: "original" })).text);
  assert.equal(first.total_matches, 1);
  const pagesAfterBuild = world.requests.filter((u) => u.pathname.endsWith("/items")).length;

  const again = JSON.parse((await call("dig_find_in_playlist", { playlist_id: "p", query: "original" })).text);
  assert.equal(again.total_matches, 1);
  assert.equal(
    world.requests.filter((u) => u.pathname.endsWith("/items")).length,
    pagesAfterBuild,
    "same snapshot: answered from the index, no re-page",
  );

  world.playlists.p = { name: "P", snapshot_id: "s2", tracks: [makeTrack(2, "Brand New Thing")] };
  const rebuilt = JSON.parse((await call("dig_find_in_playlist", { playlist_id: "p", query: "brand new" })).text);
  assert.equal(rebuilt.total_matches, 1, "index rebuilt from the changed playlist");
  assert.ok(
    world.requests.filter((u) => u.pathname.endsWith("/items")).length > pagesAfterBuild,
    "changed snapshot: playlist re-paged",
  );
});

// ---------- R5: error mapping ----------

test("R5: 401 is authoritative — invalidate, refresh, retry once, succeed", async () => {
  const world = makeWorld({ playlists: { p: { name: "P", snapshot_id: "s1", tracks: [] } } });
  world.nextResponses = [[401, { error: { status: 401, message: "The access token expired" } }]];
  const { call, store } = makeRig(world);
  const r = await call("dig_get_playlist", { playlist_id: "p" });
  assert.equal(r.isError, false, r.text);
  assert.equal(store.invalidations, 1, "in-memory access token invalidated via the sanctioned API");
});

test("R5: persistent 401 after the one retry maps to a reconnect instruction", async () => {
  const world = makeWorld({});
  world.nextResponses = [[401, {}], [401, {}]];
  const { call } = makeRig(world);
  const r = await call("dig_list_playlists", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /reconnect/i);
});

test("R5: Premium 403 gets the Premium copy; playlist 403 explains own-playlists-only", async () => {
  const world = makeWorld({});
  world.nextResponses = [[403, { error: { status: 403, message: "Active premium subscription required for the owner of the app" } }]];
  const { call } = makeRig(world);
  const premium = await call("dig_list_playlists", {});
  assert.equal(premium.isError, true);
  assert.match(premium.text, /Premium subscription/);

  world.nextResponses = [[403, { error: { status: 403, message: "Forbidden" } }]];
  const denied = await call("dig_get_playlist", { playlist_id: "someoneelses" });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /owns or collaborates/i);
  assert.match(denied.text, /User Management/, "still points at the allowlist trap");
});

test("R5: expired connection surfaces the reconnect copy, not a raw error", async () => {
  const world = makeWorld({});
  const { tools } = makeRig(world);
  const store = { getAccessToken: async () => { throw new AuthExpiredError(); }, invalidateAccess() {} };
  const client = new SpotifyClient({ store, fetchImpl: world.fetch });
  const [listPlaylists] = createReadTools({ client }).filter((t) => t.def.name === "dig_list_playlists");
  const r = await listPlaylists.handler({});
  assert.equal(r.isError, true);
  assert.match(r.text, /connection expired/i);
  assert.ok(tools.length === 7, "sanity: seven read tools registered");
});

test("R5: validation failures are isError tool results and never reach the network", async () => {
  const world = makeWorld({});
  const { call } = makeRig(world);
  for (const [name, args, pattern] of [
    ["dig_get_playlist", {}, /Missing a playlist ID/i],
    ["dig_find_in_playlist", { playlist_id: "p" }, /Missing text to find/i],
    ["dig_search_catalog", { query: "x", detail: "verbose" }, /Unknown detail level/],
    ["dig_get_tracks", { track_ids: [] }, /Missing track IDs/],
  ]) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, pattern);
  }
  assert.equal(world.requests.length, 0, "no Spotify traffic for invalid input");
});

// ---------- R6: annotations from one authored field ----------

test("R6: every tool's annotations are derived, complete, and honest about read-onlyness", () => {
  const world = makeWorld({});
  const { tools } = makeRig(world);
  const allDefs = [STATUS_TOOL, CONNECT_TOOL, ...tools.map((t) => t.def)];
  assert.equal(allDefs.length, 9);
  for (const def of allDefs) {
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof def.annotations[hint], "boolean", `${def.name} missing ${hint}`);
    }
    assert.equal(typeof def.annotations.title, "string", `${def.name} missing title`);
  }
  for (const t of tools) {
    assert.equal(t.def.annotations.readOnlyHint, true, `${t.def.name} must be read-only`);
    assert.equal(t.def.annotations.destructiveHint, false);
  }
  assert.equal(CONNECT_TOOL.annotations.readOnlyHint, false, "connect writes local state");
});

// ---------- R7: server instructions budget ----------

test("R7: server instructions fit the 2 KB budget and carry the cross-cutting rules", () => {
  const bytes = Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8");
  assert.ok(bytes <= 2048, `server instructions are ${bytes} bytes (budget 2048)`);
  assert.match(SERVER_INSTRUCTIONS, /paginated/i);
  assert.match(SERVER_INSTRUCTIONS, /dig_find_in_playlist/);
  assert.match(SERVER_INSTRUCTIONS, /rate limit/i);
});
