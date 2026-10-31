/* The automatic login bootstrap asks the app's suite store; whether a request is asked at all is the freeze's decision (run-freeze.ts, runner.campaign.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteHoldsVerifiedLoginFor } from "./login-bootstrap-wiring";

test("the question reads the app's store under the data directory: an app with no store holds no login", () => {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-wiring-"));
  try {
    const holds = suiteHoldsVerifiedLoginFor(root);
    assert.equal(holds("fresh-app"), false);
    mkdirSync(join(root, "data", "suites", "other"), { recursive: true });
    assert.equal(holds("other"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
