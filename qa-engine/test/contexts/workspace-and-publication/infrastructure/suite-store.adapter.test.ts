/* The suite store against real files under a temporary directory; git is a fake that lists what it tracks. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTH_SETUP_PATH, SuiteStoreAdapter, deleteSuiteStoreDir, suiteStoreHoldsVerifiedLogin, gitBlobOid, gitListTracked, parseStagedListing, suiteEntryKind,
  type SuiteManifest, type SuiteStoreLimits, type TrackedFile,
} from "../../../../src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts";
import type { SuiteCaptureInput } from "../../../../src/shared-kernel/ports/suite-store.port.ts";

const STOCK_SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "auth.setup.ts"), "utf8");
const APP_LOGIN = "import { test as setup } from '@playwright/test';\nsetup('authenticate', async ({ page }) => { await page.goto('/login'); });\n";
const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

interface Rig {
  base: string;
  mirrorDir: string;
  specDir: string;
  storeDir: string;
  tracked: Map<string, TrackedFile>;
  put(rel: string, text: string | Buffer): void;
  read(rel: string): string;
  has(rel: string): boolean;
  clean(): void;
  store(limits?: SuiteStoreLimits, readOnly?: boolean): SuiteStoreAdapter;
  /** The engine's seed project the store was told about; a test rewrites a file of it to stand for an engine upgrade. */
  seedDir: string;
  seed(rel: string, text: string): void;
  manifest(): SuiteManifest;
  blobs(): string[];
  /** `executedGreen` as a list means "these paths ran green with the bytes they hold right now"; a map names the exact bytes that ran. */
  capture(over?: Partial<Omit<SuiteCaptureInput, "executedGreen">> & { executedGreen?: readonly string[] | ReadonlyMap<string, string> }): ReturnType<SuiteStoreAdapter["capture"]>;
  /** What the fingerprint of these paths is at this moment. */
  ranGreen(...paths: string[]): Map<string, string>;
  warnings: string[];
}

function rig(t: TestContext): Rig {
  const base = mkdtempSync(join(tmpdir(), "suite-store-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const mirrorDir = join(base, "mirrors", "org__app");
  const specDir = join(mirrorDir, "e2e");
  const storeDir = join(base, "data", "suites", "demo");
  mkdirSync(specDir, { recursive: true });
  const tracked = new Map<string, TrackedFile>();
  const seedDir = join(base, "config", "e2e");
  mkdirSync(seedDir, { recursive: true });
  const warnings: string[] = [];
  let tick = 0;
  const store = (limits?: SuiteStoreLimits, readOnly?: boolean): SuiteStoreAdapter =>
    new SuiteStoreAdapter({
      storeDir, app: "demo", repo: "org/app", specRelDir: "e2e", seedDir,
      listTracked: async () => tracked,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
      warn: (m) => warnings.push(m),
      ...(limits ? { limits } : {}),
      ...(readOnly ? { readOnly } : {}),
    });
  const put = (rel: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(specDir, rel)), { recursive: true });
    writeFileSync(join(specDir, rel), text);
  };
  const adapter = store();
  const ranGreen = (...paths: string[]): Map<string, string> =>
    new Map(paths.filter((p) => existsSync(join(specDir, p))).map((p) => [p, sha(readFileSync(join(specDir, p)))]));
  return {
    base, mirrorDir, specDir, storeDir, tracked, warnings, put, store, seedDir,
    seed: (rel, text) => {
      mkdirSync(dirname(join(seedDir, rel)), { recursive: true });
      writeFileSync(join(seedDir, rel), text);
    },
    read: (rel) => readFileSync(join(specDir, rel), "utf8"),
    has: (rel) => existsSync(join(specDir, rel)),
    clean: () => {
      rmSync(specDir, { recursive: true, force: true });
      mkdirSync(specDir, { recursive: true });
    },
    manifest: () => JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8")) as SuiteManifest,
    blobs: () => (existsSync(join(storeDir, "blobs")) ? readdirSync(join(storeDir, "blobs")).sort() : []),
    capture: (over = {}) => adapter.capture({ mirrorDir, specDir, runId: "run-1", sha: "abc1234", ...over, executedGreen: Array.isArray(over.executedGreen) ? ranGreen(...(over.executedGreen as string[])) : (over.executedGreen as ReadonlyMap<string, string> | undefined) ?? new Map() }),
    ranGreen,
  };
}

const root = (r: Rig) => ({ mirrorDir: r.mirrorDir, specDir: r.specDir });

test("a restore puts back what a capture took, and a wiped working copy equals the captured one", async (t) => {
  const r = rig(t);
  r.put("package.json", "{}");
  r.put("flows/login.spec.ts", "test('login')");
  r.put("pages/login.page.ts", "export class LoginPage {}");
  r.put(".qa/manifest.json", "{\"specs\":[]}");
  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  await r.capture({ executedGreen: ["flows/login.spec.ts"], authVerifiedSha256: sha(APP_LOGIN) });

  r.clean();
  const result = await r.store().restore(root(r));

  assert.deepEqual({ ...result, digest: undefined }, { restored: 5, trackedWins: 0, overlaid: 0, authRestored: true, digest: undefined });
  assert.equal(r.read("flows/login.spec.ts"), "test('login')");
  assert.equal(r.read("pages/login.page.ts"), "export class LoginPage {}");
  assert.equal(r.read(AUTH_SETUP_PATH), APP_LOGIN);
  assert.equal(r.read(".qa/manifest.json"), "{\"specs\":[]}");
});

test("a restore names the set it put back by a digest: the same set gives the same digest, an extra spec gives another", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "test('a')");
  r.put("flows/b.spec.ts", "test('b')");
  await r.capture({ executedGreen: ["flows/a.spec.ts", "flows/b.spec.ts"] });

  r.clean();
  const first = await r.store().restore(root(r));
  r.clean();
  const again = await r.store().restore(root(r));
  assert.match(first.digest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(again.digest, first.digest, "the same stored set restores to the same digest");

  r.put("flows/c.spec.ts", "test('c')");
  await r.capture({ executedGreen: ["flows/a.spec.ts", "flows/b.spec.ts", "flows/c.spec.ts"] });
  r.clean();
  const grown = await r.store().restore(root(r));
  assert.notEqual(grown.digest, first.digest, "a spec another replicate generated changes the digest");
});

test("the digest follows the content of the restored files, not the order they were stored in", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "test('a')");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  r.clean();
  const before = await r.store().restore(root(r));
  r.put("flows/a.spec.ts", "test('a, edited')");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  r.clean();
  assert.notEqual((await r.store().restore(root(r))).digest, before.digest);
});

test("a store with nothing in it restores nothing and leaves the working copy alone", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "x");
  const empty = await r.store().restore(root(r));
  assert.deepEqual({ ...empty, digest: undefined }, { restored: 0, trackedWins: 0, overlaid: 0, authRestored: false, digest: undefined });
  assert.match(empty.digest ?? "", /^[0-9a-f]{64}$/, "an empty restore still has a digest, so it differs from a populated one");
  assert.equal(r.read("flows/a.spec.ts"), "x");
});

test("a spec is admitted only when it ran green this run; one that did not keeps the stored content", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a v1");
  r.put("flows/b.spec.ts", "b v1");
  await r.capture({ executedGreen: ["flows/a.spec.ts", "flows/b.spec.ts"] });

  r.put("flows/a.spec.ts", "a v2");
  r.put("flows/b.spec.ts", "b TAMPERED, never ran");
  r.put("flows/c.spec.ts", "c new, never ran");
  await r.capture({ runId: "run-2", executedGreen: ["./flows/a.spec.ts"] });

  r.clean();
  await r.store().restore(root(r));
  assert.equal(r.read("flows/a.spec.ts"), "a v2");
  assert.equal(r.read("flows/b.spec.ts"), "b v1");
  assert.equal(r.has("flows/c.spec.ts"), false);
});

test("a spec whose bytes changed after they ran green is not admitted: the store keeps the content that ran", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a ran green");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });

  const ran = r.ranGreen("flows/a.spec.ts");
  r.put("flows/a.spec.ts", "a regenerated after the run, never executed");
  const result = await r.capture({ runId: "run-2", executedGreen: ran });

  assert.equal(result.admitted, 0);
  assert.equal(result.skipped.some((s) => s.path === "flows/a.spec.ts"), true, "the refusal is reported");
  r.clean();
  await r.store().restore(root(r));
  assert.equal(r.read("flows/a.spec.ts"), "a ran green");
});

test("a new spec that was regenerated after it ran green is left out altogether", async (t) => {
  const r = rig(t);
  r.put("flows/new.spec.ts", "executed bytes");
  const ran = r.ranGreen("flows/new.spec.ts");
  r.put("flows/new.spec.ts", "other bytes");

  const result = await r.capture({ executedGreen: ran });

  assert.deepEqual({ entries: result.entries, admitted: result.admitted }, { entries: 0, admitted: 0 });
  assert.equal(r.blobs().length, 0);
});

test("the fingerprint of a run names the bytes of each spec it is asked about, apart from a spec it cannot read", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  const ran = await r.store().fingerprint(root(r), ["./flows/a.spec.ts", "flows/missing.spec.ts"]);

  assert.deepEqual([...ran], [["flows/a.spec.ts", sha("a")]]);
});

test("a stored file the working copy no longer has is a deletion", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  r.put("flows/b.spec.ts", "b");
  await r.capture({ executedGreen: ["flows/a.spec.ts", "flows/b.spec.ts"] });
  rmSync(join(r.specDir, "flows", "b.spec.ts"));

  const result = await r.capture({ runId: "run-2", executedGreen: ["flows/a.spec.ts"] });

  assert.equal(result.dropped, 1);
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/a.spec.ts"]);
  assert.equal(r.blobs().length, 1, "the blob of the deleted spec is collected");
});

test("git wins over a stored file whose path git tracks with other content, and the entry is dropped at the next capture", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "stored version");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });

  r.clean();
  r.tracked.set("flows/a.spec.ts", { oid: gitBlobOid(Buffer.from("merged version"), 40) });
  r.put("flows/a.spec.ts", "merged version");
  const result = await r.store().restore(root(r));
  assert.equal(result.trackedWins, 1);
  assert.equal(result.restored, 0);
  assert.equal(r.read("flows/a.spec.ts"), "merged version", "the tracked file is not overwritten");

  await r.capture({ runId: "run-2" });
  assert.deepEqual(r.manifest().entries, [], "the entry the merge replaced is gone");
});

test("an unpublished change over a tracked file is put back only while git still has the revision it was made over", async (t) => {
  const r = rig(t);
  const base = gitBlobOid(Buffer.from("published v1"), 40);
  r.tracked.set("flows/a.spec.ts", { oid: base });
  r.put("flows/a.spec.ts", "my unpublished v2");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  assert.equal(r.manifest().entries[0]?.gitBaseBlob, base);

  r.clean();
  r.put("flows/a.spec.ts", "published v1");
  assert.equal((await r.store().restore(root(r))).overlaid, 1);
  assert.equal(r.read("flows/a.spec.ts"), "my unpublished v2");

  r.clean();
  r.put("flows/a.spec.ts", "published v3, after a merge");
  r.tracked.set("flows/a.spec.ts", { oid: gitBlobOid(Buffer.from("published v3, after a merge"), 40) });
  assert.equal((await r.store().restore(root(r))).trackedWins, 1);
  assert.equal(r.read("flows/a.spec.ts"), "published v3, after a merge");
});

test("a file identical to the one git tracks is not stored", async (t) => {
  const r = rig(t);
  r.tracked.set("package.json", { oid: gitBlobOid(Buffer.from("{}"), 40) });
  r.put("package.json", "{}");
  r.put("flows/a.spec.ts", "a");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/a.spec.ts"]);
});

test("the login is admitted only when it is the file that signed in, and never when it is the stock seed", async (t) => {
  const r = rig(t);
  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  const none = await r.capture();
  assert.deepEqual(r.blobs(), [], "no login signed in, nothing stored");
  assert.equal(none.admitted, 0);

  const other = await r.capture({ runId: "run-2", authVerifiedSha256: sha("some other file") });
  assert.deepEqual(other.skipped, [{ path: AUTH_SETUP_PATH, reason: "not the login that signed in" }]);

  r.put(AUTH_SETUP_PATH, STOCK_SEED);
  await r.capture({ runId: "run-3", authVerifiedSha256: sha(STOCK_SEED) });
  assert.equal(existsSync(join(r.storeDir, "manifest.json")), false, "the stock seed is the engine's own, never the app's login");

  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  await r.capture({ runId: "run-4", authVerifiedSha256: sha(APP_LOGIN) });
  const m = r.manifest();
  assert.equal(m.auth?.status, "verified");
  assert.equal(m.auth?.sha256, sha(APP_LOGIN));
  assert.equal(m.auth?.verifiedBy.runId, "run-4");
  assert.equal(m.entries[0]?.kind, "auth-setup");
});

test("a demoted login is taken out of the working copy and of every later restore, until a login is verified again", async (t) => {
  const r = rig(t);
  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  r.put("flows/a.spec.ts", "a");
  await r.capture({ executedGreen: ["flows/a.spec.ts"], authVerifiedSha256: sha(APP_LOGIN) });

  r.clean();
  assert.equal((await r.store().restore(root(r))).authRestored, true);
  await r.store().demoteAuth(root(r), "the restored login failed");

  assert.equal(r.has(AUTH_SETUP_PATH), false, "the project setup seeds the stock login again");
  assert.equal(r.has("flows/a.spec.ts"), true, "the specs stay");
  assert.equal(r.manifest().auth?.status, "demoted");
  assert.equal(r.manifest().auth?.reason, "the restored login failed");
  assert.equal(r.manifest().entries.some((e) => e.kind === "auth-setup"), false);

  r.clean();
  const again = await r.store().restore(root(r));
  assert.equal(again.authRestored, false);
  assert.equal(r.has(AUTH_SETUP_PATH), false);

  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  await r.capture({ runId: "run-2", executedGreen: ["flows/a.spec.ts"], authVerifiedSha256: sha(APP_LOGIN) });
  assert.equal(r.manifest().auth?.status, "verified");
});

test("what holds a credential or a login session is never admitted, whatever it is called", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  r.put(".env", "SECRET=1");
  r.put(".auth/user.json", "{}");
  r.put("keys/server.pem", "-----BEGIN");
  r.put("state.json", '{"cookies":[{"name":"s"}],"origins":[]}');
  r.put("node_modules/dep/index.js", "x");
  r.put("test-results/out.txt", "x");
  r.put(".qa/context.json", "{}");
  r.put(".qa-probe/scratch.ts", "x");
  r.put(".qa/manifest.json", "{}");
  const result = await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  assert.deepEqual(r.manifest().entries.map((e) => e.path), [".qa/manifest.json", "flows/a.spec.ts"]);
  assert.deepEqual(result.skipped, [{ path: "state.json", reason: "login session (storage state)" }]);
});

test("a link or a named pipe in the suite is neither followed nor admitted", async (t) => {
  const r = rig(t);
  const outside = join(r.base, "outside.txt");
  writeFileSync(outside, "secret outside the suite");
  r.put("flows/a.spec.ts", "a");
  symlinkSync(outside, join(r.specDir, "flows", "link.spec.ts"));
  symlinkSync(join(r.base, "outside-dir"), join(r.specDir, "dirlink"));
  await r.capture({ executedGreen: ["flows/a.spec.ts", "flows/link.spec.ts"] });
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/a.spec.ts"]);

  /* A restore does not write through a link the agent planted where a stored file goes. */
  r.clean();
  symlinkSync(outside, join(r.specDir, "flows"));
  await assert.rejects(() => r.store().restore(root(r)));
  assert.equal(readFileSync(outside, "utf8"), "secret outside the suite");
});

test("a file over the per-file cap is skipped, and a suite over the total cap stores nothing", async (t) => {
  const r = rig(t);
  const limits: SuiteStoreLimits = { maxFileBytes: 8, maxTotalBytes: 20, maxEntries: 10 };
  const adapter = r.store(limits);
  r.put("flows/small.spec.ts", "tiny");
  r.put("flows/huge.spec.ts", "0123456789");
  const result = await adapter.capture({ mirrorDir: r.mirrorDir, specDir: r.specDir, runId: "r", sha: "s", executedGreen: r.ranGreen("flows/small.spec.ts", "flows/huge.spec.ts") });
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/small.spec.ts"]);
  assert.equal(result.skipped[0]?.path, "flows/huge.spec.ts");

  r.put("flows/b.spec.ts", "bbbbbbb");
  r.put("flows/c.spec.ts", "ccccccc");
  r.put("flows/d.spec.ts", "ddddddd");
  await assert.rejects(
    () => adapter.capture({ mirrorDir: r.mirrorDir, specDir: r.specDir, runId: "r2", sha: "s", executedGreen: r.ranGreen("flows/small.spec.ts", "flows/b.spec.ts", "flows/c.spec.ts", "flows/d.spec.ts") }),
    /over the store's limit/,
  );
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/small.spec.ts"], "the previous store is untouched");
});

test("the manifest is replaced atomically and no temporary file or unreferenced blob is left behind", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a v1");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  const first = r.manifest();
  r.put("flows/a.spec.ts", "a v2");
  await r.capture({ runId: "run-2", executedGreen: ["flows/a.spec.ts"] });
  const second = r.manifest();

  assert.equal(second.generation, first.generation + 1);
  assert.deepEqual(r.blobs(), [sha("a v2")], "the superseded blob is collected");
  assert.deepEqual(readdirSync(r.storeDir).sort(), ["blobs", "manifest.json"]);
  assert.equal((lstatSync(join(r.storeDir, "manifest.json")).mode & 0o077), 0, "owner-only");
});

test("a capture that changes nothing does not rewrite the manifest", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  const before = readFileSync(join(r.storeDir, "manifest.json"), "utf8");
  await r.capture({ runId: "run-2", executedGreen: ["flows/a.spec.ts"] });
  assert.equal(readFileSync(join(r.storeDir, "manifest.json"), "utf8"), before);
});

test("a corrupt manifest or a blob that no longer matches its hash is said aloud, never restored", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  r.put("flows/b.spec.ts", "b");
  await r.capture({ executedGreen: ["flows/a.spec.ts", "flows/b.spec.ts"] });
  writeFileSync(join(r.storeDir, "blobs", sha("a")), "tampered");
  r.clean();
  const result = await r.store().restore(root(r));
  assert.equal(result.restored, 1);
  assert.equal(r.has("flows/a.spec.ts"), false);
  assert.match(r.warnings.join("\n"), /flows\/a\.spec\.ts.*no longer matches/);

  writeFileSync(join(r.storeDir, "manifest.json"), "{not json");
  await assert.rejects(() => r.store().restore(root(r)), /not valid JSON/);
  writeFileSync(join(r.storeDir, "manifest.json"), JSON.stringify({ schema: 1, generation: 1, entries: [{ path: "../escape", sha256: sha("x"), bytes: 1, kind: "support", admittedBy: {} }] }));
  await assert.rejects(() => r.store().restore(root(r)), /unsafe path/);
});

test("a capture that holds a file again repairs its stored copy when that no longer matches its hash", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  r.put("package.json", "{}");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  writeFileSync(join(r.storeDir, "blobs", sha("a")), "tampered");
  writeFileSync(join(r.storeDir, "blobs", sha("{}")), "tampered");

  await r.capture({ runId: "run-2", executedGreen: ["flows/a.spec.ts"] });

  assert.equal(readFileSync(join(r.storeDir, "blobs", sha("a")), "utf8"), "a", "an unchanged spec");
  assert.equal(readFileSync(join(r.storeDir, "blobs", sha("{}")), "utf8"), "{}", "an unchanged support file");
  r.clean();
  assert.equal((await r.store().restore(root(r))).restored, 2);
  assert.deepEqual(r.warnings, []);
});

test("a file that is byte-equal to the engine's seed is not stored: it is the seed's to give, not the app's", async (t) => {
  const r = rig(t);
  r.seed("package.json", "{\"seed\":1}");
  r.seed("fixtures.ts", "seed fixtures");
  r.put("package.json", "{\"seed\":1}");
  r.put("fixtures.ts", "app fixtures");
  r.put("flows/a.spec.ts", "a");

  await r.capture({ executedGreen: ["flows/a.spec.ts"] });

  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["fixtures.ts", "flows/a.spec.ts"]);
});

test("a stored file that has since become the seed's own is dropped at the next capture", async (t) => {
  const r = rig(t);
  r.put("package.json", "{\"v\":1}");
  await r.capture({});
  r.seed("package.json", "{\"v\":1}");

  const result = await r.capture({ runId: "run-2" });

  assert.equal(result.dropped, 1);
});

test("an engine seed upgrade reaches an app whose cold working copy is restored, and what the app authored is kept", async (t) => {
  const r = rig(t);
  r.seed("package.json", "{\"playwright\":\"1.60.0\"}");
  r.seed("playwright.config.ts", "seed config v1");
  r.put("package.json", "{\"playwright\":\"1.60.0\"}");
  r.put("playwright.config.ts", "seed config v1");
  r.put("flows/a.spec.ts", "a");
  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  r.put("pages/login.page.ts", "export class LoginPage {}");
  await r.capture({ executedGreen: ["flows/a.spec.ts"], authVerifiedSha256: sha(APP_LOGIN) });

  r.seed("playwright.config.ts", "seed config v2");
  r.seed("package.json", "{\"playwright\":\"1.61.0\"}");
  r.clean();
  await r.store().restore(root(r));

  assert.equal(r.read("playwright.config.ts"), "seed config v2");
  assert.equal(r.read("package.json"), "{\"playwright\":\"1.61.0\"}");
  assert.equal(r.read("flows/a.spec.ts"), "a");
  assert.equal(r.read(AUTH_SETUP_PATH), APP_LOGIN, "the app's login is not replaced by the seed's");
  assert.equal(r.read("pages/login.page.ts"), "export class LoginPage {}");
});

test("a stored file the app changed from the seed is restored over the seed", async (t) => {
  const r = rig(t);
  r.seed("package.json", "{\"seed\":1}");
  r.seed("fixtures.ts", "seed fixtures");
  r.put("package.json", "{\"seed\":1,\"extra\":true}");
  r.put("fixtures.ts", "app fixtures");
  await r.capture({});

  r.clean();
  await r.store().restore(root(r));

  assert.equal(r.read("package.json"), "{\"seed\":1,\"extra\":true}");
  assert.equal(r.read("fixtures.ts"), "app fixtures");
});

test("a working copy that already holds a project is not seeded by the restore", async (t) => {
  const r = rig(t);
  r.seed("package.json", "{\"seed\":1}");
  r.seed("eslint.config.js", "seed eslint");
  r.put("flows/a.spec.ts", "a");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  r.clean();
  r.put("package.json", "{\"the app's own\":1}");

  await r.store().restore(root(r));

  assert.equal(r.has("eslint.config.js"), false);
  assert.equal(r.read("package.json"), "{\"the app's own\":1}");
});

test("entries are classified: specs, the login, and everything else as support (the engine's own cleanup spec included)", () => {
  assert.equal(suiteEntryKind("flows/login.spec.ts"), "spec");
  assert.equal(suiteEntryKind("a.spec.mjs"), "spec");
  assert.equal(suiteEntryKind("cleanup.spec.ts"), "support");
  assert.equal(suiteEntryKind("auth.setup.ts"), "auth-setup");
  assert.equal(suiteEntryKind("sub/auth.setup.ts"), "support");
  assert.equal(suiteEntryKind("fixtures.ts"), "support");
});

test("git's staged listing is read per record: ordinary files below the suite directory only", () => {
  const listing = [
    "100644 aaa 0\te2e/flows/a.spec.ts",
    "100755 bbb 0\te2e/run.sh",
    "120000 ccc 0\te2e/link",
    "160000 ddd 0\te2e/sub",
    "100644 eee 2\te2e/conflict.ts",
    "100644 fff 0\tother/x.ts",
    "100644 ggg 0\te2e/name with\ttab.ts",
  ].join("\0") + "\0";
  assert.deepEqual([...parseStagedListing(listing, "e2e")], [["flows/a.spec.ts", { oid: "aaa" }], ["run.sh", { oid: "bbb" }], ["name with\ttab.ts", { oid: "ggg" }]]);
  assert.throws(() => parseStagedListing("100644 aaa 0 no-tab\0", "e2e"), /without a path/);
});

test("the git listing runs hardened and a failed or timed out git is thrown, never an empty listing", async () => {
  const calls: string[][] = [];
  const ok = gitListTracked({ run: async (req) => ((calls.push([...req.args]), { exitCode: 0, stdout: "100644 abc 0\te2e/a.ts\0", stderr: "", timedOut: false })) });
  assert.deepEqual([...(await ok("/nonexistent-mirror", "e2e"))], [["a.ts", { oid: "abc" }]]);
  assert.equal(calls[0]?.includes("ls-files"), true);
  const failed = gitListTracked({ run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal", timedOut: false }) });
  await assert.rejects(() => failed("/m", "e2e"), /failed \(exit 128\)/);
  const slow = gitListTracked({ run: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }) });
  await assert.rejects(() => slow("/m", "e2e"), /timed out/);
});

test("git blob ids follow git's own hashing, for both object formats", () => {
  assert.equal(gitBlobOid(Buffer.from("hello\n"), 40), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(gitBlobOid(Buffer.from("hello\n"), 64).length, 64);
});

test("a purge removes the whole store, and a store that was never made is a store removed", async (t) => {
  const r = rig(t);
  r.put("flows/a.spec.ts", "a");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  assert.equal(existsSync(r.storeDir), true);
  deleteSuiteStoreDir(r.storeDir);
  assert.equal(existsSync(r.storeDir), false);
  assert.doesNotThrow(() => deleteSuiteStoreDir(r.storeDir));
  assert.equal(existsSync(join(r.base, "data", "suites")), true, "only the app's own directory goes");
});

test("a purge refuses what is not a directory rather than deleting it", (t) => {
  const r = rig(t);
  mkdirSync(dirname(r.storeDir), { recursive: true });
  writeFileSync(r.storeDir, "not a directory");
  assert.throws(() => deleteSuiteStoreDir(r.storeDir), /not a directory/);
  assert.equal(readFileSync(r.storeDir, "utf8"), "not a directory");
});

/* ── seeding: the harness's warm start loads a snapshot into the store, replacing whatever it held ── */

const files = (entries: Record<string, string>): Map<string, Buffer> => new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text)]));

test("a seeded store restores to exactly the snapshot, and the snapshot's login is the verified one", async (t) => {
  const r = rig(t);
  const result = await r.store().seed(files({ "package.json": "{}", "flows/a.spec.ts": "a", [AUTH_SETUP_PATH]: APP_LOGIN }), { label: "w1" });
  assert.equal(result.entries, 3);
  assert.equal(r.manifest().auth?.status, "verified");
  assert.equal(r.manifest().auth?.verifiedBy.runId, "seed:w1");

  r.clean();
  const restored = await r.store().restore(root(r));
  assert.deepEqual({ ...restored, digest: undefined }, { restored: 3, trackedWins: 0, overlaid: 0, authRestored: true, digest: undefined });
  assert.equal(r.read(AUTH_SETUP_PATH), APP_LOGIN);
});

test("a seeded file at a path git tracks is restored over git's content: both arms of a campaign start from the whole snapshot", async (t) => {
  const r = rig(t);
  await r.store().seed(files({ "flows/a.spec.ts": "warm snapshot a", "package.json": "{}" }), { label: "w5" });
  r.tracked.set("flows/a.spec.ts", { oid: gitBlobOid(Buffer.from("what git has at this commit"), 40) });

  r.clean();
  const restored = await r.store().restore(root(r));

  assert.deepEqual({ restored: restored.restored, trackedWins: restored.trackedWins, overlaid: restored.overlaid }, { restored: 1, trackedWins: 0, overlaid: 1 });
  assert.equal(r.read("flows/a.spec.ts"), "warm snapshot a");
});

test("a seeded file git tracks is kept by the capture of a run that did not touch it", async (t) => {
  const r = rig(t);
  await r.store().seed(files({ "flows/a.spec.ts": "warm snapshot a" }), { label: "w5" });
  r.tracked.set("flows/a.spec.ts", { oid: gitBlobOid(Buffer.from("what git has at this commit"), 40) });
  r.clean();
  await r.store().restore(root(r));

  const result = await r.capture({ runId: "run-2", executedGreen: [] });

  assert.equal(result.dropped, 0);
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/a.spec.ts"]);
});

test("seeding replaces what the store held: an earlier run's entries and blobs are gone", async (t) => {
  const r = rig(t);
  r.put("flows/old.spec.ts", "old");
  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  await r.capture({ executedGreen: ["flows/old.spec.ts"], authVerifiedSha256: sha(APP_LOGIN) });
  await r.store().seed(files({ "package.json": "{}", "flows/new.spec.ts": "new" }), { label: "w2" });

  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/new.spec.ts", "package.json"]);
  assert.equal(r.manifest().auth, undefined, "a snapshot without a login leaves no login record");
  assert.deepEqual(r.blobs(), [sha("new"), sha("{}")].sort());
});

test("seeding leaves out the stock login, credentials and sessions, as a capture does", async (t) => {
  const r = rig(t);
  await r.store().seed(files({ [AUTH_SETUP_PATH]: STOCK_SEED, ".env": "S=1", ".auth/user.json": "{}", "state.json": '{"cookies":[],"origins":[]}', "flows/a.spec.ts": "a" }), { label: "w3" });
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/a.spec.ts"]);
});

test("a snapshot over the store's limits is refused and the store is untouched", async (t) => {
  const r = rig(t);
  r.put("flows/keep.spec.ts", "keep");
  await r.capture({ executedGreen: ["flows/keep.spec.ts"] });
  await assert.rejects(() => r.store({ maxFileBytes: 8, maxTotalBytes: 4, maxEntries: 10 }).seed(files({ "flows/a.spec.ts": "aaaa", "flows/b.spec.ts": "bbbb" }), { label: "big" }), /over the store's limit/);
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/keep.spec.ts"]);
});

test("a seed repairs a store whose manifest is corrupt", async (t) => {
  const r = rig(t);
  mkdirSync(r.storeDir, { recursive: true });
  writeFileSync(join(r.storeDir, "manifest.json"), "{not json");
  await r.store().seed(files({ "flows/a.spec.ts": "a" }), { label: "repair" });
  assert.deepEqual(r.manifest().entries.map((e) => e.path), ["flows/a.spec.ts"]);
});

/* ── read-only: a campaign's runs read the store and never write it ── */

test("a read-only store restores, but a capture writes nothing and a demotion only takes the login out of the working copy", async (t) => {
  const r = rig(t);
  await r.store().seed(files({ "package.json": "{}", [AUTH_SETUP_PATH]: APP_LOGIN, "flows/a.spec.ts": "a" }), { label: "w4" });
  const before = readFileSync(join(r.storeDir, "manifest.json"), "utf8");
  const frozen = r.store(undefined, true);

  r.clean();
  assert.equal((await frozen.restore(root(r))).restored, 3);
  r.put("flows/b.spec.ts", "b");
  const captured = await frozen.capture({ ...root(r), runId: "r", sha: "s", executedGreen: r.ranGreen("flows/a.spec.ts", "flows/b.spec.ts") });
  assert.deepEqual({ admitted: captured.admitted, dropped: captured.dropped }, { admitted: 0, dropped: 0 });
  await frozen.demoteAuth(root(r), "x");

  assert.equal(r.has(AUTH_SETUP_PATH), false);
  assert.equal(readFileSync(join(r.storeDir, "manifest.json"), "utf8"), before, "the manifest is exactly as the seed left it");
});

test("a store holds a verified login only after a login signed in, and not when none was stored, it was demoted, or only specs are kept", async (t) => {
  const r = rig(t);
  assert.equal(suiteStoreHoldsVerifiedLogin(r.storeDir), false, "no store at all");

  r.put("flows/a.spec.ts", "a");
  await r.capture({ executedGreen: ["flows/a.spec.ts"] });
  assert.equal(suiteStoreHoldsVerifiedLogin(r.storeDir), false, "specs alone are not a login");

  r.put(AUTH_SETUP_PATH, APP_LOGIN);
  await r.capture({ runId: "run-2", executedGreen: ["flows/a.spec.ts"], authVerifiedSha256: sha(APP_LOGIN) });
  assert.equal(suiteStoreHoldsVerifiedLogin(r.storeDir), true);

  await r.store().demoteAuth(root(r), "the restored login failed");
  assert.equal(suiteStoreHoldsVerifiedLogin(r.storeDir), false, "a demoted login is not verified");
});

test("a manifest that cannot be read is an error, not an answer", (t) => {
  const r = rig(t);
  mkdirSync(r.storeDir, { recursive: true });
  writeFileSync(join(r.storeDir, "manifest.json"), "not json");
  assert.throws(() => suiteStoreHoldsVerifiedLogin(r.storeDir), /manifest/);
});
