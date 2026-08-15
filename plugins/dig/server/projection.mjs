// Context discipline (slice C R3): project at the API boundary with
// Spotify's `fields` parameter, compact by default. A raw playlist item is
// hundreds of tokens; compact keeps a track well under 60 tokens so a
// 4,000-track playlist stays tractable (research §6).
//
// February 2026 field names: playlist rows are `items`/`item`, never
// `tracks`/`track` (research §2). The old names are accepted on read as a
// fallback only, because docs pages still show the union of both worlds.

export const DETAIL_LEVELS = ["compact", "standard", "full"];

// `fields` strings for GET /playlists/{id}/items per detail level.
export const FIELDS = {
  compact: "total,limit,offset,items(item(id,name,uri,duration_ms,artists(name)))",
  standard:
    "total,limit,offset,items(added_at,item(id,name,uri,duration_ms,artists(name),album(name,release_date),external_ids(isrc)))",
  full: undefined, // everything Spotify sends — still paginated, never unbounded
};

export function validDetail(detail) {
  return DETAIL_LEVELS.includes(detail ?? "compact") ? (detail ?? "compact") : null;
}

// Rows of a paged container. Feb 2026 renamed the container to `items`; the
// container's row list is also `items`.
export function extractRows(page) {
  return page?.items ?? [];
}

// One playlist row -> one projected track object, or null for a gone/local
// row Spotify returns as null.
export function projectItemRow(row, detail) {
  const t = row?.item ?? row?.track ?? null;
  if (!t) return null;
  const track = projectTrack(t, detail);
  if (detail !== "compact" && row?.added_at) track.added_at = row.added_at;
  return track;
}

// One track object (search result, hydration, or playlist item payload).
export function projectTrack(t, detail = "compact") {
  if (detail === "full") return t;
  const out = {
    id: t.id,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a?.name).filter(Boolean),
    duration_ms: t.duration_ms,
    uri: t.uri,
  };
  if (detail === "standard") {
    if (t.album?.name) out.album = t.album.name;
    if (t.album?.release_date) out.release_date = t.album.release_date;
    if (t.external_ids?.isrc) out.isrc = t.external_ids.isrc;
  }
  return out;
}
