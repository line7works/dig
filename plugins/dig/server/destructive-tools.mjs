// Destructive operations (slice F): removal that cannot fire by accident,
// cannot wipe a playlist, and can always be rolled back from a local
// snapshot. The rules:
//   - two-step: dig_plan_removal (read-only, mints an expiring single-use
//     token bound to the connected app + a digest of the exact track list)
//     -> dig_apply_removal (validates token + digest, executes against the
//     captured snapshot_id; a changed playlist fails Spotify's own
//     validation and the answer is re-plan) (R1)
//   - dig_apply_removal carries _meta["anthropic/requiresUserInteraction"]
//     so the host prompts even under bypass-permissions modes (R2)
//   - a full track-list snapshot is written to the plugin data directory
//     before EVERY destructive write, and dig_restore_snapshot rebuilds a
//     playlist from one; snapshot files are named so a user can pick (R3)
//   - an empty plan is refused, and so is a plan that would remove every
//     track — no code path empties a playlist, and no replace-all tool
//     exists (R4)
//   - dedupe is remove-all-then-re-add ONLY, with the moved-to-end
//     consequence disclosed in the plan BEFORE approval (R5)
//   - dig_unfollow_playlist ships disabled by default (opt-in) since for
//     the owner it is deletion; actual deletion is DELETE /me/library (R6)
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "./tool-def.mjs";
import { spotify } from "./spotify-client.mjs";
import { FindIndex } from "./find-index.mjs";
import { RateLimitError, SpotifyApiError } from "./error-map.mjs";
import { AuthExpiredError, dataDir, writeFileAtomic0600 } from "./token-store.mjs";
import { ValidationError, requireString, wrapTools } from "./read-tools.mjs";
import { checkClientId } from "./config.mjs";
import { log } from "./log.mjs";

const TOKEN_TTL_MS = 15 * 60 * 1000; // a plan the user hasn't approved in 15 minutes is stale
const MAX_REMOVE = 100; // one DELETE request carries at most 100 items
const SAMPLE_MAX = 10; // R1: the plan shows at most a ten-track sample
const RESTORE_BATCH = 100; // replace/append requests carry at most 100 uris

export const MOVES_TO_END_DISCLOSURE =
  "Spotify can no longer remove a single copy of a duplicated track, so Dig removes ALL copies and re-adds one — the kept copy MOVES TO THE END of the playlist. Its original position cannot be preserved. Say this to the user before they approve.";

// ---------- snapshot files (R3) ----------

export function snapshotsDir(dir = dataDir()) {
  return dir ? join(dir, "snapshots") : null;
}

function slug(s) {
  return (
    String(s ?? "")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .toLowerCase() || "playlist"
  );
}

function requireSnapshotsDir() {
  const dir = snapshotsDir();
  if (!dir) {
    throw new ValidationError(
      "Dig has no data directory (CLAUDE_PLUGIN_DATA is unset), so it cannot write the safety snapshot a destructive change requires. Restart Claude Code; if it persists, reinstall the Dig plugin. Nothing was changed.",
    );
  }
  return dir;
}

// Writes the full track list (raw positions; unavailable/local rows recorded
// so counts stay honest) 0600-atomic into the data dir. State files get the
// token-file treatment (slice-B pattern). Returns the snapshot's file name.
export function writeSnapshot({ playlistId, playlistName, snapshotId, indexEntry, reason }) {
  const dir = requireSnapshotsDir();
  const takenAt = new Date().toISOString();
  const name = `${takenAt.replace(/[:.]/g, "-")}-${slug(playlistName)}-${playlistId}.json`;
  const byPosition = new Map(indexEntry.tracks.map((t) => [t.position, t]));
  const rows = [];
  for (let i = 0; i < indexEntry.totalRows; i++) {
    const t = byPosition.get(i);
    rows.push(t ? { position: i, id: t.id, uri: t.uri, name: t.name, artists: t.artists, duration_ms: t.duration_ms } : { position: i, unavailable: true });
  }
  const contents = {
    playlist_id: playlistId,
    playlist_name: playlistName,
    snapshot_id: snapshotId,
    taken_at: takenAt,
    reason,
    total_rows: indexEntry.totalRows,
    tracks: rows,
  };
  writeFileAtomic0600(join(dir, name), JSON.stringify(contents, null, 1) + "\n");
  log(`snapshot written: ${name}`);
  return name;
}

export function listSnapshots() {
  const dir = requireSnapshotsDir();
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.sort().reverse().map((file) => {
    try {
      const s = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return { snapshot: file, playlist: s.playlist_name, playlist_id: s.playlist_id, taken_at: s.taken_at, tracks: s.total_rows, reason: s.reason };
    } catch {
      return { snapshot: file, note: "unreadable snapshot file" };
    }
  });
}

function readSnapshot(name) {
  const dir = requireSnapshotsDir();
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) {
    throw new ValidationError("**That doesn't look like a snapshot name.** Call dig_restore_snapshot with no arguments to list the snapshots Dig has saved, then pass one of those names.");
  }
  let raw;
  try {
    raw = readFileSync(join(dir, name), "utf8");
  } catch {
    throw new ValidationError(`**No snapshot named \`${name}\`.** Call dig_restore_snapshot with no arguments to list the snapshots Dig has saved.`);
  }
  return JSON.parse(raw);
}

// ---------- the plan-token registry (R1) ----------
// In-memory and single-use: a plan lives only in the server process that
// minted it, expires after TOKEN_TTL_MS, and is consumed by the first apply
// attempt — success or failure, the next apply needs a fresh plan.

function digestOf(playlistId, snapshotId, uris) {
  return createHash("sha256").update(JSON.stringify({ playlistId, snapshotId, uris })).digest("hex");
}

export class PlanRegistry {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.plans = new Map(); // token -> record
  }

  mint(record) {
    const token = randomBytes(16).toString("hex");
    this.plans.set(token, { ...record, expiresAt: this.now() + TOKEN_TTL_MS });
    return token;
  }

  // Validates and CONSUMES the token: expiry, binding to the connected app
  // (the "user" a local plan can be bound to), and digest of the exact list.
  take(token, clientId) {
    const record = typeof token === "string" ? this.plans.get(token) : undefined;
    if (record) this.plans.delete(token);
    if (!record || this.now() > record.expiresAt) {
      throw new ValidationError(
        "**That removal plan is no longer valid.** Plans expire after 15 minutes and are single-use, and they don't survive a restart. Nothing was changed — run the plan step again and show the user the fresh plan.",
      );
    }
    if (record.clientId !== clientId) {
      throw new ValidationError(
        "**That plan belongs to a different Spotify connection.** The connected app changed since the plan was made. Nothing was changed — re-plan from the current connection.",
      );
    }
    if (digestOf(record.playlistId, record.snapshotId, record.uris) !== record.digest) {
      throw new ValidationError(
        "**The plan's track list failed its integrity check.** Nothing was changed — run the plan step again.",
      );
    }
    return record;
  }
}

// ---------- helpers ----------

function jsonText(obj) {
  return JSON.stringify(obj, null, 1);
}

function requireOkClientId() {
  const id = checkClientId();
  if (id.state !== "ok") throw new ValidationError(id.message);
  return id.clientId;
}

const trackLabel = (t) => `${t.name} — ${(t.artists ?? []).join(", ")}`;

// Spotify signals a stale snapshot_id / concurrent edit as a client error on
// the items endpoint (same seam slice E used for reorder).
function isConcurrentEditError(err) {
  return err instanceof SpotifyApiError && (err.status === 400 || err.status === 409) && /\/items$/.test(err.endpoint ?? "");
}

const DEFINITE = (err) => err instanceof SpotifyApiError || err instanceof RateLimitError || err instanceof AuthExpiredError;

export function createDestructiveTools({ client = spotify, index, registry, enableUnfollow, now = Date.now } = {}) {
  const findIndex = index ?? new FindIndex(client);
  const plans = registry ?? new PlanRegistry({ now });
  const unfollowEnabled =
    enableUnfollow ?? /^(1|true|yes)$/i.test(process.env.DIG_ENABLE_UNFOLLOW ?? process.env.CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW ?? "");

  // Fresh read of the playlist (index rebuilds when snapshot_id moved).
  async function readPlaylist(playlistId, budget) {
    return findIndex.get(playlistId, budget);
  }

  const tools = [
    {
      def: defineTool({
        name: "dig_plan_removal",
        title: "Plan a track removal",
        access: "read",
        description:
          "Step 1 of 2 for removing tracks. READ-ONLY: builds a removal plan (count, sample, one-sentence summary) and returns an expiring single-use removal_token. Nothing is removed until the user approves the plan and dig_apply_removal is called. Pass track_ids to remove specific tracks (ALL copies of each are removed — Spotify dropped positional removal), or mode:\"duplicates\" to plan a dedupe (remove all copies, re-add one; the kept copy moves to the END).",
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            track_ids: {
              type: "array",
              items: { type: "string" },
              description: "Spotify track IDs (or spotify:track: URIs) to remove. All copies of each are removed.",
            },
            mode: { type: "string", enum: ["duplicates"], description: 'Pass "duplicates" to plan a dedupe instead of listing tracks.' },
          },
          required: ["playlist_id"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const playlistId = requireString(args, "playlist_id", "a playlist ID");
        const clientId = requireOkClientId();
        const wantsDedupe = args?.mode === "duplicates";
        const ids = args?.track_ids;
        if (!wantsDedupe && (!Array.isArray(ids) || ids.length === 0)) {
          // R4: an empty plan is refused — there is nothing a zero-track
          // removal legitimately does.
          throw new ValidationError('**Nothing to remove.** Pass `track_ids` (the tracks to remove), or `mode:"duplicates"` to plan a dedupe. Dig refuses empty removal plans.');
        }
        if (wantsDedupe && Array.isArray(ids) && ids.length > 0) {
          throw new ValidationError('**Pick one.** Pass either `track_ids` or `mode:"duplicates"`, not both.');
        }

        const entry = await readPlaylist(playlistId, budget);
        const byUri = new Map();
        for (const t of entry.tracks) {
          const list = byUri.get(t.uri) ?? [];
          list.push(t);
          byUri.set(t.uri, list);
        }

        let removals; // [{uri, occurrences: [tracks]}]
        let readdUris = [];
        if (wantsDedupe) {
          removals = [...byUri.entries()].filter(([, occ]) => occ.length > 1).map(([uri, occ]) => ({ uri, occurrences: occ }));
          if (removals.length === 0) {
            return jsonText({ result: "no_plan", note: "No duplicates found — every track appears once. Nothing to remove." });
          }
          readdUris = removals.map((r) => r.uri);
        } else {
          const missing = [];
          const seen = new Set();
          removals = [];
          for (const rawId of ids) {
            if (typeof rawId !== "string" || rawId.trim() === "") {
              throw new ValidationError("**Bad track_ids entry.** Every entry must be a Spotify track ID or spotify:track: URI.");
            }
            const uri = rawId.startsWith("spotify:") ? rawId : `spotify:track:${rawId}`;
            if (seen.has(uri)) continue;
            seen.add(uri);
            const occ = byUri.get(uri);
            if (occ) removals.push({ uri, occurrences: occ });
            else missing.push(rawId);
          }
          if (missing.length > 0) {
            throw new ValidationError(
              `**Some of those tracks aren't in the playlist:** ${missing.join(", ")}. Removal plans only cover tracks actually present — re-read the playlist (dig_find_in_playlist) and re-plan.`,
            );
          }
          if (removals.length === 0) {
            throw new ValidationError("**Nothing to remove.** None of the requested tracks are in the playlist. Dig refuses empty removal plans.");
          }
        }

        if (removals.length > MAX_REMOVE) {
          throw new ValidationError(
            `**Too many tracks in one plan.** One removal carries at most ${MAX_REMOVE} distinct tracks; this plan has ${removals.length}. Split it into smaller removals.`,
          );
        }
        const rowsRemoved = removals.reduce((sum, r) => sum + r.occurrences.length, 0);
        const rowsKept = entry.totalRows - rowsRemoved + readdUris.length;
        if (rowsKept === 0) {
          // R4: no code path empties a playlist.
          throw new ValidationError(
            "**This plan would empty the playlist, so Dig refuses it.** Removing every track is not something Dig will do in one action — Spotify has no undo for removed tracks. If the user truly wants the playlist gone, that is deleting (unfollowing) it, which is a separate, off-by-default operation.",
          );
        }

        const uris = removals.map((r) => r.uri);
        const sample = removals.slice(0, SAMPLE_MAX).map((r) => {
          const t = r.occurrences[0];
          return { track: trackLabel(t), id: t.id, copies: r.occurrences.length, positions: r.occurrences.map((o) => o.position) };
        });
        const summary = wantsDedupe
          ? `Remove ${rowsRemoved} duplicate copies across ${removals.length} track(s) from "${entry.name}" and re-add one copy of each at the end`
          : `Remove ${removals.length} track(s) (${rowsRemoved} row(s) — all copies of each) from "${entry.name}"`;

        const token = plans.mint({
          kind: wantsDedupe ? "dedupe" : "removal",
          playlistId,
          playlistName: entry.name,
          snapshotId: entry.snapshotId,
          uris,
          readdUris,
          rowsRemoved,
          digest: digestOf(playlistId, entry.snapshotId, uris),
          clientId,
          summary,
        });

        const multiCopy = !wantsDedupe && removals.some((r) => r.occurrences.length > 1);
        return jsonText({
          plan: {
            playlist: entry.name,
            playlist_id: playlistId,
            snapshot_id: entry.snapshotId,
            tracks_to_remove: removals.length,
            rows_removed: rowsRemoved,
            ...(wantsDedupe ? { re_added_at_end: readdUris.length } : {}),
            sample,
            summary,
          },
          removal_token: token,
          expires_in_minutes: TOKEN_TTL_MS / 60000,
          ...(wantsDedupe ? { disclosure: MOVES_TO_END_DISCLOSURE } : {}),
          ...(multiCopy ? { note: "Some of these tracks appear more than once; removal takes ALL copies (Spotify dropped positional removal). Say so before the user approves." } : {}),
          next: "Show this plan to the user. Only after they approve, call dig_apply_removal with the removal_token and the summary sentence. Nothing has been removed yet.",
        });
      },
    },
    {
      def: defineTool({
        name: "dig_apply_removal",
        title: "Apply an approved removal plan",
        access: "destructive",
        meta: { "anthropic/requiresUserInteraction": true },
        description:
          "Step 2 of 2: executes a removal plan from dig_plan_removal AFTER the user has approved it. Validates the plan token, saves a full snapshot of the playlist to disk first (restorable with dig_restore_snapshot), then removes against the plan's captured snapshot_id — if the playlist changed since planning, nothing is removed and the answer is to re-plan. Verified by re-read.",
        inputSchema: {
          type: "object",
          properties: {
            removal_token: { type: "string", description: "The token from dig_plan_removal." },
            summary: { type: "string", description: "The plan's one-sentence summary, so the approval prompt reads as a human sentence." },
          },
          required: ["removal_token", "summary"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        requireString(args, "removal_token", "the removal token from dig_plan_removal");
        requireString(args, "summary", "the plan's summary sentence");
        const clientId = requireOkClientId();
        const plan = plans.take(args.removal_token, clientId);

        // R3: full snapshot BEFORE the destructive write. The plan's captured
        // list is authoritative for what the write applies to — the DELETE
        // below succeeds only if the playlist still matches plan.snapshotId —
        // but snapshot from a FRESH read so the file reflects reality even
        // when the apply then fails with re-plan.
        const before = await readPlaylist(plan.playlistId, budget);
        const snapshotFile = writeSnapshot({
          playlistId: plan.playlistId,
          playlistName: before.name,
          snapshotId: before.snapshotId,
          indexEntry: before,
          reason: plan.summary,
        });

        // Execute against the CAPTURED snapshot: Spotify's own validation
        // fails if the playlist changed underneath (R1).
        try {
          await client.request(`/playlists/${encodeURIComponent(plan.playlistId)}/items`, {
            method: "DELETE",
            body: { items: plan.uris.map((uri) => ({ uri })), snapshot_id: plan.snapshotId },
            budget,
          });
        } catch (err) {
          if (isConcurrentEditError(err)) {
            return jsonText({
              result: "no_write",
              snapshot: snapshotFile,
              note: "The playlist changed after this plan was made (likely an edit from the Spotify app), so Spotify rejected the removal and NOTHING was removed. Re-plan from the playlist's current state with dig_plan_removal.",
            });
          }
          // Definite failure (mapped API error / rate limit / expired auth):
          // Spotify rejected or never received the write — nothing landed,
          // surface the instruction (the slice-E rethrow doctrine).
          if (DEFINITE(err)) throw err;
          // Unknown outcome (timeout / network drop): never blind-retry —
          // fall through to the re-read to see whether it landed.
        }

        // Verify by re-read: none of the removed uris may remain (R3 of
        // slice E, applied to removal).
        const after = await readPlaylist(plan.playlistId, budget);
        const remaining = new Set(after.tracks.map((t) => t.uri));
        const stillThere = plan.uris.filter((u) => remaining.has(u));
        const removedOk = stillThere.length === 0;

        if (plan.kind === "dedupe" && removedOk) {
          // Re-add one copy of each (appends at the end — disclosed in the
          // plan). A failure here leaves partial state: report it honestly.
          try {
            await client.request(`/playlists/${encodeURIComponent(plan.playlistId)}/items`, {
              method: "POST",
              body: { uris: plan.readdUris },
              budget,
            });
          } catch (err) {
            const cause = DEFINITE(err) ? err.message : `The re-add's outcome could not be confirmed (${err?.message ?? err}).`;
            return jsonText({
              result: "partial",
              snapshot: snapshotFile,
              note: `Dedupe stopped midway: the duplicate copies were removed, but re-adding the kept copies did not complete. ${cause}\n\nThe playlist is missing those tracks right now. Re-read it, then either re-add the missing tracks with dig_add_tracks or restore the pre-change state with dig_restore_snapshot("${snapshotFile}").`,
            });
          }
          const final = await readPlaylist(plan.playlistId, budget);
          const finalUris = new Set(final.tracks.map((t) => t.uri));
          const readdMissing = plan.readdUris.filter((u) => !finalUris.has(u));
          const result = readdMissing.length === 0 ? "verified" : "partial";
          return jsonText({
            result,
            snapshot: snapshotFile,
            rows_removed: plan.rowsRemoved,
            re_added: plan.readdUris.length - readdMissing.length,
            note:
              result === "verified"
                ? `Dedupe confirmed by re-read: duplicates removed, ${plan.readdUris.length} kept copies re-added at the end. The pre-change state is saved as snapshot "${snapshotFile}".`
                : `Dedupe is incomplete: ${readdMissing.length} kept cop(ies) did not re-add. Re-read the playlist and add what is truly missing, or restore snapshot "${snapshotFile}".`,
          });
        }

        const result = removedOk ? "verified" : stillThere.length < plan.uris.length ? "partial" : "ambiguous";
        return jsonText({
          result,
          snapshot: snapshotFile,
          removed: removedOk ? plan.uris.length : plan.uris.length - stillThere.length,
          ...(removedOk ? {} : { still_present: stillThere }),
          note:
            result === "verified"
              ? `Removal confirmed by re-read: ${plan.uris.length} track(s) gone. The pre-change state is saved as snapshot "${snapshotFile}" (dig_restore_snapshot can rebuild it).`
              : result === "partial"
                ? `Spotify answered, but the re-read still shows ${stillThere.length} of the planned track(s). Do NOT retry blindly — this can be Spotify's track-relinking quirk (a removal that returns success and removes nothing). Re-read, then re-plan for what actually remains.`
                : "Spotify's answer could not be confirmed by re-read — nothing appears removed. Do NOT retry blindly; this may be Spotify's track-relinking quirk. Re-plan from the current state.",
        });
      },
    },
    {
      def: defineTool({
        name: "dig_restore_snapshot",
        title: "Restore a playlist from a snapshot",
        access: "destructive",
        meta: { "anthropic/requiresUserInteraction": true },
        description:
          "Rebuild a playlist from a snapshot Dig saved before a destructive change. Two-step like removal: call with no arguments to list saved snapshots; call with snapshot to get a restore preview + expiring restore_token; call with restore_token (after the user approves) to execute. The current state is snapshotted first, so a restore is itself undoable. Restoring REPLACES the playlist's contents with the snapshot's track list.",
        inputSchema: {
          type: "object",
          properties: {
            snapshot: { type: "string", description: "A snapshot file name from the listing. Returns a preview + restore_token; nothing is changed." },
            restore_token: { type: "string", description: "The token from the preview step. Executes the restore." },
          },
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const clientId = requireOkClientId();

        // Mode 3: execute an approved restore.
        if (typeof args?.restore_token === "string") {
          const plan = plans.take(args.restore_token, clientId);
          // R3: snapshot the CURRENT state before this destructive write too.
          const current = await readPlaylist(plan.playlistId, budget);
          const preRestore = writeSnapshot({
            playlistId: plan.playlistId,
            playlistName: current.name,
            snapshotId: current.snapshotId,
            indexEntry: current,
            reason: `state before restoring "${plan.sourceSnapshot}"`,
          });
          // Rebuild: PUT replaces with the first batch (never an empty list —
          // the preview step refused empty snapshots), then POST appends the
          // rest in order.
          const uris = plan.uris;
          let batchesDone = 0;
          try {
            await client.request(`/playlists/${encodeURIComponent(plan.playlistId)}/items`, {
              method: "PUT",
              body: { uris: uris.slice(0, RESTORE_BATCH) },
              budget,
            });
            batchesDone++;
            for (let i = RESTORE_BATCH; i < uris.length; i += RESTORE_BATCH) {
              await client.request(`/playlists/${encodeURIComponent(plan.playlistId)}/items`, {
                method: "POST",
                body: { uris: uris.slice(i, i + RESTORE_BATCH) },
                budget,
              });
              batchesDone++;
            }
          } catch (err) {
            if (DEFINITE(err) && batchesDone === 0) throw err;
            const cause = DEFINITE(err) ? err.message : `The last request's outcome could not be confirmed (${err?.message ?? err}).`;
            return jsonText({
              result: batchesDone > 0 ? "partial" : "ambiguous",
              pre_restore_snapshot: preRestore,
              note: `Restore stopped early after ${batchesDone} of ${Math.ceil(uris.length / RESTORE_BATCH)} request(s) — the playlist is in an INTERMEDIATE state. ${cause}\n\nRe-read the playlist, then either retry the restore from a fresh preview or restore "${preRestore}" to get back to where it was.`,
            });
          }
          // Verify by re-read: the uri sequence must match the snapshot's.
          const after = await readPlaylist(plan.playlistId, budget);
          const afterUris = after.tracks.map((t) => t.uri);
          const matches = uris.length === afterUris.length && uris.every((u, i) => afterUris[i] === u);
          return jsonText({
            result: matches ? "verified" : "ambiguous",
            restored_tracks: uris.length,
            pre_restore_snapshot: preRestore,
            note: matches
              ? `Restore confirmed by re-read: ${uris.length} tracks in the snapshot's order. The replaced state was saved as "${preRestore}".`
              : `The re-read does not match the snapshot's track list exactly. Do not retry blindly — re-read the playlist (dig_list_playlist_tracks) and compare; the replaced state is saved as "${preRestore}".`,
          });
        }

        // Mode 2: preview a restore of one snapshot.
        if (typeof args?.snapshot === "string") {
          const s = readSnapshot(args.snapshot);
          const uris = (s.tracks ?? []).filter((t) => t && !t.unavailable && typeof t.uri === "string").map((t) => t.uri);
          if (uris.length === 0) {
            throw new ValidationError("**That snapshot holds no restorable tracks**, and Dig never writes an empty playlist. Pick another snapshot.");
          }
          const unavailable = (s.tracks ?? []).length - uris.length;
          const summary = `Restore "${s.playlist_name}" to its ${uris.length}-track state from ${s.taken_at}`;
          const token = plans.mint({
            kind: "restore",
            playlistId: s.playlist_id,
            snapshotId: s.snapshot_id,
            uris,
            readdUris: [],
            rowsRemoved: 0,
            digest: digestOf(s.playlist_id, s.snapshot_id, uris),
            clientId,
            summary,
            sourceSnapshot: args.snapshot,
          });
          return jsonText({
            plan: {
              playlist: s.playlist_name,
              playlist_id: s.playlist_id,
              taken_at: s.taken_at,
              tracks_restored: uris.length,
              ...(unavailable > 0 ? { unavailable_rows_lost: unavailable } : {}),
              sample: (s.tracks ?? []).filter((t) => t && !t.unavailable).slice(0, SAMPLE_MAX).map((t) => ({ track: `${t.name} — ${(t.artists ?? []).join(", ")}`, position: t.position })),
              summary,
            },
            restore_token: token,
            expires_in_minutes: TOKEN_TTL_MS / 60000,
            warning: "Restoring REPLACES the playlist's current contents with this list. The current state will be snapshotted first, so this is undoable." + (unavailable > 0 ? ` ${unavailable} row(s) in the snapshot were unavailable/local tracks and cannot be restored.` : ""),
            next: "Show this to the user. Only after they approve, call dig_restore_snapshot with the restore_token.",
          });
        }

        // Mode 1: list what can be restored.
        const snapshots = listSnapshots();
        return jsonText({
          snapshots,
          note:
            snapshots.length === 0
              ? "No snapshots saved yet. Dig writes one automatically before every destructive change."
              : "Pass one of these snapshot names to dig_restore_snapshot to preview a restore.",
        });
      },
    },
  ];

  if (unfollowEnabled) {
    tools.push({
      def: defineTool({
        name: "dig_unfollow_playlist",
        title: "Unfollow (delete) a playlist",
        access: "destructive",
        meta: { "anthropic/requiresUserInteraction": true },
        description:
          "Unfollow a playlist — for a playlist the user OWNS this is deletion. Off by default; enabled by explicit opt-in. Two-step: call without confirm_token for a preview + token; call with confirm_token (after the user approves) to execute. A full snapshot is saved first.",
        inputSchema: {
          type: "object",
          properties: {
            playlist_id: { type: "string", description: "The playlist's Spotify ID." },
            confirm_token: { type: "string", description: "The token from the preview step. Executes the unfollow." },
          },
          required: ["playlist_id"],
          additionalProperties: false,
        },
      }),
      handler: async (args, budget) => {
        const playlistId = requireString(args, "playlist_id", "a playlist ID");
        const clientId = requireOkClientId();
        const playlistUri = `spotify:playlist:${playlistId}`;

        if (typeof args?.confirm_token !== "string") {
          const entry = await readPlaylist(playlistId, budget);
          const summary = `Unfollow (delete) the playlist "${entry.name}" (${entry.totalRows} tracks)`;
          const token = plans.mint({
            kind: "unfollow",
            playlistId,
            playlistName: entry.name,
            snapshotId: entry.snapshotId,
            uris: [playlistUri],
            readdUris: [],
            rowsRemoved: 0,
            digest: digestOf(playlistId, entry.snapshotId, [playlistUri]),
            clientId,
            summary,
          });
          return jsonText({
            plan: { playlist: entry.name, playlist_id: playlistId, tracks: entry.totalRows, summary },
            confirm_token: token,
            expires_in_minutes: TOKEN_TTL_MS / 60000,
            warning: "For a playlist the user owns, unfollowing IS deletion. Spotify can recover a deleted playlist for about 90 days; Dig also saves a track-list snapshot first, restorable into a new playlist. Nothing has happened yet.",
            next: "Show this to the user. Only after they approve, call again with the confirm_token.",
          });
        }

        const plan = plans.take(args.confirm_token, clientId);
        if (plan.playlistId !== playlistId) {
          throw new ValidationError("**That token was minted for a different playlist.** Nothing was changed — run the preview step again.");
        }
        // R3: snapshot before the destructive write.
        const before = await readPlaylist(playlistId, budget);
        const snapshotFile = writeSnapshot({
          playlistId,
          playlistName: before.name,
          snapshotId: before.snapshotId,
          indexEntry: before,
          reason: plan.summary,
        });
        await client.request("/me/library", { method: "DELETE", body: { uris: [playlistUri] }, budget });
        // Verify by re-read: the playlist must be gone from the user's list.
        let present = false;
        let checkedAll = true;
        for (let offset = 0; offset < 200; offset += 50) {
          const page = await client.request("/me/playlists", { query: { limit: 50, offset }, budget });
          const rows = page?.items ?? [];
          if (rows.some((p) => p?.id === playlistId)) { present = true; break; }
          const total = page?.total ?? rows.length;
          if (offset + 50 >= total) break;
          if (offset + 50 >= 200 && total > 200) checkedAll = false;
        }
        const result = present ? "ambiguous" : checkedAll ? "verified" : "accepted";
        return jsonText({
          result,
          snapshot: snapshotFile,
          note: present
            ? "The playlist still appears in the user's library — the unfollow may not have landed. Do not retry blindly; re-read and re-plan."
            : `Unfollowed. Snapshot "${snapshotFile}" holds its track list; Spotify itself can also recover a deleted playlist for about 90 days at spotify.com/account.` + (checkedAll ? "" : " (Verification checked the first 200 playlists.)"),
        });
      },
    });
  }

  return wrapTools(tools);
}
