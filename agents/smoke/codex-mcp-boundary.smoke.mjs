#!/usr/bin/env node
/**
 * MCP boundary smoke — IMAGE-GATED
 *
 * PURPOSE: Proves that the Codex CLI in the agents image loads exactly the [mcp_servers.*]
 * entries the supervisor writes to config.toml (ensureCodexConfig): the code-navigation and
 * browser servers, and no memory server. It asks Codex itself (`codex mcp list`, which reads the
 * same config.toml `codex exec` loads), so no model turn is involved and nothing can be
 * hallucinated.
 *
 * WHY NOT IN `npm test`:
 *   - Requires the @openai/codex binary pinned in agents/Dockerfile (not present on the dev/CI host).
 *   - Requires the supervisor to have written $CODEX_HOME/config.toml at boot.
 *
 * HOW TO RUN (inside the built `agents` image):
 *   node agents/smoke/codex-mcp-boundary.smoke.mjs
 *
 * DECISION GATE:
 *   PASS  → Codex loads the supervisor-written config.toml MCP servers.
 *   FAIL  → Codex does not load them as written. Wire MCP supervisor-side in runCodexExec (which
 *           already owns the spawn) or pass an explicit MCP flag in buildCodexExecArgs.
 */

import { execSync } from "node:child_process";

const EXPECTED = ["playwright", "serena"];

let listing;
try {
  listing = execSync("codex mcp list", { stdio: "pipe", encoding: "utf8" });
} catch (err) {
  if (/not found|ENOENT/.test(String(err.message))) {
    console.log("[codex-mcp-boundary.smoke] SKIPPED — `codex` binary not found (not in agents image).");
    process.exit(0);
  }
  console.error("[codex-mcp-boundary.smoke] FAIL — `codex mcp list` failed:", err.message);
  process.exit(2);
}

// The first column of every row after the header is a server name.
const servers = listing
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim().split(/\s+/)[0])
  .filter(Boolean)
  .sort();

console.log(`[codex-mcp-boundary.smoke] Codex loads: ${servers.join(", ") || "(none)"}`);
if (JSON.stringify(servers) === JSON.stringify(EXPECTED)) {
  console.log("[codex-mcp-boundary.smoke] PASS — Codex loads exactly the supervisor-written MCP servers.");
  process.exit(0);
}
console.error(`[codex-mcp-boundary.smoke] FAIL — expected ${EXPECTED.join(", ")}.`);
process.exit(1);
