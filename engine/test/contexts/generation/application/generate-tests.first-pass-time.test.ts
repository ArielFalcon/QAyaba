import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type AuthoringPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import { REPAIR_TURN_TIMEOUT_MS } from "@contexts/generation/domain/repair-turn.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { RunDeadlineExceededError, type RunDeadlineView } from "@kernel/run-deadline.ts";
import { RunDeadlineRuntime } from "@contexts/run-orchestration/infrastructure/run-deadline-runtime.adapter.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { TimeLimitSource } from "@kernel/turn-limit.ts";

/* A diff of `added` one-line additions to a single file: the size of the change is the only thing that varies between the cases. */
const diffOfLines = (added: number): string =>
  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", ...Array.from({ length: added }, (_, i) => `+line ${i}`), ""].join("\n");

const TINY_DIFF = diffOfLines(1);
const FOCUSED_DIFF = diffOfLines(41);
const BROAD_DIFF = diffOfLines(401);
const SIZES = [["tiny", TINY_DIFF], ["focused", FOCUSED_DIFF], ["broad", BROAD_DIFF]] as const;

const NOOP_REASON = "the change touches no behavior a user can reach";

type Step = { output: string } | { throws: Error };

interface Harness {
  opened: Array<{ role: AgentRole; opts: OpenSessionOpts | undefined }>;
  prompts: Array<{ role: AgentRole; isRepair: boolean; timeoutMs: number | undefined; timeLimit: TimeLimitSource | undefined; withoutTools: boolean }>;
  disposed: AgentRole[];
}

function baseInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: TINY_DIFF, mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
    mode: "diff", appName: "a",
    ...over,
  };
}

function build(
  generatorSteps: Step[],
  opts: { specs?: string[]; repairInvalid?: boolean; repairTimeoutMs?: number } = {},
): { ports: AuthoringPorts; seen: Harness } {
  const seen: Harness = { opened: [], prompts: [], disposed: [] };
  const steps = [...generatorSteps];
  const ports: AuthoringPorts = {
    runtime: {
      openSession: async (role, _cwd, sessionOpts) => {
        seen.opened.push({ role, opts: sessionOpts });
        return {
          prompt: async (_text, promptOpts) => {
            seen.prompts.push({ role, isRepair: promptOpts?.isRepair === true, timeoutMs: promptOpts?.timeoutMs, timeLimit: promptOpts?.timeLimit, withoutTools: promptOpts?.withoutTools === true });
            if (role === "reviewer") return { output: "REVIEW" };
            const step = steps.shift() ?? { output: "" };
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
      parseReview: () => ({ approved: true, findings: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    ...(opts.repairTimeoutMs !== undefined ? { repairTimeoutMs: opts.repairTimeoutMs } : {}),
    ...(opts.repairInvalid ? { repair: { checkGenerator: () => ({ valid: false, issues: ["no verdict"] }), instruction: () => "REPAIR" } } : {}),
  };
  return { ports, seen };
}

const generatorOpen = (seen: Harness) => seen.opened.find((o) => o.role === "author");

/** A run deadline with `allowanceMs` for the generate purpose out of `remainingMs` left. */
const deadlineView = (allowanceMs: number, remainingMs: number): RunDeadlineView => ({
  remainingMs: () => remainingMs,
  describe: () => ({ label: "diff", budgetMs: 3_600_000 }),
  allowance: () => allowanceMs,
  currentPurpose: () => "generate" as const,
});

for (const [label, diff] of SIZES) {
  test(`a ${label} diff run's first pass states no time of its own: the session opens with the host's default and the prompt carries no limit`, async () => {
    const { ports, seen } = build([{ output: "SPECS" }]);
    await new GenerateTestsUseCase(ports).author(baseInput({ diff }));
    assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
    assert.equal(seen.prompts[0]?.timeoutMs, undefined);
    assert.equal(seen.prompts[0]?.timeLimit, undefined);
  });
}

test("a first pass is held to what the run deadline allots the generate purpose, typed as the allotment, whatever the size of the change", async () => {
  for (const [label, diff] of SIZES) {
    const { ports, seen } = build([{ output: "SPECS" }]);
    const bounded: AuthoringPorts = { ...ports, runtime: new RunDeadlineRuntime(ports.runtime, deadlineView(600_000, 900_000)) };
    await new GenerateTestsUseCase(bounded).author(baseInput({ diff }));
    assert.equal(seen.prompts[0]?.timeoutMs, 600_000, label);
    assert.equal(seen.prompts[0]?.timeLimit, "allotment", label);
  }
});

test("a first pass cut by the host's own prompt deadline is never the time budget: it surfaces as the integration error it is, whatever the size of the change", async () => {
  for (const [label, diff] of SIZES) {
    const { ports, seen } = build([{ throws: new AgentTimeoutError("OpenCode prompt: timed out after 1500000ms") }]);
    await assert.rejects(new GenerateTestsUseCase(ports).author(baseInput({ diff })), AgentTimeoutError, label);
    assert.deepEqual(seen.disposed, ["author"], `${label}: the cut-off session is still disposed`);
  }
});

test("every mode other than diff opens the generator's session with the host's default", async () => {
  for (const mode of ["manual"] as const) {
    const { ports, seen } = build([{ output: "SPECS" }]);
    await new GenerateTestsUseCase(ports).author(baseInput({ mode, guidance: "g" }));
    assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false, mode);
  }
});

test("a regeneration turn keeps the host's default: a timeout there is never read as 'no fixes'", async () => {
  const { ports, seen } = build([{ output: "SPECS" }]);
  await new GenerateTestsUseCase(ports).author(baseInput({ reviewCorrections: ["fix the selector"] }));
  assert.equal("timeoutMs" in (generatorOpen(seen)?.opts ?? {}), false);
});

test("a declared no-op has no specs for a reviewer to judge: its session is never opened, so a spent run deadline cannot turn the no-op into a failure", async () => {
  const { ports, seen } = build([{ output: "NOOP" }]);
  const open = ports.runtime.openSession.bind(ports.runtime);
  ports.runtime.openSession = async (role, cwd, sessionOpts) => {
    if (role === "reviewer") throw new RunDeadlineExceededError(600_000, "diff", "reviewer", "before-turn");
    return open(role, cwd, sessionOpts);
  };
  const result = await new GenerateTestsUseCase(ports).author(baseInput());

  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.deepEqual(result.specs, []);
  assert.equal(seen.opened.some((o) => o.role === "reviewer"), false);
});

test("a provider failure of the first pass surfaces unchanged", async () => {
  const { ports, seen } = build([{ throws: new AgentUnavailableError("provider rejected: out of credits") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).author(baseInput()), AgentUnavailableError);
  assert.deepEqual(seen.disposed, ["author"]);
});

test("a plain error that merely mentions a timeout surfaces unchanged", async () => {
  const { ports } = build([{ throws: new Error("socket hang up after a timeout") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).author(baseInput()), /socket hang up/);
});

test("a repair prompt never gets more than its own cap, however long the main prompt took", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).author(baseInput());
  assert.equal(seen.prompts[1]?.isRepair, true);
  assert.equal(seen.prompts[1]?.timeoutMs, REPAIR_TURN_TIMEOUT_MS);
  assert.equal(seen.prompts[1]?.timeLimit, "repair-cap");
});

test("a run sends its main prompt no time of its own and its repair only the repair cap", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).author(baseInput({ diff: BROAD_DIFF }));
  assert.equal(seen.prompts.length, 2);
  assert.equal(seen.prompts[0]?.timeoutMs, undefined);
  assert.equal(seen.prompts[1]?.timeoutMs, REPAIR_TURN_TIMEOUT_MS);
});

test("the contract-repair prompt runs with no tools, and the prompt it repairs keeps its tools", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true });
  await new GenerateTestsUseCase(ports).author(baseInput({ diff: BROAD_DIFF }));
  assert.deepEqual(seen.prompts.map((p) => p.withoutTools), [false, true]);
});

test("a repair cap the ports state replaces the default", async () => {
  const { ports, seen } = build([{ output: "malformed" }, { output: "SPECS" }], { repairInvalid: true, repairTimeoutMs: 30_000 });
  await new GenerateTestsUseCase(ports).author(baseInput({ diff: BROAD_DIFF }));
  assert.equal(seen.prompts[1]?.timeoutMs, 30_000);
});

test("a repair that ran past its own cap leaves the first answer standing: specs delivered stay delivered", async () => {
  const { ports } = build([{ output: "SPECS but malformed" }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).author(baseInput());
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/a.spec.ts"]);
});

test("a repair that ran past its own cap with a declared no-op keeps the no-op", async () => {
  const { ports } = build([{ output: "NOOP malformed" }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).author(baseInput());
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.equal(result.note, NOOP_REASON);
  assert.deepEqual(result.specs, []);
});

test("a repair that ran past its own cap with no readable verdict ends the generation as no-verdict, loudly", async () => {
  const { ports } = build([{ output: "no verdict at all" }, { throws: new AgentTimeoutError("timed out") }], { repairInvalid: true });
  const result = await new GenerateTestsUseCase(ports).author(baseInput());
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
  assert.match(result.note ?? "", /contract-repair turn \(tools disabled\) did not answer within 120 s/);
});

test("a repair that fails for any reason other than time is still the integration error it is", async () => {
  const { ports } = build([{ output: "no verdict at all" }, { throws: new AgentUnavailableError("provider rejected: out of credits") }], { repairInvalid: true });
  await assert.rejects(new GenerateTestsUseCase(ports).author(baseInput()), AgentUnavailableError);
});
