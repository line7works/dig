#!/usr/bin/env node
// Dig MCP server — hand-rolled stdio JSON-RPC 2.0 (pattern proven in
// dig-plugin-test). This file is the ONLY place allowed to write to stdout;
// everything else logs through log.mjs to stderr.

import { log } from "./log.mjs";
import { STATUS_TOOL, digStatus } from "./status.mjs";
import { checkClientId } from "./config.mjs";

const VERSION = "0.1.0";

// Protocol versions this server actually implements. Initialize negotiates:
// echo the client's version only if we support it, else answer with our latest.
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

// A missing or malformed Client ID must never prevent startup — tools answer
// with setup instructions instead. Just note it on stderr.
log(`server started, node ${process.version}, client id state: ${checkClientId().state}`);

const TOOLS = [STATUS_TOOL];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function toolResult(id, text, isError = false) {
  reply(id, { content: [{ type: "text", text }], isError });
}

function handleToolCall(id, params) {
  const name = params?.name;
  switch (name) {
    case "dig_status":
      toolResult(id, digStatus());
      break;
    default:
      toolResult(id, `Unknown tool: ${name}`, true);
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
      break; // notification, no reply
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call":
      try {
        handleToolCall(id, req.params);
      } catch (err) {
        log(`tool error: ${err?.stack || err}`);
        toolResult(id, `Dig hit an internal error: ${err?.message || err}`, true);
      }
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

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    dispatch(line);
  }
});

process.stdin.on("end", () => process.exit(0));
