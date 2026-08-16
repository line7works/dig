// Tool annotations derived from ONE authored field (slice C R6): each tool
// declares an access class, and the four MCP hints are computed from it so
// they cannot drift tool-by-tool. Annotations are documentation, not a
// safety mechanism (research §6) — the tool surface itself is the gate.

const ACCESS_CLASSES = {
  // Pure reads: local or Spotify GETs, no state changed anywhere.
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Local-only reads (no network): status and similar.
  local: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Local-only configuration writes (no network): persists a setting into
  // Dig's own data directory. Repeating one with the same value is a no-op.
  configure: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Starts the sign-in flow: writes local token state, talks to Spotify.
  connect: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Additive writes: create/add/rename/reorder — never removal, so not
  // destructive, but repeating one is not idempotent (a re-add duplicates).
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Destructive writes (slice F): removal, restore-over, unfollow. These may
  // also carry requiresUserInteraction via `meta` so the host prompts even
  // under bypass-permissions modes (research §6).
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export function defineTool({ name, title, description, inputSchema, access, meta }) {
  const hints = ACCESS_CLASSES[access];
  if (!hints) throw new Error(`unknown tool access class: ${access}`);
  return {
    name,
    description,
    inputSchema,
    annotations: { title, ...hints },
    ...(meta ? { _meta: meta } : {}),
  };
}
