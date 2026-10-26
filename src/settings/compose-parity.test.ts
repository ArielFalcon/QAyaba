import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isRegisteredSetting } from "./registry";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* The variables the compose file hands the orchestrator service through its `environment` block. */
function orchestratorEnvironmentNames(): string[] {
  const compose = parse(readFileSync(join(ROOT, "docker-compose.yml"), "utf8")) as { services?: { orchestrator?: { environment?: Record<string, unknown> | string[] } } };
  const environment = compose.services?.orchestrator?.environment ?? {};
  return Array.isArray(environment) ? environment.map((entry) => entry.split("=")[0]!) : Object.keys(environment);
}

/* Variables .env.example still assigns although nothing reads them: the runtime-selector variables the orchestrator reports as no longer read, the removed second runtime's key, and a data directory no code consults. Each is deleted from both lists when the example drops it; the second test fails if one is listed here after it has gone. */
const ASSIGNED_BUT_UNREAD = new Set(["AGENT_RUNTIME_MODE", "AGENT_SINGLE_PROVIDER", "AGENT_PRIMARY_PROVIDER", "AGENT_REVIEWER_PROVIDER", "AGENT_CHAT_PROVIDER", "CODEX_API_KEY", "ENGRAM_DATA_DIR"]);

/* The variables .env.example assigns, one name per assignment line. */
function exampleAssignmentNames(): string[] {
  const names: string[] = [];
  for (const line of readFileSync(join(ROOT, ".env.example"), "utf8").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names;
}

test("every variable compose gives the orchestrator service is in the settings registry", () => {
  const names = orchestratorEnvironmentNames();
  assert.ok(names.length > 0, "the orchestrator service declares an environment");
  const missing = names.filter((name) => !isRegisteredSetting(name));
  assert.deepEqual(missing, [], "add each of these to src/settings/registry.ts or remove it from docker-compose.yml");
});

test("every assignment in .env.example is in the settings registry", () => {
  const names = exampleAssignmentNames();
  assert.ok(names.length > 0, ".env.example assigns variables");
  const missing = names.filter((name) => !isRegisteredSetting(name) && !ASSIGNED_BUT_UNREAD.has(name));
  assert.deepEqual(missing, [], "add each of these to src/settings/registry.ts or remove it from .env.example");
});

test("a variable listed as assigned but unread is still assigned in .env.example and still unregistered", () => {
  const names = new Set(exampleAssignmentNames());
  for (const name of ASSIGNED_BUT_UNREAD) {
    assert.ok(names.has(name), `${name} is no longer in .env.example: remove it from ASSIGNED_BUT_UNREAD`);
    assert.ok(!isRegisteredSetting(name), `${name} is registered: remove it from ASSIGNED_BUT_UNREAD`);
  }
});
