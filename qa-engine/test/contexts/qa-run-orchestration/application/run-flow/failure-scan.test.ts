/*
 * The run's steps leave the two rules for errors (the run's deadline and an untrusted git tree are never soft failures) to the
 * failure policy: no module of the run flow or the use case reads those predicates or remembers a rethrow of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const application = join(import.meta.dirname, "..", "..", "..", "..", "..", "src", "contexts", "qa-run-orchestration", "application");
const ALLOWED = new Set(["run-flow/failure-policy.ts"]);
const FORBIDDEN = /rethrowIf(RunDeadline|Untrusted)|isRunDeadlineError|isUntrustedGitTreeError/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("no module of the run flow or the use case reads the error predicates or remembers a rethrow outside the failure policy", () => {
  const offenders = [...sources(join(application, "run-flow")), join(application, "run-qa.use-case.ts")]
    .map((path) => relative(application, path))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => FORBIDDEN.test(readFileSync(join(application, rel), "utf8")));
  assert.deepEqual(offenders, []);
});
