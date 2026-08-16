// Client ID capture and validation. The plugin's userConfig prompt supplies
// SPOTIFY_CLIENT_ID; a blank value must never stop the server from starting.
// Validation lives server-side because the manifest's `required`/`sensitive`
// flags each trip live install bugs and are deliberately omitted.

import { readConfigFile } from "./config-file.mjs";

const CLIENT_ID_SHAPE = /^[a-zA-Z0-9]{32}$/;
export { CLIENT_ID_SHAPE };

export const BAD_CLIENT_ID_MESSAGE = `**That doesn't look like a Client ID.**
A Client ID is 32 characters of letters and numbers. Two things people paste by mistake:

- The **Client Secret**, which sits right underneath and looks almost identical. Dig never needs it. Don't paste it anywhere.
- The **app name** you typed when you created the app.

Open your app on the Spotify dashboard — the value labelled **Client ID** sits at the top of its **Basic Information** page, with a copy button.`;

export const UNCONFIGURED_MESSAGE = `**Dig isn't connected to a Spotify app yet.**
Dig needs the Client ID of your own (free) Spotify developer app. To set it:

1. Paste the Client ID right here in the chat — Claude stores it for you with the dig_set_client_id tool, and it works immediately.
2. If you don't have a Spotify app yet (or that didn't work), ask Claude to walk you through Dig setup.

Nothing else is broken — Dig just doesn't know which app is yours yet.`;

function usable(raw) {
  const v = (raw ?? "").trim();
  // Empty, or an unsubstituted "${user_config...}" placeholder, is no value.
  return v !== "" && !v.startsWith("${") ? v : null;
}

export { usable };

// Resolves the Client ID: env (both names, usable() rules) first, then Dig's
// own config file — the desktop app never delivers userConfig to the server
// (slice G2), so the file is the fallback that path relies on. Env wins when
// usable; a usable-but-different file value is reported as a mismatch by
// status/doctor, never silently resolved.
function resolveClientId() {
  const env =
    usable(process.env.SPOTIFY_CLIENT_ID) ?? usable(process.env.CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID);
  const file = usable(readConfigFile()?.spotify_client_id);
  if (env !== null) {
    return { value: env, source: "env", mismatch: file !== null && file !== env };
  }
  if (file !== null) {
    return { value: file, source: "file", mismatch: false };
  }
  return { value: null, source: "none", mismatch: false };
}

// Returns { state: "unconfigured" | "invalid" | "ok", clientId, message,
// source: "env" | "file" | "none", mismatch }. `raw` bypasses resolution for
// direct validation of a candidate value (source "none").
export function checkClientId(raw) {
  const resolved = raw !== undefined ? { value: usable(raw), source: "none", mismatch: false } : resolveClientId();
  const { value, source, mismatch } = resolved;
  if (value === null) {
    return { state: "unconfigured", clientId: null, message: UNCONFIGURED_MESSAGE, source: "none", mismatch: false };
  }
  if (!CLIENT_ID_SHAPE.test(value)) {
    return { state: "invalid", clientId: null, message: BAD_CLIENT_ID_MESSAGE, source, mismatch };
  }
  return { state: "ok", clientId: value, message: null, source, mismatch };
}

// Resolves the unfollow opt-in the same way (R1): env names first — the
// primary may be blank or an unsubstituted placeholder and must not mask the
// auto-export fallback — then Dig's config file. Returns { enabled, source }.
export function resolveUnfollowFlag() {
  const env =
    usable(process.env.DIG_ENABLE_UNFOLLOW) ?? usable(process.env.CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW);
  const file = usable(readConfigFile()?.dig_enable_unfollow);
  const raw = env ?? file;
  return {
    enabled: raw !== null && /^(1|true|yes)$/i.test(raw),
    source: env !== null ? "env" : file !== null ? "file" : "none",
  };
}
