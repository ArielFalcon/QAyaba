import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneMirrors,
  computeActiveRepoSlugs,
  defaultMirrorPruneDeps,
  repoSlug,
  PRUNE_MAX_AGE_MS,
  type MirrorEntry,
  type MirrorPruneDeps,
} from "./mirror-prune";
import { DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR } from "../paths";

const NOW = 1_750_000_000_000;
const FRESH = NOW - 60_000;
const STALE = NOW - PRUNE_MAX_AGE_MS - 60_000; /* a minute past the 7-day window */

interface StubOverrides {
  entries?: MirrorEntry[];
  configured?: string[];
  active?: string[];
  remove?: (path: string) => void;
  directorySize?: (path: string) => number;
  listThrows?: boolean;
}

function makeDeps(overrides: StubOverrides = {}): {
  deps: MirrorPruneDeps;
  removed: string[];
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
  const removed: string[] = [];
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const deps: MirrorPruneDeps = {
    mirrorRoot: "/mirrors",
    listMirrorDirs: () => {
      if (overrides.listThrows) throw new Error("ENOENT");
      return overrides.entries ?? [];
    },
    remove: overrides.remove ?? ((path) => removed.push(path)),
    directorySize: overrides.directorySize ?? (() => 1024),
    configuredRepoSlugs: () => new Set(overrides.configured ?? []),
    activeRepoSlugs: () => new Set(overrides.active ?? []),
    now: () => NOW,
    log: (level, message, meta) => logs.push({ level, message, meta }),
  };
  return { deps, removed, logs };
}

const entry = (name: string, mtimeMs: number): MirrorEntry => ({ name, path: `/mirrors/${name}`, mtimeMs });

test("the directory holding an experiment's throwaway working copies is never pruned, however old and whatever the configured apps", () => {
  const { deps, removed } = makeDeps({ entries: [entry(EXPERIMENT_COPIES_DIR, STALE), entry("gone__repo", STALE)], configured: [] });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["gone__repo"]);
  assert.deepEqual(removed, ["/mirrors/gone__repo"]);
});

test("the directory holding an experiment's warm-start snapshots is never pruned, however old and whatever the configured apps", () => {
  const { deps, removed } = makeDeps({ entries: [entry(WARM_SNAPSHOTS_DIR, STALE), entry("gone__repo", STALE)], configured: [] });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["gone__repo"]);
  assert.deepEqual(removed, ["/mirrors/gone__repo"]);
});

test("the directory holding the workspaces of a run's sidekicks is never pruned, however old and whatever the configured apps", () => {
  const { deps, removed } = makeDeps({ entries: [entry(DELEGATIONS_DIR, STALE), entry("gone__repo", STALE)], configured: [] });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["gone__repo"]);
  assert.deepEqual(removed, ["/mirrors/gone__repo"]);
});

test("orphan mirror (repo not in any app config) is deleted even when fresh", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("gone__repo", FRESH)],
    configured: ["kept__repo"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["gone__repo"]);
  assert.deepEqual(removed, ["/mirrors/gone__repo"]);
});

test("configured mirror older than 7 days is deleted (re-cloned next run)", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("team__app", STALE)],
    configured: ["team__app"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["team__app"]);
  assert.deepEqual(removed, ["/mirrors/team__app"]);
});

test("configured and fresh mirror is kept", () => {
  const { deps, removed } = makeDeps({
    entries: [entry("team__app", FRESH)],
    configured: ["team__app"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(removed, []);
});

test("active-run guard: the running job's mirror is never deleted, orphaned or stale", () => {
  const { deps, removed } = makeDeps({
    entries: [
      entry("active__orphan", FRESH),
      entry("active__stale", STALE), /* configured but stale, and active */
      entry("inactive__orphan", FRESH), /* orphan, NOT active → deleted */
    ],
    configured: ["active__stale"],
    active: ["active__orphan", "active__stale"],
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["inactive__orphan"]);
  assert.deepEqual(removed, ["/mirrors/inactive__orphan"]);
});

test("a failing delete is logged as a warning and does not stop the pass", () => {
  const removed: string[] = [];
  const { deps, logs } = makeDeps({
    entries: [entry("breaks__repo", FRESH), entry("ok__repo", FRESH)],
    configured: [],
    remove: (path) => {
      if (path.includes("breaks")) throw new Error("EBUSY");
      removed.push(path);
    },
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, ["ok__repo"]);
  assert.deepEqual(removed, ["/mirrors/ok__repo"]);
  assert.ok(logs.some((l) => l.level === "warn" && l.message.includes("failed to delete")));
});

test("freedBytes sums the size of deleted mirrors only", () => {
  const sizes: Record<string, number> = { "/mirrors/a__a": 100, "/mirrors/b__b": 200, "/mirrors/c__c": 999 };
  const { deps } = makeDeps({
    entries: [entry("a__a", FRESH), entry("b__b", FRESH), entry("c__c", FRESH)],
    configured: ["c__c"], /* kept — its size must not count */
    directorySize: (path) => sizes[path] ?? 0,
  });
  const result = pruneMirrors(deps);
  assert.equal(result.freedBytes, 300);
});

test("an unreadable mirrors root logs a warning and prunes nothing", () => {
  const { deps, removed, logs } = makeDeps({ listThrows: true });
  const result = pruneMirrors(deps);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(removed, []);
  assert.ok(logs.some((l) => l.level === "warn" && l.message.includes("could not read")));
});

test("a summary line is logged only when something was deleted", () => {
  const pruned = makeDeps({ entries: [entry("x__y", FRESH)], configured: [] });
  pruneMirrors(pruned.deps);
  assert.ok(pruned.logs.some((l) => l.level === "info" && l.message === "pruned old mirrors"));

  const noop = makeDeps({ entries: [entry("x__y", FRESH)], configured: ["x__y"] });
  pruneMirrors(noop.deps);
  assert.equal(noop.logs.length, 0);
});

/* ── computeActiveRepoSlugs (the guard's inputs) ────────────────────────────── */

test("computeActiveRepoSlugs covers the running record's repo and triggerRepo", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "running", app: "front", triggerRepo: "team/service" }),
    queueCurrentRunId: () => "r1",
    getRecord: () => undefined,
    repoForApp: (app) => (app === "front" ? "team/front" : undefined),
  });
  assert.deepEqual([...slugs].sort(), ["team__front", "team__service"]);
});

test("computeActiveRepoSlugs ignores a record that is not running", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "enqueued", app: "front" }),
    queueCurrentRunId: () => null,
    getRecord: () => undefined,
    repoForApp: () => "team/front",
  });
  assert.equal(slugs.size, 0);
});

test("computeActiveRepoSlugs falls back to the queue's run id when DB and queue disagree", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => undefined,
    queueCurrentRunId: () => "q1",
    getRecord: (id) => (id === "q1" ? { app: "other", triggerRepo: "svc/repo" } : undefined),
    repoForApp: (app) => (app === "other" ? "team/other" : undefined),
  });
  assert.deepEqual([...slugs].sort(), ["svc__repo", "team__other"]);
});

test("computeActiveRepoSlugs tolerates a missing app config (repoForApp undefined)", () => {
  const slugs = computeActiveRepoSlugs({
    currentRun: () => ({ id: "r1", status: "running", app: "deleted-app", triggerRepo: "svc/repo" }),
    queueCurrentRunId: () => "r1",
    getRecord: () => undefined,
    repoForApp: () => undefined,
  });
  assert.deepEqual([...slugs], ["svc__repo"]);
});

test("repoSlug mirrors repo-mirror.ts directory naming", () => {
  assert.equal(repoSlug("owner/repo"), "owner__repo");
});

/* ── A sweep over a mirrors root: what the pass removes, keeps and logs ──────── */

test("a sweep over a mirrors root removes the orphans and the stale configured mirrors, and keeps everything else", () => {
  const sizes = new Map<string, number>();
  const names: Array<[string, number, number]> = [
    ["team__front", FRESH, 10],  /* configured, fresh: kept */
    ["team__service-api", FRESH, 20],  /* a service repo of an app, fresh: kept */
    ["team__stale", STALE, 30],  /* configured, idle past the window: removed */
    ["team__edge", NOW - PRUNE_MAX_AGE_MS, 40],  /* configured, idle exactly the window: kept */
    ["team__edge-over", NOW - PRUNE_MAX_AGE_MS - 1, 50],  /* configured, one millisecond past: removed */
    ["gone__repo", FRESH, 60],  /* no app names it: removed even when fresh */
    ["owner__repo.v2", FRESH, 70],  /* dotted name, not configured: removed */
    ["owner__my-repo", FRESH, 80],  /* dashed name, configured: kept */
    ["busy__repo", STALE, 90],  /* running job's mirror, orphaned and stale: kept */
    [".hidden", FRESH, 100],  /* a dot-directory that is not one of the reserved ones: an orphan, removed */
    [EXPERIMENT_COPIES_DIR, STALE, 110],
    [WARM_SNAPSHOTS_DIR, STALE, 120],
    [DELEGATIONS_DIR, STALE, 130],
  ];
  const entries = names.map(([name, mtimeMs, size]) => {
    sizes.set(`/mirrors/${name}`, size);
    return entry(name, mtimeMs);
  });
  const sized: string[] = [];
  const { deps, removed, logs } = makeDeps({
    entries,
    configured: ["team__front", "team__service-api", "team__stale", "team__edge", "team__edge-over", "owner__my-repo"],
    active: ["busy__repo"],
    directorySize: (path) => {
      sized.push(path);
      return sizes.get(path) ?? 0;
    },
  });
  const result = pruneMirrors(deps);
  const expected = ["team__stale", "team__edge-over", "gone__repo", "owner__repo.v2", ".hidden"];
  assert.deepEqual(result, { deleted: expected, freedBytes: 30 + 50 + 60 + 70 + 100 });
  assert.deepEqual(removed, expected.map((name) => `/mirrors/${name}`));
  assert.deepEqual(sized, removed, "a mirror is measured just before it is removed, and no other is measured");
  assert.deepEqual(logs, [
    { level: "info", message: "pruned old mirrors", meta: { deletedCount: 5, deleted: expected, freedBytes: 310, freedMB: 0 } },
  ]);
});

test("a mirror whose size cannot be measured is not removed and the pass goes on", () => {
  const { deps, removed, logs } = makeDeps({
    entries: [entry("a__a", FRESH), entry("b__b", FRESH)],
    configured: [],
    directorySize: (path) => {
      if (path.endsWith("a__a")) throw new Error("EIO");
      return 5;
    },
  });
  const result = pruneMirrors(deps);
  assert.deepEqual(result, { deleted: ["b__b"], freedBytes: 5 });
  assert.deepEqual(removed, ["/mirrors/b__b"]);
  assert.deepEqual(logs.map((l) => [l.level, l.message, l.meta?.path, l.meta?.error]), [
    ["warn", "pruneMirrors: failed to delete mirror", "/mirrors/a__a", "EIO"],
    ["info", "pruned old mirrors", undefined, undefined],
  ]);
});

test("an unreadable mirrors root logs the root it could not read", () => {
  const { deps, logs } = makeDeps({ listThrows: true });
  pruneMirrors(deps);
  assert.deepEqual(logs, [{ level: "warn", message: "pruneMirrors: could not read mirror directory", meta: { mirrorRoot: "/mirrors" } }]);
});

/* ── The same pass over real directories ─────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

function writeBytes(dir: string, name: string, bytes: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "x".repeat(bytes));
}

test("a pass over a real mirrors root removes what the rule picks, follows no link out of the root and counts the bytes it freed", () => {
  const scratch = mkdtempSync(join(tmpdir(), "qa-mirror-prune-"));
  const previousMirrorDir = process.env.MIRROR_DIR;
  try {
    const root = join(scratch, "mirrors");
    const outside = join(scratch, "outside");
    mkdirSync(root);
    writeBytes(outside, "precious.txt", 7);
    writeBytes(join(root, "team__front"), "a.txt", 11);
    writeBytes(join(root, "team__front", "node_modules", "dep"), "b.txt", 13);
    writeBytes(join(root, "team__stale"), "c.txt", 17);
    writeBytes(join(root, "gone__repo", "deep", "er"), "d.txt", 19);
    writeBytes(join(root, "owner__repo.v2"), "e.txt", 23);
    writeBytes(join(root, EXPERIMENT_COPIES_DIR), "f.txt", 1);
    writeBytes(join(root, WARM_SNAPSHOTS_DIR), "g.txt", 1);
    writeBytes(join(root, DELEGATIONS_DIR), "h.txt", 1);
    writeFileSync(join(root, "team__file"), "not a directory");  /* a file named like a mirror */
    symlinkSync(join(outside, "precious.txt"), join(root, "link__file"));  /* a link to a file */
    symlinkSync(outside, join(root, "link__outside"));  /* a link to a directory outside the root */
    const old = new Date(Date.now() - 8 * DAY_MS);
    utimesSync(join(root, "team__stale"), old, old);
    process.env.MIRROR_DIR = root;

    const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const deps: MirrorPruneDeps = {
      ...defaultMirrorPruneDeps(() => null),
      configuredRepoSlugs: () => new Set(["team__front", "team__stale"]),
      activeRepoSlugs: () => new Set(),
      log: (level, message, meta) => logs.push({ level, message, meta }),
    };
    const result = pruneMirrors(deps);

    assert.deepEqual(result.deleted.sort(), ["gone__repo", "link__outside", "owner__repo.v2", "team__stale"]);
    /* The link is measured through, as the pass always did: its target's bytes count (7), the link alone is removed. */
    assert.equal(result.freedBytes, 17 + 19 + 23 + 7);
    assert.deepEqual(readdirSync(root).sort(), [DELEGATIONS_DIR, EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR, "link__file", "team__file", "team__front"].sort());
    assert.ok(existsSync(join(outside, "precious.txt")), "nothing outside the root is touched");
    assert.ok(existsSync(join(root, "team__front", "node_modules", "dep", "b.txt")));
    assert.deepEqual(logs.map((l) => [l.level, l.message]), [["info", "pruned old mirrors"]]);
  } finally {
    if (previousMirrorDir === undefined) delete process.env.MIRROR_DIR;
    else process.env.MIRROR_DIR = previousMirrorDir;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a pass over a mirrors root that is not there logs a warning and removes nothing", () => {
  const scratch = mkdtempSync(join(tmpdir(), "qa-mirror-prune-"));
  const previousMirrorDir = process.env.MIRROR_DIR;
  try {
    process.env.MIRROR_DIR = join(scratch, "missing");
    const logs: string[] = [];
    const result = pruneMirrors({
      ...defaultMirrorPruneDeps(() => null),
      configuredRepoSlugs: () => new Set(),
      activeRepoSlugs: () => new Set(),
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    assert.deepEqual(result, { deleted: [], freedBytes: 0 });
    assert.deepEqual(logs, ["warn:pruneMirrors: could not read mirror directory"]);
  } finally {
    if (previousMirrorDir === undefined) delete process.env.MIRROR_DIR;
    else process.env.MIRROR_DIR = previousMirrorDir;
    rmSync(scratch, { recursive: true, force: true });
  }
});
