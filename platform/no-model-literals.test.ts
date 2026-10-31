import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Which model runs a role is configuration (agents/opencode.json and the operator's tier models). A model id in
 * production code, the console or the documentation is a second copy of that choice, so none may name one: the
 * console shows the model the API reports, or a role name.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* Where a model id must not appear: production TypeScript, the web console's scripts and the documentation. */
const SCANNED: ReadonlyArray<{ dir: string; keep: (name: string) => boolean }> = [
  { dir: "platform", keep: (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts") },
  { dir: "qa-engine/src", keep: (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts") },
  { dir: "web", keep: (name) => name.endsWith(".js") },
  { dir: "docs", keep: (name) => name.endsWith(".md") },
];

/* The ids agents/opencode.json declares: `<provider>/<name>`. */
function declaredModelIds(): string[] {
  const raw = JSON.parse(readFileSync(join(ROOT, "agents", "opencode.json"), "utf8")) as { agent?: Record<string, { model?: string }>; model_fallback?: Record<string, string> };
  const ids = [...Object.values(raw.agent ?? {}).map((a) => a.model), ...Object.values(raw.model_fallback ?? {})];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.includes("/")))];
}

function sourcesIn(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourcesIn(path, keep));
    else if (keep(entry.name)) found.push(path);
  }
  return found;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ids = declaredModelIds();
const prefixes = [...new Set(ids.map((id) => id.slice(0, id.indexOf("/"))))];
/* A model family is the leading word of a declared model name (`glm` of `glm-5.3-flash`): any `family-<word>` names a model, whichever version a copy has drifted to. */
const families = [...new Set(ids.map((id) => id.slice(id.indexOf("/") + 1).match(/^[a-z]+/i)?.[0]).filter((f): f is string => f !== undefined))];
const modelId = new RegExp(`["'\`](?:${prefixes.map(escape).join("|")})/[\\w][\\w.:-]*|\\b(?:${families.map(escape).join("|")})-\\w`, "i");

const naming = SCANNED.flatMap(({ dir, keep }) => sourcesIn(dir, keep))
  .filter((path) => modelId.test(readFileSync(join(ROOT, path), "utf8")))
  .sort();

test("agents/opencode.json declares the providers and model families the scan looks for", () => {
  assert.ok(prefixes.length > 0);
  assert.ok(families.length > 0);
});

test("the scan reaches the console scripts and the documentation", () => {
  assert.ok(SCANNED.flatMap(({ dir, keep }) => sourcesIn(dir, keep)).some((path) => path.startsWith("web/public/js/")));
  assert.ok(SCANNED.flatMap(({ dir, keep }) => sourcesIn(dir, keep)).some((path) => path.startsWith("docs/")));
});

test("neither production code, the console nor the documentation names a model", () => {
  assert.deepEqual(naming, [], "read the model from agents/opencode.json (declaredAgentModel), the model the API reports, or name the role instead of naming a model");
});
