import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type AuthoringPorts, type GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable } from "@contexts/generation/domain/manifest-repository.ts";
import type { GeneratorDelivery } from "@contexts/generation/application/ports/verdict-parser.port.ts";
import { submittingRuntime } from "../../../support/submission.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/domain/generation-end.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { NOOP_KIND, type NoopKind } from "@kernel/noop-kind.ts";
import type { AgentPromptOpts, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";

/** One scripted turn: the text the agent returned and the stats its runtime measured for it (none for a runtime that cannot). */
interface Turn {
  output: string;
  stats?: AgentTurnStats;
}

const FINISHED: AgentTurnStats = { maxSteps: 30, stepsUsed: 12, exhausted: false, writeCount: 2, observationComplete: true };
const EXHAUSTED: AgentTurnStats = { maxSteps: 30, stepsUsed: 30, exhausted: true, writeCount: 0, observationComplete: true };

const SPEC_VERDICT = '{"specs":["flows/login.spec.ts"]}';
const EMPTY_VERDICT = '{"specs":[]}';
const NOOP_VERDICT = '{"specs":[],"noop":{"reason":"the diff only renames an internal helper"}}';

/** A stand-in for the verdict parser that reads the compact verdicts of these tests. */
function readGenerator({ answer, noSubmission, output }: GeneratorDelivery): GeneratorDeliverable {
  if (answer === undefined) return { specs: [], parsed: false, note: noSubmission, outputTail: output };
  const verdict = answer as { specs?: string[]; noop?: { reason?: string; kind?: NoopKind } };
  return {
    specs: verdict.specs ?? [],
    parsed: true,
    ...(verdict.noop?.reason ? { noopReason: verdict.noop.reason, noopKind: verdict.noop.kind ?? NOOP_KIND.UNSPECIFIED } : {}),
    outputTail: output,
  };
}

interface Run {
  result: GenerationResult;
  prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }>;
}

async function generate(turns: Turn[]): Promise<Run> {
  const prompts: Run["prompts"] = [];
  let turnIndex = 0;
  const ports: AuthoringPorts = {
    runtime: submittingRuntime({
      openSession: async () => ({
        prompt: async (text, opts) => {
          prompts.push({ text, opts });
          const turn = turns[Math.min(turnIndex++, turns.length - 1)]!;
          if (turn.stats) opts?.onTurnStats?.(turn.stats);
          return { output: turn.output };
        },
        dispose: () => {},
      }),
    }),
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN PROMPT", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      readGenerator,
      readReview: () => ({ approved: true, findings: [], valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
  };
  const result = await new GenerateTestsUseCase(ports).author({
    repo: "org/demo",
    sha: "abc1234",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    mode: "diff",
    appName: "a",
  });
  return { result, prompts };
}

test("a generation that wrote specs ends delivered and forwards its main turn's stats", async () => {
  const { result, prompts } = await generate([{ output: SPEC_VERDICT, stats: FINISHED }]);
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/login.spec.ts"]);
  assert.equal(result.turn?.stepsUsed, FINISHED.stepsUsed);
  assert.equal(result.turn?.writeCount, FINISHED.writeCount);
  assert.equal(result.turn?.exhausted, false);
  assert.equal(prompts.length, 1);
});

test("an exhausted main turn with no specs ends exhausted and is never continued", async () => {
  const { result, prompts } = await generate([{ output: "Maximum steps for this agent have been reached.", stats: EXHAUSTED }]);
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
  assert.equal(prompts.length, 1, "the session that ran out of steps is not asked to submit again");
});

test("an exhausted generation's note carries what it measured and the end of its output", async () => {
  const { result } = await generate([{ output: "I cannot make further tool calls. The harness was reviewed.", stats: EXHAUSTED }]);
  assert.match(result.note ?? "", /30\/30/);
  assert.match(result.note ?? "", /writes:? 0\b/);
  assert.ok((result.note ?? "").includes("The harness was reviewed."));
  assert.ok((result.note ?? "").length <= GENERATION_NOTE_MAX_CHARS);
});

test("the stats forwarded for an exhausted generation are the main turn's", async () => {
  const { result } = await generate([{ output: "cut off", stats: EXHAUSTED }]);
  assert.equal(result.turn?.maxSteps, EXHAUSTED.maxSteps);
  assert.equal(result.turn?.stepsUsed, EXHAUSTED.stepsUsed);
  assert.equal(result.turn?.exhausted, true);
});

test("an exhausted main turn that still delivered specs continues: exhaustion is only recorded", async () => {
  const { result } = await generate([{ output: SPEC_VERDICT, stats: EXHAUSTED }]);
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/login.spec.ts"]);
  assert.equal(result.turn?.exhausted, true, "recorded on the stats, with no failure");
});

test("an exhausted main turn that submitted nothing is still not continued", async () => {
  const { prompts, result } = await generate([{ output: "no json at all", stats: EXHAUSTED }]);
  assert.equal(prompts.length, 1);
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
});

test("an empty verdict with no decision gets exactly one continuation, and a continuation that still decides nothing ends undecided", async () => {
  const { result, prompts } = await generate([
    { output: EMPTY_VERDICT, stats: FINISHED },
    { output: EMPTY_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2, "one turn and one continuation, never a second one");
  assert.equal(prompts[1]!.opts?.isRepair, true);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY);
  assert.ok((result.note ?? "").length > 0);
});

test("an empty verdict whose continuation declares a no-op ends as a declared no-op with the reason as its note", async () => {
  const { result, prompts } = await generate([
    { output: EMPTY_VERDICT, stats: FINISHED },
    { output: NOOP_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.equal(result.note, "the diff only renames an internal helper");
});

test("a declared no-op reports the kind its verdict named, and unspecified when it named none", async () => {
  const unobservable = await generate([{ output: '{"specs":[],"noop":{"kind":"unobservable","reason":"DEV listed no rows, so the button never rendered"}}', stats: FINISHED }]);
  assert.equal(unobservable.result.end, GENERATION_END.DECLARED_NOOP);
  assert.equal(unobservable.result.noopKind, NOOP_KIND.UNOBSERVABLE);
  assert.equal((await generate([{ output: NOOP_VERDICT, stats: FINISHED }])).result.noopKind, NOOP_KIND.UNSPECIFIED);
});

test("a generation that is no declared no-op reports no kind", async () => {
  assert.equal("noopKind" in (await generate([{ output: SPEC_VERDICT, stats: FINISHED }])).result, false);
  assert.equal("noopKind" in (await generate([{ output: EMPTY_VERDICT, stats: FINISHED }, { output: EMPTY_VERDICT, stats: FINISHED }])).result, false);
});

test("a no-op declared at once needs no continuation", async () => {
  const { result, prompts } = await generate([{ output: NOOP_VERDICT, stats: FINISHED }]);
  assert.equal(prompts.length, 1);
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
});

test("a final step with no text reads as no submission and gets one continuation", async () => {
  const { result, prompts } = await generate([
    { output: "", stats: FINISHED },
    { output: SPEC_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.DELIVERED);
});

test("an output that stays without a submission after its one continuation ends without a verdict, saying why", async () => {
  const { result, prompts } = await generate([
    { output: "prose only", stats: FINISHED },
    { output: "more prose", stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
  assert.equal(result.parsed, false);
  assert.match(result.note ?? "", /no accepted submission/);
});

test("a generation asks for its verdict through the submit tool and states no final-step reading", async () => {
  const { prompts } = await generate([{ output: SPEC_VERDICT, stats: FINISHED }]);
  assert.equal(prompts[0]!.opts?.submit?.tool, "submit_specs");
  assert.equal(prompts[0]!.opts?.finalStepOnly, undefined);
});

test("a runtime that cannot measure a turn leaves the generation's stats out, and its exhaustion unknown", async () => {
  const { result } = await generate([{ output: EMPTY_VERDICT }, { output: EMPTY_VERDICT }]);
  assert.equal(result.turn, undefined);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY);
});

test("a generation whose turns were measured as not exhausted is not classified exhausted", async () => {
  const unknown: AgentTurnStats = { maxSteps: 30, stepsUsed: null, exhausted: null, writeCount: null, observationComplete: false };
  const { result } = await generate([{ output: EMPTY_VERDICT, stats: unknown }, { output: EMPTY_VERDICT, stats: unknown }]);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY, "unknown exhaustion is not exhaustion");
  assert.match(result.note ?? "", /unavailable/);
});

test("a declared no-op's very long reason is bounded to the note limit", async () => {
  const reason = `START ${"why ".repeat(GENERATION_NOTE_MAX_CHARS)}`;
  const { result } = await generate([{ output: JSON.stringify({ specs: [], noop: { reason } }), stats: FINISHED }]);
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.ok((result.note ?? "").length <= GENERATION_NOTE_MAX_CHARS);
  assert.ok((result.note ?? "").startsWith("START"));
});
