import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeCallSequence,
  detectRedundantReads,
  readWindowOf,
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

test("a call still running when the turn ended counts once", () => {
  const summary = summarizeCallSequence([
    call("c1", "running", CALL_BUCKETS.CODE_READ),
    call("c1", "running", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(summary.totalCalls, 1);
});

test("a call is the one its first counted sighting describes, however its later sightings differ", () => {
  const summary = summarizeCallSequence([
    call("c1", "running", CALL_BUCKETS.CODE_READ, "read:/a.ts"),
    call("c1", "completed", CALL_BUCKETS.CODE_READ, "read:/b.ts"),
    call("c2", "completed", CALL_BUCKETS.CODE_READ, "read:/a.ts"),
  ]);
  assert.equal(summary.repeatedCallCount, 1, "c2 repeats what c1 first was");
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

test("a tool that merely starts with the word read is not a content-read tool", () => {
  for (const tool of ["reader", "read_memory", "readdir"]) {
    const redundant = detectRedundantReads([
      rw("c1", tool, "/a.ts", CALL_BUCKETS.CODE_READ),
      rw("c2", tool, "/a.ts", CALL_BUCKETS.CODE_READ),
    ]);
    assert.equal(redundant.size, 0, tool);
  }
});

test("a read with no recorded window and a read of the whole file are the same read", () => {
  const redundant = detectRedundantReads([
    rw("c1", "read", "/a.ts", CALL_BUCKETS.CODE_READ),
    { ...rw("c2", "read", "/a.ts", CALL_BUCKETS.CODE_READ), window: "" },
  ]);
  assert.deepEqual([...redundant], ["c2"]);
});

test("read_file also counts as a content-read tool", () => {
  const redundant = detectRedundantReads([
    rw("c1", "read_file", "/a.ts", CALL_BUCKETS.CODE_READ),
    rw("c2", "read_file", "/a.ts", CALL_BUCKETS.CODE_READ),
  ]);
  assert.equal(redundant.has("c2"), true);
});

test("a read's window is empty for the whole file and names the requested lines otherwise", () => {
  assert.equal(readWindowOf({ filePath: "/a.ts" }), "");
  assert.equal(readWindowOf({ filePath: "/a.ts", offset: 0 }), "", "an offset of 0 is the top of the file, the default");
  assert.equal(readWindowOf({ relative_path: "a.ts", start_line: 0 }), "");
  assert.notEqual(readWindowOf({ filePath: "/a.ts", offset: 100, limit: 50 }), "");
  assert.notEqual(readWindowOf({ relative_path: "a.ts", start_line: 10, end_line: 20 }), "");
  assert.notEqual(readWindowOf({ filePath: "/a.ts", limit: 50 }), readWindowOf({ filePath: "/a.ts" }), "a limit alone is a window");
  assert.notEqual(readWindowOf({ filePath: "/a.ts", offset: 100 }), readWindowOf({ filePath: "/a.ts", offset: 200 }));
  assert.equal(readWindowOf(null), "");
});

test("a read's window follows numeric strings the way it follows numbers, and a non-object input asks for the whole file", () => {
  assert.notEqual(readWindowOf({ filePath: "/a.ts", offset: "100" }), "");
  assert.equal(readWindowOf({ filePath: "/a.ts", offset: "0" }), "", "a start of \"0\" is the default too");
  assert.equal(readWindowOf({ filePath: "/a.ts", offset: "100" }), readWindowOf({ filePath: "/a.ts", offset: 100 }));
  assert.equal(readWindowOf("offset=5"), "");
  assert.equal(readWindowOf(undefined), "");
  assert.equal(readWindowOf(42), "");
});

test("two different windows never share an identity, even when a value spells out the other's key", () => {
  assert.notEqual(readWindowOf({ offset: "5limit=9" }), readWindowOf({ offset: 5, limit: 9 }));
});

test("reads of one path are redundant only when they asked for the same window", () => {
  const read = (callId: string, window: string): ReadWriteEvent => ({ ...rw(callId, "read", "/a.ts", CALL_BUCKETS.CODE_READ), window });
  const redundant = detectRedundantReads([read("c1", "offset=0,limit=100"), read("c2", "offset=100,limit=100"), read("c3", "offset=100,limit=100"), read("c4", "")]);
  assert.deepEqual([...redundant], ["c3"]);
});
