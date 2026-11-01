/*
 * A failure whose page looks like a login page is judged as it ran, like any other (ADR-0023 row 8, amended): the run never asks
 * whether its session is gone, never renews it and never re-runs an execution for it. A public sign-in page, a change-password form,
 * a sign-up form, an auth callback or a search box labelled with a keyword field each fail on their own assertion and reach the fix
 * loop and the Issue with every case; a mutant whose code ends the session is a mutant like any other, and a green run publishes.
 * The session's age is the one thing kept: on the record, never acted on. Driven end to end through RunQaUseCase over a simulated app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { BundleMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts";
import { requestOriginClassifier } from "@kernel/observed-requests.ts";
import { executionConditions } from "@kernel/execution-conditions.ts";
import { purposeOfExecution } from "@kernel/exec-purpose.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { ok } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { reassignableGeneration, runWorkspace } from "../../../support/run-workspace.ts";
import { coordinatorOver } from "../../../support/coordinator-over-author.ts";
import { citingRejections } from "../../../support/cited-rejection.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { fakeHandle, rootsOf } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

type AnyObj = Record<string, any>;
const BASE = "https://dev.example";

interface Scenario {
  id: string;
  auth: "none" | "form";
  /* spec file -> the goto paths its source holds */
  files: Record<string, string[]>;
  /* the outcome of a file while the app accepts the session */
  genuine: (file: string) => AnyObj | "pass";
  /* the mutant's own code ends the app's session while its tests run */
  mutantEndsSession?: true;
}

const SIGN_IN_FAILS = (): AnyObj => ({ status: "fail", finalUrl: `${BASE}/login`, failureDom: 'heading: Sign in\ntextbox: "Email"\ntextbox: "Password"', detail: "expect(getByRole('alert')).toHaveText('Wrong password') failed" });
const CHANGE_PASSWORD_FAILS = (): AnyObj => ({ status: "fail", finalUrl: `${BASE}/account/security`, failureDom: 'heading: Change password\ntextbox: "Current password"\ntextbox: "New password"', detail: "expect(getByRole('status')).toHaveText('Password updated') failed" });
const ORDERS_FAIL = (): AnyObj => ({ status: "fail", finalUrl: `${BASE}/orders`, failureDom: "heading: Orders", detail: "expect(getByRole('row')).toHaveCount(3) failed" });

/* Failures whose page looks like a login page, of an app with a login unless said otherwise: each must stand as it ran. */
const FAILING: Scenario[] = [
  { id: "a change-password page failing beside a real failure", auth: "form", files: { "account.spec.ts": ["/account/security"], "orders.spec.ts": ["/orders"] }, genuine: (f) => (f === "account.spec.ts" ? CHANGE_PASSWORD_FAILS() : ORDERS_FAIL()) },
  { id: "a search box labelled with a keyword field", auth: "form", files: { "productos.spec.ts": ["/productos"] }, genuine: () => ({ status: "fail", finalUrl: `${BASE}/productos`, failureDom: 'heading: Productos\ntextbox: "Buscar por palabra clave"', detail: "expect(getByRole('listitem')).toHaveCount(5) failed" }) },
  { id: "a sign-up form", auth: "form", files: { "register.spec.ts": ["/register"] }, genuine: () => ({ status: "fail", finalUrl: `${BASE}/register`, failureDom: 'heading: Create account\ntextbox: "Email"\ntextbox: "Password"', detail: "expect(getByText('Welcome')).toBeVisible() failed" }) },
  { id: "a test that ends on an auth callback page", auth: "form", files: { "dash.spec.ts": ["/dashboard"] }, genuine: () => ({ status: "fail", finalUrl: `${BASE}/auth/callback`, failureDom: "heading: Welcome", detail: "expect(page).toHaveURL('/dashboard') failed" }) },
  { id: "a public sign-in page of an app with a login", auth: "form", files: { "signin.spec.ts": ["/login"] }, genuine: SIGN_IN_FAILS },
  { id: "a sign-in page of an app with no login", auth: "none", files: { "signin.spec.ts": ["/login"] }, genuine: SIGN_IN_FAILS },
  { id: "a password page beside a real failure, in an app with a login", auth: "form", files: { "account.spec.ts": ["/account/security"], "orders.spec.ts": ["/orders"] }, genuine: (f) => (f === "account.spec.ts" ? { ...CHANGE_PASSWORD_FAILS(), failureDom: 'heading: Security\ntextbox: "Password"' } : ORDERS_FAIL()) },
];

const specFilesOn = (root: string): string[] => (existsSync(root) ? readdirSync(root).filter((n) => n.endsWith(".spec.ts")).sort() : []);

interface Seen {
  out: AnyObj;
  saved: RunOutcome[];
  published: Array<{ verdict: string; cases: string[] }>;
  prepares: string[];
  purposes: string[];
}

async function runScenario(scn: Scenario): Promise<Seen> {
  const ws = runWorkspace("qa-login-page-");
  const sim = { valid: true };
  const seen: Omit<Seen, "out"> = { saved: [], published: [], prepares: [], purposes: [] };

  const author = async (specDir: string) => {
    for (const [f, gotos] of Object.entries(scn.files)) writeFileSync(join(specDir, f), `import { test } from "./fixtures";\ntest("runs", async ({ page }) => {\n${gotos.map((p) => `  await page.goto("${p}");`).join("\n")}\n});\n`);
    return scriptedGeneration({ specs: Object.keys(scn.files) });
  };
  const generation = reassignableGeneration(author as never);
  const caseOf = (file: string): AnyObj => {
    const name = `${file} › runs`;
    if (!sim.valid) return { name, file, status: "fail", finalUrl: `${BASE}/login?next=%2Forders`, failureDom: 'heading: Sign in\ntextbox: "Password"', detail: "locator.click: Timeout 8000ms exceeded" };
    const g = scn.genuine(file);
    return g === "pass" ? { name, file, status: "pass", expectedStatus: "passed" } : { name, file, ...g };
  };
  const execution = {
    execute: async (dir: string, given?: unknown) => {
      const o: AnyObj = given === undefined || given instanceof AbortSignal ? {} : (given as AnyObj);
      const purpose = purposeOfExecution(o);
      seen.purposes.push(purpose);
      if (purpose === "mutant" && scn.mutantEndsSession) sim.valid = false;
      const cases = [...(o.specFiles ?? specFilesOn(dir))].map((f: string) => caseOf(f));
      const conditions = executionConditions({ purpose, instrumentation: { coverage: o.coverage === true, observe: o.observe === true, route: o.mutant !== undefined, writeCounter: false }, specFiles: o.specFiles, processTimeoutMs: 900_000, ...(o.session ? { session: o.session } : {}), namespace: o.namespace ?? "ns", startedAt: Date.now() });
      return { verdict: cases.some((c) => c.status === "fail") ? "fail" : "pass", cases, logs: "", ...(o.observe ? { observations: [] } : {}), conditions };
    },
  };
  const signal = { status: "pass", ratio: 0.9, uncovered: [], untakenArms: [], measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1 } };
  const objectiveSignal: AnyObj = {
    measure: async (_br: unknown, _specDir: string, _diff: unknown, baselineCases: string[] | undefined, opts: AnyObj = {}) => {
      if (!scn.mutantEndsSession) return signal;
      const site = { file: "src/auth.ts", line: 10, column: 1, operator: "negate", script: { url: `${BASE}/main.js`, sha256: "0".repeat(64) }, edit: { start: 0, end: 1, replacement: "!a" }, original: "a", ranIn: [] };
      return { ...signal, mutationPass: { mutants: [{ site, specFiles: ["orders.spec.ts"], tests: ["orders-spec-ts-runs"] }], selection: {}, judgedAgainst: baselineCases ?? [], namespace: `${opts.namespace ?? "ns"}`, sources: [], changeDiff: "", changedFiles: ["src/auth.ts"], executed: { executableLines: 10 }, caseFiles: ["orders.spec.ts"], ...(opts.firstObservation ? { firstObservation: opts.firstObservation } : {}) } };
    },
    measureMutation: async (pass: AnyObj, specDir: string, opts: AnyObj = {}) => {
      const result = await new BundleMutationOracleAdapter(undefined, () => 1, BASE, requestOriginClassifier(["https://dev.example", "https://api.maps.example"])).measure(pass.mutants, specDir, pass.namespace, pass.judgedAgainst, { observe: true, ...(pass.firstObservation ? { before: pass.firstObservation } : {}), rerun: opts.rerun });
      return { ...signal, ...(result ? { bundleMutation: { applied: result.applied, killed: result.killed, survived: result.survived } } : {}) };
    },
    blocks: () => false,
  };
  const deps: AnyObj = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches the change", diff: "diff --git a/src/auth.ts b/src/auth.ts\n+changed\n" }) },
    generation,
    leadSidekicks: coordinatorOver(generation),
    review: { review: citingRejections(async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true })) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution,
    objectiveSignal,
    publication: { publish: async (d: AnyObj) => { seen.published.push({ verdict: d.verdict, cases: (d.cases ?? []).map((c: AnyObj) => `${c.name}:${c.status}`).sort() }); return { outcome: d.verdict === "pass" ? "pr" : "issue" }; } },
    workspace: { readRoots: rootsOf, prepare: async () => fakeHandle({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
    specFiles: confinedSpecFiles,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async (outcome: RunOutcome) => { seen.saved.push(outcome); } },
    setup: { setup: async () => {} },
    cleanup: { cleanup: async () => {} },
    suiteStore: ws.suiteStore,
    processAudit: { audit: async () => {} },
    authSession: {
      prepare: async (req: AnyObj) => {
        seen.prepares.push(req?.phase ?? "?");
        return scn.auth === "form" ? { storageStatePath: "/x/storageState.json", unauthored: false } : { unauthored: false };
      },
    },
    authContext: { baseUrl: BASE, ...(scn.auth === "form" ? { auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS", loginPath: "/login" } } : {}) },
    config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, coveragePolicyMode: "signal" },
  };
  try {
    const out = await new RunQaUseCase(deps as never).run({ app: "demo", sha: Sha.of("abc1234"), changeSet: primaryChangeSet("demo", Sha.of("abc1234")), source: "manual", mode: "diff", target: "e2e", runId: "login-page" } as never);
    return { out, ...seen };
  } finally {
    ws.cleanup?.();
  }
}

for (const scn of FAILING) {
  test(`${scn.id} fails on its own assertion and stands as it ran: fail, an Issue with every case, no renewal`, async () => {
    const seen = await runScenario(scn);
    const everyCase = Object.keys(scn.files).map((f) => `${f} › runs:fail`).sort();

    assert.equal(seen.out.decision.verdict, "fail");
    assert.equal(seen.out.errorClass, "E-EXEC-FAIL");
    assert.deepEqual(seen.published, [{ verdict: "fail", cases: everyCase }]);
    assert.deepEqual((seen.saved.at(-1)?.cases ?? []).map((c) => `${c.name}:${c.status}`).sort(), everyCase);
    assert.deepEqual(seen.prepares, ["pre-generate", "pre-execute"], "the run signs in once before executing, and never again");
  });
}

test("a mutant whose code ends the app's session is judged like any other, and the green run publishes", async () => {
  const seen = await runScenario({ id: "mutant", auth: "form", files: { "orders.spec.ts": ["/orders"] }, genuine: () => "pass", mutantEndsSession: true });
  const last = seen.saved.at(-1)!;

  assert.equal(seen.out.decision.verdict, "pass");
  assert.deepEqual(seen.published.map((p) => p.verdict), ["pass"], "a PR");
  assert.equal(seen.purposes.filter((p) => p === "mutant").length, 1, "the mutant ran once");
  assert.equal(last.gateSignals.bundleMutation?.killed, 1, "its failing test is a kill, as at the baseline");
  assert.deepEqual(seen.prepares, ["pre-generate", "pre-execute"]);
  assert.ok(last.gateSignals.executions?.runs.every((r) => typeof r.sessionAgeMs === "number"), "every execution after the login records the session's age");
});
