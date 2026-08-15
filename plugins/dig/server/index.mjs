#!/usr/bin/env node
// Dig MCP server — hand-rolled stdio JSON-RPC 2.0 (pattern proven in
// dig-plugin-test). This file is the ONLY place allowed to write to stdout;
// everything else logs through log.mjs to stderr.

import { log } from "./log.mjs";
import { STATUS_TOOL, digStatus } from "./status.mjs";
import { checkClientId } from "./config.mjs";

const VERSION = "0.1.0";

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

function handle(req) {
  const { id, method } = req;
  log(`<- ${method}`);
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: req.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "dig", version: VERSION },
      });
      break;
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
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
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
    try {
      handle(JSON.parse(line));
    } catch (err) {
      log(`unparseable line (${err?.message}): ${line.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
