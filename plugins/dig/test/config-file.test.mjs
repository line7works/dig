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

test("env wins over the config file when both are usable, and the mismatch is reported", () => {
  writeConfigPatch({ spotify_client_id: OTHER });
  process.env.SPOTIFY_CLIENT_ID = VALID;
  const r = checkClientId();
  assert.equal(r.state, "ok");
  assert.equal(r.clientId, VALID);
  assert.equal(r.source, "env");
  assert.equal(r.mismatch, true);
});

test("matching env and file values report no mismatch", () => {
  writeConfigPatch({ spotify_client_id: VALID });
  process.env.SPOTIFY_CLIENT_ID = VALID;
  const r = checkClientId();
  assert.equal(r.mismatch, false);
});

test("file fallback used when env is blank or an unsubstituted placeholder", () => {
  writeConfigPatch({ spotify_client_id: VALID });
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

// --- R1: unfollow flag resolution -----------------------------------------

test("unfollow flag: both env names still honored, and they win over the file", () => {
  writeConfigPatch({ dig_enable_unfollow: "true" });
  process.env.DIG_ENABLE_UNFOLLOW = "false";
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "env" });
  delete process.env.DIG_ENABLE_UNFOLLOW;
  process.env.CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW = "false";
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "env" });
});

test("unfollow flag: file fallback when env names are blank/placeholder", () => {
  writeConfigPatch({ dig_enable_unfollow: "true" });
  process.env.DIG_ENABLE_UNFOLLOW = "${user_config.dig_enable_unfollow}";
  const r = resolveUnfollowFlag();
  assert.equal(r.enabled, true);
  assert.equal(r.source, "file");
});

test("unfollow flag: nothing set anywhere is disabled, source none", () => {
  assert.deepEqual(resolveUnfollowFlag(), { enabled: false, source: "none" });
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

test("dig_set_client_id warns when a different plugin-settings value stays in charge", async () => {
  process.env.SPOTIFY_CLIENT_ID = OTHER;
  const { dig_set_client_id } = toolsByName();
  const r = await dig_set_client_id.handler({ client_id: VALID });
  assert.equal(r.isError, false);
  assert.match(r.text, /different Client ID .* plugin's settings|plugin's settings, and that one wins/);
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

test("dig_status names the source in all three states", async () => {
  assert.match(digStatus(), /not configured \(no plugin setting, nothing in Dig's config file\)/);
  writeConfigPatch({ spotify_client_id: VALID });
  assert.match(digStatus(), /Source: Dig's config file \(set in chat\)/);
  process.env.SPOTIFY_CLIENT_ID = OTHER;
  const s = digStatus();
  assert.match(s, /Source: plugin settings/);
  assert.match(s, /DIFFERENT Client IDs/);
});

test("dig_doctor names the source in all three states", async () => {
  const [{ handler: doctor }] = createDoctorTool({
    client: { request: async () => ({ display_name: "Probe" }) },
    deps: { readToken: () => null, signIn: () => null },
  });
  assert.match((await doctor()).text, /not configured \(no plugin setting, nothing in Dig's config file\)/);
  writeConfigPatch({ spotify_client_id: VALID });
  assert.match((await doctor()).text, /Source: Dig's config file \(set in chat\)/);
  process.env.SPOTIFY_CLIENT_ID = OTHER;
  const out = (await doctor()).text;
  assert.match(out, /Source: plugin settings/);
  assert.match(out, /DIFFERENT Client IDs/);
});

// --- R2/R3 at the real server boundary: same process, no restart ------------

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
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  for (const f of frames) child.stdin.write(JSON.stringify(f) + "\n");
  child.stdin.end();
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, rej) => setTimeout(() => { child.kill("SIGKILL"); rej(new Error("server did not exit within 10s")); }, 10_000).unref()),
  ]);
  assert.equal(code, 0, `server exited nonzero; stderr: ${stderr.slice(0, 400)}`);
  return stdout.trim().split("\n").map((l) => JSON.parse(l));
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

test("one server process: enable deletion in chat, tools/list re-evaluates — no restart", async () => {
  const frames = await runServerSession(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dig_enable_playlist_deletion", arguments: { enable: true } } },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ],
    { CLAUDE_PLUGIN_DATA: dir },
  );
  const names = (id) => frames.find((f) => f.id === id).result.tools.map((t) => t.name);
  assert.ok(!names(2).includes("dig_unfollow_playlist"), "must start absent");
  assert.ok(names(4).includes("dig_unfollow_playlist"), "must appear after enable, same process");
  // The enable also announces the change to the host.
  assert.ok(
    frames.some((f) => f.method === "notifications/tools/list_changed"),
    "expected a tools/list_changed notification",
  );
});
