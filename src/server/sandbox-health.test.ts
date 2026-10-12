import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSandboxHealth } from "./sandbox-health";

const SB = { uid: 1002, gid: 1002, home: "/home/sandbox" };

test("a sandbox uid with the egress filter's self-test passed is healthy", () => {
  const h = describeSandboxHealth({}, { sandbox: SB, readStatus: () => "ok\n" });
  assert.equal(h.degraded, false);
  assert.equal(h.egress, "filtered");
  assert.equal(h.reason, undefined);
});

test("required with no sandbox uid is degraded and says every run will end E-SANDBOX", () => {
  const h = describeSandboxHealth({ QA_EXEC_SANDBOX: "required" }, { sandbox: null });
  assert.equal(h.degraded, true);
  assert.match(h.reason ?? "", /E-SANDBOX/);
});

test("best-effort with no sandbox uid is not degraded, but says what it runs as", () => {
  const h = describeSandboxHealth({}, { sandbox: null });
  assert.equal(h.degraded, false);
  assert.equal(h.isolation, "none");
  assert.ok(h.reason);
});

test("an egress filter that did not pass is degraded under enforce and only said under warn", () => {
  const enforce = describeSandboxHealth({}, { sandbox: SB, readStatus: () => "unavailable: iptables: Permission denied" });
  assert.equal(enforce.degraded, true);
  assert.match(enforce.reason ?? "", /Permission denied/);
  const warn = describeSandboxHealth({ QA_EGRESS_MODE: "warn" }, { sandbox: SB, readStatus: () => undefined });
  assert.equal(warn.degraded, false);
  assert.equal(warn.egress, "unfiltered");
  assert.match(warn.reason ?? "", /full network/);
});
