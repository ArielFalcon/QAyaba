/* A run keeps the suite it proved and starts the next one from it: restore between the checkout and the setup, capture after an accepted decision, and a restored login that no longer works gives way to the stock one. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { RunQaUseCase, type RunQaConfig, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { AuthSession, AuthSessionRequest } from "@contexts/app-catalog/application/index.ts";
import type { SuiteCaptureInput, SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import { UntrustedGitTreeError } from "../../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import { AuthPreconditionError, PRECONDITION_KIND } from "@contexts/app-catalog/domain/auth-precondition.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
import { fakeHandle, rootsOf } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
const INPUT = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual" as const, mode: "diff" as const, target: "e2e" as const, runId: "suite-run" };
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const PASSING: QaCase[] = [
  { name: "a", status: "pass", file: "flows/a.spec.ts" },
  { name: "b", status: "pass", file: "./flows/b.spec.ts" },
  { name: "no file", status: "pass" },
];

interface Rig {
  events: string[];
  captured: SuiteCaptureInput[];
  demoted: string[];
  store: SuiteStorePort;
  ws: RunWorkspace;
  /** Rewrites a spec file, as a regeneration would. */
  write(file: string, text: string): void;
  deps(over?: Partial<RunQaUseCaseDeps>): RunQaUseCaseDeps;
}

function rig(opts: { authRestored?: boolean; restoreThrows?: Error; captureThrows?: Error } = {}): Rig {
  const ws = runWorkspace("qa-suite-");
  ws.write("flows/a.spec.ts", "a v1");
  ws.write("flows/b.spec.ts", "b v1");
  const events: string[] = [];
  const captured: SuiteCaptureInput[] = [];
  const demoted: string[] = [];
  const store: SuiteStorePort = {
    fingerprint: async (_root, specs) => {
      events.push("fingerprint");
      return new Map(specs
        .map((spec) => spec.replace(/^\.\//, ""))
        .filter((spec) => ws.has(spec))
        .map((spec) => [spec, sha256(readFileSync(join(ws.specDir, spec), "utf8"))] as const));
    },
    restore: async () => {
      events.push("restore");
      if (opts.restoreThrows) throw opts.restoreThrows;
      return { restored: 3, trackedWins: 0, overlaid: 0, authRestored: opts.authRestored ?? false };
    },
    capture: async (input) => {
      events.push("capture");
      captured.push(input);
      if (opts.captureThrows) throw opts.captureThrows;
      return { entries: 1, admitted: 1, dropped: 0, skipped: [] };
    },
    demoteAuth: async (_root, reason) => {
      events.push("demote");
      demoted.push(reason);
    },
  };
  const deps = (over: Partial<RunQaUseCaseDeps> = {}): RunQaUseCaseDeps => {
    const { generation: generationOver, ...rest } = over;
    return {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    ...served(generationOnDisk(generationOver ?? { author: async () => scriptedGeneration({ specs: ["flows/a.spec.ts"]}) })),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => ({ verdict: "pass", cases: PASSING, logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => (events.push("publish"), { outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: { readRoots: rootsOf, prepare: async () => (events.push("prepare"), fakeHandle({ specDir: ws.specDir, mirrorDir: ws.mirrorDir })) },
    specFiles: confinedSpecFiles,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async () => {} },
    setup: { setup: async () => void events.push("setup") },
    suiteStore: store,
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
    ...rest,
    };
  };
  return { events, captured, demoted, store, ws, write: (file, text) => ws.write(file, text), deps };
}

const withConfig = (config: Partial<RunQaConfig>): Partial<RunQaUseCaseDeps> => ({ config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, ...config } });

test("the suite is restored after the checkout and before the project setup", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.deepEqual(r.events.slice(0, 3), ["prepare", "restore", "setup"]);
});

test("a code run, a context run and a run that ends at classification never touch the e2e suite store", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps(withConfig({ isCode: true }))).run({ ...INPUT, target: "code" });
  assert.equal(code.events.includes("restore") || code.events.includes("capture"), false, "code");

  const context = rig();
  await new RunQaUseCase(context.deps({ ...served({ author: async () => scriptedGeneration({ specs: [".qa/context.json"], note: "map" }) }) })).run({ ...INPUT, mode: "context" });
  assert.equal(context.events.includes("restore") || context.events.includes("capture"), false, "context");

  const skipped = rig();
  await new RunQaUseCase(skipped.deps({ changeAnalysis: { classify: async () => ({ action: "skip", reason: "docs only", diff: "" }) } })).run(INPUT);
  assert.equal(skipped.events.includes("restore"), false, "classify-skip spends nothing on the suite");
});

test("an accepted run captures its suite before the pull request is opened, with the specs that ran green", async () => {
  const r = rig();
  const out = await new RunQaUseCase(r.deps()).run(INPUT);

  assert.equal(out.decision.sideEffect, "pr");
  assert.deepEqual(r.events.filter((e) => e === "capture" || e === "publish"), ["capture", "publish"]);
  assert.equal(r.captured.length, 1);
  assert.deepEqual({ ...r.captured[0], executedGreen: [...r.captured[0]!.executedGreen].sort() }, {
    mirrorDir: r.ws.mirrorDir,
    specDir: r.ws.specDir,
    runId: "suite-run",
    sha: "abc1234",
    executedGreen: [["flows/a.spec.ts", sha256("a v1")]],
  });
});

test("a spec the reviewer's correction round rewrote is executed by its acceptance and captured with the bytes it now holds", async () => {
  const r = rig();
  let reviews = 0;
  let executions = 0;
  const out = await new RunQaUseCase(r.deps({
    ...served({
      author: async (_specDir, _signal, _diff, enrichment) => {
        if (enrichment?.reviewCorrections !== undefined) r.write("flows/a.spec.ts", "a v2, executed by acceptance");
        return scriptedGeneration({ specs: ["flows/a.spec.ts"]});
      },
    }),
    review: { review: async () => (reviews++ === 0 ? { approved: false, corrections: ["assert the total"], blockingCount: 1, parsed: true } : { approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    execution: { execute: async () => (executions++, { verdict: "pass", cases: PASSING, logs: "" }) },
  })).run(INPUT);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(executions, 2, "the first pass and the corrected spec's acceptance");
  assert.equal(r.captured.length, 1);
  const green = r.captured[0]!.executedGreen;
  assert.equal(green.get("flows/a.spec.ts"), sha256("a v2, executed by acceptance"), "the hash is that of the bytes the acceptance executed");
});

test("a fingerprint that cannot be taken fails the run closed: the store cannot prove the bytes it would publish", async () => {
  const r = rig();
  r.store.fingerprint = async () => {
    throw new Error("EIO");
  };
  const out = await new RunQaUseCase(r.deps()).run(INPUT);

  assert.equal(out.decision.verdict, "infra-error");
  assert.match(out.note ?? "", /could not fingerprint/);
  assert.equal(r.events.includes("publish"), false);
  assert.equal(r.captured.length, 0);
});

test("a shadow run that publishes nothing still keeps the suite it proved", async () => {
  const r = rig();
  const out = await new RunQaUseCase(r.deps(withConfig({ shadow: true }))).run(INPUT);
  assert.equal(out.decision.sideEffect, "shadow-log");
  assert.equal(r.captured.length, 1);
});

test("a run that is not accepted keeps nothing: a failed or flaky verdict, a rejected review, a coverage block", async () => {
  const cases: Array<[string, Partial<RunQaUseCaseDeps>]> = [
    ["fail", { execution: { execute: async () => ({ verdict: "fail", cases: [{ name: "a", status: "fail", file: "flows/a.spec.ts" }], logs: "" }) } }],
    ["flaky", { execution: { execute: async () => ({ verdict: "flaky", cases: [{ name: "a", status: "flaky", file: "flows/a.spec.ts" }], logs: "" }) } }],
    ["rejected", { review: { review: async () => ({ approved: false, corrections: ["x"], blockingCount: 1, parsed: true }) } }],
    ["coverage block", { objectiveSignal: { measure: async () => ({ status: "fail", ratio: 0.1 }), blocks: () => true } }],
  ];
  for (const [name, over] of cases) {
    const r = rig();
    await new RunQaUseCase(r.deps({ ...over, ...served({ author: async () => scriptedGeneration({ specs: ["flows/a.spec.ts"]}) }) })).run({ ...INPUT, runId: `not-accepted-${name}` });
    assert.equal(r.captured.length, 0, name);
  }
});

test("a capture that throws changes neither the verdict nor the publication", async () => {
  const r = rig({ captureThrows: new Error("ENOSPC: no space left on device") });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(r.events.includes("publish"), true);
});

test("a restore that throws leaves a cold run, and a cold run cannot publish: no proof was seeded", async () => {
  const r = rig({ restoreThrows: new Error("manifest is not valid JSON") });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "infra-error");
  assert.match(out.note ?? "", /found no proof/);
  assert.equal(r.captured.length, 0);
  assert.equal(r.events.includes("publish"), false);
});

test("a git dir that is not the orchestrator's is a security refusal, never an off-path fault", async () => {
  const r = rig({ restoreThrows: new UntrustedGitTreeError("/tmp/qa-suite is owned by another user") });
  await assert.rejects(() => new RunQaUseCase(r.deps()).run(INPUT), UntrustedGitTreeError);
});

test("the login that signed in at the pre-execute step is the one the capture is told to admit", async () => {
  const r = rig({ authRestored: true });
  const phases: string[] = [];
  const authSession = {
    prepare: async (req: AuthSessionRequest): Promise<AuthSession> => {
      phases.push(req.phase);
      return req.phase === "pre-execute" ? { unauthored: false, setupSha256: "f".repeat(64) } : { unauthored: false };
    },
  };
  await new RunQaUseCase(r.deps({ authSession, authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } } })).run(INPUT);
  assert.equal(r.captured[0]?.authVerifiedSha256, "f".repeat(64));
  assert.deepEqual(phases, ["pre-generate", "pre-execute"]);
});

test("without a login that signed in, the capture is told of none", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ authSession: { prepare: async () => ({ unauthored: true }) }, authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } } })).run(INPUT);
  assert.equal("authVerifiedSha256" in r.captured[0]!, false);
});

test("a restored login that fails before generation is demoted, the stock one seeded again, and the login tried once more", async () => {
  const r = rig({ authRestored: true });
  const attempts: string[] = [];
  const authSession = {
    prepare: async (req: AuthSessionRequest): Promise<AuthSession> => {
      attempts.push(`${req.phase}${r.events.includes("demote") ? "-after-demote" : ""}`);
      if (req.phase === "pre-generate" && !r.events.includes("demote")) throw new Error("auth setup failed: login form not found");
      return { unauthored: true };
    },
  };
  const out = await new RunQaUseCase(r.deps({ authSession, authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } } })).run(INPUT);

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(r.events.filter((e) => e !== "capture" && e !== "publish" && e !== "fingerprint"), ["prepare", "restore", "setup", "demote", "setup"]);
  assert.equal(r.demoted.length, 1);
  assert.doesNotMatch(r.demoted[0]!, /login form not found/, "the reason names the cause in general; the login's own output is not kept");
  assert.deepEqual(attempts.slice(0, 2), ["pre-generate", "pre-generate-after-demote"]);
});

test("a login that fails again after the demotion ends the run as before, and one the store did not restore is never demoted", async () => {
  const failing = { prepare: async (): Promise<AuthSession> => { throw new Error("auth setup failed: nope"); } };
  const ctx = { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } } as const;

  const restored = rig({ authRestored: true });
  const first = await new RunQaUseCase(restored.deps({ authSession: failing, authContext: ctx })).run(INPUT);
  assert.equal(first.decision.verdict, "infra-error");
  assert.equal(restored.demoted.length, 1, "demoted once, not in a loop");

  const own = rig({ authRestored: false });
  const second = await new RunQaUseCase(own.deps({ authSession: failing, authContext: ctx })).run(INPUT);
  assert.equal(second.decision.verdict, "infra-error");
  assert.equal(own.demoted.length, 0, "the app's own login keeps today's behaviour");
});

test("a restored login that fails because the egress filter refused its hosts is kept, not replaced: the run ends E-PRECONDITION naming them, with no Issue and nothing learned", async () => {
  const r = rig({ authRestored: true });
  const attempts: string[] = [];
  const authSession = {
    prepare: async (req: AuthSessionRequest): Promise<AuthSession> => {
      attempts.push(req.phase);
      throw new AuthPreconditionError(PRECONDITION_KIND.EGRESS_DENIED, "the egress filter refused the login's browser 1 host(s): idp.example.test. Declare their origins in dev.allowedOrigins", 30_000);
    },
  };
  let folded = 0;
  const out = await new RunQaUseCase(r.deps({
    authSession,
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } },
    learning: { fold: async () => void (folded += 1), retrieve: async () => [] },
  })).run(INPUT);

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.PRECONDITION);
  assert.match(out.note ?? "", /idp\.example\.test/);
  assert.match(out.note ?? "", /dev\.allowedOrigins/);
  assert.equal(r.demoted.length, 0, "the stored login is not thrown away for a network reason");
  assert.deepEqual(attempts, ["pre-generate"], "no second login with the stock seed");
  assert.equal(r.events.filter((e) => e === "setup").length, 1);
  assert.equal(r.events.includes("publish"), false, "no Issue, no PR");
  assert.equal(folded, 0);
});

test("a run without a suite store has no proof and fails closed before deciding", async () => {
  const r = rig();
  const { suiteStore: _omitted, ...without } = r.deps();
  const out = await new RunQaUseCase(without).run(INPUT);
  assert.equal(out.decision.verdict, "infra-error");
  assert.match(out.note ?? "", /found no proof/);
  assert.equal(out.decision.sideEffect, "none");
  assert.equal(r.events.includes("restore") || r.events.includes("capture") || r.events.includes("fingerprint"), false);
});
