/* `@opentelemetry/*` is imported only under src/telemetry/. The cruiser does not scan src/, so this is the machine check for the shell side of the boundary (docs/observability-design.md §3.2); qa-engine/src is covered by the cruiser rule `no-telemetry-sdk-in-engine`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..");
const SDK_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@opentelemetry\//;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

test("@opentelemetry imports under src/ exist only in src/telemetry/", () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => !relative(SRC, file).startsWith(`telemetry${sep}`))
    .filter((file) => SDK_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));
  assert.deepEqual(offenders, []);
});

test("the confinement check sees an SDK import when one is present", () => {
  assert.ok(SDK_IMPORT.test('import { trace } from "@opentelemetry/api";'));
  assert.ok(SDK_IMPORT.test('const m = await import("@opentelemetry/sdk-trace-base");'));
  assert.ok(!SDK_IMPORT.test('import { trace } from "./telemetry/otel-telemetry.adapter";'));
});

test("src/telemetry itself does import the SDK, so the check is not vacuous", () => {
  const inside = sourceFiles(join(SRC, "telemetry")).filter((file) => SDK_IMPORT.test(readFileSync(file, "utf8")));
  assert.ok(inside.length > 0);
});
