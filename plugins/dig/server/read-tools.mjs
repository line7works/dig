// The seven read tools (slice C R1) — every read the product needs, none of
// them able to flood the context window (R3):
//   - compact projection by default, `detail` opt-in for more
//   - every list paginated, replies naming the exact next call and saying
//     plainly when exhausted
//   - aggregate questions answered with aggregates (count + sample)
//   - truncation reported as data, not just prose
// All Spotify traffic goes through the one serialized client (R4); failures
// arrive as mapped instructions (R5) and are returned as isError tool
// results, never protocol errors.
import { defineTool } from "./tool-def.mjs";
import { spotify, waitBudget } from "./spotify-client.mjs";
import { FindIndex } from "./find-index.mjs";
import { FIELDS, DETAIL_LEVELS, validDetail, extractRows, projectItemRow, projectTrack } from "./projection.mjs";
import { AuthExpiredError } from "./token-store.mjs";
import { RateLimitError, SpotifyApiError } from "./error-map.mjs";

const PAGE_LIMIT = 50; // playlist + list endpoints
const SEARCH_MAX = 10; // Spotify's Feb 2026 search cap (research §2)
const SAMPLE_SIZE = 10; // aggregate answers: count + up to this many rows
const HYDRATE_MAX = 20; // dig_get_tracks per call — each ID is one request

const detailProp = {
  type: "string",
  enum: DETAIL_LEVELS,
  description: "How much per track: compact (default; id, title, artists, duration), standard (adds album, year, ISRC), full (everything Spotify sends).",
};

// Validation failure -> isError tool result (never a protocol error).
class ValidationError extends Error {}

function requireString(args, key, what) {
  const v = args?.[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ValidationError(`**Missing ${what}.** Pass \`${key}\` — get one from dig_list_playlists or dig_search_catalog.`);
  }
  return v.trim();
}

function jsonText(obj) {
  return JSON.stringify(obj, null, 1);
}

export function createReadTools({ client = spotify, index } = {}) {
  const findIndex = index ?? new FindIndex(client);

  const tools = [
    {
      def: defineTool({
        name: "dig_search_catalog",
        title: "Search the Spotify catalog",
        access: "read",
        description:
          "Search Spotify's catalog for tracks. Returns at most 10 results (Spotify's cap for this app type), projected compactly.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for — track title, optionally with the artist." },
            limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX, description: "Max results, 1-10 (default 5)." },
            detail: detailProp,
          },
          required: ["query"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const query = requireString(args, "query", "a search query");
        const detail = checkDetail(args);
        const limit = Math.min(Math.max(1, args?.limit ?? 5), SEARCH_MAX);
        const body = await client.request("/search", { query: { q: query, type: "track", limit }, budget });
        const container = body?.items ?? body?.tracks ?? {};
        const rows = container?.items ?? [];
        const tracks = rows.map((r) => projectTrack(r?.item ?? r?.track ?? r, detail));
        return jsonText({
          query,
          results: tracks,
          note:
            tracks.length === limit
              ? `Spotify caps search at ${SEARCH_MAX} results per query for this app type; refine the query rather than paging.`
              : `${tracks.length} result(s) — that's everything Spotify returned.`,
        });
      },
    },
    {
      def: defineTool({
        name: "dig_list_playlists",
        title: "List the user's playlists",
        access: "read",
        description: "List the playlists the connected account owns or collaborates on, paginated.",
        inputSchema: {
          type: "object",
          properties: {
            offset: { type: "integer", minimum: 0, description: "Start position (default 0)." },
            limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT, description: `Page size, 1-${PAGE_LIMIT} (default ${PAGE_LIMIT}).` },
          },
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const offset = Math.max(0, args?.offset ?? 0);
        const limit = Math.min(Math.max(1, args?.limit ?? PAGE_LIMIT), PAGE_LIMIT);
        const body = await client.request("/me/playlists", { query: { offset, limit }, budget });
        const rows = extractRows(body);
        const playlists = rows.filter(Boolean).map((p) => ({
          id: p.id,
          name: p.name,
          tracks: p.items?.total ?? p.tracks?.total,
          public: p.public,
          collaborative: p.collaborative,
          owner: p.owner?.display_name,
        }));
        const total = body?.total ?? playlists.length;
        return jsonText({
          playlists,
          range: { offset, count: playlists.length, total },
          ...pageNote("dig_list_playlists", offset, playlists.length, total),
        });
      },
    },
    {
      def: defineTool({
        name: "dig_get_playlist",
        title: "Get playlist details",
        access: "read",
        description: "Get one playlist's metadata (name, description, size, snapshot). No tracks — use dig_list_playlist_tracks for those.",
        inputSchema: {
          type: "object",
          properties: { playlist_id: { type: "string", description: "The playlist's Spotify ID." } },
          required: ["playlist_id"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const id = requireString(args, "playlist_id", "a playlist ID");
        const p = await client.request(`/playlists/${encodeURIComponent(id)}`, {
          query: { fields: "id,name,description,public,collaborative,snapshot_id,owner(display_name),items(total)" },
          budget,
        });
        return jsonText({
          id: p?.id,
          name: p?.name,
          description: p?.description || undefined,
          tracks: p?.items?.total ?? p?.tracks?.total,
          public: p?.public,
          collaborative: p?.collaborative,
          owner: p?.owner?.display_name,
          snapshot_id: p?.snapshot_id,
          note: "Metadata only — call dig_list_playlist_tracks for the tracks.",
        });
      },
    },
    {
      def: defineTool({
        name: "dig_list_playlist_tracks",
        title: "List a playlist's tracks",
        access: "read",
        description: "Page through a playlist's tracks, compactly projected. Never returns the whole playlist at once.",
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            offset: { type: "integer", minimum: 0, description: "Start position (default 0)." },
            limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT, description: `Page size, 1-${PAGE_LIMIT} (default ${PAGE_LIMIT}).` },
            detail: detailProp,
          },
          required: ["playlist_id"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const id = requireString(args, "playlist_id", "a playlist ID");
        const detail = checkDetail(args);
        const offset = Math.max(0, args?.offset ?? 0);
        const limit = Math.min(Math.max(1, args?.limit ?? PAGE_LIMIT), PAGE_LIMIT);
        const page = await client.request(`/playlists/${encodeURIComponent(id)}/items`, {
          query: { fields: FIELDS[detail], limit, offset },
          budget,
        });
        // Positions and page advance count RAW rows: Spotify returns null for
        // local/unavailable tracks, and dropping them before numbering would
        // shift every later position and stall the offset (all-null page =
        // infinite loop). Nulls are reported as data, not silently skipped.
        const rows = extractRows(page);
        const tracks = rows
          .map((r, i) => {
            const t = projectItemRow(r, detail);
            return t ? { position: offset + i, ...t } : null;
          })
          .filter(Boolean);
        const unavailable = rows.length - tracks.length;
        const total = page?.total ?? offset + rows.length;
        return jsonText({
          tracks,
          range: { offset, count: rows.length, total },
          ...(unavailable > 0 ? { unavailable_rows: unavailable } : {}),
          ...pageNote("dig_list_playlist_tracks", offset, rows.length, total, `playlist_id="${id}"`),
        });
      },
    },
    {
      def: defineTool({
        name: "dig_find_in_playlist",
        title: "Find tracks within a playlist",
        access: "read",
        description:
          "Search WITHIN one playlist by title or artist (Spotify itself cannot do this — Dig indexes the playlist server-side). Returns the match count and a sample.",
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            query: { type: "string", description: "Text to find in track titles or artist names." },
          },
          required: ["playlist_id", "query"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const id = requireString(args, "playlist_id", "a playlist ID");
        const query = requireString(args, "query", "text to find");
        const { playlistName, totalTracks, matches } = await findIndex.find(id, query, budget);
        return jsonText({
          playlist: playlistName,
          query,
          total_matches: matches.length,
          total_tracks_searched: totalTracks,
          matches: matches.slice(0, SAMPLE_SIZE),
          truncated: matches.length > SAMPLE_SIZE,
          note:
            matches.length > SAMPLE_SIZE
              ? `Showing the first ${SAMPLE_SIZE} of ${matches.length} matches — narrow the query, or page the positions with dig_list_playlist_tracks.`
              : matches.length === 0
                ? "No track title or artist in this playlist contains that text."
                : "All matches shown.",
        });
      },
    },
    {
      def: defineTool({
        name: "dig_diff_playlists",
        title: "Compare two playlists",
        access: "read",
        description: "Compare two playlists: what's in one and not the other. Returns counts plus a sample from each side.",
        inputSchema: {
          type: "object",
          properties: {
            playlist_a: { type: "string", description: "First playlist's Spotify ID." },
            playlist_b: { type: "string", description: "Second playlist's Spotify ID." },
          },
          required: ["playlist_a", "playlist_b"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const aId = requireString(args, "playlist_a", "the first playlist ID");
        const bId = requireString(args, "playlist_b", "the second playlist ID");
        const a = await findIndex.get(aId, budget);
        const b = await findIndex.get(bId, budget);
        const bIds = new Set(b.tracks.map((t) => t.id));
        const aIds = new Set(a.tracks.map((t) => t.id));
        const onlyA = a.tracks.filter((t) => !bIds.has(t.id));
        const onlyB = b.tracks.filter((t) => !aIds.has(t.id));
        const side = (name, total, only) => ({
          name,
          total_tracks: total,
          only_here: only.length,
          sample: only.slice(0, SAMPLE_SIZE).map((t) => ({ name: t.name, artists: t.artists, id: t.id })),
          sample_truncated: only.length > SAMPLE_SIZE,
        });
        return jsonText({
          a: side(a.name, a.tracks.length, onlyA),
          b: side(b.name, b.tracks.length, onlyB),
          in_both: a.tracks.length - onlyA.length,
          note: `Samples cap at ${SAMPLE_SIZE} per side; use dig_find_in_playlist or dig_list_playlist_tracks for the full lists.`,
        });
      },
    },
    {
      def: defineTool({
        name: "dig_get_tracks",
        title: "Look up specific tracks",
        access: "read",
        description: `Hydrate up to ${HYDRATE_MAX} specific tracks by ID. Each ID is one Spotify request (batch lookups no longer exist), so keep lists short.`,
        inputSchema: {
          type: "object",
          properties: {
            track_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: HYDRATE_MAX,
              description: "Spotify track IDs to fetch.",
            },
            detail: detailProp,
          },
          required: ["track_ids"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const ids = args?.track_ids;
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string" && x.trim() !== "")) {
          throw new ValidationError("**Missing track IDs.** Pass `track_ids` as a list of Spotify track ID strings.");
        }
        if (ids.length > HYDRATE_MAX) {
          throw new ValidationError(
            `**Too many tracks at once.** Spotify removed batch lookups, so each ID costs one request; Dig caps this at ${HYDRATE_MAX} per call. You asked for ${ids.length} — split the list.`,
          );
        }
        const detail = checkDetail(args);
        const tracks = [];
        for (const id of ids) {
          // Deliberately sequential — the queue serializes anyway, and one
          // request per ID is the whole point of the cap.
          const t = await client.request(`/tracks/${encodeURIComponent(id.trim())}`, { budget });
          tracks.push(projectTrack(t, detail));
        }
        return jsonText({ tracks, count: tracks.length });
      },
    },
  ];

  // Wrap every handler once: known failures become isError instructions.
  return tools.map(({ def, handler }) => ({
    def,
    handler: async (args, budget) => {
      try {
        // One wait budget per tool call: the R4 60s cap spans every request
        // this invocation makes, not each request separately.
        return { text: await handler(args, waitBudget()), isError: false };
      } catch (err) {
        if (
          err instanceof ValidationError ||
          err instanceof AuthExpiredError ||
          err instanceof RateLimitError ||
          err instanceof SpotifyApiError
        ) {
          return { text: err.message, isError: true };
        }
        throw err;
      }
    },
  }));
}

function checkDetail(args) {
  const detail = validDetail(args?.detail);
  if (!detail) {
    throw new ValidationError(`**Unknown detail level.** Use one of: ${DETAIL_LEVELS.join(", ")} (compact is the default).`);
  }
  return detail;
}

// Continuation is named exactly; exhaustion is said plainly (R3).
function pageNote(toolName, offset, count, total, extraArg = "") {
  const next = offset + count;
  if (next < total) {
    const argText = [extraArg, `offset=${next}`].filter(Boolean).join(", ");
    return { next_call: `${toolName}(${argText})`, note: `Showing ${offset}-${next - 1} of ${total}. More available — call ${toolName} with ${argText}.` };
  }
  return { next_call: null, note: `Showing ${offset}-${Math.max(offset, next - 1)} of ${total}. That is the end — nothing more to fetch.` };
}
