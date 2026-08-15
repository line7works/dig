import { checkClientId } from "./config.mjs";
import { beginSignIn } from "./auth.mjs";
import { dataDir } from "./token-store.mjs";
import { defineTool } from "./tool-def.mjs";

// dig_connect: starts the browser sign-in and returns immediately; the flow
// finishes in the callback request and dig_status reports the outcome.
export const CONNECT_TOOL = defineTool({
  name: "dig_connect",
  title: "Connect to Spotify",
  access: "connect",
  description:
    "Connect Dig to the user's Spotify account: opens the Spotify approval page in their browser and serves the local setup reference page. Returns immediately; call dig_status to see the result.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

export async function digConnect() {
  const id = checkClientId();
  if (id.state !== "ok") return { text: id.message, isError: true };
  if (!dataDir()) {
    return {
      text: "Dig can't store the sign-in: the host didn't provide a data directory (CLAUDE_PLUGIN_DATA is unset). Restart Claude Code and try again; if it persists, reinstall the Dig plugin.",
      isError: true,
    };
  }
  const { authUrl, referenceUrl, opened } = await beginSignIn({ clientId: id.clientId });
  const lines = [
    opened
      ? "A Spotify approval page just opened in the browser."
      : `Open this address in a browser to approve: ${authUrl}`,
    "",
    "Tell the user to approve it with the Spotify account whose playlists Dig should manage, then check dig_status to confirm who connected.",
    `A setup reference page (creating the Spotify app, the exact redirect address, the User Management step) is at: ${referenceUrl}`,
    "The sign-in link expires after 5 minutes; running dig_connect again starts a fresh one.",
  ];
  return { text: lines.join("\n"), isError: false };
}
