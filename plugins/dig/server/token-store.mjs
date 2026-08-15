// Token lifecycle (research §9, all five rules):
//   - only the refresh token is persisted; access tokens live in memory
//   - absolute expiry timestamps, never "seconds remaining"
//   - file created 0600 atomically from the first byte, permissions
//     self-healed on read
//   - exclusive lock around every read-refresh-write
//   - a rotated refresh token is persisted BEFORE the new access token is used
import {
  chmodSync, mkdirSync, openSync, closeSync, writeSync, fsyncSync, renameSync,
  readFileSync, statSync, unlinkSync, rmSync,
} from "node:fs";
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

// Exclusive lock via wx-open of a lockfile. Stale locks (holder crashed) are
// broken after 30s. Returns a release function.
export async function acquireLock(file, { timeoutMs = 5000, staleMs = 30_000 } = {}) {
  const lockPath = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try { unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          log(`breaking stale lock ${lockPath}`);
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* raced with release */ }
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for lock ${lockPath}`);
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

  persist(record) {
    writeFileAtomic0600(this.file, JSON.stringify(record, null, 2) + "\n");
  }

  read() {
    return readTokenFile(this.file);
  }

  signOut() {
    this.access = null;
    try { unlinkSync(this.file); } catch { /* already gone */ }
  }

  // Returns a live access token, refreshing if needed. Rotation rule: the new
  // refresh token is persisted before the returned access token can be used.
  async getAccessToken(clientId) {
    if (this.access && Date.now() < this.access.expiresAt) return this.access.token;
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
      const res = await this.fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: record.refresh_token,
          client_id: clientId ?? record.client_id,
        }),
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
