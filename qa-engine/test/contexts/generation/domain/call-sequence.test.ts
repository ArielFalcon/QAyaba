import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeCallSequence,
  detectRedundantReads,
  type CallRecord,
  type ReadWriteEvent,
} from "@contexts/generation/domain/call-sequence.ts";
import { CALL_BUCKETS } from "@contexts/generation/domain/tool-call-taxonomy.ts";

function call(callId: string, status: CallRecord["status"], bucket: CallRecord["bucket"], repeatKey = callId): CallRecord {
  return { callId, status, bucket, repeatKey };
}

test("a call counts once, at its first running/completed sighting", () => {
  const summary = summarizeCallSequence([
    call("c1", "pending", CALL_BUCKETS.CODE_READ),
    call("c1", "running", CALL_BUCKETS.CODE_READ),
    call("c1", "completed", CALL_BUCKETS.CODE_READ),
    call("c2", "completed", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(summary.totalCalls, 2);
});

test("a call seen only pending or only error never counts", () => {
  const summary = summarizeCallSequence([
    call("c1", "pending", CALL_BUCKETS.CODE_READ),
    call("c2", "error", CALL_BUCKETS.CODE_READ),
    call("c3", "completed", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(summary.totalCalls, 1);
});

test("callsBeforeFirstWrite counts calls strictly before the first write, excluding the write itself", () => {
  const summary = summarizeCallSequence([
    call("c1", "completed", CALL_BUCKETS.CODE_READ),
    call("c2", "completed", CALL_BUCKETS.CODE_READ),
    call("c3", "completed", CALL_BUCKETS.WRITE),
    call("c4", "completed", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(summary.callsBeforeFirstWrite, 2);
  assert.equal(summary.writeCount, 1);
});

test("callsBeforeFirstWrite equals totalCalls when the turn has no write", () => {
  const summary = summarizeCallSequence([
    call("c1", "completed", CALL_BUCKETS.CODE_READ),
    call("c2", "completed", CALL_BUCKETS.BROWSER),
  ]);
  assert.equal(summary.callsBeforeFirstWrite, summary.totalCalls);
  assert.equal(summary.callsBeforeFirstWrite, 2);
});

test("writeCount/commandCount/subagentCount tally by bucket", () => {
  const summary = summarizeCallSequence([
    call("c1", "completed", CALL_BUCKETS.WRITE),
    call("c2", "completed", CALL_BUCKETS.WRITE),
    call("c3", "completed", CALL_BUCKETS.VALIDATE_RUN),
    call("c4", "completed", CALL_BUCKETS.SUBAGENT),
    call("c5", "completed", CALL_BUCKETS.OTHER),
  ]);
  assert.equal(summary.writeCount, 2);
  assert.equal(summary.commandCount, 1);
  assert.equal(summary.subagentCount, 1);
});

test("repeatedCallCount flags the second+ occurrence of the same repeatKey, not the first", () => {
  const summary = summarizeCallSequence([
    call("c1", "completed", CALL_BUCKETS.CODE_READ, "read:/a.ts"),
    call("c2", "completed", CALL_BUCKETS.CODE_READ, "read:/a.ts"),
    call("c3", "completed", CALL_BUCKETS.CODE_READ, "read:/b.ts"),
  ]);
  assert.equal(summary.repeatedCallCount, 1);
});

test("repeatedCallCount works as a (kind,target) proxy when the coarse classifier reuses the same repeatKey shape", () => {
  const summary = summarizeCallSequence([
    call("c1", "completed", CALL_BUCKETS.CODE_READ, "analyzing:foo.ts"),
    call("c2", "completed", CALL_BUCKETS.CODE_READ, "analyzing:foo.ts"),
    call("c3", "completed", CALL_BUCKETS.CODE_READ, "analyzing:foo.ts"),
  ]);
  assert.equal(summary.repeatedCallCount, 2);
});

function rw(callId: string, tool: string, path: string | undefined, bucket: ReadWriteEvent["bucket"], status: ReadWriteEvent["status"] = "completed"): ReadWriteEvent {
  return { callId, status, bucket, tool, path };
}

test("a first read of a path is never redundant", () => {
  const redundant = detectRedundantReads([rw("c1", "read", "/a.ts", CALL_BUCKETS.CODE_READ)]);
  assert.equal(redundant.size, 0);
});

test("re-reading the same path with no write in between flags the second read redundant", () => {
  const redundant = detectRedundantReads([
    rw("c1", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c2", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(redundant.has("c1"), false);
  assert.equal(redundant.has("c2"), true);
});

test("a write clears redundancy for that path (spec scenario)", () => {
  const redundant = detectRedundantReads([
    rw("c1", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c2", "write", "/a.ts", CALL_BUCKETS.WRITE),
    rw("c3", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(redundant.has("c3"), false);
  assert.equal(redundant.size, 0);
});

test("a write with no path invalidates every previously-read path", () => {
  const redundant = detectRedundantReads([
    rw("c1", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c2", "read", "/b.ts", CALL_BUCKETS.CODE_READ),
    rw("c3", "write", undefined, CALL_BUCKETS.WRITE),
    rw("c4", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c5", "read", "/b.ts", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(redundant.size, 0);
});

test("only content-read tools (matching the content-read pattern) participate in redundant-read tracking", () => {
  const redundant = detectRedundantReads([
    rw("c1", "grep", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c2", "grep", "/a.ts", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(redundant.size, 0);
});

test("read_file also counts as a content-read tool", () => {
  const redundant = detectRedundantReads([
    rw("c1", "read_file", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c2", "read_file", "/a.ts", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(redundant.has("c2"), true);
});
