/* qa-engine/test/contexts/generation/infrastructure/manifest-fs.test.ts
   (upsert-by-id, JSON array read/write) — proven here against REAL temp-dir fixtures, not stubs, so
   the port is a behavioral proof, not a type-shape proof.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, existsSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import type { ManifestEntry } from "@contexts/generation/application/ports/index.ts";
import { MAX_MANIFEST_BYTES } from "@kernel/manifest/manifest-entry.ts";
import { ConfinedPathError, type SpecRoot } from "../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

function makeSpecDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-engine-manifest-fs-"));
}

/* The behaviors below do not depend on where the mirror is, so their root is the spec directory itself, the root of a code run; the cases about the anchor build their own. */
function rootOf(specDir: string): SpecRoot {
  return { mirrorDir: specDir, specDir };
}

function manifestPath(specDir: string): string {
  return join(specDir, ".qa", "manifest.json");
}

/* Writes a real (dummy-content) spec file under specDir so a ManifestEntry naming it survives the
   on-disk phantom-drop safety filter reconcileManifest now runs before every merge.
 */
function writeSpecFile(specDir: string, relPath: string): void {
  const full = join(specDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "// dummy spec content\n");
}

test("readManifest returns [] when the manifest file does not exist", async () => {
  const specDir = makeSpecDir();
  try {
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("readManifest returns [] on corrupt (non-JSON) manifest content — fail-open, never throws", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(manifestPath(specDir), "{ not valid json ][");
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("readManifest returns [] when the on-disk JSON is not an array", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(manifestPath(specDir), JSON.stringify({ not: "an array" }));
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("readManifest reads back real entries written to disk", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    const seeded = [{ id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "given creds, then dashboard" }];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, seeded);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest creates the manifest file (with .qa/ dir) when none exists", async () => {
  const specDir = makeSpecDir();
  try {
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
    const entries = [{ id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } }];
    const out = await reconcileManifest(rootOf(specDir),entries);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, "checkout");
    assert.ok(out[0]?.sha256, "surviving entry is stamped with a sha256 checksum");
    assert.equal(existsSync(manifestPath(specDir)), true);
    const onDisk = JSON.parse(readFileSync(manifestPath(specDir), "utf8"));
    assert.deepEqual(onDisk, out);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest upserts by id — an existing id is overwritten, a new id is added", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeSpecFile(specDir, "e2e/login.spec.ts");
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
    const seeded = [
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "old objective" },
      { id: "logout", file: "e2e/logout.spec.ts", flow: "logout", objective: "o" },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(rootOf(specDir),[
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "NEW objective", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
      { id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);

    const byId = new Map(out.map((e) => [e.id, e]));
    assert.equal(byId.get("login")?.objective, "NEW objective");
    assert.equal(byId.get("logout")?.flow, "logout"); /* preserved (unrelated entry survives) */
    assert.equal(byId.get("checkout")?.flow, "checkout");
    assert.equal(out.length, 3);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest returns [] and writes nothing when given an empty entries array (upsertManifest no-op)", async () => {
  const specDir = makeSpecDir();
  try {
    const out = await reconcileManifest(rootOf(specDir),[]);
    assert.deepEqual(out, []);
    /* upsertManifest short-circuits before any fs.write when entries.length === 0 —
       no manifest file is created for a no-op reconcile.
     */
    assert.equal(existsSync(manifestPath(specDir)), false);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

/* ── manifest-enrichment fix: reconcile preserves prior enriched fields on merge ────────────────
   The use-case's upsert (generate-tests.use-case.ts) now stamps targets/changeRef per entry.
   reconcileManifest's merge is `{ ...byId.get(e.id), ...e }` — a re-upserted id's NEW fields win,
   but a re-upsert with a DIFFERENT id must never touch an unrelated id's previously-enriched
   targets/changeRef. Pins that invariant explicitly for the widened (targets/changeRef) shape.
 */
test("reconcileManifest preserves an unrelated entry's targets/changeRef when a different id is re-upserted", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
    const seeded = [
      {
        id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "given creds, then dashboard",
        targets: ["AuthService.login"], changeRef: { sha: "sha1", type: "feat" },
      },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(rootOf(specDir),[
      {
        id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "user can checkout",
        targets: ["CheckoutService.pay"], changeRef: { sha: "sha2", type: "fix" },
      },
    ]);

    const byId = new Map(out.map((e) => [e.id, e]));
    assert.deepEqual(byId.get("login")?.targets, ["AuthService.login"], "unrelated entry's targets preserved");
    assert.deepEqual(byId.get("login")?.changeRef, { sha: "sha1", type: "feat" }, "unrelated entry's changeRef preserved");
    assert.deepEqual(byId.get("checkout")?.targets, ["CheckoutService.pay"]);
    assert.deepEqual(byId.get("checkout")?.changeRef, { sha: "sha2", type: "fix" });
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

/* A re-upsert of the SAME id with a NEW changeRef must win (matches the spread-merge order
   `{ ...byId.get(e.id), ...e }` — the new entry's fields overwrite the old).
 */
test("reconcileManifest overwrites targets/changeRef when the SAME id is re-upserted with new values", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
    const seeded = [
      {
        id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "old objective",
        targets: ["OldService.old"], changeRef: { sha: "sha-old", type: "chore" },
      },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(rootOf(specDir),[
      {
        id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "user can checkout",
        targets: ["CheckoutService.pay"], changeRef: { sha: "sha-new", type: "feat" },
      },
    ]);

    assert.equal(out.length, 1);
    assert.deepEqual(out[0]?.targets, ["CheckoutService.pay"]);
    assert.deepEqual(out[0]?.changeRef, { sha: "sha-new", type: "feat" });
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest rebuilds from the given entries when the existing manifest is corrupt", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(manifestPath(specDir), "not json at all");
    writeSpecFile(specDir, "e2e/a.spec.ts");
    const entries = [{ id: "a", file: "e2e/a.spec.ts", flow: "a", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } }];
    const out = await reconcileManifest(rootOf(specDir),entries);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, "a");
    assert.ok(out[0]?.sha256);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest drops a specMeta whose file is NOT on disk (phantom), and logs a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/real.spec.ts");
    const out = await reconcileManifest(rootOf(specDir),[
      { id: "real", file: "e2e/real.spec.ts", flow: "real", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
      { id: "phantom", file: "e2e/phantom.spec.ts", flow: "phantom", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);

    const ids = out.map((e) => e.id);
    assert.deepEqual(ids, ["real"], "the phantom entry is absent from the written manifest");
    assert.ok(
      warnings.some((w) => w.includes("phantom") && w.includes("e2e/phantom.spec.ts")),
      "a warning names the dropped phantom entry — never silent",
    );

    const onDisk = JSON.parse(readFileSync(manifestPath(specDir), "utf8"));
    assert.deepEqual(onDisk.map((e: { id: string }) => e.id), ["real"]);
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest stamps sha256 on a surviving entry whose file IS on disk", async () => {
  const specDir = makeSpecDir();
  try {
    writeSpecFile(specDir, "e2e/real.spec.ts");
    const out = await reconcileManifest(rootOf(specDir),[
      { id: "real", file: "e2e/real.spec.ts", flow: "real", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.equal(out.length, 1);
    assert.equal(typeof out[0]?.sha256, "string");
    assert.equal(out[0]?.sha256?.length, 64, "sha256 hex digest is 64 chars");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest drops a malformed entry (empty objective) even when its file IS on disk, and logs a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/bad.spec.ts");
    const out = await reconcileManifest(rootOf(specDir),[
      { id: "bad", file: "e2e/bad.spec.ts", flow: "bad", objective: "", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.deepEqual(out, [], "malformed entry dropped — nothing written");
    assert.equal(existsSync(manifestPath(specDir)), false, "no manifest file created for an all-dropped batch");
    assert.ok(
      warnings.some((w) => w.includes("bad") && w.includes("schema")),
      "a warning names the dropped malformed entry — never silent",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest drops a malformed entry (empty targets) with a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/bad.spec.ts");
    const out = await reconcileManifest(rootOf(specDir),[
      { id: "bad", file: "e2e/bad.spec.ts", flow: "bad", objective: "o", targets: [], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.deepEqual(out, []);
    assert.ok(warnings.some((w) => w.includes("bad") && w.includes("schema")));
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

/* GIVEN a manifest entry missing `file` (a hypothetical or hand-edited entry) — `file` is
   now OPTIONAL on the canonical ManifestEntry. It must NOT be silently dropped as a phantom:
   collapsing "no file declared" and "file declared but not on disk" into "no sha256 => drop"
   would falsely flag every file-less entry.
 */
test("reconcileManifest does NOT drop an entry with no 'file' field as a false phantom", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    const out = await reconcileManifest(rootOf(specDir),[
      { id: "no-file", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.deepEqual(out.map((e) => e.id), ["no-file"], "a file-less entry survives — it is not a phantom");
    assert.equal(out[0]?.sha256, undefined, "sha256 is never fabricated for an entry with no file to hash");
    assert.ok(
      !warnings.some((w) => w.includes("phantom")),
      "no phantom warning must fire for an entry that never declared a file",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

/* GIVEN an entry with criticality:"urgent" (not in the enum) WHEN written via reconcile THEN it is
   rejected AT WRITE TIME — the write path (manifestEntryViolation, now canonical-schema-backed)
   validates enum fields, not only required-field presence.
 */
test("reconcileManifest rejects criticality:\"urgent\" (not in the enum) at WRITE time, with a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/bad-enum.spec.ts");
    /* A runtime-only value (e.g. a hand-edited on-disk entry) can carry an out-of-enum
       criticality even though the TYPE forbids it — cast through `unknown` to exercise the
       runtime zod check, mirroring how a real malformed value would arrive (JSON.parse, not a
       typed literal).
     */
    const badEntry = {
      id: "bad-enum", file: "e2e/bad-enum.spec.ts", flow: "checkout", objective: "o",
      targets: ["t"], changeRef: { sha: "s", type: "feat" }, criticality: "urgent",
    } as unknown as ManifestEntry;
    const out = await reconcileManifest(rootOf(specDir),[badEntry]);
    assert.deepEqual(out, [], "the enum-violating entry is dropped — never silently written");
    assert.ok(
      warnings.some((w) => w.includes("bad-enum") && w.includes("schema")),
      "a warning names the dropped entry — never silent",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest still merges valid entries by id while dropping a phantom sibling in the same batch", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeSpecFile(specDir, "e2e/login.spec.ts");
    const seeded = [
      { id: "logout", file: "e2e/logout.spec.ts", flow: "logout", objective: "old", targets: ["t"], changeRef: { sha: "s0", type: "chore" } },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(rootOf(specDir),[
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "NEW", targets: ["t2"], changeRef: { sha: "s1", type: "feat" } },
      { id: "ghost", file: "e2e/ghost.spec.ts", flow: "ghost", objective: "o", targets: ["t"], changeRef: { sha: "s1", type: "feat" } },
    ]);

    const byId = new Map(out.map((e) => [e.id, e]));
    assert.equal(byId.get("login")?.objective, "NEW", "valid entry merged in");
    assert.equal(byId.get("logout")?.flow, "logout", "prior enriched entry preserved across the batch");
    assert.equal(byId.has("ghost"), false, "phantom sibling dropped, doesn't block its valid batch-mate");
    assert.equal(out.length, 2);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

/* ── the files a manifest names come from the agent's verdict ──────────────────────────────────────
   Each is hashed through the confined reader, relative to the root's spec directory: a name that
   leaves it is a phantom like a name that is not on disk, and what it points at is never read, so
   its hash is never written into a manifest that gets published. */

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

function entryFor(id: string, file?: string): ManifestEntry {
  return { id, ...(file ? { file } : {}), flow: id, objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } };
}

/* <tmp>/mirror/e2e/flows/real.spec.ts is the suite; <tmp>/outside/secret.txt is what no hash may be taken of. */
async function withMirror(run: (m: { tmp: string; mirror: string; specDir: string; root: SpecRoot }) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-engine-manifest-confinement-"));
  const mirror = join(tmp, "mirror");
  const specDir = join(mirror, "e2e");
  mkdirSync(join(specDir, "flows"), { recursive: true });
  mkdirSync(join(tmp, "outside"));
  writeFileSync(join(tmp, "outside", "secret.txt"), "TOP SECRET");
  writeFileSync(join(specDir, "flows", "real.spec.ts"), "// the real spec\n");
  const warn = console.warn;
  try {
    await run({ tmp, mirror, specDir, root: { mirrorDir: mirror, specDir } });
  } finally {
    console.warn = warn;
    rmSync(tmp, { recursive: true, force: true });
  }
}

function collectWarnings(): string[] {
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  return warnings;
}

test("reconcileManifest stamps the sha256 of the bytes of a file inside the spec directory of the root, however it is spelled", async () => {
  await withMirror(async ({ root }) => {
    const expected = sha256Of("// the real spec\n");
    const out = await reconcileManifest(root, [entryFor("slash", "flows/real.spec.ts"), entryFor("backslash", "flows\\real.spec.ts"), entryFor("dotted", "./flows/real.spec.ts")]);
    assert.deepEqual(out.map((e) => e.sha256), [expected, expected, expected]);
  });
});

test("reconcileManifest drops an entry whose file is a symlink out of the spec directory as a phantom, and never hashes what it points at", async () => {
  await withMirror(async ({ tmp, specDir, root }) => {
    symlinkSync(join(tmp, "outside", "secret.txt"), join(specDir, "flows", "leak.spec.ts"));
    const warnings = collectWarnings();

    const out = await reconcileManifest(root, [entryFor("real", "flows/real.spec.ts"), entryFor("leak", "flows/leak.spec.ts")]);

    assert.deepEqual(out.map((e) => e.id), ["real"]);
    assert.ok(warnings.some((w) => w.includes("phantom") && w.includes("flows/leak.spec.ts")), "the phantom warning names the refused file, as it does for a file that is not on disk");
    const written = readFileSync(manifestPath(specDir), "utf8");
    assert.ok(!written.includes(sha256Of("TOP SECRET")), "the hash of the file outside the spec directory is in no manifest entry");
    assert.deepEqual((JSON.parse(written) as Array<{ id: string }>).map((e) => e.id), ["real"]);
  });
});

test("reconcileManifest drops an entry whose file climbs out of the spec directory, or is absolute, as a phantom", async () => {
  await withMirror(async ({ tmp, specDir, root }) => {
    const warnings = collectWarnings();
    const out = await reconcileManifest(root, [
      entryFor("real", "flows/real.spec.ts"),
      entryFor("climbs", "../../outside/secret.txt"),
      entryFor("backslashes", "..\\..\\outside\\secret.txt"),
      entryFor("absolute", join(tmp, "outside", "secret.txt")),
      entryFor("inside-by-way-of-parent", "flows/../flows/real.spec.ts"),
    ]);

    assert.deepEqual(out.map((e) => e.id), ["real"]);
    assert.equal(warnings.filter((w) => w.includes("phantom")).length, 4, "each refused entry is warned about by name");
    assert.ok(!readFileSync(manifestPath(specDir), "utf8").includes(sha256Of("TOP SECRET")));
  });
});

test("reconcileManifest stamps a symlink to another file inside the spec directory with the hash of that file", async () => {
  await withMirror(async ({ specDir, root }) => {
    symlinkSync("real.spec.ts", join(specDir, "flows", "alias.spec.ts"));
    const out = await reconcileManifest(root, [entryFor("alias", "flows/alias.spec.ts")]);
    assert.deepEqual(out.map((e) => e.sha256), [sha256Of("// the real spec\n")]);
  });
});

test("reconcileManifest drops every entry that names a file when the spec directory of the root leaves the mirror, and writes nothing there", async () => {
  await withMirror(async ({ tmp, mirror }) => {
    mkdirSync(join(tmp, "elsewhere", "flows"), { recursive: true });
    writeFileSync(join(tmp, "elsewhere", "flows", "real.spec.ts"), "// planted outside the mirror\n");
    const warnings = collectWarnings();

    const out = await reconcileManifest({ mirrorDir: mirror, specDir: join(tmp, "elsewhere") }, [entryFor("planted", "flows/real.spec.ts")]);

    assert.deepEqual(out, [], "the file exists, but its spec directory is not the mirror's");
    assert.ok(warnings.some((w) => w.includes("phantom") && w.includes("flows/real.spec.ts")));
    assert.equal(existsSync(join(tmp, "elsewhere", ".qa")), false);
  });
});

test("reconcileManifest refuses to write into a spec directory that leaves the mirror, even for an entry that names no file", async () => {
  await withMirror(async ({ tmp, mirror }) => {
    mkdirSync(join(tmp, "elsewhere"));

    await assert.rejects(reconcileManifest({ mirrorDir: mirror, specDir: join(tmp, "elsewhere") }, [entryFor("fileless")]), (err: unknown) => err instanceof ConfinedPathError);

    assert.equal(existsSync(join(tmp, "elsewhere", ".qa")), false);
  });
});

test("reconcileManifest writes the manifest under the spec directory of the root, not under the mirror", async () => {
  await withMirror(async ({ mirror, specDir, root }) => {
    await reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]);
    assert.equal(existsSync(manifestPath(specDir)), true);
    assert.equal(existsSync(join(mirror, ".qa", "manifest.json")), false);
  });
});

/* ── the manifest itself is in a directory the agent writes into ───────────────────────────────────
   `.qa/manifest.json` is the orchestrator's own file, but the agent can plant a symlink or a named pipe at the file or at `.qa`.
   Followed, a read hands the orchestrator a file of the agent's choosing and a write clobbers one. So it is read and written
   strictly: nothing at or above it may be a link, and a write replaces the file through a temporary file, never through a link.
   A refused read is "no manifest", said aloud; a refused write is thrown, since a manifest that was not written is not a manifest. */

const canMakeNamedPipes = (): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "qa-manifest-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";

const refusedAsManifest = (err: unknown): boolean => err instanceof ConfinedPathError && err.path === ".qa/manifest.json";
const LEAKED = JSON.stringify([{ id: "leaked", file: "a.spec.ts", flow: "leaked flow", objective: "leaked objective" }]);

test("readManifest takes a manifest reached through a symlink, at the file or at its directory, for no manifest, says so, and never returns what the link points at", async () => {
  await withMirror(async ({ tmp, specDir }) => {
    writeFileSync(join(tmp, "outside", "entries.json"), LEAKED);
    mkdirSync(join(tmp, "outside", "qa"));
    writeFileSync(join(tmp, "outside", "qa", "manifest.json"), LEAKED);
    const warnings = collectWarnings();

    symlinkSync(join(tmp, "outside", "qa"), join(specDir, ".qa"));
    assert.deepEqual(await readManifest(specDir), [], "the directory is a symlink");
    rmSync(join(specDir, ".qa"));
    mkdirSync(join(specDir, ".qa"));
    symlinkSync(join(tmp, "outside", "entries.json"), manifestPath(specDir));
    assert.deepEqual(await readManifest(specDir), [], "the file is a symlink");

    assert.equal(warnings.filter((w) => w.includes("manifest")).length, 2, "each refusal is said aloud");
  });
});

test("readManifest takes a manifest that is a symlink to another file inside the spec directory for no manifest as well", async () => {
  await withMirror(async ({ specDir }) => {
    mkdirSync(join(specDir, ".qa"));
    writeFileSync(join(specDir, "copy.json"), LEAKED);
    symlinkSync(join(specDir, "copy.json"), manifestPath(specDir));
    collectWarnings();

    assert.deepEqual(await readManifest(specDir), []);
  });
});

/* The named-pipe cases run under a watch: a read that opened the pipe would wait for a writer for ever, and a test cannot time out a thread that is stuck, so the watch releases it and the test fails there instead. */
test("readManifest does not wait on a named pipe at the manifest", { skip: NO_NAMED_PIPES }, async () => {
  await withMirror(async ({ specDir }) => {
    mkdirSync(join(specDir, ".qa"));
    execFileSync("mkfifo", [manifestPath(specDir)]);
    collectWarnings();

    assert.deepEqual(await withoutWaitingOnNamedPipe(manifestPath(specDir), () => readManifest(specDir)), []);
  });
});

test("readManifest takes a manifest that is a directory, or whose directory is a regular file, for no manifest and says so", async () => {
  await withMirror(async ({ specDir }) => {
    const warnings = collectWarnings();
    mkdirSync(manifestPath(specDir), { recursive: true });
    assert.deepEqual(await readManifest(specDir), []);
    rmSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(join(specDir, ".qa"), "not a directory");
    assert.deepEqual(await readManifest(specDir), []);
    assert.equal(warnings.filter((w) => w.includes("manifest")).length, 2);
  });
});

test("readManifest says nothing about a manifest that is simply not there, with or without its directory", async () => {
  await withMirror(async ({ specDir }) => {
    const warnings = collectWarnings();
    assert.deepEqual(await readManifest(specDir), []);
    mkdirSync(join(specDir, ".qa"));
    assert.deepEqual(await readManifest(specDir), []);
    assert.deepEqual(warnings, []);
  });
});

test("readManifest takes a manifest larger than the cap for no manifest and says so, and reads one of exactly the cap", async () => {
  await withMirror(async ({ specDir }) => {
    mkdirSync(join(specDir, ".qa"));
    const entries = JSON.stringify([{ id: "big", file: "a.spec.ts", flow: "f", objective: "o", pad: "" }]);
    const padded = (bytes: number): string => entries.replace('"pad":""', `"pad":"${"x".repeat(bytes - entries.length)}"`);
    const warnings = collectWarnings();

    writeFileSync(manifestPath(specDir), padded(MAX_MANIFEST_BYTES + 1));
    assert.deepEqual(await readManifest(specDir), [], "one byte over");
    assert.equal(warnings.filter((w) => w.includes("manifest")).length, 1);

    writeFileSync(manifestPath(specDir), padded(MAX_MANIFEST_BYTES));
    assert.equal((await readManifest(specDir)).length, 1, "exactly the cap");
  });
});

test("reconcileManifest never writes through a symlink at the manifest: the file it points at is intact and the refusal is thrown", async () => {
  await withMirror(async ({ tmp, specDir, root }) => {
    mkdirSync(join(specDir, ".qa"));
    writeFileSync(join(tmp, "outside", "victim.txt"), "PRECIOUS");
    symlinkSync(join(tmp, "outside", "victim.txt"), manifestPath(specDir));

    await assert.rejects(reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]), refusedAsManifest);

    assert.equal(readFileSync(join(tmp, "outside", "victim.txt"), "utf8"), "PRECIOUS");
    assert.equal(lstatSync(manifestPath(specDir)).isSymbolicLink(), true, "the plant is left as it was");
    assert.deepEqual(readdirSync(join(specDir, ".qa")), ["manifest.json"], "and no temporary file is left");
  });
});

test("reconcileManifest never writes through a symlink at the directory of the manifest, and nothing is made outside", async () => {
  await withMirror(async ({ tmp, specDir, root }) => {
    symlinkSync(join(tmp, "outside"), join(specDir, ".qa"));

    await assert.rejects(reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]), refusedAsManifest);

    assert.deepEqual(readdirSync(join(tmp, "outside")), ["secret.txt"]);
  });
});

test("reconcileManifest throws, and writes nothing, for a manifest that is a directory, a named pipe, or in a directory that is a regular file", async () => {
  await withMirror(async ({ specDir, root }) => {
    mkdirSync(manifestPath(specDir), { recursive: true });
    await assert.rejects(reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]), refusedAsManifest, "a directory");
    assert.equal(lstatSync(manifestPath(specDir)).isDirectory(), true);
    rmSync(join(specDir, ".qa"), { recursive: true });

    writeFileSync(join(specDir, ".qa"), "not a directory");
    await assert.rejects(reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]), refusedAsManifest, "a regular file in place of the directory");
    assert.equal(readFileSync(join(specDir, ".qa"), "utf8"), "not a directory");
  });
});

test("reconcileManifest throws for a manifest that is a named pipe, which it never opens", { skip: NO_NAMED_PIPES }, async () => {
  await withMirror(async ({ specDir, root }) => {
    mkdirSync(join(specDir, ".qa"));
    execFileSync("mkfifo", [manifestPath(specDir)]);

    await assert.rejects(withoutWaitingOnNamedPipe(manifestPath(specDir), () => reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")])), refusedAsManifest);

    assert.equal(lstatSync(manifestPath(specDir)).isFIFO(), true);
  });
});

test("reconcileManifest leaves out of the manifest it rewrites a prior entry that is not an object or has no id, and keeps the ones that have one", async () => {
  await withMirror(async ({ specDir, root }) => {
    mkdirSync(join(specDir, ".qa"));
    const kept = { id: "kept", flow: "kept", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } };
    writeFileSync(manifestPath(specDir), JSON.stringify([null, 5, "text", { flow: "no id" }, { id: 7, flow: "id that is not a string" }, kept]));

    const out = await reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]);

    assert.deepEqual(out.map((e) => e.id), ["kept", "real"]);
    assert.deepEqual((JSON.parse(readFileSync(manifestPath(specDir), "utf8")) as Array<{ id: string }>).map((e) => e.id), ["kept", "real"]);
  });
});

test("reconcileManifest throws rather than merge into a manifest it will not read, and does not replace it", async () => {
  await withMirror(async ({ specDir, root }) => {
    mkdirSync(join(specDir, ".qa"));
    const oversize = "x".repeat(MAX_MANIFEST_BYTES + 1);
    writeFileSync(manifestPath(specDir), oversize);

    await assert.rejects(reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]), refusedAsManifest);

    assert.equal(readFileSync(manifestPath(specDir), "utf8").length, oversize.length, "an unreadable manifest is not overwritten with one that has lost its entries");
  });
});

/* The read of a manifest refuses a link before the write is reached, so nothing above makes the write strict on its own: this is the case only a write that goes through a temporary file tells apart from one that opens the manifest, a second name for another file's inode. */
test("reconcileManifest replaces a manifest that is a second name for another file's inode, and leaves that file as it was", async () => {
  await withMirror(async ({ tmp, specDir, root }) => {
    mkdirSync(join(specDir, ".qa"));
    linkSync(join(tmp, "outside", "secret.txt"), manifestPath(specDir));

    await reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]);

    assert.equal(readFileSync(join(tmp, "outside", "secret.txt"), "utf8"), "TOP SECRET", "a write that went through the inode would have replaced it");
    assert.deepEqual((JSON.parse(readFileSync(manifestPath(specDir), "utf8")) as Array<{ id: string }>).map((e) => e.id), ["real"]);
  });
});

test("reconcileManifest replaces the manifest as a whole and leaves no temporary file in its directory", async () => {
  await withMirror(async ({ specDir, root }) => {
    mkdirSync(join(specDir, ".qa"));
    writeFileSync(manifestPath(specDir), JSON.stringify([entryFor("old", "flows/real.spec.ts")], null, 2) + " ".repeat(2000));

    await reconcileManifest(root, [entryFor("real", "flows/real.spec.ts")]);

    assert.deepEqual((JSON.parse(readFileSync(manifestPath(specDir), "utf8")) as Array<{ id: string }>).map((e) => e.id), ["old", "real"], "the file is the merge, with nothing left of the longer old text");
    assert.deepEqual(readdirSync(join(specDir, ".qa")), ["manifest.json"]);
  });
});
