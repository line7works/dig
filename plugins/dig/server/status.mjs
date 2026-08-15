import { statSync } from "node:fs";
import { checkClientId } from "./config.mjs";

// dig_status: the one tool of slice A. Reports Client ID state, auth state
// (always "none" until the auth slice lands), and the plugin data directory.

export const STATUS_TOOL = {
  name: "dig_status",
  description:
    "Report Dig's current state: whether a Spotify Client ID is configured and looks valid, authentication state, and where Dig keeps its data.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Dig status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function describeDataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) {
    return "Data directory: not provided by the host (CLAUDE_PLUGIN_DATA is unset). Dig stores nothing yet, so this only matters once you sign in.";
  }
  try {
    const st = statSync(dir);
    const mode = (st.mode & 0o777).toString(8).padStart(4, "0");
    return `Data directory: ${dir} (exists, permissions ${mode})`;
  } catch {
    return `Data directory: ${dir} (not created yet — Dig creates it when it first has something to store)`;
  }
}

export function digStatus() {
  const id = checkClientId();
  const lines = [];
  if (id.state === "ok") {
    lines.push("Client ID: configured and looks valid (32 characters).");
  } else {
    lines.push(id.state === "invalid" ? "Client ID: configured but wrong shape." : "Client ID: not configured.");
    lines.push("", id.message, "");
  }
  lines.push("Spotify connection: not signed in yet (sign-in arrives in a later Dig version).");
  lines.push(describeDataDir());
  return lines.join("\n");
}
