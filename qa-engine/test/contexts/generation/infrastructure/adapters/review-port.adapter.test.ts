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

function fakeRuntime(output: string): AgentRuntimePort {
  return {
    openSession: async () => ({
      prompt: async () => ({ output }),
      dispose: async () => {},
    }),
  };
}

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
    parseGenerator: () => ({ specs: [] }),
    parseReview: () => judgment,
  };
}

const cases: QaCase[] = [{ name: "checkout flow", status: "pass" }];

test("review() delegates to the reviewer session and surfaces approved/corrections/rationale", async () => {
  const runtime = fakeRuntime("verdict-json");
  const rendering = fakeRendering();
  const verdicts = fakeVerdicts({
    approved: true, corrections: [], rationale: undefined, parsed: true, valid: true, issues: [],
  });
  const adapter = new ReviewPortAdapter({ runtime, rendering, verdicts }, {
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
    corrections: [], parsed: false, valid: false, issues: ["no verdict JSON found"],
  });
  const adapter = new ReviewPortAdapter({ runtime, rendering, verdicts }, {
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
    approved: false, corrections: ["nit: rename var"], blockingCount: 0, parsed: true, valid: true, issues: [],
  });
  const adapter = new ReviewPortAdapter({ runtime, rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.blockingCount, 0);
  assert.deepEqual(result.corrections, ["nit: rename var"]);
});

test("review() prefers the run's DYNAMIC diff over the static ctx.diff (Plan 7.6), falling back when absent", async () => {
  let seenDiff: string | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenDiff = (input as { diff?: string }).diff; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], rationale: undefined, parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { domSnapshot: "route /owners:\n  heading: Owners" });

  assert.equal(seenInput?.domSnapshot, "route /owners:\n  heading: Owners");
});

test("review() with absent enrichment.domSnapshot omits it from ReviewInput (never fabricated)", async () => {
  let seenInput: { domSnapshot?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { domSnapshot?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(seenInput?.priorCorrections, undefined);
});

/* enrichment.learnedRules is rendered via the reviewer-specific renderer
   (renderLearnedRulesForReviewer) — active-only, NOT the generator's proven/experimental renderer.
 */

test("review() renders enrichment.learnedRules via the reviewer-specific (active-only) faithful renderer", async () => {
  let seenInput: { learnedRules?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { learnedRules?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {
    learnedRules: [
      { id: "rule-active", trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL", status: "active", confidence: "high" },
      { id: "rule-candidate", trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY", status: "candidate", confidence: "low" },
    ],
  });

  assert.ok(seenInput?.learnedRules?.includes("- selector absent → use role+name (E-EXEC-FAIL)"));
  assert.ok(!seenInput?.learnedRules?.includes("flaky wait"), "candidate rules must never reach the reviewer's reject-on-sight list");
  assert.ok(seenInput?.learnedRules?.includes("Each was learned from a real failure and proven by the value oracle or sustained prevention."));
  assert.ok(seenInput?.learnedRules?.includes("Treat them as an extension of the anti-pattern catalog: if a spec violates one, REJECT."));
});

/* exists on the type and buildReviewerPromptAssembled ALREADY reads it (`input.target === "code" ?
   "tests" : "E2E tests"`, prompts.ts) — grep-confirmed the render side was ready; only this adapter
   never populated the field, so every code-mode review rendered "E2E tests" framing regardless of
   target. ReviewPortStaticContext now carries `target`, threaded verbatim onto ReviewInput.target. ──
 */

test("review() threads ctx.target onto ReviewInput.target for a code-mode review (closes the 'E2E tests' framing bug)", async () => {
  let seenTarget: string | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenTarget = (input as { target?: string }).target; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/code-app", e2eRelDir: "e2e", appName: "app", mode: "diff", target: "code",
  });

  await adapter.review("/mirrors/org/code-app", cases);

  assert.equal(seenTarget, "code", "ReviewInput.target must carry 'code' so buildReviewerPromptAssembled renders 'tests', not 'E2E tests'");
});

test("review() threads ctx.target:'e2e' unchanged (backward compatible default framing)", async () => {
  let seenTarget: string | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenTarget = (input as { target?: string }).target; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", target: "e2e",
  });

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(seenTarget, "e2e");
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
      return { prompt: async () => ({ output: "verdict-json" }), dispose: async () => {} };
    },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts }, {
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
      return { prompt: async () => ({ output: "verdict-json" }), dispose: async () => {} };
    },
  };
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts }, {
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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", timeoutMs: 360_000,
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.approved, false, "a reviewer failure must NEVER read as approved");
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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff", timeoutMs: 360_000,
  });

  const result = await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(result.approved, false);
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

const approving = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
const REVIEW_CONTEXT = { diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff" as const };

test("review() puts the reviewer's limit from the resolver on ReviewInput.stepLimit, asking for the reviewer role and for no other", async () => {
  const seen: ReviewInput[] = [];
  const asked: StepLimitRole[] = [];
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering: renderingRecording(seen), verdicts: approving }, REVIEW_CONTEXT, {
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
  const noResolver = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering: renderingRecording(seen), verdicts: approving }, REVIEW_CONTEXT);
  const noLimit = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering: renderingRecording(seen), verdicts: approving }, REVIEW_CONTEXT, {
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
        return { output: "verdict-json" };
      },
      dispose: async () => {},
    }),
  };
}

test("review() sends its prompt with the reviewer's limit as an option, on every review, beside the options it already carried", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const rendering: PromptRenderingPort = { ...fakeRendering(), renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: { "reviewer-specs": 12 } }) };
  const adapter = new ReviewPortAdapter({ runtime: runtimeRecordingOptions(sent), rendering, verdicts: approving }, REVIEW_CONTEXT, {
    stepLimitFor: async (role) => (role === "reviewer" ? 17 : 41),
  });

  await adapter.review("/mirrors/org/app/e2e", cases);
  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { priorCorrections: ["fix the assertion"] });

  assert.deepEqual(sent.map((opts) => opts?.stepLimit), [17, 17]);
  assert.deepEqual(sent[0]?.sectionSizes, { "reviewer-specs": 12 });
});

test("review() sends its prompt with no limit key when there is no resolver, or when the resolver has none", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const noResolver = new ReviewPortAdapter({ runtime: runtimeRecordingOptions(sent), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);
  const noLimit = new ReviewPortAdapter({ runtime: runtimeRecordingOptions(sent), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT, {
    stepLimitFor: async () => undefined,
  });

  await noResolver.review("/mirrors/org/app/e2e", cases);
  await noLimit.review("/mirrors/org/app/e2e", cases);

  assert.equal(sent.length, 2);
  for (const opts of sent) assert.equal("stepLimit" in (opts ?? {}), false);
});

test("review() lets the run's deadline through: a reviewer turn the run's time ran out on is the run's end, not a reviewer to fail closed on", async () => {
  const runtime: AgentRuntimePort = { openSession: async () => { throw new RunDeadlineExceededError(60_000, "manual", "reviewer", "before-turn"); } };
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);
  await assert.rejects(adapter.review("/mirrors/org/app/e2e", cases), (err: unknown) => err instanceof RunDeadlineExceededError);
});

/* An unavailable reviewer is told apart from a rejection, and from a reviewer that answered unreadably. */

const REVIEW_CTX = { diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff" as const };

test("review() marks a reviewer whose session failed as unavailable, in either place it can fail", async () => {
  const failAtOpen: AgentRuntimePort = { openSession: async () => { throw new Error("HTTP 400: model not supported"); } };
  const failAtPrompt: AgentRuntimePort = { openSession: async () => ({ prompt: async () => { throw new Error("stalled: no activity"); }, dispose: async () => {} }) };
  for (const runtime of [failAtOpen, failAtPrompt]) {
    const result = await new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts: approving }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
    assert.equal(result.unavailable, true);
    assert.equal(result.approved, false);
    assert.equal(result.parsed, false);
  }
});

test("review() marks a reviewer that returned nothing as unavailable: an empty answer judged nothing", async () => {
  for (const output of ["", "  \n "]) {
    const result = await new ReviewPortAdapter({ runtime: fakeRuntime(output), rendering: fakeRendering(), verdicts: approving }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
    assert.equal(result.unavailable, true, JSON.stringify(output));
    assert.match(result.rationale ?? "", /reviewer unavailable: the reviewer returned no output/);
  }
});

test("review() does not mark a real rejection as unavailable, and keeps it exactly as it was", async () => {
  const rejecting = fakeVerdicts({ approved: false, corrections: ["[false-positive] asserts nothing"], blockingCount: 1, parsed: true, valid: true, issues: [], rationale: "asserts nothing real" });
  const result = await new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering: fakeRendering(), verdicts: rejecting }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
  assert.equal("unavailable" in result, false);
  assert.deepEqual([result.approved, result.parsed, result.blockingCount, result.corrections], [false, true, 1, ["[false-positive] asserts nothing"]]);
});

test("review() does not mark an answer it could not read as unavailable: the reviewer was reached, only its verdict is a parse miss", async () => {
  const unreadable = fakeVerdicts({ approved: false, corrections: [], parsed: false, valid: false, issues: ["no verdict JSON found"] });
  const result = await new ReviewPortAdapter({ runtime: fakeRuntime("I think the tests look fine"), rendering: fakeRendering(), verdicts: unreadable }, REVIEW_CTX).review("/mirrors/org/app/e2e", cases);
  assert.equal("unavailable" in result, false);
  assert.equal(result.parsed, false);
  assert.equal(result.approved, false);
});

/* The verdict is the model's spoken answer: reasoning parts are dropped before parsing, and the turn
 * reports what it cost so the run can persist it (never read back into the verdict). */

test("review() asks for the final answer only (textOnly), so reasoning prose never reaches the parser", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const adapter = new ReviewPortAdapter({ runtime: runtimeRecordingOptions(sent), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);

  await adapter.review("/mirrors/org/app/e2e", cases);

  assert.equal(sent[0]?.textOnly, true);
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
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);

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
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering: fakeRendering(), verdicts: approving }, REVIEW_CONTEXT);

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
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts: approving }, REVIEW_CONTEXT);

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { specChanges: "### a.spec.ts\n- old\n+ new" });

  assert.equal(seenInput?.specChanges, "### a.spec.ts\n- old\n+ new");
});

/* The review is the publish gate, so it may only reject on PROVEN (active) learned rules: unproven candidates are generator hints, never grounds for rejection. */
test("review() hands the reviewer the proven learned rules and never an unproven candidate", async () => {
  let seenInput: { learnedRules?: string } | undefined;
  const rendering: PromptRenderingPort = {
    ...fakeRendering(),
    renderReviewer: (input) => { seenInput = input as { learnedRules?: string }; return { text: "reviewer-prompt", sectionSizes: {} }; },
  };
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts: approving }, REVIEW_CONTEXT);
  const proven = { id: "p", trigger: "the diff touches the search form", action: "assert the owners table lists the name", errorClass: "E-FALSE-POSITIVE", status: "active", confidence: "high" } as const;
  const unproven = { id: "u", trigger: "the diff renders a visit history", action: "assert exactly five visit rows", errorClass: "E-WRONG-OBJECTIVE", status: "candidate", confidence: "low" } as const;

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, { learnedRules: [proven, unproven] });

  assert.ok(seenInput?.learnedRules?.includes(proven.action), "a proven rule reaches the reviewer");
  assert.ok(!seenInput?.learnedRules?.includes(unproven.action), "an unproven candidate never does");
});

test("review() opens its session for the review kind: the reviewer role, the reviewer agent and the review timeout", async () => {
  const opened: Array<{ role: string; agent: string | undefined; timeoutMs: number | undefined }> = [];
  const runtime: AgentRuntimePort = {
    openSession: async (role, _cwd, opts) => {
      opened.push({ role, agent: opts?.descriptor?.role, timeoutMs: opts?.timeoutMs });
      return { prompt: async () => ({ output: "verdict-json" }), dispose: async () => {} };
    },
  };
  const adapter = new ReviewPortAdapter({ runtime, rendering: fakeRendering(), verdicts: approving }, { ...REVIEW_CONTEXT, timeoutMs: 7_000 });

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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
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
  const verdicts = fakeVerdicts({ approved: true, corrections: [], parsed: true, valid: true, issues: [] });
  const adapter = new ReviewPortAdapter({ runtime: fakeRuntime("verdict-json"), rendering, verdicts }, {
    diff: "", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", appName: "app", mode: "diff",
  });

  await adapter.review("/mirrors/org/app/e2e", cases, undefined, {});

  assert.equal(seenInput?.executionResult, undefined);
});
