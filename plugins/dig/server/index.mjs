#!/usr/bin/env node
// Dig MCP server — hand-rolled stdio JSON-RPC 2.0 (pattern proven in
// dig-plugin-test). This file is the ONLY place allowed to write to stdout;
// everything else logs through log.mjs to stderr.

import { readFileSync } from "node:fs";
import { log } from "./log.mjs";
import { STATUS_TOOL, digStatus } from "./status.mjs";
import { CONNECT_TOOL, digConnect } from "./connect.mjs";
import { checkClientId } from "./config.mjs";

// Version is single-sourced from the plugin manifest so a release bump
// cannot drift from what serverInfo reports.
const VERSION = JSON.parse(
  readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
).version;

// Protocol versions this server actually implements. Initialize negotiates:
// echo the client's version only if we support it, else answer with our latest.
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

// A missing or malformed Client ID must never prevent startup — tools answer
// with setup instructions instead. Just note it on stderr.
log(`server started, node ${process.version}, client id state: ${checkClientId().state}`);

const TOOLS = [STATUS_TOOL, CONNECT_TOOL];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function toolResult(id, text, isError = false) {
  reply(id, { content: [{ type: "text", text }], isError });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  switch (name) {
    case "dig_status":
      toolResult(id, digStatus());
      break;
    case "dig_connect": {
      const r = await digConnect();
      toolResult(id, r.text, r.isError);
      break;
    }
    default:
      // Unknown tool is a host-facing protocol error (-32602), not a
      // model-facing isError result.
      sendError(validId(id), -32602, `Unknown tool: ${name}`);
  }
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
}

// A JSON-RPC id must be a string, number, or null; anything else means the
// request is malformed and the error reply carries id null.
function validId(id) {
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function handle(req) {
  // Invalid Request (-32600): not a lone object (batches included — MCP
  // dropped batching), or no string method. Silence here hangs the client.
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    sendError(null, -32600, "Invalid Request: expected a single JSON-RPC object");
    return;
  }
  if (typeof req.method !== "string") {
    sendError(validId(req.id), -32600, "Invalid Request: missing method");
    return;
  }
  const { id, method } = req;
  log(`<- ${method}`);
  switch (method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "dig", version: VERSION },
      });
      break;
    }
    case "notifications/initialized":
      // A true notification gets no reply, but a misbehaving client that
      // attached an id is owed a response or it hangs on it.
      if (id !== undefined) reply(validId(id), {});
      break;
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call":
      // Async tools reply when they finish; a rejection still answers.
      handleToolCall(id, req.params).catch((err) => {
        log(`tool error: ${err?.stack || err}`);
        toolResult(id, `Dig hit an internal error: ${err?.message || err}`, true);
      });
      break;
    case "ping":
      reply(id, {});
      break;
    default:
      if (id !== undefined) {
        sendError(validId(id), -32601, `Method not found: ${method}`);
      }
  }
}

// Every request gets exactly one reply or is a true notification. A throw
// from a handler is an Internal error (-32603), never a silent drop — and
// never mislabeled as a parse failure.
function dispatch(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    log(`parse error: ${err?.message}: ${line.slice(0, 200)}`);
    sendError(null, -32700, "Parse error");
    return;
  }
  try {
    handle(req);
  } catch (err) {
    log(`handler error on ${req?.method}: ${err?.stack || err}`);
    const id = typeof req === "object" && req !== null && !Array.isArray(req) ? req.id : undefined;
    if (id !== undefined) sendError(validId(id), -32603, "Internal error");
  }
}

// Cap the line buffer: a client streaming without newlines must not OOM the
// server. Real MCP frames are far below this.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  if (buf.length > MAX_LINE_BYTES && !buf.includes("\n")) {
    log(`dropping oversized frame (${buf.length} bytes, no newline)`);
    buf = "";
    sendError(null, -32700, "Parse error: frame exceeds size limit");
    return;
  }
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    dispatch(line);
  }
});

process.stdin.on("end", () => {
  // Flush a final request that arrived without a trailing newline before the
  // client half-closed; otherwise it is silently lost.
  const line = buf.trim();
  if (line) dispatch(line);
  process.exit(0);
});
