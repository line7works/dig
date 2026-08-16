// Dig's own persisted configuration (slice G2). The desktop app never
// delivers plugin userConfig to the server (verified live 2026-08-16), so
// values a user sets from chat persist here — config.json in the plugin data
// directory, 0600 atomic. Resolution contract: env wins when usable; this
// file is the fallback, never the override.
import { readFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dataDir, writeFileAtomic0600 } from "./token-store.mjs";
import { log } from "./log.mjs";

export function configFilePath(dir = dataDir()) {
  return dir ? join(dir, "config.json") : null;
}

// Reads the persisted config ({ spotify_client_id?, dig_enable_unfollow? }),
// self-healing permissions like the token file. Returns null when absent or
// unreadable — a corrupt config file must never stop the server.
export function readConfigFile(file = configFilePath()) {
  if (!file) return null;
  try {
    const st = statSync(file);
    if (st.mode & 0o077) {
      log(`self-healing config file permissions (were ${(st.mode & 0o777).toString(8)})`);
      chmodSync(file, 0o600);
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Merge-writes a patch into the config file (0600, atomic). Throws with a
// plain-language error when the host provided no data directory.
export function writeConfigPatch(patch, file = configFilePath()) {
  if (!file) {
    throw new Error(
      "Dig has no data directory (CLAUDE_PLUGIN_DATA is unset), so it cannot store settings. Restart Claude Code; if it persists, reinstall the Dig plugin.",
    );
  }
  const merged = { ...(readConfigFile(file) ?? {}), ...patch };
  writeFileAtomic0600(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}
