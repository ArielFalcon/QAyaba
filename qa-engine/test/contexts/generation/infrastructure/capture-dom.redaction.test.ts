/* The capture script runs where the run's secrets are not held, so it keeps the text of a page up to a memory bound and the orchestrator redacts it and only then cuts it to the bound it shows: a secret that straddles the bound the orchestrator shows is taken out whole. The real script runs against a stand-in browser and its output line is read by the real reader. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_LIMITS, buildCaptureScript, createCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { PRODUCER_MEMORY_BOUND_CHARS, REDACTION_LOOKAHEAD_CHARS } from "../../../../src/shared-kernel/redact-then-bound.ts";
import { sharedTestExec } from "../../../support/exec-sandbox-harness.ts";
import { CASES, filler, leaks, withRunSecrets } from "../../../support/straddling-secrets.ts";

const STUB_PLAYWRIGHT = fileURLToPath(new URL("./__fixtures__/stub-playwright.cjs", import.meta.url));
const LOCATION_STATE = { routes: { "/": { locationSelector: ".where", timeoutMs: 450 } } };
const SHOWN_LOCATION_CHARS = 200;

/* The line the real script writes for "/" on the page the stand-in browser describes. */
function scriptOutput(page: Record<string, unknown>, state?: unknown): string {
  const work = mkdtempSync(join(tmpdir(), "capture-redaction-"));
  try {
    writeFileSync(join(work, "capture.cjs"), buildCaptureScript(STUB_PLAYWRIGHT));
    const result = spawnSync("node", [join(work, "capture.cjs")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", PW_CAPTURE_INPUT: JSON.stringify({ baseUrl: "https://dev.example", routes: ["/"], limits: CAPTURE_LIMITS }), STUB_PAGE: JSON.stringify(page), ...(state ? { PW_CAPTURE_DATA_STATE: JSON.stringify(state) } : {}) },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* The orchestrator reads `line` as the capture's output, through a node that prints it. */
async function snapshotOf(line: string) {
  const root = mkdtempSync(join(tmpdir(), "capture-reader-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "print.cjs"), `process.stdout.write(${JSON.stringify(line)});`);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "print.cjs")}" "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? ""}`;
  try {
    const [snap] = await withRunSecrets(() => createCaptureDomDeps(sharedTestExec(), 20_000).render(root, "http://localhost", ["/"]));
    return snap;
  } finally {
    process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

test("the script hands the orchestrator a memory bound that holds the shown bound and the redaction lookahead", () => {
  assert.equal(CAPTURE_LIMITS.maxTextChars, PRODUCER_MEMORY_BOUND_CHARS);
  assert.ok(PRODUCER_MEMORY_BOUND_CHARS >= SHOWN_LOCATION_CHARS + REDACTION_LOOKAHEAD_CHARS);
});

for (const secret of CASES) {
  test(`the effective location keeps no part of a ${secret.name} that straddles the shown bound, whatever the script cut`, { timeout: 30_000 }, async () => {
    const text = `${filler(SHOWN_LOCATION_CHARS - 12)} ${secret.text} shown in the header`;
    const line = scriptOutput({ aria: "- text: x", text }, LOCATION_STATE);
    assert.ok(String(JSON.parse(line).effectiveLocation).length > SHOWN_LOCATION_CHARS, "the script keeps more than the shown bound");
    const snap = await snapshotOf(line);
    assert.deepEqual(leaks(snap?.effectiveLocation ?? "", secret), []);
    assert.ok((snap?.effectiveLocation ?? "").length <= SHOWN_LOCATION_CHARS);
  });

  test(`the reason a route could not be read keeps no part of a ${secret.name} that straddles the shown bound`, { timeout: 30_000 }, async () => {
    const line = scriptOutput({ gotoError: `${filler(SHOWN_LOCATION_CHARS - 12)} ${secret.text} while opening the page` });
    assert.ok(String(JSON.parse(line).error).length > SHOWN_LOCATION_CHARS);
    const snap = await snapshotOf(line);
    assert.ok(snap?.error);
    assert.deepEqual(leaks(snap.error, secret), []);
  });
}

test("a location is still captured in full when it is shorter than the shown bound", { timeout: 30_000 }, async () => {
  const snap = await snapshotOf(scriptOutput({ aria: "- text: x", text: "Madrid  centre" }, LOCATION_STATE));
  assert.equal(snap?.effectiveLocation, "Madrid centre");
});
