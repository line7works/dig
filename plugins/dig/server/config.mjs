// Client ID capture and validation. The plugin's userConfig prompt supplies
// SPOTIFY_CLIENT_ID; a blank value must never stop the server from starting.
// Validation lives server-side because the manifest's `required`/`sensitive`
// flags each trip live install bugs and are deliberately omitted.

const CLIENT_ID_SHAPE = /^[a-zA-Z0-9]{32}$/;

export const BAD_CLIENT_ID_MESSAGE = `**That doesn't look like a Client ID.**
A Client ID is 32 characters of letters and numbers. Two things people paste by mistake:

- The **Client Secret**, which sits right underneath and looks almost identical. Dig never needs it. Don't paste it anywhere.
- The **app name** you typed when you created the app.

Open your app on the Spotify dashboard, click **Settings**, and copy the value labelled **Client ID**.`;

export const UNCONFIGURED_MESSAGE = `**Dig isn't connected to a Spotify app yet.**
Dig needs the Client ID of your own (free) Spotify developer app. To set it:

1. Run \`/plugin\` in the Claude Code terminal, find Dig, and open its settings to paste your Client ID — or reinstall Dig and fill in the prompt.
2. If you don't have a Spotify app yet, ask Claude to walk you through Dig setup.

Nothing else is broken — Dig just doesn't know which app is yours yet.`;

// Returns { state: "unconfigured" | "invalid" | "ok", clientId, message }.
export function checkClientId(
  raw = process.env.SPOTIFY_CLIENT_ID ?? process.env.CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID,
) {
  const value = (raw ?? "").trim();
  if (value === "" || value.startsWith("${")) {
    // Empty, or an unsubstituted "${user_config...}" placeholder.
    return { state: "unconfigured", clientId: null, message: UNCONFIGURED_MESSAGE };
  }
  if (!CLIENT_ID_SHAPE.test(value)) {
    return { state: "invalid", clientId: null, message: BAD_CLIENT_ID_MESSAGE };
  }
  return { state: "ok", clientId: value, message: null };
}
