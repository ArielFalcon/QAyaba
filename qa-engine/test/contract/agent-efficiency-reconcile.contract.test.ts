/* The fine (in-session SSE tracker) and coarse (persisted run_events) classifiers must agree on the
   metrics they share. The explorer's session is not observed in production (it is never registered
   for live observation), so its calls reach neither classifier and the grounding window stays empty.
   Repeated-call counts are deliberately NOT compared: the coarse side only has a (kind, target) proxy
   for them. A command is a call of a shell tool, whatever its command line does: the coarse side counts
   the shell calls it sees, and the fine side counts the same calls however it buckets each by its command
   (reading, validating, running a script), so the generator here makes one shell call of each kind. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallEfficiencyTracker } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { mapOpencodeEvent, type RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper.ts";
import { classifyRunEfficiency } from "@contexts/generation/domain/coarse-run-efficiency.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import type { RunEventBody } from "@kernel/contract/events.ts";

const CWD = "/mirrors/org__app";
const RUN_ID = "run-1";
const GENERATOR = "s-generator";
const EXPLORER = "s-explorer";

function toolLifecycle(sessionID: string, callID: string, tool: string, input: Record<string, unknown>): RawOpencodeEvent[] {
  const part = (status: string, extra: Record<string, unknown> = {}): RawOpencodeEvent => ({
    type: "message.part.updated",
    properties: {
      part: { id: `prt-${callID}`, sessionID, messageID: "m", type: "tool", callID, tool, state: { status, input, ...extra } },
    },
  });
  return [part("pending"), part("running"), part("completed", { output: "ok", title: `${tool} ${callID}` })];
}

const stepStart = (sessionID: string, id: string): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { id, sessionID, messageID: "m", type: "step-start" } },
});

/* The explorer session investigates first (the grounding sub-step), then the generator works. Only the
   generator session is attached and registered, as in production. */
const explorerEvents: RawOpencodeEvent[] = [
  stepStart(EXPLORER, "step-e1"),
  ...toolLifecycle(EXPLORER, "e1", "read", { filePath: `${CWD}/src/a.ts` }),
  ...toolLifecycle(EXPLORER, "e2", "playwright_browser_navigate", { url: "http://dev/" }),
];
const generatorEvents: RawOpencodeEvent[] = [
  stepStart(GENERATOR, "step-g1"),
  ...toolLifecycle(GENERATOR, "g1", "read", { filePath: `${CWD}/src/b.ts` }),
  ...toolLifecycle(GENERATOR, "g2", "playwright_browser_snapshot", {}),
  ...toolLifecycle(GENERATOR, "g3", "bash", { command: "npx tsc --noEmit" }),
  stepStart(GENERATOR, "step-g2"),
  ...toolLifecycle(GENERATOR, "g4", "task", { description: "review" }),
  ...toolLifecycle(GENERATOR, "g5", "write", { filePath: `${CWD}/e2e/a.spec.ts`, content: "x" }),
  ...toolLifecycle(GENERATOR, "g6", "read", { filePath: `${CWD}/src/b.ts` }),
  ...toolLifecycle(GENERATOR, "g7", "bash", { command: "ls src" }),
  ...toolLifecycle(GENERATOR, "g8", "bash", { command: "node /tmp/probe.mjs" }),
];

function coarseRunEvents(): RunEventBody[] {
  const sessions = new Map([[GENERATOR, RUN_ID]]);
  const step = (detail?: string): RunEventBody => ({ type: "step.changed", step: "generate", ...(detail ? { detail } : {}) });
  return [
    step(PRE_GENERATION_GROUNDING_STEP_DETAIL),
    ...explorerEvents.flatMap((e) => mapOpencodeEvent(e, sessions)),
    step(),
    ...generatorEvents.flatMap((e) => mapOpencodeEvent(e, sessions)),
  ];
}

test("fine and coarse classifiers agree on calls, calls before the first write, writes, commands and subagents", () => {
  const tracker = new CallEfficiencyTracker();
  tracker.attach(GENERATOR, CWD);
  for (const event of [...explorerEvents, ...generatorEvents]) tracker.record(event);
  const fine = tracker.take(GENERATOR, "");
  const coarse = classifyRunEfficiency(coarseRunEvents()).firstPass;

  assert.notEqual(fine, null);
  assert.equal(fine!.totalCalls, 8);
  assert.equal(fine!.totalCalls, coarse.totalCalls);
  assert.equal(fine!.callsBeforeFirstWrite, coarse.callsBeforeFirstWrite);
  assert.equal(fine!.writeCount, coarse.writeCount);
  assert.equal(fine!.commandCount, 3);
  assert.equal(fine!.commandCount, coarse.commandCount);
  assert.equal(fine!.buckets.subagent, coarse.subagentCount);
});

test("an unobserved explorer adds nothing to either classifier, so the grounding window stays empty", () => {
  const tracker = new CallEfficiencyTracker();
  tracker.attach(GENERATOR, CWD);
  for (const event of [...explorerEvents, ...generatorEvents]) tracker.record(event);
  const fine = tracker.take(GENERATOR, "");
  const coarse = classifyRunEfficiency(coarseRunEvents());

  assert.equal(coarse.grounding.totalCalls, 0, "the explorer's calls never reach the persisted events");
  assert.equal(coarse.wholeRunExcludingGrounding.totalCalls, fine!.totalCalls);
  assert.equal(coarse.firstPass.totalCalls, fine!.totalCalls);
});
