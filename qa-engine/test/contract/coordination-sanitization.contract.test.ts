/* A secret injected in an evidence source must not survive in the serialized
   DelegationBrief, the DelegationResult, or the JSONL telemetry sink. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDelegationBrief } from "@contexts/qa-run-orchestration/application/coordination/delegation-brief.ts";
import { evidenceFromChangeAnalysis } from "@contexts/qa-run-orchestration/application/coordination/evidence-from.ts";
import { FileCoordinationTelemetryAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/coordination-telemetry-port.adapter.ts";
import { SidekickExecutor } from "@contexts/qa-run-orchestration/application/coordination/sidekick-executor.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";

const SECRET = "token: ghs_supersecretvalue";

test("change-analysis evidence, the brief, and the JSONL sink redact an injected secret", () => {
  const evidence = evidenceFromChangeAnalysis({
    action: "generate",
    reason: `type=feat; leak ${SECRET}`,
    fileCount: 9,
  });
  assert.doesNotMatch(evidence.summary, /ghs_supersecretvalue/);
  assert.match(evidence.summary, /\[REDACTED\]/);

  const brief = createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: `cover checkout with ${SECRET}`,
    task: `write smoke; leak ${SECRET}`,
    acceptanceCriteria: [`passes when ${SECRET} is absent`],
    scope: { readablePaths: ["e2e/"], writablePaths: ["e2e/"], allowedCommands: [] },
    knownFacts: [evidence],
    validationPlan: [{ id: "v1", description: `check ${SECRET}` }],
  });
  assert.doesNotMatch(JSON.stringify(brief), /ghs_supersecretvalue/);

  const dir = mkdtempSync(join(tmpdir(), "coord-sanitize-"));
  const path = join(dir, "coordination-events.jsonl");
  const sink = new FileCoordinationTelemetryAdapter(path);
  sink.record({
    runId: "r1",
    kind: "escalation",
    reason: `deterministic contradiction: ${evidence.summary} plus raw ${SECRET}`,
    at: 1,
  });
  assert.doesNotMatch(readFileSync(path, "utf8"), /ghs_supersecretvalue/);
  assert.doesNotMatch(sink.events.map((e) => e.reason).join("\n"), /ghs_supersecretvalue/);
});

test("DelegationResult serialized after an illegal write still redacts secrets in the replacement summary", async () => {
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed",
          summary: "wrote it",
          filesChanged: [{ path: "vendor/token: ghs_supersecretvalue.txt" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        }),
      };
    },
    async dispose() {},
  };
  const runtime: Pick<AgentRuntimePort, "openSession"> = {
    async openSession() {
      return session;
    },
  };
  const result = await new SidekickExecutor({ runtime }).execute(
    createDelegationBrief({
      delegationId: "d1",
      runId: "r1",
      objective: "cover checkout",
      task: "write smoke",
      scope: { readablePaths: ["e2e/"], writablePaths: ["e2e/specs/"], allowedCommands: [] },
    }),
    { cwd: "/tmp/mirror", capability: "sidekick-standard" },
  );
  assert.equal(result.status, "blocked");
  assert.doesNotMatch(JSON.stringify(result), /ghs_supersecretvalue/);
});
