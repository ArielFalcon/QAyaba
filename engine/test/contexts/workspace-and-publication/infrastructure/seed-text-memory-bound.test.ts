/* The seed's failure capture runs in the app's test process, which holds none of the run's secrets, so it keeps the text of a failed request or an error up to a memory bound and the orchestrator redacts what it reads and only then cuts it to the bound it shows. The capture block between the seed's markers is compiled and driven with a stand-in page, and the dump it writes is read by the real reader. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { readFailureDumps } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { PRODUCER_MEMORY_BOUND_CHARS, REDACTION_LOOKAHEAD_CHARS } from "../../../../src/shared-kernel/redact-then-bound.ts";
import { CASES, filler, leaks, withRunSecrets } from "../../../support/straddling-secrets.ts";

const SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");

interface Capture {
  start(page: unknown, request: unknown): Promise<void>;
  finish(page: unknown, testInfo: unknown): Promise<void>;
}

const capture = (() => {
  const start = SEED.indexOf("// >>> qa-failure-capture");
  const end = SEED.indexOf("// Set by the seed's _failureCapture fixture");
  assert.ok(start >= 0 && end > start, "the seed marks its failure capture block");
  const body = SEED.slice(start, end).replace(/^import type .*$/m, "");
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(`return (async () => { ${js}\nreturn { start: qaFailureCaptureStart, finish: qaFailureCaptureFinish }; })();`)() as Promise<Capture>;
})();

const APP = "https://app.example";
const SHOWN = { url: 300, errorText: 160, runtimeError: 200 };

interface Failure { url: string; errorText: string }

/* One failed test attempt: the page fails the given requests and logs the console errors, the capture runs, and the real reader reads the dump it wrote. */
async function dumpOf(opts: { failures?: Failure[]; consoleErrors?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "seed-memory-bound-"));
  const saved = { dir: process.env.QA_FAILURE_CAPTURE_DIR, base: process.env.PW_BASE_URL };
  process.env.QA_FAILURE_CAPTURE_DIR = dir;
  process.env.PW_BASE_URL = APP;
  try {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const page = {
      on: (event: string, fn: (arg: unknown) => void) => { (handlers[event] ??= []).push(fn); },
      url: () => `${APP}/orders`,
      locator: () => ({ ariaSnapshot: async () => "- main" }),
    };
    const { start, finish } = await capture;
    await start(page, {});
    for (const f of opts.failures ?? []) {
      const request = { url: () => f.url, resourceType: () => "fetch", method: () => "GET", failure: () => ({ errorText: f.errorText }) };
      for (const fn of handlers.requestfailed ?? []) fn(request);
    }
    for (const text of opts.consoleErrors ?? []) for (const fn of handlers.console ?? []) fn({ type: () => "error", text: () => text });
    await finish(page, { status: "failed", expectedStatus: "passed", titlePath: ["", "orders.spec.ts", "lists orders"], project: { name: "desktop" }, file: "/e2e/orders.spec.ts", retry: 0, testId: "t1", workerIndex: 0 });
    const [dump] = withRunSecrets(() => readFailureDumps(dir));
    return dump;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [["QA_FAILURE_CAPTURE_DIR", saved.dir], ["PW_BASE_URL", saved.base]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("the seed's memory bound is the one the orchestrator holds and covers the bounds it shows plus the redaction lookahead", () => {
  const seeded = /const QA_TEXT_MEMORY_BOUND_CHARS = (\d+);/.exec(SEED);
  assert.equal(Number(seeded?.[1]), PRODUCER_MEMORY_BOUND_CHARS);
  assert.ok(PRODUCER_MEMORY_BOUND_CHARS >= Math.max(...Object.values(SHOWN)) + REDACTION_LOOKAHEAD_CHARS);
});

/* What a path can hold: the run's secrets spelled as a URL carries them. */
const PATH_SECRETS = CASES.filter((c) => ["run secret, multi-word", "run secret, url spelling", "run secret, hex spelling"].includes(c.name));

for (const secret of PATH_SECRETS) {
  test(`a failed request's URL keeps no part of a ${secret.name} that straddles the bound it is shown at`, async () => {
    const dump = await dumpOf({ failures: [{ url: `${APP}/${filler(SHOWN.url - 40).replaceAll(" ", "-")}/${secret.text}/x`, errorText: "net::ERR_FAILED" }] });
    const url = dump?.networkErrors?.[0]?.url ?? "";
    assert.ok(url.length > 0 && url.length <= SHOWN.url);
    assert.deepEqual(leaks(url, secret), []);
  });
}

for (const secret of CASES) {
  test(`a failed request's error text keeps no part of a ${secret.name} that straddles the bound it is shown at`, async () => {
    const dump = await dumpOf({ failures: [{ url: `${APP}/api/orders`, errorText: `${filler(SHOWN.errorText - 12)} ${secret.text} while fetching` }] });
    const errorText = dump?.networkErrors?.[0]?.errorText ?? "";
    assert.ok(errorText.length > 0 && errorText.length <= SHOWN.errorText);
    assert.deepEqual(leaks(errorText, secret), []);
  });

  test(`a console error keeps no part of a ${secret.name} that straddles the bound it is shown at`, async () => {
    const dump = await dumpOf({ consoleErrors: [`${filler(SHOWN.runtimeError - 12)} ${secret.text} rejected by /api/session`] });
    const text = dump?.runtimeErrors?.[0]?.text ?? "";
    assert.ok(text.length > 0 && text.length <= SHOWN.runtimeError);
    assert.deepEqual(leaks(text, secret), []);
  });
}

test("two errors that differ only past the bound they are shown at are one error", async () => {
  const lead = filler(SHOWN.runtimeError + 50);
  const dump = await dumpOf({ consoleErrors: [`${lead} first`, `${lead} second`] });
  assert.equal(dump?.runtimeErrors?.length, 1);
});
