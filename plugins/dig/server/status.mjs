import { statSync } from "node:fs";
import { defineTool } from "./tool-def.mjs";
import { checkClientId, resolveUnfollowFlag, CLIENT_ID_MISMATCH_NOTE } from "./config.mjs";
import { readTokenFile, tokenAge, ageWarning } from "./token-store.mjs";
import { activeSignIn } from "./auth.mjs";

// dig_status: the one tool of slice A. Reports Client ID state, auth state
// (always "none" until the auth slice lands), and the plugin data directory.

export const STATUS_TOOL = defineTool({
  name: "dig_status",
  title: "Dig status",
  access: "local",
  description:
    "Report Dig's current state: whether a Spotify Client ID is configured and looks valid, authentication state, and where Dig keeps its data.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

// Names the active config source (slice G2 R4) in user language: "env" is
// the plugin's settings (userConfig substitution / auto-export), "file" is
// Dig's own config file written by dig_set_client_id.
export function describeSource(source) {
  return source === "env" ? "plugin settings" : source === "file" ? "Dig's config file (set in chat)" : "none";
}

// R4 for the unfollow opt-in: deletion's on/off state, where it comes from,
// and any env-vs-file disagreement (R6) — reported, never silently resolved.
export function describeUnfollow() {
  const flag = resolveUnfollowFlag();
  const state = flag.enabled ? "ENABLED" : "disabled";
  const src = flag.source === "none" ? "" : ` Source: ${describeSource(flag.source)}.`;
  const mm = flag.mismatch
    ? "\n⚠ The plugin's settings and Dig's config file DISAGREE about playlist deletion — the plugin settings win while present."
    : "";
  return `Playlist deletion (dig_unfollow_playlist): ${state}.${src}${mm}`;
}

function describeDataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) {
    return "Data directory: not provided by the host (CLAUDE_PLUGIN_DATA is unset). Dig stores nothing yet, so this only matters once you sign in.";
  }
  try {
    const st = statSync(dir);
    const mode = (st.mode & 0o777).toString(8).padStart(4, "0");
    if (!st.isDirectory()) {
      return `Data directory: ${dir} exists but is NOT a directory — Dig cannot store anything until it is removed or replaced with a folder.`;
    }
    return `Data directory: ${dir} (exists, permissions ${mode})`;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return `Data directory: ${dir} (not created yet — Dig creates it when it first has something to store)`;
    }
    return `Data directory: ${dir} (cannot inspect: ${err?.code || err?.message})`;
  }
}

export function digStatus() {
  const id = checkClientId();
  const lines = [];
  if (id.state === "ok") {
    lines.push(`Client ID: configured and looks valid (32 characters). Source: ${describeSource(id.source)}.`);
    if (id.mismatch) lines.push(`⚠ ${CLIENT_ID_MISMATCH_NOTE}`);
  } else {
    lines.push(
      id.state === "invalid"
        ? `Client ID: configured but wrong shape. Source: ${describeSource(id.source)}.`
        : "Client ID: not configured (no plugin setting, nothing in Dig's config file).",
    );
    // An invalid plugin setting can be hiding a perfectly good value the
    // user stored from chat — the one fact a support conversation needs.
    if (id.mismatch) lines.push(`⚠ ${CLIENT_ID_MISMATCH_NOTE}`);
    lines.push("", id.message, "");
  }
  lines.push(describeAuth());
  lines.push(describeUnfollow());
  lines.push(describeDataDir());
  return lines.join("\n");
}

function describeAuth() {
  const record = readTokenFile();
  if (record?.refresh_token) {
    const days = Math.floor((tokenAge(record) ?? 0) / 86_400_000);
    const who = record.display_name ? ` as ${record.display_name}` : "";
    const warn = ageWarning(record);
    return `Spotify connection: signed in${who} (connected ${days === 0 ? "today" : `${days} days ago`}).${warn ? `\n${warn}` : ""}`;
  }
  const flow = activeSignIn();
  if (flow && !flow.result) {
    return "Spotify connection: sign-in in progress — finish approving in your browser, or run dig_connect again to restart.";
  }
  if (flow?.result && !flow.result.ok) {
    return `Spotify connection: last sign-in did not finish.\n\n${flow.result.message}`;
  }
  return "Spotify connection: not signed in. Run dig_connect to sign in through your browser.";
}
