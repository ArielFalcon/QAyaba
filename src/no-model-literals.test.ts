import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Which model runs a role is configuration (agents/opencode.json and the operator's tier models). A model id in
 * production code is a second copy of that choice, so only the sites below may name one.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "qa-engine/src"];

const ALLOWED: readonly string[] = ["src/server/onboarding/llm-profile-proposer.adapter.ts"];

/* A model id is `<provider>/<name>`; the providers are the ones agents/opencode.json declares models of. */
function declaredProviderPrefixes(): string[] {
  const raw = JSON.parse(readFileSync(join(ROOT, "agents", "opencode.json"), "utf8")) as { agent?: Record<string, { model?: string }>; model_fallback?: Record<string, string> };
  const ids = [...Object.values(raw.agent ?? {}).map((a) => a.model), ...Object.values(raw.model_fallback ?? {})];
  return [...new Set(ids.flatMap((id) => (typeof id === "string" && id.includes("/") ? [id.slice(0, id.indexOf("/"))] : [])))];
}

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

const prefixes = declaredProviderPrefixes();
const modelId = new RegExp(`["'\`](?:${prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/[\\w][\\w.:-]*`);

const naming = SCANNED.flatMap(productionSources)
  .filter((path) => modelId.test(readFileSync(join(ROOT, path), "utf8")))
  .sort();

test("agents/opencode.json declares the providers whose model ids the scan looks for", () => {
  assert.ok(prefixes.length > 0);
});

test("production code names a model id only where the allow-list says", () => {
  const permitted = new Set(ALLOWED);
  assert.deepEqual(
    naming.filter((path) => !permitted.has(path)),
    [],
    "read the model from agents/opencode.json (declaredAgentModel) or the operator's tier model instead of naming it",
  );
});

test("a file that no longer names a model id is removed from the allow-list", () => {
  assert.deepEqual(
    ALLOWED.filter((path) => !naming.includes(path)),
    [],
  );
});
