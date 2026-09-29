import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts, type GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable, ManifestEntry } from "@contexts/generation/application/ports/index.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/domain/generation-end.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
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
function parseGenerator(text: string): GeneratorDeliverable {
  try {
    const verdict = JSON.parse(text) as { specs?: string[]; noop?: { reason?: string } };
    return {
      specs: verdict.specs ?? [],
      parsed: true,
      ...(verdict.noop?.reason ? { noopReason: verdict.noop.reason } : {}),
      outputTail: text,
    };
  } catch {
    return { specs: [], parsed: false, note: "the agent emitted no parseable verdict", outputTail: text };
  }
}

interface Run {
  result: GenerationResult;
  prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }>;
  repairsChecked: string[];
}

async function generate(turns: Turn[], options: { valid?: (text: string) => boolean; noRepair?: boolean } = {}): Promise<Run> {
  const prompts: Run["prompts"] = [];
  const repairsChecked: string[] = [];
  const valid = options.valid ?? ((text: string) => parseGenerator(text).parsed === true && (parseGenerator(text).specs.length > 0 || !!parseGenerator(text).noopReason));
  let turnIndex = 0;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async (text, opts) => {
          prompts.push({ text, opts });
          const turn = turns[Math.min(turnIndex++, turns.length - 1)]!;
          if (turn.stats) opts?.onTurnStats?.(turn.stats);
          return { output: turn.output };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN PROMPT", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator,
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    ...(options.noRepair
      ? {}
      : {
          repair: {
            checkGenerator: (text: string) => {
              repairsChecked.push(text);
              return valid(text) ? { valid: true, issues: [] } : { valid: false, issues: ["no decision"] };
            },
            instruction: () => "REPAIR PROMPT",
          },
        }),
  };
  const result = await new GenerateTestsUseCase(ports).generate({
    repo: "org/demo",
    sha: "abc1234",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  });
  return { result, prompts, repairsChecked };
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

test("an exhausted main turn with no specs ends exhausted and is never sent a repair", async () => {
  const { result, prompts, repairsChecked } = await generate([{ output: "Maximum steps for this agent have been reached.", stats: EXHAUSTED }]);
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
  assert.equal(prompts.length, 1, "the session that ran out of steps is not asked to re-emit a verdict");
  assert.equal(repairsChecked.length, 0);
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

test("an exhausted main turn whose verdict cannot be read is still not sent a repair", async () => {
  const { prompts, result } = await generate([{ output: "no json at all", stats: EXHAUSTED }]);
  assert.equal(prompts.length, 1);
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
});

test("an empty verdict with no decision gets exactly one repair, and a repair that still decides nothing ends undecided", async () => {
  const { result, prompts } = await generate([
    { output: EMPTY_VERDICT, stats: FINISHED },
    { output: EMPTY_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2, "one turn and one repair, never a second repair");
  assert.equal(prompts[1]!.opts?.isRepair, true);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY);
  assert.ok((result.note ?? "").length > 0);
});

test("an empty verdict whose repair declares a no-op ends as a declared no-op with the reason as its note", async () => {
  const { result, prompts } = await generate([
    { output: EMPTY_VERDICT, stats: FINISHED },
    { output: NOOP_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.equal(result.note, "the diff only renames an internal helper");
});

test("a no-op declared at once needs no repair", async () => {
  const { result, prompts } = await generate([{ output: NOOP_VERDICT, stats: FINISHED }]);
  assert.equal(prompts.length, 1);
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
});

test("a repair turn that ran out of steps ends the generation exhausted, keeps the main turn's stats, and says so in the note", async () => {
  const { result, prompts } = await generate([
    { output: EMPTY_VERDICT, stats: FINISHED },
    { output: "cut off in the repair", stats: EXHAUSTED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.EXHAUSTED);
  assert.equal(result.turn?.stepsUsed, FINISHED.stepsUsed, "the stats forwarded are the generation's main turn");
  assert.equal(result.turn?.exhausted, false);
  assert.match(result.note ?? "", /repair/i);
});

test("a final step with no text reads as no verdict and gets one repair", async () => {
  const { result, prompts } = await generate([
    { output: "", stats: FINISHED },
    { output: SPEC_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.DELIVERED);
});

test("an output that stays unreadable after its one repair ends without a verdict, keeping the parser's note", async () => {
  const { result, prompts } = await generate([
    { output: "prose only", stats: FINISHED },
    { output: "more prose", stats: FINISHED },
  ]);
  assert.equal(prompts.length, 2);
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
  assert.equal(result.parsed, false);
  assert.equal(result.note, "the agent emitted no parseable verdict");
});

test("with no repair port an empty verdict is classified as it stands", async () => {
  const { result, prompts } = await generate([{ output: EMPTY_VERDICT, stats: FINISHED }], { noRepair: true });
  assert.equal(prompts.length, 1);
  assert.equal(result.end, GENERATION_END.UNDECIDED_EMPTY);
});

test("the generator's main and repair prompts ask for the final step's text only", async () => {
  const { prompts } = await generate([
    { output: EMPTY_VERDICT, stats: FINISHED },
    { output: NOOP_VERDICT, stats: FINISHED },
  ]);
  assert.equal(prompts[0]!.opts?.finalStepOnly, true);
  assert.equal(prompts[1]!.opts?.finalStepOnly, true);
  assert.equal(prompts[1]!.opts?.isRepair, true);
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
