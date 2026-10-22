import { test } from "node:test";
import assert from "node:assert/strict";
import { capCaptureMode, DEFAULT_CAPTURE_MODE, isCaptureMode } from "@kernel/telemetry/capture-mode.ts";

test("a run that asks for nothing gets the default, unless the ceiling is lower", () => {
  assert.equal(capCaptureMode(undefined, "full"), DEFAULT_CAPTURE_MODE);
  assert.equal(capCaptureMode(undefined, "off"), "off");
});

test("a request above the ceiling is capped to it, a request at or below stands", () => {
  assert.equal(capCaptureMode("full", "metadata"), "metadata");
  assert.equal(capCaptureMode("full", "off"), "off");
  assert.equal(capCaptureMode("metadata", "full"), "metadata");
  assert.equal(capCaptureMode("off", "metadata"), "off");
  assert.equal(capCaptureMode("full", "full"), "full");
});

test("only the three modes are capture modes", () => {
  assert.equal(isCaptureMode("metadata"), true);
  assert.equal(isCaptureMode("FULL"), false);
  assert.equal(isCaptureMode(undefined), false);
});
