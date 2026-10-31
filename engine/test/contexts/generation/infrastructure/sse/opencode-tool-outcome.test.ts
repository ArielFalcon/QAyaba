import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_TARGET_MAX_CHARS } from "@contexts/generation/domain/tool-sequence.ts";
import { redactedText, toolOutcomeOf, TOOL_ERROR_MAX_CHARS } from "@contexts/generation/infrastructure/sse/opencode-tool-outcome.ts";

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

/* Word-like filler: a run of one repeated character trips the entropy redaction and would hide the cut. */
const filler = (chars: number): string => "the file is missing in the working copy; ".repeat(Math.ceil(chars / 40)).slice(0, chars);
const TOKEN = "Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";

test("a credential straddling the cap never reaches a failed call's message, not even in part", () => {
  const outcome = toolOutcomeOf({ tool: "bash", state: { status: "error", error: filler(TOOL_ERROR_MAX_CHARS - 40) + TOKEN } });
  const message = outcome.kind === "failed" ? (outcome.message ?? "") : "";
  assert.ok(message.length > 0 && message.length <= TOOL_ERROR_MAX_CHARS);
  assert.ok(!/Bearer abc|abcdefghij/.test(message), `a prefix of the credential survived: ${message.slice(-60)}`);
});

test("a credential straddling the cap never reaches the attempted tool or a target", () => {
  const attempted = toolOutcomeOf({ tool: "invalid", state: { status: "completed", input: { tool: filler(170) + TOKEN } } });
  assert.ok(!/Bearer abc|abcdefghij/.test(attempted.kind === "invalid" ? (attempted.attempted ?? "") : ""));
  assert.ok(!/Bearer abc|abcdefghij/.test(redactedText(filler(170) + TOKEN, 200)));
});

/* A quoted credential of 800 characters in a tool's target (a grep command, a JSON pattern, a header): only a window that holds it whole closes the quote and lets the pattern take every word of it; cut inside, the pattern takes the first word alone. */
const SECRET_WORDS = "swordfish marlin anchovy ".repeat(32);

test("an 800-character quoted credential that begins before the target cap leaves no word of itself, in a grep command, a JSON pattern or a header", () => {
  for (const text of [`grep -rn "password=\"${SECRET_WORDS}\"" src/`, `{"pattern":"api_key: \"${SECRET_WORDS}\"","path":"src"}`, `curl -H 'Authorization: Bearer "${SECRET_WORDS}"' https://x`]) {
    const target = redactedText(text, TOOL_TARGET_MAX_CHARS);
    assert.ok(target.length <= TOOL_TARGET_MAX_CHARS);
    assert.ok(!/marlin|anchovy|swordfish marlin/.test(target), `a part of the credential survived: ${target}`);
  }
});

test("a long JWT in a grep command is redacted whole, whatever the cap", () => {
  const jwt = `eyJ${"a1B2".repeat(75)}.${"c3D4".repeat(75)}.${"e5F6".repeat(50)}`;
  assert.ok(!/eyJ|a1B2/.test(redactedText(`grep -rn "${jwt}" src/`, TOOL_TARGET_MAX_CHARS)));
});

test("a fault in the redactor yields a marker, never the raw message or attempted tool", () => {
  const redact = (): string => {
    throw new Error("redactor down");
  };
  const failed = toolOutcomeOf({ tool: "read", state: { status: "error", error: "ENOENT: raw" } }, { redact });
  assert.deepEqual(failed, { kind: "failed", message: "[redacted]" });
  const invalid = toolOutcomeOf({ tool: "invalid", state: { status: "completed", input: { tool: "readfile", error: "raw" } } }, { redact });
  assert.deepEqual(invalid, { kind: "invalid", attempted: "[redacted]", message: "[redacted]" });
  assert.equal(redactedText("raw", 200, { redact }), "[redacted]");
});

const ROOTS = [join(import.meta.dirname, "..", "..", "..", "..", "..", "src"), join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "platform")];

/* Every source file under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourcesUnder(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no module of the engine or the shell reads a tool state's error outside the outcome classifier", () => {
  const offenders = ROOTS.flatMap(sourcesUnder)
    .filter((path) => !path.endsWith(join("sse", "opencode-tool-outcome.ts")))
    .filter((path) => /\bstate\??\.error\b/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});
