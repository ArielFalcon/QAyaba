/* The text of the specs a run held at validation: kept per run, redacted, capped, through the confined reader, and never in the way of the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scanSpecTree } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";
import { SpecSnapshotValidationPort } from "../../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/spec-snapshot-validation.adapter";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-infrastructure/run-secret-redaction";
import { MAX_SPEC_SNAPSHOT_BYTES_PER_RUN, MAX_SPEC_SNAPSHOT_TEXT_BYTES, type SpecSnapshot, type SpecSnapshotPort } from "@kernel/ports/spec-snapshot.port";
import type { ValidationPort } from "../../qa-engine/src/contexts/qa-run-orchestration/application/ports/index";
import { SqliteSpecSnapshotAdapter } from "./spec-snapshot-sqlite.adapter";
import { listSpecSnapshots, pruneSpecSnapshots, commitSpecSnapshots } from "./history";

const SECRET = "s3cr3t-account-pass-value";
const RESULT = { ok: false, errors: ["[lint] nope"], infra: false };
const inner: ValidationPort = { validate: async () => RESULT };

function scopeFor(runId: string): RunScope {
  return { runId, workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport() };
}

function suite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-snap-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/* Every spec of the directory is reported as delivered unless the test says which are. */
function validateIn(dir: string, runId: string, port: SpecSnapshotPort, sanitize: (t: string) => string = (t) => t, delivered?: string[], adapterOf?: SpecSnapshotValidationPort) {
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets([SECRET]);
  const adapter = adapterOf ?? new SpecSnapshotValidationPort(inner, { port, sanitize, now: () => 1_760_000_000_000 });
  const reported = delivered ?? scanSpecTree(dir).specs;
  return withRunSecretScope(secrets, () => withExecScope(scopeFor(runId), () => adapter.validate(dir, undefined, { deliveredSpecs: reported })));
}

test("every spec of the suite directory is kept per run with the hash of its bytes, and the validation result is untouched", async () => {
  const dir = suite({ "flows/a.spec.ts": "test('a', () => {});", "flows/deep/b.spec.ts": "test('b', () => {});", "notes.txt": "not a spec" });
  try {
    const kept: SpecSnapshot[] = [];
    const result = await validateIn(dir, "run-1", { record: (s) => kept.push(...s) });
    assert.deepEqual(result, RESULT);
    assert.deepEqual(kept.map((s) => s.path).sort(), ["flows/a.spec.ts", "flows/deep/b.spec.ts"]);
    const a = kept.find((s) => s.path === "flows/a.spec.ts")!;
    assert.equal(a.runId, "run-1");
    assert.equal(a.sha256, createHash("sha256").update("test('a', () => {});").digest("hex"));
    assert.equal(a.bytes, "test('a', () => {});".length);
    assert.equal(a.text, "test('a', () => {});");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret of the run is absent from the text, whether the run's scope or the outbound sanitizer takes it out", async () => {
  const dir = suite({ "flows/a.spec.ts": `await page.fill('#pw', '${SECRET}'); // ghp_0123456789abcdefghijklmnopqrstuvwxyz01` });
  try {
    const kept: SpecSnapshot[] = [];
    await validateIn(dir, "run-2", { record: (s) => kept.push(...s) }, (t) => t.replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED]"));
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.text.includes(SECRET), false);
    assert.equal(kept[0]!.text.includes("ghp_"), false);
    assert.equal(kept[0]!.text.includes("[REDACTED]"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the text is capped at 64 KB while the hash and size are of the whole file", async () => {
  const big = `// ${"x".repeat(100_000)}\n`;
  const dir = suite({ "flows/big.spec.ts": big });
  try {
    const kept: SpecSnapshot[] = [];
    await validateIn(dir, "run-3", { record: (s) => kept.push(...s) });
    assert.equal(Buffer.byteLength(kept[0]!.text, "utf8") <= MAX_SPEC_SNAPSHOT_TEXT_BYTES, true);
    assert.equal(kept[0]!.bytes, big.length);
    assert.equal(kept[0]!.sha256, createHash("sha256").update(big).digest("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spec that is a link out of the suite is not followed", async () => {
  const outside = mkdtempSync(join(tmpdir(), "spec-snap-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET OUTSIDE");
  const dir = suite({ "flows/ok.spec.ts": "test('ok', () => {});" });
  try {
    symlinkSync(join(outside, "secret.txt"), join(dir, "flows", "evil.spec.ts"));
    const kept: SpecSnapshot[] = [];
    await validateIn(dir, "run-4", { record: (s) => kept.push(...s) });
    assert.deepEqual(kept.map((s) => s.path), ["flows/ok.spec.ts"]);
    assert.equal(JSON.stringify(kept).includes("TOP SECRET"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("outside a run nothing is kept", async () => {
  const dir = suite({ "flows/a.spec.ts": "test('a', () => {});" });
  try {
    const kept: SpecSnapshot[] = [];
    const result = await new SpecSnapshotValidationPort(inner, { port: { record: (s) => kept.push(...s) }, sanitize: (t) => t }).validate(dir);
    assert.deepEqual(result, RESULT);
    assert.equal(kept.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a store that throws does not fail the validation", async () => {
  const dir = suite({ "flows/a.spec.ts": "test('a', () => {});" });
  try {
    const result = await validateIn(dir, "run-5", { record: () => { throw new Error("disk full"); } });
    assert.deepEqual(result, RESULT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the history keeps a spec once per version of its bytes, and a rewritten spec is kept as well", async () => {
  const dir = suite({ "flows/a.spec.ts": "test('v1', () => {});" });
  try {
    const port = new SqliteSpecSnapshotAdapter();
    await validateIn(dir, "run-6", port);
    await validateIn(dir, "run-6", port);
    assert.equal(listSpecSnapshots("run-6").length, 1);
    writeFileSync(join(dir, "flows", "a.spec.ts"), "test('v2', () => {});");
    await validateIn(dir, "run-6", port);
    const rows = listSpecSnapshots("run-6");
    assert.deepEqual(rows.map((r) => r.text).sort(), ["test('v1', () => {});", "test('v2', () => {});"]);
    assert.deepEqual(listSpecSnapshots("another-run"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshots older than the retention window are pruned with the same chunking as the span ledger", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 1_760_000_000_000;
  const row = (runId: string, ageDays: number) => ({ runId, path: "flows/a.spec.ts", sha256: runId, text: "t", bytes: 1, capturedAt: now - ageDays * day, delivered: 1 });
  commitSpecSnapshots([row("old-run", 40), row("fresh-run", 1)]);
  assert.equal(pruneSpecSnapshots(30, now), 1);
  assert.equal(listSpecSnapshots("old-run").length, 0);
  assert.equal(listSpecSnapshots("fresh-run").length, 1);
});

test("only the specs the run reports as delivered are kept, and a run that reports none keeps none", async () => {
  const dir = suite({ "flows/new.spec.ts": "test('new', () => {});", "flows/restored.spec.ts": "test('restored', () => {});" });
  try {
    const kept: SpecSnapshot[] = [];
    await validateIn(dir, "run-7", { record: (s) => kept.push(...s) }, (t) => t, ["./flows/new.spec.ts"]);
    assert.deepEqual(kept.map((s) => s.path), ["flows/new.spec.ts"]);
    assert.equal(kept[0]!.delivered, true);
    const none: SpecSnapshot[] = [];
    await validateIn(dir, "run-8", { record: (s) => none.push(...s) }, (t) => t, []);
    assert.deepEqual(none, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spec already kept in this run in the same bytes is skipped before its text is made", async () => {
  const dir = suite({ "flows/a.spec.ts": "test('a', () => {});" });
  try {
    let sanitized = 0;
    const kept: SpecSnapshot[] = [];
    const deps = { port: { record: (s: readonly SpecSnapshot[]) => void kept.push(...s) }, sanitize: (t: string) => { sanitized += 1; return t; } };
    const adapter = new SpecSnapshotValidationPort(inner, deps);
    await validateIn(dir, "run-9", deps.port, deps.sanitize, undefined, adapter);
    await validateIn(dir, "run-9", deps.port, deps.sanitize, undefined, adapter);
    assert.equal(sanitized, 1);
    assert.equal(kept.length, 1);
    writeFileSync(join(dir, "flows", "a.spec.ts"), "test('a2', () => {});");
    await validateIn(dir, "run-9", deps.port, deps.sanitize, undefined, adapter);
    assert.equal(kept.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run keeps at most 2 MB of snapshot text", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i += 1) files[`flows/s${String(i).padStart(2, "0")}.spec.ts`] = `// ${String(i)} ${"x".repeat(60_000)}\n`;
  const dir = suite(files);
  try {
    const kept: SpecSnapshot[] = [];
    await validateIn(dir, "run-10", { record: (s) => kept.push(...s) });
    const total = kept.reduce((sum, s) => sum + Buffer.byteLength(s.text, "utf8"), 0);
    assert.ok(total <= MAX_SPEC_SNAPSHOT_BYTES_PER_RUN, `kept ${total}`);
    assert.ok(kept.length >= 30 && kept.length < 50, `kept ${kept.length}`);
    /* The ones kept are the first in path order, whatever order the directory lists them in. */
    assert.deepEqual(kept.map((s) => s.path), Object.keys(files).sort().slice(0, kept.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
