import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type AuthoringPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import { didNotSubmit, type FakeReply } from "../../../support/submission.ts";
import { SUBMIT_TOOL } from "@kernel/submission.ts";
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
  prompts: Array<{ role: AgentRole; isRepair: boolean; submitOnly: boolean; timeoutMs: number | undefined; timeLimit: TimeLimitSource | undefined }>;
  disposed: AgentRole[];
}

function baseInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: TINY_DIFF, mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
    mode: "diff", appName: "a",
    ...over,
  };
}

/* What the fake author does with a turn: "SPECS" and "NOOP" are calls to its submit tool, any other text is a turn that made none. */
function replyFor(output: string, specs: string[]): FakeReply {
  if (output.includes("SPECS")) return { output, submission: { accepted: true, value: { specs }, calls: 1 } };
  if (output.includes("NOOP")) return { output, submission: { accepted: true, value: { specs: [], noop: { reason: NOOP_REASON } }, calls: 1 } };
  return didNotSubmit(output);
}

function build(generatorSteps: Step[], opts: { specs?: string[] } = {}): { ports: AuthoringPorts; seen: Harness } {
  const seen: Harness = { opened: [], prompts: [], disposed: [] };
  const steps = [...generatorSteps];
  const specs = opts.specs ?? ["flows/a.spec.ts"];
  const ports: AuthoringPorts = {
    runtime: {
      openSession: async (role, _cwd, sessionOpts) => {
        seen.opened.push({ role, opts: sessionOpts });
        return {
          prompt: async (_text, promptOpts) => {
            seen.prompts.push({ role, isRepair: promptOpts?.isRepair === true, submitOnly: promptOpts?.submitOnly === true, timeoutMs: promptOpts?.timeoutMs, timeLimit: promptOpts?.timeLimit });
            if (role === "reviewer") return { output: "REVIEW" };
            const step = steps.shift() ?? { output: "" };
            if ("throws" in step) throw step.throws;
            return replyFor(step.output, specs);
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
      readGenerator: ({ answer, noSubmission }) =>
        answer === undefined
          ? { specs: [], parsed: false, note: noSubmission }
          : Array.isArray(answer.specs) && answer.specs.length > 0
            ? { specs: answer.specs as string[], parsed: true }
            : { specs: [], parsed: true, noopReason: NOOP_REASON },
      readReview: () => ({ approved: true, findings: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
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

test("a turn that ends without a submission is continued once, restricted to the submit tool and within the bounds the first prompt had", async () => {
  const { ports, seen } = build([{ output: "wrote the specs, did not submit" }, { output: "SPECS" }]);
  const result = await new GenerateTestsUseCase(ports).author(baseInput({ diff: BROAD_DIFF }));
  assert.equal(seen.prompts.length, 2);
  assert.equal(seen.prompts[0]?.submitOnly, false);
  assert.equal(seen.prompts[1]?.submitOnly, true);
  assert.equal(seen.prompts[1]?.isRepair, true);
  assert.equal(seen.prompts[1]?.timeoutMs, seen.prompts[0]?.timeoutMs);
  assert.equal(result.end, GENERATION_END.DELIVERED);
  assert.deepEqual(result.specs, ["flows/a.spec.ts"]);
});

test("a turn is asked for its submission through the submit tool of the specs contract", async () => {
  const asked: Array<string | undefined> = [];
  const { ports } = build([{ output: "SPECS" }]);
  const open = ports.runtime.openSession.bind(ports.runtime);
  ports.runtime.openSession = async (...args) => {
    const session = await open(...args);
    return { ...session, prompt: async (text, opts) => { asked.push(opts?.submit?.tool); return session.prompt(text, opts); } };
  };
  await new GenerateTestsUseCase(ports).author(baseInput());
  assert.deepEqual(asked, [SUBMIT_TOOL.SPECS]);
});

test("a continuation that ran past its time leaves a no-verdict end that says so", async () => {
  const { ports } = build([{ output: "no submission at all" }, { throws: new AgentTimeoutError("timed out") }]);
  const result = await new GenerateTestsUseCase(ports).author(baseInput());
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
  assert.equal(result.parsed, false);
  assert.match(result.note ?? "", /continuation ran out of its time/);
});

test("a turn that ends without a submission even after its continuation ends as no-verdict, with the reason", async () => {
  const { ports, seen } = build([{ output: "no submission at all" }, { output: "still none" }]);
  const result = await new GenerateTestsUseCase(ports).author(baseInput());
  assert.equal(seen.prompts.length, 2, "one continuation only");
  assert.equal(result.end, GENERATION_END.NO_VERDICT);
  assert.match(result.note ?? "", /no accepted submission/);
});

test("a continuation that fails for any reason other than time is still the integration error it is", async () => {
  const { ports } = build([{ output: "no submission at all" }, { throws: new AgentUnavailableError("provider rejected: out of credits") }]);
  await assert.rejects(new GenerateTestsUseCase(ports).author(baseInput()), AgentUnavailableError);
});
