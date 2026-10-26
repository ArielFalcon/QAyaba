import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * One settings object: production code under src/ reads the process environment only where the reason below holds. Every
 * other value arrives through `Settings`, so a new variable is declared in the registry and documented by `settings:check`.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SRC, "..");

const ALLOWED: Readonly<Record<string, string>> = {
  "src/index.ts": "the server entry point loads the settings once",
  "src/cli.ts": "the CLI entry point loads the settings once",
  "src/paths.ts": "the repository root is needed before any settings exist",
  "src/integrations/logger.ts": "the log directory is needed before any settings exist",
  "src/server/file-boundary-check.ts": "a process of its own, started as root before the service, that loads no settings so an unrelated invalid variable cannot stop the sandbox check",
};

const ENV_READ = /\bprocess\s*(?:\.\s*env\b|\[\s*["']env["']\s*\])|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/;

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...productionFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

test("the process environment is read only where the settings gate allows it", () => {
  const readers = productionFiles(SRC)
    .map((file) => relative(ROOT, file))
    .filter((file) => !file.startsWith("src/settings/"))
    .filter((file) => ENV_READ.test(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(readers.filter((file) => !(file in ALLOWED)), []);
});

test("every allowed reader still reads the environment", () => {
  const stale = Object.keys(ALLOWED).filter((file) => !ENV_READ.test(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(stale, []);
});

test("the gate recognizes the ways code reads the environment", () => {
  for (const read of ["process.env.X", "process.env", 'process["env"]', "const { env } = process;", "process . env"]) assert.ok(ENV_READ.test(read), read);
  assert.ok(!ENV_READ.test("const environment = settings.env"));
});
