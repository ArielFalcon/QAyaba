import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CallEfficiencyTracker,
  OBSERVATION_READY_TIMEOUT_MS,
  type StreamToken,
  type TrackerTimer,
} from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
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

/** Opens and connects a stream for the directory, the way the event loop does, and returns its token. */
function liveStream(tracker: CallEfficiencyTracker, directory = CWD): StreamToken {
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(directory, token);
  tracker.streamConnected(directory, token);
  return token;
}

/** A tracker whose directory stream is live when the session attaches, so its steps are observed completely. */
function tracked(sessionId = "s1"): CallEfficiencyTracker {
  const tracker = new CallEfficiencyTracker();
  liveStream(tracker);
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

test("an event that is not a part update is ignored, whatever part it carries", () => {
  const tracker = tracked();
  tracker.record({ ...toolEvent("s1", "c1", "read", "completed", { filePath: "/mirrors/org__app/a.ts" }), type: "session.status" });
  assert.equal(tracker.take("s1", ""), null);
});

test("a part that is not a tool part is not a call, whatever else it carries", () => {
  const tracker = tracked();
  const asText = toolEvent("s1", "c1", "read", "completed", { filePath: "/mirrors/org__app/a.ts" });
  (asText.properties!.part as Record<string, unknown>).type = "text";
  tracker.record(asText);
  assert.equal(tracker.take("s1", ""), null);
});

test("a call seen only pending is not counted", () => {
  const tracker = tracked();
  tracker.record(toolEvent("s1", "c1", "read", "pending", { filePath: "/mirrors/org__app/a.ts" }));
  assert.equal(tracker.take("s1", "")?.totalCalls, 0);
});

test("a call whose first sighting is an error never entered the sequence", () => {
  const tracker = tracked();
  tracker.record(toolEvent("s1", "c1", "read", "error", { filePath: "/mirrors/org__app/a.ts" }));
  assert.equal(tracker.take("s1", "")?.totalCalls, 0);
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

test("a call is identified by the input of its latest sighting", () => {
  const tracker = tracked();
  const path = "/mirrors/org__app/a.ts";
  tracker.record(toolEvent("s1", "c1", "read", "running", {}));
  tracker.record(toolEvent("s1", "c1", "read", "completed", { filePath: path }, "ok"));
  runCall(tracker, "s1", "c2", "read", { filePath: path });
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.duplicateCallCount, 1, "c2 is the same call as c1's completed input");
  assert.equal(metrics?.redundantReadCount, 1, "c2 re-reads the file c1 read");
});

test("the input a call ends with when it errors identifies it", () => {
  const tracker = tracked();
  const path = "/mirrors/org__app/a.ts";
  tracker.record(toolEvent("s1", "c1", "read", "running", {}));
  tracker.record(toolEvent("s1", "c1", "read", "error", { filePath: path }));
  runCall(tracker, "s1", "c2", "read", { filePath: path });
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

test("serena's relative_path identifies the file, so re-reading it with no write in between is redundant", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "serena_read_file", { relative_path: "src/a.ts" });
  runCall(tracker, "s1", "c2", "serena_read_file", { relative_path: "src/a.ts", start_line: 0 });
  runCall(tracker, "s1", "c3", "serena_read_file", { relative_path: "src/b.ts" });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 1);
});

test("reading different windows of the same file is not redundant, but re-reading the same window is", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts", offset: 0, limit: 100 });
  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/a.ts", offset: 100, limit: 100 });
  runCall(tracker, "s1", "c3", "read", { filePath: "/mirrors/org__app/a.ts", offset: 200, limit: 100 });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 0, "three pages of one file are three reads of new content");
  runCall(tracker, "s1", "c4", "read", { filePath: "/mirrors/org__app/a.ts", offset: 100, limit: 100 });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 1, "the second page again is redundant");
});

test("serena's line window is part of what a read asked for", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "serena_read_file", { relative_path: "src/a.ts", start_line: 0, end_line: 49 });
  runCall(tracker, "s1", "c2", "serena_read_file", { relative_path: "src/a.ts", start_line: 50, end_line: 99 });
  runCall(tracker, "s1", "c3", "serena_read_file", { relative_path: "src/a.ts", start_line: 50, end_line: 99 });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 1, "only the repeat of the same window");
});

test("a write to the file clears every window read of it", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts", offset: 0, limit: 100 });
  runCall(tracker, "s1", "c2", "write", { filePath: "/mirrors/org__app/a.ts", content: "x" });
  runCall(tracker, "s1", "c3", "read", { filePath: "/mirrors/org__app/a.ts", offset: 0, limit: 100 });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 0);
});

test("a serena edit of the file clears redundancy for a later read of that file only", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "serena_read_file", { relative_path: "src/a.ts" });
  runCall(tracker, "s1", "c2", "serena_read_file", { relative_path: "src/b.ts" });
  runCall(tracker, "s1", "c3", "serena_replace_symbol_body", { relative_path: "src/a.ts", name_path: "run", body: "x" });
  runCall(tracker, "s1", "c4", "serena_read_file", { relative_path: "src/a.ts" });
  runCall(tracker, "s1", "c5", "serena_read_file", { relative_path: "src/b.ts" });
  assert.equal(tracker.take("s1", "")?.redundantReadCount, 1, "only the untouched file's re-read is redundant");
});

test("serena edits count as writes: the calls before the first write stop at the first one", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "serena_find_symbol", { name_path_pattern: "run" });
  runCall(tracker, "s1", "c2", "serena_read_file", { relative_path: "src/a.ts" });
  runCall(tracker, "s1", "c3", "serena_create_text_file", { relative_path: "e2e/a.spec.ts", content: "x" });
  runCall(tracker, "s1", "c4", "serena_insert_after_symbol", { relative_path: "e2e/a.spec.ts", name_path: "t", body: "y" });
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.callsBeforeFirstWrite, 2);
  assert.equal(metrics?.writeCount, 2);
  assert.equal(metrics?.buckets.write, 2);
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

/* A prompt can render a file compactly (a facts list, a summary): the lines of the file are then not in the prompt, but a read of that file re-fetches what the prompt already carries. The prompt lists such files by path. */
const COMPACT_OUTPUT = "1\texport const test = base.extend({ authenticate: async ({ page }, use) => { await use(async () => {}); } });\n2\texport { expect } from '@playwright/test';\n3\texport function ns(prefix: string) { return prefix + Date.now(); }";

test("a read of a file the prompt lists by path counts as path-provided even though the prompt renders it compactly", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: `${CWD}/e2e/fixtures.ts` }, COMPACT_OUTPUT);

  const metrics = tracker.take("s1", "fixtures: e2e/fixtures.ts exports test, expect, ns", ["e2e/fixtures.ts"]);
  assert.equal(metrics?.pathProvidedReadCount, 1);
  assert.equal(metrics?.promptProvidedReadCount, 0, "the compact render does not contain the file's lines, so content detection cannot see it");
});

test("path-provided and content-provided reads are counted separately, each by its own measure", () => {
  const source = [
    "export function calculateInvoiceTotal(items) {",
    "  const subtotal = items.reduce((sum, item) => sum + item.price, 0);",
    "  const tax = subtotal * TAX_RATE_FOR_REGION;",
    "  return subtotal + tax + SHIPPING_FLAT_FEE;",
    "}",
  ];
  const contentRead = source.map((line, i) => `${String(i + 1).padStart(5)}\t${line}`).join("\n");
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: `${CWD}/invoice.ts` }, contentRead);
  runCall(tracker, "s1", "c2", "read", { filePath: `${CWD}/e2e/.qa/context.json` }, COMPACT_OUTPUT);

  const metrics = tracker.take("s1", `Here is the file:\n${source.join("\n")}\n`, ["e2e/.qa/context.json"]);
  assert.equal(metrics?.promptProvidedReadCount, 1, "the read whose lines the prompt contained");
  assert.equal(metrics?.pathProvidedReadCount, 1, "the read of the listed path");
});

test("a listed path resolves against the session's directory, whether it is written relative or absolute", () => {
  for (const listed of ["e2e/fixtures.ts", `${CWD}/e2e/fixtures.ts`, "./e2e/fixtures.ts"]) {
    const tracker = tracked();
    runCall(tracker, "s1", "c1", "read", { filePath: "e2e/fixtures.ts" }, COMPACT_OUTPUT);
    assert.equal(tracker.take("s1", "", [listed])?.pathProvidedReadCount, 1, listed);
  }
});

test("only a content read of a listed path counts: another path, another tool and an unlisted turn do not", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: `${CWD}/e2e/other.ts` }, COMPACT_OUTPUT);
  runCall(tracker, "s1", "c2", "edit", { filePath: `${CWD}/e2e/fixtures.ts` }, "edited");
  runCall(tracker, "s1", "c3", "read", { filePath: `${CWD}/e2e/fixtures.ts` }, COMPACT_OUTPUT);

  assert.equal(tracker.take("s1", "", ["e2e/fixtures.ts"])?.pathProvidedReadCount, 1, "only the read of the listed file");

  const none = tracked();
  runCall(none, "s1", "c1", "read", { filePath: `${CWD}/e2e/fixtures.ts` }, COMPACT_OUTPUT);
  assert.equal(none.take("s1", "")?.pathProvidedReadCount, 0, "no paths listed: nothing is path-provided");
  const empty = tracked();
  runCall(empty, "s1", "c1", "read", { filePath: `${CWD}/e2e/fixtures.ts` }, COMPACT_OUTPUT);
  assert.equal(empty.take("s1", "", [])?.pathProvidedReadCount, 0);
});

test("path-provided reads are reported per turn: a later take does not count an earlier turn's read again", () => {
  const tracker = tracked();
  runCall(tracker, "s1", "c1", "read", { filePath: `${CWD}/e2e/fixtures.ts` }, COMPACT_OUTPUT);
  assert.equal(tracker.take("s1", "", ["e2e/fixtures.ts"])?.pathProvidedReadCount, 1);
  runCall(tracker, "s1", "c2", "read", { filePath: `${CWD}/e2e/fixtures.ts` }, COMPACT_OUTPUT);
  assert.equal(tracker.take("s1", "", ["e2e/fixtures.ts"])?.pathProvidedReadCount, 1, "one read this turn, not two");
});

test("each take reports only the steps opened since the session's previous flush", () => {
  const tracker = tracked();
  tracker.record(stepStart("s1", "step-a"));
  tracker.record(stepStart("s1", "step-b"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, 2);

  for (const id of ["step-c", "step-d", "step-e"]) tracker.record(stepStart("s1", id));
  assert.equal(tracker.take("s1", "")?.stepsUsed, 3);
});

test("each take reports only the duplicates that turn added", () => {
  const tracker = tracked();
  const path = "/mirrors/org__app/a.ts";
  runCall(tracker, "s1", "c1", "read", { filePath: path });
  runCall(tracker, "s1", "c2", "read", { filePath: path });
  assert.equal(tracker.take("s1", "")?.duplicateCallCount, 1);

  runCall(tracker, "s1", "c3", "read", { filePath: path });
  assert.equal(tracker.take("s1", "")?.duplicateCallCount, 1, "the third identical call is one more duplicate, not the total so far");
});

test("only a read's output is sampled, and only once the read completed", () => {
  const source = [
    "export function calculateInvoiceTotal(items) {",
    "  const subtotal = items.reduce((sum, item) => sum + item.price, 0);",
    "  const tax = subtotal * TAX_RATE_FOR_REGION;",
    "  return subtotal + tax + SHIPPING_FLAT_FEE;",
    "}",
  ];
  const output = source.join("\n");
  const prompt = `Here is the file:\n${source.join("\n")}\n`;

  const grep = tracked();
  runCall(grep, "s1", "c1", "grep", { pattern: "subtotal", path: "/mirrors/org__app/invoice.ts" }, output);
  assert.equal(grep.take("s1", prompt)?.promptProvidedReadCount, 0, "a search that returned prompt lines is not a read of them");

  const unfinished = tracked();
  unfinished.record(toolEvent("s1", "c1", "read", "running", { filePath: "/mirrors/org__app/invoice.ts" }, output));
  assert.equal(unfinished.take("s1", prompt)?.promptProvidedReadCount, 0, "a read that never completed has no final output to compare");
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

test("a fault while recording is logged with the session and the cause", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const tracker = tracked("session-under-test");
  const input = {
    get filePath(): string {
      throw new Error("the input could not be read");
    },
  };
  runCall(tracker, "session-under-test", "c1", "read", input);

  const message = String(logged.mock.calls[0]?.arguments[0]);
  assert.match(message, /session-under-test/);
  assert.match(message, /the input could not be read/);
});

/* A timer the test drives by hand, so the readiness bound is tested without waiting. */
class ManualTimer implements TrackerTimer {
  private elapsed = 0;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.elapsed + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    this.elapsed += ms;
    for (const [handle, timer] of [...this.pending]) {
      if (timer.at <= this.elapsed) {
        this.pending.delete(handle);
        timer.callback();
      }
    }
  }

  get scheduled(): number {
    return this.pending.size;
  }
}

/* Resolves to whether the promise has settled by the time the microtask queue drains. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return done;
}

const stepIds = (...ids: string[]) => ids;

function recordSteps(tracker: CallEfficiencyTracker, sessionId: string, ids: string[]): void {
  for (const id of ids) tracker.record(stepStart(sessionId, id));
}

test("a session attached to a live stream has its steps observed completely", () => {
  const tracker = tracked();
  recordSteps(tracker, "s1", stepIds("a", "b"));
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.stepsUsed, 2);
  assert.equal(metrics?.observationComplete, true);
});

test("a session attached before its stream is live reports no step count and an incomplete observation, but keeps its calls", () => {
  const tracker = new CallEfficiencyTracker();
  tracker.attach("s1", CWD);
  recordSteps(tracker, "s1", stepIds("a", "b"));
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.stepsUsed, null);
  assert.equal(metrics?.observationComplete, false);
  assert.equal(metrics?.totalCalls, 1);
});

test("a stream that is still opening does not count as live for an attaching session", () => {
  const tracker = new CallEfficiencyTracker();
  tracker.streamOpening(CWD, Symbol("stream"));
  tracker.attach("s1", CWD);
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
});

test("an interrupted stream makes the turn in flight incomplete, and the next attempt is observed again once the stream reconnects", async () => {
  const tracker = new CallEfficiencyTracker();
  const token = liveStream(tracker);
  tracker.attach("s1", CWD);
  await tracker.prepareAttempt("s1", 0);
  recordSteps(tracker, "s1", stepIds("a", "b"));
  tracker.streamInterrupted(CWD, token);
  tracker.streamConnected(CWD, token);
  recordSteps(tracker, "s1", stepIds("c"));
  const interrupted = tracker.take("s1", "");
  assert.equal(interrupted?.stepsUsed, null, "the steps seen before the drop are unknowable");
  assert.equal(interrupted?.observationComplete, false);

  await tracker.prepareAttempt("s1", 0);
  recordSteps(tracker, "s1", stepIds("d", "e"));
  const next = tracker.take("s1", "");
  assert.equal(next?.stepsUsed, 2, "counts are not disabled after one blip");
  assert.equal(next?.observationComplete, true);
});

test("a stream interrupted while it was waiting to connect delays the attempt until it connects", async () => {
  const timer = new ManualTimer();
  const tracker = new CallEfficiencyTracker({ timer });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.attach("s1", CWD);
  const prepared = tracker.prepareAttempt("s1", 0);
  tracker.streamInterrupted(CWD, token);
  assert.equal(await settled(prepared), false, "an interruption is not readiness");
  tracker.streamConnected(CWD, token);
  await prepared;
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, 1);
});

test("a second connected event on a live stream marks the turn in flight incomplete", () => {
  const tracker = new CallEfficiencyTracker();
  const token = liveStream(tracker);
  tracker.attach("s1", CWD);
  recordSteps(tracker, "s1", stepIds("a"));
  tracker.streamConnected(CWD, token);
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.stepsUsed, null);
  assert.equal(metrics?.observationComplete, false);
});

test("closing the current stream mid-turn makes the turn incomplete", () => {
  const tracker = new CallEfficiencyTracker();
  const token = liveStream(tracker);
  tracker.attach("s1", CWD);
  recordSteps(tracker, "s1", stepIds("a", "b"));
  tracker.streamClosed(CWD, token);
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
});

test("a gap on one directory's stream leaves the sessions of other directories complete", () => {
  const tracker = new CallEfficiencyTracker();
  const token = liveStream(tracker);
  liveStream(tracker, "/mirrors/other");
  tracker.attach("here", CWD);
  tracker.attach("there", "/mirrors/other");
  recordSteps(tracker, "here", stepIds("a"));
  recordSteps(tracker, "there", stepIds("b"));
  tracker.streamInterrupted(CWD, token);
  assert.equal(tracker.take("here", "")?.stepsUsed, null);
  assert.equal(tracker.take("there", "")?.stepsUsed, 1);
});

test("a gap makes every session attached to the directory incomplete", () => {
  const tracker = new CallEfficiencyTracker();
  const token = liveStream(tracker);
  tracker.attach("s1", CWD);
  tracker.attach("s2", CWD);
  recordSteps(tracker, "s1", stepIds("a"));
  recordSteps(tracker, "s2", stepIds("b"));
  tracker.streamInterrupted(CWD, token);
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
  assert.equal(tracker.take("s2", "")?.stepsUsed, null);
});

test("events of a stream that is no longer the directory's current one change nothing", () => {
  const tracker = new CallEfficiencyTracker();
  const stale: StreamToken = Symbol("stale");
  tracker.streamOpening(CWD, stale);
  const current = liveStream(tracker);
  tracker.attach("s1", CWD);
  recordSteps(tracker, "s1", stepIds("a"));

  tracker.streamInterrupted(CWD, stale);
  tracker.streamConnected(CWD, stale);
  tracker.streamClosed(CWD, stale);
  assert.equal(tracker.take("s1", "")?.stepsUsed, 1, "a stale stream's lifecycle leaves the live one untouched");

  tracker.streamClosed(CWD, current);
  recordSteps(tracker, "s1", stepIds("b"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null, "the current stream's close still counts");
});

test("a stream that replaces an unclosed one starts over as opening and makes in-flight turns incomplete", () => {
  const tracker = new CallEfficiencyTracker();
  liveStream(tracker);
  tracker.attach("s1", CWD);
  recordSteps(tracker, "s1", stepIds("a"));
  tracker.streamOpening(CWD, Symbol("replacement"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);

  tracker.attach("s2", CWD);
  recordSteps(tracker, "s2", stepIds("b"));
  assert.equal(tracker.take("s2", "")?.stepsUsed, null, "the replacement has not connected yet");
});

test("a session attached after the stream connected inherits its liveness, and one attached after it closed does not", () => {
  const tracker = new CallEfficiencyTracker();
  const token = liveStream(tracker);
  tracker.attach("early", CWD);
  recordSteps(tracker, "early", stepIds("a"));
  assert.equal(tracker.take("early", "")?.stepsUsed, 1);

  tracker.streamClosed(CWD, token);
  tracker.attach("late", CWD);
  recordSteps(tracker, "late", stepIds("b"));
  assert.equal(tracker.take("late", "")?.stepsUsed, null);
});

test("preparing an attempt for a session that was never attached returns at once and schedules nothing", async () => {
  const timer = new ManualTimer();
  const tracker = new CallEfficiencyTracker({ timer });
  tracker.streamOpening(CWD, Symbol("stream"));
  await tracker.prepareAttempt("stranger", 0);
  assert.equal(timer.scheduled, 0);
});

test("preparing an attempt with no stream for the directory returns at once, leaving the attempt incomplete", async () => {
  const timer = new ManualTimer();
  const tracker = new CallEfficiencyTracker({ timer });
  tracker.attach("s1", CWD);
  await tracker.prepareAttempt("s1", 0);
  assert.equal(timer.scheduled, 0);
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
});

test("preparing an attempt on a live stream makes it complete, and only the first attempt of a prompt is ever complete", async () => {
  const tracker = new CallEfficiencyTracker();
  liveStream(tracker);
  tracker.attach("s1", CWD);

  await tracker.prepareAttempt("s1", 0);
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, 1);

  await tracker.prepareAttempt("s1", 0);
  await tracker.prepareAttempt("s1", 1);
  recordSteps(tracker, "s1", stepIds("b", "c"));
  const fallback = tracker.take("s1", "");
  assert.equal(fallback?.stepsUsed, null, "a fallback attempt re-runs the prompt: the steps of both cannot be told apart");
  assert.equal(fallback?.observationComplete, false);
});

test("an attempt prepared while the stream is opening waits for it to connect and is then complete", async () => {
  const timer = new ManualTimer();
  const tracker = new CallEfficiencyTracker({ timer });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.attach("s1", CWD);

  const prepared = tracker.prepareAttempt("s1", 0);
  assert.equal(await settled(prepared), false);
  tracker.streamConnected(CWD, token);
  await prepared;
  assert.equal(timer.scheduled, 0, "the wait's timer is cleared once the stream connects");
  recordSteps(tracker, "s1", stepIds("a", "b"));
  const metrics = tracker.take("s1", "");
  assert.equal(metrics?.stepsUsed, 2);
  assert.equal(metrics?.observationComplete, true);
});

test("an attempt prepared while the stream is opening stops waiting at the readiness bound and stays incomplete", async () => {
  const timer = new ManualTimer();
  const tracker = new CallEfficiencyTracker({ timer });
  tracker.streamOpening(CWD, Symbol("stream"));
  tracker.attach("s1", CWD);

  const prepared = tracker.prepareAttempt("s1", 0);
  timer.advance(OBSERVATION_READY_TIMEOUT_MS - 1);
  assert.equal(await settled(prepared), false, "still waiting just before the bound");
  timer.advance(1);
  assert.equal(await settled(prepared), true, "released at the bound");
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
});

test("a stream that closes while an attempt waits for it releases the attempt at once, incomplete", async () => {
  const timer = new ManualTimer();
  const tracker = new CallEfficiencyTracker({ timer });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.attach("s1", CWD);

  const prepared = tracker.prepareAttempt("s1", 0);
  tracker.streamClosed(CWD, token);
  await prepared;
  assert.equal(timer.scheduled, 0);
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
});

test("a gap after the stream connected but before the waiting attempt continues leaves the attempt incomplete", async () => {
  const tracker = new CallEfficiencyTracker({ timer: new ManualTimer() });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.attach("s1", CWD);
  const prepared = tracker.prepareAttempt("s1", 0);
  tracker.streamConnected(CWD, token);
  tracker.streamInterrupted(CWD, token);
  await prepared;
  recordSteps(tracker, "s1", stepIds("a"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, null);
});

test("the steps of an abandoned attempt never reach the next prompt's count", async () => {
  const tracker = new CallEfficiencyTracker();
  liveStream(tracker);
  tracker.attach("s1", CWD);

  await tracker.prepareAttempt("s1", 0);
  recordSteps(tracker, "s1", stepIds("a", "b", "c"));
  /* the prompt was abandoned (timeout, abort): no take() */
  await tracker.prepareAttempt("s1", 0);
  recordSteps(tracker, "s1", stepIds("d"));
  assert.equal(tracker.take("s1", "")?.stepsUsed, 1);
});

test("preparing an attempt keeps the calls of an abandoned attempt in the next turn's counts", async () => {
  const tracker = new CallEfficiencyTracker();
  liveStream(tracker);
  tracker.attach("s1", CWD);
  await tracker.prepareAttempt("s1", 0);
  runCall(tracker, "s1", "c1", "read", { filePath: "/mirrors/org__app/a.ts" });
  await tracker.prepareAttempt("s1", 0);
  runCall(tracker, "s1", "c2", "read", { filePath: "/mirrors/org__app/b.ts" });
  assert.equal(tracker.take("s1", "")?.totalCalls, 2);
});
