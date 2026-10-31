/* The DNS filter answers the sandbox uid's name lookups: a declared name is forwarded to the real resolver, every other name does not exist. Real UDP on loopback; the real resolver is a fake. */
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { buildDnsQuery, DnsFilter, parseDnsQuestion } from "../../../src/shared-infrastructure/egress/dns-filter.ts";
import { compileEgressPolicy } from "../../../src/shared-kernel/egress-policy.ts";

function ask(port: number, query: Buffer): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve(undefined); }, 1500);
    socket.once("message", (message) => { clearTimeout(timer); socket.close(); resolve(message); });
    socket.send(query, port, "127.0.0.1");
  });
}

function filterFor(origins: string[], forward?: (query: Buffer) => Promise<Buffer>): { filter: DnsFilter; denied: string[]; forwarded: string[] } {
  const policy = compileEgressPolicy(origins);
  const denied: string[] = [];
  const forwarded: string[] = [];
  const filter = new DnsFilter({
    allowsName: (name) => policy.allowsName(name),
    onDenied: (name) => denied.push(name),
    forward: forward ?? (async (query) => { forwarded.push(parseDnsQuestion(query)?.name ?? "?"); return Buffer.concat([query, Buffer.from("FORWARDED")]); }),
  });
  return { filter, denied, forwarded };
}

test("a declared name is forwarded to the real resolver and its answer is returned as it came", async () => {
  const { filter, forwarded, denied } = filterFor(["https://registry.npmjs.org"]);
  try {
    const port = await filter.listen();
    const answer = await ask(port, buildDnsQuery(0x1234, "registry.npmjs.org", 1));
    assert.ok(answer);
    assert.ok(answer.toString("latin1").endsWith("FORWARDED"));
    assert.deepEqual(forwarded, ["registry.npmjs.org"]);
    assert.deepEqual(denied, []);
  } finally {
    await filter.close();
  }
});

test("a name the policy does not declare does not exist: NXDOMAIN, the query's id and question kept, nothing forwarded", async () => {
  const { filter, forwarded, denied } = filterFor(["https://registry.npmjs.org"]);
  try {
    const port = await filter.listen();
    const answer = await ask(port, buildDnsQuery(0xbeef, "attacker.example.net", 1));
    assert.ok(answer);
    assert.equal(answer.readUInt16BE(0), 0xbeef);
    assert.equal(answer.readUInt16BE(2) & 0x000f, 3, "RCODE is NXDOMAIN");
    assert.equal(answer.readUInt16BE(2) & 0x8000, 0x8000, "it is a response");
    assert.equal(answer.readUInt16BE(6), 0, "no answers");
    assert.equal(parseDnsQuestion(answer)?.name, "attacker.example.net");
    assert.deepEqual(forwarded, []);
    assert.deepEqual(denied, ["attacker.example.net"]);
  } finally {
    await filter.close();
  }
});

test("an AAAA question for a declared name gets an empty answer, so a client stays on IPv4 where the filter holds", async () => {
  const { filter, forwarded } = filterFor(["https://registry.npmjs.org"]);
  try {
    const port = await filter.listen();
    const answer = await ask(port, buildDnsQuery(7, "registry.npmjs.org", 28));
    assert.ok(answer);
    assert.equal(answer.readUInt16BE(2) & 0x000f, 0, "NOERROR");
    assert.equal(answer.readUInt16BE(6), 0, "no answers");
    assert.deepEqual(forwarded, []);
  } finally {
    await filter.close();
  }
});

test("a datagram that is not a single well-formed question is not answered", async () => {
  const { filter, forwarded } = filterFor(["https://registry.npmjs.org"]);
  try {
    const port = await filter.listen();
    assert.equal(await ask(port, Buffer.from([1, 2, 3])), undefined);
    const twoQuestions = buildDnsQuery(9, "registry.npmjs.org", 1);
    twoQuestions.writeUInt16BE(2, 4);
    assert.equal(await ask(port, twoQuestions), undefined);
    assert.deepEqual(forwarded, []);
  } finally {
    await filter.close();
  }
});

test("a resolver that fails leaves the lookup unanswered instead of inventing an answer", async () => {
  const { filter } = filterFor(["https://registry.npmjs.org"], async () => { throw new Error("upstream down"); });
  try {
    const port = await filter.listen();
    assert.equal(await ask(port, buildDnsQuery(1, "registry.npmjs.org", 1)), undefined);
  } finally {
    await filter.close();
  }
});

test("names are compared in lower case", async () => {
  const { filter, forwarded } = filterFor(["https://registry.npmjs.org"]);
  try {
    const port = await filter.listen();
    await ask(port, buildDnsQuery(1, "Registry.NPMJS.org", 1));
    assert.equal(forwarded.length, 1);
  } finally {
    await filter.close();
  }
});
