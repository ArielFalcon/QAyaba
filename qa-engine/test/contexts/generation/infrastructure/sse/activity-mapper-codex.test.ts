/* Codex JSONL event mapper. These tests use SYNTHETIC JSONL fixtures shaped after the defensive
   4-field probe in extractCodexLastMessage (event.msg ?? event.message ?? event.text ?? event.content).
   When a captured real fixture is committed, extend these tests to cover the real event types and field names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapCodexExecEvent } from "@contexts/generation/infrastructure/sse/activity-mapper.ts";

describe("mapCodexExecEvent (T-P1-4 / AC1.4.1-2)", () => {
  it("tool_use event maps to agent.activity (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "tool_use", name: "read", input: { filePath: "/src/foo.ts" } });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.type, "agent.activity");
    if (ev.type === "agent.activity") {
      assert.equal(ev.kind, "analyzing");
      assert.equal(ev.target, "foo.ts");
      assert.equal(ev.status, "running");
    }
  });

  it("write tool maps to writing kind (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "tool_use", name: "write", input: { filePath: "/src/bar.spec.ts" } });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 1);
    const ev = events[0]!;
    if (ev.type === "agent.activity") {
      assert.equal(ev.kind, "writing");
    }
  });

  it("bash/shell tool maps to command kind (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "tool_use", name: "bash", input: { command: "npm test" } });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 1);
    const ev = events[0]!;
    if (ev.type === "agent.activity") {
      assert.equal(ev.kind, "command");
    }
  });

  it("error event maps to agent.error (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "error", message: "out of context window" });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "agent.error");
  });

  it("error event uses error field fallback (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "error", error: "rate limited" });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "agent.error");
    if (events[0]?.type === "agent.error") {
      assert.ok(events[0].detail.includes("rate limited"));
    }
  });

  it("message/assistant event is skipped — prose only (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "message", message: "I have written the tests." });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 0, "prose message events must be dropped");
  });

  it("malformed / non-JSON line is skipped without throwing (AC1.4.2)", () => {
    const lines = [
      "not json at all",
      "{broken json",
      "",
      "   ",
    ];
    for (const line of lines) {
      assert.doesNotThrow(
        () => mapCodexExecEvent(line),
        `mapCodexExecEvent must not throw on: ${JSON.stringify(line)}`,
      );
      const events = mapCodexExecEvent(line);
      assert.equal(events.length, 0, `malformed line must return []: ${JSON.stringify(line)}`);
    }
  });

  it("interleaved stderr-like non-JSON lines do not discard valid tool event (AC1.4.2)", () => {
    const toolLine = JSON.stringify({ type: "tool_use", name: "read", input: {} });
    assert.equal(mapCodexExecEvent("stderr: warn: something").length, 0);
    const events = mapCodexExecEvent(toolLine);
    assert.equal(events.length, 1);
  });

  it("unknown event type is silently skipped (forward-compatible) (AC1.4.2)", () => {
    const line = JSON.stringify({ type: "thinking", text: "deliberating..." });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 0);
  });

  it("defensive field probe: msg field is recognized (AC1.4.1)", () => {
    const line = JSON.stringify({ type: "error", msg: "something went wrong" });
    const events = mapCodexExecEvent(line);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "agent.error");
    if (events[0]?.type === "agent.error") {
      assert.ok(events[0].detail.includes("something went wrong"));
    }
  });
});
