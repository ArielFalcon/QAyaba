import { test } from "node:test";
import assert from "node:assert/strict";
import { createIptablesApplier } from "../../../src/shared-infrastructure/egress/iptables-runner.ts";

const input = { uid: 1002, dnsPort: 5353, redirects: [{ upstream: 443, local: 40443 }] };

test("applying hands the IPv4 and IPv6 documents to the atomic restore commands, without flushing the rest of the tables", () => {
  const calls: Array<{ command: string; args: readonly string[]; input: string | undefined }> = [];
  createIptablesApplier((command, args, doc) => { calls.push({ command, args, input: doc }); }).apply(input);
  assert.deepEqual(calls.map((c) => c.command), ["iptables-restore", "ip6tables-restore"]);
  for (const call of calls) {
    assert.ok(call.args.includes("--noflush"), `${call.command} must not flush the other chains`);
    assert.ok(call.input?.includes("COMMIT"));
  }
  assert.match(calls[0]!.input!, /REDIRECT --to-ports 40443/);
});

test("a failing restore is not swallowed", () => {
  assert.throws(() => createIptablesApplier(() => { throw new Error("xtables lock"); }).apply(input), /xtables lock/);
});

test("the jumps are verified for the filter and nat tables and for IPv6, and a missing one is named", () => {
  const seen: string[] = [];
  const ok = createIptablesApplier((command, args) => { seen.push(`${command} ${args.join(" ")}`); });
  assert.equal(ok.verifyJumps(1002), undefined);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((line) => line.includes("--uid-owner 1002") && line.includes("QA_EGRESS")));
  const missing = createIptablesApplier((command, args) => { if (command === "ip6tables" || args.includes("nat")) throw new Error("no such rule"); });
  assert.match(missing.verifyJumps(1002) ?? "", /missing/);
});
