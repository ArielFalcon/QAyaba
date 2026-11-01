/* test/contexts/run-orchestration/infrastructure/adapters/review-port.adapter.test.ts
   generation-owned primitives GenerateTestsUseCase.generate() itself composes for its embedded
   review branch (renderReviewer / openSession(reviewerRole) / parseReview) — there is NO standalone
   "reviewer flow" export under generation/ (grep-confirmed: renderReviewer is called from exactly
   ONE place, inside generate()'s conditional review branch). This adapter is THIN: it does not
   reimplement the fail-closed formula, it reads the SAME ReviewJudgment fields the port interface
   (its own comment) already documents verbatim — parsed:false is a parse MISS
   (not a rejection), distinct from a genuine approved:false. blockingCount gates blocking-vs-advisory.
   The #1 fail-closed invariant is asserted here directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewPortAdapter } from "@contexts/generation/infrastructure/adapters/review-port.adapter.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort } from "@contexts/generation/application/ports/prompt-rendering.port.ts";
import type { VerdictParserPort } from "@contexts/generation/application/ports/verdict-parser.port.ts";
import type { ReviewJudgment } from "@contexts/generation/domain/manifest-repository.ts";
import type { ReviewInput, StepLimitRole } from "@contexts/generation/domain/generation-input.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { LOG_EFFECT, levelOfEffect, memoryLogger } from "@kernel/ports/logger.port.ts";
import { installProcessLogger, resetProcessLoggerForTests } from "@kernel/ports/process-logger.ts";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import type { ReviewPort } from "@contexts/generation/application/index.ts";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { readVerdict } from "@contexts/generation/domain/verdict-parse.ts";
import { submittingRuntime } from "../../../../support/submission.ts";
import { RunDeadlineRuntime } from "@contexts/run-orchestration/infrastructure/run-deadline-runtime.adapter.ts";
import type { AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";

/* The text of a reviewer turn that calls its submit tool with an approval. */
const APPROVAL = '{"approved":true,"corrections":[]}';

function fakeRuntime(output: string): AgentRuntimePort {
  return {
    openSession: async () => ({
      prompt: async () => ({ output: output === "verdict-json" ? APPROVAL : output }),
      dispose: async () => {},
    }),
  };
}

/* The reviewer delivers by submit tool: the fake runtime's text is read as the call of it, and a text with none as a turn that made no call. */
const adapterOver = (deps: ConstructorParameters<typeof ReviewPortAdapter>[0], ctx: ConstructorParameters<typeof ReviewPortAdapter>[1], collaborators?: ConstructorParameters<typeof ReviewPortAdapter>[2]): ReviewPortAdapter =>
  new ReviewPortAdapter({ ...deps, runtime: submittingRuntime(deps.runtime) }, ctx, collaborators);

function fakeRendering(): PromptRenderingPort {
  return {
    render: () => "",
    renderMain: () => ({ text: "", sectionSizes: {} }),
    renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }),
    specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
  };
}

function fakeVerdicts(judgment: ReviewJudgment): VerdictParserPort {
  return {
    readGenerator: () => ({ specs: [] }),
    readReview: () => judgment,
  };
}

const cases: QaCase[] = [{ name: "checkout flow", status: "pass" }];

test("review() delegates to the reviewer session and surfaces approved/corrections/rationale", async () => {
  const runtime = fakeRuntime("verdict-json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: true, findings: [], rationale: undefined, parsed: true, valid: true, issues: [],
  });
  const adapter = adapterOver({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.approved, true);
  assert.equal(result.parsed, true);
});

test("review() fail-closed invariant: a parse miss (parsed:false) is NEVER treated as approved", async () => {
  const runtime = fakeRuntime("garbage, not json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: true, /* even if the parser's own approved defaulted true, parsed:false must win */
    findings: [], parsed: false, valid: false, issues: ["no verdict JSON found"],
  });
  const adapter = adapterOver({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.parsed, false);
  assert.equal(result.approved, false, "a parse miss must NEVER read as a real approval");
});

test("review() threads blockingCount so the caller can distinguish blocking vs advisory corrections", async () => {
  const runtime = fakeRuntime("verdict-json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: false, findings: [{ text: "nit: rename var", severity: "advisory" as const }], blockingCount: 0, parsed: true, valid: true, issues: [],
  });
  const adapter = adapterOver({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.blockingCount, 0);
  assert.deepEqual(result.findings, [{ text: "nit: rename var", severity: "advisory" }]);
});

test("review() prefers the run's DYNAMIC diff over the static ctx.diff (Plan 7.6), falling back when absent", async () => {
  let seenDiff: string | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenDiff = (input as { diff?: string }).diff; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], rationale: undefined, parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "STATIC-ctx-diff", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, "DYNAMIC-run-diff");
  assert.equal(seenDiff, "DYNAMIC-run-diff", "the reviewer must ground on the run's REAL diff, not the empty composition-time value");

  await adapter.review("/mirrors/org/app/e2e", cases);
  assert.equal(seenDiff, "STATIC-ctx-diff", "absent dynamic diff falls back to ctx.diff (operator / unit-test path)");
});

/* review()'s optional 4th `enrichment` argument maps priorCorrections verbatim. */

test("review() maps enrichment.priorCorrections onto ReviewInput.priorCorrections verbatim", async () => {
  let seenInput: { priorCorrections?: string[] } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { priorCorrections?: string[] }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { priorCorrections: ["fix the assertion on line 12"] });

  assert.deepEqual(seenInput?.priorCorrections, ["fix the assertion on line 12"]);
});

/* enrichment.domSnapshot must map onto ReviewInput.domSnapshot.
 */

test("review() maps enrichment.domSnapshot onto ReviewInput.domSnapshot verbatim", async () => {
  let seenInput: { domSnapshot?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { domSnapshot?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { domSnapshot: "route /owners:\n  heading: Owners" });

  assert.equal(seenInput?.domSnapshot, "route /owners:\n  heading: Owners");
});

test("review() hands enrichment.changeView to the reviewer prompt, and omits it when the run had none", async () => {
  const seen: Array<ReviewInput["changeView"]> = [];
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seen.push((input as ReviewInput).changeView); return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });
  const changeView: NonNullable<ReviewInput["changeView"]> = { files: [], flows: [{ specFile: "flows/a.spec.ts", candidateIds: ["uc-a"], owned: [] }], unassigned: [], hunkless: [], referenced: [] };

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { changeView });
  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {});

  assert.deepEqual(seen, [changeView, undefined]);
});

test("review() with absent enrichment.domSnapshot omits it from ReviewInput (never fabricated)", async () => {
  let seenInput: { domSnapshot?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { domSnapshot?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {});

  assert.equal(seenInput?.domSnapshot, undefined);
});

test("review() with no enrichment argument omits priorCorrections (unchanged prompt)", async () => {
  let seenInput: { priorCorrections?: string[] } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { priorCorrections?: string[] }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(seenInput?.priorCorrections, undefined);
});

/* previously passed NO timeoutMs into openSession(), so the reviewer silently inherited the
   dispatcher's ~25.5min ceiling instead of the purpose-built REVIEWER_TIMEOUT_MS (6min) — a hung
   reviewer could hold the sequential queue 25-50min. ReviewPortStaticContext.timeoutMs (optional,
   composition-supplied — the adapter stays agnostic to the constant's numeric value, same pattern
   as baseUrl/guidance) now threads straight into openSession's own opts.timeoutMs. ──────────────────
 */

test("review() threads ctx.timeoutMs into openSession's opts.timeoutMs (reviewer gets its OWN budget, not the dispatcher's)", async () => {
  let seenTimeoutMs: number | undefined;
  const runtime: AgentRuntimePort = {
    openSession: async (_role, _cwd, opts) => {
      seenTimeoutMs = opts?.timeoutMs;
      return { prompt: async () => ({ output: APPROVAL }), dispose: async () => {} };
    },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", timeoutMs: 360_000,
  });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(seenTimeoutMs, 360_000, "the reviewer's OWN budget (e.g. REVIEWER_TIMEOUT_MS) must reach openSession, not be silently dropped");
});

test("review() with absent ctx.timeoutMs omits it from openSession opts (backward compatible — no forced timeout)", async () => {
  let sawTimeoutKey = false;
  const runtime: AgentRuntimePort = {
    openSession: async (_role, _cwd, opts) => {
      sawTimeoutKey = opts !== undefined && "timeoutMs" in opts && opts.timeoutMs !== undefined;
      return { prompt: async () => ({ output: APPROVAL }), dispose: async () => {} };
    },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(sawTimeoutKey, false, "absent ctx.timeoutMs must not fabricate a timeout the composition layer never configured");
});

test("review() maps a thrown openSession/prompt failure (e.g. a reviewer timeout) to a fail-closed ReviewResult with a distinctive note — never a crash, never approved:true", async () => {
  const runtime: AgentRuntimePort = {
    openSession: async () => {
      throw new Error("reviewer session timed out after 360000ms");
    },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", timeoutMs: 360_000,
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.approved, undefined, "a reviewer failure carries no verdict: not an approval and not a rejection a later reader could find");
  assert.equal(result.parsed, false, "a reviewer failure is a parse-equivalent miss — not an actionable rejection to regenerate against");
  assert.ok(result.rationale?.includes("reviewer unavailable"), "the rationale must carry a distinctive, human-legible note distinguishing this from a real rejection");
  assert.ok(result.rationale?.includes("timed out"), "the original failure reason should be visible for operators");
});

test("review() maps a thrown session.prompt() failure the same fail-closed way (not just openSession failures)", async () => {
  const runtime: AgentRuntimePort = {
    openSession: async () => ({
      prompt: async () => { throw new Error("stalled: no activity for 360000ms"); },
      dispose: async () => {},
    }),
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", timeoutMs: 360_000,
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.approved, undefined);
  assert.equal(result.parsed, false);
  assert.ok(result.rationale?.includes("reviewer unavailable"));
});

/* The reviewer's session runs under a step limit of its own. The shell resolves it from the live runtime and the
   adapter carries it onto the review input; with no resolver, or none for the role, the input has no such key. */

function renderingRecording(seen: ReviewInput[]): PromptRenderingPort {
  return {
    ...fakeRendering(),
    renderReviewer: (input) => {
      seen.push(input);
      return { text: "reviewer-prompt", sectionSizes: {} };
    },
  };
}

const approving = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
const REVIEW_CONTEXT = { diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff" as const };

test("review() puts the reviewer's limit from the resolver on ReviewInput.stepLimit, asking for the reviewer role and for no other", async () => {
  const seen: ReviewInput[] = [];
  const asked: StepLimitRole[] = [];
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering: renderingRecording(seen), verdicts: approving }, REVIEW_CONTEXT, {
    stepLimitFor: async (role) => {
      asked.push(role);
      return role === "reviewer" ? 17 : 41;
    },
  });

  await adapter.review("/mirrors/org/app/e2e", cases);
  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { priorCorrections: ["fix the assertion"] });

  assert.deepEqual(seen.map((input) => input.stepLimit), [17, 17], "a re-review states it as the first review does");
  assert.deepEqual(asked, ["reviewer", "reviewer"]);
});

test("review() carries no limit key when there is no resolver, or when the resolver has none", async () => {
  const seen: ReviewInput[] = [];
  const noResolver = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering: renderingRecording(seen), verdicts: approving }, REVIEW_CONTEXT);
  const noLimit = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering: renderingRecording(seen), verdicts: approving }, REVIEW_CONTEXT, {
    stepLimitFor: async () => undefined,
  });

  await noResolver.review("/mirrors/org/app/e2e", cases);
  await noLimit.review("/mirrors/org/app/e2e", cases);

  assert.equal(seen.length, 2);
  for (const input of seen) assert.equal("stepLimit" in input, false);
});

/* The prompt that states the reviewer's limit is sent with that limit as an option, so the review turn is classified against the number the prompt stated. */

function runtimeRecordingOptions(sent: Array<Record<string, unknown> | undefined>): AgentRuntimePort {
  return {
    openSession: async () => ({
      prompt: async (_text, opts) => {
        sent.push(opts as Record<string, unknown> | undefined);
        return { output: APPROVAL };
      },
      dispose: async () => {},
    }),
  };
}

test("review() sends its prompt with the reviewer's limit as an option, on every review, beside the options it already carried", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const rendering: PromptRenderingPort = { ...fakeRendering(), renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: { "reviewer-specs": 12 } }) };
  const adapter = adapterOver({ runtime: runtimeRecordingOptions(sent), rendering, verdicts: approving }, REVIEW_CONTEXT, {
    stepLimitFor: async (role) => (role === "reviewer" ? 17 : 41),
  });

  await adapter.review("/mirrors/org/app/e2e", cases);
  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { priorCorrections: ["fix the assertion"] });

  assert.deepEqual(sent.map((opts) => opts?.stepLimit), [17, 17]);
  assert.deepEqual(sent[0]?.sectionSizes, { "reviewer-specs": 12 });
});

test("review() sends its prompt with no limit key when there is no resolver, or when the resolver has none", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const noResolver = adapterOver({ runtime: runtimeRecordingOptions(sent), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);
  const noLimit = adapterOver({ runtime: runtimeRecordingOptions(sent), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT, {
    stepLimitFor: async () => undefined,
  });

  await noResolver.review("/mirrors/org/app/e2e", cases);
  await noLimit.review("/mirrors/org/app/e2e", cases);

  assert.equal(sent.length, 2);
  for (const opts of sent) assert.equal("stepLimit" in (opts ?? {}), false);
});

test("review() lets the run's deadline through: a reviewer turn the run's time ran out on is the run's end, not a reviewer to fail closed on", async () => {
  const runtime: AgentRuntimePort = { openSession: async () => { throw new RunDeadlineExceededError(60_000, "manual", "reviewer", "before-turn"); } };
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);
  await assert.rejects(adapter.review("/mirrors/org/app/e2e", cases), (err: unknown) => err instanceof RunDeadlineExceededError);
});

/* An unavailable reviewer is told apart from a rejection, and from a reviewer that answered unreadably. */

const REVIEW_CTX = { diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff" as const };

test("review() marks a reviewer whose session failed as unavailable, in either place it can fail", async () => {
  const failAtOpen: AgentRuntimePort = { openSession: async () => { throw new Error("HTTP 400: model not supported"); } };
  const failAtPrompt: AgentRuntimePort = { openSession: async () => ({ prompt: async () => { throw new Error("stalled: no activity"); }, dispose: async () => {} }) };
  for (const runtime of [failAtOpen, failAtPrompt]) {
    const result = await adapterOver({ runtime, rendering: fakeRendering(), verdicts: approving }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
    assert.equal(result.unavailable, true);
    assert.equal(result.approved, undefined, "no reviewer reached a verdict, so the answer carries none");
    assert.equal(result.parsed, false);
  }
});

test("review() marks a reviewer that returned nothing as unavailable: an empty answer judged nothing", async () => {
  for (const output of ["", "  \n "]) {
    const result = await adapterOver({ runtime: fakeRuntime(output), rendering: fakeRendering(), verdicts: approving }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
    assert.equal(result.unavailable, true, JSON.stringify(output));
    assert.match(result.rationale ?? "", /reviewer unavailable: the reviewer returned no output/);
  }
});

test("review() does not mark a real rejection as unavailable, and keeps it exactly as it was", async () => {
  const rejecting = fakeVerdicts({ approved: false, findings: [{ text: "[false-positive] asserts nothing", severity: "blocking" as const }], blockingCount: 1, parsed: true, valid: true, issues: [], rationale: "asserts nothing real" });
  const result = await adapterOver({ runtime: fakeRuntime("verdict-json"), rendering: fakeRendering(), verdicts: rejecting }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
  assert.equal("unavailable" in result, false);
  assert.deepEqual([result.approved, result.parsed, result.blockingCount, result.findings], [false, true, 1, [{ text: "[false-positive] asserts nothing", severity: "blocking" }]]);
});

test("review() does not mark an answer it could not read as unavailable: the reviewer was reached, only its verdict is a parse miss", async () => {
  const unreadable = fakeVerdicts({ approved: false, findings: [], parsed: false, valid: false, issues: ["no verdict JSON found"] });
  const result = await adapterOver({ runtime: fakeRuntime("I think the tests look fine"), rendering: fakeRendering(), verdicts: unreadable }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
  assert.equal("unavailable" in result, false);
  assert.equal(result.parsed, false);
  assert.equal(result.approved, false);
});

/* The verdict is the call of the reviewer's submit tool, and the turn reports what it cost so the run can persist it (never read back into the verdict). */

test("review() asks for its verdict through the reviewer's submit tool", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const adapter = adapterOver({ runtime: runtimeRecordingOptions(sent), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal((sent[0]?.submit as { tool?: string } | undefined)?.tool, "submit_review");
  assert.equal(sent[0]?.textOnly, undefined);
});

test("review() reports the turn's duration, tokens, cost and steps", async () => {
  const runtime: AgentRuntimePort = {
    openSession: async (_role, _cwd, opts) => {
      opts?.onUsage?.({ input: 900, output: 120, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.004 });
      return {
        prompt: async (_text, promptOpts) => {
          promptOpts?.onTurnStats?.({ maxSteps: 12, stepsUsed: 1, exhausted: false, writeCount: 0, observationComplete: true });
          return { output: '{"approved":true,"rationale":"ok","corrections":[]}' };
        },
        dispose: async () => {},
      };
    },
  };
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.ok(result.stats, "a review that opened a session reports what it cost");
  assert.equal(result.stats?.outputTokens, 120);
  assert.equal(result.stats?.inputTokens, 900);
  assert.equal(result.stats?.costUsd, 0.004);
  assert.equal(result.stats?.steps, 1);
  assert.ok(result.stats!.durationMs >= 0);
  assert.equal(result.stats?.promptBytes, Buffer.byteLength("reviewer-prompt", "utf8"));
});

test("review() reports no fabricated token count when the runtime reports no usage", async () => {
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.stats?.outputTokens, undefined, "absent usage stays absent, never 0");
  assert.equal(result.stats?.costUsd, undefined);
});

test("review() maps enrichment.specChanges onto ReviewInput.specChanges verbatim", async () => {
  let seenInput: { specChanges?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { specChanges?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts: approving }, REVIEW_CONTEXT);

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { specChanges: "### a.spec.ts\n- old\n+ new" });

  assert.equal(seenInput?.specChanges, "### a.spec.ts\n- old\n+ new");
});

test("review() opens its session for the review kind: the reviewer role, the reviewer agent and the review timeout", async () => {
  const opened: Array<{ role: string; agent: string | undefined; timeoutMs: number | undefined }> = [];
  const runtime: AgentRuntimePort = {
    openSession: async (role, _cwd, opts) => {
      opened.push({ role, agent: opts?.descriptor?.role, timeoutMs: opts?.timeoutMs });
      return { prompt: async () => ({ output: APPROVAL }), dispose: async () => {} };
    },
  };
  const adapter = adapterOver({ runtime, rendering: fakeRendering(), verdicts: approving }, { ...REVIEW_CONTEXT, timeoutMs: 7_000 });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.deepEqual(opened, [{ role: "reviewer", agent: "qa-reviewer", timeoutMs: 7_000 }]);
});

/* enrichment.executionEvidence must reach the prompt as the reviewer's execution result: the run's own
   captured statuses and URLs, rendered by the one renderer that bounds and sanitizes them. */
test("review() renders the run's execution evidence into the reviewer prompt, bounded like every other section", async () => {
  let seenInput: { executionResult?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { executionResult?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {
    executionEvidence: { verdict: "pass", cases: [{ name: "checkout flow", status: "pass", httpStatus: 500, finalUrl: "http://dev/checkout", detail: "the server rejected card-4242" }] },
  });

  assert.match(seenInput?.executionResult ?? "", /RUNTIME EXECUTION RESULT/);
  assert.match(seenInput?.executionResult ?? "", /Verdict: pass/);
  assert.match(seenInput?.executionResult ?? "", /httpStatus: 500/);
  assert.match(seenInput?.executionResult ?? "", /finalUrl: http:\/\/dev\/checkout/);
  assert.doesNotMatch(seenInput?.executionResult ?? "", /\bauthoritative\b/i, "execution evidence is evidence, not an authority");
});

test("review() with no execution evidence omits the section entirely (never an empty one)", async () => {
  let seenInput: { executionResult?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { executionResult?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {});

  assert.equal(seenInput?.executionResult, undefined);
});

test("review() hands the reviewer prompt the arms no test ran, and none when the enrichment has none", async () => {
  const seen: unknown[] = [];
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seen.push((input as { untakenArms?: unknown }).untakenArms); return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });
  const arms = [{ file: "src/a.ts", line: 3, kind: "if", arm: "else" }];

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { untakenArms: arms });
  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { untakenArms: [] });

  assert.deepEqual(seen, [arms, undefined]);
});

test("review() hands on every finding as the reviewer wrote it: its text, severity and citation", async () => {
  const verdicts = fakeVerdicts({
    approved: false,
    findings: [{ text: "[false-positive] flows/x.spec.ts asserts nothing", severity: "blocking", citation: { kind: "execution", ref: "flows/x.spec.ts" } }],
    blockingCount: 1,
    parsed: true,
    valid: true,
    issues: [],
  });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.deepEqual(result.findings, [{ text: "[false-positive] flows/x.spec.ts asserts nothing", severity: "blocking", citation: { kind: "execution", ref: "flows/x.spec.ts" } }]);
});

test("a port result without findings does not compile", () => {
  /* Checked by `npm run typecheck`: the directive fails the build when the omission starts to compile. */
  const omitted = async (): ReturnType<ReviewPort["review"]> =>
    // @ts-expect-error findings is required: an adapter that drops the reviewer's findings is a build failure
    ({ approved: true, parsed: true });
  assert.equal(typeof omitted, "function");
});

/* A reviewer turn that ends before its verdict is accepted is continued once, in the same session, restricted to the submit tool. */

const CUT_ANSWER = '{"approved": true, "rationale": "the spec asserts the filtered list", "corrections": [';
const RESTATED_ANSWER = '{"approved": true, "rationale": "the spec asserts the filtered list", "corrections": []}';

const realVerdicts = new VerdictParserAdapter({ readVerdict });

interface ScriptedReviewer {
  runtime: AgentRuntimePort;
  opened: number;
  prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }>;
}

/* Answers the prompts in turn; a thrown answer fails that prompt. */
function scriptedReviewer(answers: Array<string | Error>): ScriptedReviewer {
  const scripted: ScriptedReviewer = { opened: 0, prompts: [], runtime: undefined as unknown as AgentRuntimePort };
  scripted.runtime = {
    openSession: async () => {
      scripted.opened++;
      return {
        prompt: async (text, opts) => {
          scripted.prompts.push({ text, opts });
          const answer = answers[scripted.prompts.length - 1] ?? "";
          if (answer instanceof Error) throw answer;
          return { output: answer };
        },
        dispose: async () => {},
      };
    },
  };
  return scripted;
}

test("review() continues a reviewer whose turn was cut before its verdict, once, in its own session and restricted to the submit tool, and reads the verdict it then submits", async () => {
  const reviewer = scriptedReviewer([CUT_ANSWER, RESTATED_ANSWER]);
  const adapter = adapterOver({ runtime: reviewer.runtime, rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT, { stepLimitFor: async () => 9 });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.parsed, true);
  assert.equal(result.approved, true);
  assert.equal(result.rationale, "the spec asserts the filtered list");
  assert.equal("unavailable" in result, false);
  assert.equal(reviewer.opened, 1, "the continuation rides the reviewer's own session");
  assert.equal(reviewer.prompts.length, 2);
  assert.equal(reviewer.prompts[0]!.opts?.submitOnly, undefined, "the review itself keeps its tools");
  assert.equal(reviewer.prompts[1]!.opts?.submitOnly, true);
  assert.equal(reviewer.prompts[1]!.opts?.isRepair, true);
  assert.equal(reviewer.prompts[1]!.opts?.stepLimit, 9);
  assert.match(reviewer.prompts[1]!.text, /submit_review/);
  assert.equal(result.stats?.outputChars, RESTATED_ANSWER.length);
});

test("review() names where the verdict went wrong inside the turn, and reads the corrected one", async () => {
  const noSeverity = '{"approved":false,"corrections":[{"text":"[false-positive] a.spec.ts: asserts nothing"}]}';
  const corrected = '{"approved":false,"corrections":[{"text":"[false-positive] a.spec.ts: asserts nothing","severity":"blocking"}]}';
  const reviewer = scriptedReviewer([noSeverity, corrected]);

  const result = await adapterOver({ runtime: reviewer.runtime, rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT).review("/mirrors/org/app/e2e", cases);

  assert.match(reviewer.prompts[1]!.text, /corrections\.0\.severity/);
  assert.equal(result.parsed, true);
  assert.equal(result.blockingCount, 1);
});

test("review() still fails closed when the continuation delivers no verdict either: one continuation and no more, and the reason is recorded", async () => {
  const reviewer = scriptedReviewer([CUT_ANSWER, CUT_ANSWER, RESTATED_ANSWER]);

  const result = await adapterOver({ runtime: reviewer.runtime, rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT).review("/mirrors/org/app/e2e", cases);

  assert.equal(result.parsed, false);
  assert.equal(result.approved, false);
  assert.equal("unavailable" in result, false, "the reviewer was reached: this is a parse miss, not an absence");
  assert.equal(reviewer.prompts.length, 2, "a second continuation is never sent");
  assert.match(result.issues?.join("\n") ?? "", /no accepted submission/);
});

test("review() still fails closed when the continuation outlasts its time: a parse miss that says so", async () => {
  const reviewer = scriptedReviewer([CUT_ANSWER, new AgentTimeoutError("prompt exceeded 100ms")]);

  const result = await adapterOver({ runtime: reviewer.runtime, rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT).review("/mirrors/org/app/e2e", cases);

  assert.equal(result.parsed, false);
  assert.equal(result.approved, false);
  assert.equal("unavailable" in result, false);
  assert.match(result.issues?.join("\n") ?? "", /continuation ran out of its time/);
});

/* A parse miss is carried past: the run goes on without burning a round, so its line is a carried-on fault, not an end. */
test("the line that says a reviewer delivered no verdict is written at the level of a carried-on fault", async () => {
  const memory = memoryLogger();
  installProcessLogger(memory);
  try {
    await adapterOver({ runtime: fakeRuntime("I think the tests look fine"), rendering: fakeRendering(), verdicts: approving }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
  } finally {
    resetProcessLoggerForTests();
  }
  const lines = memory.entries.filter((e) => /delivered no verdict/.test(e.message));
  assert.equal(lines.length, 1);
  assert.deepEqual([...new Set(lines.map((e) => e.level))], [levelOfEffect(LOG_EFFECT.CARRIED_ON)]);
});

test("review() asks a reviewer that submitted a readable verdict nothing more", async () => {
  const readable = scriptedReviewer([RESTATED_ANSWER]);
  await adapterOver({ runtime: readable.runtime, rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT).review("/mirrors/org/app/e2e", cases);
  assert.equal(readable.prompts.length, 1);
});

test("review() marks a reviewer that wrote nothing and called nothing, even after its continuation, as unavailable", async () => {
  const empty = scriptedReviewer(["  ", ""]);
  const result = await adapterOver({ runtime: empty.runtime, rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT).review("/mirrors/org/app/e2e", cases);
  assert.equal(empty.prompts.length, 2);
  assert.equal(result.unavailable, true);
});

test("review() sends no continuation once the run's deadline has no time left: the run ends instead", async () => {
  const reviewer = scriptedReviewer([CUT_ANSWER, RESTATED_ANSWER]);
  let left = 60_000;
  const deadline = { remainingMs: () => left, allowance: () => left, describe: () => ({ label: "manual", budgetMs: 60_000 }), currentPurpose: () => "review" as const };
  /* The review turn spends the run's last milliseconds. */
  const spending: AgentRuntimePort = {
    openSession: async (role, cwd, opts) => {
      const session = await reviewer.runtime.openSession(role, cwd, opts);
      return { prompt: async (text, promptOpts) => { const out = await session.prompt(text, promptOpts); left = 0; return out; }, dispose: () => session.dispose() };
    },
  };
  const adapter = adapterOver({ runtime: new RunDeadlineRuntime(spending, deadline), rendering: fakeRendering(), verdicts: realVerdicts }, REVIEW_CONTEXT);

  await assert.rejects(adapter.review("/mirrors/org/app/e2e", cases), (err: unknown) => err instanceof RunDeadlineExceededError);
  assert.equal(reviewer.prompts.length, 1, "the continuation never reached the agent");
});

test("review() hands enrichment.ambientDataPins to the reviewer prompt, and omits them when the run recorded none", async () => {
  const seen: Array<ReviewInput["ambientDataPins"]> = [];
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seen.push((input as ReviewInput).ambientDataPins); return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, findings: [], parsed: true, valid: true, issues: [] });
  const adapter = adapterOver({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });
  const ambientDataPins = [{ file: "flows/listing.spec.ts", test: "renders the empty listing", pages: ["/listing"] }];

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { ambientDataPins });
  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { ambientDataPins: [] });

  assert.deepEqual(seen, [ambientDataPins, undefined]);
});
