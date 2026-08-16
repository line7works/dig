// The four additive write tools (slice E R1): create, add, update details,
// reorder. Rules that govern every one of them:
//   - every proposed add runs through the slice-D matcher first; an UNCERTAIN
//     match is NEVER added — it comes back as a question with evidence (R2)
//   - every write is verified by re-read, reported with the result vocabulary
//     `verified | accepted | ambiguous | partial`, never a bare boolean (R3)
//   - an add is never blind-retried: an unknown-outcome failure re-reads the
//     playlist first to see whether the write landed (R3, research §9)
//   - reorder passes `snapshot_id` preconditions — the one items endpoint that
//     supports them — and a concurrent-edit failure says re-plan (R4)
import { defineTool } from "./tool-def.mjs";
import { spotify } from "./spotify-client.mjs";
import { FindIndex } from "./find-index.mjs";
import { extractRows, projectItemRow } from "./projection.mjs";
import { verifyCandidates } from "./matching.mjs";
import { RateLimitError, SpotifyApiError } from "./error-map.mjs";
import { AuthExpiredError } from "./token-store.mjs";
import { ValidationError, requireString, wrapTools } from "./read-tools.mjs";

const SEARCH_LIMIT = 10; // Spotify's Feb 2026 search cap
const MAX_PROPOSALS = 20; // each proposal costs one search request
const MAX_REORDER = 200; // each out-of-place row costs one move request
const ALT_SAMPLE = 3; // alternatives shown per uncertain match

// ---------- matcher seam (slice-D trap, matching.mjs:149) ----------
// verify() expects {title/name, artists:[strings]} and throws a raw TypeError
// on anything else — raw Spotify items are mapped HERE, never passed through.

function yearOf(releaseDate) {
  const y = Number(String(releaseDate ?? "").slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
}

// One raw Spotify track object -> the matcher's candidate shape.
export function toCandidate(t) {
  return {
    id: t?.id,
    uri: t?.uri,
    name: typeof t?.name === "string" ? t.name : "",
    artists: (t?.artists ?? []).map((a) => a?.name).filter((n) => typeof n === "string" && n !== ""),
    duration_ms: t?.duration_ms ?? null,
    isrc: t?.external_ids?.isrc,
    album: t?.album?.name,
    year: yearOf(t?.album?.release_date),
    explicit: t?.explicit ?? null,
  };
}

// One user/model proposal -> the matcher's wanted shape. The version rides
// inside the title so the matcher's version-class gate sees it; a duration
// from the model's memory is never trusted enough to veto (research §7 G4).
export function toWanted(p) {
  const title = p.version ? `${p.title} (${p.version})` : p.title;
  const wanted = { title, artists: [p.artist] };
  if (typeof p.duration_seconds === "number" && p.duration_seconds > 0) {
    wanted.duration_ms = Math.round(p.duration_seconds * 1000);
    wanted.duration_trusted = false;
  }
  return wanted;
}

function checkProposal(p, i) {
  if (typeof p !== "object" || p === null) {
    throw new ValidationError(`**Track ${i + 1} isn't an object.** Each entry needs at least \`title\` and \`artist\`.`);
  }
  for (const key of ["title", "artist"]) {
    if (typeof p[key] !== "string" || p[key].trim() === "") {
      throw new ValidationError(`**Track ${i + 1} is missing \`${key}\`.** Every proposed track needs \`title\` and \`artist\` (plus \`version\` and \`duration_seconds\` when known).`);
    }
  }
}

const proposalLabel = (p) => `${p.title}${p.version ? ` (${p.version})` : ""} — ${p.artist}`;
const candLabel = (c) => `${c.name} — ${(c.artists ?? []).join(", ")}`;

function evidence(v) {
  return { verdict: v.verdict, score: v.score, reasons: v.reasons };
}

function jsonText(obj) {
  return JSON.stringify(obj, null, 1);
}

// Spotify signals a stale snapshot_id / concurrent edit as a client error on
// the items endpoint; the fix is always the same: re-read and re-plan (R4).
function isConcurrentEditError(err) {
  return err instanceof SpotifyApiError && (err.status === 400 || err.status === 409) && /\/items$/.test(err.endpoint ?? "");
}

const REPLAN_NOTE =
  "The playlist changed while Dig was writing (likely an edit from the Spotify app). Nothing further was written. Re-read the playlist and re-plan from its current state.";

export function createWriteTools({ client = spotify, index } = {}) {
  const findIndex = index ?? new FindIndex(client);

  // Re-read one window of a playlist as raw rows (nulls kept — positions are
  // raw offsets, the slice-C contract).
  async function readWindow(playlistId, offset, limit, budget) {
    const page = await client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
      query: { fields: "total,items(item(id,uri,name))", limit: Math.min(Math.max(limit, 1), 50), offset: Math.max(offset, 0) },
      budget,
    });
    return { rows: extractRows(page), total: page?.total };
  }

  const tools = [
    {
      def: defineTool({
        name: "dig_create_playlist",
        title: "Create a playlist",
        access: "write",
        description:
          "Create a new playlist on the connected account. Spotify defaults new playlists to PUBLIC unless public:false is passed. Verified by re-read.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The playlist's name." },
            description: { type: "string", description: "Optional playlist description." },
            public: { type: "boolean", description: "Whether the playlist is public (Spotify's default is true)." },
            collaborative: { type: "boolean", description: "Whether others can edit it (requires public:false)." },
          },
          required: ["name"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const name = requireString(args, "name", "a playlist name");
        const body = { name };
        if (typeof args?.description === "string") body.description = args.description;
        if (typeof args?.public === "boolean") body.public = args.public;
        if (typeof args?.collaborative === "boolean") body.collaborative = args.collaborative;
        const created = await client.request("/me/playlists", { method: "POST", body, budget });
        const id = created?.id;
        if (!id) {
          return jsonText({ result: "ambiguous", note: "Spotify answered without a playlist ID — the playlist may or may not exist. List your playlists to check before retrying." });
        }
        // Verify by re-read (R3).
        let readBack = null;
        try {
          readBack = await client.request(`/playlists/${encodeURIComponent(id)}`, {
            query: { fields: "id,name,public,collaborative,snapshot_id" },
            budget,
          });
        } catch {
          // The create definitely happened (we hold the ID); only the
          // confirmation read failed.
        }
        const verified = readBack?.id === id && readBack?.name === name;
        return jsonText({
          result: verified ? "verified" : "accepted",
          playlist: { id, name: readBack?.name ?? created?.name ?? name, public: readBack?.public ?? created?.public, snapshot_id: readBack?.snapshot_id ?? created?.snapshot_id },
          note: verified
            ? "Created and confirmed by re-read."
            : "Spotify accepted the create, but the confirming re-read did not match — check with dig_get_playlist before writing to it.",
        });
      },
    },
    {
      def: defineTool({
        name: "dig_add_tracks",
        title: "Add verified tracks to a playlist",
        access: "write",
        description:
          "Add proposed tracks (title + artist, plus version/duration when known) to a playlist. Each proposal is searched and verified first: confident matches are added, uncertain ones come back as questions with evidence and are NEVER added, misses are reported honestly. Verified by re-read.",
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            tracks: {
              type: "array",
              minItems: 1,
              maxItems: MAX_PROPOSALS,
              description: `Proposed tracks, up to ${MAX_PROPOSALS} per call (each costs one search request).`,
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Track title, without version tags." },
                  artist: { type: "string", description: "Primary artist." },
                  version: { type: "string", description: "Version if a specific one is wanted, e.g. 'live', 'acoustic', 'remastered 2011'." },
                  duration_seconds: { type: "number", description: "Approximate duration in seconds, when known." },
                },
                required: ["title", "artist"],
                additionalProperties: false,
              },
            },
            position: { type: "integer", minimum: 0, description: "Insert position (raw playlist offset). Omit to append at the end." },
          },
          required: ["playlist_id", "tracks"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const playlistId = requireString(args, "playlist_id", "a playlist ID");
        const proposals = args?.tracks;
        if (!Array.isArray(proposals) || proposals.length === 0) {
          throw new ValidationError("**No tracks proposed.** Pass `tracks` as a list of {title, artist} objects.");
        }
        if (proposals.length > MAX_PROPOSALS) {
          throw new ValidationError(`**Too many tracks at once.** Each proposal costs one Spotify search; Dig caps this at ${MAX_PROPOSALS} per call. You sent ${proposals.length} — split the list.`);
        }
        proposals.forEach(checkProposal);

        // Match every proposal BEFORE writing anything (R2).
        const toAdd = [];
        const questions = [];
        const missing = [];
        for (const p of proposals) {
          const wanted = toWanted(p);
          const body = await client.request("/search", {
            query: { q: `${p.title} ${p.artist}`, type: "track", limit: SEARCH_LIMIT },
            budget,
          });
          const container = body?.items ?? body?.tracks ?? {};
          const rawRows = container?.items ?? [];
          const candidates = rawRows.map((r) => toCandidate(r?.item ?? r?.track ?? r)).filter((c) => c.uri && c.name && c.artists.length);
          if (candidates.length === 0) {
            missing.push({ proposed: proposalLabel(p), reason: "Spotify's catalog search returned nothing for this title + artist." });
            continue;
          }
          const { best, alternatives } = verifyCandidates(wanted, candidates);
          if (best.verdict === "CONFIDENT") {
            toAdd.push({ proposed: proposalLabel(p), track: candLabel(best.candidate), id: best.candidate.id, uri: best.candidate.uri, ...evidence(best) });
          } else if (best.verdict === "UNCERTAIN") {
            // NEVER added (R2) — returned as a question with the matcher's evidence.
            questions.push({
              proposed: proposalLabel(p),
              closest: { track: candLabel(best.candidate), id: best.candidate.id, ...evidence(best) },
              alternatives: alternatives.slice(0, ALT_SAMPLE).map((a) => ({ track: candLabel(a.candidate), id: a.candidate.id, ...evidence(a) })),
              note: "Not added. Ask the user which (if any) they meant; add their pick with an exact title + artist, or dig_get_tracks its ID first.",
            });
          } else {
            missing.push({ proposed: proposalLabel(p), reason: `Search found candidates but none matched (best: ${candLabel(best.candidate)} — ${best.reasons.join("; ")}).` });
          }
        }

        if (toAdd.length === 0) {
          return jsonText({
            result: "no_write",
            added: [],
            questions,
            missing,
            note: "Nothing met the confidence bar, so nothing was written. Report the misses honestly — never pad the list.",
          });
        }

        // Where the adds should land, for the confirming re-read.
        const meta = await client.request(`/playlists/${encodeURIComponent(playlistId)}`, {
          query: { fields: "snapshot_id,items(total)" },
          budget,
        });
        const totalBefore = meta?.items?.total ?? meta?.tracks?.total ?? 0;
        const insertAt = Number.isInteger(args?.position) ? Math.min(Math.max(args.position, 0), totalBefore) : totalBefore;

        const uris = toAdd.map((t) => t.uri);
        try {
          await client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
            method: "POST",
            body: { uris, ...(insertAt !== totalBefore ? { position: insertAt } : {}) },
            budget,
          });
        } catch (err) {
          // Definite failures — Spotify rejected or never received the write
          // (mapped API error, rate limit, expired auth): nothing landed, so
          // surface the instruction instead of probing further. A 429 in
          // particular means the write was NOT executed, and firing a re-read
          // into an active rate limit only escalates it.
          if (err instanceof SpotifyApiError || err instanceof RateLimitError || err instanceof AuthExpiredError) throw err;
          // Unknown outcome (timeout / network drop): never blind-retry an
          // add — fall through to the re-read to see whether it landed (R3).
        }

        // Verify by re-read (R3): POSITIONAL — each added uri must sit at its
        // expected raw offset, and the playlist's total must have grown by the
        // batch size. Mere presence-in-window would false-verify a silent
        // failure whenever the track already sat nearby.
        const { rows, total: totalAfter } = await readWindow(playlistId, insertAt, Math.min(uris.length + 5, 50), budget);
        const windowUris = rows.map((r) => (r?.item ?? r?.track)?.uri ?? null);
        const landed = toAdd.filter((t, k) => windowUris[k] === t.uri);
        const countOk = totalAfter == null || totalAfter === totalBefore + uris.length;
        const result =
          landed.length === toAdd.length && countOk ? "verified"
          : landed.length > 0 && landed.length < toAdd.length ? "partial"
          : "ambiguous";
        return jsonText({
          result,
          added: landed.map(({ uri, ...t }) => t),
          not_confirmed: result === "verified" ? undefined : toAdd.filter((t, k) => windowUris[k] !== t.uri).map(({ uri, ...t }) => t),
          questions,
          missing,
          note:
            result === "verified"
              ? `All ${landed.length} confident match(es) added and confirmed by re-read.`
              : result === "partial"
                ? "Some adds were confirmed by re-read and some were not. Do NOT retry blindly — re-read the playlist (dig_find_in_playlist) and add only what is truly absent."
                : "Spotify's answer could not be confirmed by re-read — the adds may not have landed. Do NOT retry blindly — re-read the playlist first.",
        });
      },
    },
    {
      def: defineTool({
        name: "dig_update_playlist_details",
        title: "Rename or re-describe a playlist",
        access: "write",
        description: "Change a playlist's name, description, or public/collaborative flags. Verified by re-read.",
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            name: { type: "string", description: "New name." },
            description: { type: "string", description: "New description." },
            public: { type: "boolean", description: "New public flag." },
            collaborative: { type: "boolean", description: "New collaborative flag (requires public:false)." },
          },
          required: ["playlist_id"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const playlistId = requireString(args, "playlist_id", "a playlist ID");
        const body = {};
        if (typeof args?.name === "string" && args.name.trim() !== "") body.name = args.name;
        if (typeof args?.description === "string") body.description = args.description;
        if (typeof args?.public === "boolean") body.public = args.public;
        if (typeof args?.collaborative === "boolean") body.collaborative = args.collaborative;
        if (Object.keys(body).length === 0) {
          throw new ValidationError("**Nothing to change.** Pass at least one of `name`, `description`, `public`, `collaborative`.");
        }
        await client.request(`/playlists/${encodeURIComponent(playlistId)}`, { method: "PUT", body, budget });

        // Verify by re-read (R3).
        const p = await client.request(`/playlists/${encodeURIComponent(playlistId)}`, {
          query: { fields: "id,name,description,public,collaborative" },
          budget,
        });
        const mismatches = [];
        if (body.name !== undefined && p?.name !== body.name) mismatches.push("name");
        if (body.public !== undefined && p?.public !== body.public) mismatches.push("public");
        if (body.collaborative !== undefined && p?.collaborative !== body.collaborative) mismatches.push("collaborative");
        // Spotify HTML-escapes descriptions on read; compare after unescaping.
        const unescape = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x?27;|&#39;/g, "'");
        const descOff = body.description !== undefined && unescape(p?.description) !== body.description;
        const result = mismatches.length > 0 ? "ambiguous" : descOff ? "accepted" : "verified";
        return jsonText({
          result,
          playlist: { id: p?.id, name: p?.name, description: p?.description || undefined, public: p?.public, collaborative: p?.collaborative },
          note:
            result === "verified"
              ? "Change confirmed by re-read."
              : result === "accepted"
                ? "Spotify accepted the change; the re-read description differs only in Spotify's own escaping/normalization."
                : `Re-read does not show the change for: ${mismatches.join(", ")}. Do not assume it landed — check dig_get_playlist and re-plan.`,
        });
      },
    },
    {
      def: defineTool({
        name: "dig_reorder",
        title: "Reorder a playlist",
        access: "write",
        description:
          `Reorder a playlist into an arbitrary new order. Pass new_order as a complete permutation of the current raw positions (0-based, from dig_list_playlist_tracks — unavailable/local rows count too): new_order[i] = the current position of the track that should end up at position i. Composed from Spotify's move primitive under a snapshot_id precondition; verified by re-read. Playlists over ${MAX_REORDER} tracks can't be reordered in one call.`,
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            new_order: {
              type: "array",
              items: { type: "integer", minimum: 0 },
              minItems: 1,
              description: "Complete permutation of current raw positions: new_order[i] = current position of the track that belongs at position i.",
            },
          },
          required: ["playlist_id", "new_order"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const playlistId = requireString(args, "playlist_id", "a playlist ID");
        const order = args?.new_order;
        if (!Array.isArray(order) || order.length === 0 || !order.every((x) => Number.isInteger(x) && x >= 0)) {
          throw new ValidationError("**Bad new_order.** Pass a complete permutation of the playlist's current raw positions (non-negative integers).");
        }

        // Pre-read: raw positions, count, and the snapshot the plan is based on.
        const before = await findIndex.get(playlistId, budget);
        const n = before.totalRows;
        if (n > MAX_REORDER) {
          throw new ValidationError(`**Playlist too large to reorder in one call.** This playlist has ${n} rows and Dig caps full reorders at ${MAX_REORDER}. Reorder a smaller playlist, or move tracks in stages.`);
        }
        if (order.length !== n) {
          throw new ValidationError(`**new_order has ${order.length} positions but the playlist has ${n} rows** (unavailable/local rows count). Pass a complete permutation of 0-${n - 1}.`);
        }
        if (new Set(order).size !== n || Math.max(...order) !== n - 1) {
          throw new ValidationError(`**new_order is not a permutation of 0-${n - 1}.** Every current position must appear exactly once.`);
        }

        // id-or-null at each raw position, for the confirming re-read.
        const idAt = new Array(n).fill(null);
        for (const t of before.tracks) idAt[t.position] = t.id;

        // Compose the permutation from single-row moves with SHIFTING indices:
        // `cur` tracks where each original position currently sits.
        const cur = Array.from({ length: n }, (_, i) => i);
        let snapshot = before.snapshotId;
        let moves = 0;
        for (let i = 0; i < n; i++) {
          const j = cur.indexOf(order[i], i);
          if (j === i) continue;
          let resp;
          try {
            resp = await client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
              method: "PUT",
              body: { range_start: j, insert_before: i, range_length: 1, ...(snapshot ? { snapshot_id: snapshot } : {}) },
              budget,
            });
          } catch (err) {
            if (isConcurrentEditError(err)) {
              return jsonText({ result: moves > 0 ? "partial" : "ambiguous", moves_applied: moves, note: REPLAN_NOTE });
            }
            // A definite failure (mapped API error, rate limit, expired auth)
            // before ANY move applied left the playlist untouched — surface
            // the instruction as-is; "nothing was lost" is then true.
            const definite = err instanceof SpotifyApiError || err instanceof RateLimitError || err instanceof AuthExpiredError;
            if (definite && moves === 0) throw err;
            // Anything mid-flight leaves the playlist in an intermediate
            // order (a definite failure after N moves, or an unknown outcome
            // whose move may or may not have landed). Never report that as
            // "nothing was lost" — state the partial truth and say re-plan.
            const cause = definite ? err.message : `The last move's outcome could not be confirmed (${err?.message ?? err}).`;
            return jsonText({
              result: moves > 0 ? "partial" : "ambiguous",
              moves_applied: moves,
              note: `Reorder stopped early: ${moves} of the planned moves were applied, so the playlist is in an INTERMEDIATE order. ${cause}\n\nRe-read the playlist (dig_list_playlist_tracks) and re-plan the remaining moves from its current state.`,
            });
          }
          snapshot = resp?.snapshot_id ?? snapshot;
          cur.splice(i, 0, cur.splice(j, 1)[0]);
          moves++;
        }

        // Verify by re-read (R3): every identifiable track at its target spot.
        const { rows } = await readWindow(playlistId, 0, 50, budget);
        const after = [];
        for (let offset = 0; offset < n; offset += 50) {
          const page = offset === 0 ? rows : (await readWindow(playlistId, offset, 50, budget)).rows;
          page.forEach((r, k) => { after[offset + k] = (r?.item ?? r?.track)?.id ?? null; });
          if (page.length === 0) break;
        }
        let confirmed = 0;
        let checked = 0;
        for (let i = 0; i < n; i++) {
          const expected = idAt[order[i]];
          if (expected === null) continue; // unavailable rows carry no id to compare
          checked++;
          if (after[i] === expected) confirmed++;
        }
        const result = confirmed === checked ? "verified" : confirmed > 0 ? "partial" : "ambiguous";
        return jsonText({
          result,
          moves_applied: moves,
          tracks_confirmed_in_place: `${confirmed}/${checked}`,
          note:
            result === "verified"
              ? moves === 0
                ? "The playlist was already in that order — nothing to move; confirmed by re-read."
                : `Reordered with ${moves} move(s) and confirmed by re-read.`
              : "The re-read does not match the requested order — the playlist may have changed underneath. Re-read it and re-plan.",
        });
      },
    },
  ];

  return wrapTools(tools);
}
