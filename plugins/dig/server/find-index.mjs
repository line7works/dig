// Server-side find index (slice C R2). Spotify cannot search within a
// playlist, so Dig pages the playlist into an index ONCE and answers finds
// locally. Keyed by playlist ID + snapshot_id: any change to the playlist
// changes its snapshot_id, which invalidates and rebuilds the index
// (research §6 — the "search_logs, not read_logs" rule applied literally).
import { FIELDS, projectItemRow, extractRows } from "./projection.mjs";
import { log } from "./log.mjs";

const PAGE_LIMIT = 50;

// Case- and accent-insensitive match text.
export function foldText(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export class FindIndex {
  constructor(client) {
    this.client = client;
    this.cache = new Map(); // playlistId -> { snapshotId, name, tracks }
  }

  // Returns { snapshotId, name, tracks } where tracks carry their playlist
  // position. Rebuilds only when the snapshot_id moved.
  async get(playlistId) {
    const meta = await this.client.request(`/playlists/${encodeURIComponent(playlistId)}`, {
      query: { fields: "snapshot_id,name" },
    });
    const snapshotId = meta?.snapshot_id;
    const cached = this.cache.get(playlistId);
    if (cached && cached.snapshotId === snapshotId) return cached;

    log(`building find index for ${playlistId} (snapshot ${snapshotId})`);
    const tracks = [];
    for (let offset = 0; ; offset += PAGE_LIMIT) {
      const page = await this.client.request(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { query: { fields: FIELDS.compact, limit: PAGE_LIMIT, offset } },
      );
      const rows = extractRows(page);
      for (const row of rows) {
        const t = projectItemRow(row, "compact");
        if (t) tracks.push(t);
      }
      const total = page?.total ?? tracks.length;
      if (rows.length === 0 || offset + PAGE_LIMIT >= total) break;
    }
    // Position is the running order in which rows were paged.
    tracks.forEach((t, i) => { t.position = i; });
    const entry = { snapshotId, name: meta?.name, tracks };
    this.cache.set(playlistId, entry);
    return entry;
  }

  // Substring find over folded title + artist names.
  async find(playlistId, query) {
    const { snapshotId, name, tracks } = await this.get(playlistId);
    const q = foldText(query);
    const matches = tracks.filter(
      (t) => foldText(t.name).includes(q) || (t.artists ?? []).some((a) => foldText(a).includes(q)),
    );
    return { snapshotId, playlistName: name, totalTracks: tracks.length, matches };
  }
}
