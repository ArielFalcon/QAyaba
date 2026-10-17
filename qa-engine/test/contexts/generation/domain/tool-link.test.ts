import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK_TOLERANCE_MS, matchServerCalls, type LinkableCall, type ServerToolCall } from "@contexts/generation/domain/tool-link.ts";

const server = (id: string, tool: string, startedAt: number, endedAt: number, messageId?: string): ServerToolCall => ({
  tool,
  startedAt,
  endedAt,
  context: { traceId: "t".repeat(32), spanId: id },
  ...(messageId !== undefined ? { messageId } : {}),
});
const call = (callId: string, tool: string, startedAt: number | null, endedAt: number | null, messageId?: string): LinkableCall => ({
  callId,
  tool,
  startedAt,
  endedAt,
  firstSeenAt: startedAt ?? 0,
  ...(messageId !== undefined ? { messageId } : {}),
});

test("a tool call joins the server span of the same tool, in the same message, that ran inside its time", () => {
  const joined = matchServerCalls([call("c1", "run_spec", 1_000, 9_000, "m1")], [server("s1", "run_spec", 1_050, 8_900, "m1")]);
  assert.equal(joined.get("c1")?.context.spanId, "s1");
});

test("a server span of another message is not joined, however well the times fit", () => {
  const joined = matchServerCalls([call("c1", "run_spec", 1_000, 9_000, "m1")], [server("s1", "run_spec", 1_050, 8_900, "m2")]);
  assert.equal(joined.size, 0);
});

test("a server span of another tool is not joined", () => {
  const joined = matchServerCalls([call("c1", "authbrowser_click", 1_000, 2_000, "m1")], [server("s1", "authbrowser_snapshot", 1_050, 1_900, "m1")]);
  assert.equal(joined.size, 0);
});

test("a server span that ran outside the call's time, past the tolerance, is not joined", () => {
  const joined = matchServerCalls([call("c1", "run_spec", 1_000, 2_000, "m1")], [server("s1", "run_spec", 2_000 + LINK_TOLERANCE_MS + 1, 9_000, "m1")]);
  assert.equal(joined.size, 0);
});

test("without a message id on either side the times alone decide", () => {
  const joined = matchServerCalls([call("c1", "run_spec", 1_000, 5_000)], [server("s1", "run_spec", 1_100, 4_900, "m1")]);
  assert.equal(joined.get("c1")?.context.spanId, "s1");
  const other = matchServerCalls([call("c1", "run_spec", 1_000, 5_000, "m1")], [server("s1", "run_spec", 1_100, 4_900)]);
  assert.equal(other.get("c1")?.context.spanId, "s1");
});

test("two calls in a row each join their own server span, and a server span joins one call only", () => {
  const joined = matchServerCalls(
    [call("c1", "run_spec", 1_000, 2_000, "m1"), call("c2", "run_spec", 2_100, 3_000, "m1")],
    [server("s1", "run_spec", 1_020, 1_990, "m1"), server("s2", "run_spec", 2_120, 2_990, "m1")],
  );
  assert.equal(joined.get("c1")?.context.spanId, "s1");
  assert.equal(joined.get("c2")?.context.spanId, "s2");
});

test("calls that cannot be told apart are not joined at all rather than joined at random", () => {
  const joined = matchServerCalls(
    [call("c1", "authbrowser_snapshot", 1_000, 5_000, "m1"), call("c2", "authbrowser_snapshot", 1_000, 5_000, "m1")],
    [server("s1", "authbrowser_snapshot", 1_100, 4_000, "m1")],
  );
  assert.equal(joined.size, 0);
});

test("a call still running when the turn ended joins a server span that started after it", () => {
  const joined = matchServerCalls([call("c1", "run_spec", 1_000, null, "m1")], [server("s1", "run_spec", 1_200, 90_000, "m1")]);
  assert.equal(joined.get("c1")?.context.spanId, "s1");
});
