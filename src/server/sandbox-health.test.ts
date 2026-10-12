import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSandboxHealth } from "./sandbox-health";

const SB = { uid: 1002, gid: 1002, home: "/home/sandbox" };

test("a sandbox uid with the egress filter's self-test passed is healthy", () => {
  const h = describeSandboxHealth({}, { sandbox: SB, readStatus: () => "ok\n", readFileBoundaryStatus: () => "ok\n" });
  assert.equal(h.degraded, false);
  assert.equal(h.egress, "filtered");
  assert.equal(h.files, "enforced");
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
  const enforce = describeSandboxHealth({}, { sandbox: SB, readStatus: () => "unavailable: iptables: Permission denied", readFileBoundaryStatus: () => "ok" });
  assert.equal(enforce.degraded, true);
  assert.match(enforce.reason ?? "", /Permission denied/);
  const warn = describeSandboxHealth({ QA_EGRESS_MODE: "warn" }, { sandbox: SB, readStatus: () => undefined, readFileBoundaryStatus: () => "ok" });
  assert.equal(warn.degraded, false);
  assert.equal(warn.egress, "unfiltered");
  assert.match(warn.reason ?? "", /full network/);
});

test("a file boundary the boot check found open is degraded under required, and says what the sandbox uid can reach", () => {
  const h = describeSandboxHealth({ QA_EXEC_SANDBOX: "required" }, { sandbox: SB, readStatus: () => "ok", readFileBoundaryStatus: () => "breach: /app/src is writable by the sandbox uid\n" });
  assert.equal(h.degraded, true);
  assert.equal(h.files, "exposed");
  assert.match(h.reason ?? "", /\/app\/src is writable/);
  assert.match(h.reason ?? "", /E-SANDBOX/);
});

test("a file boundary that was never checked is not taken for one that holds", () => {
  const h = describeSandboxHealth({ QA_EXEC_SANDBOX: "required" }, { sandbox: SB, readStatus: () => "ok", readFileBoundaryStatus: () => undefined });
  assert.equal(h.degraded, true);
  assert.equal(h.files, "exposed");
  assert.match(h.reason ?? "", /never checked/);
});

test("under best-effort an open file boundary is said, not degraded; both problems are said when both are there", () => {
  const h = describeSandboxHealth({ QA_EXEC_SANDBOX: "best-effort", QA_EGRESS_MODE: "warn" }, { sandbox: SB, readStatus: () => "unavailable: no iptables", readFileBoundaryStatus: () => "breach: /app/config is listable by the sandbox uid" });
  assert.equal(h.degraded, false);
  assert.match(h.reason ?? "", /\/app\/config is listable/);
  assert.match(h.reason ?? "", /no iptables/);
  const both = describeSandboxHealth({}, { sandbox: SB, readStatus: () => "unavailable: no iptables", readFileBoundaryStatus: () => "breach: /app/config is listable by the sandbox uid" });
  assert.equal(both.degraded, true);
  assert.match(both.reason ?? "", /listable.*no iptables|no iptables.*listable/);
});
