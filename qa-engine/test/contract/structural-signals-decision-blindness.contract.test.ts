/* structuralSignalBytes, serviceLinksCount, and contractDriftCount are persist-only telemetry:
   never a live UI/caller input and never a verdict/gate/publish branch. This static guard greps
   every decide/verdict/gate/publish source file and asserts none reference those identifiers.
   Only the use-case construction site (run-qa.use-case.ts) and the persistence mapping
   (run-history-sqlite-adapter.ts) may name them. crossRepoImpact/impactedLinks/crossRepoImpactedCount
   extend the same guard — advisory-only, fail-open, never a decision input. Cross-repo
   change-coverage stays "unknown" independently of this seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const qaEngineRoot = join(here, "..", "..");

/* Every source file that owns a decide/verdict/gate/publish decision path. Deliberately an
   exhaustive allowlist of PATHS (not a glob) so a new decision file added later must be added here
   explicitly — dropping a path from disk without removing its entry here would throw ENOENT.
 */
const DECISION_PATH_FILES = [
  "src/contexts/qa-run-orchestration/domain/run-decision.service.ts",
  "src/contexts/qa-run-orchestration/domain/adjudicate.service.ts",
  "src/contexts/test-execution/domain/adjudicate.service.ts",
  "src/contexts/objective-signal/domain/decide-coverage.service.ts",
  "src/contexts/workspace-and-publication/domain/publish-decision.service.ts",
  "src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts",
  "src/contexts/qa-run-orchestration/domain/helpers/progress-gate.ts",
  "src/contexts/test-execution/infrastructure/static-gate.adapter.ts",
  "src/contexts/generation/infrastructure/catalog-gate.ts",
  "src/contexts/generation/infrastructure/verdict-parser.adapter.ts",
];

const STRUCTURAL_SIGNAL_TELEMETRY_FIELDS = ["structuralSignalBytes", "serviceLinksCount", "contractDriftCount"];

/* crossRepoImpact/impactedLinks/crossRepoImpactedCount must be blind to every decision path —
   same static guard, same file list, extended field set.
 */
const CROSS_REPO_IMPACT_FIELDS = ["crossRepoImpact", "impactedLinks", "crossRepoImpactedCount"];

test("no decide/verdict/gate/publish source file references structuralSignalBytes/serviceLinksCount/contractDriftCount — persist-only telemetry, never a decision input", () => {
  for (const relPath of DECISION_PATH_FILES) {
    const content = readFileSync(join(qaEngineRoot, relPath), "utf8");
    for (const field of STRUCTURAL_SIGNAL_TELEMETRY_FIELDS) {
      assert.ok(
        !content.includes(field),
        `${relPath} references '${field}' — this field is persist-only telemetry (design §2/ADR-B) and must NEVER be read by a decide/verdict/gate/publish path`,
      );
    }
  }
});

test("no decide/verdict/gate/publish source file references crossRepoImpact/impactedLinks/crossRepoImpactedCount — advisory-only, fail-open, never a decision input (Slice C, C-R8)", () => {
  for (const relPath of DECISION_PATH_FILES) {
    const content = readFileSync(join(qaEngineRoot, relPath), "utf8");
    for (const field of CROSS_REPO_IMPACT_FIELDS) {
      assert.ok(
        !content.includes(field),
        `${relPath} references '${field}' — CrossRepoImpactPort's composition is advisory-only (design §3/spec "Zero verdict/gate/publish coupling") and must NEVER be read by a decide/verdict/gate/publish path`,
      );
    }
  }
});

test("cross-repo change-coverage semantics stay 'unknown' — decide-coverage.service.ts never derives status from a cross-repo/triggerRepo signal", () => {
  const content = readFileSync(join(qaEngineRoot, "src/contexts/objective-signal/domain/decide-coverage.service.ts"), "utf8");
  assert.ok(
    !/triggerRepo|crossRepo/.test(content),
    "decide-coverage.service.ts must never branch on triggerRepo/crossRepo signals — cross-repo runs stay 'unknown' by construction (browser coverage cannot map service-repo lines), independent of CrossRepoImpactPort's own advisory result",
  );
});
