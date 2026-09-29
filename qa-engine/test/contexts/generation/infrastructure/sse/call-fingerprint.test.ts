import { test } from "node:test";
import assert from "node:assert/strict";
import { callFingerprint } from "@contexts/generation/infrastructure/sse/call-fingerprint.ts";

test("the same tool with the same input has the same fingerprint, whatever the key order", () => {
  assert.equal(
    callFingerprint("grep", { pattern: "foo", path: "/src", nested: { a: 1, b: [1, 2] } }),
    callFingerprint("grep", { nested: { b: [1, 2], a: 1 }, path: "/src", pattern: "foo" }),
  );
});

test("a different tool or a different input has a different fingerprint", () => {
  const base = callFingerprint("grep", { pattern: "foo" });
  assert.notEqual(callFingerprint("read", { pattern: "foo" }), base);
  assert.notEqual(callFingerprint("grep", { pattern: "bar" }), base);
  assert.notEqual(callFingerprint("grep", { pattern: "foo", extra: true }), base);
});

test("a tool name cannot be traded against the start of the input", () => {
  assert.notEqual(callFingerprint("ab", "c"), callFingerprint("a", "bc"));
});

test("a call with no input and a call with a null input are the same call", () => {
  assert.equal(callFingerprint("snapshot", undefined), callFingerprint("snapshot", null));
});

test("the fingerprint has the same small size whether the input is empty or several megabytes", () => {
  const empty = callFingerprint("write", {});
  const huge = callFingerprint("write", { filePath: "/src/a.ts", content: "x".repeat(5_000_000) });
  assert.equal(huge.length, empty.length);
  assert.ok(huge.length <= 128, `the fingerprint was ${huge.length} chars`);
});

test("two large inputs that differ by one character have different fingerprints", () => {
  const content = "y".repeat(2_000_000);
  assert.notEqual(
    callFingerprint("write", { content }),
    callFingerprint("write", { content: `${content.slice(0, -1)}z` }),
  );
});
