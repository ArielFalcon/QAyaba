import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CallEfficiencyTracker } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import type { RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper.ts";

const CWD = "/mirrors/org__app";

function toolEvent(
  sessionID: string,
  callID: string,
  tool: string,
  status: "pending" | "running" | "completed" | "error",
  input: Record<string, unknown> = {},
  output?: string,
): RawOpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `prt_${sessionID}_${callID}`,
        sessionID,
        messageID: "msg_1",
        type: "tool",
        callID,
        tool,
        state: { status, input, ...(output !== undefined ? { output } : {}) },
      },
    },
  };
}

function stepStart(sessionID: string, id: string): RawOpencodeEvent {
  return { type: "message.part.updated", properties: { part: { id, sessionID, messageID: "msg_1", type: "step-start" } } };
}

function tracked(sessionId = "s1"): CallEfficiencyTracker {
  const tracker = new CallEfficiencyTracker();
  tracker.attach(sessionId, CWD);
  return tracker;
}

/** Records a call's whole lifecycle the way the SSE stream emits it: pending, running, completed. */
function runCall(
  tracker: CallEfficiencyTracker,
  sessionID: string,
  callID: string,
  tool: string,
  input: Record<string, unknown> = {},
  output = "ok",
): void {
  tracker.record(toolEvent(sessionID, callID, tool, "pending", input));
  tracker.record(toolEvent(sessionID, callID, tool, "running", input));
  tracker.record(toolEvent(sessionID, callID, tool, "completed", input, output));
}

test("a real OpenCode 1.17.7 text-only turn yields one step and no calls", () => {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/opencode-1.17.7-step-parts.json", import.meta.url)), "utf8"),
  ) as RawOpencodeEvent[];
  const sessionID = (fixture.find((e) => e.properties?.sessionID)?.properties?.sessionID ?? "") as string;
  assert.notEqual(sessionID, "");
  const tracker = tracked(sessionID);
  for (const event of fixture) tracker.record(event);

  const metrics = tracker.take(sessionID, "Reply with the single word: ack.");
  assert.equal(metrics?.stepsUsed, 1);
  assert.equal(metrics?.totalCalls, 0);
});

test("stepsUsed counts distinct step-start parts and stays null when none are seen", () => {
  const withSteps = tracked();
  withSteps.record(stepStart("s1", "step-a"));
  withSteps.record(stepStart("s1", "step-a"));
  withSteps.record(stepStart("s1", "step-b"));
  assert.equal(withSteps.take("s1", "")?.stepsUsed, 2);

  const withoutSteps = tracked();
  runCall(withoutSteps, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(withoutSteps.take("s1", "")?.stepsUsed, null);
});

test("a session that was never attached is ignored", () => {
  const tracker = new CallEfficiencyTracker();
  runCall(tracker, "stranger", "c1", "read", { filePath: "/a.ts" });
  assert.equal(tracker.take("stranger", ""), null);
});

test("a turn that saw no event yields null metrics", () => {
  const tracker = tracked();
  assert.equal(tracker.take("s1", ""), null);
});

test("the same callId re-emitted across pending, running and completed counts as one call", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(tracker.take("s1", "")?.totalCalls, 1);
});

test("the same callId in two different sessions is two calls, one per session", () => {
  const tracker = new CallEfficiencyTracker();
  tracker.attach("s1", CWD);
  tracker.attach("s2", CWD);
  runCall(tracker, "s1", "call-1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s2", "call-1", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(tracker.take("s1", "")?.totalCalls, 1);
  assert.equal(tracker.take("s2", "")?.totalCalls, 1);
});

test("a call that errors after running is still counted once", () => {
  const tracker = tracked();
  tracker.record(toolEvent("s1", "c1", "browser_navigate", "running", { url: "http://x" }));
  tracker.record(toolEvent("s1", "c1", "browser_navigate", "error", { url: "http://x" }));
  assert.equal(tracker.take("s1", "")?.totalCalls, 1);
});

test("an exact duplicate (same tool, same input, any key order) is flagged; a different input is not", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "grep", { pattern: "foo", path: "/mirrors/org__app/src" });
  runCall(tracker, "s1", "c2", "grep", { path: "/mirrors/org__app/src", pattern: "foo" });
  runCall(tracker, "s1", "c3", "grep", { pattern: "bar", path: "/mirrors/org__app/src" });
  assert.equal(tracker.take("s1", "")?.duplicateCallCount, 1);
});

test("re-reading a path with no write in between is a redundant read", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 1);
});

test("a relative path and its cwd-resolved absolute form are the same path", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "a.ts" });
  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 1);
});

test("a write to the path clears redundancy for a later read", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s1", "c2", "write", { filePath: "/mirrors/org__app/a.ts", content: "x" });
  runCall(tracker, "s1", "c3", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 0);
});

test("a write with no path invalidates every read path", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s1", "c2", "apply_patch", { patchText: "*** Begin Patch" });
  runCall(tracker, "s1", "c3", "read", { filePath: "/mirrors/org__app/a.ts" });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 0);
});

test("calls before the first write, write count and buckets describe the turn", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s1", "c2", "playwright_browser_navigate", { url: "http://x" });
  runCall(tracker, "s1", "c3", "write", { filePath: "/mirrors/org__app/e2e/a.spec.ts", content: "x" });
  runCall(tracker, "s1", "c4", "bash", { command: "npx playwright test" });
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.totalCalls, 4);
  assert.equal(metrics?.callsBeforeFirstWrite, 2);
  assert.equal(metrics?.writeCount, 1);
  assert.equal(metrics?.buckets.code_read, 1);
  assert.equal(metrics?.buckets.browser, 1);
  assert.equal(metrics?.buckets.write, 1);
  assert.equal(metrics?.buckets.validate_run, 1);
});

test("each take reports only the delta since the session's previous flush", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "s1", "c2", "write", { filePath: "/mirrors/org__app/e2e/a.spec.ts", content: "x" });
  const first = tracker.take("s1", "");
  assert.equal(first?.totalCalls, 2);

  runCall(tracker, "s1", "c3", "bash", { command: "ls" });
  const second = tracker.take("s1", "");
  assert.equal(second?.totalCalls, 1);
  assert.equal(second?.writeCount, 0);
  assert.equal(second?.callsBeforeFirstWrite, 1);
  assert.equal(tracker.take("s1", ""), null);
});

test("duplicates and redundant reads stay session-scoped across turns", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  tracker.take("s1", "");

  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/a.ts" });
  const second = tracker.take("s1", "");
  assert.equal(second?.duplicateCallCount, 1);
  assert.equal(second?.redundantReadCount, 1);
});

test("a read whose output the turn's prompt already contained counts as prompt-provided", () => {
  const source = [
    "export function calculateInvoiceTotal(items) {",
    "  const subtotal = items.reduce((sum, item) => sum + item.price, 0);",
    "  const tax = subtotal * TAX_RATE_FOR_REGION;",
    "  return subtotal + tax + SHIPPING_FLAT_FEE;",
    "}",
  ];
  const output = source.map((line, i) => `${String(i + 1).padStart(5)}\t${line}`).join("\n");
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/invoice.ts" }, output);
  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/other.ts" }, "1\tsomething entirely different here\n2\tanother distinct line of code\n3\tyet another distinct line of code");

  const metrics = tracker.take("s1", `Here is the file:\n${source.join("\n")}\n`);
  assert.equal(metrics?.promptProvidedReadCount, 1);
});

test("a fault while recording poisons only that session: its metrics are null, the others are intact", (t) => {
  t.mock.method(console, "error", () => {});
  const tracker = new CallEfficiencyTracker();
  tracker.attach("bad", CWD);
  tracker.attach("good", CWD);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  runCall(tracker, "bad", "c1", "read", circular);
  runCall(tracker, "good", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  runCall(tracker, "bad", "c2", "read", { filePath: "/mirrors/org__app/b.ts" });

  assert.equal(tracker.take("bad", ""), null);
  assert.equal(tracker.take("good", "")?.totalCalls, 1);
});

test("clear forgets a session so its later events are ignored", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  tracker.clear("s1");
  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/b.ts" });
  assert.equal(tracker.take("s1", ""), null);
});
