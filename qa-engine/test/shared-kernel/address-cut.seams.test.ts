/* A request address cut at a bound never carries part of a secret: every cut keeps whole path segments, so redaction by value still finds the secret whole or not at all. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutAddress, wholeSegmentsOfProducerCut } from "../../src/shared-kernel/address-cut.ts";
import { MAX_LOGGED_PATH_CHARS, RequestLedger } from "../../src/shared-kernel/observed-requests.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../src/shared-kernel/run-secret-redaction.ts";
import { sanitizeText } from "../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { runE2E, type E2eExecuteDeps } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { readObservations } from "@contexts/test-execution/infrastructure/observation-reader.ts";
import { describeDevWriteRequest } from "@contexts/test-execution/domain/dev-write-request.ts";

const TOKEN = "Zq9tLm2vRx8kPw4nHy6cBd3fGj7sTu5aQe1rWy0uIo9pAs8dFg7hJk6lZx5cVb4n";
const ORIGIN = "https://dev.example.test";
/* The bound the seed's networkUrl cuts a DEV-write or observed address at, in the sandboxed child. */
const SEED_ADDRESS_BOUND = 300;

const scoped = <T>(fn: () => T): T => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([TOKEN]);
  return withRunSecretScope(scope, fn);
};
const fragments = (text: string): string[] => [0, 8, 16, 24, 40].map((at) => TOKEN.slice(at, at + 8)).filter((f) => text.includes(f));

/* An address whose session token starts `inside` characters before `bound`, so a cut at the bound splits it. */
function straddling(bound: number, inside: number): string {
  const prefix = `${ORIGIN}/api/v1/sessions/`;
  const pad = bound - inside - prefix.length - "/".length;
  return `${prefix}${"a-".repeat(Math.floor(pad / 2))}${"a".repeat(pad % 2)}/${TOKEN}/close`;
}
/* The seed's own cut: origin + pathname sliced at the bound. */
const seedCut = (raw: string): string => {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}`.slice(0, SEED_ADDRESS_BOUND);
};

test("a cut address keeps whole path segments, and an address within its bound is unchanged", () => {
  assert.equal(cutAddress(`${ORIGIN}/abcdef`, `${ORIGIN}/ab`.length), `${ORIGIN}/`);
  assert.equal(cutAddress(`${ORIGIN}/abc/def/ghi`, `${ORIGIN}/abc/de`.length), `${ORIGIN}/abc/`);
  assert.equal(cutAddress(`${ORIGIN}/abc`, 100), `${ORIGIN}/abc`);
  assert.equal(cutAddress("x".repeat(30), 10), "x".repeat(10));
  assert.equal(wholeSegmentsOfProducerCut(`${ORIGIN}/abc/def`, 100), `${ORIGIN}/abc/def`);
  assert.equal(wholeSegmentsOfProducerCut(`${ORIGIN}/abc/de`, `${ORIGIN}/abc/de`.length), `${ORIGIN}/abc/`);
});

test("a DEV write whose path holds a run secret across the seed's cut leaves no part of it in the counted requests", async () => {
  for (const inside of [10, 30, 50]) {
    const root = mkdtempSync(join(tmpdir(), "qa-address-cut-"));
    try {
      const dumps = join(root, "dumps");
      mkdirSync(dumps);
      const recorded = seedCut(straddling(SEED_ADDRESS_BOUND, inside));
      writeFileSync(join(dumps, "ledger-0-1.json"), JSON.stringify({ v: 2, writes: 1, pending: 0, done: true, project: "desktop", requests: [{ method: "DELETE", url: recorded, sender: "page", count: 1 }] }));
      const deps = { allocateFailureDir: () => ({ dir: dumps, root, dispose: () => {} }), runSuite: async () => ({ report: { stats: { expected: 1 }, suites: [] }, logs: "ok", ran: true }) } as unknown as E2eExecuteDeps;
      const run = await scoped(() => runE2E("/dir", { baseUrl: ORIGIN, namespace: "ns", countWrites: true }, deps));
      const urls = (run.devWriteRequests ?? []).map(describeDevWriteRequest).join(" ");
      assert.equal(run.devWrites, 1);
      assert.match(urls, /\/api\/v1\/sessions\//);
      assert.deepEqual(fragments(urls), [], `inside=${inside}: ${urls}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an observed request whose path holds a run secret across the seed's cut leaves no part of it in the observation", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-address-cut-"));
  try {
    const dir = join(root, "dumps");
    mkdirSync(dir);
    const recorded = seedCut(straddling(SEED_ADDRESS_BOUND, 30));
    writeFileSync(join(dir, "observed-w0-t1-r0.json"), JSON.stringify({ project: "desktop", file: "a.spec.ts", title: "orders", retry: 0, requests: [{ method: "GET", url: recorded, count: 1 }], yaml: '- button "Save"' }));
    const pages = scoped(() => readObservations(dir, root, ["orders"], (name, files) => files.filter((f) => (f as { title?: string }).title === name)));
    const urls = JSON.stringify(pages);
    assert.match(urls, /\/api\/v1\/sessions\//);
    assert.deepEqual(fragments(urls), [], urls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the request ledger's bound on an address cuts at a segment, so the redacted answer holds no part of a secret", () => {
  for (const inside of [10, 30, 50]) {
    const ledger = new RequestLedger();
    ledger.addListed("GET", straddling(MAX_LOGGED_PATH_CHARS, inside), false, 1);
    const kept = ledger.drain();
    const answer = scoped(() => sanitizeText(redactByValue(JSON.stringify(kept))).text);
    assert.equal(kept.listed.length, 1);
    assert.match(answer, /\/api\/v1\/sessions\/[a-]+\//);
    assert.deepEqual(fragments(answer), [], `inside=${inside}: ${answer}`);
  }
});
