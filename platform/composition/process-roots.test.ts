/* Every process that starts engine code installs the redacting logger, or the engine's lines reach the console as they are. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* A file is a process root when it runs `main` only if it is the process entry. */
const ENTRY_GUARD = /process\.argv\[1\]\s*(===|&&)|isProcessEntry\(\)|import\.meta\.url === `file:/;

function roots(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .map((name) => `${dir}/${name}`)
    .filter((path) => ENTRY_GUARD.test(readFileSync(join(ROOT, path), "utf8")));
}

/* Roots that run no engine code that logs a run's text: generators and checks of the repository itself. The list only shrinks. */
const NO_ENGINE_LOGGING = new Set([
  "scripts/check-contract-fresh.ts",
  "scripts/check-previous-forms.ts",
  "scripts/check-settings-fresh.ts",
  "scripts/gen-settings-docs.ts",
  "scripts/mutate.ts",
  "scripts/prompt-contract-matrix.ts",
  "scripts/campaign-compare.ts",
  "scripts/enforce-readiness.ts",
  "scripts/run-funnel.ts",
]);

test("every process root that runs engine code installs the redacting process logger", () => {
  const found = [...roots("platform/composition"), ...roots("scripts")];
  assert.ok(found.includes("platform/composition/cli.ts"), "the CLI root must be found");
  assert.ok(found.includes("platform/composition/index.ts"), "the service root must be found");
  const missing = found.filter((path) => !NO_ENGINE_LOGGING.has(path)).filter((path) => {
    const source = readFileSync(join(ROOT, path), "utf8");
    /* The service root installs it in wireApp, the one function it boots through. */
    const owner = path === "platform/composition/index.ts" ? readFileSync(join(ROOT, "platform/composition/wire-app.ts"), "utf8") : source;
    return !/installRedactingProcessLogger\(\)/.test(owner);
  });
  assert.deepEqual(missing, []);
});
