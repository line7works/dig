// AC3: drive the server over stdio through a full initialize + tools/list +
// tools/call and assert every byte the server writes to stdout parses as
// JSON-RPC. One stray log line on stdout fails this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server/index.mjs", import.meta.url));

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n";
}

async function runSession(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.write(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(rpc(2, "tools/list"));
  child.stdin.write(rpc(3, "tools/call", { name: "dig_status", arguments: {} }));
  // Exercise every remaining branch so a stray stdout write anywhere in the
  // server has nowhere to hide from this test: ping, unknown tool, unknown
  // method, parse error, invalid requests (batch / non-object / no method).
  child.stdin.write(rpc(4, "ping"));
  child.stdin.write(rpc(5, "tools/call", { name: "dig_nope", arguments: {} }));
  child.stdin.write(rpc(6, "no/such/method"));
  child.stdin.write("this is not json\n");
  child.stdin.write("[]\n");
  child.stdin.write('"just a string"\n');
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7 }) + "\n");
  child.stdin.end();
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, rej) => setTimeout(() => { child.kill("SIGKILL"); rej(new Error("server did not exit within 10s")); }, 10_000).unref()),
  ]);
  assert.equal(code, 0, `server exited nonzero (${code}); stderr: ${stderr.slice(0, 500)}`);
  return { stdout, stderr };
}

function parseFrames(stdout) {
  // Every stdout byte must belong to a newline-delimited JSON-RPC frame.
  const raw = stdout.split("\n");
  assert.equal(raw[raw.length - 1], "", "stdout must end with a newline");
  return raw.slice(0, -1).map((line) => {
    let msg;
    assert.doesNotThrow(() => (msg = JSON.parse(line)), `non-JSON on stdout: ${line.slice(0, 200)}`);
    assert.equal(msg.jsonrpc, "2.0", `stdout frame is not JSON-RPC: ${line.slice(0, 200)}`);
    return msg;
  });
}

test("stdout carries only JSON-RPC through init + list + call (client id set)", async () => {
  const { stdout } = await runSession({ SPOTIFY_CLIENT_ID: "a".repeat(32) });
  const frames = parseFrames(stdout);
  const byId = new Map(frames.map((f) => [f.id, f]));
  assert.ok(byId.get(1)?.result?.serverInfo, "initialize answered");
  assert.ok(byId.get(2)?.result?.tools?.some((t) => t.name === "dig_status"), "dig_status listed");
  const call = byId.get(3)?.result;
  assert.ok(call?.content?.[0]?.text.includes("looks valid"), "dig_status reports valid id");
  assert.deepEqual(byId.get(4)?.result, {}, "ping answered");
  assert.equal(byId.get(5)?.error?.code, -32602, "unknown tool -> -32602 protocol error");
  assert.equal(byId.get(6)?.error?.code, -32601, "unknown method -> -32601");
  assert.equal(byId.get(7)?.error?.code, -32600, "missing method -> -32600");
  const parseErrors = frames.filter((f) => f.id === null && f.error?.code === -32700);
  assert.equal(parseErrors.length, 1, "non-JSON line -> one -32700 with id null");
  const invalid = frames.filter((f) => f.id === null && f.error?.code === -32600);
  assert.equal(invalid.length, 2, "batch and non-object -> -32600 with id null");
});

test("initialize clamps unsupported protocol versions to a supported one", async () => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stdin.write(rpc(1, "initialize", { protocolVersion: "1999-01-01", capabilities: {} }));
  child.stdin.end();
  await once(child, "exit");
  const init = parseFrames(stdout).find((f) => f.id === 1);
  assert.equal(init.result.protocolVersion, "2025-06-18", "unsupported version negotiated down, never echoed");
});

test("server starts and answers with NO client id configured", async () => {
  const { stdout } = await runSession({ SPOTIFY_CLIENT_ID: "", CLAUDE_PLUGIN_OPTION_SPOTIFY_CLIENT_ID: "" });
  const frames = parseFrames(stdout);
  const call = frames.find((f) => f.id === 3)?.result;
  assert.ok(call, "tool call answered despite blank client id");
  assert.match(call.content[0].text, /not configured/i);
  assert.match(call.content[0].text, /Client ID/, "response explains what to configure");
});

test("unsubstituted ${user_config...} placeholder treated as unconfigured", async () => {
  const { stdout } = await runSession({ SPOTIFY_CLIENT_ID: "${user_config.spotify_client_id}" });
  const call = parseFrames(stdout).find((f) => f.id === 3)?.result;
  assert.match(call.content[0].text, /not configured/i);
});
