/* A security-relevant module that moves keeps its guard: each file below must satisfy the
   autonomous-fix guard's isProtectedPath at its current path, and must exist. A move that forgets to
   update PROTECTED_PATHS makes the entry point at nothing and this test fails. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isProtectedPath } from "./merge-guard";

const repoRoot = join(import.meta.dirname, "..", "..");
const CONTEXTS = "qa-engine/src/contexts";

const SECURITY_RELEVANT_MODULES = [
  `${CONTEXTS}/app-catalog/infrastructure/auth-session.adapter.ts`,
  `${CONTEXTS}/app-catalog/application/ports/auth-session.port.ts`,
  `${CONTEXTS}/app-catalog/domain/helpers/login-evidence.ts`,
  `${CONTEXTS}/app-catalog/infrastructure/login-discovery/login-discovery.script.ts`,
  `${CONTEXTS}/app-catalog/infrastructure/login-discovery/login-discovery.runner.ts`,
  `${CONTEXTS}/agent-tools/infrastructure/agent-browser-registry.ts`,
  `${CONTEXTS}/agent-tools/infrastructure/closed-loop-registry.ts`,
  `${CONTEXTS}/agent-tools/infrastructure/code-graph-tool-registry.ts`,
  `${CONTEXTS}/agent-tools/infrastructure/adapters/agent-browser-port.adapter.ts`,
  `${CONTEXTS}/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts`,
  `${CONTEXTS}/agent-tools/infrastructure/adapters/code-graph-tools-port.adapter.ts`,
  `${CONTEXTS}/agent-tools/domain/code-graph-query.ts`,
  `${CONTEXTS}/agent-tools/domain/explore-answer.ts`,
  `${CONTEXTS}/coordination/application/lead-plan.ts`,
  `${CONTEXTS}/coordination/application/lead-sidekicks.ts`,
  `${CONTEXTS}/coordination/application/sidekick-authoring.ts`,
  `${CONTEXTS}/coordination/application/lead-review.ts`,
  `${CONTEXTS}/coordination/application/lead-correction.ts`,
  `${CONTEXTS}/coordination/application/ports/delegation-workspace.port.ts`,
  `${CONTEXTS}/coordination/infrastructure/adapters/delegation-workspace.adapter.ts`,
  `${CONTEXTS}/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts`,
  `${CONTEXTS}/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts`,
  `${CONTEXTS}/generation/infrastructure/adapters/generation-port.adapter.ts`,
  `${CONTEXTS}/change-analysis/infrastructure/adapters/blast-radius-signal.ts`,
];

test("every security-relevant module exists at its path and is protected there", () => {
  for (const file of SECURITY_RELEVANT_MODULES) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} does not exist: a move left the list behind`);
    assert.equal(isProtectedPath(file), true, `${file} is not protected`);
  }
});
