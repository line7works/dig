// All Dig logging goes through here, and only to stderr.
// stdout is the MCP protocol channel; a single stray write corrupts it.
export function log(...parts) {
  process.stderr.write(`[dig] ${parts.join(" ")}\n`);
}
