/* The kernel half of the egress filter, as the documents handed to iptables-restore. Nothing is applied here (it needs root and a kernel with xt_owner); the rules are checked as text, because their ORDER and their CLOSED default are the security property. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRestoreDocuments, EGRESS_CHAIN } from "../../../src/shared-infrastructure/egress/iptables-ruleset.ts";

const input = { uid: 1002, dnsPort: 5353, redirects: [{ upstream: 443, local: 40443 }, { upstream: 80, local: 40080 }, { upstream: 8443, local: 48443 }] };

const lines = (doc: string): string[] => doc.split("\n").filter(Boolean);

test("the nat chain redirects the sandbox uid's DNS and each allowed upstream port to a local listener", () => {
  const { v4 } = buildRestoreDocuments(input);
  const nat = lines(v4.split("*filter")[0]!.includes("*nat") ? v4.split("*nat")[1]!.split("COMMIT")[0]! : v4);
  assert.ok(nat.includes(`-A ${EGRESS_CHAIN} -p udp --dport 53 -j REDIRECT --to-ports 5353`));
  assert.ok(nat.includes(`-A ${EGRESS_CHAIN} -p tcp --dport 443 -j REDIRECT --to-ports 40443`));
  assert.ok(nat.includes(`-A ${EGRESS_CHAIN} -p tcp --dport 80 -j REDIRECT --to-ports 40080`));
  assert.ok(nat.includes(`-A ${EGRESS_CHAIN} -p tcp --dport 8443 -j REDIRECT --to-ports 48443`));
});

test("the filter chain accepts only the listeners and the DNS filter, then rejects everything else", () => {
  const { v4 } = buildRestoreDocuments(input);
  const filter = lines(v4.split("*filter")[1]!.split("COMMIT")[0]!);
  const rules = filter.filter((l) => l.startsWith("-A "));
  const accepts = rules.filter((l) => l.endsWith("-j ACCEPT"));
  assert.equal(accepts.length, 4, "three listeners and the DNS filter");
  for (const local of [40443, 40080, 48443]) assert.ok(accepts.includes(`-A ${EGRESS_CHAIN} -p tcp -d 127.0.0.1 --dport ${local} -j ACCEPT`), String(local));
  assert.ok(accepts.includes(`-A ${EGRESS_CHAIN} -p udp -d 127.0.0.1 --dport 5353 -j ACCEPT`));
  const last = rules.at(-1)!;
  assert.match(last, /-j REJECT/);
  assert.ok(rules.indexOf(last) > rules.lastIndexOf(accepts.at(-1)!), "the reject comes after every accept");
  assert.equal(rules.filter((l) => /-j REJECT/.test(l)).length, 2, "tcp is reset, everything else is refused");
  assert.ok(rules.some((l) => l.includes("-p tcp") && l.includes("--reject-with tcp-reset")));
});

test("nothing but the listeners is accepted on loopback: the API and the tools port stay closed", () => {
  const { v4 } = buildRestoreDocuments({ ...input, redirects: [] });
  const filter = lines(v4.split("*filter")[1]!.split("COMMIT")[0]!);
  const accepts = filter.filter((l) => l.startsWith("-A ") && l.endsWith("-j ACCEPT"));
  assert.deepEqual(accepts, [`-A ${EGRESS_CHAIN} -p udp -d 127.0.0.1 --dport 5353 -j ACCEPT`]);
  assert.equal(filter.some((l) => /--dport 458\b/.test(l)), false);
});

test("the chain is rewritten in one commit per table, so there is no moment with an empty chain", () => {
  const { v4, v6 } = buildRestoreDocuments(input);
  for (const doc of [v4, v6]) {
    const body = lines(doc);
    const tables = body.filter((l) => l.startsWith("*"));
    const commits = body.filter((l) => l === "COMMIT");
    assert.equal(tables.length, commits.length);
    for (const table of tables) {
      const start = body.indexOf(table);
      const flush = body.indexOf(`-F ${EGRESS_CHAIN}`, start);
      const commit = body.indexOf("COMMIT", start);
      assert.ok(flush > start && flush < commit, "the flush and the new rules are inside one table block");
      assert.ok(body.slice(flush, commit).some((l) => l.startsWith(`-A ${EGRESS_CHAIN}`)), "and the block re-adds the rules");
    }
  }
});

test("IPv6 is closed to the sandbox uid entirely, loopback included", () => {
  const { v6 } = buildRestoreDocuments(input);
  const rules = lines(v6).filter((l) => l.startsWith("-A "));
  assert.deepEqual(rules, [`-A ${EGRESS_CHAIN} -j REJECT --reject-with icmp6-port-unreachable`]);
});

test("the documents never name a uid, which belongs to the jump from OUTPUT, and carry no shell", () => {
  const { v4, v6 } = buildRestoreDocuments(input);
  for (const doc of [v4, v6]) {
    assert.equal(/uid-owner/.test(doc), false);
    assert.equal(/[;&|`$]/.test(doc), false);
  }
});

test("a port outside 1-65535 cannot be written into a rule", () => {
  assert.throws(() => buildRestoreDocuments({ ...input, redirects: [{ upstream: 443, local: 0 }] }), /port/);
  assert.throws(() => buildRestoreDocuments({ ...input, dnsPort: 70000 }), /port/);
  assert.throws(() => buildRestoreDocuments({ ...input, uid: 0 }), /uid/);
});
