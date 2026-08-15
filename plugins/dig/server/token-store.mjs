// Token lifecycle (research §9, all five rules):
//   - only the refresh token is persisted; access tokens live in memory
//   - absolute expiry timestamps, never "seconds remaining"
//   - file created 0600 atomically from the first byte, permissions
//     self-healed on read
//   - exclusive lock around every read-refresh-write
//   - a rotated refresh token is persisted BEFORE the new access token is used
import {
  chmodSync, mkdirSync, openSync, closeSync, writeSync, fsyncSync, renameSync,
  readFileSync, statSync, unlinkSync, rmSync, utimesSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { log } from "./log.mjs";

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const FIVE_MONTHS_MS = 150 * 24 * 60 * 60 * 1000;
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;

export const EXPIRED_CONNECTION_MESSAGE = `**Your Spotify connection expired.**
Spotify makes every connection expire after six months and yours has hit that mark. Nothing is wrong and nothing was lost.

Reconnect and approve the same screen you saw the first time. Your playlists are untouched.`;

export class AuthExpiredError extends Error {
  constructor() {
    super(EXPIRED_CONNECTION_MESSAGE);
    this.name = "AuthExpiredError";
  }
}

export function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) return null;
  return dir;
}

export function tokenFilePath(dir = dataDir()) {
  return dir ? join(dir, "token.json") : null;
}

// Atomic 0600 write: temp file opened with the final mode from the first
// byte, fsynced, then renamed over the target. A crash mid-write leaves the
// previous file intact (the claude-radio pattern, spotify_playlist.py:85-92).
export function writeFileAtomic0600(file, contents) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

// Exclusive lock via wx-open of a lockfile. Three guarantees the naive
// version lacked: the holder heartbeats the lockfile's mtime so a live hold
// is never "stale"; release only removes a lock this acquisition owns; and
// breaking a stale lock claims it atomically via rename, so two breakers
// cannot both proceed and neither can delete a freshly acquired live lock.
export async function acquireLock(file, { timeoutMs = 5000, staleMs = 30_000 } = {}) {
  const lockPath = `${file}.lock`;
  const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, owner);
      fsyncSync(fd);
      closeSync(fd);
      const beat = setInterval(() => {
        try { const now = new Date(); utimesSync(lockPath, now, now); } catch { /* lock gone */ }
      }, 5000);
      beat.unref();
      return () => {
        clearInterval(beat);
        try {
          if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          // Claim-by-rename: only one breaker wins the rename; a lock that
          // was released-and-reacquired in the window renames a DIFFERENT
          // inode path and the loser just retries.
          const claim = `${lockPath}.stale-${owner.replace(":", "-")}`;
          renameSync(lockPath, claim);
          log(`broke stale lock ${lockPath}`);
          rmSync(claim, { force: true });
          continue;
        }
      } catch { /* raced with release or another breaker */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for lock ${lockPath} — another Dig session may be refreshing; try again in a few seconds`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// Reads the persisted state ({ refresh_token, obtained_at, client_id,
// display_name }), self-healing permissions. Returns null when signed out.
export function readTokenFile(file = tokenFilePath()) {
  if (!file) return null;
  try {
    const st = statSync(file);
    if (st.mode & 0o077) {
      log(`self-healing token file permissions (were ${(st.mode & 0o777).toString(8)})`);
      chmodSync(file, 0o600);
    }
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function tokenAge(record) {
  return record?.obtained_at ? Date.now() - record.obtained_at : null;
}

export function ageWarning(record) {
  const age = tokenAge(record);
  if (age === null) return null;
  if (age > FIVE_MONTHS_MS) {
    const daysLeft = Math.max(0, Math.round((SIX_MONTHS_MS - age) / 86_400_000));
    return `Your Spotify connection is over five months old and expires at six months (about ${daysLeft} days left). Reconnecting now takes one browser approval and avoids an interruption later.`;
  }
  return null;
}

export class TokenStore {
  // fetchImpl is injectable for tests; file defaults to the plugin data dir.
  constructor({ file = tokenFilePath(), fetchImpl = fetch } = {}) {
    this.file = file;
    this.fetch = fetchImpl;
    this.access = null; // { token, expiresAt } — memory only, never persisted
  }

  // Every path that touches the file demands a real path first — with
  // CLAUDE_PLUGIN_DATA unset, `file` is null and naive string-building would
  // write "null.lock"-style litter into the cwd (the banned class).
  ensureFile() {
    if (!this.file) {
      throw new Error("Dig has no data directory (CLAUDE_PLUGIN_DATA is unset), so it cannot store or refresh the Spotify connection. Restart Claude Code; if it persists, reinstall the Dig plugin.");
    }
  }

  persist(record) {
    this.ensureFile();
    writeFileAtomic0600(this.file, JSON.stringify(record, null, 2) + "\n");
  }

  read() {
    return readTokenFile(this.file);
  }

  // The sanctioned 401 path (research §9: a 401 is authoritative regardless
  // of the local clock): drop the in-memory access token so the next
  // getAccessToken() performs a real refresh. Touches nothing on disk.
  invalidateAccess() {
    this.access = null;
  }

  signOut() {
    this.access = null;
    if (!this.file) return;
    try { unlinkSync(this.file); } catch { /* already gone */ }
  }

  // Returns a live access token, refreshing if needed. Rotation rule: the new
  // refresh token is persisted before the returned access token can be used.
  async getAccessToken(clientId) {
    if (this.access && Date.now() < this.access.expiresAt) return this.access.token;
    this.ensureFile();
    const release = await acquireLock(this.file);
    try {
      // A concurrent call on this instance may have refreshed while we waited.
      if (this.access && Date.now() < this.access.expiresAt) return this.access.token;
      // Re-read inside the lock: another server process may have rotated the
      // refresh token while we waited; using our stale copy would kill both.
      const record = this.read();
      if (!record?.refresh_token) throw new AuthExpiredError();
      if (record.client_id && clientId && record.client_id !== clientId) {
        // Token bound to a different app: force a clean re-auth.
        this.signOut();
        throw new AuthExpiredError();
      }
      // Bounded well under the lock's 30s staleness window, so a stalled
      // request can never make a live hold look abandoned.
      const res = await this.fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: record.refresh_token,
          client_id: clientId ?? record.client_id,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.error === "invalid_grant") {
          this.signOut();
          throw new AuthExpiredError();
        }
        throw new Error(`Token refresh failed (${res.status}): ${body?.error || "unknown"}`);
      }
      if (body.refresh_token && body.refresh_token !== record.refresh_token) {
        this.persist({ ...record, refresh_token: body.refresh_token });
      }
      this.access = {
        token: body.access_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000,
      };
      return this.access.token;
    } finally {
      release();
    }
  }
}
