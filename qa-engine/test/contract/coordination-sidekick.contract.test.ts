import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDelegationBrief } from "@contexts/qa-run-orchestration/application/coordination/delegation-brief.ts";
import { existingWritableFiles } from "@contexts/qa-run-orchestration/application/coordination/existing-writable-files.ts";
import {
  resolveCapabilityRole,
  SidekickExecutor,
} from "@contexts/qa-run-orchestration/application/coordination/sidekick-executor.ts";
import { renderSidekickBrief } from "@contexts/qa-run-orchestration/application/coordination/sidekick-prompt.ts";
import {
  ACCEPTANCE_STATUSES,
  readAcceptanceReport,
} from "@contexts/qa-run-orchestration/application/coordination/acceptance-report.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

const scope = {
  readablePaths: ["e2e/"],
  writablePaths: ["e2e/specs/"],
  allowedCommands: ["npm test"],
};

function brief(overrides: { task?: string } = {}) {
  return createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "cover checkout",
    task: overrides.task ?? "write smoke spec",
    scope,
    acceptanceCriteria: ["checkout completes"],
  });
}

test("resolveCapabilityRole maps lead→primary and sidekicks→dedicated sidekick role without model names", () => {
  assert.equal(resolveCapabilityRole("lead"), "primary");
  assert.equal(resolveCapabilityRole("sidekick-standard"), "sidekick");
  assert.equal(resolveCapabilityRole("sidekick-escalated"), "sidekick");
});

test("renderSidekickBrief includes authority, scope, validation and escalation — not a lead transcript", () => {
  const { text, sectionSizes } = renderSidekickBrief(brief());
  assert.match(text, /write smoke spec/);
  assert.match(text, /checkout completes/);
  assert.match(text, /canExpandScope:\s*false/);
  assert.match(text, /e2e\/specs\//);
  assert.match(text, /onNeedsLead/);
  assert.equal(text.includes("LEAD TRANSCRIPT"), false);
  assert.ok(Object.keys(sectionSizes).length > 0);
});

/* Model-bound egress: sidekick prompt must scrub free-form brief fields the same way lead/worker
   prompts do via sanitizeText — secrets in guidance/commit message must not reach the provider.
 */
test("renderSidekickBrief redacts secrets in objective, task, knownFacts, and acceptance criteria", () => {
  const secret = "token: ghs_supersecretvalue";
  const { text } = renderSidekickBrief(
    createDelegationBrief({
      delegationId: "d1",
      runId: "r1",
      objective: `cover checkout with ${secret}`,
      task: `write smoke; leak ${secret}`,
      acceptanceCriteria: [`passes when ${secret} is absent`],
      scope,
      knownFacts: [
        {
          id: "f1",
          kind: "change-analysis",
          source: "test",
          summary: `generate; files=9: ${secret}`,
          confidence: "deterministic",
        },
      ],
    }),
  );
  assert.doesNotMatch(text, /ghs_supersecretvalue/);
  assert.match(text, /\[REDACTED\]/);
});

test("SidekickExecutor opens sidekick session, prompts, disposes, and parses DelegationResult", async () => {
  const prompts: string[] = [];
  let disposed = false;
  const session: AgentSession = {
    async prompt(text) {
      prompts.push(text);
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed",
          summary: "wrote smoke",
          filesChanged: [{ path: "e2e/specs/checkout.spec.ts" }],
          evidence: [],
          validation: [{ id: "v1", ok: true }],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
          acceptance: [{ criterion: 1, status: "met" }],
        }),
      };
    },
    async dispose() {
      disposed = true;
    },
  };
  const roles: AgentRole[] = [];
  const runtime: Pick<AgentRuntimePort, "openSession"> = {
    async openSession(role) {
      roles.push(role);
      return session;
    },
  };
  const executor = new SidekickExecutor({ runtime, render: renderSidekickBrief });
  const result = await executor.execute(brief(), {
    cwd: "/tmp/mirror",
    capability: "sidekick-standard",
  });
  assert.deepEqual(roles, ["sidekick"]);
  assert.equal(prompts.length, 1);
  assert.equal(disposed, true);
  assert.equal(result.status, "completed");
  assert.equal(result.delegationId, "d1");
  assert.equal(result.recommendation, "accept");
});

/* Free-form DelegationResult fields re-enter lead context / notes — scrub before they leave the
   executor boundary (same sanitizer twin as Issue/prompt egress elsewhere).
 */
test("SidekickExecutor redacts secrets in DelegationResult summary, concerns, and assumptions", async () => {
  const secret = "token: ghs_supersecretvalue";
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed-with-concerns",
          summary: `wrote smoke; saw ${secret}`,
          filesChanged: [{ path: "e2e/specs/checkout.spec.ts" }],
          evidence: [
            {
              id: "obs",
              kind: "agent-observation",
              source: "sidekick",
              summary: `DOM had ${secret}`,
              confidence: "observed",
            },
          ],
          validation: [],
          assumptions: [`env still has ${secret}`],
          concerns: [`selector near ${secret}`],
          unresolvedQuestions: [`why is ${secret} in the page?`],
          recommendation: "review",
        }),
      };
    },
    async dispose() {},
  };
  const executor = new SidekickExecutor({
    runtime: { openSession: async () => session },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), {
    cwd: "/tmp/mirror",
    capability: "sidekick-standard",
  });
  assert.equal(result.status, "completed-with-concerns");
  assert.doesNotMatch(result.summary, /ghs_supersecretvalue/);
  assert.doesNotMatch(result.concerns.join("\n"), /ghs_supersecretvalue/);
  assert.doesNotMatch(result.assumptions.join("\n"), /ghs_supersecretvalue/);
  assert.doesNotMatch(result.unresolvedQuestions.join("\n"), /ghs_supersecretvalue/);
  assert.doesNotMatch(result.evidence.map((e) => e.summary).join("\n"), /ghs_supersecretvalue/);
  assert.match(result.summary, /\[REDACTED\]/);
});

test("SidekickExecutor can send feedback on the same session before dispose", async () => {
  const prompts: string[] = [];
  const session: AgentSession = {
    async prompt(text) {
      prompts.push(text);
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed-with-concerns",
          summary: "fixed after feedback",
          filesChanged: [{ path: "e2e/specs/checkout.spec.ts" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: ["selector fragile"],
          unresolvedQuestions: [],
          recommendation: "review",
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
  const executor = new SidekickExecutor({ runtime, render: renderSidekickBrief });
  const result = await executor.execute(brief(), {
    cwd: "/tmp/mirror",
    capability: "sidekick-standard",
    feedback: "selectors must use getByRole",
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /getByRole/);
  assert.equal(result.status, "completed-with-concerns");
});

test("SidekickExecutor rejects a result for a foreign brief as failed", async () => {
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "OTHER",
          runId: "r1",
          status: "completed",
          summary: "spoof",
          filesChanged: [],
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
  const executor = new SidekickExecutor({
    runtime: { openSession: async () => session },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), { cwd: "/tmp", capability: "sidekick-standard" });
  assert.equal(result.status, "failed");
  assert.equal(result.recommendation, "escalate");
});

test("SidekickExecutor marks write outside writablePaths as blocked", async () => {
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed",
          summary: "escaped",
          filesChanged: [{ path: "src/app.ts" }],
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
  const executor = new SidekickExecutor({
    runtime: { openSession: async () => session },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), { cwd: "/tmp", capability: "sidekick-standard" });
  assert.equal(result.status, "blocked");
  assert.equal(result.recommendation, "escalate");
});

/* filesChanged is an authority input (scope check + on-disk adoption), not free-form prose: a
   redaction pass that rewrites a legitimate path makes the lead reject work the sidekick really did. */
test("SidekickExecutor adopts long camelCase and digit-bearing spec paths it wrote, while still redacting a secret in a concern", async () => {
  const written = [
    "e2e/specs/checkoutWithSavedCreditCardAndCoupon.spec.ts",
    "e2e/specs/orders/OrderHistoryPaginationAndFiltering2026.spec.ts",
    "e2e/specs/login.spec.ts",
  ];
  const mirror = mkdtempSync(join(tmpdir(), "sidekick-paths-"));
  try {
    for (const path of written) {
      mkdirSync(dirname(join(mirror, path)), { recursive: true });
      writeFileSync(join(mirror, path), "test('x', async () => {});\n");
    }
    const session: AgentSession = {
      async prompt() {
        return {
          output: JSON.stringify({
            delegationId: "d1",
            runId: "r1",
            status: "completed-with-concerns",
            summary: "wrote three specs",
            filesChanged: written.map((path) => ({ path })),
            evidence: [],
            validation: [],
            assumptions: [],
            concerns: ["login form echoed token: ghs_supersecretvalue in the DOM"],
            unresolvedQuestions: [],
            recommendation: "review",
          }),
        };
      },
      async dispose() {},
    };
    const executor = new SidekickExecutor({
      runtime: { openSession: async () => session },
      render: renderSidekickBrief,
    });
    const result = await executor.execute(brief(), { cwd: mirror, capability: "sidekick-standard" });

    assert.equal(result.status, "completed-with-concerns");
    const adopted = existingWritableFiles(mirror, result.filesChanged, scope.writablePaths).map((f) => f.path);
    assert.deepEqual([...adopted].sort(), [...written].sort());
    assert.doesNotMatch(result.concerns.join("\n"), /ghs_supersecretvalue/);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("SidekickExecutor passes escalated model via OpenSessionOpts without naming it in domain", async () => {
  let seenModel: string | undefined;
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "needs-lead",
          summary: "architecture ambiguous",
          filesChanged: [],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: ["which layout?"],
          recommendation: "escalate",
        }),
      };
    },
    async dispose() {},
  };
  const executor = new SidekickExecutor({
    runtime: {
      openSession: async (_role, _cwd, opts) => {
        seenModel = opts?.model;
        return session;
      },
    },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), {
    cwd: "/tmp",
    capability: "sidekick-escalated",
    model: "configured-externally",
  });
  assert.equal(seenModel, "configured-externally");
  assert.equal(result.status, "needs-lead");
});

/* ── the per-criterion acceptance report ─────────────────────────────────────────────────────── */

const TWO_CRITERIA = ["Failing cases pass on re-execute", "No writes outside scope"];

/* Runs the executor on one sidekick answer: the base answer is a clean completion, `fields` replace
   or (as undefined) remove any of its keys. */
async function executeWith(fields: Record<string, unknown>, criteria: readonly string[] = TWO_CRITERIA) {
  const answer: Record<string, unknown> = {
    delegationId: "d1",
    runId: "r1",
    status: "completed",
    summary: "fixed selectors",
    filesChanged: [{ path: "e2e/specs/login.spec.ts" }],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    ...fields,
  };
  const session: AgentSession = {
    async prompt() {
      return { output: JSON.stringify(answer) };
    },
    async dispose() {},
  };
  const executor = new SidekickExecutor({ runtime: { openSession: async () => session }, render: renderSidekickBrief });
  const repairBrief = createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "Repair failing QA specs",
    task: "Fix the failing tests",
    scope,
    acceptanceCriteria: criteria,
  });
  return executor.execute(repairBrief, { cwd: "/tmp", capability: "sidekick-standard" });
}

test("the executor keeps the sidekick's per-criterion acceptance report and its notes", async () => {
  const result = await executeWith({
    acceptance: [
      { criterion: 1, status: "unverified", note: "no test runner in scope" },
      { criterion: 2, status: "met" },
    ],
  });
  const byCriterion = new Map(result.acceptance.map((e) => [e.criterion, e]));
  assert.equal(byCriterion.get(1)?.status, "unverified");
  assert.match(byCriterion.get(1)?.note ?? "", /no test runner/);
  assert.equal(byCriterion.get(2)?.status, "met");
  assert.equal(result.acceptanceReportDefect, undefined);
  assert.equal(result.status, "completed");
});

test("a result without an acceptance report is a recorded contract defect, never a clean completion", async () => {
  const result = await executeWith({ acceptance: undefined, concerns: ["fails acceptance criterion 1"] });
  assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-missing");
  assert.deepEqual(result.acceptance, []);
  assert.equal(result.status, "completed-with-concerns");
  assert.ok(result.concerns.some((c) => c.startsWith("acceptance-report-missing")));
  assert.ok(result.concerns.includes("fails acceptance criterion 1"), "the sidekick's own concerns stay as notes");
});

test("an empty acceptance report for a brief with criteria is a missing report that names how many criteria went unreported", async () => {
  const result = await executeWith({ acceptance: [] });
  assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-missing");
  assert.match(result.acceptanceReportDefect?.detail ?? "", /\b2\b/);
});

test("an invalid report's defect names every unreported criterion and how many entries were malformed", async () => {
  const result = await executeWith(
    { acceptance: [{ criterion: 1, status: "met" }, { criterion: 1, status: "done" }] },
    ["first", "second", "third"],
  );
  const detail = result.acceptanceReportDefect?.detail ?? "";
  assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-invalid");
  assert.match(detail, /\b2\b/, "criterion 2 unreported");
  assert.match(detail, /\b3\b/, "criterion 3 unreported");
  assert.match(detail, /\b1\b/, "one malformed entry");
});

test("a malformed report entry that reports no unmet is a non-blocking defect and is not kept", async () => {
  for (const bad of [
    { criterion: 1.5, status: "met" },
    { criterion: 2.5, status: "met" },
    { criterion: "1", status: "met" },
    { criterion: 1, status: "done" },
    { criterion: 1, status: "Met" },
    { criterion: 1 },
    "criterion 1 met",
    null,
  ]) {
    const result = await executeWith({ acceptance: [{ criterion: 1, status: "met" }, { criterion: 2, status: "met" }, bad] });
    assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-invalid", JSON.stringify(bad));
    assert.equal(result.acceptance.length, 2, JSON.stringify(bad));
    assert.equal(result.status, "completed-with-concerns", JSON.stringify(bad));
  }
});

test("a report numbering criteria outside the brief's 1..N keeps no entry, so none is read as met", async () => {
  for (const outside of [
    { criterion: 0, status: "met" },
    { criterion: 3, status: "met" },
    { criterion: -1, status: "met" },
  ]) {
    const result = await executeWith({ acceptance: [outside, { criterion: 1, status: "met" }, { criterion: 2, status: "met" }] });
    assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-invalid", JSON.stringify(outside));
    assert.ok(result.acceptanceReportDefect?.detail.includes(String(outside.criterion)), "the defect names the number outside the brief's");
    assert.deepEqual(result.acceptance, [], JSON.stringify(outside));
    assert.equal(result.status, "completed-with-concerns", JSON.stringify(outside));
  }
});

test("an unmet the sidekick reports blocks the delegation whatever the shape of its report, naming the unmet", async () => {
  const shapes: { label: string; acceptance: unknown; named: RegExp }[] = [
    { label: "criterion as a numeral string", acceptance: [{ criterion: "1", status: "unmet" }, { criterion: 2, status: "met" }], named: /"1"/ },
    { label: "0-based numbering", acceptance: [{ criterion: 0, status: "unmet" }, { criterion: 1, status: "met" }], named: /\b0\b/ },
    { label: "a status in another case", acceptance: [{ criterion: 1, status: "Unmet" }, { criterion: 2, status: "met" }], named: /\b1\b/ },
    { label: "a status with padding", acceptance: [{ criterion: 1, status: " unmet " }, { criterion: 2, status: "met" }], named: /\b1\b/ },
    {
      label: "the criterion's text for its number",
      acceptance: [{ criterion: TWO_CRITERIA[0], status: "unmet" }, { criterion: 2, status: "met" }],
      named: new RegExp(TWO_CRITERIA[0]!),
    },
    { label: "a keyed object of statuses", acceptance: { "1": "unmet", "2": "met" }, named: /"1"/ },
    { label: "a keyed object of entries", acceptance: { "1": { status: "met" }, "2": { status: "UNMET" }, "3": null }, named: /"2"/ },
  ];
  for (const { label, acceptance, named } of shapes) {
    const result = await executeWith({ acceptance });
    assert.equal(result.status, "blocked", label);
    assert.equal(result.recommendation, "escalate", label);
    assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-invalid", label);
    assert.match(result.acceptanceReportDefect?.detail ?? "", named, label);
  }
});

test("a well-numbered unmet in a 0-based report still blocks although the report keeps no entry", async () => {
  const result = await executeWith({ acceptance: [{ criterion: 0, status: "met" }, { criterion: 1, status: "unmet" }] });
  assert.deepEqual(result.acceptance, []);
  assert.equal(result.status, "blocked");
});

test("a keyed report without an unmet is a non-blocking defect that reads no criterion as met", async () => {
  const result = await executeWith({ acceptance: { "1": "met", "2": "met" } });
  assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-invalid");
  assert.deepEqual(result.acceptance, []);
  assert.equal(result.status, "completed-with-concerns");
});

test("an acceptance report that is neither a list nor a keyed object is a missing report", async () => {
  for (const acceptance of ["all criteria met", null, 2]) {
    const result = await executeWith({ acceptance });
    assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-missing", JSON.stringify(acceptance));
    assert.equal(result.status, "completed-with-concerns", JSON.stringify(acceptance));
  }
});

test("a report that leaves a criterion out is a defect naming that criterion", async () => {
  const result = await executeWith({ acceptance: [{ criterion: 1, status: "met" }] });
  assert.equal(result.acceptanceReportDefect?.reason, "acceptance-report-invalid");
  assert.match(result.acceptanceReportDefect?.detail ?? "", /\b2\b/);
  assert.doesNotMatch(result.acceptanceReportDefect?.detail ?? "", /\b1\b/);
});

test("a brief without acceptance criteria needs no report", async () => {
  const result = await executeWith({ acceptance: undefined }, []);
  assert.equal(result.acceptanceReportDefect, undefined);
  assert.equal(result.status, "completed");
});

test("a report entry's note is scrubbed before it re-enters the lead context", async () => {
  const result = await executeWith({
    acceptance: [
      { criterion: 1, status: "unverified", note: "runner needs token: ghs_supersecretvalue" },
      { criterion: 2, status: "met" },
    ],
  });
  assert.doesNotMatch(result.acceptance.map((e) => e.note ?? "").join("\n"), /ghs_supersecretvalue/);
});

test("the brief numbers each acceptance criterion and asks for a report of every status by that number", () => {
  const { text } = renderSidekickBrief(
    createDelegationBrief({
      delegationId: "d1",
      runId: "r1",
      objective: "Repair failing QA specs",
      task: "Fix the failing tests",
      scope,
      acceptanceCriteria: TWO_CRITERIA,
    }),
  );
  assert.match(text, /^1\. Failing cases pass on re-execute$/m);
  assert.match(text, /^2\. No writes outside scope$/m);
  const example = /^\{"delegationId":.*\}$/m.exec(text)?.[0];
  assert.ok(example, "the brief carries the output example");
  /* The example writes each enum as its alternatives ("met"|"unmet"); read those as arrays. */
  const parsed = JSON.parse(example.replace(/"[^"]*"(?:\|"[^"]*")+/g, (alts) => `[${alts.split("|").join(",")}]`)) as {
    acceptance?: { criterion: unknown; status: string[] }[];
  };
  const acceptance = parsed.acceptance ?? [];
  assert.ok(acceptance.length > 0, "the example carries an acceptance report");
  for (const { criterion, status } of acceptance) {
    assert.deepEqual([...status].sort(), [...ACCEPTANCE_STATUSES].sort(), "the example names every status the executor reads");
    for (const one of status) {
      assert.equal(readAcceptanceReport([{ criterion, status: one }], acceptance.length).defect, undefined, one);
    }
  }
});
