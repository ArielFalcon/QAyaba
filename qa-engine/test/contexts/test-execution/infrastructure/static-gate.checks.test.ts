/* Behavioral tests for the static gate (e2e checks + code-mode compile gate + manifest-entry
   validation). The zero-assertion tests below exercise the real, non-stubbed zero-assertion
   scan (checkZeroAssertionSpecs is baked into validateSpecs itself, never injectable) against
   real temp-dir fixtures — a no-op validateAll wiring that would pass every stub test must not
   pass a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSpecs,
  type ValidateDeps,
  runCheck,
  CHECK_OUTPUT_KEEP_CHARS,
  defaultValidateDeps,
  validateManifest,
  compileCommand,
  isToolchainFailure,
  validateCodeProject,
  type CodeValidateDeps,
} from "@contexts/test-execution/infrastructure/static-gate.checks.ts";
import type { CheckResult } from "@contexts/test-execution/application/ports/index.ts";
import type { CodeProject } from "@contexts/test-execution/infrastructure/code-execution.runner.ts";

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   Part 1 — validateSpecs / runCheck / checkManifest (moved from src/qa/validate.test.ts)
   ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const ok = async () => ({ ok: true, output: "" });

test("ok when the four checks pass", async () => {
  const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("accumulates ALL failures (does not stop at the first) with their label", async () => {
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "TS2322 type error" }),
    lint: ok,
    listTests: async () => ({ ok: false, output: "no spec files found" }),
    checkManifest: ok,
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0]!, /\[typecheck\] TS2322/);
  assert.match(res.errors[1]!, /\[list\] no spec files/);
});

test("infra failures (spawn ENOENT, signal-kill) are flagged separately from real lint errors", async () => {
  /* The typecheck check failed because tsc is missing (ENOENT) — infrastructure, NOT bad code.
     The lint check found a real error — code quality.
   */
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "Error: spawn tsc ENOENT", infra: true }),
    lint: async () => ({ ok: false, output: "expect-expect: Test has no assertions" }),
    listTests: async () => ({ ok: true, output: "" }),
    checkManifest: async () => ({ ok: true, output: "" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  /* There are non-infra errors → not a pure infra failure. */
  assert.equal(res.infra, false); /* lint error makes it a real validation failure */
});

test("a pure-infra validation failure is flagged as infra, not invalid", async () => {
  /* ALL checks failed with infrastructure errors (e.g. npx not installed, ENOMEM). */
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "spawn npx ENOENT", infra: true }),
    lint: async () => ({ ok: false, output: "spawn npx ENOENT", infra: true }),
    listTests: async () => ({ ok: false, output: "spawn npx ENOENT", infra: true }),
    checkManifest: async () => ({ ok: true, output: "" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  /* Pure infra: the gate itself couldn't run. Should be infra-error, not invalid. */
  assert.equal(res.infra, true);
});

test("invalid metadata makes the run invalid", async () => {
  const deps: ValidateDeps = {
    typecheck: ok,
    lint: ok,
    listTests: ok,
    checkManifest: async () => ({ ok: false, output: "'login': missing 'objective'" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.match(res.errors[0]!, /\[manifest\].*objective/);
});

test("runCheck kills a hung check on timeout and classifies it as INFRA", async () => {
  const res = await runCheck(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), 100);
  assert.equal(res.ok, false);
  assert.equal(res.infra, true); /* a wedged child is infrastructure, not a code defect */
  assert.match(res.output, /timed out after 100ms — killed/);
});

test("runCheck resolves ok on a clean exit and captures output", async () => {
  const res = await runCheck(process.execPath, ["-e", "console.log('all good')"], process.cwd());
  assert.equal(res.ok, true);
  assert.match(res.output, /all good/);
  assert.equal(res.infra, undefined);
});

test("runCheck flags a non-zero exit as a CODE failure, not infra", async () => {
  const res = await runCheck(process.execPath, ["-e", "console.error('TS2322'); process.exit(2)"], process.cwd());
  assert.equal(res.ok, false);
  assert.equal(res.infra, undefined); /* the tool ran and judged the code */
  assert.match(res.output, /TS2322/);
});

test("runCheck keeps only the newest output of a check that writes megabytes, and still judges its exit", { timeout: 30_000 }, async () => {
  /* A check runs code the agent wrote (tsc/eslint config, `playwright --list` imports every spec), so its output is untrusted and unbounded. */
  const script =
    "const line = 'check output line that repeats\\n'.repeat(1000); let n = 0;" +
    "(function go() { if (n++ < 300) return process.stdout.write(line, go); process.stderr.write('THE-END\\n'); process.exitCode = 2; })();";
  const res = await runCheck(process.execPath, ["-e", script], process.cwd());
  assert.equal(res.ok, false, "the exit status is still judged");
  assert.equal(res.infra, undefined);
  assert.match(res.output, /THE-END/, "the newest output is kept");
  assert.ok(res.output.length < CHECK_OUTPUT_KEEP_CHARS + 500, `the kept output stays bounded (was ${res.output.length} chars)`);
});

test("runCheck flags a missing binary (ENOENT) as INFRA", async () => {
  const res = await runCheck("/definitely/not/a/binary-qa-xyz", [], process.cwd(), 5_000);
  assert.equal(res.ok, false);
  assert.equal(res.infra, true);
});

test("a timed-out check routes through validateSpecs as pure infra", async () => {
  /* The shape runCheck produces on timeout, fed through the aggregation: the run
     must surface as infra-error (gate couldn't run), never `invalid`.
   */
  const timedOut = async () => ({ ok: false, output: "npx tsc --noEmit timed out after 300000ms — killed", infra: true });
  const deps: ValidateDeps = { typecheck: timedOut, lint: ok, listTests: ok, checkManifest: ok };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.equal(res.infra, true);
});

import { readFileSync as _readFileSync, writeFileSync as _writeFileSync, mkdtempSync as _mkdtempSync, mkdirSync as _mkdirSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";

function makeTmpSpecDir(specContent: string): string {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-b2-"));
  _mkdirSync(_join(dir, "flows"));
  _writeFileSync(_join(dir, "flows", "login.spec.ts"), specContent);
  return dir;
}

test("RED: a spec file with NO expect() call is flagged as a zero-assertion error", async () => {
  const specDir = makeTmpSpecDir([
    `import { test } from "@playwright/test";`,
    `test("login loads", async ({ page }) => {`,
    `  await page.goto("/login");`,
    `  await page.click("button[type=submit]");`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, false, "zero-assertion spec must produce a validation failure");
    assert.ok(res.errors.some((e) => /zero.assertion|no.*expect|login\.spec\.ts/i.test(e)),
      `expected a zero-assertion error; got: ${JSON.stringify(res.errors)}`);
    /* Must NOT be classified as infra — this is a code quality issue, not a tool failure. */
    assert.equal(res.infra, false);
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("GREEN: a spec file with at least one expect() passes the zero-assertion check", async () => {
  const specDir = makeTmpSpecDir([
    `import { test, expect } from "@playwright/test";`,
    `test("login succeeds", async ({ page }) => {`,
    `  await page.goto("/login");`,
    `  await expect(page).toHaveURL("/dashboard");`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, true, "spec with expect() must pass the zero-assertion check");
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("await expect() and expect.soft() both count as assertions", async () => {
  const specDir = makeTmpSpecDir([
    `import { test, expect } from "@playwright/test";`,
    `test("soft assertion", async ({ page }) => {`,
    `  await page.goto("/");`,
    `  await expect.soft(page.locator("h1")).toBeVisible();`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, true, "expect.soft() must count as an assertion");
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("a spec asserting ONLY via expect.poll() is NOT flagged (regression — poll is a real assertion)", async () => {
  const specDir = makeTmpSpecDir([
    `import { test, expect } from "@playwright/test";`,
    `test("eventually consistent", async ({ page }) => {`,
    `  await page.goto("/");`,
    `  await expect.poll(() => page.locator(".count").count()).toBeGreaterThan(0);`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, true, "expect.poll() must count as an assertion (not a zero-assertion false-flag)");
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("a zero-assertion spec at the e2e ROOT (the cleanup seed) is NOT flagged — only flows/ is checked", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-b2-seed-"));
  try {
    /* The seed cleanup.spec.ts sits at the e2e ROOT and has no expect() by design (skip-guarded). */
    _writeFileSync(_join(dir, "cleanup.spec.ts"), `import { test } from "@playwright/test";\ntest.skip("cleanup", async () => {});\n`);
    _mkdirSync(_join(dir, "flows"));
    _writeFileSync(_join(dir, "flows", "login.spec.ts"), `import { test, expect } from "@playwright/test";\ntest("login", async ({ page }) => { await expect(page).toHaveURL("/"); });\n`);
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(dir, deps);
    assert.equal(res.ok, true, "the assertion-free seed spec at the e2e root must NOT be flagged");
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("a zero-assertion GENERATED spec under flows/ IS flagged", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-b2-flows-"));
  try {
    _mkdirSync(_join(dir, "flows"));
    _writeFileSync(_join(dir, "flows", "trivial.spec.ts"), `import { test } from "@playwright/test";\ntest("trivial", async ({ page }) => { await page.goto("/"); });\n`);
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(dir, deps);
    assert.equal(res.ok, false, "a generated spec under flows/ with no expect must be flagged");
    assert.ok(res.errors.some((e) => /zero.assertion|trivial\.spec\.ts/i.test(e)), `expected a zero-assertion error; got ${JSON.stringify(res.errors)}`);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

/* generation's manifest-fs.ts::readManifest (fail-open-to-[]). This pins the byte-matching strict-
   read behavior against the REAL defaultValidateDeps implementation (not a stub), with real fs
 */
test("defaultValidateDeps.checkManifest: a MISSING manifest.json is ok:false (never a fail-open pass)", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-missing-"));
  try {
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, false);
    assert.match(res.output, /unreadable or missing/);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("defaultValidateDeps.checkManifest: a CORRUPT (non-JSON) manifest.json is ok:false", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-corrupt-"));
  try {
    _mkdirSync(_join(dir, ".qa"));
    _writeFileSync(_join(dir, ".qa", "manifest.json"), "{ not valid json ][");
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, false);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("defaultValidateDeps.checkManifest: a well-formed manifest.json is ok:true (byte-matching today)", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-ok-"));
  try {
    _mkdirSync(_join(dir, ".qa"));
    const entry = {
      id: "checkout", objective: "o", flow: "checkout",
      targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" },
    };
    _writeFileSync(_join(dir, ".qa", "manifest.json"), JSON.stringify([entry]));
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, true);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("defaultValidateDeps.checkManifest: an entry with criticality:\"urgent\" (not in the enum) is ok:false — write-time and read-time now share the SAME canonical validator", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-enum-"));
  try {
    _mkdirSync(_join(dir, ".qa"));
    const entry = {
      id: "checkout", objective: "o", flow: "checkout",
      targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" },
      criticality: "urgent",
    };
    _writeFileSync(_join(dir, ".qa", "manifest.json"), JSON.stringify([entry]));
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, false);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

/* The manifest is in a directory the agent writes into, and what this check says about it goes back to the agent as validation feedback. Read through a symlink the agent planted, it would hand the agent the first characters of any file the orchestrator can read, in the parse error. A link or a pipe at the manifest or at `.qa` is a refusal that names no content. */
import { chmodSync as _chmodSync, symlinkSync as _symlinkSync, existsSync as _existsSync } from "node:fs";
import { execFileSync as _execFileSync } from "node:child_process";
import { MAX_MANIFEST_BYTES as _MAX_MANIFEST_BYTES } from "@kernel/manifest/manifest-entry.ts";
import { MAX_SPEC_SOURCE_BYTES as _MAX_SPEC_SOURCE_BYTES } from "../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe as _withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

/* A refusal says why: something follows the label. */
const REASONED = /unreadable or missing: \S/;

const SECRET_TEXT = "API_KEY=hunter2-not-json";
const VALID_MANIFEST = JSON.stringify([{ id: "checkout", objective: "o", flow: "checkout", targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" } }]);

function withManifestDir(run: (dir: string, outside: string) => Promise<void>): Promise<void> {
  const tmp = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-planted-"));
  const dir = _join(tmp, "e2e");
  const outside = _join(tmp, "outside");
  _mkdirSync(dir);
  _mkdirSync(outside);
  _writeFileSync(_join(outside, "secret.env"), SECRET_TEXT);
  _writeFileSync(_join(outside, "valid.json"), VALID_MANIFEST);
  return run(dir, outside).finally(() => _rmSync(tmp, { recursive: true, force: true }));
}

test("defaultValidateDeps.checkManifest: a manifest.json that is a symlink is ok:false and its output never carries what the link points at, whatever that is", async () => {
  await withManifestDir(async (dir, outside) => {
    _mkdirSync(_join(dir, ".qa"));
    for (const target of ["secret.env", "valid.json"]) {
      _symlinkSync(_join(outside, target), _join(dir, ".qa", "manifest.json"));
      const res = await defaultValidateDeps.checkManifest(dir);
      assert.equal(res.ok, false, `${target}: even a valid manifest behind a link is not read`);
      assert.doesNotMatch(res.output, /API_KEY|hunter2/, `${target}: nothing of the target in the output`);
      assert.match(res.output, REASONED);
      _rmSync(_join(dir, ".qa", "manifest.json"));
    }
  });
});

test("defaultValidateDeps.checkManifest: a .qa directory that is a symlink is ok:false, though the manifest behind it is valid", async () => {
  await withManifestDir(async (dir, outside) => {
    _mkdirSync(_join(outside, "qa"));
    _writeFileSync(_join(outside, "qa", "manifest.json"), VALID_MANIFEST);
    _symlinkSync(_join(outside, "qa"), _join(dir, ".qa"));

    const res = await defaultValidateDeps.checkManifest(dir);

    assert.equal(res.ok, false);
    assert.match(res.output, REASONED);
  });
});

test("defaultValidateDeps.checkManifest: a manifest.json that is a directory, or a .qa that is a regular file, is ok:false and says why", async () => {
  await withManifestDir(async (dir) => {
    _mkdirSync(_join(dir, ".qa", "manifest.json"), { recursive: true });
    const asDirectory = await defaultValidateDeps.checkManifest(dir);
    _rmSync(_join(dir, ".qa"), { recursive: true });
    _writeFileSync(_join(dir, ".qa"), "not a directory");
    const asFile = await defaultValidateDeps.checkManifest(dir);

    for (const res of [asDirectory, asFile]) {
      assert.equal(res.ok, false);
      assert.match(res.output, REASONED);
    }
  });
});

/* The pipe is watched: a check that opened it would wait for a writer for ever, and a test cannot time out a thread that is stuck, so the watch releases it and the test fails there instead. */
test("defaultValidateDeps.checkManifest: a manifest.json that is a named pipe is ok:false, and the check does not wait on it", async (t) => {
  const probe = _mkdtempSync(_join(_tmpdir(), "qa-validate-fifo-probe-"));
  try {
    _execFileSync("mkfifo", [_join(probe, "p")]);
  } catch {
    t.skip("mkfifo is not available on this platform, so the named-pipe case is not exercised");
    return;
  } finally {
    _rmSync(probe, { recursive: true, force: true });
  }
  await withManifestDir(async (dir) => {
    _mkdirSync(_join(dir, ".qa"));
    _execFileSync("mkfifo", [_join(dir, ".qa", "manifest.json")]);

    const res = await _withoutWaitingOnNamedPipe(_join(dir, ".qa", "manifest.json"), () => defaultValidateDeps.checkManifest(dir));

    assert.equal(res.ok, false);
    assert.match(res.output, REASONED);
  });
});

test("defaultValidateDeps.checkManifest: a manifest larger than the cap is ok:false, and one of exactly the cap is read", async () => {
  await withManifestDir(async (dir) => {
    _mkdirSync(_join(dir, ".qa"));
    const entry = { id: "checkout", objective: "o", flow: "checkout", targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" }, owner: "" };
    const text = JSON.stringify([entry]);
    const padded = (bytes: number): string => text.replace('"owner":""', `"owner":"${"x".repeat(bytes - text.length)}"`);

    _writeFileSync(_join(dir, ".qa", "manifest.json"), padded(_MAX_MANIFEST_BYTES + 1));
    assert.equal((await defaultValidateDeps.checkManifest(dir)).ok, false, "one byte over");
    _writeFileSync(_join(dir, ".qa", "manifest.json"), padded(_MAX_MANIFEST_BYTES));
    assert.equal((await defaultValidateDeps.checkManifest(dir)).ok, true, "exactly the cap");
  });
});

test("defaultValidateDeps.checkManifest: a missing .qa directory is ok:false with no content in the output, and nothing is created", async () => {
  await withManifestDir(async (dir) => {
    const res = await defaultValidateDeps.checkManifest(dir);

    assert.equal(res.ok, false);
    assert.match(res.output, REASONED);
    assert.equal(_existsSync(_join(dir, ".qa")), false);
  });
});

test("defaultValidateDeps.checkManifest: a manifest with several violations reports each on a line of its own", async () => {
  await withManifestDir(async (dir) => {
    _mkdirSync(_join(dir, ".qa"));
    const entry = { id: "checkout", objective: "o", flow: "checkout", targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" } };
    _writeFileSync(_join(dir, ".qa", "manifest.json"), JSON.stringify([{ ...entry, objective: "" }, { ...entry, id: "other", flow: "" }]));

    const res = await defaultValidateDeps.checkManifest(dir);

    assert.equal(res.ok, false);
    assert.equal(res.output.split("\n").length, 2, "one violation per line");
    assert.ok(res.output.split("\n").every((line) => line.length > 0));
  });
});

/* ── the zero-assertion scan reads what the agent wrote under flows/ ───────────────────────────────
   The scan runs in the orchestrator itself, synchronously, over files the agent controls. A link it followed handed it a file of
   the agent's choosing, a named pipe held the whole orchestrator, a link to a device or to a directory above it was read or walked
   without end. It reads through the confined reader and walks without following a link; a spec it cannot vouch for is a finding of
   its own, never skipped and never taken for fine: the gate is fail-closed, the agent can fix it, and a spec that was not checked
   must not go on to be run. */

const CHECKS_PASS: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
const SPEC_WITH_EXPECT = `import { test, expect } from "@playwright/test";\ntest("t", async ({ page }) => { await expect(page).toHaveURL("/"); });\n`;
const SPEC_WITHOUT_EXPECT = `import { test } from "@playwright/test";\ntest("t", async ({ page }) => { await page.goto("/"); });\n`;
const SECRET_MARK = "TOPSECRET-TOKEN-1f3a";

/* The finding about flows/ itself: it names the directory and says why, with something after the colon. */
const FLOWS_FINDING = /\[zero-assertions\] flows: \S/;

/* <tmp>/e2e/flows is where the specs are; <tmp>/outside is what the scan must not read or walk. */
function withFlows(run: (e2e: string, flows: string, outside: string) => Promise<void>): Promise<void> {
  const tmp = _mkdtempSync(_join(_tmpdir(), "qa-validate-flows-"));
  const e2e = _join(tmp, "e2e");
  const flows = _join(e2e, "flows");
  const outside = _join(tmp, "outside");
  _mkdirSync(flows, { recursive: true });
  _mkdirSync(outside);
  return run(e2e, flows, outside).finally(() => _rmSync(tmp, { recursive: true, force: true }));
}

const NO_NAMED_PIPES_FOR_SCAN = (() => {
  const probe = _mkdtempSync(_join(_tmpdir(), "qa-validate-flows-fifo-probe-"));
  try {
    _execFileSync("mkfifo", [_join(probe, "p")]);
    return false as const;
  } catch {
    return "mkfifo is not available on this platform, so the named-pipe case is not exercised";
  } finally {
    _rmSync(probe, { recursive: true, force: true });
  }
})();

/* A directory whose mode is 000 cannot be searched by an account that the mode binds: not by root, and not on a platform without modes. */
const NO_MODE_RESTRICTIONS_FOR_SCAN = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the case that relies on them is not exercised" : false;

test("a spec that is a symlink to a file outside the spec directory is a finding, though what it points at has assertions, and nothing of it is quoted", async () => {
  await withFlows(async (e2e, flows, outside) => {
    _writeFileSync(_join(outside, "leak.ts"), `${SPEC_WITH_EXPECT}// ${SECRET_MARK}\n`);
    _symlinkSync(_join(outside, "leak.ts"), _join(flows, "linked.spec.ts"));

    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false, "a spec that leaves the spec directory is not vouched for");
    assert.equal(res.infra, false, "the agent can fix it, so it is not an infrastructure failure");
    assert.ok(res.errors.some((e) => e.includes("linked.spec.ts")), `the finding names the spec: ${JSON.stringify(res.errors)}`);
    assert.ok(!res.errors.join("\n").includes(SECRET_MARK), "no content of what the link points at is quoted back");
  });
});

test("a spec that is a named pipe is a finding, and the scan does not wait on it", { skip: NO_NAMED_PIPES_FOR_SCAN }, async () => {
  await withFlows(async (e2e, flows) => {
    _execFileSync("mkfifo", [_join(flows, "pipe.spec.ts")]);

    const res = await _withoutWaitingOnNamedPipe(_join(flows, "pipe.spec.ts"), () => validateSpecs(e2e, CHECKS_PASS));

    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("pipe.spec.ts")), `the finding names the spec: ${JSON.stringify(res.errors)}`);
  });
});

test("a spec that cannot be read is a finding, not skipped", { skip: NO_MODE_RESTRICTIONS_FOR_SCAN }, async () => {
  await withFlows(async (e2e, flows) => {
    _writeFileSync(_join(flows, "locked.spec.ts"), SPEC_WITH_EXPECT);
    _chmodSync(_join(flows, "locked.spec.ts"), 0o000);
    try {
      const res = await validateSpecs(e2e, CHECKS_PASS);

      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes("locked.spec.ts") && e.includes("EACCES")), `the finding names the spec and the failure's code: ${JSON.stringify(res.errors)}`);
    } finally {
      _chmodSync(_join(flows, "locked.spec.ts"), 0o644);
    }
  });
});

test("a flows/ that cannot be examined is a finding, not a directory with nothing in it", { skip: NO_MODE_RESTRICTIONS_FOR_SCAN }, async () => {
  await withFlows(async (e2e, flows) => {
    _writeFileSync(_join(flows, "ok.spec.ts"), SPEC_WITH_EXPECT);
    _chmodSync(e2e, 0o000);
    try {
      const res = await validateSpecs(e2e, CHECKS_PASS);

      assert.equal(res.ok, false);
      assert.equal(res.infra, false);
      assert.ok(res.errors.some((e) => FLOWS_FINDING.test(e)), JSON.stringify(res.errors));
    } finally {
      _chmodSync(e2e, 0o755);
    }
  });
});

test("a spec larger than the cap is a finding, though it has assertions, and one of exactly the cap is checked", async () => {
  await withFlows(async (e2e, flows) => {
    const padded = (bytes: number): string => SPEC_WITH_EXPECT + `// ${"x".repeat(bytes - SPEC_WITH_EXPECT.length - 4)}\n`;
    _writeFileSync(_join(flows, "exact.spec.ts"), padded(_MAX_SPEC_SOURCE_BYTES));
    assert.equal((await validateSpecs(e2e, CHECKS_PASS)).ok, true, "exactly the cap is read and has its assertion");

    _writeFileSync(_join(flows, "big.spec.ts"), padded(_MAX_SPEC_SOURCE_BYTES + 1));
    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("big.spec.ts")), `the finding names the spec: ${JSON.stringify(res.errors)}`);
    assert.ok(!res.errors.some((e) => e.includes("exact.spec.ts")), "the one of exactly the cap is not a finding");
  });
});

test("a link back up to an ancestor is not walked: a spec without assertions is flagged once, not once per level", async () => {
  await withFlows(async (e2e, flows) => {
    _writeFileSync(_join(flows, "trivial.spec.ts"), SPEC_WITHOUT_EXPECT);
    _symlinkSync(e2e, _join(flows, "up"));

    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.errors.filter((e) => e.includes("trivial.spec.ts")).length, 1);
  });
});

test("a directory link inside flows/ is not walked, so what it leads to is neither read nor listed", async () => {
  await withFlows(async (e2e, flows, outside) => {
    _writeFileSync(_join(outside, "elsewhere.spec.ts"), SPEC_WITHOUT_EXPECT);
    _symlinkSync(outside, _join(flows, "hop"));
    _writeFileSync(_join(flows, "fine.spec.ts"), SPEC_WITH_EXPECT);

    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
  });
});

test("a flows/ that is a symlink is a finding, and nothing behind it is scanned or trusted", async () => {
  await withFlows(async (e2e, flows, outside) => {
    _rmSync(flows, { recursive: true });
    _mkdirSync(_join(outside, "flows-real"));
    _writeFileSync(_join(outside, "flows-real", "good.spec.ts"), SPEC_WITH_EXPECT);
    _symlinkSync(_join(outside, "flows-real"), flows);

    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false);
    assert.equal(res.infra, false);
    assert.ok(res.errors.some((e) => FLOWS_FINDING.test(e)), `the finding names flows/ and says why: ${JSON.stringify(res.errors)}`);
  });
});

test("a flows/ that is a regular file is a finding", async () => {
  await withFlows(async (e2e, flows) => {
    _rmSync(flows, { recursive: true });
    _writeFileSync(flows, "not a directory");

    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => FLOWS_FINDING.test(e)), JSON.stringify(res.errors));
  });
});

test("a spec directory with no flows/ has nothing to scan", async () => {
  await withFlows(async (e2e, flows) => {
    _rmSync(flows, { recursive: true });

    assert.equal((await validateSpecs(e2e, CHECKS_PASS)).ok, true);
  });
});

test("an assertion is a call of expect: one written with whitespace before its parenthesis counts, and a spec that only imports or names expect does not", async () => {
  await withFlows(async (e2e, flows) => {
    _writeFileSync(_join(flows, "spaced.spec.ts"), `import { test, expect } from "@playwright/test";\ntest("t", async ({ page }) => { await expect (page).toHaveURL("/"); await expect\n  .soft(page).toHaveURL("/"); });\n`);
    assert.equal((await validateSpecs(e2e, CHECKS_PASS)).ok, true, "expect (page) and expect\\n.soft(page) are assertions");

    _writeFileSync(_join(flows, "imports-only.spec.ts"), `import { test, expect } from "@playwright/test";\n// the expected page is the home page\ntest("t", async ({ page }) => { await page.goto("/"); });\n`);
    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false);
    assert.equal(res.errors.filter((e) => e.includes("imports-only.spec.ts")).length, 1, "importing expect, or the word expected, is not an assertion");
  });
});

test("a link to a spec inside the spec directory is judged by what it points at", async () => {
  await withFlows(async (e2e, flows) => {
    _writeFileSync(_join(flows, "real.spec.ts"), SPEC_WITH_EXPECT);
    _symlinkSync("real.spec.ts", _join(flows, "alias.spec.ts"));
    assert.equal((await validateSpecs(e2e, CHECKS_PASS)).ok, true, "the link to a spec with assertions passes");

    _writeFileSync(_join(flows, "real.spec.ts"), SPEC_WITHOUT_EXPECT);
    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("alias.spec.ts")), "the link to a spec without assertions is flagged under its own name");
  });
});

test("every spec of flows/ is judged on its own: each one that cannot be vouched for is named, and the good ones are not", async () => {
  await withFlows(async (e2e, flows, outside) => {
    _mkdirSync(_join(flows, "nested"));
    _writeFileSync(_join(flows, "good.spec.ts"), SPEC_WITH_EXPECT);
    _writeFileSync(_join(flows, "bad.spec.ts"), SPEC_WITHOUT_EXPECT);
    _writeFileSync(_join(flows, "nested", "deep.spec.ts"), SPEC_WITHOUT_EXPECT);
    _writeFileSync(_join(outside, "leak.ts"), SPEC_WITH_EXPECT);
    _symlinkSync(_join(outside, "leak.ts"), _join(flows, "linked.spec.ts"));

    const res = await validateSpecs(e2e, CHECKS_PASS);

    assert.equal(res.ok, false);
    for (const named of ["bad.spec.ts", "deep.spec.ts", "linked.spec.ts"]) {
      assert.equal(res.errors.filter((e) => e.includes(named)).length, 1, `${named} is named once: ${JSON.stringify(res.errors)}`);
    }
    assert.ok(!res.errors.some((e) => e.includes("good.spec.ts")));
    const linked = res.errors.find((e) => e.includes("linked.spec.ts"))!;
    assert.match(linked, /\([^)]{3,}\)/, "a spec that cannot be checked is said with its reason, in words of the gate's own");
    assert.ok(!linked.includes("undefined"), linked);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   Part 2 — validateManifest (moved from src/qa/metadata.test.ts)
   ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const validManifestEntry = {
  id: "checkout/over-10-items",
  objective: "With >10 items, checkout completes the payment",
  flow: "checkout",
  targets: ["CheckoutService.validateCart"],
  changeRef: { sha: "abc1234", type: "fix" },
};

test("an empty manifest is valid (repo with no tests yet)", () => {
  assert.equal(validateManifest([]).ok, true);
});

test("a complete entry is valid", () => {
  assert.equal(validateManifest([validManifestEntry]).ok, true);
});

test("rejects a non-array", () => {
  assert.equal(validateManifest({}).ok, false);
});

test("requires objective, flow, targets and changeRef", () => {
  const r = validateManifest([{ id: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /objective/);
  assert.match(r.errors.join(" "), /flow/);
  assert.match(r.errors.join(" "), /targets/);
  assert.match(r.errors.join(" "), /changeRef/);
});

test("detects duplicate ids", () => {
  const r = validateManifest([validManifestEntry, validManifestEntry]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /duplicate id/);
});

test("empty targets is not allowed", () => {
  const r = validateManifest([{ ...validManifestEntry, targets: [] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /targets/);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   Part 3 — compileCommand / isToolchainFailure / validateCodeProject (moved from
   src/qa/code-validate.test.ts)
   ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const maven: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
const gradle: CodeProject = { ecosystem: "gradle", install: null, test: { cmd: "./gradlew", args: ["test"] } };
const go: CodeProject = { ecosystem: "go", install: null, test: { cmd: "go", args: ["test", "./..."] } };
const rust: CodeProject = { ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } };
const node: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
const python: CodeProject = { ecosystem: "python", install: null, test: { cmd: "python3", args: ["-m", "pytest"] } };

/* ── compileCommand: compiles TEST sources without running them, scoped when possible ────────────── */
test("compileCommand: maven test-compile, scoped to the changed module when it resolves", () => {
  const exists = (p: string) => p === "/repo/customers-service/pom.xml" || p === "/repo/pom.xml";
  assert.deepEqual(compileCommand(maven, "/repo", ["customers-service/src/main/java/X.java"], { exists }), {
    cmd: "mvn",
    args: ["-B", "-pl", "customers-service", "-am", "test-compile"],
  });
});

test("compileCommand: maven whole-reactor test-compile when nothing scopes", () => {
  assert.deepEqual(compileCommand(maven, "/repo", [], { exists: () => true }), { cmd: "mvn", args: ["-B", "test-compile"] });
});

test("compileCommand: gradle testClasses", () => {
  assert.deepEqual(compileCommand(gradle, "/repo", [], { exists: () => false }), { cmd: "./gradlew", args: ["testClasses"] });
});

test("compileCommand: go vet (compiles _test.go which go build skips), rust cargo check --tests", () => {
  assert.deepEqual(compileCommand(go, "/repo", [], { exists: () => false }), { cmd: "go", args: ["vet", "./..."] });
  assert.deepEqual(compileCommand(rust, "/repo", [], { exists: () => false }), { cmd: "cargo", args: ["check", "--tests"] });
});

test("compileCommand: node tsc --noEmit only with a tsconfig; plain JS has no compile step", () => {
  assert.deepEqual(compileCommand(node, "/repo", [], { exists: (p) => p === "/repo/tsconfig.json" }), { cmd: "npx", args: ["tsc", "--noEmit"] });
  assert.equal(compileCommand(node, "/repo", [], { exists: () => false }), null);
});

test("compileCommand: unknown ecosystem has no compile gate (null)", () => {
  const unknown: CodeProject = { ecosystem: "unknown", install: null, test: { cmd: "npm", args: ["test"] } };
  assert.equal(compileCommand(unknown, "/repo", ["x.py"], { exists: () => true }), null);
});

test("compileCommand: python byte-compiles the changed .py files (syntax gate); none → null", () => {
  assert.deepEqual(compileCommand(python, "/repo", ["pkg/test_owner.py", "README.md"], { exists: () => true }), {
    cmd: "python3",
    args: ["-m", "compileall", "-q", "pkg/test_owner.py"],
  });
  assert.equal(compileCommand(python, "/repo", ["README.md"], { exists: () => true }), null);
  assert.equal(compileCommand(python, "/repo", [], { exists: () => true }), null);
});

/* ── isToolchainFailure: a broken JVM toolchain is infra, not a code defect ───────────────────────── */
test("isToolchainFailure: matches the REAL JDK/JAVA_HOME misconfig messages, not a normal compile error", () => {
  assert.equal(isToolchainFailure("Error: JAVA_HOME is not set and could not be found."), true);
  assert.equal(isToolchainFailure("The JAVA_HOME environment variable is not correctly set"), true);
  assert.equal(isToolchainFailure("No compiler is provided in this environment. Perhaps you are running on a JRE rather than a JDK?"), true);
  assert.equal(isToolchainFailure("[ERROR] /src/X.java:[12,5] cannot find symbol"), false);
});

/* ── validateCodeProject: the orchestration (runCheck injected) ───────────────────────────────────── */
function deps(project: CodeProject, result: CheckResult, onRun?: () => void): CodeValidateDeps {
  return {
    detect: () => project,
    runCheck: async () => {
      onRun?.();
      return result;
    },
  };
}

test("validateCodeProject: a clean compile is ok with no errors", async () => {
  const r = await validateCodeProject("/repo", deps(maven, { ok: true, output: "BUILD SUCCESS" }), {});
  assert.deepEqual(r, { ok: true, errors: [], infra: false });
});

test("validateCodeProject: a real compile error is invalid (not infra), with the error fed back", async () => {
  const r = await validateCodeProject("/repo", deps(maven, { ok: false, output: "[ERROR] cannot find symbol method map()" }), {});
  assert.equal(r.ok, false);
  assert.equal(r.infra, false);
  assert.match(r.errors[0]!, /compile/);
  assert.match(r.errors[0]!, /cannot find symbol/);
});

test("validateCodeProject: a missing/broken toolchain is infra, never blamed on the agent", async () => {
  const enoent = await validateCodeProject("/repo", deps(maven, { ok: false, output: "spawn mvn ENOENT", infra: true }), {});
  assert.equal(enoent.infra, true);
  const jdk = await validateCodeProject("/repo", deps(maven, { ok: false, output: "Error: JAVA_HOME is not set and could not be found." }), {});
  assert.equal(jdk.infra, true);
});

test("validateCodeProject: interpreted ecosystems are a no-op — the gate never spawns", async () => {
  let ran = false;
  const r = await validateCodeProject("/repo", deps(python, { ok: false, output: "x" }, () => (ran = true)), {});
  assert.deepEqual(r, { ok: true, errors: [], infra: false });
  assert.equal(ran, false);
});

test("validateCodeProject: secrets in the compile output are sanitized before the agent sees them", async () => {
  const r = await validateCodeProject("/repo", deps(maven, { ok: false, output: "aws.key=AKIAIOSFODNN7EXAMPLE [ERROR] boom" }), {});
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.errors[0]!, /AKIAIOSFODNN7EXAMPLE/);
});
