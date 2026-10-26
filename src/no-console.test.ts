import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleCallLines } from "./no-console.scan";

/*
 * Production code logs through LoggerPort, which redacts. A raw console call writes an unredacted line, so only the
 * files below may make one.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "qa-engine/src"];

/* Output the operator reads as the product, the JSON logger's own mirror, the tap that intercepts third-party output. */
const ALLOWED: readonly string[] = [
  "src/cli.ts",
  "src/qa/learning/ledger-cli.ts",
  "src/integrations/logger.ts",
  "src/telemetry/console-log-tap.ts",
];

/* Files not migrated yet. The list only shrinks: a file that no longer calls console must leave it. */
const NOT_MIGRATED: readonly string[] = [
  "qa-engine/src/contexts/generation/application/generate-tests.use-case.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/context-map-capture-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/context-trace.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/implementation-resources.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/pre-exec-grounding-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/review-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts",
  "qa-engine/src/contexts/generation/infrastructure/context-pack.ts",
  "qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts",
  "qa-engine/src/contexts/generation/infrastructure/manifest-fs.ts",
  "qa-engine/src/contexts/generation/infrastructure/prompt-builders/context-assembler.ts",
  "qa-engine/src/contexts/generation/infrastructure/prompt-builders/model-window-catalog.ts",
  "qa-engine/src/contexts/generation/infrastructure/prompt-builders/review-render.ts",
  "qa-engine/src/contexts/generation/infrastructure/resilience/circuit-breaker.ts",
  "qa-engine/src/contexts/generation/infrastructure/sse/call-efficiency-tracker.ts",
  "qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts",
  "qa-engine/src/contexts/generation/infrastructure/telemetry/turn-probe.ts",
  "qa-engine/src/contexts/generation/infrastructure/telemetry/turn-trace-registry.ts",
  "qa-engine/src/contexts/generation/infrastructure/telemetry/with-turn-telemetry.ts",
  "qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts",
  "qa-engine/src/shared-kernel/telemetry/guarded-telemetry.ts",
];

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

function callsConsole(path: string): boolean {
  return consoleCallLines(readFileSync(join(ROOT, path), "utf8")).length > 0;
}

const calling = SCANNED.flatMap(productionSources)
  .filter(callsConsole)
  .map((path) => relative(".", path))
  .sort();

test("production code calls console only where the allow-list says", () => {
  const permitted = new Set([...ALLOWED, ...NOT_MIGRATED]);
  assert.deepEqual(
    calling.filter((path) => !permitted.has(path)),
    [],
    "log through LoggerPort (redacting-logger for the shell, the engine logger for contexts) instead of console",
  );
});

test("a file that no longer calls console is removed from the allow-list", () => {
  const stale = [...ALLOWED, ...NOT_MIGRATED].filter((path) => !calling.includes(path));
  assert.deepEqual(stale, []);
});
