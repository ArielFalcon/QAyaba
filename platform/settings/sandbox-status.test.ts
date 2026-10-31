import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEgressMode } from "./sandbox-status";

test("QA_EGRESS_MODE: enforce is the default, warn is the operator's choice, anything else is a configuration error", () => {
  assert.equal(resolveEgressMode({}), "enforce");
  assert.equal(resolveEgressMode({ QA_EGRESS_MODE: "" }), "enforce");
  assert.equal(resolveEgressMode({ QA_EGRESS_MODE: "warn" }), "warn");
  assert.throws(() => resolveEgressMode({ QA_EGRESS_MODE: "off" }), /QA_EGRESS_MODE/);
});
