// Chat-first configuration tools (slice G2). The desktop app never delivers
// plugin userConfig to the server, so these persist settings into Dig's own
// config file — effective immediately in the same session, because every
// consumer resolves configuration per call through config.mjs.
import { defineTool } from "./tool-def.mjs";
import { checkClientId, resolveUnfollowFlag, usable, BAD_CLIENT_ID_MESSAGE } from "./config.mjs";
import { writeConfigPatch } from "./config-file.mjs";

export const SET_CLIENT_ID_TOOL = defineTool({
  name: "dig_set_client_id",
  title: "Set Spotify Client ID",
  access: "configure",
  description:
    "Store the user's Spotify app Client ID for Dig. Takes effect immediately in this chat — no restart needed. Use when the user pastes their Client ID in chat. Never accepts a Client Secret.",
  inputSchema: {
    type: "object",
    properties: {
      client_id: {
        type: "string",
        description: "The Client ID from the app's Basic Information page on the Spotify developer dashboard — 32 letters and numbers.",
      },
    },
    required: ["client_id"],
    additionalProperties: false,
  },
});

export const ENABLE_DELETION_TOOL = defineTool({
  name: "dig_enable_playlist_deletion",
  title: "Enable/disable playlist deletion",
  access: "destructive",
  meta: { "anthropic/requiresUserInteraction": true },
  description:
    "Enable or disable the dig_unfollow_playlist tool. For playlists the user owns, unfollowing IS deletion — only enable this when the user explicitly asks for playlist deletion and has been warned.",
  inputSchema: {
    type: "object",
    properties: {
      enable: {
        type: "boolean",
        description: "true to enable playlist deletion, false to disable it.",
      },
    },
    required: ["enable"],
    additionalProperties: false,
  },
});

export function createConfigTools({ notifyToolsChanged = () => {} } = {}) {
  async function digSetClientId(args) {
    const candidate = usable(typeof args?.client_id === "string" ? args.client_id : undefined);
    if (candidate === null) {
      return { text: BAD_CLIENT_ID_MESSAGE, isError: true };
    }
    const check = checkClientId(candidate);
    if (check.state !== "ok") {
      return { text: check.message, isError: true };
    }
    try {
      writeConfigPatch({ spotify_client_id: check.clientId });
    } catch (err) {
      return { text: err.message, isError: true };
    }
    const after = checkClientId();
    const lines = ["Client ID stored. It's active right now — no restart or new chat needed."];
    if (after.source === "env" && after.clientId !== check.clientId) {
      lines.push(
        "",
        "Note: a different Client ID is also set in the plugin's settings, and that one wins while it's present. dig_status shows which value is active.",
      );
    }
    lines.push("", "Next step: run dig_connect to sign in to Spotify through the browser.");
    return { text: lines.join("\n"), isError: false };
  }

  async function digEnableDeletion(args) {
    if (typeof args?.enable !== "boolean") {
      return { text: "dig_enable_playlist_deletion needs `enable`: true or false.", isError: true };
    }
    try {
      writeConfigPatch({ dig_enable_unfollow: args.enable ? "true" : "false" });
    } catch (err) {
      return { text: err.message, isError: true };
    }
    notifyToolsChanged();
    const now = resolveUnfollowFlag();
    const lines = [];
    if (args.enable) {
      lines.push(
        "Playlist deletion is now enabled: the dig_unfollow_playlist tool is available.",
        "",
        "**Warning, repeated on purpose: for playlists you own, unfollowing IS deletion.** Spotify keeps deleted playlists recoverable for about 90 days at spotify.com, but Dig treats this as destructive — it always snapshots first and asks before acting.",
      );
      if (!now.enabled) {
        lines.push(
          "",
          "Note: the plugin's settings currently force this OFF, and settings win while present. dig_status shows which source is active.",
        );
      }
    } else {
      lines.push("Playlist deletion is now disabled: the dig_unfollow_playlist tool is no longer available.");
      if (now.enabled) {
        lines.push(
          "",
          "Note: the plugin's settings currently force this ON, and settings win while present. dig_status shows which source is active.",
        );
      }
    }
    lines.push(
      "",
      "The tool list updates in this session; if this chat's tool list doesn't refresh, it takes effect in the next new chat.",
    );
    return { text: lines.join("\n"), isError: false };
  }

  return [
    { def: SET_CLIENT_ID_TOOL, handler: digSetClientId },
    { def: ENABLE_DELETION_TOOL, handler: digEnableDeletion },
  ];
}
