/*
 * Every way a run can end, one row each: how the rig is set up to reach the end, and what the run is observed to be when it gets
 * there. `verdict` is the run's decision (`threw` when `run()` rejected), `errorClass` the class it carries, `furthestPhase` the last
 * phase it entered, `persisted` whether a run record was saved, `published` the decision's side effect (`none` for a run that threw),
 * `publishCalled` whether publication was dispatched at all, `folded` whether learning received the outcome and `reflected` whether
 * the reflector ran.
 * A new end adds a row here.
 */
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AuthPreconditionError, PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import { ProbeSweepError } from "@contexts/qa-run-orchestration/application/run-flow/phases/generation-services.ts";
import { activeExecScope, type ExecScopePort } from "../../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { createExecSandbox, SandboxUnavailableError } from "../../../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { createExecScopeProvider } from "../../../../../src/shared-infrastructure/process-sandbox/exec-scope-provider.ts";
import { UntrustedGitTreeError } from "../../../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import type { EndReason } from "@contexts/qa-run-orchestration/application/run-flow/run-end.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import type { ReviewPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { scriptedGeneration } from "../../../../support/generation-output.ts";
import { RIG_SPEC, scratchDir, type Rig } from "./run-end-rig.ts";

export type Published = "none" | "pr" | "issue" | "quarantine" | "shadow-log";

export interface RunEndExpectation {
  verdict: string;
  errorClass: string | null;
  furthestPhase: string | null;
  persisted: boolean;
  published: Published;
  publishCalled: boolean;
  folded: boolean;
  reflected: boolean;
  note?: RegExp;
}

export interface RunEndRow {
  id: string;
  /** Why the run ended; absent for the runs that ended on an error nothing handled. */
  endReason?: EndReason;
  setup: (rig: Rig) => void;
  expect: RunEndExpectation;
}

const FORM_AUTH = { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } as const;
const AUTH_CONTEXT = { baseUrl: "https://dev.example", auth: FORM_AUTH };
const REJECTED_LOGIN = { kind: PRECONDITION_KIND.CREDENTIALS_REJECTED, note: "the login was rejected", ms: 1200 } as const;
const DEADLINE_BUDGET_MS = 600_000;

const abortFrom = (rig: Rig): void => rig.abort.abort();

/* The store the composition puts behind a run, with the calls a row scripts: `fingerprint` sees the call number and the real answer. */
function scriptedStore(rig: Rig, script: { fingerprint?: (call: number, real: ReadonlyMap<string, string>) => ReadonlyMap<string, string>; restoreAuth?: boolean }): SuiteStorePort {
  const real = rig.ws.suiteStore;
  let calls = 0;
  return {
    restore: async (root) => {
      const restored = await real.restore(root);
      return script.restoreAuth ? { ...restored, authRestored: true } : restored;
    },
    fingerprint: async (root, specs) => {
      calls += 1;
      const answer = await real.fingerprint(root, specs);
      return script.fingerprint ? script.fingerprint(calls, answer) : answer;
    },
    capture: (input) => real.capture(input),
    demoteAuth: script.restoreAuth ? async () => {} : (root, reason) => real.demoteAuth(root, reason),
  };
}

const withFingerprint = (rig: Rig, fingerprint: (call: number, real: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
  rig.store = scriptedStore(rig, { fingerprint });
};

const otherBytes = (real: ReadonlyMap<string, string>): ReadonlyMap<string, string> => new Map([...real].map(([file]) => [file, "0".repeat(64)]));

const reviewerDown: ReviewPort["review"] = async () => ({
  approved: false,
  corrections: [],
  rationale: "reviewer unavailable: the reviewer session failed",
  parsed: false,
  unavailable: true,
});

const DISPUTED_FINDING = "[wrong-objective] checkout.spec.ts: the discount is never asserted";

function refusedFinding(rig: Rig): void {
  const spec = "flows/checkout.spec.ts";
  let turn = 0;
  rig.config = { ...rig.config, reviewLoopIntegrity: true };
  rig.execute = async () => ({ verdict: "pass", cases: [{ name: "checkout", file: spec, status: "pass" }], logs: "" });
  rig.review = async () => ({
    approved: false,
    corrections: [DISPUTED_FINDING],
    severities: ["blocking" as const],
    citations: [{ kind: "execution" as const, ref: spec }],
    blockingCount: 1,
    parsed: true,
  });
  rig.generate = async () => {
    turn += 1;
    if (turn === 1) {
      rig.ws.write(spec, "test('checkout', async () => {});\n");
      return scriptedGeneration({ specs: [spec], approved: true });
    }
    return scriptedGeneration({ specs: [], approved: true, rebuttals: [{ finding: DISPUTED_FINDING, basis: "execution", ref: "flows/absent.spec.ts", reason: "the case passed" }] as never });
  };
}

const sandboxScope = (rig: Rig): ExecScopePort => createExecScopeProvider({ workRoot: scratchDir(rig, "qa-run-end-scope-"), sandbox: null, egress: { dev: [], install: [] } });

/* What the egress filter records while a child runs: the host it refused is the evidence a run that dies on an error leaves behind. */
function refuseHost(host: string): void {
  const report = activeExecScope()!.report;
  report.egress = "enforced";
  report.denied.push(host);
}

const deadline = (role: string): RunDeadlineExceededError => new RunDeadlineExceededError(DEADLINE_BUDGET_MS, "diff-tiny", role, "mid-turn");

const failLoginAt = (rig: Rig, phase: "pre-generate" | "pre-execute", error: () => Error): void => {
  rig.extra = {
    ...rig.extra,
    authSession: { prepare: async (req) => { if (req.phase === phase) throw error(); return { unauthored: false }; } },
    authContext: AUTH_CONTEXT,
  };
};

export const RUN_END_ROWS: readonly RunEndRow[] = [
  { id: "aborted-at-gate", endReason: "aborted", setup: (rig) => abortFrom(rig), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: null, persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "gate-never-serves-sha", endReason: "deploy-gate-failed", setup: (rig) => { rig.waitUntilServing = async () => ({ ok: false, error: new Error("DEV did not serve sha abc1234 within 5000ms") }); }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "gate", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /DEV did not serve sha/ } },
  { id: "classify-skip", endReason: "classify-skipped", setup: (rig) => { rig.classify = async () => ({ action: "skip", reason: "docs-only commit", diff: "" }); }, expect: { verdict: "skipped", errorClass: null, furthestPhase: "classify", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "aborted-after-workspace", endReason: "aborted", setup: (rig) => { rig.prepare = async () => { abortFrom(rig); return { specDir: rig.ws.specDir, mirrorDir: rig.ws.mirrorDir }; }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "classify", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "aborted-during-setup", endReason: "aborted", setup: (rig) => { rig.setup = async () => { abortFrom(rig); }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "setup", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "aborted-during-ground", endReason: "aborted", setup: (rig) => { rig.extra = { ...rig.extra, preGenerationGrounding: { ground: async () => { abortFrom(rig); return {}; } } }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "ground", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "aborted-during-generate", endReason: "aborted", setup: (rig) => { rig.generate = async () => { abortFrom(rig); return scriptedGeneration({ specs: [RIG_SPEC], approved: true }); }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "health", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "aborted-during-validate", endReason: "aborted", setup: (rig) => { rig.validate = async () => { abortFrom(rig); return { ok: true, errors: [] }; }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "health", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "aborted-during-execute", endReason: "aborted", setup: (rig) => { rig.execute = async () => { abortFrom(rig); return { verdict: "pass", cases: [], logs: "" }; }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "execute", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "setup-failed", endReason: "setup-failed", setup: (rig) => { rig.setup = async () => { throw new Error("npm ci in e2e failed (code 1)"); }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "setup", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /npm ci in e2e failed/ } },
  {
    id: "login-replacement-failed",
    endReason: "auth-failed",
    setup: (rig) => {
      let setups = 0;
      rig.store = scriptedStore(rig, { restoreAuth: true });
      rig.setup = async () => { setups += 1; if (setups > 1) throw new Error("setup failed again"); };
      rig.extra = { ...rig.extra, authSession: { prepare: async () => { throw new Error("login did not sign in"); } }, authContext: AUTH_CONTEXT };
    },
    expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "setup", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /stored login was replaced/ },
  },
  { id: "auth-preparation-failed", endReason: "auth-failed", setup: (rig) => failLoginAt(rig, "pre-generate", () => new Error("login failed")), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "setup", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /login failed/ } },
  { id: "precondition-failed-before-generation", endReason: "login-precondition", setup: (rig) => failLoginAt(rig, "pre-generate", () => new AuthPreconditionError(REJECTED_LOGIN.kind, REJECTED_LOGIN.note, REJECTED_LOGIN.ms)), expect: { verdict: "infra-error", errorClass: "E-PRECONDITION", furthestPhase: "setup", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "precondition-failed-before-execute", endReason: "pre-execute-infra", setup: (rig) => failLoginAt(rig, "pre-execute", () => new AuthPreconditionError(REJECTED_LOGIN.kind, REJECTED_LOGIN.note, REJECTED_LOGIN.ms)), expect: { verdict: "infra-error", errorClass: "E-PRECONDITION", furthestPhase: "health", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "auth-preparation-failed-before-execute", endReason: "pre-execute-infra", setup: (rig) => failLoginAt(rig, "pre-execute", () => new Error("login form not found")), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "health", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false, note: /login form not found/ } },
  { id: "generation-no-decision", endReason: "generation-ended-without-specs", setup: (rig) => { rig.generate = async () => scriptedGeneration({ specs: [], approved: false, end: GENERATION_END.UNDECIDED_EMPTY, note: "no decision" }); }, expect: { verdict: "infra-error", errorClass: "E-NO-DECISION", furthestPhase: "generate", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "generation-step-budget", endReason: "generation-ended-without-specs", setup: (rig) => { rig.generate = async () => scriptedGeneration({ specs: [], approved: false, end: GENERATION_END.EXHAUSTED, note: "step budget" }); }, expect: { verdict: "infra-error", errorClass: "E-STEP-BUDGET", furthestPhase: "generate", persisted: true, published: "none", publishCalled: false, folded: true, reflected: true } },
  { id: "generation-time-budget", endReason: "generation-ended-without-specs", setup: (rig) => { rig.generate = async () => scriptedGeneration({ specs: [], approved: false, end: GENERATION_END.TIME_BUDGET, note: "time budget" }); }, expect: { verdict: "infra-error", errorClass: "E-TIME-BUDGET", furthestPhase: "generate", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "generation-empty-output", endReason: "generation-empty-output", setup: (rig) => { rig.generate = async () => scriptedGeneration({ specs: [], approved: false, parsed: false, note: "" }); }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "generate", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /generation produced no parseable output/ } },
  { id: "agent-declared-noop", endReason: "generation-noop", setup: (rig) => { rig.generate = async () => scriptedGeneration({ specs: [], approved: true, end: GENERATION_END.DECLARED_NOOP, note: "nothing in this change is worth a test" }); }, expect: { verdict: "skipped", errorClass: null, furthestPhase: "generate", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "static-gate-invalid", endReason: "static-gate-failed", setup: (rig) => { rig.validate = async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }); }, expect: { verdict: "invalid", errorClass: "E-STATIC", furthestPhase: "validate", persisted: true, published: "issue", publishCalled: true, folded: true, reflected: true, note: /no-wait-for-timeout/ } },
  { id: "static-gate-invalid-context-mode", endReason: "static-gate-failed", setup: (rig) => { rig.input = { mode: "context" }; rig.generate = async () => scriptedGeneration({ specs: [".qa/context.json"], approved: true }); rig.validate = async () => ({ ok: false, errors: ["[manifest] unreadable"] }); }, expect: { verdict: "invalid", errorClass: null, furthestPhase: "validate", persisted: false, published: "issue", publishCalled: true, folded: false, reflected: false } },
  { id: "static-gate-infra", endReason: "pre-execute-infra", setup: (rig) => { rig.validate = async () => ({ ok: false, errors: ["playwright: browser binary missing"], infra: true }); }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "validate", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false, note: /browser binary missing/ } },
  {
    id: "dev-precondition-before-execute",
    endReason: "pre-execute-infra",
    setup: (rig) => {
      let calls = 0;
      rig.waitUntilServing = async () => { calls += 1; return calls === 1 ? { ok: true as const, value: true } : { ok: false as const, error: new Error("DEV went down mid-run") }; };
    },
    expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "health", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false, note: /DEV went down mid-run/ },
  },
  { id: "reviewer-unavailable", endReason: "reviewer-unavailable", setup: (rig) => { rig.review = reviewerDown; }, expect: { verdict: "infra-error", errorClass: "E-REVIEWER-UNAVAILABLE", furthestPhase: "review", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "review-disputed", endReason: "review-disputed", setup: (rig) => refusedFinding(rig), expect: { verdict: "infra-error", errorClass: "E-REVIEW-DISPUTED", furthestPhase: "review", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false, note: /could not settle/ } },
  { id: "final-proof-fingerprint-throws", endReason: "final-proof-guard", setup: (rig) => withFingerprint(rig, (call, real) => { if (call === 2) throw new Error("store unreadable"); return real; }), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /could not fingerprint the delivered specs/ } },
  { id: "final-proof-missing", endReason: "final-proof-guard", setup: (rig) => withFingerprint(rig, (call, real) => (call === 1 ? new Map() : real)), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /found no proof for/ } },
  {
    id: "final-proof-bytes-unreadable",
    endReason: "final-proof-guard",
    setup: (rig) => withFingerprint(rig, (call, real) => { if (call === 1) rmSync(join(rig.ws.specDir, RIG_SPEC)); return real; }),
    expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /holds no proven bytes to restore/ },
  },
  {
    id: "final-proof-restore-fails",
    endReason: "final-proof-guard",
    setup: (rig) => withFingerprint(rig, (call, real) => {
      if (call !== 2) return real;
      chmodSync(rig.ws.specDir, 0o555);
      rig.onDispose.push(() => { if (existsSync(rig.ws.specDir)) chmodSync(rig.ws.specDir, 0o755); });
      return otherBytes(real);
    }),
    expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /could not restore/ },
  },
  {
    id: "final-proof-no-store-to-verify",
    endReason: "final-proof-guard",
    setup: (rig) => {
      withFingerprint(rig, (call, real) => (call === 2 ? otherBytes(real) : real));
      const store = rig.store;
      let fingerprints = 0;
      const counting: SuiteStorePort = { ...store!, fingerprint: async (root, specs) => { fingerprints += 1; return await store!.fingerprint(root, specs); } };
      rig.store = counting;
      rig.shape = (deps) => Object.defineProperty({ ...deps }, "suiteStore", { enumerable: true, get: () => (fingerprints >= 2 ? undefined : counting) });
    },
    expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /no suite store is composed/ },
  },
  { id: "final-proof-verification-throws", endReason: "final-proof-guard", setup: (rig) => withFingerprint(rig, (call, real) => { if (call === 2) return otherBytes(real); if (call === 3) throw new Error("store unreadable"); return real; }), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /could not verify the restored/ } },
  { id: "final-proof-bytes-still-differ", endReason: "final-proof-guard", setup: (rig) => withFingerprint(rig, (call, real) => (call === 2 || call === 3 ? otherBytes(real) : real)), expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "review", persisted: false, published: "none", publishCalled: false, folded: false, reflected: false, note: /still differ from the proven ones/ } },
  { id: "publication-failed-after-decision", endReason: "publication-failed", setup: (rig) => { rig.publish = async () => { throw new Error("github 502"); }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "publish", persisted: false, published: "none", publishCalled: true, folded: false, reflected: false, note: /publication failed after verdict was decided/ } },
  { id: "run-deadline", endReason: "run-deadline", setup: (rig) => { rig.generate = async () => { throw deadline("primary"); }; }, expect: { verdict: "infra-error", errorClass: "E-TIME-BUDGET", furthestPhase: "generate", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "sandbox-unavailable-at-open", endReason: "sandbox-unavailable", setup: (rig) => { rig.extra = { ...rig.extra, execScope: { open: async () => { throw new SandboxUnavailableError("residue", "1 process of the sandbox uid survived SIGKILL"); } } }; }, expect: { verdict: "infra-error", errorClass: "E-SANDBOX", furthestPhase: null, persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  {
    id: "sandbox-unavailable-mid-run",
    endReason: "sandbox-unavailable",
    setup: (rig) => {
      const exec = createExecSandbox({ sandbox: null, mode: "required", baseEnv: {}, warn: () => {} });
      rig.extra = { ...rig.extra, execScope: sandboxScope(rig) };
      rig.execute = async () => { exec.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite" }); return { verdict: "pass", cases: [], logs: "" }; };
    },
    expect: { verdict: "infra-error", errorClass: "E-SANDBOX", furthestPhase: "execute", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false },
  },
  { id: "probe-sweep-failed", endReason: "probe-sweep-failed", setup: (rig) => { rig.generate = async () => { throw new ProbeSweepError("EACCES"); }; }, expect: { verdict: "infra-error", errorClass: "E-INFRA", furthestPhase: "generate", persisted: true, published: "none", publishCalled: false, folded: false, reflected: false, note: /probes could not be removed/ } },
  { id: "unhandled-error-with-evidence", setup: (rig) => { rig.extra = { ...rig.extra, execScope: sandboxScope(rig) }; rig.execute = async () => { refuseHost("idp.example.test"); throw new Error("provider error"); }; }, expect: { verdict: "threw", errorClass: null, furthestPhase: null, persisted: true, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "unhandled-error-without-evidence", setup: (rig) => { rig.execute = async () => { throw new Error("provider error"); }; }, expect: { verdict: "threw", errorClass: null, furthestPhase: null, persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "untrusted-git-tree", setup: (rig) => { rig.classify = async () => { throw new UntrustedGitTreeError("refusing to run git on /mirrors/org__app/.git: it is a symbolic link"); }; }, expect: { verdict: "threw", errorClass: null, furthestPhase: null, persisted: false, published: "none", publishCalled: false, folded: false, reflected: false } },
  { id: "context-pass-clean", endReason: "context-pass", setup: (rig) => { rig.input = { mode: "context" }; rig.generate = async () => scriptedGeneration({ specs: [".qa/context.json"], approved: true, note: "built map" }); }, expect: { verdict: "pass", errorClass: null, furthestPhase: "publish", persisted: false, published: "pr", publishCalled: true, folded: false, reflected: false } },
  { id: "decided-pass-pr", endReason: "decided", setup: () => {}, expect: { verdict: "pass", errorClass: null, furthestPhase: "learn", persisted: true, published: "pr", publishCalled: true, folded: true, reflected: false } },
  { id: "decided-pass-shadow", endReason: "decided", setup: (rig) => { rig.config = { ...rig.config, shadow: true }; }, expect: { verdict: "pass", errorClass: null, furthestPhase: "learn", persisted: true, published: "shadow-log", publishCalled: true, folded: true, reflected: false } },
  { id: "decided-fail-issue", endReason: "decided", setup: (rig) => { rig.execute = async () => ({ verdict: "fail", cases: [{ name: "checkout", status: "fail" }], logs: "expect(received).toBe(expected)" }); }, expect: { verdict: "fail", errorClass: "E-EXEC-FAIL", furthestPhase: "learn", persisted: true, published: "issue", publishCalled: true, folded: true, reflected: true } },
  { id: "decided-flaky-quarantine", endReason: "decided", setup: (rig) => { rig.execute = async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" }], logs: "" }); }, expect: { verdict: "flaky", errorClass: "E-FLAKY", furthestPhase: "learn", persisted: true, published: "quarantine", publishCalled: true, folded: true, reflected: false } },
  { id: "coverage-blocks-publish", endReason: "decided", setup: (rig) => { rig.config = { ...rig.config, coveragePolicyMode: "enforce" }; rig.measure = async () => ({ status: "fail", ratio: 0.2 }); rig.blocks = () => true; }, expect: { verdict: "pass", errorClass: "E-COVERAGE-GAP", furthestPhase: "learn", persisted: true, published: "issue", publishCalled: true, folded: true, reflected: true } },
  { id: "review-rejected", endReason: "decided", setup: (rig) => { rig.review = async () => ({ approved: false, corrections: ["[blocking] asserts nothing"], blockingCount: 1, parsed: true }); }, expect: { verdict: "pass", errorClass: "E-FALSE-POSITIVE", furthestPhase: "learn", persisted: true, published: "issue", publishCalled: true, folded: true, reflected: true } },
];
