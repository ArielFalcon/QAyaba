/* The layering violations that exist today are frozen in qa-engine/.dependency-cruiser-known-violations.json so `npm run arch:check` fails only on a new one. The frozen set may only shrink:
   - every entry is still a current violation, so fixing one means deleting its entry;
   - there are at most KNOWN_VIOLATIONS_CEILING entries, a number each shrinking commit lowers (raising it is a visible review event);
   - none of the older security rules is ever frozen.
   Regenerate the file (only to shrink it, or to follow a pure file move that leaves the count unchanged) with
   `node_modules/.bin/depcruise-baseline --config qa-engine/.dependency-cruiser.cjs qa-engine/src -f qa-engine/.dependency-cruiser-known-violations.json`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");

export const KNOWN_VIOLATIONS_CEILING = 31;

const LAYERING_RULES = ["domain-imports-nothing-outward", "application-not-infrastructure", "cross-context-internals", "no-circular"];

interface Violation {
  type: string;
  from: string;
  to: string;
  rule: { name: string };
  cycle?: Array<{ name: string }>;
}

const baseline = JSON.parse(readFileSync(join(repoRoot, "qa-engine", ".dependency-cruiser-known-violations.json"), "utf8")) as Violation[];

const keyOf = (v: Violation): string => JSON.stringify([v.type, v.rule.name, v.from, v.to, (v.cycle ?? []).map((step) => step.name)]);

/* Every violation of the current tree, the baseline not applied. */
function currentViolations(): Violation[] {
  let output: string;
  try {
    output = execFileSync(DEPCRUISE, ["--config", join(repoRoot, "qa-engine", ".dependency-cruiser.cjs"), "--no-ignore-known", "-T", "json", "qa-engine/src"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e) {
    /* depcruise exits non-zero when it finds violations; the report is still on stdout. */
    output = (e as { stdout?: string }).stdout ?? "";
  }
  return (JSON.parse(output) as { summary: { violations: Violation[] } }).summary.violations;
}

test("every known violation is still a current violation, so a fixed one must be deleted from the file", () => {
  const current = new Set(currentViolations().map(keyOf));
  const stale = baseline.filter((v) => !current.has(keyOf(v))).map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`);
  assert.deepEqual(stale, [], "these entries no longer match a violation: delete them from the known-violations file and lower KNOWN_VIOLATIONS_CEILING");
});

test("the known violations never exceed the ceiling", () => {
  assert.ok(baseline.length <= KNOWN_VIOLATIONS_CEILING, `${baseline.length} known violations, ceiling ${KNOWN_VIOLATIONS_CEILING}: the set may only shrink`);
});

test("the known violations hold only the layering rules, never a security rule", () => {
  const names = new Set(baseline.map((v) => v.rule.name));
  for (const name of names) assert.ok(LAYERING_RULES.includes(name), `${name} is not a layering rule and must never be frozen`);
});

test("the known violations are free of duplicates", () => {
  const keys = baseline.map(keyOf);
  assert.equal(new Set(keys).size, keys.length);
});
