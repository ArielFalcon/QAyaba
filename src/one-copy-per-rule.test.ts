import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * A rule has one copy. Each test below names a rule and the one file that owns it; a second file that restates the rule is
 * a copy that drifts, so it fails here.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function typescriptIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...typescriptIn(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

const PRODUCTION = ["qa-engine/src", "src", "scripts"].flatMap(typescriptIn);

function filesMatching(pattern: RegExp): string[] {
  return PRODUCTION.filter((path) => pattern.test(readFileSync(join(ROOT, path), "utf8"))).sort();
}

test("the run-event vocabulary is defined once, in the kernel contract", () => {
  assert.deepEqual(filesMatching(/z\.literal\("run\.started"\)/), ["qa-engine/src/shared-kernel/contract/events.ts"]);
});

test("the run modes and the run steps are listed once, in the kernel", () => {
  assert.deepEqual(filesMatching(/\[\s*"diff",\s*"manual",\s*"context"\s*\]/), ["qa-engine/src/shared-kernel/run-mode.ts"]);
  assert.deepEqual(filesMatching(/"gate",\s*"classify",\s*"setup",\s*"generate",\s*"validate"/), ["qa-engine/src/shared-kernel/run-step.ts"]);
});

test("a spec path is compared in one place, the kernel's spec-path module", () => {
  const owner = "qa-engine/src/shared-kernel/spec-path.ts";
  const strictCopies = filesMatching(/normalizeSpecPath\([^()]*\)\s*===\s*normalizeSpecPath\(|const sameSpec\b|const sameFile = \(a: string \| undefined|export function sameFile\b/);
  assert.deepEqual(strictCopies.filter((path) => path !== owner), []);
  const tailCopies = filesMatching(/===\s*[\w.]+\s*\|\|\s*[\w.]+\.endsWith\(`\/\$\{[\w.]+\}`\)\s*\|\|\s*[\w.]+\.endsWith\(`\/\$\{[\w.]+\}`\)/);
  assert.deepEqual(tailCopies.filter((path) => path !== owner), []);
});

test("the review-round cap is defined once, in the kernel", () => {
  assert.deepEqual(filesMatching(/\bMAX_REVIEW_ROUNDS\s*=\s*\d/), ["qa-engine/src/shared-kernel/derive-cycle-backstop.ts"]);
});

test("a page opened from a template is printed by one derivation, the kernel's printed-route module", () => {
  assert.deepEqual(filesMatching(/\(instance of/), []);
});
