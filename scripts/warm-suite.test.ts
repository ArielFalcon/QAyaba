/* The warm start of the experiment: what a snapshot of a suite keeps and leaves out, what a restore makes of a mirror, and what the
   commands refuse. Real files under a temporary directory; the queue and the app config are fakes. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTH_SETUP_FILE, MANIFEST_FILE, STOCK_SEED_MARKER, createSnapshot, loadSnapshot,
  main, parseArguments, restoreSuite, specsTouchedSinceSnapshot, warmSnapshotDir, warmStatus, type WarmDeps,
} from "./warm-suite.ts";
import { MAX_FILE_BYTES } from "../qa-engine/src/shared-infrastructure/suite-tree.ts";

const STOCK_SEED = readFileSync(join(import.meta.dirname, "..", "config", "e2e", "auth.setup.ts"), "utf8");
const APP_LOGIN = "import { test as setup } from '@playwright/test';\nsetup('authenticate', async ({ page }) => { await page.goto('/login'); });\n";
const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

interface Sandbox {
  root: string;
  mirrorDir: string;
  e2eDir: string;
  warmRoot: string;
  put(rel: string, text: string | Buffer): void;
  read(rel: string): string;
  tree(): string[];
}

function sandbox(t: TestContext): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "warm-suite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mirrorDir = join(root, "mirrors", "org__app");
  const e2eDir = join(mirrorDir, "e2e");
  mkdirSync(e2eDir, { recursive: true });
  const put = (rel: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(e2eDir, rel)), { recursive: true });
    writeFileSync(join(e2eDir, rel), text);
  };
  const tree = (): string[] => (readdirSync(e2eDir, { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath: string; isDirectory(): boolean }>)
    .filter((e) => !e.isDirectory())
    .map((e) => join(e.parentPath, e.name).slice(e2eDir.length + 1))
    .sort();
  return { root, mirrorDir, e2eDir, warmRoot: join(root, "mirrors", ".warm"), put, read: (rel) => readFileSync(join(e2eDir, rel), "utf8"), tree };
}

/* A suite as a pipeline run leaves it: the app's login, a spec, install and run output, a session and credentials. */
function dirtySuite(s: Sandbox): void {
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  s.put("playwright.config.ts", "export default {};\n");
  s.put("flows/cart.spec.ts", "test('cart', () => {});\n");
  s.put(".qa/manifest.json", '{"specs":[]}\n');
  s.put(".qa/measured.json", '{"runs":9}\n');
  s.put(".qa/coverage/dump.json", "{}\n");
  s.put("node_modules/pkg/index.js", "module.exports = 1;\n");
  s.put("node_modules/.install-hash", "abc");
  s.put("test-results/trace.zip", "zip");
  s.put("playwright-report/index.html", "<html>");
  s.put(".auth/user.json", '{"cookies":[],"origins":[]}');
  s.put(".env", "DEV_TEST_PASS=hunter2\n");
  s.put("certs/client.p12", "p12");
  s.put("saved-login.json", '{"cookies":[{"name":"sid","value":"s3cret"}],"origins":[]}');
  s.put("run.log", "log line\n");
}

const snapshotOf = (s: Sandbox, label = "w1") =>
  createSnapshot({ mirrorDir: s.mirrorDir, e2eDir: s.e2eDir, labelDir: warmSnapshotDir(s.warmRoot, "demo", label), app: "demo", repo: "org/app", label, now: new Date("2026-10-11T10:00:00Z") });

/* ── what a snapshot keeps and leaves out ── */

test("a snapshot keeps the suite's own files with their hashes and leaves out install and run output, the login session and credentials", (t) => {
  const s = sandbox(t);
  dirtySuite(s);
  const manifest = snapshotOf(s);
  const kept = manifest.files.map((f) => f.path);
  assert.deepEqual(kept, [".qa/manifest.json", AUTH_SETUP_FILE, "flows/cart.spec.ts", "playwright.config.ts"]);
  assert.equal(manifest.files.find((f) => f.path === AUTH_SETUP_FILE)?.sha256, sha(APP_LOGIN));
  const left = new Map(manifest.excluded.map((x) => [x.path, x.reason]));
  for (const path of ["node_modules", "test-results", "playwright-report", ".auth", ".env", "certs/client.p12", "saved-login.json", "run.log", ".qa/measured.json", ".qa/coverage"]) {
    assert.ok(left.has(path), `${path} is reported as left out`);
  }
  const onDisk = readdirSync(join(warmSnapshotDir(s.warmRoot, "demo", "w1"), "e2e"), { recursive: true }).map(String);
  assert.equal(onDisk.some((p) => /node_modules|test-results|\.auth|\.env|client\.p12|saved-login|\.log/.test(p)), false, "nothing sensitive reached the snapshot's folder");
});

test("a snapshot never follows a link out of the suite: a linked secret or directory is left out and its target is not copied", (t) => {
  const s = sandbox(t);
  const outside = join(s.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  symlinkSync(join(outside, "secret.txt"), join(s.e2eDir, "notes.txt"));
  symlinkSync(outside, join(s.e2eDir, "linked-dir"));
  const manifest = snapshotOf(s);
  assert.deepEqual(manifest.files.map((f) => f.path), [AUTH_SETUP_FILE]);
  assert.deepEqual(manifest.excluded.map((x) => x.path).sort(), ["linked-dir", "notes.txt"]);
  const snapshotDir = warmSnapshotDir(s.warmRoot, "demo", "w1");
  assert.equal(readdirSync(snapshotDir, { recursive: true }).some((p) => String(p).includes("secret") || String(p).includes("linked")), false);
});

test("a suite directory that is itself a link is refused", (t) => {
  const s = sandbox(t);
  const real = join(s.root, "real-e2e");
  mkdirSync(real);
  rmSync(s.e2eDir, { recursive: true });
  symlinkSync(real, s.e2eDir);
  assert.throws(() => snapshotOf(s), /symbolic link/);
});

test("a label names one snapshot, and a snapshot that fails leaves nothing under its label", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  snapshotOf(s);
  assert.throws(() => snapshotOf(s), /already exists/);

  s.put("assets/huge.bin", Buffer.alloc(MAX_FILE_BYTES + 1));
  assert.throws(() => snapshotOf(s, "w2"), /larger than/);
  assert.equal(existsSync(warmSnapshotDir(s.warmRoot, "demo", "w2")), false);
  assert.deepEqual(readdirSync(join(s.warmRoot, "demo")), ["w1"], "no partial folder is left beside the snapshots");
});

/* ── loading ── */

test("a snapshot whose file no longer matches its manifest is refused rather than restored", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  snapshotOf(s);
  const dir = warmSnapshotDir(s.warmRoot, "demo", "w1");
  assert.equal(loadSnapshot(dir, "w1").files.get(AUTH_SETUP_FILE)?.toString("utf8"), APP_LOGIN);
  writeFileSync(join(dir, "e2e", AUTH_SETUP_FILE), "tampered");
  assert.throws(() => loadSnapshot(dir, "w1"), /corrupt/);
  assert.throws(() => loadSnapshot(join(s.warmRoot, "demo", "missing"), "missing"), /no snapshot/);
});

test("a manifest that names a path outside the snapshot is refused", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  snapshotOf(s);
  const dir = warmSnapshotDir(s.warmRoot, "demo", "w1");
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as { files: Array<{ path: string; sha256: string }> };
  manifest.files.push({ path: "../../outside", sha256: sha("x") });
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  assert.throws(() => loadSnapshot(dir, "w1"), /unsafe path/);
});

/* ── restore ── */

test("a restore leaves the suite equal to the snapshot: extra specs, directories and state go, changed files are replaced, missing ones come back, node_modules stays", (t) => {
  const s = sandbox(t);
  dirtySuite(s);
  snapshotOf(s);
  const snapshot = loadSnapshot(warmSnapshotDir(s.warmRoot, "demo", "w1"), "w1");

  /* a case ran: it left a spec, a directory, state, a session, a changed login and a deleted config */
  s.put("flows/new-feature.spec.ts", "left by the previous case\n");
  s.put("scratch/notes.md", "notes\n");
  s.put(".qa/analysis.json", "{}\n");
  s.put(".qa/manifest.json", '{"specs":["new-feature"]}\n');
  s.put(".auth/user.json", "{}");
  s.put(AUTH_SETUP_FILE, "overwritten\n");
  rmSync(join(s.e2eDir, "playwright.config.ts"));

  const summary = restoreSuite(snapshot, { mirrorDir: s.mirrorDir, e2eDir: s.e2eDir });
  assert.deepEqual(summary.added, ["playwright.config.ts"]);
  assert.deepEqual(summary.changed, [".qa/manifest.json", AUTH_SETUP_FILE]);
  assert.ok(["flows/new-feature.spec.ts", "scratch/", ".qa/analysis.json", ".auth/", ".qa/coverage/", ".qa/measured.json", "test-results/", "playwright-report/", ".env", "certs/", "run.log", "saved-login.json"].every((p) => summary.removed.includes(p)), `removed: ${summary.removed.join(", ")}`);
  assert.equal(summary.keptNodeModules, true);

  assert.equal(s.read(AUTH_SETUP_FILE), APP_LOGIN);
  assert.deepEqual(s.tree().filter((p) => !p.startsWith("node_modules/")), [".qa/manifest.json", AUTH_SETUP_FILE, "flows/cart.spec.ts", "playwright.config.ts"]);
  assert.equal(s.read("node_modules/.install-hash"), "abc", "the install is not repeated");

  const again = restoreSuite(snapshot, { mirrorDir: s.mirrorDir, e2eDir: s.e2eDir });
  assert.deepEqual([again.added, again.changed, again.removed], [[], [], []]);
  assert.equal(again.unchanged, 4);
});

test("a dry-run restore reports what it would do and changes nothing", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  snapshotOf(s);
  const snapshot = loadSnapshot(warmSnapshotDir(s.warmRoot, "demo", "w1"), "w1");
  s.put("flows/extra.spec.ts", "x\n");
  s.put(AUTH_SETUP_FILE, "changed\n");
  const summary = restoreSuite(snapshot, { mirrorDir: s.mirrorDir, e2eDir: s.e2eDir }, { dryRun: true });
  assert.deepEqual([summary.changed, summary.removed], [[AUTH_SETUP_FILE], ["flows/"]]);
  assert.equal(s.read(AUTH_SETUP_FILE), "changed\n");
  assert.equal(existsSync(join(s.e2eDir, "flows", "extra.spec.ts")), true);
});

test("a restore removes a planted link without touching what it points at, and replaces a linked directory with a real one", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  s.put("flows/cart.spec.ts", "test('cart', () => {});\n");
  snapshotOf(s);
  const snapshot = loadSnapshot(warmSnapshotDir(s.warmRoot, "demo", "w1"), "w1");

  const outside = join(s.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "mine");
  writeFileSync(join(outside, "cart.spec.ts"), "outside spec");
  rmSync(join(s.e2eDir, "flows"), { recursive: true });
  symlinkSync(outside, join(s.e2eDir, "flows"));
  symlinkSync(join(outside, "keep.txt"), join(s.e2eDir, "planted"));

  const summary = restoreSuite(snapshot, { mirrorDir: s.mirrorDir, e2eDir: s.e2eDir });
  assert.ok(summary.removed.includes("planted") && summary.removed.includes("flows"));
  assert.equal(lstatSync(join(s.e2eDir, "flows")).isDirectory(), true);
  assert.equal(s.read("flows/cart.spec.ts"), "test('cart', () => {});\n");
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "mine");
  assert.equal(readFileSync(join(outside, "cart.spec.ts"), "utf8"), "outside spec", "nothing was written through the link");
});

test("a restore into a directory that does not exist yet builds the suite from the snapshot", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  snapshotOf(s);
  const snapshot = loadSnapshot(warmSnapshotDir(s.warmRoot, "demo", "w1"), "w1");
  const copy = join(s.root, "copy");
  mkdirSync(copy);
  const summary = restoreSuite(snapshot, { mirrorDir: copy, e2eDir: join(copy, "e2e") });
  assert.deepEqual(summary.added, [AUTH_SETUP_FILE]);
  assert.equal(readFileSync(join(copy, "e2e", AUTH_SETUP_FILE), "utf8"), APP_LOGIN);
});

test("a restore refuses a suite directory that is a link", (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  snapshotOf(s);
  const snapshot = loadSnapshot(warmSnapshotDir(s.warmRoot, "demo", "w1"), "w1");
  const real = join(s.root, "real-e2e");
  mkdirSync(real);
  rmSync(s.e2eDir, { recursive: true });
  symlinkSync(real, s.e2eDir);
  assert.throws(() => restoreSuite(snapshot, { mirrorDir: s.mirrorDir, e2eDir: s.e2eDir }), /symbolic link/);
  assert.deepEqual(readdirSync(real), []);
});

/* ── is it warm ── */

test("a login is warm once it was written for the app, and cold while it is the stock seed, has the seed's marker or is missing", (t) => {
  const s = sandbox(t);
  const statusOf = (login: string | undefined, label: string) => {
    if (login !== undefined) s.put(AUTH_SETUP_FILE, login);
    else rmSync(join(s.e2eDir, AUTH_SETUP_FILE), { force: true });
    snapshotOf(s, label);
    return warmStatus(loadSnapshot(warmSnapshotDir(s.warmRoot, "demo", label), label));
  };
  assert.ok(STOCK_SEED.includes(STOCK_SEED_MARKER));
  const stock = statusOf(STOCK_SEED, "stock");
  assert.deepEqual([stock.warm, stock.carriesMarker, stock.stockSeed], [false, true, true]);
  const edited = statusOf(`${STOCK_SEED}// edited\n`, "edited");
  assert.deepEqual([edited.warm, edited.carriesMarker, edited.stockSeed], [false, true, false]);
  const rewritten = statusOf(APP_LOGIN, "rewritten");
  assert.deepEqual([rewritten.warm, rewritten.carriesMarker, rewritten.stockSeed], [true, false, false]);
  const absent = statusOf(undefined, "absent");
  assert.deepEqual([absent.warm, absent.present], [false, false]);
});

test("the specs a snapshot already held are not a case's own unless their content changed", (t) => {
  const s = sandbox(t);
  s.put("flows/held.spec.ts", "held\n");
  s.put("flows/edited.spec.ts", "before\n");
  const manifest = snapshotOf(s);
  const disk = new Map([["flows/held.spec.ts", sha("held\n")], ["flows/edited.spec.ts", sha("after\n")], ["flows/new.spec.ts", sha("new\n")]]);
  const touched = specsTouchedSinceSnapshot(["flows/held.spec.ts", "flows/edited.spec.ts", "flows/new.spec.ts", "flows/unreadable.spec.ts"], manifest, (spec) => disk.get(spec) ?? null);
  assert.deepEqual(touched, ["flows/edited.spec.ts", "flows/new.spec.ts", "flows/unreadable.spec.ts"]);
});

/* ── the commands ── */

function harness(s: Sandbox, over: Partial<WarmDeps> = {}) {
  const lines: string[] = [];
  const deps: WarmDeps = {
    assertQueueIdle: async () => {},
    warmRoot: () => s.warmRoot,
    primaryMirror: () => ({ repo: "org/app", mirrorDir: s.mirrorDir, e2eDir: s.e2eDir }),
    now: () => new Date("2026-10-11T10:00:00Z"),
    out: (line) => lines.push(line),
    ...over,
  };
  return { deps, lines, text: () => lines.join("\n") };
}
const busy = async (): Promise<void> => { throw new Error("the queue is busy"); };

test("snapshot and restore refuse a busy queue before touching anything, while verify and a dry-run restore do not need it", async (t) => {
  const s = sandbox(t);
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  const h = harness(s);
  assert.equal(await main(["snapshot", "--app", "demo", "--label", "w1"], h.deps), 0);

  const b = harness(s, { assertQueueIdle: busy });
  s.put("flows/extra.spec.ts", "x\n");
  assert.equal(await main(["snapshot", "--app", "demo", "--label", "w2"], b.deps), 1);
  assert.equal(existsSync(warmSnapshotDir(s.warmRoot, "demo", "w2")), false);
  assert.equal(await main(["restore", "--app", "demo", "--label", "w1"], b.deps), 1);
  assert.equal(existsSync(join(s.e2eDir, "flows", "extra.spec.ts")), true, "a refused restore changed nothing");
  assert.ok(b.text().includes("the queue is busy"));

  assert.equal(await main(["restore", "--app", "demo", "--label", "w1", "--dry-run"], b.deps), 0);
  assert.equal(await main(["verify", "--app", "demo", "--label", "w1"], b.deps), 0);
});

test("snapshot prints what was left out and whether the login is warm, and restore prints a diff summary", async (t) => {
  const s = sandbox(t);
  dirtySuite(s);
  const h = harness(s);
  assert.equal(await main(["snapshot", "--app", "demo", "--label", "w1"], h.deps), 0);
  assert.ok(h.text().includes(".env"), "the left-out files are named");
  assert.ok(h.text().includes("WARM"));

  s.put("flows/extra.spec.ts", "x\n");
  const r = harness(s);
  assert.equal(await main(["restore", "--app", "demo", "--label", "w1"], r.deps), 0);
  assert.ok(r.text().includes("flows/extra.spec.ts"), "the removed spec is listed");
  assert.equal(existsSync(join(s.e2eDir, "flows", "extra.spec.ts")), false);
});

test("verify exits nonzero while the snapshot's login is still the stock seed, and zero once it is the app's own", async (t) => {
  const s = sandbox(t);
  const h = harness(s);
  s.put(AUTH_SETUP_FILE, STOCK_SEED);
  await main(["snapshot", "--app", "demo", "--label", "cold"], h.deps);
  assert.equal(await main(["verify", "--app", "demo", "--label", "cold"], h.deps), 1);
  assert.ok(h.text().includes("COLD"));
  s.put(AUTH_SETUP_FILE, APP_LOGIN);
  await main(["snapshot", "--app", "demo", "--label", "warm"], h.deps);
  assert.equal(await main(["verify", "--app", "demo", "--label", "warm"], h.deps), 0);
  assert.equal(await main(["verify", "--app", "demo", "--label", "nope"], h.deps), 1);
});

test("arguments are validated: a known subcommand, an app and a label that cannot name a path, and --dry-run only for restore", () => {
  assert.equal(parseArguments(["restore", "--app", "demo", "--label", "w1", "--dry-run"]).ok, true);
  for (const bad of [[], ["frobnicate"], ["snapshot", "--app", "demo"], ["snapshot", "--label", "w1"], ["snapshot", "--app", "../x", "--label", "w1"], ["verify", "--app", "demo", "--label", "a/b"], ["snapshot", "--app", "demo", "--label", "w1", "--dry-run"], ["verify", "--app", "demo", "--label", "w1", "--nope"]]) {
    assert.equal(parseArguments(bad).ok, false, bad.join(" "));
  }
});
