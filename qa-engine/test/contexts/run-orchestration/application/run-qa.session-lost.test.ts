/* A judging execution that failed on the login wall judged nothing about the specs (RFC-0015): the run renews its session through its own login and runs that execution once more; a second wall ends the run as E-PRECONDITION with the typed reason `session-lost`, recorded, never learned from and with no Issue. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ExecutionOpts } from "@contexts/test-execution/domain/execution.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { passingCases } from "../../../support/passing-cases.ts";

const INPUT = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual" as const, mode: "manual" as const, target: "e2e" as const, runId: "session-run" };

const ON_LOGIN: QaCase = { name: "a.spec.ts › opens the map", file: "a.spec.ts", status: "fail", detail: "expect(locator).toBeVisible() failed", finalUrl: "https://dev.example/login?next=%2Fmap", failureDom: 'heading: Sign in\ntextbox: "Password"' };
const REAL_FAILURE: QaCase = { name: "a.spec.ts › opens the map", file: "a.spec.ts", status: "fail", detail: "expect(locator).toBeVisible() failed", finalUrl: "https://dev.example/map", failureDom: "heading: Map" };

interface Seen {
  saved: RunOutcome[];
  asked: ExecutionOpts[];
  logins: string[];
  published: number;
  audited: number;
}

/* `walls` judging executions in a row end on the login page; every later one passes. */
function useCase(seen: Seen, opts: { walls: number; signsIn?: boolean; after?: QaCase }): RunQaUseCase {
  const ws = runWorkspace("qa-session-");
  let walls = opts.walls;
  return new RunQaUseCase({
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "x", diff: "" }) },
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["a.spec.ts"] }) })),
    review: { review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: {
      execute: async (dir, given) => {
        const o = (given ?? {}) as ExecutionOpts;
        seen.asked.push(o);
        if (walls > 0) {
          walls -= 1;
          return { verdict: "fail", cases: [ON_LOGIN], logs: "" };
        }
        if (opts.after) return { verdict: "fail", cases: [opts.after], logs: "" };
        return { verdict: "pass", cases: passingCases(dir, given), logs: "" };
      },
    },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => { seen.published += 1; return { outcome: "pr" }; } },
    processAudit: { audit: async () => { seen.audited += 1; } },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async (outcome) => { seen.saved.push(outcome); } },
    setup: { setup: async () => {} },
    ...(opts.signsIn === false
      ? {}
      : { authSession: { prepare: async (req: { phase: string }) => { seen.logins.push(req.phase); return { unauthored: false }; } }, authContext: { baseUrl: "https://dev.example" } }),
    config: { needsReview: false },
  } as ConstructorParameters<typeof RunQaUseCase>[0]);
}

const fresh = (): Seen => ({ saved: [], asked: [], logins: [], published: 0, audited: 0 });

test("a judging execution that ended on the login wall is run once more after the run signs in again, and its second result is the verdict", async () => {
  const seen = fresh();
  const out = await useCase(seen, { walls: 1 }).run(INPUT);

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(seen.logins, ["pre-generate", "pre-execute", "pre-execute"], "the session is renewed through the run's own login");
  assert.equal(seen.asked.length, 2);
  const [first, second] = seen.asked;
  assert.ok((second!.session?.signedInAt ?? 0) >= (first!.session?.signedInAt ?? Infinity), "the re-run is told the renewed session");
});

test("a second login wall ends the run as E-PRECONDITION with the reason session-lost: recorded, never learned from, no Issue", async () => {
  const seen = fresh();
  const out = await useCase(seen, { walls: 2 }).run(INPUT);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.asked.length, 2, "the execution is run once more, never again");
  assert.equal(seen.published, 0, "no Issue and no PR");
  assert.equal(seen.audited, 0, "nothing is learned");
  const saved = seen.saved.at(-1)!;
  assert.equal(saved.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(saved.adjudication?.reason, "session-lost");
  assert.match(saved.note ?? "", /session/i);
});

test("a failure that is not on the login wall is the spec's own and is not run again", async () => {
  const seen = fresh();
  const out = await useCase(seen, { walls: 0, after: REAL_FAILURE }).run(INPUT);

  assert.notEqual(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.ok(!seen.logins.slice(2).length, "no renewal for a failure of the spec");
});

test("a run that signs no one in has no session to lose: a login page is the spec's failure", async () => {
  const seen = fresh();
  const out = await useCase(seen, { walls: 1, signsIn: false }).run(INPUT);

  assert.notEqual(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.saved.at(-1)?.adjudication?.reason === "session-lost", false);
});
