import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts, type GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { DIFF_TIERS, DIFF_TIME_BUDGET_MS } from "@kernel/diff-stat.ts";
import type { DiffTimeBudgets } from "@contexts/generation/domain/generator-time-budget.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import { renderGenerationNote } from "@contexts/generation/domain/generation-end.ts";
import { REPAIR_TURN_TIMEOUT_MS } from "@contexts/generation/domain/repair-turn.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";

/* A diff of `added` one-line additions to a single file: its tier follows from how many. */
const diffOfLines = (added: number): string =>
  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", ...Array.from({ length: added }, (_, i) => `+line ${i}`), ""].join("\n");

const TINY_DIFF = diffOfLines(1);
const FOCUSED_DIFF = diffOfLines(DIFF_TIERS.tiny.maxLines + 1);
const BROAD_DIFF = diffOfLines(DIFF_TIERS.focused.maxLines + 1);

const NOOP_REASON = "the change touches no behavior a user can reach";

const TINY_MS = DIFF_TIME_BUDGET_MS.tiny as number;
const FOCUSED_MS = DIFF_TIME_BUDGET_MS.focused as number;

type Step = ({ output: string } | { throws: Error }) & { takes?: number };

interface Harness {
  opened: Array<{ role: AgentRole; opts: OpenSessionOpts | undefined }>;
  prompts: Array<{ role: AgentRole; isRepair: boolean; timeoutMs: number | undefined; withoutTools: boolean }>;
  /** The fake clock the use case reads; a step's `takes` moves it forward while that prompt runs. */
  clock: { now: number };
  disposed: AgentRole[];
}

function baseInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: TINY_DIFF, mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
    target: "e2e", mode: "diff", appName: "a",
    ...over,
  };
}

function build(
  generatorSteps: Step[],
  opts: { promptCapMs?: number; specs?: string[]; repairInvalid?: boolean; timeBudgets?: DiffTimeBudgets; repairTimeoutMs?: number } = {},
): { ports: GenerationPorts; seen: Harness } {
  const seen: Harness = { opened: [], prompts: [], disposed: [], clock: { now: 1_000_000 } };
  const steps = [...generatorSteps];
  const ports: GenerationPorts = {
    runtime: {
      openSession: async (role, _cwd, sessionOpts) => {
        seen.opened.push({ role, opts: sessionOpts });
        return {
          prompt: async (_text, promptOpts) => {
            seen.prompts.push({ role, isRepair: promptOpts?.isRepair === true, timeoutMs: promptOpts?.timeoutMs, withoutTools: promptOpts?.withoutTools === true });
            if (role === "reviewer") return { output: "REVIEW" };
            const step = steps.shift() ?? { output: "" };
            seen.clock.now += step.takes ?? 0;
            if ("throws" in step) throw step.throws;
            return { output: step.output };
          },
          dispose: () => { seen.disposed.push(role); },
        };
      },
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "PROMPT", sectionSizes: {} }),
      renderReviewer: () => ({ text: "REVIEW_PROMPT", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text) =>
        text.includes("SPECS")
          ? { specs: opts.specs ?? ["flows/a.spec.ts"], parsed: true }
          : text.includes("NOOP")
            ? { specs: [], parsed: true, noopReason: NOOP_REASON }
            : { specs: [], parsed: false },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    now: () => seen.clock.now,
    ...(opts.promptCapMs !== undefined ? { promptCapMs: opts.promptCapMs } : {}),
    ...(opts.timeBudgets ? { timeBudgets: opts.timeBudgets } : {}),
    ...(opts.repairTimeoutMs !== undefined ? { repairTimeoutMs: opts.repairTimeoutMs } : {}),
    ...(opts.repairInvalid ? { repair: { checkGenerator: () => ({ valid: false, issues: ["no verdict"] }), instruction: () => "REPAIR" } } : {}),
  };
  return { ports, seen };
}

const generatorOpen = (seen: Harness) => seen.opened.find((o) => o.role === "primary");

for (const [label, diff, expected] of [
  ["tiny", TINY_DIFF, TINY_MS],
  ["focused", FOCUSED_DIFF, FOCUSED_MS],
] as const) {
  test(`a ${label} diff run's first pass opens the generator's session with the time its tier allows`, async () => {
    const { ports, seen } = build([{ output: "SPECS" }]);
    await new GenerateTestsUseCase(ports).generate(baseInput({ diff }));
    assert.equal(generatorOpen(seen)?.opts?.timeoutMs, expected);
  });
}

test("the budgets the composition root resolved replace the defaults: the session opens with the time its tier was given, and a broad run can be bounded", async () => {
  const timeBudgets = { tiny: 45_000, focused: 90_000, broad: 7_200_000 };
  for (const [diff, expected] of [[TINY_DIFF, 45_000], [FOCUSED_DIFF, 90_000], [BROAD_DIFF, 7_200_000]] as const) {
    const { ports, seen } = build([{ output: "SPECS" }], { timeBudgets });
    await new GenerateTestsUseCase(ports).generate(baseInput({ diff }));
    assert.equal(generatorOpen(seen)?.opts?.timeoutMs, expected);
  }
});

test("a resolved budget the host's prompt deadline does not exceed sets no budget: the host's deadline still fires first", async () => {
  const { ports, seen } = build([{ output: "SPECS" }], { timeBudgets: { tiny: 600_000, focused: 600_000, broad: 600_000 }, promptCapMs: 600_000 });
  await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});

test("a first pass cut by an overridden budget reports the time it was actually given", async () => {
  const { ports } = build([{ throws: new AgentTimeoutError("OpenCode prompt: timed out"), takes: 45_000 }], { timeBudgets: { tiny: 45_000, focused: 90_000, broad: null } });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.TIME_BUDGET);
  assert.match(result.note ?? "", /Time budget of 45 s exhausted/);
});

test("a broad diff run's session is opened with no time of its own: it keeps the host's default", async () => {
  const { ports, seen } = build([{ output: "SPECS" }]);
  await new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF }));
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});

test("the tier follows the changed files the input names, as the prompt's own effort line does", async () => {
  const { ports, seen } = build([{ output: "SPECS" }]);
  const many = Array.from({ length: DIFF_TIERS.focused.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);
  await new GenerateTestsUseCase(ports).generate(baseInput({ diff: TINY_DIFF, intent: { type: "feat", breaking: false, changedFiles: many } as OpencodeRunInput["intent"] }));
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false, "nine files is a broad change however few the lines");
});

test("a host whose prompt deadline is not above the tier's time keeps its own deadline: no budget is set and its timeout stays the integration error it is", async () => {
  const { ports, seen } = build([{ throws: new AgentTimeoutError("OpenCode prompt: timed out after 359000ms") }], { promptCapMs: TINY_MS - 1_000 });
  await assert.rejects(new GenerateTestsUseCase(ports).generate(baseInput()), AgentTimeoutError);
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});

test("every mode other than diff opens the generator's session with the host's default", async () => {
  for (const mode of ["manual", "complete", "exhaustive"] as const) {
    const { ports, seen } = build([{ output: "SPECS" }]);
    await new GenerateTestsUseCase(ports).generate(baseInput({ mode, guidance: "g" }));
    assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false, mode);
  }
});

test("a regeneration turn keeps the host's default: a timeout there is never read as 'no fixes'", async () => {
  const { ports, seen } = build([{ output: "SPECS" }]);
  await new GenerateTestsUseCase(ports).generate(baseInput({ reviewCorrections: ["fix the selector"] }));
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});

test("a generator turn cut off by its time budget ends the generation as time-budget, with a note naming the budget", async () => {
  const { ports, seen } = build([{ throws: new AgentTimeoutError("OpenCode prompt: timed out after 360000ms") }]);
  const result: GenerationResult = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.TIME_BUDGET);
  assert.deepEqual(result.specs, []);
  assert.equal(result.note, renderGenerationNote({ end: GENERATION_END.TIME_BUDGET, budgetMs: TINY_MS }));
  assert.deepEqual(seen.disposed, ["primary"], "the cut-off session is still disposed");
});

test("a generation that ran out of time does not open the reviewer on specs it never produced", async () => {
  const { ports, seen } = build([{ throws: new AgentTimeoutError("timed out") }]);
  const result = await new GenerateTestsUseCase(ports).generate(baseInput({ }));
  assert.equal(result.end, GENERATION_END.TIME_BUDGET);
  assert.equal(seen.opened.some((o) => o.role === "reviewer"), false);
});

test("a declared no-op has no specs for a reviewer to judge: its session is never opened, so a spent run deadline cannot turn the no-op into a time-budget end", async () => {
  const { ports, seen } = build([{ output: "NOOP" }]);
  const open = ports.runtime.openSession.bind(ports.runtime);
  ports.runtime.openSession = async (role, cwd, sessionOpts) => {
    if (role === "reviewer") throw new RunDeadlineExceededError(600_000, "diff", "reviewer", "before-turn");
    return open(role, cwd, sessionOpts);
  };
  const result = await new GenerateTestsUseCase(ports).generate(baseInput({ }));

  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.deepEqual(result.specs, []);
  assert.equal(seen.opened.some((o) => o.role === "reviewer"), false);
});

test("a timeout from another realm's error class is still the time budget, matched by name", async () => {
  const foreign = new Error("timed out");
  foreign.name = "AgentTimeoutError";
  const { ports } = build([{ throws: foreign }]);
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.TIME_BUDGET);
});

test("a timeout the generator was given no budget for is not the time budget: it surfaces as the integration error it is", async () => {
  const { ports } = build([{ throws: new AgentTimeoutError("OpenCode prompt: timed out after 1500000ms") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF })), AgentTimeoutError);
});

test("a timeout in a mode that has no budget surfaces unchanged", async () => {
  const { ports } = build([{ throws: new AgentTimeoutError("timed out") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).generate(baseInput({ mode: "manual", guidance: "g" })), AgentTimeoutError);
});

test("a provider failure under a budget is not the time budget: it surfaces unchanged", async () => {
  const { ports, seen } = build([{ throws: new AgentUnavailableError("provider rejected: out of credits") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).generate(baseInput()), AgentUnavailableError);
  assert.deepEqual(seen.disposed, ["primary"]);
});

test("a plain error under a budget that merely mentions a timeout is not the time budget", async () => {
  const { ports } = build([{ throws: new Error("socket hang up after a timeout") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).generate(baseInput()), /socket hang up/);
});

test("a repair turn that runs out of time after specs were delivered keeps the delivery and does not end the run", async () => {
  const { ports } = build([{ output: "SPECS but malformed", takes: TINY_MS - 60_000 }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/a.spec.ts"]);
});

test("a repair turn that runs out of time with no spec delivered ends as time-budget and the note names the repair", async () => {
  const { ports } = build([{ output: "no verdict at all", takes: TINY_MS - 60_000 }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.TIME_BUDGET);
  assert.equal(result.note, renderGenerationNote({ end: GENERATION_END.TIME_BUDGET, budgetMs: TINY_MS, repair: true }));
});

test("a repair cut by the time budget after a main turn that declared a no-op leaves the no-op standing", async () => {
  const { ports } = build([{ output: "NOOP malformed", takes: TINY_MS - 60_000 }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.equal(result.note, NOOP_REASON);
  assert.deepEqual(result.specs, []);
});

test("the budget bounds the whole first pass: the main prompt may use all of it and the repair only what the main prompt left", async () => {
  const MAIN_TOOK = TINY_MS - 100_000;
  const { ports, seen } = build([{ output: "malformed", takes: MAIN_TOOK }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).generate(baseInput());
  const [main, repair] = seen.prompts;
  assert.equal(main?.timeoutMs, TINY_MS);
  assert.equal(repair?.isRepair, true);
  assert.equal(repair?.timeoutMs, 100_000);
});

test("a repair prompt never gets more than its own cap, however much of the budget is left", async () => {
  const { ports, seen } = build([{ output: "malformed", takes: 1_000 }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(seen.prompts[1]?.timeoutMs, REPAIR_TURN_TIMEOUT_MS);
});

test("a main prompt that used the whole budget leaves no time to repair: the repair is not asked and the generation ends as time-budget naming the repair", async () => {
  const { ports, seen } = build([{ output: "no verdict at all", takes: TINY_MS }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(seen.prompts.some((p) => p.isRepair), false, "no repair prompt was sent");
  assert.equal(result.end, GENERATION_END.TIME_BUDGET);
  assert.equal(result.note, renderGenerationNote({ end: GENERATION_END.TIME_BUDGET, budgetMs: TINY_MS, repair: true }));
});

test("a main prompt that used the whole budget but declared a no-op keeps it: nothing is left to repair and nothing is lost", async () => {
  const { ports } = build([{ output: "NOOP", takes: TINY_MS }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
});

test("a run with no budget sends its main prompt no time of its own and its repair only the repair cap", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF }));
  assert.equal(seen.prompts.length, 2);
  assert.equal(seen.prompts[0]?.timeoutMs, undefined);
  assert.equal(seen.prompts[1]?.timeoutMs, REPAIR_TURN_TIMEOUT_MS);
});

test("the contract-repair prompt runs with no tools, and the prompt it repairs keeps its tools", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF }));
  assert.deepEqual(seen.prompts.map((p) => p.withoutTools), [false, true]);
});

test("a repair cap the ports state replaces the default", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true, repairTimeoutMs: 30_000 });
  await new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF }));
  assert.equal(seen.prompts[1]?.timeoutMs, 30_000);
});

test("a repair that ran past its own cap, with the budget to spare, leaves the first answer standing: specs delivered stay delivered", async () => {
  const { ports } = build([{ output: "SPECS but malformed" }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/a.spec.ts"]);
});

test("a repair that ran past its own cap with no readable verdict ends the generation as no-verdict, loudly, and not as the time budget", async () => {
  const { ports } = build([{ output: "no verdict at all" }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput());
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
  assert.match(result.note ?? "", /contract-repair turn \(tools disabled\) did not answer within 120 s/);
});

test("a repair that ran past its own cap in a run with no budget does not become an integration error", async () => {
  const { ports } = build([{ output: "no verdict at all" }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF }));
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
});

test("a repair that fails for any reason other than time is still the integration error it is", async () => {
  const { ports } = build([{ output: "no verdict at all" }, { throws: new AgentUnavailableError("provider rejected: out of credits") }], { repairInvalid: true });
  await assert.rejects(new GenerateTestsUseCase(ports).generate(baseInput()), AgentUnavailableError);
});

const deadlineLeaving = (leftMs: number | null) => ({
  remainingMs: () => leftMs ?? undefined,
  describe: () => ({ label: "diff-tiny", budgetMs: 1 }),
  allowance: () => leftMs,
});

test("a first pass never outlives what the run deadline has left: the session and its prompts are given the smaller of the tier's time and that", async () => {
  const left = TINY_MS - 60_000;
  const { ports, seen } = build([{ output: "SPECS" }]);
  await new GenerateTestsUseCase(ports).generate(baseInput(), { deadline: deadlineLeaving(left) });
  assert.equal(generatorOpen(seen)?.opts?.timeoutMs, left);
  assert.ok((seen.prompts[0]?.timeoutMs ?? Infinity) <= left);
});

test("a first pass the run deadline leaves more time than its tier keeps the tier's time, and one with no deadline armed keeps it too", async () => {
  for (const left of [TINY_MS + 1, null]) {
    const { ports, seen } = build([{ output: "SPECS" }]);
    await new GenerateTestsUseCase(ports).generate(baseInput(), { deadline: deadlineLeaving(left) });
    assert.equal(generatorOpen(seen)?.opts?.timeoutMs, TINY_MS);
  }
});

test("a tier that bounds nothing stays unbounded whatever the deadline leaves: the deadline's own runtime ends such a turn", async () => {
  const { ports, seen } = build([{ output: "SPECS" }], { timeBudgets: { tiny: 45_000, focused: 90_000, broad: null } });
  await new GenerateTestsUseCase(ports).generate(baseInput({ diff: BROAD_DIFF }), { deadline: deadlineLeaving(10_000) });
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});

test("a regeneration keeps the host's default whatever the deadline leaves", async () => {
  const { ports, seen } = build([{ output: "SPECS" }]);
  await new GenerateTestsUseCase(ports).generate(baseInput({ fixCases: [{ name: "c", status: "fail" } as never] }), { deadline: deadlineLeaving(1_000) });
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});
