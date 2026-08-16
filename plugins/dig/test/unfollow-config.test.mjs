// AC4 (slice G R6): the non-developer opt-in — with the userConfig-backed
// env set, dig_unfollow_playlist appears in the SERVER's tools/list; unset
// (or carrying an unsubstituted placeholder / blank), it stays absent.
// Proven at the real server boundary (spawned process, tools/list over
// stdio), not the factory layer, and env-hygienic against ambient values of
// BOTH env names (the slice-F MINOR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/index.mjs", import.meta.url));

async function listTools(extraEnv) {
  const env = {
    ...process.env,
    SPOTIFY_CLIENT_ID: "a".repeat(32),
    // Neutralize ambient opt-ins so each case controls both names fully.
    DIG_ENABLE_UNFOLLOW: "",
    CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW: "",
    ...extraEnv,
  };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  child.stdin.end();
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, rej) => setTimeout(() => { child.kill("SIGKILL"); rej(new Error("server did not exit within 10s")); }, 10_000).unref()),
  ]);
  assert.equal(code, 0, `server exited nonzero; stderr: ${stderr.slice(0, 400)}`);
  const frames = stdout.trim().split("\n").map((l) => JSON.parse(l));
  const list = frames.find((f) => f.id === 2);
  assert.ok(list?.result?.tools, "no tools/list result");
  return list.result.tools.map((t) => t.name);
}

test("default (both env names blank): dig_unfollow_playlist absent", async () => {
  const names = await listTools({});
  assert.ok(!names.includes("dig_unfollow_playlist"), `unexpectedly present in: ${names}`);
  assert.ok(names.includes("dig_doctor"), "doctor should always be listed");
});

test("unsubstituted userConfig placeholder: stays absent", async () => {
  const names = await listTools({ DIG_ENABLE_UNFOLLOW: "${user_config.dig_enable_unfollow}" });
  assert.ok(!names.includes("dig_unfollow_playlist"));
});

test("userConfig path (DIG_ENABLE_UNFOLLOW=true via .mcp.json substitution): present", async () => {
  const names = await listTools({ DIG_ENABLE_UNFOLLOW: "true" });
  assert.ok(names.includes("dig_unfollow_playlist"), `missing from: ${names}`);
});

test("auto-export fallback works even when the primary is blank", async () => {
  const names = await listTools({ CLAUDE_PLUGIN_OPTION_DIG_ENABLE_UNFOLLOW: "true" });
  assert.ok(names.includes("dig_unfollow_playlist"), `missing from: ${names}`);
});

test("a non-truthy value does not enable it", async () => {
  const names = await listTools({ DIG_ENABLE_UNFOLLOW: "false" });
  assert.ok(!names.includes("dig_unfollow_playlist"));
});

test("plugin.json declares the dig_enable_unfollow field with the deletion warning", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const field = manifest.userConfig?.dig_enable_unfollow;
  assert.ok(field, "userConfig.dig_enable_unfollow missing from plugin.json");
  assert.ok(!("required" in field) && !("sensitive" in field), "required/sensitive must stay omitted (live install bugs)");
  assert.match(field.description, /deletion/i);
  const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
  assert.equal(mcp.mcpServers.dig.env.DIG_ENABLE_UNFOLLOW, "${user_config.dig_enable_unfollow}");
});
