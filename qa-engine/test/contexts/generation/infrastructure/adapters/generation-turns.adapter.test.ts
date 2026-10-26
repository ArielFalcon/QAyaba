/* test/contexts/run-orchestration/infrastructure/adapters/generation-turns.adapter.test.ts
   GenerationTurnsAdapter must delegate to the REAL GenerateTestsUseCase.author()
   and map {specs, reviewed, approved, note} -> {specs, approved, note}. specSources is populated from
   a file-read collaborator (file I/O stays OUTSIDE the domain, per fix-loop.aggregate.ts's own
   FixLoopGenerateResult.specSources contract) — absent/empty when the read collaborator is absent.
   reexploreNavigations has NO real sibling counter (confirmed absent under generation/) so this adapter
   omits it — the FixLoop's own documented contract treats absent as 0 (the safe default), never a
   fabricated number.
 */
import type { RetrievedRule } from "@kernel/learned-rule";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationTurnsAdapter } from "@contexts/generation/infrastructure/adapters/generation-turns.adapter.ts";
import { ConfinedPathError, readConfinedSpecFile, type SpecRoot } from "../../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { callEfficiencyTracker } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { formatSuiteEntry } from "@contexts/generation/domain/suite-entry.ts";
import { withoutWaitingOnNamedPipe } from "../../../../support/named-pipe-watch.ts";
import type { AuthoringPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { StepLimitRole } from "@contexts/generation/domain/generation-input.ts";
import type { GenerationEnrichment } from "@contexts/generation/application/index.ts";
import type { TestTarget } from "@kernel/run-mode.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import {
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  specFileForFlow,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { setAgentsConfigPath } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { rosterFixturePath } from "../../../../support/roster-fixture.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

function fakeAuthoringPorts(overrides: {
  generatorOutput?: string;
  reviewerOutput?: string;
} = {}): AuthoringPorts {
  return {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: overrides.generatorOutput ?? "generator-json" }),
        dispose: async () => {},
      }),
    } as unknown as AuthoringPorts["runtime"],
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "prompt", sectionSizes: {} }),
      renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }),
      specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/checkout.spec.ts"], note: "ok" }),
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_specDir, entries) => [...entries],
    },
    budget: {
      capDiff: (d: string) => d,
      capText: (t: string) => t,
      budgetForRole: () => 1000,
    },
  };
}

test("author() delegates to GenerateTestsUseCase and maps GenerationResult onto the port shape", async () => {
  const ports = fakeAuthoringPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.author("/mirrors/org/app/e2e");

  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
  assert.equal(result.note, "ok");
});

const STATIC_CONTEXT = {
  repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234", target: "e2e" as TestTarget, mode: "diff" as const, diff: "",
};

const TESTED_METAS = { specs: ["flows/checkout.spec.ts"], parsed: true, specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "the user pays", targets: [] }] };

test("author() publishes no specMetas unless the run requires a review", async () => {
  const ports = fakeAuthoringPorts();
  ports.verdicts.parseGenerator = () => TESTED_METAS;
  const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(ports), { ...STATIC_CONTEXT });
  const result = await adapter.author("/mirrors/org/app/e2e");
  assert.equal("specMetas" in result, false);
  assert.deepEqual(result.specs, TESTED_METAS.specs);
});

test("author() publishes the manifest's flow and objective when the run requires a review", async () => {
  const ports = fakeAuthoringPorts();
  ports.verdicts.parseGenerator = () => TESTED_METAS;
  const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(ports), { ...STATIC_CONTEXT, reviewRequired: true });
  const result = await adapter.author("/mirrors/org/app/e2e");
  assert.deepEqual(result.specMetas, [{ flow: "checkout", objective: "the user pays" }]);
});

test("author() forwards how the generation ended", async () => {
  const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(fakeAuthoringPorts()), { ...STATIC_CONTEXT});
  const result = await adapter.author("/mirrors/org/app/e2e");
  assert.equal(result.end, GENERATION_END.DELIVERED);
});

test("author() forwards an exhausted generation's end, its note and the main turn's stats", async () => {
  const ports = fakeAuthoringPorts();
  const exhausting: AuthoringPorts = {
    ...ports,
    runtime: {
      openSession: async () => ({
        prompt: async (_text: string, opts?: { onTurnStats?: (s: { maxSteps: number | null; stepsUsed: number | null; exhausted: boolean | null; writeCount: number | null; observationComplete: boolean }) => void }) => {
          opts?.onTurnStats?.({ maxSteps: 30, stepsUsed: 30, exhausted: true, writeCount: 0, observationComplete: true });
          return { output: "Maximum steps for this agent have been reached." };
        },
        dispose: async () => {},
      }),
    } as unknown as AuthoringPorts["runtime"],
    verdicts: { ...ports.verdicts, parseGenerator: () => ({ specs: [], parsed: true, outputTail: "cut off" }) },
  };
  const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(exhausting), { ...STATIC_CONTEXT});
  const result = await adapter.author("/mirrors/org/app/e2e");
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
  assert.equal(result.turn?.stepsUsed, 30);
  assert.equal(result.turn?.writeCount, 0);
  assert.match(result.note ?? "", /30\/30/);
});

test("author() populates specSources from an injected file-read collaborator (absent by default), handing it the run's spec root and each reported path", async () => {
  const ports = fakeAuthoringPorts();
  ports.verdicts.parseGenerator = () => ({ specs: ["flows/checkout.spec.ts", "login.spec.ts"], note: "ok" });
  const useCase = new GenerateTestsUseCase(ports);
  const calls: Array<{ root: SpecRoot; reported: string }> = [];
  const readSpecSource = (root: SpecRoot, reported: string): string => {
    calls.push({ root, reported });
    return `// source of ${reported}`;
  };
  const adapter = new GenerationTurnsAdapter(
    useCase,
    { repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "" },
    { readSpecSource },
  );

  const result = await adapter.author("/mirrors/org/app/e2e");

  assert.deepEqual(result.specSources, ["// source of flows/checkout.spec.ts", "// source of login.spec.ts"]);
  const root = { mirrorDir: "/mirrors/org/app", specDir: "/mirrors/org/app/e2e" };
  assert.deepEqual(calls, [
    { root, reported: "flows/checkout.spec.ts" },
    { root, reported: "login.spec.ts" },
  ]);
});

test("author() roots the spec reads at the spec directory of the call, which for a code run is the mirror itself", async () => {
  const roots: SpecRoot[] = [];
  const adapter = new GenerationTurnsAdapter(
    new GenerateTestsUseCase(fakeAuthoringPorts()),
    { ...STATIC_CONTEXT},
    { readSpecSource: (root) => { roots.push(root); return ""; } },
  );

  await adapter.author("/mirrors/org/app");

  assert.deepEqual(roots, [{ mirrorDir: "/mirrors/org/app", specDir: "/mirrors/org/app" }]);
});

/* The reader the composition root defaults to. The agent writes the spec files and names them in its verdict, so what it reports can be a symlink it planted: the adapter must surface that as the typed error, never hand the target's content on as a spec source. */
function withMirror(run: (dirs: { tmp: string; mirror: string; specDir: string }) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-gen-port-confinement-"));
  const mirror = join(tmp, "mirror");
  const specDir = join(mirror, "e2e");
  mkdirSync(join(specDir, "flows"), { recursive: true });
  writeFileSync(join(tmp, "secret.txt"), "TOP SECRET");
  return run({ tmp, mirror, specDir }).finally(() => rmSync(tmp, { recursive: true, force: true }));
}

test("author() reads the delivered specs through the confined reader: a file inside the spec directory is a source", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(specDir, "flows", "checkout.spec.ts"), "// the real spec\n");
    const adapter = new GenerationTurnsAdapter(
      new GenerateTestsUseCase(fakeAuthoringPorts()),
      { ...STATIC_CONTEXT, mirrorDir: mirror},
      { readSpecSource: readConfinedSpecFile },
    );

    const result = await adapter.author(specDir);

    assert.deepEqual(result.specSources, ["// the real spec\n"]);
  }));

test("author() fails with the typed error, naming the reported path, when a delivered spec is a symlink that leaves the spec directory", () =>
  withMirror(async ({ tmp, mirror, specDir }) => {
    symlinkSync(join(tmp, "secret.txt"), join(specDir, "flows", "checkout.spec.ts"));
    const adapter = new GenerationTurnsAdapter(
      new GenerateTestsUseCase(fakeAuthoringPorts()),
      { ...STATIC_CONTEXT, mirrorDir: mirror},
      { readSpecSource: readConfinedSpecFile },
    );

    await assert.rejects(adapter.author(specDir), (err: unknown) => err instanceof ConfinedPathError && err.path === "flows/checkout.spec.ts");
  }));

test("author() fails with the typed error when a delivered spec climbs out of the spec directory", () =>
  withMirror(async ({ mirror, specDir }) => {
    const ports = fakeAuthoringPorts();
    ports.verdicts.parseGenerator = () => ({ specs: ["../../secret.txt"], note: "ok" });
    const adapter = new GenerationTurnsAdapter(
      new GenerateTestsUseCase(ports),
      { ...STATIC_CONTEXT, mirrorDir: mirror},
      { readSpecSource: readConfinedSpecFile },
    );

    await assert.rejects(adapter.author(specDir), (err: unknown) => err instanceof ConfinedPathError && err.path === "../../secret.txt");
  }));

test("author() omits specSources when no readSpecSource collaborator is injected", async () => {
  const ports = fakeAuthoringPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.author("/mirrors/org/app/e2e");

  assert.equal(result.specSources, undefined);
});

test("author() never reports re-exploration counts, however much navigation the call-efficiency tracker recorded during the turn", async (t) => {
  const sessionId = "sess-navigation-heavy";
  t.after(() => callEfficiencyTracker.clear(sessionId));
  /* The stream of tool events a real turn produces, recorded while the generator turn runs. */
  const runtime = {
    openSession: async () => ({
      /* A real session carries its id, which is what anything that reads the tracker per session would use. */
      id: sessionId,
      prompt: async () => {
        callEfficiencyTracker.attach(sessionId, "/mirrors/org/app");
        for (let i = 0; i < 25; i++) {
          callEfficiencyTracker.record({
            type: "message.part.updated",
            properties: {
              part: {
                id: `prt-${i}`, sessionID: sessionId, messageID: "m", type: "tool", callID: `call-${i}`,
                tool: "playwright_browser_navigate", state: { status: "completed", input: { url: `http://dev/${i}` }, output: "ok" },
              },
            },
          });
        }
        return { output: "generator-json" };
      },
      dispose: async () => {},
    }),
  } as unknown as AuthoringPorts["runtime"];
  const useCase = new GenerateTestsUseCase({ ...fakeAuthoringPorts(), runtime });
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.author("/mirrors/org/app/e2e");

  assert.equal("reexploreNavigations" in result, false, "measuring calls must not activate the progress gate's re-exploration signal");
  assert.equal(callEfficiencyTracker.take(sessionId, "")?.totalCalls, 25, "the tracker really held the navigation the signal could have been fed with");
});

/* already forwards opts?.signal into runtime.openSession(role, mirrorDir, { signal }) for BOTH the
   missing link. It must declare + forward the signal into GenerateTestsUseCase.author(input,
   opts), or the queue's AbortSignal is silently dropped before it ever reaches the agent session.
 */

test("author() forwards an AbortSignal into GenerateTestsUseCase.author()'s GenerateOpts", async () => {
  const controller = new AbortController();
  const capturedSignals: (AbortSignal | undefined)[] = [];
  const ports = fakeAuthoringPorts();
  ports.runtime.openSession = async (_role, _mirrorDir, opts) => {
    capturedSignals.push(opts?.signal);
    return {
      prompt: async () => ({ output: "generator-json" }),
      dispose: async () => {},
    };
  };
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
  });

  await adapter.author("/mirrors/org/app/e2e", controller.signal);

  assert.ok(capturedSignals.length > 0, "openSession must have been called at least once");
  for (const captured of capturedSignals) {
    assert.equal(captured, controller.signal, "the SAME AbortSignal instance passed to author() must reach GenerateTestsUseCase's own opts.signal, not be dropped at the adapter");
  }
});

test("author() with no signal at all behaves exactly as before (no third-arg regression)", async () => {
  const ports = fakeAuthoringPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.author("/mirrors/org/app/e2e");

  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
});

/* Production constructs this adapter BEFORE the run/checkout, so the STATIC ctx.diff supplied at
   composition time is always "". This adapter must accept the run's ACTUAL diff as a fourth
   author() argument and PREFER it over the static ctx.diff — falling back to ctx.diff only when
   the caller omits the argument (callers that pre-compute ctx.diff before the adapter is built
   keep working unchanged).
 */

test("author() PREFERS a dynamic diff argument over the static ctx.diff supplied at construction time", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "STALE-STATIC-DIFF",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "REAL-DYNAMIC-DIFF");

    assert.equal(capturedInput?.diff, "REAL-DYNAMIC-DIFF", "a diff argument passed to author() must win over the static ctx.diff, matching the run's actual commit diff");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() FALLS BACK to the static ctx.diff when no dynamic diff argument is supplied (preserves the F.2 operator's own pre-computed-diff path)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "OPERATOR-PRECOMPUTED-DIFF",
    });

    await adapter.author("/mirrors/org/app/e2e");

    assert.equal(capturedInput?.diff, "OPERATOR-PRECOMPUTED-DIFF", "omitting the diff argument must fall back to ctx.diff unchanged — the operator's own pre-computed-diff composition must keep working");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* The adapter's optional 5th `enrichment` argument must map EVERY field 1:1 onto OpencodeRunInput
   — absent fields stay absent, present fields flow through unchanged (never re-derived, never dropped).
 */

test("author() maps enrichment.reviewCorrections/fixCases/selectorContradictions/domSnapshot/coverageGap/intent onto OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {
      reviewCorrections: ["fix the assertion"],
      fixCases: [{ name: "login", status: "fail", detail: "timed out" }],
      selectorContradictions: ["role:button is NOT in the tree"],
      domSnapshot: "- button \"Submit\"",
      coverageGap: "src/x.ts:12-15 not exercised",
      intent: { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/x.ts"] },
    });

    assert.deepEqual(capturedInput?.reviewCorrections, ["fix the assertion"]);
    assert.deepEqual(capturedInput?.fixCases, [{ name: "login", status: "fail", detail: "timed out" }]);
    assert.deepEqual(capturedInput?.selectorContradictions, ["role:button is NOT in the tree"]);
    assert.equal(capturedInput?.domSnapshot, "- button \"Submit\"");
    assert.equal(capturedInput?.coverageGap, "src/x.ts:12-15 not exercised");
    assert.deepEqual(capturedInput?.intent, { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/x.ts"] });
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* run-qa.use-case.ts) must map 1:1 onto OpencodeRunInput — the SAME fields buildPromptAssembled
   already renders sections for (contextPack's "VOLATILE context-pack section" / existingSpecFiles'
   "existing-suite-manifest" section, generation-input.ts).
 */

test("author() maps enrichment.contextPack/existingSpecFiles onto OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {
      contextPack: "## Context Pack\n\nblast radius...",
      existingSpecFiles: ["flows/checkout.spec.ts", "home.spec.ts"],
    });

    assert.equal(capturedInput?.contextPack, "## Context Pack\n\nblast radius...");
    assert.deepEqual(capturedInput?.existingSpecFiles, ["flows/checkout.spec.ts", "home.spec.ts"]);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with absent enrichment.contextPack/existingSpecFiles omits both from OpencodeRunInput (never fabricated)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {});

    assert.equal(capturedInput?.contextPack, undefined);
    assert.equal(capturedInput?.existingSpecFiles, undefined);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* enrichment.contextMap must reach OpencodeRunInput.contextMap so prompts.ts can run
   renderArchitectureContext. Spreading only contextPack text is not enough.
 */
const T4_CONTEXT_MAP = {
  builtAtSha: "abc1234",
  routes: [{ path: "/owners" }],
  api: [{ operationId: "getOwners", method: "GET", path: "/api/owners" }],
  feBe: [{ route: "/owners", operationId: "getOwners" }],
};

test("author() maps enrichment.contextMap onto OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {
      contextMap: T4_CONTEXT_MAP,
    });

    assert.ok(capturedInput?.contextMap, "OpencodeRunInput.contextMap must be the object field, not a pack-text grep");
    assert.deepEqual(capturedInput?.contextMap, T4_CONTEXT_MAP);
    assert.equal(capturedInput?.contextMap?.api[0]?.operationId, "getOwners");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() maps enrichment.harnessFacts onto OpencodeRunInput and omits the key when there are none", async () => {
  const ports = fakeAuthoringPorts();
  const captured: OpencodeRunInput[] = [];
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    captured.push(input);
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });
    const harnessFacts = { testIdAttribute: "data-cy", fixtures: { file: "fixtures.ts", exports: ["test", "expect"] } };

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { harnessFacts });
    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {});

    assert.deepEqual(captured[0]?.harnessFacts, harnessFacts);
    assert.equal("harnessFacts" in (captured[1] ?? {}), false);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with absent enrichment.contextMap omits it from OpencodeRunInput (never fabricated)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {
      contextPack: "## Context Pack\n\nblast radius...",
    });

    assert.equal(capturedInput?.contextMap, undefined);
    assert.equal(capturedInput?.contextPack, "## Context Pack\n\nblast radius...");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* ── Manifest-enrichment fix: enrichment.sha must reach OpencodeRunInput.sha so
   GenerateTestsUseCase can stamp ManifestEntry.changeRef.sha (previously hardcoded to "" here,
   which made every manifest entry fail the real schema's changeRef.sha non-empty check).
 */

test("author() maps enrichment.sha onto OpencodeRunInput.sha", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { sha: "abc1234def" });

    assert.equal(capturedInput?.sha, "abc1234def");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with no enrichment.sha falls back to empty string (today's behavior, until run-qa.use-case.ts threads it)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e");

    assert.equal(capturedInput?.sha, "");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with no enrichment argument omits every enrichment field from OpencodeRunInput (unchanged prompt)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e");

    assert.equal(capturedInput?.reviewCorrections, undefined);
    assert.equal(capturedInput?.fixCases, undefined);
    assert.equal(capturedInput?.selectorContradictions, undefined);
    assert.equal(capturedInput?.domSnapshot, undefined);
    assert.equal(capturedInput?.coverageGap, undefined);
    assert.equal(capturedInput?.intent, undefined);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* enrichment.serviceLinks/contractDrift must map 1:1 onto OpencodeRunInput.serviceLinks/contractDrift
   — the SAME conditional-spread as staticSignal/contextPack (absent/empty -> key OMITTED, not set to []).
 */

test("author() maps a non-empty enrichment.serviceLinks onto OpencodeRunInput.serviceLinks, same order", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });
    const links = [
      {
        from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" },
        to: { repo: "org/orders", file: "src/routes.ts", symbol: "GET /orders/:id" },
        transport: "http" as const,
        contractRef: "GET /orders/{id}",
        confidence: 0.9,
        source: "openapi",
      },
    ];

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { serviceLinks: links });

    assert.deepEqual(capturedInput?.serviceLinks, links);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with absent/empty enrichment.serviceLinks OMITS the key entirely from OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { serviceLinks: [] });
    assert.equal("serviceLinks" in (capturedInput ?? {}), false, "empty serviceLinks must be OMITTED, not set to []");

    await adapter.author("/mirrors/org/app/e2e");
    assert.equal("serviceLinks" in (capturedInput ?? {}), false, "absent enrichment must OMIT serviceLinks entirely");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() maps a non-empty enrichment.contractDrift onto OpencodeRunInput.contractDrift, same order", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });
    const drift = [
      { from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" }, verb: "DELETE", path: "/orders/{id}" },
    ];

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { contractDrift: drift });

    assert.deepEqual(capturedInput?.contractDrift, drift);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with absent/empty enrichment.contractDrift OMITS the key entirely from OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { contractDrift: [] });
    assert.equal("contractDrift" in (capturedInput ?? {}), false, "empty contractDrift must be OMITTED, not set to []");

    await adapter.author("/mirrors/org/app/e2e");
    assert.equal("contractDrift" in (capturedInput ?? {}), false, "absent enrichment must OMIT contractDrift entirely");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* The structural signal and the flag that says it names symbols travel together: the prompt reads the flag to decide whether the signal stands for an explored blast radius. A flag never travels without its signal, and an absent flag stays absent (a co-change-only signal), never false. */

test("author() maps the structural signal and its symbol flag onto OpencodeRunInput together, and omits the flag for a signal that names no symbols", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { staticSignal: "## Structural blast radius\n- `save`", staticSignalHasSymbols: true });
    assert.equal(capturedInput?.staticSignal, "## Structural blast radius\n- `save`");
    assert.equal(capturedInput?.staticSignalHasSymbols, true);

    const coChangeOnly = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }] });
    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { staticSignal: coChangeOnly });
    assert.equal(capturedInput?.staticSignal, coChangeOnly);
    assert.equal("staticSignalHasSymbols" in (capturedInput ?? {}), false, "a signal without the flag leaves it absent, never false");

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { staticSignal: "## Structural blast radius\n- `save`", staticSignalHasSymbols: true, staticSignalFiles: ["src/Foo.java"] });
    assert.deepEqual(capturedInput?.staticSignalFiles, ["src/Foo.java"], "the dossier's files travel with their signal");

    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { staticSignalHasSymbols: true, staticSignalFiles: ["src/Foo.java"] });
    assert.equal("staticSignalHasSymbols" in (capturedInput ?? {}), false, "a flag without a signal is dropped");
    assert.equal("staticSignalFiles" in (capturedInput ?? {}), false, "files without a signal are dropped");
    assert.equal("staticSignal" in (capturedInput ?? {}), false);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* TRIGGERING microservice (repo + its OWN mirror dir + its OWN openapi hint) for a cross-repo run —
   distinct from ctx.mirrorDir/ctx.openapi, which stay bound to the PRIMARY repo. App-static (known
   once per run, fixed for the whole run), so it lives on GenerationTurnsContext exactly like
   baseUrl/openapi above, NOT on the per-call GenerationEnrichment (which carries only values that
   vary between author() calls within the same run). Absent -> OMITTED entirely, the SAME
   absence-vs-present discipline serviceLinks/contractDrift above already established.
 */

test("author() maps ctx.service onto OpencodeRunInput.service when the run is cross-repo (triggered by a declared microservice)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/front", appName: "app", mirrorDir: "/mirrors/org/front", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
      service: { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" },
    });

    await adapter.author("/mirrors/org/front/e2e");

    assert.deepEqual(capturedInput?.service, { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" });
    assert.equal(capturedInput?.mirrorDir, "/mirrors/org/front", "the PRIMARY mirrorDir must stay the agent's cwd — service.mirrorDir is a read-only sibling, never a substitute");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with no ctx.service (same-repo run) OMITS the service key entirely from OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e");

    assert.equal("service" in (capturedInput ?? {}), false, "no ctx.service (the common same-repo case) must OMIT the key, not set it to undefined");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* carries EVERY declared microservice repo (read-only working copies) for a context-mode run, so the
   agent can extract each service's OpenAPI operations into the unified FE<->BE context map
   (buildContextTask's "## Microservice repos" section, task-builders.ts). App-static (known once per
   run, fixed for the whole run), the SAME shape as ctx.service above — NOT per-call/dynamic. Maps 1:1
   onto OpencodeRunInput.services. Absent -> OMITTED entirely, the SAME absence-vs-present discipline
   ctx.service/serviceLinks/contractDrift above already established.
 */

test("author() maps ctx.services onto OpencodeRunInput.services (context mode, every declared service)", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/front", appName: "app", mirrorDir: "/mirrors/org/front", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "context", diff: "",
      services: [
        { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" },
        { repo: "org/payments-svc", mirrorDir: "/mirrors/org/payments-svc" },
      ],
    });

    await adapter.author("/mirrors/org/front/e2e");

    assert.deepEqual(capturedInput?.services, [
      { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/mirrors/org/payments-svc" },
    ]);
    assert.equal(capturedInput?.mirrorDir, "/mirrors/org/front", "the PRIMARY mirrorDir must stay the agent's cwd — service mirrorDirs are read-only siblings, never a substitute");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("author() with no ctx.services OMITS the services key entirely from OpencodeRunInput", async () => {
  const ports = fakeAuthoringPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationTurnsAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });

    await adapter.author("/mirrors/org/app/e2e");

    assert.equal("services" in (capturedInput ?? {}), false, "no ctx.services (the common case) must OMIT the key, not set it to undefined or an empty array");
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

/* The generator receives the retrieved rules, unproven candidates included, as hints. Driven through the real adapter, use case and prompt builders; only the agent runtime (the LLM boundary) is faked. */

const provenRule: RetrievedRule = {
  id: "rule-proven", trigger: "the diff touches the owner search form",
  action: "assert the owners table lists the searched last name", errorClass: "E-FALSE-POSITIVE",
  status: "active", confidence: "high",
};
const unprovenRule: RetrievedRule = {
  id: "rule-unproven", trigger: "the diff renders a paginated visit history",
  action: "assert exactly five visit rows are listed", errorClass: "E-WRONG-OBJECTIVE",
  status: "candidate", confidence: "low",
};

async function generatorPromptWith(rules: readonly RetrievedRule[]): Promise<string> {
  let generatorPrompt = "";
  const useCase = new GenerateTestsUseCase({
    runtime: {
      openSession: async () => ({
        prompt: async (text: string) => {
          generatorPrompt = text;
          return { output: '{"specs":["flows/search.spec.ts"]}' };
        },
        dispose: async () => {},
      }),
    },
    rendering: new PromptRenderingAdapter({
      buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow,
    }),
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/search.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_specDir, entries) => [...entries] },
    budget: { capDiff: (d: string) => d, capText: (t: string) => t, budgetForRole: () => 0 },
  });
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/nonexistent/mirror", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", target: "e2e", mode: "diff",
    diff: "diff --git a/src/owners.ts b/src/owners.ts\n+export const search = () => [];\n",
  });
  await adapter.author("/nonexistent/mirror/e2e", undefined, undefined, rules.length ? { learnedRules: rules } : undefined);
  return generatorPrompt;
}

test("the generator receives unproven candidates as hints beside the proven rules", async () => {
  const generatorPrompt = await generatorPromptWith([provenRule, unprovenRule]);

  assert.ok(generatorPrompt.includes(unprovenRule.action));
  assert.ok(generatorPrompt.includes(provenRule.action));
});

/* A stock auth seed that did not sign in is a run fact the use case hands to generation; it must
   reach the generator prompt through this adapter. Real adapter, use case and prompt builders; only
   the agent runtime (the LLM boundary) is faked. */

async function generatorPromptFor(
  run: { e2eRelDir: string; target: TestTarget; mirrorDir?: string; specDir?: string },
  enrichment?: GenerationEnrichment,
): Promise<string> {
  let generatorPrompt = "";
  const useCase = new GenerateTestsUseCase({
    runtime: {
      openSession: async (role) => ({
        prompt: async (text: string) => {
          if (role === "author") generatorPrompt = text;
          return { output: '{"specs":[]}' };
        },
        dispose: async () => {},
      }),
    },
    rendering: new PromptRenderingAdapter({
      buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow,
    }),
    verdicts: {
      parseGenerator: () => ({ specs: [], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_specDir, entries) => [...entries] },
    budget: { capDiff: (d: string) => d, capText: (t: string) => t, budgetForRole: () => 0 },
  });
  const adapter = new GenerationTurnsAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: run.mirrorDir ?? "/nonexistent/mirror", e2eRelDir: run.e2eRelDir,
    namespace: "qa-bot-abc1234", target: run.target, mode: "diff", baseUrl: "https://dev",
    diff: "diff --git a/src/owners.ts b/src/owners.ts\n+export const search = () => [];\n",
  });
  await adapter.author(run.specDir ?? `/nonexistent/mirror/${run.e2eRelDir}`, undefined, undefined, enrichment);
  return generatorPrompt;
}

test("an unauthored auth seed makes the generator prompt ask to rewrite the suite's auth.setup.ts", async () => {
  const prompt = await generatorPromptFor({ e2eRelDir: "tests/e2e", target: "e2e" }, { authSeedUnauthored: true });

  assert.match(prompt, /^## App login$/m);
  assert.ok(prompt.includes("tests/e2e/auth.setup.ts"), "the rewrite must target the suite folder's own setup file");
});

test("a signed-in auth seed leaves auth.setup.ts out of the generator prompt", async () => {
  const prompt = await generatorPromptFor({ e2eRelDir: "tests/e2e", target: "e2e" });

  assert.ok(prompt.length > 0, "the generator was prompted");
  assert.doesNotMatch(prompt, /^## App login$/m);
  assert.ok(!prompt.includes("auth.setup.ts"));
});

test("a code-target run never renders the app login section, even with an unauthored seed", async () => {
  const prompt = await generatorPromptFor({ e2eRelDir: "e2e", target: "code" }, { authSeedUnauthored: true });

  assert.ok(prompt.length > 0, "the generator was prompted");
  assert.doesNotMatch(prompt, /^## App login$/m);
  assert.ok(!prompt.includes("auth.setup.ts"));
});

/* The step limit the agent runtime enforces reaches each input: the author's on every authoring call, the lead's on a planning turn.
   The resolver is the shell's; with none, or with no limit for a role, the input carries no key at all (absence is what
   tells a prompt not to state a limit). */

function recordingUseCase(inputs: OpencodeRunInput[]): GenerateTestsUseCase {
  return {
    author: async (input: OpencodeRunInput) => {
      inputs.push(input);
      return { specs: [], end: GENERATION_END.DELIVERED };
    },
  } as unknown as GenerateTestsUseCase;
}

/* A resolver that tells the roles apart by value, so a limit put on the wrong field shows. */
function resolverAsking(asked: StepLimitRole[]): (role: StepLimitRole) => Promise<number | undefined> {
  return async (role) => {
    asked.push(role);
    return role === "author" ? 41 : role === "lead" ? 29 : 17;
  };
}

test("author() puts the author's limit from the resolver on every input it builds, a regeneration's included", async () => {
  const inputs: OpencodeRunInput[] = [];
  const asked: StepLimitRole[] = [];
  const adapter = new GenerationTurnsAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT}, { stepLimitFor: resolverAsking(asked) });

  await adapter.author("/mirrors/org/app/e2e");
  await adapter.author("/mirrors/org/app/e2e", undefined, undefined, { reviewCorrections: ["fix the assertion"] });

  assert.deepEqual(inputs.map((input) => input.stepLimit), [41, 41]);
  assert.deepEqual(asked, ["author", "author"], "an authoring turn asks for the author's limit alone");
});

test("plan() puts the lead's limit from the resolver on the input of the planning turn", async () => {
  const inputs: OpencodeRunInput[] = [];
  const asked: StepLimitRole[] = [];
  const planning = { ...recordingUseCase(inputs), plan: async (input: OpencodeRunInput) => { inputs.push(input); return { parsed: true, timedOut: false }; } } as unknown as GenerateTestsUseCase;
  const adapter = new GenerationTurnsAdapter(planning, { ...STATIC_CONTEXT }, { stepLimitFor: resolverAsking(asked) });

  await adapter.plan("/mirrors/org/app/e2e", undefined, undefined, { planning: { budgetMs: 1000 } as never });

  assert.deepEqual(inputs.map((input) => input.stepLimit), [29]);
  assert.deepEqual(asked, ["lead"]);
});

test("author() carries no limit key when there is no resolver, or when the resolver has none for the role", async () => {
  const inputs: OpencodeRunInput[] = [];
  const noResolver = new GenerationTurnsAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT});
  const noLimit = new GenerationTurnsAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT}, { stepLimitFor: async () => undefined });

  await noResolver.author("/mirrors/org/app/e2e");
  await noLimit.author("/mirrors/org/app/e2e");

  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal("stepLimit" in input, false);
  }
});

/* What the verdict declared for each delivered spec travels out on the port's output; and the specs the run delivered so far travel in on a regeneration turn only, those whose file is still a regular file inside the spec directory. */

test("author() hands on what the verdict declared for each delivered spec, and omits the key when it declared none", async () => {
  const declaredSpecs = [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "the order is placed" }, { file: "login.spec.ts" }];
  const delivering = { author: async () => ({ specs: ["flows/checkout.spec.ts", "login.spec.ts"], declaredSpecs, end: GENERATION_END.DELIVERED }) } as unknown as GenerateTestsUseCase;
  const nothing = { author: async () => ({ specs: [], end: GENERATION_END.DECLARED_NOOP }) } as unknown as GenerateTestsUseCase;
  const emptyHanded = { author: async () => ({ specs: [], declaredSpecs: [], end: GENERATION_END.DECLARED_NOOP }) } as unknown as GenerateTestsUseCase;

  const delivered = await new GenerationTurnsAdapter(delivering, { ...STATIC_CONTEXT}).author("/mirrors/org/app/e2e");
  const none = await new GenerationTurnsAdapter(nothing, { ...STATIC_CONTEXT}).author("/mirrors/org/app/e2e");
  const empty = await new GenerationTurnsAdapter(emptyHanded, { ...STATIC_CONTEXT}).author("/mirrors/org/app/e2e");

  assert.deepEqual(delivered.declaredSpecs, declaredSpecs);
  assert.equal("declaredSpecs" in none, false);
  assert.equal("declaredSpecs" in empty, false, "an empty list of declarations is no key, never []");
});

test("author() declares the specs of a real generation, by path when the verdict declared nothing else for them", async () => {
  const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(fakeAuthoringPorts()), { ...STATIC_CONTEXT});
  const result = await adapter.author("/mirrors/org/app/e2e");
  assert.deepEqual(result.declaredSpecs, [{ file: "flows/checkout.spec.ts" }]);
});

const FAILING_CASES = [{ name: "checkout works", status: "fail" as const, file: "flows/a.spec.ts" }];
const REGENERATION_SIGNALS: ReadonlyArray<readonly [string, GenerationEnrichment]> = [
  ["failing cases", { fixCases: FAILING_CASES }],
  ["reviewer corrections", { reviewCorrections: ["assert the order total"] }],
  ["a coverage gap", { coverageGap: "src/cart.ts: 10-14" }],
  ["selector contradictions", { selectorContradictions: ["a selector the page does not have"] }],
];

/* The one generation input the adapter builds for `enrichment`, over a real mirror. */
async function inputFor(enrichment: GenerationEnrichment, mirror: string, specDir: string): Promise<OpencodeRunInput> {
  const inputs: OpencodeRunInput[] = [];
  const adapter = new GenerationTurnsAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT, mirrorDir: mirror});
  await adapter.author(specDir, undefined, undefined, enrichment);
  assert.equal(inputs.length, 1);
  return inputs[0]!;
}

const A = { file: "flows/a.spec.ts", flow: "login", objective: "the user signs in" };
const B = { file: "b.spec.ts" };

for (const [signal, regeneration] of REGENERATION_SIGNALS) {
  test(`author() hands the delivered specs whose file is there to a regeneration turn driven by ${signal}, as they were declared and in order`, () =>
    withMirror(async ({ mirror, specDir }) => {
      writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
      writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
      const input = await inputFor({ ...regeneration, deliveredSpecs: [A, B] }, mirror, specDir);
      assert.deepEqual(input.deliveredSpecs, [A, B]);
    }));
}

test("author() hands no delivered spec to a first pass, whatever the enrichment holds", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
    const input = await inputFor({ deliveredSpecs: [B], attributedSpecFiles: ["b.spec.ts"] }, mirror, specDir);
    assert.equal("deliveredSpecs" in input, false);
    assert.equal("attributedSpecFiles" in input, false);
  }));

/* One delivered spec that is still there, beside one whose file the confinement refuses: only the first is handed on. */
const REFUSED: ReadonlyArray<readonly [string, string, (dirs: { tmp: string; specDir: string }) => void]> = [
  ["deleted", "flows/gone.spec.ts", () => {}],
  ["renamed away: its old path is empty", "flows/old-name.spec.ts", () => {}],
  ["a path that climbs out of the spec directory", "../../secret.txt", () => {}],
  ["an absolute path", "/etc/hostname", () => {}],
  ["a symlink that leaves the spec directory", "flows/link.spec.ts", ({ tmp, specDir }) => symlinkSync(join(tmp, "secret.txt"), join(specDir, "flows", "link.spec.ts"))],
  ["a directory, not a file", "flows", () => {}],
  ["a path no filesystem can name", "flows/a\0.spec.ts", () => {}],
  ["no path at all", "", () => {}],
];

for (const [why, refused, arrange] of REFUSED) {
  test(`author() drops a delivered spec that is ${why}, and keeps the one that is there`, () =>
    withMirror(async ({ tmp, mirror, specDir }) => {
      writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
      arrange({ tmp, specDir });
      const input = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [{ file: refused, flow: "gone" }, A] }, mirror, specDir);
      assert.deepEqual(input.deliveredSpecs, [A]);
    }));
}

/* The named-pipe case needs mkfifo; where it is missing it skips, and says so. */
function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-gen-port-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe case is not exercised";

/* The probe judges a path without opening it: a spec the agent replaced with a named pipe is dropped, and the generation never waits on it. Under the watch a probe that did open it fails within a fraction of a second instead of hanging. */
test("author() drops a delivered spec that is a named pipe without opening it", { skip: NO_NAMED_PIPES }, () =>
  withMirror(async ({ mirror, specDir }) => {
    const pipe = join(specDir, "flows", "pipe.spec.ts");
    execFileSync("mkfifo", [pipe]);
    writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");

    const input = await withoutWaitingOnNamedPipe(pipe, () => inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [{ file: "flows/pipe.spec.ts" }, A], attributedSpecFiles: ["flows/pipe.spec.ts"] }, mirror, specDir));

    assert.deepEqual(input.deliveredSpecs, [A]);
    assert.equal("attributedSpecFiles" in input, false);
  }));

test("author() carries no delivered-specs key at all when none of them is there any more", () =>
  withMirror(async ({ mirror, specDir }) => {
    const input = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [A, B] }, mirror, specDir);
    assert.equal("deliveredSpecs" in input, false);
  }));

test("author() judges a delivered spec by the spec directory of the call: a file beside it is not a spec of the suite", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(mirror, "top.spec.ts"), "// beside the suite\n");
    const entry = { file: "top.spec.ts" };
    const e2e = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [entry] }, mirror, specDir);
    const code = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [entry] }, mirror, mirror);
    assert.equal("deliveredSpecs" in e2e, false);
    assert.deepEqual(code.deliveredSpecs, [entry]);
  }));

test("author() hands a regeneration turn the attributed spec files that are still there, in order, and drops the others", () =>
  withMirror(async ({ tmp, mirror, specDir }) => {
    writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
    writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
    symlinkSync(join(tmp, "secret.txt"), join(specDir, "flows", "link.spec.ts"));
    const input = await inputFor(
      { selectorContradictions: ["x"], attributedSpecFiles: ["b.spec.ts", "gone.spec.ts", "flows/link.spec.ts", "../../secret.txt", "flows/a.spec.ts"] },
      mirror,
      specDir,
    );
    assert.deepEqual(input.attributedSpecFiles, ["b.spec.ts", "flows/a.spec.ts"]);
  }));

test("author() carries no attributed-files key when there are none, or none of them is there", () =>
  withMirror(async ({ mirror, specDir }) => {
    const absent = await inputFor({ selectorContradictions: ["x"] }, mirror, specDir);
    const gone = await inputFor({ selectorContradictions: ["x"], attributedSpecFiles: ["gone.spec.ts"] }, mirror, specDir);
    assert.equal("attributedSpecFiles" in absent, false);
    assert.equal("attributedSpecFiles" in gone, false);
  }));

/* The suite's own entries, the lines the grounding folded before the run, meet the same probe on a regeneration turn: the agent can delete or rename a spec of the suite between passes, and a line for a file that is gone would go on being listed. A first pass hands them on exactly as they came. */

const SUITE_A = formatSuiteEntry({ file: "flows/a.spec.ts", flow: "login", objective: "the user signs in" });
const SUITE_B = formatSuiteEntry({ file: "b.spec.ts" });

for (const [signal, regeneration] of REGENERATION_SIGNALS) {
  test(`author() hands the existing-suite entries whose file is there to a regeneration turn driven by ${signal}, as they were folded and in order`, () =>
    withMirror(async ({ mirror, specDir }) => {
      writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
      writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
      const input = await inputFor({ ...regeneration, existingSpecFiles: [SUITE_B, SUITE_A] }, mirror, specDir);
      assert.deepEqual(input.existingSpecFiles, [SUITE_B, SUITE_A]);
    }));
}

test("author() hands a first pass every existing-suite entry exactly as it came, whatever is on disk", () =>
  withMirror(async ({ mirror, specDir }) => {
    const entries = [SUITE_A, SUITE_B, "flows/gone.spec.ts", "../../secret.txt"];
    const input = await inputFor({ existingSpecFiles: entries }, mirror, specDir);
    assert.deepEqual(input.existingSpecFiles, entries);
  }));

for (const [why, refused, arrange] of REFUSED) {
  test(`author() drops an existing-suite entry whose file is ${why}, and keeps the one that is there`, () =>
    withMirror(async ({ tmp, mirror, specDir }) => {
      writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
      arrange({ tmp, specDir });
      const input = await inputFor({ fixCases: FAILING_CASES, existingSpecFiles: [formatSuiteEntry({ file: refused, flow: "gone" }), SUITE_A] }, mirror, specDir);
      assert.deepEqual(input.existingSpecFiles, [SUITE_A]);
    }));
}

test("author() drops an existing-suite entry that is a named pipe without opening it", { skip: NO_NAMED_PIPES }, () =>
  withMirror(async ({ mirror, specDir }) => {
    const pipe = join(specDir, "flows", "pipe.spec.ts");
    execFileSync("mkfifo", [pipe]);
    writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");

    const input = await withoutWaitingOnNamedPipe(pipe, () => inputFor({ fixCases: FAILING_CASES, existingSpecFiles: ["flows/pipe.spec.ts", SUITE_A] }, mirror, specDir));

    assert.deepEqual(input.existingSpecFiles, [SUITE_A]);
  }));

test("author() carries no existing-suite key at all when none of the entries is there any more", () =>
  withMirror(async ({ mirror, specDir }) => {
    const input = await inputFor({ fixCases: FAILING_CASES, existingSpecFiles: [SUITE_A, SUITE_B] }, mirror, specDir);
    assert.equal("existingSpecFiles" in input, false);
  }));

test("author() judges an existing-suite entry by the spec directory of the call: a file beside it is not a spec of the suite", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(mirror, "top.spec.ts"), "// beside the suite\n");
    const entries = [formatSuiteEntry({ file: "top.spec.ts" })];
    const e2e = await inputFor({ fixCases: FAILING_CASES, existingSpecFiles: entries }, mirror, specDir);
    const code = await inputFor({ fixCases: FAILING_CASES, existingSpecFiles: entries }, mirror, mirror);
    assert.equal("existingSpecFiles" in e2e, false);
    assert.deepEqual(code.existingSpecFiles, entries);
  }));

test("a suite spec deleted during the run is no longer listed in the prompt of a regeneration, and the one that is there still is", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
    const prompt = await generatorPromptFor(
      { e2eRelDir: "e2e", target: "e2e", mirrorDir: mirror, specDir },
      { reviewCorrections: ["assert the order total"], existingSpecFiles: [SUITE_A, SUITE_B] },
    );
    assert.ok(prompt.includes("b.spec.ts"), "the spec that is still there stays listed");
    assert.ok(!prompt.includes("flows/a.spec.ts"), "the one that is gone is not");
  }));

test("the prompt of a first pass lists the suite exactly as the grounding folded it, whatever is on disk", () =>
  withMirror(async ({ mirror, specDir }) => {
    const run = { e2eRelDir: "e2e", target: "e2e" as TestTarget, mirrorDir: mirror, specDir };
    const enrichment = { existingSpecFiles: [SUITE_A, SUITE_B] };
    const bare = await generatorPromptFor(run, enrichment);
    writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
    writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
    const present = await generatorPromptFor(run, enrichment);
    assert.ok(bare.includes(SUITE_A) && bare.includes(SUITE_B), "both folded lines are in the prompt, with nothing on disk");
    assert.equal(present, bare);
  }));

test("author() hands the authenticated browser's limits to the prompt input when the run granted it, and nothing otherwise", async () => {
  const ports = fakeAuthoringPorts();
  const captured: Array<OpencodeRunInput | undefined> = [];
  const originalGenerate = GenerateTestsUseCase.prototype.author;
  GenerateTestsUseCase.prototype.author = async function (input: OpencodeRunInput, opts) {
    captured.push(input);
    return originalGenerate.call(this, input, opts);
  };
  try {
    const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(ports), {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", target: "e2e", mode: "diff", diff: "",
    });
    const limits = { maxCalls: 12, perCallMs: 20_000, leaseWaitMs: 5_000 };
    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", { agentBrowser: limits });
    await adapter.author("/mirrors/org/app/e2e", undefined, "the-diff", {});
    assert.deepEqual(captured[0]?.agentBrowser, limits);
    assert.equal("agentBrowser" in (captured[1] ?? {}), false);
  } finally {
    GenerateTestsUseCase.prototype.author = originalGenerate;
  }
});

test("plan() hands the use case the input a first pass has, with the limits of the plan, and maps its answer onto the port shape", async () => {
  const seen: OpencodeRunInput[] = [];
  const useCase = Object.assign(new GenerateTestsUseCase(fakeAuthoringPorts()), {
    plan: async (input: OpencodeRunInput) => {
      seen.push(input);
      return { plan: { kind: "single" }, parsed: true, timedOut: false };
    },
  });
  const adapter = new GenerationTurnsAdapter(useCase, { ...STATIC_CONTEXT, guidance: "cover the cart" });
  const planning = { maxFlows: 4, maxParallel: 2, budgetMs: 120_000 };
  const result = await adapter.plan("/mirrors/org/app/e2e", undefined, "the diff", { sha: "abc1234", runId: "run-9", planning });
  assert.deepEqual(result.plan, { kind: "single" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.planning, planning);
  assert.equal(seen[0]!.diff, "the diff");
  assert.equal(seen[0]!.runId, "run-9");
  assert.equal(seen[0]!.sha, "abc1234");
  assert.equal(seen[0]!.guidance, "cover the cart");
});

test("plan() refuses a call that carries no limits for the plan, before any session is opened", async () => {
  let opened = false;
  const ports = fakeAuthoringPorts();
  const guarded: AuthoringPorts = { ...ports, runtime: { openSession: async () => { opened = true; throw new Error("no"); } } as unknown as AuthoringPorts["runtime"] };
  const adapter = new GenerationTurnsAdapter(new GenerateTestsUseCase(guarded), { ...STATIC_CONTEXT});
  await assert.rejects(adapter.plan("/mirrors/org/app/e2e", undefined, "diff", { sha: "abc1234" }), /planning/);
  assert.equal(opened, false);
});

test("plan() forwards a plan turn that ran out of time and one that gave a no-op", async () => {
  const outcomes = [{ parsed: false, timedOut: true }, { noopReason: "docs only", parsed: true, timedOut: false }] as const;
  for (const outcome of outcomes) {
    const useCase = Object.assign(new GenerateTestsUseCase(fakeAuthoringPorts()), { plan: async () => outcome });
    const adapter = new GenerationTurnsAdapter(useCase, { ...STATIC_CONTEXT});
    const result = await adapter.plan("/mirrors/org/app/e2e", undefined, "diff", { sha: "abc1234", planning: { maxFlows: 3, maxParallel: 2, budgetMs: 60_000 } });
    assert.equal(result.timedOut, outcome.timedOut);
    assert.equal(result.noopReason, "noopReason" in outcome ? outcome.noopReason : undefined);
  }
});

