/* test/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.test.ts
   GenerationPortAdapter must delegate to the REAL GenerateTestsUseCase.generate()
   and map {specs, reviewed, approved, note} -> {specs, approved, note}. specSources is populated from
   a file-read collaborator (file I/O stays OUTSIDE the domain, per fix-loop.aggregate.ts's own
   FixLoopGenerateResult.specSources contract) — absent/empty when the read collaborator is absent.
   reexploreNavigations has NO real sibling counter (confirmed absent under generation/) so this bridge
   omits it — the FixLoop's own documented contract treats absent as 0 (the safe default), never a
   fabricated number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationPortAdapter, renderLearnedRules, renderLearnedRulesForReviewer } from "@contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts";
import { ConfinedPathError, readConfinedSpecFile, type SpecRoot } from "../../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import { Objective } from "@kernel/objective.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { callEfficiencyTracker } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { withoutWaitingOnNamedPipe } from "../../../../support/named-pipe-watch.ts";
import type { GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput, StepLimitRole } from "@contexts/generation/application/ports/generation-ports.ts";
import type { GenerationEnrichment, RetrievedRule } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { TestTarget } from "@kernel/run-mode.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import {
  buildPromptAssembled,
  buildWorkerPromptAssembled,
  buildReviewerPromptAssembled,
  buildExplorerPrompt,
  specFileForFlow,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";

function fakeGenerationPorts(overrides: {
  generatorOutput?: string;
  reviewerOutput?: string;
} = {}): GenerationPorts {
  return {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: overrides.generatorOutput ?? "generator-json" }),
        dispose: async () => {},
      }),
    } as unknown as GenerationPorts["runtime"],
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "prompt", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }),
      renderExplorer: () => "",
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

test("generate() delegates to GenerateTestsUseCase and maps GenerationResult onto the port shape", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const objectives = [Objective.of({ flow: "checkout", objective: "user can checkout", targets: [] })];
  const result = await adapter.generate(objectives, "/mirrors/org/app/e2e");

  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
  assert.equal(result.approved, true);
  assert.equal(result.note, "ok");
});

const STATIC_CONTEXT = {
  repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234", target: "e2e" as TestTarget, mode: "diff" as const, diff: "",
};
const CHECKOUT = [Objective.of({ flow: "checkout", objective: "user can checkout", targets: [] })];

test("generate() forwards how the generation ended and that no reviewer ran when generation is not reviewed", async () => {
  const adapter = new GenerationPortAdapter(new GenerateTestsUseCase(fakeGenerationPorts()), { ...STATIC_CONTEXT, needsReview: false });
  const result = await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e");
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.equal(result.reviewed, false);
  assert.equal(result.approved, true, "the flag stays, but reviewed says it is not a reviewer's approval");
});

test("generate() forwards that a reviewer ran when generation is reviewed", async () => {
  const adapter = new GenerationPortAdapter(new GenerateTestsUseCase(fakeGenerationPorts()), { ...STATIC_CONTEXT, needsReview: true });
  const result = await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e");
  assert.equal(result.reviewed, true);
  assert.equal(result.approved, true);
});

test("generate() forwards an exhausted generation's end, its note and the main turn's stats", async () => {
  const ports = fakeGenerationPorts();
  const exhausting: GenerationPorts = {
    ...ports,
    runtime: {
      openSession: async () => ({
        prompt: async (_text: string, opts?: { onTurnStats?: (s: { maxSteps: number | null; stepsUsed: number | null; exhausted: boolean | null; writeCount: number | null; observationComplete: boolean }) => void }) => {
          opts?.onTurnStats?.({ maxSteps: 30, stepsUsed: 30, exhausted: true, writeCount: 0, observationComplete: true });
          return { output: "Maximum steps for this agent have been reached." };
        },
        dispose: async () => {},
      }),
    } as unknown as GenerationPorts["runtime"],
    verdicts: { ...ports.verdicts, parseGenerator: () => ({ specs: [], parsed: true, outputTail: "cut off" }) },
  };
  const adapter = new GenerationPortAdapter(new GenerateTestsUseCase(exhausting), { ...STATIC_CONTEXT, needsReview: false });
  const result = await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e");
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
  assert.equal(result.turn?.stepsUsed, 30);
  assert.equal(result.turn?.writeCount, 0);
  assert.match(result.note ?? "", /30\/30/);
});

test("generate() surfaces approved:false with a note when the reviewer rejects (needsReview:true)", async () => {
  const ports = fakeGenerationPorts();
  ports.verdicts.parseReview = () => ({
    approved: false, corrections: ["fix X"], rationale: "missing assertion", parsed: true, valid: true, issues: [],
  });
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: true, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.equal(result.approved, false);
  assert.equal(result.note, "missing assertion");
});

test("generate() populates specSources from an injected file-read collaborator (absent by default), handing it the run's spec root and each reported path", async () => {
  const ports = fakeGenerationPorts();
  ports.verdicts.parseGenerator = () => ({ specs: ["flows/checkout.spec.ts", "login.spec.ts"], note: "ok" });
  const useCase = new GenerateTestsUseCase(ports);
  const calls: Array<{ root: SpecRoot; reported: string }> = [];
  const readSpecSource = (root: SpecRoot, reported: string): string => {
    calls.push({ root, reported });
    return `// source of ${reported}`;
  };
  const adapter = new GenerationPortAdapter(
    useCase,
    { repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "" },
    { readSpecSource },
  );

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.deepEqual(result.specSources, ["// source of flows/checkout.spec.ts", "// source of login.spec.ts"]);
  const root = { mirrorDir: "/mirrors/org/app", specDir: "/mirrors/org/app/e2e" };
  assert.deepEqual(calls, [
    { root, reported: "flows/checkout.spec.ts" },
    { root, reported: "login.spec.ts" },
  ]);
});

test("generate() roots the spec reads at the spec directory of the call, which for a code run is the mirror itself", async () => {
  const roots: SpecRoot[] = [];
  const adapter = new GenerationPortAdapter(
    new GenerateTestsUseCase(fakeGenerationPorts()),
    { ...STATIC_CONTEXT, needsReview: false },
    { readSpecSource: (root) => { roots.push(root); return ""; } },
  );

  await adapter.generate(CHECKOUT, "/mirrors/org/app");

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

test("generate() reads the delivered specs through the confined reader: a file inside the spec directory is a source", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(specDir, "flows", "checkout.spec.ts"), "// the real spec\n");
    const adapter = new GenerationPortAdapter(
      new GenerateTestsUseCase(fakeGenerationPorts()),
      { ...STATIC_CONTEXT, mirrorDir: mirror, needsReview: false },
      { readSpecSource: readConfinedSpecFile },
    );

    const result = await adapter.generate(CHECKOUT, specDir);

    assert.deepEqual(result.specSources, ["// the real spec\n"]);
  }));

test("generate() fails with the typed error, naming the reported path, when a delivered spec is a symlink that leaves the spec directory", () =>
  withMirror(async ({ tmp, mirror, specDir }) => {
    symlinkSync(join(tmp, "secret.txt"), join(specDir, "flows", "checkout.spec.ts"));
    const adapter = new GenerationPortAdapter(
      new GenerateTestsUseCase(fakeGenerationPorts()),
      { ...STATIC_CONTEXT, mirrorDir: mirror, needsReview: false },
      { readSpecSource: readConfinedSpecFile },
    );

    await assert.rejects(adapter.generate(CHECKOUT, specDir), (err: unknown) => err instanceof ConfinedPathError && err.path === "flows/checkout.spec.ts");
  }));

test("generate() fails with the typed error when a delivered spec climbs out of the spec directory", () =>
  withMirror(async ({ mirror, specDir }) => {
    const ports = fakeGenerationPorts();
    ports.verdicts.parseGenerator = () => ({ specs: ["../../secret.txt"], note: "ok" });
    const adapter = new GenerationPortAdapter(
      new GenerateTestsUseCase(ports),
      { ...STATIC_CONTEXT, mirrorDir: mirror, needsReview: false },
      { readSpecSource: readConfinedSpecFile },
    );

    await assert.rejects(adapter.generate(CHECKOUT, specDir), (err: unknown) => err instanceof ConfinedPathError && err.path === "../../secret.txt");
  }));

test("generate() omits specSources when no readSpecSource collaborator is injected", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.equal(result.specSources, undefined);
});

test("generate() never reports re-exploration counts, however much navigation the call-efficiency tracker recorded during the turn", async (t) => {
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
  } as unknown as GenerationPorts["runtime"];
  const useCase = new GenerateTestsUseCase({ ...fakeGenerationPorts(), runtime });
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.equal("reexploreNavigations" in result, false, "measuring calls must not activate the progress gate's re-exploration signal");
  assert.equal(callEfficiencyTracker.take(sessionId, "")?.totalCalls, 25, "the tracker really held the navigation the signal could have been fed with");
});

/* already forwards opts?.signal into runtime.openSession(role, mirrorDir, { signal }) for BOTH the
   missing link. It must declare + forward the signal into GenerateTestsUseCase.generate(input,
   opts), or the queue's AbortSignal is silently dropped before it ever reaches the agent session.
 */

test("generate() forwards an AbortSignal into GenerateTestsUseCase.generate()'s GenerateOpts", async () => {
  const controller = new AbortController();
  const capturedSignals: (AbortSignal | undefined)[] = [];
  const ports = fakeGenerationPorts();
  ports.runtime.openSession = async (_role, _mirrorDir, opts) => {
    capturedSignals.push(opts?.signal);
    return {
      prompt: async () => ({ output: "generator-json" }),
      dispose: async () => {},
    };
  };
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  await adapter.generate([], "/mirrors/org/app/e2e", controller.signal);

  assert.ok(capturedSignals.length > 0, "openSession must have been called at least once");
  for (const captured of capturedSignals) {
    assert.equal(captured, controller.signal, "the SAME AbortSignal instance passed to generate() must reach GenerateTestsUseCase's own opts.signal, not be dropped at the bridge");
  }
});

test("generate() with no signal at all behaves exactly as before (no third-arg regression)", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
  assert.equal(result.approved, true);
});

/* Production constructs this adapter BEFORE the run/checkout, so the STATIC ctx.diff supplied at
   composition time is always "". This bridge must accept the run's ACTUAL diff as a fourth
   generate() argument and PREFER it over the static ctx.diff — falling back to ctx.diff only when
   the caller omits the argument (callers that pre-compute ctx.diff before building
   CompositionConfig keep working unchanged).
 */

test("generate() PREFERS a dynamic diff argument over the static ctx.diff supplied at construction time", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "STALE-STATIC-DIFF",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "REAL-DYNAMIC-DIFF");

    assert.equal(capturedInput?.diff, "REAL-DYNAMIC-DIFF", "a diff argument passed to generate() must win over the static ctx.diff, matching the run's actual commit diff");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() FALLS BACK to the static ctx.diff when no dynamic diff argument is supplied (preserves the F.2 operator's own pre-computed-diff path)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "OPERATOR-PRECOMPUTED-DIFF",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal(capturedInput?.diff, "OPERATOR-PRECOMPUTED-DIFF", "omitting the diff argument must fall back to ctx.diff unchanged — the operator's own pre-computed-diff composition must keep working");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* The adapter's optional 5th `enrichment` argument must map EVERY field 1:1 onto OpencodeRunInput
   — absent fields stay absent, present fields flow through unchanged (never re-derived, never dropped).
 */

test("generate() maps enrichment.reviewCorrections/fixCases/selectorContradictions/domSnapshot/coverageGap/intent onto OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {
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
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* run-qa.use-case.ts) must map 1:1 onto OpencodeRunInput — the SAME fields buildPromptAssembled
   already renders sections for (contextPack's "VOLATILE context-pack section" / existingSpecFiles'
   "existing-suite-manifest" section, generation-ports.ts).
 */

test("generate() maps enrichment.contextPack/existingSpecFiles onto OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {
      contextPack: "## Context Pack\n\nblast radius...",
      existingSpecFiles: ["flows/checkout.spec.ts", "home.spec.ts"],
    });

    assert.equal(capturedInput?.contextPack, "## Context Pack\n\nblast radius...");
    assert.deepEqual(capturedInput?.existingSpecFiles, ["flows/checkout.spec.ts", "home.spec.ts"]);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with absent enrichment.contextPack/existingSpecFiles omits both from OpencodeRunInput (never fabricated)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {});

    assert.equal(capturedInput?.contextPack, undefined);
    assert.equal(capturedInput?.existingSpecFiles, undefined);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
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

test("generate() maps enrichment.contextMap onto OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {
      contextMap: T4_CONTEXT_MAP,
    });

    assert.ok(capturedInput?.contextMap, "OpencodeRunInput.contextMap must be the object field, not a pack-text grep");
    assert.deepEqual(capturedInput?.contextMap, T4_CONTEXT_MAP);
    assert.equal(capturedInput?.contextMap?.api[0]?.operationId, "getOwners");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() maps enrichment.contextBrief onto OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });
    const brief = { builtForSha: "abc1234", objective: "checkout", blastRadius: [{ symbol: "Pay", file: "pay.ts", role: "charges" }] };

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { contextBrief: brief });

    assert.deepEqual(capturedInput?.contextBrief, brief);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() maps enrichment.harnessFacts onto OpencodeRunInput and omits the key when there are none", async () => {
  const ports = fakeGenerationPorts();
  const captured: OpencodeRunInput[] = [];
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    captured.push(input);
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });
    const harnessFacts = { testIdAttribute: "data-cy", fixtures: { file: "fixtures.ts", exports: ["test", "expect"] } };

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { harnessFacts });
    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {});

    assert.deepEqual(captured[0]?.harnessFacts, harnessFacts);
    assert.equal("harnessFacts" in (captured[1] ?? {}), false);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with absent enrichment.contextMap omits it from OpencodeRunInput (never fabricated)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {
      contextPack: "## Context Pack\n\nblast radius...",
    });

    assert.equal(capturedInput?.contextMap, undefined);
    assert.equal(capturedInput?.contextPack, "## Context Pack\n\nblast radius...");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* ── Manifest-enrichment fix: enrichment.sha must reach OpencodeRunInput.sha so
   GenerateTestsUseCase can stamp ManifestEntry.changeRef.sha (previously hardcoded to "" here,
   which made every manifest entry fail the real schema's changeRef.sha non-empty check).
 */

test("generate() maps enrichment.sha onto OpencodeRunInput.sha", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { sha: "abc1234def" });

    assert.equal(capturedInput?.sha, "abc1234def");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with no enrichment.sha falls back to empty string (today's behavior, until run-qa.use-case.ts threads it)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal(capturedInput?.sha, "");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with no enrichment argument omits every enrichment field from OpencodeRunInput (unchanged prompt)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal(capturedInput?.reviewCorrections, undefined);
    assert.equal(capturedInput?.fixCases, undefined);
    assert.equal(capturedInput?.selectorContradictions, undefined);
    assert.equal(capturedInput?.domSnapshot, undefined);
    assert.equal(capturedInput?.coverageGap, undefined);
    assert.equal(capturedInput?.intent, undefined);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* enrichment.serviceLinks/contractDrift must map 1:1 onto OpencodeRunInput.serviceLinks/contractDrift
   — the SAME conditional-spread as staticSignal/contextPack (absent/empty -> key OMITTED, not set to []).
 */

test("generate() maps a non-empty enrichment.serviceLinks onto OpencodeRunInput.serviceLinks, same order", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
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

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { serviceLinks: links });

    assert.deepEqual(capturedInput?.serviceLinks, links);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with absent/empty enrichment.serviceLinks OMITS the key entirely from OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { serviceLinks: [] });
    assert.equal("serviceLinks" in (capturedInput ?? {}), false, "empty serviceLinks must be OMITTED, not set to []");

    await adapter.generate([], "/mirrors/org/app/e2e");
    assert.equal("serviceLinks" in (capturedInput ?? {}), false, "absent enrichment must OMIT serviceLinks entirely");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() maps a non-empty enrichment.contractDrift onto OpencodeRunInput.contractDrift, same order", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });
    const drift = [
      { from: { repo: "org/front", file: "src/api.ts", symbol: "getOrder" }, verb: "DELETE", path: "/orders/{id}" },
    ];

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { contractDrift: drift });

    assert.deepEqual(capturedInput?.contractDrift, drift);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with absent/empty enrichment.contractDrift OMITS the key entirely from OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { contractDrift: [] });
    assert.equal("contractDrift" in (capturedInput ?? {}), false, "empty contractDrift must be OMITTED, not set to []");

    await adapter.generate([], "/mirrors/org/app/e2e");
    assert.equal("contractDrift" in (capturedInput ?? {}), false, "absent enrichment must OMIT contractDrift entirely");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* The structural signal and the flag that says it names symbols travel together: the prompt reads the flag to decide whether the signal stands for an explored blast radius. A flag never travels without its signal, and an absent flag stays absent (a co-change-only signal), never false. */

test("generate() maps the structural signal and its symbol flag onto OpencodeRunInput together, and omits the flag for a signal that names no symbols", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { staticSignal: "## Structural blast radius\n- `save`", staticSignalHasSymbols: true });
    assert.equal(capturedInput?.staticSignal, "## Structural blast radius\n- `save`");
    assert.equal(capturedInput?.staticSignalHasSymbols, true);

    const coChangeOnly = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }] });
    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { staticSignal: coChangeOnly });
    assert.equal(capturedInput?.staticSignal, coChangeOnly);
    assert.equal("staticSignalHasSymbols" in (capturedInput ?? {}), false, "a signal without the flag leaves it absent, never false");

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { staticSignalHasSymbols: true });
    assert.equal("staticSignalHasSymbols" in (capturedInput ?? {}), false, "a flag without a signal is dropped");
    assert.equal("staticSignal" in (capturedInput ?? {}), false);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* TRIGGERING microservice (repo + its OWN mirror dir + its OWN openapi hint) for a cross-repo run —
   distinct from ctx.mirrorDir/ctx.openapi, which stay bound to the PRIMARY repo. App-static (known
   once per run, fixed for the whole run), so it lives on GenerationPortStaticContext exactly like
   baseUrl/openapi above, NOT on the per-call GenerationEnrichment (which carries only values that
   vary between generate() calls within the same run). Absent -> OMITTED entirely, the SAME
   absence-vs-present discipline serviceLinks/contractDrift above already established.
 */

test("generate() maps ctx.service onto OpencodeRunInput.service when the run is cross-repo (triggered by a declared microservice)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/front", appName: "app", mirrorDir: "/mirrors/org/front", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
      service: { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" },
    });

    await adapter.generate([], "/mirrors/org/front/e2e");

    assert.deepEqual(capturedInput?.service, { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" });
    assert.equal(capturedInput?.mirrorDir, "/mirrors/org/front", "the PRIMARY mirrorDir must stay the agent's cwd — service.mirrorDir is a read-only sibling, never a substitute");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with no ctx.service (same-repo run) OMITS the service key entirely from OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal("service" in (capturedInput ?? {}), false, "no ctx.service (the common same-repo case) must OMIT the key, not set it to undefined");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* carries EVERY declared microservice repo (read-only working copies) for a context-mode run, so the
   agent can extract each service's OpenAPI operations into the unified FE<->BE context map
   (buildContextTask's "## Microservice repos" section, prompts.ts:1181). App-static (known once per
   run, fixed for the whole run), the SAME shape as ctx.service above — NOT per-call/dynamic. Maps 1:1
   onto OpencodeRunInput.services. Absent -> OMITTED entirely, the SAME absence-vs-present discipline
   ctx.service/serviceLinks/contractDrift above already established.
 */

test("generate() maps ctx.services onto OpencodeRunInput.services (context mode, every declared service)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/front", appName: "app", mirrorDir: "/mirrors/org/front", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "context", diff: "",
      services: [
        { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" },
        { repo: "org/payments-svc", mirrorDir: "/mirrors/org/payments-svc" },
      ],
    });

    await adapter.generate([], "/mirrors/org/front/e2e");

    assert.deepEqual(capturedInput?.services, [
      { repo: "org/orders-svc", mirrorDir: "/mirrors/org/orders-svc", openapi: "openapi.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/mirrors/org/payments-svc" },
    ]);
    assert.equal(capturedInput?.mirrorDir, "/mirrors/org/front", "the PRIMARY mirrorDir must stay the agent's cwd — service mirrorDirs are read-only siblings, never a substitute");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with no ctx.services OMITS the services key entirely from OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal("services" in (capturedInput ?? {}), false, "no ctx.services (the common case) must OMIT the key, not set it to undefined or an empty array");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

/* renderLearnedRules: proven (active) rules and experimental (candidate) hints go to separate
   sections, proven first, each rule carrying its trigger, action and error class. */

const activeRule: RetrievedRule = {
  id: "rule-active", trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL",
  status: "active", confidence: "high",
};
const candidateRule: RetrievedRule = {
  id: "rule-candidate", trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY",
  status: "candidate", confidence: "low",
};

/* The rendered markdown split into its "## " sections. */
function sections(rendered: string): Array<{ heading: string; body: string }> {
  return rendered
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [heading = "", ...rest] = chunk.split("\n");
      return { heading, body: rest.join("\n") };
    });
}
const isExperimental = (heading: string): boolean => /experimental|unproven/i.test(heading);

test("renderLearnedRules: an active rule is offered as a proven rule with its trigger, action, error class and confidence", () => {
  const found = sections(renderLearnedRules([activeRule]));

  assert.equal(found.length, 1);
  assert.equal(isExperimental(found[0]!.heading), false);
  for (const field of ["selector absent", "use role+name", "E-EXEC-FAIL", "high"]) {
    assert.ok(found[0]!.body.includes(field), `the proven rule must carry ${field}`);
  }
});

test("renderLearnedRules: a candidate rule is offered only as an experimental hint, never as a proven rule", () => {
  const found = sections(renderLearnedRules([candidateRule]));

  assert.equal(found.length, 1);
  assert.equal(isExperimental(found[0]!.heading), true);
  for (const field of ["flaky wait", "use expect.poll", "E-FLAKY"]) {
    assert.ok(found[0]!.body.includes(field), `the experimental hint must carry ${field}`);
  }
});

test("renderLearnedRules: a mixed set renders the proven section first and keeps each rule in its own section", () => {
  const [proven, experimental, ...rest] = sections(renderLearnedRules([activeRule, candidateRule]));

  assert.equal(rest.length, 0);
  assert.equal(isExperimental(proven!.heading), false);
  assert.equal(isExperimental(experimental!.heading), true);
  assert.ok(proven!.body.includes("use role+name") && !proven!.body.includes("use expect.poll"));
  assert.ok(experimental!.body.includes("use expect.poll") && !experimental!.body.includes("use role+name"));
});

test("renderLearnedRules: empty input renders the empty string", () => {
  assert.equal(renderLearnedRules([]), "");
});

/* renderLearnedRulesForReviewer: active rules only (never candidates), framed as reject-on-sight
   rules, one line per rule carrying its trigger, action and error class. */

test("renderLearnedRulesForReviewer: an active rule becomes a reject-on-sight line with its trigger, action and error class", () => {
  const rendered = renderLearnedRulesForReviewer([activeRule]);

  assert.match(rendered, /reject/i, "the reviewer must be told a violated proven rule is grounds to reject");
  const line = rendered.split("\n").find((l) => l.includes("selector absent"));
  assert.ok(line, "the rule appears in the list");
  assert.ok(line.includes("use role+name") && line.includes("E-EXEC-FAIL"), `one line carries trigger, action and error class: ${line}`);
});

test("renderLearnedRulesForReviewer: candidate-only input renders '' — unproven rules never gate the reviewer", () => {
  assert.equal(renderLearnedRulesForReviewer([candidateRule]), "");
});

test("renderLearnedRulesForReviewer: a mixed set renders ONLY the active rule's line", () => {
  const rendered = renderLearnedRulesForReviewer([activeRule, candidateRule]);

  assert.ok(rendered.includes("- selector absent → use role+name (E-EXEC-FAIL)"));
  assert.ok(!rendered.includes("flaky wait"), "candidate rules must never appear in the reviewer's reject-on-sight list");
});

test("renderLearnedRulesForReviewer: empty input renders the empty string", () => {
  assert.equal(renderLearnedRulesForReviewer([]), "");
});

/* The first reviewer pass is the publish gate, so it may only reject on PROVEN (active) learned
   rules — unproven candidates are generator hints, never grounds for rejection. Driven through the
   real bridge, use case and prompt builders; only the agent runtime (the LLM boundary) is faked. */

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

async function runFirstReviewPass(rules: readonly RetrievedRule[]): Promise<{ generatorPrompt: string; reviewerPrompt: string }> {
  const prompts: Record<string, string> = {};
  const useCase = new GenerateTestsUseCase({
    runtime: {
      openSession: async (role) => ({
        prompt: async (text: string) => {
          prompts[role] = text;
          return { output: role === "reviewer" ? '{"approved":true,"corrections":[]}' : '{"specs":["flows/search.spec.ts"]}' };
        },
        dispose: async () => {},
      }),
    },
    rendering: new PromptRenderingAdapter({
      buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow,
    }),
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/search.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_specDir, entries) => [...entries] },
    budget: { capDiff: (d: string) => d, capText: (t: string) => t, budgetForRole: () => 0 },
  });
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/nonexistent/mirror", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: true, target: "e2e", mode: "diff",
    diff: "diff --git a/src/owners.ts b/src/owners.ts\n+export const search = () => [];\n",
  });
  await adapter.generate([], "/nonexistent/mirror/e2e", undefined, undefined, rules.length ? { learnedRules: rules } : undefined);
  return { generatorPrompt: prompts.primary ?? "", reviewerPrompt: prompts.reviewer ?? "" };
}

test("first review pass: the reviewer sees proven learned rules and never unproven candidates", async () => {
  const { reviewerPrompt } = await runFirstReviewPass([provenRule, unprovenRule]);

  assert.ok(reviewerPrompt.includes(provenRule.action), "a proven rule must reach the reviewer");
  assert.ok(!reviewerPrompt.includes(unprovenRule.trigger), "an unproven candidate's trigger must never reach the reviewer");
  assert.ok(!reviewerPrompt.includes(unprovenRule.action), "an unproven candidate's action must never reach the reviewer");
});

test("first review pass: the generator still receives unproven candidates as hints", async () => {
  const { generatorPrompt } = await runFirstReviewPass([provenRule, unprovenRule]);

  assert.ok(generatorPrompt.includes(unprovenRule.action));
  assert.ok(generatorPrompt.includes(provenRule.action));
});

test("first review pass: candidate-only rules leave the reviewer prompt identical to a run with no learned rules", async () => {
  const withCandidates = await runFirstReviewPass([unprovenRule]);
  const withoutRules = await runFirstReviewPass([]);

  assert.equal(withCandidates.reviewerPrompt, withoutRules.reviewerPrompt);
});

/* A stock auth seed that did not sign in is a run fact the use case hands to generation; it must
   reach the generator prompt through this bridge. Real bridge, use case and prompt builders; only
   the agent runtime (the LLM boundary) is faked. */

async function generatorPromptFor(
  run: { e2eRelDir: string; target: TestTarget },
  enrichment?: GenerationEnrichment,
): Promise<string> {
  let generatorPrompt = "";
  const useCase = new GenerateTestsUseCase({
    runtime: {
      openSession: async (role) => ({
        prompt: async (text: string) => {
          if (role === "primary") generatorPrompt = text;
          return { output: '{"specs":[]}' };
        },
        dispose: async () => {},
      }),
    },
    rendering: new PromptRenderingAdapter({
      buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow,
    }),
    verdicts: {
      parseGenerator: () => ({ specs: [], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_specDir, entries) => [...entries] },
    budget: { capDiff: (d: string) => d, capText: (t: string) => t, budgetForRole: () => 0 },
  });
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/nonexistent/mirror", e2eRelDir: run.e2eRelDir,
    namespace: "qa-bot-abc1234", needsReview: false, target: run.target, mode: "diff", baseUrl: "https://dev",
    diff: "diff --git a/src/owners.ts b/src/owners.ts\n+export const search = () => [];\n",
  });
  await adapter.generate([], `/nonexistent/mirror/${run.e2eRelDir}`, undefined, undefined, enrichment);
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

/* The step limit the agent runtime enforces reaches each generation input: the generator's on every call, the
   in-generate reviewer's only when that reviewer runs. The resolver is the shell's; with none, or with no limit
   for a role, the input carries no key at all (absence is what tells a prompt not to state a limit). */

function recordingUseCase(inputs: OpencodeRunInput[]): GenerateTestsUseCase {
  return {
    generate: async (input: OpencodeRunInput) => {
      inputs.push(input);
      return { specs: [], approved: true, reviewed: false, end: GENERATION_END.DELIVERED };
    },
  } as unknown as GenerateTestsUseCase;
}

/* A resolver that tells the two roles apart by value, so a limit put on the wrong field shows. */
function resolverAsking(asked: StepLimitRole[]): (role: StepLimitRole) => Promise<number | undefined> {
  return async (role) => {
    asked.push(role);
    return role === "generator" ? 41 : 17;
  };
}

test("generate() puts the generator's limit from the resolver on every input it builds, a regeneration's included", async () => {
  const inputs: OpencodeRunInput[] = [];
  const asked: StepLimitRole[] = [];
  const adapter = new GenerationPortAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT, needsReview: false }, { stepLimitFor: resolverAsking(asked) });

  await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e");
  await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e", undefined, undefined, { reviewCorrections: ["fix the assertion"] });

  assert.deepEqual(inputs.map((input) => input.stepLimit), [41, 41]);
  assert.deepEqual(asked, ["generator", "generator"], "a generation that runs no reviewer never asks for the reviewer's limit");
  assert.ok(inputs.every((input) => !("reviewerStepLimit" in input)));
});

test("generate() carries the in-generate reviewer's own limit when that reviewer runs, apart from the generator's", async () => {
  const inputs: OpencodeRunInput[] = [];
  const asked: StepLimitRole[] = [];
  const adapter = new GenerationPortAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT, needsReview: true }, { stepLimitFor: resolverAsking(asked) });

  await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e");

  assert.equal(inputs[0]?.stepLimit, 41);
  assert.equal(inputs[0]?.reviewerStepLimit, 17);
  assert.deepEqual([...asked].sort(), ["generator", "reviewer"]);
});

test("generate() carries no limit key when there is no resolver, or when the resolver has none for the role", async () => {
  const inputs: OpencodeRunInput[] = [];
  const noResolver = new GenerationPortAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT, needsReview: true });
  const noLimit = new GenerationPortAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT, needsReview: true }, { stepLimitFor: async () => undefined });

  await noResolver.generate(CHECKOUT, "/mirrors/org/app/e2e");
  await noLimit.generate(CHECKOUT, "/mirrors/org/app/e2e");

  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal("stepLimit" in input, false);
    assert.equal("reviewerStepLimit" in input, false);
  }
});

/* What the verdict declared for each delivered spec travels out on the port's output; and the specs the run delivered so far travel in on a regeneration turn only, those whose file is still a regular file inside the spec directory. */

test("generate() hands on what the verdict declared for each delivered spec, and omits the key when it declared none", async () => {
  const declaredSpecs = [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "the order is placed" }, { file: "login.spec.ts" }];
  const delivering = { generate: async () => ({ specs: ["flows/checkout.spec.ts", "login.spec.ts"], declaredSpecs, approved: true, reviewed: false, end: GENERATION_END.DELIVERED }) } as unknown as GenerateTestsUseCase;
  const nothing = { generate: async () => ({ specs: [], approved: true, reviewed: false, end: GENERATION_END.DECLARED_NOOP }) } as unknown as GenerateTestsUseCase;
  const emptyHanded = { generate: async () => ({ specs: [], declaredSpecs: [], approved: true, reviewed: false, end: GENERATION_END.DECLARED_NOOP }) } as unknown as GenerateTestsUseCase;

  const delivered = await new GenerationPortAdapter(delivering, { ...STATIC_CONTEXT, needsReview: false }).generate(CHECKOUT, "/mirrors/org/app/e2e");
  const none = await new GenerationPortAdapter(nothing, { ...STATIC_CONTEXT, needsReview: false }).generate(CHECKOUT, "/mirrors/org/app/e2e");
  const empty = await new GenerationPortAdapter(emptyHanded, { ...STATIC_CONTEXT, needsReview: false }).generate(CHECKOUT, "/mirrors/org/app/e2e");

  assert.deepEqual(delivered.declaredSpecs, declaredSpecs);
  assert.equal("declaredSpecs" in none, false);
  assert.equal("declaredSpecs" in empty, false, "an empty list of declarations is no key, never []");
});

test("generate() declares the specs of a real generation, by path when the verdict declared nothing else for them", async () => {
  const adapter = new GenerationPortAdapter(new GenerateTestsUseCase(fakeGenerationPorts()), { ...STATIC_CONTEXT, needsReview: false });
  const result = await adapter.generate(CHECKOUT, "/mirrors/org/app/e2e");
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
  const adapter = new GenerationPortAdapter(recordingUseCase(inputs), { ...STATIC_CONTEXT, mirrorDir: mirror, needsReview: false });
  await adapter.generate(CHECKOUT, specDir, undefined, undefined, enrichment);
  assert.equal(inputs.length, 1);
  return inputs[0]!;
}

const A = { file: "flows/a.spec.ts", flow: "login", objective: "the user signs in" };
const B = { file: "b.spec.ts" };

for (const [signal, regeneration] of REGENERATION_SIGNALS) {
  test(`generate() hands the delivered specs whose file is there to a regeneration turn driven by ${signal}, as they were declared and in order`, () =>
    withMirror(async ({ mirror, specDir }) => {
      writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");
      writeFileSync(join(specDir, "b.spec.ts"), "// b\n");
      const input = await inputFor({ ...regeneration, deliveredSpecs: [A, B] }, mirror, specDir);
      assert.deepEqual(input.deliveredSpecs, [A, B]);
    }));
}

test("generate() hands no delivered spec to a first pass, whatever the enrichment holds", () =>
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
  test(`generate() drops a delivered spec that is ${why}, and keeps the one that is there`, () =>
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
test("generate() drops a delivered spec that is a named pipe without opening it", { skip: NO_NAMED_PIPES }, () =>
  withMirror(async ({ mirror, specDir }) => {
    const pipe = join(specDir, "flows", "pipe.spec.ts");
    execFileSync("mkfifo", [pipe]);
    writeFileSync(join(specDir, "flows", "a.spec.ts"), "// a\n");

    const input = await withoutWaitingOnNamedPipe(pipe, () => inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [{ file: "flows/pipe.spec.ts" }, A], attributedSpecFiles: ["flows/pipe.spec.ts"] }, mirror, specDir));

    assert.deepEqual(input.deliveredSpecs, [A]);
    assert.equal("attributedSpecFiles" in input, false);
  }));

test("generate() carries no delivered-specs key at all when none of them is there any more", () =>
  withMirror(async ({ mirror, specDir }) => {
    const input = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [A, B] }, mirror, specDir);
    assert.equal("deliveredSpecs" in input, false);
  }));

test("generate() judges a delivered spec by the spec directory of the call: a file beside it is not a spec of the suite", () =>
  withMirror(async ({ mirror, specDir }) => {
    writeFileSync(join(mirror, "top.spec.ts"), "// beside the suite\n");
    const entry = { file: "top.spec.ts" };
    const e2e = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [entry] }, mirror, specDir);
    const code = await inputFor({ fixCases: FAILING_CASES, deliveredSpecs: [entry] }, mirror, mirror);
    assert.equal("deliveredSpecs" in e2e, false);
    assert.deepEqual(code.deliveredSpecs, [entry]);
  }));

test("generate() hands a regeneration turn the attributed spec files that are still there, in order, and drops the others", () =>
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

test("generate() carries no attributed-files key when there are none, or none of them is there", () =>
  withMirror(async ({ mirror, specDir }) => {
    const absent = await inputFor({ selectorContradictions: ["x"] }, mirror, specDir);
    const gone = await inputFor({ selectorContradictions: ["x"], attributedSpecFiles: ["gone.spec.ts"] }, mirror, specDir);
    assert.equal("attributedSpecFiles" in absent, false);
    assert.equal("attributedSpecFiles" in gone, false);
  }));
