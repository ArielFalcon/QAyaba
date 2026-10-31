/* A run secret that holds a `/` and stands raw in a request path is never left half-kept by a cut: the orchestrator redacts an address by value before it cuts it, and an address a sandboxed producer already cut loses the segments that begin a secret it stops short of. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressOfProducerCut } from "@contexts/test-execution/domain/producer-address.ts";
import { PRODUCER_ADDRESS_CHARS } from "../../src/shared-kernel/address-cut.ts";
import { MAX_LOGGED_PATH_CHARS, RequestLedger } from "../../src/shared-kernel/observed-requests.ts";
import { createRunSecretScope, partialSecretStartByValue, withRunSecretScope } from "../../src/shared-kernel/run-secret-redaction.ts";
import { sanitizeText } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { runE2E, type E2eExecuteDeps } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { readObservations } from "@contexts/test-execution/infrastructure/observation-reader.ts";
import { describeDevWriteRequest } from "@contexts/test-execution/domain/dev-write-request.ts";

const ORIGIN = "https://dev.example.test";
/* A password that holds a slash: its first half is a whole path segment of its own. */
const HEAD = "Zq9tLm2vRx8kPw4n";
const SECRET = `${HEAD}/Hy6cBd3fGj7sTu5a`;

const scoped = <T>(fn: () => T): T => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([SECRET]);
  return withRunSecretScope(scope, fn);
};

/* An address whose secret starts `inside` characters before `bound`, so a cut at the bound lands past the secret's slash. */
function straddling(bound: number, inside: number): string {
  const prefix = `${ORIGIN}/api/v1/sessions/`;
  const pad = bound - inside - prefix.length - "/".length;
  return `${prefix}${"a-".repeat(Math.floor(pad / 2))}${"a".repeat(pad % 2)}/${SECRET}/close`;
}
const seedCut = (raw: string): string => {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}`.slice(0, PRODUCER_ADDRESS_CHARS);
};

test("a text that ends in the beginning of a value, up to one of the value's slashes, says where that beginning starts", () => {
  scoped(() => {
    assert.equal(partialSecretStartByValue(`/api/${HEAD}`), "/api/".length);
    assert.equal(partialSecretStartByValue(`/api/x${HEAD}`), "/api/x".length);
    assert.equal(partialSecretStartByValue(`/api/${HEAD}/Hy6c`), undefined);
    assert.equal(partialSecretStartByValue("/api/orders"), undefined);
  });
  assert.equal(partialSecretStartByValue(`/api/${HEAD}`), undefined, "outside a run nothing is secret");
});

test("an address a producer cut loses the segments that begin a run secret it stops short of, and nothing else", () => {
  for (const inside of [20, 25, 30]) {
    const cut = seedCut(straddling(PRODUCER_ADDRESS_CHARS, inside));
    const kept = scoped(() => addressOfProducerCut(cut, PRODUCER_ADDRESS_CHARS));
    assert.match(kept, /\/api\/v1\/sessions\/[a-]+$/, `inside=${inside}: ${kept}`);
    assert.ok(!kept.includes(HEAD.slice(0, 8)), kept);
  }
  const plain = seedCut(`${ORIGIN}/api/${"item1234/".repeat(40)}close`);
  assert.equal(scoped(() => addressOfProducerCut(plain, PRODUCER_ADDRESS_CHARS)), addressOfProducerCut(plain, PRODUCER_ADDRESS_CHARS));
  const whole = `${ORIGIN}/api/${HEAD}`;
  assert.equal(scoped(() => addressOfProducerCut(whole, PRODUCER_ADDRESS_CHARS)), whole, "an address the producer did not cut holds the secret whole and is redacted later");
});

test("a DEV write whose path holds a run secret with a slash across the seed's cut leaves no part of it in the counted requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-slash-secret-"));
  try {
    const dumps = join(root, "dumps");
    mkdirSync(dumps);
    const recorded = seedCut(straddling(PRODUCER_ADDRESS_CHARS, 25));
    writeFileSync(join(dumps, "ledger-0-1.json"), JSON.stringify({ v: 2, writes: 1, pending: 0, done: true, project: "desktop", requests: [{ method: "DELETE", url: recorded, sender: "page", count: 1 }] }));
    const deps = { allocateFailureDir: () => ({ dir: dumps, root, dispose: () => {} }), runSuite: async () => ({ report: { stats: { expected: 1 }, suites: [] }, logs: "ok", ran: true }) } as unknown as E2eExecuteDeps;
    const run = await scoped(() => runE2E("/dir", { baseUrl: ORIGIN, namespace: "ns", countWrites: true }, deps));
    const urls = (run.devWriteRequests ?? []).map(describeDevWriteRequest).join(" ");
    assert.equal(run.devWrites, 1);
    assert.match(urls, /\/api\/v1\/sessions\//);
    assert.ok(!urls.includes(HEAD.slice(0, 8)), urls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an observed request whose path holds a run secret with a slash across the seed's cut leaves no part of it in the observation", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-slash-secret-"));
  try {
    const dir = join(root, "dumps");
    mkdirSync(dir);
    const recorded = seedCut(straddling(PRODUCER_ADDRESS_CHARS, 25));
    writeFileSync(join(dir, "observed-w0-t1-r0.json"), JSON.stringify({ project: "desktop", file: "a.spec.ts", title: "orders", retry: 0, requests: [{ method: "GET", url: recorded, count: 1 }], yaml: "- main" }));
    const pages = scoped(() => readObservations(dir, root, ["orders"], (name, files) => files.filter((f) => (f as { title?: string }).title === name)));
    const urls = JSON.stringify(pages);
    assert.match(urls, /\/api\/v1\/sessions\//);
    assert.ok(!urls.includes(HEAD.slice(0, 8)), urls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the request ledger redacts an address by value before it cuts it, so a secret with a slash is not split by the cut", () => {
  for (const inside of [20, 25, 30]) {
    const ledger = new RequestLedger();
    scoped(() => ledger.addListed("GET", straddling(MAX_LOGGED_PATH_CHARS, inside), false, 1));
    const answer = scoped(() => sanitizeText(JSON.stringify(ledger.drain())).text);
    assert.match(answer, /\/api\/v1\/sessions\/[a-]+/);
    assert.ok(!answer.includes(HEAD.slice(0, 8)), `inside=${inside}: ${answer}`);
  }
});

/* A session value is any cookie or storage value the run holds: an app keeps URLs and paths there, and their beginnings are ordinary path segments. */
const withSession = <T>(values: string[], fn: () => T): T => {
  const scope = createRunSecretScope();
  scope.addSessionValues(values);
  return withRunSecretScope(scope, fn);
};

test("an address a producer cut keeps its origin and root when a value of the run begins inside it, so it is still read and counted", async () => {
  const value = `${ORIGIN}/orders/42`;
  const cut = seedCut(`${ORIGIN}/orders/${"0123456789abcdef".repeat(19)}/lines`);
  const kept = withSession([value, "dev.example.test/orders/42"], () => addressOfProducerCut(cut, PRODUCER_ADDRESS_CHARS));
  assert.equal(new URL(kept).origin, ORIGIN, kept);
  const root = mkdtempSync(join(tmpdir(), "qa-slash-secret-"));
  try {
    const dumps = join(root, "dumps");
    mkdirSync(dumps);
    writeFileSync(join(dumps, "ledger-0-1.json"), JSON.stringify({ v: 2, writes: 1, pending: 0, done: true, project: "desktop", requests: [{ method: "DELETE", url: cut, sender: "page", count: 1 }] }));
    const deps = { allocateFailureDir: () => ({ dir: dumps, root, dispose: () => {} }), runSuite: async () => ({ report: { stats: { expected: 1 }, suites: [] }, logs: "ok", ran: true }) } as unknown as E2eExecuteDeps;
    const run = await withSession([value], () => runE2E("/dir", { baseUrl: ORIGIN, namespace: "ns", countWrites: true }, deps));
    assert.equal(run.devWrites, 1, "the ledger is read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a value that begins at a slash drops only its own segments: the whole segments before it stay, and distinct endpoints stay apart", () => {
  const seven = seedCut(`${ORIGIN}/customers/7/orders/${"f".repeat(290)}`);
  const eight = seedCut(`${ORIGIN}/customers/8/orders/${"f".repeat(290)}`);
  const [a, b] = withSession(["/orders/42"], () => [addressOfProducerCut(seven, PRODUCER_ADDRESS_CHARS), addressOfProducerCut(eight, PRODUCER_ADDRESS_CHARS)]);
  assert.equal(a, `${ORIGIN}/customers/7`);
  assert.equal(b, `${ORIGIN}/customers/8`);
  const secret = `/${HEAD}/Hy6cBd3fGj7sTu5a`;
  const scope = createRunSecretScope();
  scope.addAccountSecrets([secret]);
  const cut = seedCut(`${ORIGIN}/a/b/${"c".repeat(250)}/x/${HEAD}/Hy6cBd3fGj7sTu5a/close`);
  const kept = withRunSecretScope(scope, () => addressOfProducerCut(cut, PRODUCER_ADDRESS_CHARS));
  assert.ok(kept.endsWith("/x"), kept);
});

test("an address over the ledger's bound whose redaction fits it still loses its trailing segment, which a producer's own cut may have split", () => {
  const value = "plain-session-value-".repeat(25);
  const raw = `${ORIGIN}/p/${value}/q/${value.slice(0, 300)}`;
  const kept = withSession([value], () => {
    const ledger = new RequestLedger();
    ledger.addListed("GET", raw, false, 1);
    return JSON.stringify(ledger.drain());
  });
  assert.ok(!kept.includes(value.slice(0, 40)), kept);
  assert.match(kept, /\/p\/\[REDACTED\]/);
});
