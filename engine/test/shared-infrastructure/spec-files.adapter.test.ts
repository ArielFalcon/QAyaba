/* The adapter is the confined reader behind SpecFilesPort: a path the agent reported is refused when it leaves the spec directory, and a file the orchestrator keeps is read, written, probed and removed strictly. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinedSpecFiles } from "../../src/shared-infrastructure/spec-files.adapter.ts";
import { ConfinedPathError } from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { MAX_SPEC_SOURCE_BYTES, type SpecRoot } from "../../src/shared-kernel/ports/spec-files.port.ts";

function rig(t: TestContext): { root: SpecRoot; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), "spec-files-adapter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mirrorDir = join(dir, "mirror");
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(dir, "secret.txt"), "outside");
  return { root: { mirrorDir, specDir }, outside: join(dir, "secret.txt") };
}

test("a file written through the port is read, listed, probed and removed through it", (t) => {
  const { root } = rig(t);
  confinedSpecFiles.write(root, "flows/a.spec.ts", "export {};\n");
  confinedSpecFiles.write(root, "support/helper.ts", "export const h = 1;\n");
  assert.equal(confinedSpecFiles.read(root, "flows/a.spec.ts"), "export {};\n");
  assert.deepEqual(confinedSpecFiles.list(root.specDir), ["flows/a.spec.ts"]);
  const suite = confinedSpecFiles.listSuite(root.specDir);
  assert.deepEqual([...suite.files].sort(), ["flows/a.spec.ts", "support/helper.ts"]);
  assert.equal(suite.cut, false);
  assert.equal(confinedSpecFiles.probe(root, "flows/a.spec.ts"), "file");
  assert.deepEqual(confinedSpecFiles.remove(root, "flows/a.spec.ts"), { removed: "flows/a.spec.ts", how: "unlinked" });
  assert.equal(confinedSpecFiles.probe(root, "flows/a.spec.ts"), "absent");
  assert.deepEqual(confinedSpecFiles.remove(root, "flows/a.spec.ts"), { nothing: true });
});

test("a reported path that leaves the spec directory is refused", (t) => {
  const { root } = rig(t);
  assert.throws(() => confinedSpecFiles.read(root, "../../secret.txt"), ConfinedPathError);
  assert.throws(() => confinedSpecFiles.write(root, "../escape.txt", "x"), ConfinedPathError);
});

test("a symbolic link planted below the spec directory is never read", (t) => {
  const { root, outside } = rig(t);
  symlinkSync(outside, join(root.specDir, "planted.spec.ts"));
  assert.throws(() => confinedSpecFiles.read(root, "planted.spec.ts"), ConfinedPathError);
  const owned = confinedSpecFiles.readOwned(root, "planted.spec.ts", MAX_SPEC_SOURCE_BYTES);
  assert.ok("reason" in owned);
  assert.ok(typeof confinedSpecFiles.probe(root, "planted.spec.ts") === "object");
});

test("a file the orchestrator keeps is absent, read whole, or refused over the cap", (t) => {
  const { root } = rig(t);
  assert.deepEqual(confinedSpecFiles.readOwned(root, "missing.ts", 10), { absent: true });
  confinedSpecFiles.write(root, "k.ts", "0123456789ABC");
  const small = confinedSpecFiles.readOwned(root, "k.ts", 100);
  assert.ok("bytes" in small && small.bytes.toString() === "0123456789ABC");
  const tooBig = confinedSpecFiles.readOwned(root, "k.ts", 5);
  assert.ok("reason" in tooBig);
});
