/* A secret injected in an evidence source must not survive in the serialized
   DelegationBrief, the DelegationResult, or the JSONL telemetry sink. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { evidenceFromChangeAnalysis } from "@contexts/coordination/application/evidence-from.ts";
import { FileCoordinationTelemetryAdapter } from "@contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts";
import { SidekickExecutor } from "@contexts/coordination/application/sidekick-executor.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import { PatternRedactionAdapter } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const SECRET = "token: ghs_supersecretvalue";

test("change-analysis evidence, the brief, and the JSONL sink redact an injected secret", () => {
  const evidence = evidenceFromChangeAnalysis(redaction, {
    action: "generate",
    reason: `type=feat; leak ${SECRET}`,
    fileCount: 9,
  });
  assert.doesNotMatch(evidence.summary, /ghs_supersecretvalue/);
  assert.match(evidence.summary, /\[REDACTED\]/);

  const brief = createDelegationBrief({ redaction,
    delegationId: "d1",
    runId: "r1",
    objective: `cover checkout with ${SECRET}`,
    task: `write smoke; leak ${SECRET}`,
    acceptanceCriteria: [`passes when ${SECRET} is absent`],
    scope: { readablePaths: ["e2e/"], writablePaths: ["e2e/"], allowedCommands: [] },
    knownFacts: [evidence],
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

test("an illegal write's replacement summary and concerns redact a secret-bearing path", async () => {
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
  const result = await new SidekickExecutor({ redaction, runtime }).execute(
    createDelegationBrief({ redaction,
      delegationId: "d1",
      runId: "r1",
      objective: "cover checkout",
      task: "write smoke",
      scope: { readablePaths: ["e2e/"], writablePaths: ["e2e/specs/"], allowedCommands: [] },
    }),
    { cwd: "/tmp/mirror", kind: "author" },
  );
  assert.equal(result.status, "blocked");
  assert.doesNotMatch(result.summary, /ghs_supersecretvalue/);
  assert.doesNotMatch(result.concerns.join("\n"), /ghs_supersecretvalue/);
});
