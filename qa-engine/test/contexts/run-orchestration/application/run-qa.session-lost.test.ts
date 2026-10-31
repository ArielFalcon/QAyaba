/*
 * A judging execution whose failure page looks like the app's login page only asks whether the session it was given is gone; the
 * orchestrator's own check of the session answers (RFC-0015, ADR-0023 row 8). Shown lost: the run signs in again through its own
 * login and runs that execution once more, and the re-run is the judgment. Not shown lost: the first result stands and is judged as it
 * ran. A run that holds no saved session (an app with no login) never asks. A re-run that meets the login page with the session shown
 * gone again ends the run as E-PRECONDITION with the typed reason `session-lost`: recorded, never learned from, no Issue.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { ERROR_CLASS, type ErrorClass } from "@kernel/error-class.ts";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ExecutionOpts } from "@contexts/test-execution/domain/execution.ts";
import type { SessionCheck } from "@contexts/test-execution/application/index.ts";
import { AuthPreconditionError } from "@contexts/app-catalog/application/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { passingCases } from "../../../support/passing-cases.ts";

const INPUT = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual" as const, mode: "manual" as const, target: "e2e" as const, runId: "session-run" };

/* A test sent to the login page by a session the app ended. */
const ON_LOGIN: QaCase = { name: "a.spec.ts › opens the map", file: "a.spec.ts", status: "fail", detail: "expect(locator).toBeVisible() failed", finalUrl: "https://dev.example/login?next=%2Fmap", failureDom: 'heading: Sign in\ntextbox: "Password"' };
/* A test of the app's own public sign-in page that fails on its own assertion. */
const SIGN_IN_FORM_FAILS: QaCase = { name: "a.spec.ts › shows an error for a wrong password", file: "a.spec.ts", status: "fail", detail: "expect(getByRole('alert')).toHaveText('Wrong password') failed", finalUrl: "https://dev.example/login", failureDom: 'heading: Sign in\ntextbox: "Email"\ntextbox: "Password"' };
/* A failure on a change-password page: a password field, and no lost session. */
const CHANGE_PASSWORD_FAILS: QaCase = { name: "a.spec.ts › changes the password", file: "a.spec.ts", status: "fail", detail: "expect(getByRole('status')).toHaveText('Password updated') failed", finalUrl: "https://dev.example/account/security", failureDom: 'heading: Change password\ntextbox: "Current password"' };
const REAL_FAILURE: QaCase = { name: "a.spec.ts › opens the map", file: "a.spec.ts", status: "fail", detail: "expect(locator).toBeVisible() failed", finalUrl: "https://dev.example/map", failureDom: "heading: Map" };

const SPEC = 'import { test } from "./fixtures";\ntest("opens the map", async ({ page }) => {\n  await page.goto("/map");\n  await page.goto(`/shops/${id}`);\n});\n';

interface Seen {
  saved: RunOutcome[];
  asked: ExecutionOpts[];
  logins: string[];
  checked: string[][];
  published: Array<{ verdict: string; cases: string[] }>;
  audited: number;
}

interface Rig {
  /* What each judging execution of the suite returns, in order; once they are spent every execution passes. */
  results: QaCase[][];
  /* What each check of the session answers, in order; the last one repeats. Absent: the run has no session check. */
  checks?: SessionCheck[];
  /* The app declares a login, so its login leaves a saved session; false: an app with no login. */
  login?: boolean;
  /* What the run's login answers when it renews the session. */
  renewal?: "signs-in" | "precondition" | "fails";
}

function useCase(seen: Seen, rig: Rig): RunQaUseCase {
  const ws = runWorkspace("qa-session-");
  const results = [...rig.results];
  const checks = [...(rig.checks ?? [])];
  const login = rig.login ?? true;
  return new RunQaUseCase({
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "x", diff: "" }) },
    ...served(
      generationOnDisk({
        author: async (specDir: string) => {
          writeFileSync(join(specDir, "a.spec.ts"), SPEC);
          return scriptedGeneration({ specs: ["a.spec.ts"] });
        },
      } as never),
    ),
    review: { review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: {
      execute: async (dir: string, given?: AbortSignal | ExecutionOpts) => {
        const o = (given ?? {}) as ExecutionOpts;
        seen.asked.push(o);
        const next = results.shift();
        if (next) return { verdict: "fail", cases: next, logs: "" };
        return { verdict: "pass", cases: passingCases(dir, given), logs: "" };
      },
    },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: {
      publish: async (p: { verdict: string; cases?: QaCase[] }) => {
        seen.published.push({ verdict: p.verdict, cases: (p.cases ?? []).map((c) => `${c.name}:${c.status}`) });
        return { outcome: p.verdict === "pass" ? "pr" : "issue" };
      },
    },
    processAudit: { audit: async () => { seen.audited += 1; } },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async (outcome: RunOutcome) => { seen.saved.push(outcome); } },
    setup: { setup: async () => {} },
    authSession: {
      prepare: async (req: { phase: string }) => {
        seen.logins.push(req.phase);
        const renewing = seen.logins.filter((p) => p === "pre-execute").length > 1;
        if (renewing && rig.renewal === "precondition") throw new AuthPreconditionError("credentials-rejected", "the login form said the password is wrong", 5);
        if (renewing && rig.renewal === "fails") throw new Error("the login child crashed");
        /* What the auth adapter answers: a saved session for an app that declares a login, nothing for one that does not. */
        return login ? { unauthored: false, storageStatePath: "/auth/user.json" } : { unauthored: false };
      },
    },
    authContext: { baseUrl: "https://dev.example", ...(login ? { auth: { kind: "form" as const, usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } } : {}) },
    ...(rig.checks
      ? {
          sessionCheck: {
            check: async (paths: readonly string[]) => {
              seen.checked.push([...paths]);
              return checks.length > 1 ? checks.shift()! : checks[0]!;
            },
          },
        }
      : {}),
    config: { needsReview: false, maxRetries: 0 },
  } as unknown as ConstructorParameters<typeof RunQaUseCase>[0]);
}

/* The class of a run whose suite failed on the specs' own account. */
const EXEC_FAIL: ErrorClass = "E-EXEC-FAIL";

const fresh = (): Seen => ({ saved: [], asked: [], logins: [], checked: [], published: [], audited: 0 });
const LOST: SessionCheck = { state: "lost", detail: "the page ended on the login path /login" };
const HELD: SessionCheck = { state: "held" };

test("an app with no login has no session to lose: a failing test of its sign-in page is judged as it ran (fail, an Issue, its cases kept)", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[SIGN_IN_FORM_FAILS], [SIGN_IN_FORM_FAILS], [SIGN_IN_FORM_FAILS]], checks: [LOST], login: false }).run(INPUT);

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.errorClass, EXEC_FAIL);
  assert.deepEqual(seen.published.map((p) => p.verdict), ["fail"], "an Issue is opened");
  assert.deepEqual((seen.saved.at(-1)?.cases ?? []).map((c) => `${c.name}:${c.status}`), [`${SIGN_IN_FORM_FAILS.name}:fail`]);
  assert.equal(seen.saved.at(-1)?.adjudication?.reason === "session-lost", false);
  assert.deepEqual(seen.checked, [], "nothing is checked");
  assert.deepEqual(seen.logins, ["pre-generate", "pre-execute"], "nothing is renewed");
  assert.equal(seen.saved.at(-1)?.gateSignals?.executions?.runs.some((r) => r.sessionAgeMs !== undefined) ?? false, false, "no execution is told of a session");
});

test("a failure that looks like the login page, while the check finds the session still accepted, stands as the spec's own failure (fail, an Issue, its cases kept)", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[CHANGE_PASSWORD_FAILS], [CHANGE_PASSWORD_FAILS], [CHANGE_PASSWORD_FAILS]], checks: [HELD] }).run(INPUT);

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.errorClass, EXEC_FAIL);
  assert.deepEqual(seen.published.map((p) => p.verdict), ["fail"]);
  assert.deepEqual((seen.saved.at(-1)?.cases ?? []).map((c) => `${c.name}:${c.status}`), [`${CHANGE_PASSWORD_FAILS.name}:fail`]);
  assert.deepEqual(seen.logins, ["pre-generate", "pre-execute"], "the session is not renewed");
  assert.equal(seen.saved.at(-1)?.gateSignals?.executions?.sessionChecks?.held, seen.checked.length);
});

test("the check opens the pages the failing test asked for", async () => {
  const seen = fresh();
  await useCase(seen, { results: [[ON_LOGIN]], checks: [HELD] }).run(INPUT);

  assert.deepEqual(seen.checked[0], ["/map"], "a templated goto names no page");
});

test("a session the check shows lost is renewed through the run's own login, the execution runs once more, and the re-run is the judgment; both are recorded", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[ON_LOGIN]], checks: [LOST] }).run(INPUT);

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(seen.logins, ["pre-generate", "pre-execute", "pre-execute"]);
  assert.equal(seen.asked.length >= 2, true);
  const [first, second] = seen.asked;
  assert.ok((second!.session?.signedInAt ?? 0) >= (first!.session?.signedInAt ?? Infinity), "the re-run is told the renewed session");
  assert.deepEqual(seen.saved.at(-1)?.gateSignals?.executions?.sessionChecks, { lost: 1, held: 0, unknown: 0 });
});

test("a re-run that meets the login page with a session the check finds accepted is judged as it ran", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[ON_LOGIN], [ON_LOGIN], [ON_LOGIN], [ON_LOGIN]], checks: [LOST, HELD] }).run(INPUT);

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.errorClass, EXEC_FAIL);
  assert.deepEqual(seen.published.map((p) => p.verdict), ["fail"]);
});

test("a session shown gone again after the renewal ends the run as E-PRECONDITION with the reason session-lost: recorded, never learned from, no Issue", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[ON_LOGIN], [ON_LOGIN]], checks: [LOST, LOST] }).run(INPUT);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.asked.length, 2, "the execution is run once more, never again");
  assert.equal(seen.published.length, 0, "no Issue and no PR");
  assert.equal(seen.audited, 0, "nothing is learned");
  const saved = seen.saved.at(-1)!;
  assert.equal(saved.adjudication?.reason, "session-lost");
  assert.match(saved.note ?? "", /session/i);
});

test("a renewal whose login fails on a positive piece of evidence ends the run as the login before execute does: E-PRECONDITION, no session-lost", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[ON_LOGIN]], checks: [LOST], renewal: "precondition" }).run(INPUT);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.asked.length, 1, "nothing runs on a session that could not be renewed");
  assert.equal(seen.published.length, 0);
  assert.notEqual(seen.saved.at(-1)?.adjudication?.reason, "session-lost");
});

test("a renewal whose login crashes ends the run as an infrastructure error, as the login before execute does", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[ON_LOGIN]], checks: [LOST], renewal: "fails" }).run(INPUT);

  assert.equal(out.decision.verdict, "infra-error");
  assert.notEqual(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(seen.published.length, 0);
});

test("a failure that does not look like the login page is the spec's own: nothing is checked", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[REAL_FAILURE]], checks: [LOST] }).run(INPUT);

  assert.notEqual(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.deepEqual(seen.checked, []);
  assert.deepEqual(seen.logins, ["pre-generate", "pre-execute"]);
});

test("a run with no session check judges a login-page failure as it ran", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [[ON_LOGIN], [ON_LOGIN], [ON_LOGIN]] }).run(INPUT);

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.errorClass, EXEC_FAIL);
  assert.deepEqual(seen.logins, ["pre-generate", "pre-execute"]);
});

test("an app with no login that passes is judged pass, its executions told of no session", async () => {
  const seen = fresh();
  const out = await useCase(seen, { results: [], checks: [LOST], login: false }).run(INPUT);

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(seen.checked, []);
  assert.equal(seen.asked.every((o) => o.session === undefined), true);
});
