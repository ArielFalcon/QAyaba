/* Both long-lived containers start an init as PID 1 (tini): the orchestrator's runs spawn Playwright browsers as the sandbox uid and tsx spawns esbuild, and the agents container spawns the browser of its Playwright MCP. A child whose parent exits first is reparented to PID 1, and the service's own main process does not reap what it did not start: without an init those orphans stay defunct and the host-health gauge counts them. Parsed from the real compose file, so a later edit that drops the init fails here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..");
const compose = parse(readFileSync(join(ROOT, "docker-compose.yml"), "utf8")) as { services: Record<string, { init?: boolean }> };

test("the orchestrator and the agents containers run an init as PID 1, so an orphaned child cannot stay a zombie", () => {
  for (const name of ["orchestrator", "agents"]) assert.equal(compose.services[name]?.init, true, name);
});
