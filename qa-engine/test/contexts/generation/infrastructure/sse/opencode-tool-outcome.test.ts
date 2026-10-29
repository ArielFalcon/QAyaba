import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolOutcomeOf, TOOL_ERROR_MAX_CHARS } from "@contexts/generation/infrastructure/sse/opencode-tool-outcome.ts";

const DENIAL = "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []";

test("only the runtime's own permission-rule message makes an errored call denied", () => {
  assert.equal(toolOutcomeOf({ tool: "bash", state: { status: "error", error: DENIAL } }).kind, "denied");
  assert.equal(toolOutcomeOf({ tool: "bash", state: { status: "error", error: "File not found" } }).kind, "failed");
  assert.equal(toolOutcomeOf({ tool: "bash", state: { status: "error" } }).kind, "failed");
  assert.equal(toolOutcomeOf({ tool: "bash", state: { status: "completed", error: DENIAL } }).kind, "completed");
});

test("a failed call's message is bounded; a call that gave none carries none", () => {
  const long = toolOutcomeOf({ tool: "read", state: { status: "error", error: "e".repeat(TOOL_ERROR_MAX_CHARS * 3) } });
  assert.equal(long.kind === "failed" ? long.message?.length : -1, TOOL_ERROR_MAX_CHARS);
  assert.deepEqual(toolOutcomeOf({ tool: "read", state: { status: "error", error: 42 } }), { kind: "failed" });
});

test("the runtime's repair pseudo-tool is invalid whether it completed or errored, naming the tool it attempted", () => {
  const input = { tool: "readfile", error: "filePath is required" };
  assert.deepEqual(toolOutcomeOf({ tool: "invalid", state: { status: "completed", input } }), { kind: "invalid", attempted: "readfile", message: "filePath is required" });
  assert.deepEqual(toolOutcomeOf({ tool: "invalid", state: { status: "error", input, error: "ignored" } }), { kind: "invalid", attempted: "readfile", message: "filePath is required" });
  assert.deepEqual(toolOutcomeOf({ tool: "invalid", state: { status: "completed", input: {} } }), { kind: "invalid" });
  assert.deepEqual(toolOutcomeOf({ tool: "invalid", state: { status: "running", input } }), { kind: "running" });
});

test("a call still running, or one the stream showed with no known status, has no ending", () => {
  assert.deepEqual(toolOutcomeOf({ tool: "read", state: { status: "running" } }), { kind: "running" });
  assert.deepEqual(toolOutcomeOf({ tool: "read", state: { status: "completed" } }), { kind: "completed" });
});

const sse = join(import.meta.dirname, "..", "..", "..", "..", "..", "src", "contexts", "generation", "infrastructure", "sse");

test("no module of the event stream reads a tool state's error outside the outcome classifier", () => {
  const offenders = readdirSync(sse)
    .filter((name) => name.endsWith(".ts") && name !== "opencode-tool-outcome.ts")
    .filter((name) => /\bstate\??\.error\b/.test(readFileSync(join(sse, name), "utf8")));
  assert.deepEqual(offenders, []);
});
