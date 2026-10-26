import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Production code logs through LoggerPort, which redacts. A raw console call writes an unredacted line, so only the
 * files below may make one.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "qa-engine/src"];
const CONSOLE_CALL = /\bconsole\.(log|warn|error|info|debug)\b/;

/* Output the operator reads as the product, the JSON logger's own mirror, and the tap that intercepts third-party output. */
const ALLOWED: readonly string[] = [
  "src/cli.ts",
  "src/qa/learning/ledger-cli.ts",
  "src/integrations/logger.ts",
  "src/telemetry/console-log-tap.ts",
];

/* Files not migrated yet. The list only shrinks: a file that no longer calls console must leave it. */
const NOT_MIGRATED: readonly string[] = [
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/agent-browser-port.adapter.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/code-graph-tools-port.adapter.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/tool-call-trace.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/trusted-session-renewal.ts",
  "qa-engine/src/contexts/app-catalog/infrastructure/auth-session.adapter.ts",
  "qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.runner.ts",
  "qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts",
  "qa-engine/src/contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts",
  "qa-engine/src/contexts/change-analysis/infrastructure/adapters/structural-signal-port.adapter.ts",
  "qa-engine/src/contexts/coordination/application/explore-round.ts",
  "qa-engine/src/contexts/coordination/application/lead-sidekicks.ts",
  "qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts",
  "qa-engine/src/contexts/coordination/infrastructure/adapters/delegation-workspace.adapter.ts",
  "qa-engine/src/contexts/cross-run-learning/application/fold-run-outcome.use-case.ts",
  "qa-engine/src/contexts/cross-run-learning/infrastructure/adapters/learning-port.adapter.ts",
  "qa-engine/src/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts",
  "qa-engine/src/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts",
  "qa-engine/src/contexts/cross-run-learning/infrastructure/reflector-port.adapter.ts",
  "qa-engine/src/contexts/evaluation/application/grade-run.use-case.ts",
  "qa-engine/src/contexts/evaluation/application/run-judges.use-case.ts",
  "qa-engine/src/contexts/generation/application/generate-tests.use-case.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/context-map-capture-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/context-trace.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/implementation-resources.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/pre-exec-grounding-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/adapters/review-port.adapter.ts",
  "qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts",
  "qa-engine/src/contexts/generation/infrastructure/context-pack.ts",
  "qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts",
  "qa-engine/src/contexts/generation/infrastructure/manifest-fs.ts",
  "qa-engine/src/contexts/generation/infrastructure/prompt-builders/context-assembler.ts",
  "qa-engine/src/contexts/generation/infrastructure/prompt-builders/model-window-catalog.ts",
  "qa-engine/src/contexts/generation/infrastructure/prompt-builders/review-render.ts",
  "qa-engine/src/contexts/generation/infrastructure/resilience/circuit-breaker.ts",
  "qa-engine/src/contexts/generation/infrastructure/sse/call-efficiency-tracker.ts",
  "qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts",
  "qa-engine/src/contexts/generation/infrastructure/telemetry/turn-probe.ts",
  "qa-engine/src/contexts/generation/infrastructure/telemetry/turn-trace-registry.ts",
  "qa-engine/src/contexts/generation/infrastructure/telemetry/with-turn-telemetry.ts",
  "qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts",
  "qa-engine/src/contexts/objective-signal/infrastructure/coverage-dump-reader.ts",
  "qa-engine/src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts",
  "qa-engine/src/contexts/run-orchestration/application/request-context-heal.use-case.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/failure-ends.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/failure-policy.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/finalize-run.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/execute.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/fix-loop.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/generate.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/generation-services.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/opening.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review-services.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/phases/setup.steps.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-flow/run-services.ts",
  "qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts",
  "qa-engine/src/contexts/run-orchestration/composition/build-run-orchestration.ts",
  "qa-engine/src/contexts/run-orchestration/domain/run-phase-cursor.ts",
  "qa-engine/src/contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/adapters/service-links-port.adapter.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/boundary-template.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/composite-resolver.adapter.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/glob-suffix.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/openapi-http-resolver.adapter.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/resolver-factory.ts",
  "qa-engine/src/contexts/service-topology/infrastructure/yaml-boundary-profile.adapter.ts",
  "qa-engine/src/contexts/test-execution/application/agent-browser.use-case.ts",
  "qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/agent-browser/playwright-agent-browser.host.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/report-spans.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/run-dump-bridge.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/spec-snapshot-validation.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts",
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts",
  "qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-scope-provider.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts",
  "qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter.ts",
  "qa-engine/src/shared-infrastructure/redaction/session-secrets.ts",
  "qa-engine/src/shared-infrastructure/repo-reader.ts",
  "qa-engine/src/shared-infrastructure/run-output-reader.ts",
  "qa-engine/src/shared-infrastructure/telemetry/run-spans.ts",
  "qa-engine/src/shared-kernel/telemetry/guarded-telemetry.ts",
  "src/agent-runtime/opencode-strategy.ts",
  "src/integrations/opencode-client.ts",
  "src/orchestrator/config-loader.ts",
  "src/server/agent-runtime.ts",
  "src/server/api-token.ts",
  "src/server/api/handlers/runs.ts",
  "src/server/api/handlers/system.ts",
  "src/server/api/respond.ts",
  "src/server/api/use-cases/continue-run.ts",
  "src/server/coordination-events.ts",
  "src/server/egress-wiring.ts",
  "src/server/evaluation-service.ts",
  "src/server/file-boundary-check.ts",
  "src/server/judge-adapters.ts",
  "src/server/judge-service.ts",
  "src/server/judges-composition.ts",
  "src/server/maintainer-runtime.ts",
  "src/server/plan-snapshot-sqlite.adapter.ts",
  "src/server/run-engine-factory.ts",
  "src/server/runner.ts",
  "src/server/spec-snapshot-sqlite.adapter.ts",
  "src/server/tools-endpoint.ts",
  "src/server/use-case-reference-loader.ts",
  "src/server/wire-app.ts",
  "src/telemetry/bootstrap.ts",
  "src/telemetry/host-health.ts",
  "src/telemetry/host-listeners.ts",
  "src/telemetry/langfuse-score-sink.ts",
  "src/telemetry/ledger.ts",
  "src/telemetry/otel-telemetry.adapter.ts",
  "src/telemetry/score-metrics-sink.ts",
];

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...productionSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

function callsConsole(path: string): boolean {
  return readFileSync(join(ROOT, path), "utf8")
    .split("\n")
    .some((line) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("/*") || code.startsWith("*")) return false;
      return CONSOLE_CALL.test(code);
    });
}

const calling = SCANNED.flatMap(productionSources)
  .filter(callsConsole)
  .map((path) => relative(".", path))
  .sort();

test("production code calls console only where the allow-list says", () => {
  const permitted = new Set([...ALLOWED, ...NOT_MIGRATED]);
  assert.deepEqual(
    calling.filter((path) => !permitted.has(path)),
    [],
    "log through LoggerPort (redacting-logger for the shell, the engine logger for contexts) instead of console",
  );
});

test("a file that no longer calls console is removed from the allow-list", () => {
  const stale = [...ALLOWED, ...NOT_MIGRATED].filter((path) => !calling.includes(path));
  assert.deepEqual(stale, []);
});
