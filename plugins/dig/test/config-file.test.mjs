// Slice G2 AC1/AC4: the config-file fallback. Env wins when usable; Dig's
// own config.json (written from chat by dig_set_client_id /
// dig_enable_playlist_deletion) is the fallback the desktop app relies on,
// effective immediately in the same server process.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { checkClientId, resolveUnfollowFlag } from "../server/config.mjs";
import { readConfigFile, writeConfigPatch, configFilePath } from "../server/config-file.mjs";
import { SET_CLIENT_ID_TOOL, ENABLE_DELETION_TOOL, createConfigTools } from "../server/config-tools.mjs";
import { digStatus } from "../server/status.mjs";
import { createDoctorTool } from "../server/doctor.mjs";

const SERVER = fileURLToPath(new URL("../server/index.mjs", import.meta.url));
const VALID = "a".repeat(32);
const OTHER = "b".repeat(32);

const ENV_KEYS = [
  "SPOTIFY_CLIENT_ID",
  "CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID",
  "DIG_ENABLE_UNFOLLOW",
  "CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW",
  "CLAUDE_PLUGIN_DATA",
];
let saved;
let dir;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "dig-config-"));
  process.env.CLAUDE_PLUGIN_DATA = dir;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- R1: resolution precedence -------------------------------------------

test("env wins over the config file when both are usable, and the mismatch is reported", async () => {
  await writeConfigPatch({ spotify_client_id: OTHER });
  process.env.SPOTIFY_CLIENT_ID = VALID;
  const r = checkClientId();
  assert.equal(r.state, "ok");
  assert.equal(r.clientId, VALID);
  assert.equal(r.source, "env");
  assert.equal(r.mismatch, true);
});

test("matching env and file values report no mismatch", async () => {
  await writeConfigPatch({ spotify_client_id: VALID });
  process.env.SPOTIFY_CLIENT_ID = VALID;
  const r = checkClientId();
  assert.equal(r.mismatch, false);
});

test("file fallback used when env is blank or an unsubstituted placeholder", async () => {
  await writeConfigPatch({ spotify_client_id: VALID });
  for (const v of ["", "   ", "${user_config.spotify_client_id}"]) {
    process.env.SPOTIFY_CLIENT_ID = v;
    delete process.env.CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID;
    const r = checkClientId();
    assert.equal(r.state, "ok", `env=${JSON.stringify(v)}`);
    assert.equal(r.clientId, VALID);
    assert.equal(r.source, "file");
  }
});

test("no env, no file: unconfigured with source none", () => {
  const r = checkClientId();
  assert.equal(r.state, "unconfigured");
  assert.equal(r.source, "none");
});

test("a corrupt config file is ignored, not fatal", () => {
  writeFileSync(join(dir, "config.json"), "not json", { mode: 0o600 });
  assert.equal(readConfigFile(), null);
  assert.equal(checkClientId().state, "unconfigured");
});

test("type-corrupt config values (boolean/number) are ignored, never a crash", () => {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ spotify_client_id: 123, dig_enable_unfollow: true }),
    { mode: 0o600 },
  );
  assert.equal(checkClientId().state, "unconfigured");
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "none", mismatch: false });
});

test("type-corrupt config.json does not kill server startup", async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ dig_enable_unfollow: true }), { mode: 0o600 });
  const frames = await runServerSession(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ],
    { CLAUDE_PLUGIN_DATA: dir },
  );
  assert.ok(frames.find((f) => f.id === 2)?.result?.tools, "tools/list must answer");
});

// --- R1: unfollow flag resolution -----------------------------------------

test("unfollow flag: both env names still honored, they win over the file, and the disagreement is reported", async () => {
  await writeConfigPatch({ dig_enable_unfollow: "true" });
  process.env.DIG_ENABLE_UNFOLLOW = "false";
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "env", mismatch: true });
  delete process.env.DIG_ENABLE_UNFOLLOW;
  process.env.CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW = "false";
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "env", mismatch: true });
  process.env.CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW = "true";
  assert.deepEqual(resolveUnfollowFlag(), { enabled: true, source: "env", mismatch: false });
});

test("unfollow flag: file fallback when env names are blank/placeholder", async () => {
  await writeConfigPatch({ dig_enable_unfollow: "true" });
  process.env.DIG_ENABLE_UNFOLLOW = "${user_config.dig_enable_unfollow}";
  const r = resolveUnfollowFlag();
  assert.equal(r.enabled, true);
  assert.equal(r.source, "file");
  assert.equal(r.mismatch, false);
});

test("unfollow flag: nothing set anywhere is disabled, source none", () => {
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "none", mismatch: false });
});

// --- R2: dig_set_client_id ------------------------------------------------

function toolsByName() {
  const tools = createConfigTools();
  return Object.fromEntries(tools.map((t) => [t.def.name, t]));
}

test("dig_set_client_id rejects a wrong-shape value with the standard message and persists nothing", async () => {
  const { dig_set_client_id } = toolsByName();
  for (const bad of ["short", "x".repeat(33), "with spaces padding to 32 chars!", ""]) {
    const r = await dig_set_client_id.handler({ client_id: bad });
    assert.equal(r.isError, true, `accepted ${JSON.stringify(bad)}`);
    assert.match(r.text, /doesn't look like a Client ID/);
  }
  assert.equal(existsSync(configFilePath()), false);
});

test("dig_set_client_id persists 0600, takes effect immediately, and names dig_connect", async () => {
  const { dig_set_client_id } = toolsByName();
  const r = await dig_set_client_id.handler({ client_id: `  ${VALID}\n` });
  assert.equal(r.isError, false);
  assert.match(r.text, /dig_connect/);
  const st = statSync(configFilePath());
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(configFilePath(), "utf8")).spotify_client_id, VALID);
  // Same process, no restart: resolution now sees the file.
  const check = checkClientId();
  assert.equal(check.state, "ok");
  assert.equal(check.source, "file");
});

test("dig_set_client_id is honest when a plugin-settings value stays in charge (valid OR invalid env)", async () => {
  const { dig_set_client_id } = toolsByName();
  // Valid competing env value.
  process.env.SPOTIFY_CLIENT_ID = OTHER;
  const r1 = await dig_set_client_id.handler({ client_id: VALID });
  assert.equal(r1.isError, false);
  assert.match(r1.text, /NOT active yet/);
  assert.doesNotMatch(r1.text, /active right now/);
  // Invalid-shape env value must not be reported as active either.
  process.env.SPOTIFY_CLIENT_ID = "my-app-name";
  const r2 = await dig_set_client_id.handler({ client_id: VALID });
  assert.equal(r2.isError, false);
  assert.match(r2.text, /NOT active yet/);
  assert.doesNotMatch(r2.text, /active right now/);
  // And status/doctor surface the masked file value in the invalid state.
  assert.match(digStatus(), /wrong shape[\s\S]*DIFFERENT Client IDs/);
});

test("dig_set_client_id warns before disconnecting a sign-in bound to a different app", async () => {
  const { writeFileAtomic0600 } = await import("../server/token-store.mjs");
  writeFileAtomic0600(
    join(dir, "token.json"),
    JSON.stringify({ refresh_token: "r", client_id: OTHER, obtained_at: 1 }),
  );
  const { dig_set_client_id } = toolsByName();
  const r = await dig_set_client_id.handler({ client_id: VALID });
  assert.equal(r.isError, false);
  assert.match(r.text, /will be disconnected/);
});

test("dig_set_client_id without a data directory fails with instructions, not a crash", async () => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  const { dig_set_client_id } = toolsByName();
  const r = await dig_set_client_id.handler({ client_id: VALID });
  assert.equal(r.isError, true);
  assert.match(r.text, /data directory/);
});

// --- R3: dig_enable_playlist_deletion --------------------------------------

test("dig_enable_playlist_deletion carries requiresUserInteraction meta and destructive annotations", () => {
  assert.equal(ENABLE_DELETION_TOOL._meta["anthropic/requiresUserInteraction"], true);
  assert.equal(ENABLE_DELETION_TOOL.annotations.destructiveHint, true);
  assert.equal(ENABLE_DELETION_TOOL.annotations.readOnlyHint, false);
});

test("dig_set_client_id is a local configure tool: non-destructive, closed-world", () => {
  assert.equal(SET_CLIENT_ID_TOOL.annotations.destructiveHint, false);
  assert.equal(SET_CLIENT_ID_TOOL.annotations.readOnlyHint, false);
  assert.equal(SET_CLIENT_ID_TOOL.annotations.openWorldHint, false);
});

test("dig_enable_playlist_deletion writes the flag, repeats the deletion warning, and merges with the stored Client ID", async () => {
  const { dig_enable_playlist_deletion, dig_set_client_id } = toolsByName();
  await dig_set_client_id.handler({ client_id: VALID });
  const on = await dig_enable_playlist_deletion.handler({ enable: true });
  assert.equal(on.isError, false);
  assert.match(on.text, /unfollowing IS deletion/i);
  assert.equal(readConfigFile().dig_enable_unfollow, "true");
  assert.equal(readConfigFile().spotify_client_id, VALID, "merge must keep the Client ID");
  assert.equal(resolveUnfollowFlag().enabled, true);
  const off = await dig_enable_playlist_deletion.handler({ enable: false });
  assert.equal(off.isError, false);
  assert.equal(resolveUnfollowFlag().enabled, false);
  const bad = await dig_enable_playlist_deletion.handler({});
  assert.equal(bad.isError, true);
});

// --- AC4: status and doctor name the active source --------------------------

test("dig_status names the source in all three states, plus the unfollow flag's state and source", async () => {
  const none = digStatus();
  assert.match(none, /not configured \(no plugin setting, nothing in Dig's config file\)/);
  assert.match(none, /Playlist deletion \(dig_unfollow_playlist\): disabled\./);
  await writeConfigPatch({ spotify_client_id: VALID, dig_enable_unfollow: "true" });
  const file = digStatus();
  assert.match(file, /Source: Dig's config file \(set in chat\)/);
  assert.match(file, /Playlist deletion \(dig_unfollow_playlist\): ENABLED\. Source: Dig's config file/);
  process.env.SPOTIFY_CLIENT_ID = OTHER;
  process.env.DIG_ENABLE_UNFOLLOW = "false";
  const s = digStatus();
  assert.match(s, /Source: plugin settings/);
  assert.match(s, /DIFFERENT Client IDs/);
  assert.match(s, /Playlist deletion \(dig_unfollow_playlist\): disabled\. Source: plugin settings/);
  assert.match(s, /DISAGREE about playlist deletion/);
});

test("dig_doctor names the source in all three states and reports the unfollow flag", async () => {
  const [{ handler: doctor }] = createDoctorTool({
    client: { request: async () => ({ display_name: "Probe" }) },
    deps: { readToken: () => null, signIn: () => null },
  });
  assert.match((await doctor()).text, /not configured \(no plugin setting, nothing in Dig's config file\)/);
  await writeConfigPatch({ spotify_client_id: VALID });
  const fileOut = (await doctor()).text;
  assert.match(fileOut, /Source: Dig's config file \(set in chat\)/);
  assert.match(fileOut, /Playlist deletion \(dig_unfollow_playlist\): disabled/);
  process.env.SPOTIFY_CLIENT_ID = OTHER;
  const out = (await doctor()).text;
  assert.match(out, /Source: plugin settings/);
  assert.match(out, /DIFFERENT Client IDs/);
  // Invalid-shape env: the masked file value must still surface.
  process.env.SPOTIFY_CLIENT_ID = "my-app-name";
  const bad = (await doctor()).text;
  assert.match(bad, /wrong shape \(source: plugin settings\)/);
  assert.match(bad, /DIFFERENT Client IDs/);
});

// --- R2/R3 at the real server boundary: same process, no restart ------------

// Sequential session: each frame is sent only after the previous frame's
// reply arrived, mirroring a real host — tool handlers are async, so firing
// all frames in one chunk would race a config write against the status read
// that checks it.
async function runServerSession(frames, env) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SPOTIFY_CLIENT_ID: "",
      CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID: "",
      DIG_ENABLE_UNFOLLOW: "",
      CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const received = [];
  let notifyArrival = null;
  child.stdout.on("data", (d) => {
    stdout += d;
    let nl;
    while ((nl = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      if (line) received.push(JSON.parse(line));
    }
    notifyArrival?.();
  });
  child.stderr.on("data", (d) => (stderr += d));
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  deadline.unref();
  try {
    for (const f of frames) {
      child.stdin.write(JSON.stringify(f) + "\n");
      const t0 = Date.now();
      while (!received.some((r) => r.id === f.id)) {
        if (Date.now() - t0 > 8000) throw new Error(`no reply to id ${f.id} within 8s; stderr: ${stderr.slice(0, 400)}`);
        await new Promise((resolve) => {
          notifyArrival = resolve;
          setTimeout(resolve, 50).unref();
        });
      }
    }
  } finally {
    child.stdin.end();
  }
  const [code] = await once(child, "exit");
  clearTimeout(deadline);
  assert.equal(code, 0, `server exited nonzero; stderr: ${stderr.slice(0, 400)}`);
  return received;
}

test("one server process: set Client ID in chat, then status serves it — no restart", async () => {
  const frames = await runServerSession(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dig_status" } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dig_set_client_id", arguments: { client_id: VALID } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dig_status" } },
    ],
    { CLAUDE_PLUGIN_DATA: dir },
  );
  const text = (id) => frames.find((f) => f.id === id).result.content[0].text;
  assert.match(text(2), /not configured/);
  assert.match(text(3), /active right now/);
  assert.match(text(4), /configured and looks valid .* Source: Dig's config file/);
});

test("one server process: enable deletion in chat, tools/list AND tools/call re-evaluate — no restart", async () => {
  const frames = await runServerSession(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      // The call-side gate: a disabled-but-registered tool must be REFUSED at
      // tools/call, exactly like an unknown tool — hidden must mean uncallable.
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dig_unfollow_playlist", arguments: { playlist_id: "x" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dig_enable_playlist_deletion", arguments: { enable: true } } },
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      // After the in-session enable, the same call must reach the real
      // handler (any tool result, success or isError — not a protocol error).
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "dig_unfollow_playlist", arguments: { playlist_id: "x" } } },
    ],
    { CLAUDE_PLUGIN_DATA: dir },
  );
  const frame = (id) => frames.find((f) => f.id === id);
  const names = (id) => frame(id).result.tools.map((t) => t.name);
  assert.ok(!names(2).includes("dig_unfollow_playlist"), "must start absent");
  assert.equal(frame(3).error?.code, -32602, "disabled tool must be refused at tools/call with -32602");
  assert.ok(names(5).includes("dig_unfollow_playlist"), "must appear after enable, same process");
  assert.ok(frame(6).result, "enabled tool must reach its handler (tool result, not protocol error)");
  assert.equal(frame(6).error, undefined);
  // The enable also announces the change to the host.
  assert.ok(
    frames.some((f) => f.method === "notifications/tools/list_changed"),
    "expected a tools/list_changed notification",
  );
});
