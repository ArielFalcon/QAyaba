/* The automatic login bootstrap asks the app's suite store, and stays off for a campaign that controls the suite's warmth itself. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAMPAIGN_FREEZE_ENV } from "./campaign-freeze";
import { suiteHoldsVerifiedLoginFor } from "./login-bootstrap-wiring";

test("under a campaign freeze there is no question, so no run queues a bootstrap on its own", () => {
  assert.equal(suiteHoldsVerifiedLoginFor({ [CAMPAIGN_FREEZE_ENV]: "1" }, "/app"), undefined);
});

test("outside a freeze the question reads the app's store under the data directory: an app with no store holds no login", () => {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-wiring-"));
  try {
    const holds = suiteHoldsVerifiedLoginFor({}, root);
    assert.ok(holds);
    assert.equal(holds("fresh-app"), false);
    mkdirSync(join(root, "data", "suites", "other"), { recursive: true });
    assert.equal(holds("other"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
