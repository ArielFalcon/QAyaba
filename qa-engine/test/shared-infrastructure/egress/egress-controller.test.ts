/* The controller is the egress filter as the launcher sees it: it brings the listeners and the kernel rules up for the origins a run declares, holds a lease per child, and answers the proxy and the DNS filter with the union of the leases held right now. Everything it touches is a fake. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EgressController, type EgressControllerDeps } from "../../../src/shared-infrastructure/egress/egress-controller.ts";
import { newSandboxReport } from "../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import type { RulesetInput } from "../../../src/shared-infrastructure/egress/iptables-ruleset.ts";

interface Harness {
  controller: EgressController;
  applied: RulesetInput[];
  listened: number[];
  warnings: string[];
  closed: string[];
}

function harness(over: Partial<EgressControllerDeps> & { applyFails?: boolean; jumps?: string } = {}): Harness {
  const applied: RulesetInput[] = [];
  const listened: number[] = [];
  const warnings: string[] = [];
  const closed: string[] = [];
  let next = 40000;
  const controller = new EgressController({
    mode: "enforce",
    uid: 1002,
    readStatus: () => "ok",
    createProxy: () => ({ listen: async (upstream) => { listened.push(upstream); return (next += 1); }, close: async () => { closed.push("proxy"); } }),
    createDns: () => ({ listen: async () => 5353, close: async () => { closed.push("dns"); } }),
    iptables: {
      apply: (input) => { if (over.applyFails) throw new Error("xtables lock"); applied.push(input); },
      verifyJumps: () => over.jumps,
    },
    warn: (line) => warnings.push(line),
    ...over,
  });
  return { controller, applied, listened, warnings, closed };
}

test("the filter is not available until a run has prepared it", () => {
  assert.equal(harness().controller.available(), false);
});

test("preparing brings a listener up for every declared port and rewrites the kernel rules once for them", async () => {
  const h = harness();
  await h.controller.prepare(["https://dev.example.com", "http://plain.example.com", "https://alt.example.com:8443"]);
  assert.equal(h.controller.available(), true);
  assert.deepEqual(h.listened.sort((a, b) => a - b), [80, 443, 8443]);
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.applied[0]!.redirects.map((r) => r.upstream).sort((a, b) => a - b), [80, 443, 8443]);
  assert.equal(h.applied[0]!.dnsPort, 5353);
  assert.equal(h.applied[0]!.uid, 1002);
});

test("preparing again opens no second listener, rewrites the rules so another process's rewrite is undone, and keeps every port", async () => {
  const h = harness();
  await h.controller.prepare(["https://dev.example.com"]);
  await h.controller.prepare(["https://dev.example.com"]);
  assert.deepEqual(h.listened, [443], "one listener per upstream port, however many runs");
  assert.equal(h.applied.length, 2, "the rules are put back at every run");
  await h.controller.prepare(["https://alt.example.com:8443"]);
  assert.deepEqual(h.applied[2]!.redirects.map((r) => r.upstream).sort((a, b) => a - b), [443, 8443]);
});

test("a status file that does not say ok leaves the filter unavailable, with the reason said once", async () => {
  const h = harness({ readStatus: () => "unavailable: iptables: Permission denied" });
  await h.controller.prepare(["https://dev.example.com"]);
  await h.controller.prepare(["https://dev.example.com"]);
  assert.equal(h.controller.available(), false);
  assert.equal(h.applied.length, 0);
  assert.equal(h.warnings.filter((w) => /Permission denied/.test(w)).length, 1);
});

test("no status file at all is not ok", async () => {
  const h = harness({ readStatus: () => undefined });
  await h.controller.prepare(["https://dev.example.com"]);
  assert.equal(h.controller.available(), false);
});

test("rules that cannot be applied leave the filter unavailable and are said, never thrown into the run", async () => {
  const h = harness({ applyFails: true });
  await h.controller.prepare(["https://dev.example.com"]);
  assert.equal(h.controller.available(), false);
  assert.ok(h.warnings.some((w) => /xtables lock/.test(w)));
});

test("a jump from OUTPUT that has gone missing makes the filter unavailable", async () => {
  const h = harness({ jumps: "iptables filter: the jump is missing" });
  await h.controller.prepare(["https://dev.example.com"]);
  assert.equal(h.controller.available(), false);
});

test("what is reachable is the union of the leases held, and nothing once they are released", async () => {
  const h = harness();
  await h.controller.prepare(["https://a.example.com", "https://b.example.com"]);
  assert.equal(h.controller.allows("a.example.com", 443), false, "no lease, no network");
  const first = h.controller.lease(["https://a.example.com"]);
  const second = h.controller.lease(["https://b.example.com"]);
  assert.equal(h.controller.allows("a.example.com", 443), true);
  assert.equal(h.controller.allows("b.example.com", 443), true);
  assert.equal(h.controller.allows("c.example.com", 443), false);
  first.release();
  assert.equal(h.controller.allows("a.example.com", 443), false);
  assert.equal(h.controller.allows("b.example.com", 443), true);
  second.release();
  assert.equal(h.controller.allowsName("b.example.com"), false);
});

test("an offline lease (no origins) reaches nothing", async () => {
  const h = harness();
  await h.controller.prepare(["https://a.example.com"]);
  h.controller.lease([]);
  assert.equal(h.controller.allows("a.example.com", 443), false);
});

test("a host the filter refuses is noted in the report of every lease held, once, and the list is bounded", async () => {
  const h = harness();
  await h.controller.prepare(["https://a.example.com"]);
  const report = newSandboxReport();
  h.controller.lease(["https://a.example.com"], report);
  h.controller.noteDenied("evil.example.net");
  h.controller.noteDenied("evil.example.net");
  assert.deepEqual(report.denied, ["evil.example.net"]);
  for (let i = 0; i < 500; i += 1) h.controller.noteDenied(`h${i}.example.net`);
  assert.ok(report.denied.length <= 64);
});

test("a refusal with nobody holding a lease is dropped, not remembered for the next run", async () => {
  const h = harness();
  await h.controller.prepare(["https://a.example.com"]);
  h.controller.noteDenied("late.example.net");
  const report = newSandboxReport();
  h.controller.lease([], report);
  assert.deepEqual(report.denied, []);
});

test("closing stops the proxy and the DNS filter", async () => {
  const h = harness();
  await h.controller.prepare(["https://a.example.com"]);
  await h.controller.close();
  assert.deepEqual(h.closed.sort(), ["dns", "proxy"]);
  assert.equal(h.controller.available(), false);
});
