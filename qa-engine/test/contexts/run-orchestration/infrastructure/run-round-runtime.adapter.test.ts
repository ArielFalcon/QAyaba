import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRoundRuntime } from "@contexts/run-orchestration/infrastructure/run-round-runtime.adapter.ts";
import type { AgentPromptOpts, AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

/* The transport, as a fake: what each prompt receives is what the telemetry would report. */
interface Harness {
  seen: Array<{ role: AgentRole; opts?: AgentPromptOpts }>;
  runtime: RunRoundRuntime;
}

function harness(): Harness {
  const seen: Harness["seen"] = [];
  const inner: AgentRuntimePort = {
    openSession: async (role) => {
      const session: AgentSession = {
        prompt: async (_text, opts) => {
          seen.push({ role, ...(opts ? { opts } : {}) });
          return { output: "" };
        },
        dispose: async () => {},
      };
      return session;
    },
  };
  return { seen, runtime: new RunRoundRuntime(inner) };
}

test("two generation turns in one run are numbered 0 then 1 across the sessions the run opens", async () => {
  const h = harness();
  const first = await h.runtime.openSession("primary", "/w");
  await first.prompt("first pass");
  const regeneration = await h.runtime.openSession("primary", "/w");
  await regeneration.prompt("first regeneration");

  assert.deepEqual(h.seen.map((p) => p.opts?.round), [0, 1]);
});

test("a repair turn inside its session is left alone: its round stays what the transport counts locally", async () => {
  const h = harness();
  const session = await h.runtime.openSession("primary", "/w");
  await session.prompt("first pass");
  await session.prompt("restate the verdict", { isRepair: true, withoutTools: true });
  await h.runtime.openSession("primary", "/w").then((s) => s.prompt("next regeneration"));

  assert.deepEqual(h.seen.map((p) => p.opts?.round), [0, undefined, 1], "the repair turn neither took a round nor advanced the counter");
});

test("each role's turns are numbered on their own", async () => {
  const h = harness();
  const generator = await h.runtime.openSession("primary", "/w");
  await generator.prompt("first pass");
  const reviewer = await h.runtime.openSession("reviewer", "/w");
  await reviewer.prompt("review");
  const generatorAgain = await h.runtime.openSession("primary", "/w");
  await generatorAgain.prompt("first regeneration");

  assert.deepEqual(
    h.seen.map((p) => [p.role, p.opts?.round]),
    [["primary", 0], ["reviewer", 0], ["primary", 1]],
  );
});

test("every other option of the prompt reaches the transport untouched, with the round added", async () => {
  const h = harness();
  const session = await h.runtime.openSession("primary", "/w");
  await session.prompt("hi", { stepLimit: 7, finalStepOnly: true, sectionSizes: { a: 1 } });

  assert.deepEqual(h.seen[0]!.opts, { stepLimit: 7, finalStepOnly: true, sectionSizes: { a: 1 }, round: 0 });
});
