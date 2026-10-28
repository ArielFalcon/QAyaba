/* The code-graph port over the codegraph engine, end to end on a recorded store: the workspace is exported from a real git
   commit, the engine's build/sync/status are a fake that installs the store recorded by the pinned engine (and its status),
   and every query runs the real store reader on it. What crosses the port is repo-relative, test files excluded, and carries
   the commit of the index it read. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodegraphCodeGraphAdapter, selectSeeds, type StoreSymbol } from "../../../src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts";
import { CodegraphEngine, STORE_READER_SCRIPT } from "../../../src/shared-infrastructure/code-graph/codegraph-engine.ts";
import { CodegraphStoreCache } from "../../../src/shared-infrastructure/code-graph/codegraph-store-cache.ts";
import { DEFAULT_MAX_OUTPUT_CHARS, type SandboxedBinaryRunner, type SandboxedRunRequest, type SandboxedRunResult } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { SandboxedBinaryRunnerAdapter } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { LanguageRegistry } from "../../../src/shared-kernel/language-id.ts";
import { BlastRadius } from "../../../src/shared-kernel/blast-radius.ts";
import { Sha } from "../../../src/shared-kernel/sha.ts";
import { DEFAULT_WALK_POLICY, type WalkPolicy } from "../../../src/shared-kernel/code/index.ts";
import { closeGitDir, git } from "../process-sandbox/git-fixtures.ts";
import { ChangeScopePortAdapter } from "../../../src/contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts";
import { fileImplementsPage, handlerServesOperation } from "../../../src/contexts/change-analysis/application/index.ts";
import { routeServesOperation } from "../../../src/contexts/service-topology/domain/cross-repo-impact.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "codegraph");
const STORE = join(FIXTURES, "store.db");
const STATUS = readFileSync(join(FIXTURES, "status.json"), "utf8");
const EXPLORE = readFileSync(join(FIXTURES, "explore.txt"), "utf8");
const REPO = (JSON.parse(readFileSync(join(FIXTURES, "repo.json"), "utf8")) as { files: Record<string, string> }).files;

const ok = (stdout = ""): SandboxedRunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

/* The engine as the pinned binary behaves on the recorded repo; the store reader runs for real. */
class FakeEngineRunner implements SandboxedBinaryRunner {
  readonly calls: string[] = [];
  status = STATUS;
  /* The store `init` installs, and the one `sync` leaves when set. */
  store = STORE;
  syncStore: string | undefined;
  fail: Partial<Record<"init" | "sync" | "status", SandboxedRunResult>> = {};
  /* The abort signal each call carried, engine verbs and store reads alike. */
  readonly signals: (AbortSignal | undefined)[] = [];

  async run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    this.signals.push(req.signal);
    if (req.command !== "codegraph") {
      /* The launcher's own output bound, not spawnSync's default of 1 MiB. */
      const r = spawnSync(req.command, req.args, { cwd: req.cwd, encoding: "utf8", maxBuffer: DEFAULT_MAX_OUTPUT_CHARS });
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
    }
    const verb = req.args[0] as "init" | "sync" | "status";
    this.calls.push(verb);
    const failure = this.fail[verb];
    if (failure) return { ...failure, stderr: failure.stderr.replaceAll("{cwd}", req.cwd) };
    if (verb === "init") copyFileSync(this.store, join(req.cwd, ".codegraph", "codegraph.db"));
    if (verb === "sync" && this.syncStore) copyFileSync(this.syncStore, join(req.cwd, ".codegraph", "codegraph.db"));
    if ((verb as string) === "explore") return ok(EXPLORE);
    return verb === "status" ? ok(this.status) : ok();
  }
}

interface Harness {
  root: string;
  mirror: string;
  sha: string;
  engine: FakeEngineRunner;
  cache: CodegraphStoreCache;
  adapter: CodegraphCodeGraphAdapter;
}

function harness(opts: { cache?: boolean; exclude?: string[]; root?: string; mirror?: string } = {}): Harness {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "cg-adapter-"));
  const mirror = opts.mirror ?? join(root, "org__shop");
  if (opts.mirror === undefined) {
    mkdirSync(mirror);
    git(mirror, "init", "-q");
    for (const [path, content] of Object.entries(REPO)) {
      mkdirSync(join(mirror, path, ".."), { recursive: true });
      writeFileSync(join(mirror, path), content);
    }
    git(mirror, "add", "-A");
    git(mirror, "commit", "-qm", "c");
    closeGitDir(mirror);
  }
  const engine = new FakeEngineRunner();
  const cache = new CodegraphStoreCache(join(root, "cache"));
  const work = mkdtempSync(join(root, "work-"));
  const adapter = new CodegraphCodeGraphAdapter({
    engine: new CodegraphEngine(engine, undefined, process.execPath),
    git: new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() }),
    ...(opts.cache === false ? {} : { cache }),
    workDir: () => work,
    sandbox: null,
    scope: { extensions: LanguageRegistry.extensions, manifests: LanguageRegistry.manifests, exclude: opts.exclude ?? [] },
    isTestFile: (f) => LanguageRegistry.isTestFile(f),
  });
  return { root, mirror, sha: git(mirror, "rev-parse", "HEAD"), engine, cache, adapter };
}

function commitAnother(h: Harness): string {
  writeFileSync(join(h.mirror, "web/src/app/shared/format.ts"), `${REPO["web/src/app/shared/format.ts"]}\n// touched\n`);
  git(h.mirror, "commit", "-qam", "touch");
  return git(h.mirror, "rev-parse", "HEAD");
}

const BUDGET = DEFAULT_WALK_POLICY;
/* The default policy with a fixed fan-in limit and the given expansion budget, so a test does not depend on the store's own distribution. */
const policyOf = (over: { depth?: number; fanInLimit?: number; expansions?: number; closures?: number } = {}): WalkPolicy => ({
  depth: over.depth ?? DEFAULT_WALK_POLICY.depth,
  fanIn: over.fanInLimit === undefined ? DEFAULT_WALK_POLICY.fanIn : { percentile: 99, floor: over.fanInLimit, ceiling: over.fanInLimit },
  expansions: over.expansions === undefined ? DEFAULT_WALK_POLICY.expansions : { base: over.expansions, perSeed: 0, floor: over.expansions, ceiling: over.expansions },
  closures: { expansions: over.closures ?? DEFAULT_WALK_POLICY.closures.expansions },
});
const FORMAT = "web/src/app/shared/format.ts";

test("a first index builds the store, validates it and publishes it to the cache with its provenance", async () => {
  const h = harness();
  try {
    const record = await h.adapter.syncTo(h.mirror, h.sha);
    assert.deepEqual(
      { repo: record.repo, engine: record.engine, version: record.engineVersion, sha: record.sha, outcome: record.outcome, nodes: record.nodeCount, edges: record.edgeCount },
      { repo: "org__shop", engine: "codegraph", version: "1.6.2", sha: h.sha, outcome: "built", nodes: 57, edges: 75 },
    );
    assert.deepEqual(h.engine.calls, ["init", "status"]);
    assert.equal(h.cache.meta("org__shop")?.sha, h.sha, "the cache's cursor is the commit the store was built at");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the cached store is synced at the same commit and at a new one, never rebuilt", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    h.engine.calls.length = 0;

    const reused = await h.adapter.syncTo(h.mirror, h.sha);
    assert.equal(reused.outcome, "reused");
    assert.deepEqual(h.engine.calls, ["sync", "status"], "the cursor is a claim: the engine's incremental sync always runs");

    const next = commitAnother(h);
    h.engine.calls.length = 0;
    const synced = await h.adapter.syncTo(h.mirror, next);
    assert.equal(synced.outcome, "synced");
    assert.deepEqual(h.engine.calls, ["sync", "status"]);
    assert.equal(h.cache.meta("org__shop")?.sha, next);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a cached store of another engine version is rebuilt, not reused", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    h.engine.status = STATUS.replace('"version":"1.6.2"', '"version":"1.7.0"');
    h.engine.calls.length = 0;

    const record = await h.adapter.syncTo(h.mirror, h.sha);

    assert.equal(record.outcome, "built");
    assert.deepEqual(h.engine.calls, ["sync", "status", "init", "status"]);
    assert.equal(h.cache.meta("org__shop")?.engineVersion, "1.7.0");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a cached store built from another workspace scope is rebuilt, not reused", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const narrower = harness({ root: h.root, mirror: h.mirror, exclude: ["web/src/app/profile/**"] });

    const record = await narrower.adapter.syncTo(h.mirror, h.sha);

    assert.equal(record.outcome, "built");
    assert.deepEqual(narrower.engine.calls, ["init", "status"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a failure's reason never names the run's paths", async () => {
  const h = harness();
  try {
    h.engine.fail.init = { exitCode: 1, stdout: "", stderr: `cannot parse {cwd}/web/src/app/x.ts under ${h.mirror}`, timedOut: false };
    const failed = await h.adapter.syncTo(h.mirror, h.sha);
    assert.equal(failed.outcome, "failed");
    assert.match(failed.reason ?? "", /cannot parse \.\/web\/src\/app\/x\.ts under \./);
    assert.equal((failed.reason ?? "").includes(h.root), false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a failed or timed-out build is recorded, never cached, and leaves every query unavailable", async () => {
  const h = harness();
  try {
    h.engine.fail.init = { exitCode: 1, stdout: "", stderr: "parse error", timedOut: false };
    const failed = await h.adapter.syncTo(h.mirror, h.sha);
    assert.equal(failed.outcome, "failed");
    assert.match(failed.reason ?? "", /parse error/);
    assert.equal(failed.nodeCount, null);
    assert.equal(h.cache.meta("org__shop"), undefined, "nothing reached the cache");
    const query = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), BUDGET);
    assert.equal(query.ok, false);

    h.engine.fail.init = { exitCode: null, stdout: "", stderr: "", timedOut: true };
    assert.equal((await h.adapter.syncTo(h.mirror, h.sha)).outcome, "timeout");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("an index that is not complete, or holds no symbol, is a failure", async () => {
  const h = harness();
  try {
    h.engine.status = STATUS.replace('"state":"complete"', '"state":"indexing"');
    assert.equal((await h.adapter.syncTo(h.mirror, h.sha)).outcome, "failed");
    h.engine.status = STATUS.replace('"nodeCount":57', '"nodeCount":0');
    const empty = await h.adapter.syncTo(h.mirror, h.sha);
    assert.equal(empty.outcome, "failed");
    assert.equal(empty.reason, "the index holds no symbol");
    assert.equal(h.cache.meta("org__shop"), undefined);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("without a cache every run builds and nothing is published", async () => {
  const h = harness({ cache: false });
  try {
    assert.equal((await h.adapter.syncTo(h.mirror, h.sha)).outcome, "built");
    assert.equal((await h.adapter.syncTo(h.mirror, h.sha)).outcome, "built");
    assert.equal(existsSync(join(h.root, "cache")), false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("impactedSymbols seeds the symbol around each touched line and walks to the code that reaches it, test files and routes left out", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const changed = BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map([[FORMAT, new Set([2])]]));

    const report = await h.adapter.impactedSymbols(h.mirror, changed, BUDGET);

    assert.ok(report.ok);
    assert.equal(report.value.indexedSha, h.sha);
    assert.equal(report.value.truncated, false);
    assert.deepEqual(report.value.symbols.map((s) => [s.depth, s.file, s.symbol]), [
      [0, FORMAT, "formatMoney"],
      [1, "web/src/app/orders/orders.page.ts", "OrdersPage"],
      [1, "web/src/app/orders/orders.page.ts", "total"],
      [1, "web/src/app/profile/profile.page.ts", "ProfilePage"],
      [1, "web/src/app/profile/profile.page.ts", "balance"],
    ]);
    assert.deepEqual(report.value.symbols.find((s) => s.symbol === "total")?.via, { file: FORMAT, symbol: "formatMoney" });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("impactedSymbols seeds every symbol of a changed file the diff gave no lines for, and a seed the expansion budget leaves open is partial", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);

    const whole = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), BUDGET);
    assert.ok(whole.ok);
    assert.deepEqual(whole.value.symbols.filter((s) => s.depth === 0).map((s) => s.symbol), ["formatMoney", "roundCents"]);

    const cut = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), policyOf({ expansions: 0 }));
    assert.ok(cut.ok);
    assert.equal(cut.value.truncated, true);
    assert.deepEqual(cut.value.partialSeeds?.map((s) => s.symbol), ["formatMoney", "roundCents"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a change to test files only reaches nothing", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), ["web/src/app/orders/orders.page.spec.ts"]), BUDGET);
    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols, []);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("callersOf walks from named symbols across a backend's layers; a name the index lacks is absent", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const report = await h.adapter.callersOf(
      h.mirror,
      [{ file: "api/src/main/java/demo/repo/OrderRepository.java", symbol: "loadAll" }, { file: "api/src/main/java/demo/repo/OrderRepository.java", symbol: "missing" }],
      BUDGET,
    );
    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => `${s.depth} ${s.symbol}`), [
      "0 loadAll",
      "1 OrderService",
      "1 findAll",
      "2 OrderController",
      "2 listOrders",
    ]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("routes name a backend handler's verb and path and a frontend page's path, with the symbol each points at", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const routes = await h.adapter.routes(h.mirror);
    assert.ok(routes.ok);
    assert.deepEqual(routes.value, [
      { file: "api/src/main/java/demo/web/OrderController.java", line: 16, method: "GET", path: "/api/orders", target: { file: "api/src/main/java/demo/web/OrderController.java", symbol: "listOrders", kind: "method" } },
      { file: "web/src/app/app.routes.ts", line: 6, path: "/orders", target: { file: "web/src/app/orders/orders.page.ts", symbol: "OrdersPage", kind: "class" } },
      { file: "web/src/app/app.routes.ts", line: 7, path: "/profile", target: { file: "web/src/app/profile/profile.page.ts", symbol: "ProfilePage", kind: "class" } },
    ]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the same change walked twice in a run reads the index once; another change, or a new index, reads it again", async () => {
  const h = harness();
  const reads = () => h.engine.signals.length - h.engine.calls.length;
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const change = BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map([[FORMAT, new Set([2])]]));
    const before = reads();
    const first = await h.adapter.impactedSymbols(h.mirror, change, BUDGET);
    const afterFirst = reads();
    const second = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map([[FORMAT, new Set([2])]])), BUDGET);

    assert.ok(afterFirst > before);
    assert.equal(reads(), afterFirst, "an identical walk is answered from the run's first one");
    assert.deepEqual(second, first);

    await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), BUDGET);
    assert.ok(reads() > afterFirst, "a change with other lines is walked");
    const afterOther = reads();
    await h.adapter.syncTo(h.mirror, h.sha);
    const resynced = reads();
    await h.adapter.impactedSymbols(h.mirror, change, BUDGET);
    assert.ok(reads() > resynced && resynced >= afterOther, "a new index is walked again");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a store the engine writes in WAL mode is cached after the reader checked it", async () => {
  const h = harness();
  try {
    const store = join(h.root, "wal.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
    h.engine.store = store;

    const built = await h.adapter.syncTo(h.mirror, h.sha);

    assert.equal(built.outcome, "built");
    assert.notEqual(h.cache.meta("org__shop"), undefined, "the reader's read-only open leaves an empty log, which does not keep the store from the cache");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a touched module-level constant seeds the walk, and the code that references it is reached from it", async () => {
  const h = harness();
  try {
    const store = join(h.root, "constant.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES ('constant:cents', 'constant', 'CENTS', 'CENTS', ?, 'typescript', 4, 4, 0, 0, 0)").run(FORMAT);
    const formatMoney = (db.prepare("SELECT id FROM nodes WHERE name = 'formatMoney' AND kind = 'function'").get() as { id: string }).id;
    db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, 'constant:cents', 'references')").run(formatMoney);
    db.close();
    h.engine.store = store;
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map([[FORMAT, new Set([4])]])), BUDGET);

    assert.ok(report.ok);
    const at = (depth: number) => report.value.symbols.filter((s) => s.depth === depth).map((s) => s.symbol);
    assert.deepEqual(at(0), ["CENTS"]);
    assert.deepEqual(at(1), ["formatMoney"]);
    assert.ok(at(2).length > 0, "the walk goes on from the code that references the constant");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a reached value or class no code calls is reached through the code of the files that import it (dependency injection leaves no call edge)", async () => {
  const h = harness();
  try {
    const store = join(h.root, "injected.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    const api = "web/src/app/orders/orders.api.ts";
    db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES ('constant:token', 'constant', 'ORDERS_TOKEN', 'ORDERS_TOKEN', ?, 'typescript', 40, 40, 0, 0, 0)").run(api);
    db.prepare("INSERT INTO edges (source, target, kind) VALUES ('file:web/src/app/orders/orders.page.ts', 'constant:token', 'imports')").run();
    db.close();
    h.engine.store = store;
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [api], new Map([[api, new Set([40])]])), BUDGET);

    assert.ok(report.ok);
    const reached = report.value.symbols.map((s) => `${s.depth} ${s.symbol}`);
    assert.ok(reached.includes("0 ORDERS_TOKEN"));
    assert.ok(reached.includes("1 OrdersPage"), reached.join(", "));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the class a changed method belongs to is reported among the containers the change touches, never among the changed symbols", async () => {
  const h = harness();
  try {
    const store = join(h.root, "container.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    const guard = "web/src/app/auth/auth.guard.ts";
    const insert = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, ?, ?, ?, ?, 'typescript', ?, ?, 0, 0, 0)");
    insert.run("class:guard", "class", "AuthGuard", "AuthGuard", guard, 1, 10);
    insert.run("method:canActivate", "method", "canActivate", "AuthGuard::canActivate", guard, 3, 5);
    db.prepare("INSERT INTO edges (source, target, kind) VALUES ('class:guard', 'method:canActivate', 'contains')").run();
    db.close();
    h.engine.store = store;
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [guard], new Map([[guard, new Set([4])]])), BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.containers, [{ file: guard, symbol: "AuthGuard" }]);
    assert.deepEqual(report.value.symbols.filter((s) => s.depth === 0).map((s) => s.symbol), ["canActivate"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a function passed by reference is reached from the function it is passed to", async () => {
  const h = harness();
  try {
    const store = join(h.root, "fnref.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES ('function:items', 'function', 'buildItems', 'buildItems', ?, 'typescript', 20, 22, 0, 0, 0)").run(FORMAT);
    const roundCents = (db.prepare("SELECT id FROM nodes WHERE name = 'roundCents' AND kind = 'function'").get() as { id: string }).id;
    db.prepare("INSERT INTO edges (source, target, kind) VALUES ('function:items', ?, 'references')").run(roundCents);
    db.close();
    h.engine.store = store;
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map([[FORMAT, new Set([6])]])), BUDGET);

    assert.ok(report.ok);
    assert.ok(report.value.symbols.some((s) => s.symbol === "buildItems" && s.depth === 1), report.value.symbols.map((s) => `${s.depth} ${s.symbol}`).join(", "));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a handler route the engine names for any verb (ANY, ALL) is a backend route, not a page named after its verb", async () => {
  const h = harness();
  try {
    const store = join(h.root, "any-verb.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    const insert = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, 'route', ?, ?, ?, ?, ?, ?, 0, 0, 0)");
    insert.run("route:api/Any.java:3:ANY:/api/any", "ANY /api/any", "ANY /api/any", "api/Any.java", "java", 3, 3);
    insert.run("route:server/app.js:5:ALL:/api/all", "ALL /api/all", "ALL /api/all", "server/app.js", "javascript", 5, 5);
    db.close();
    h.engine.store = store;
    await h.adapter.syncTo(h.mirror, h.sha);

    const routes = await h.adapter.routes(h.mirror);

    assert.ok(routes.ok);
    assert.deepEqual(routes.value.filter((r) => r.file === "api/Any.java" || r.file === "server/app.js").map((r) => [r.method, r.path]), [["ANY", "/api/any"], ["ALL", "/api/all"]]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("explore answers the engine's text for the terms, from the run's index, with its commit", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const answer = await h.adapter.explore(h.mirror, ["formatMoney", "OrdersPage"], 12);
    assert.deepEqual(answer, { ok: true, value: { text: EXPLORE, indexedSha: h.sha } });
    assert.equal((await h.adapter.explore(h.mirror, [], 12)).ok, false, "no term, no question");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a repo the run did not index answers unavailable, never an empty graph", async () => {
  const h = harness();
  try {
    const changed = BlastRadius.of(Sha.of(h.sha), [FORMAT]);
    assert.equal((await h.adapter.impactedSymbols(h.mirror, changed, BUDGET)).ok, false);
    assert.equal((await h.adapter.callersOf(h.mirror, [{ file: FORMAT, symbol: "formatMoney" }], BUDGET)).ok, false);
    assert.equal((await h.adapter.routes(h.mirror)).ok, false);
    assert.equal((await h.adapter.explore(h.mirror, ["formatMoney"], 12)).ok, false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("selectSeeds takes the innermost symbol around a line, and a line between symbols seeds nothing", () => {
  const symbols: StoreSymbol[] = [
    { id: "c", file: "a.ts", symbol: "Cls", kind: "class", startLine: 1, endLine: 20 },
    { id: "m", file: "a.ts", symbol: "method", kind: "method", startLine: 3, endLine: 6 },
    { id: "f", file: "a.ts", symbol: "after", kind: "function", startLine: 25, endLine: 30 },
  ];
  const at = (lines: number[]) => selectSeeds(symbols, ["a.ts"], new Map([["a.ts", new Set(lines)]])).map((s) => s.symbol);

  assert.deepEqual(at([4]), ["method"]);
  assert.deepEqual(at([10]), ["Cls"]);
  assert.deepEqual(at([22]), []);
  assert.deepEqual(at([4, 26]), ["method", "after"]);
  assert.deepEqual(selectSeeds(symbols, ["a.ts"], undefined).map((s) => s.symbol), ["Cls", "method", "after"], "no lines: every symbol of the file");
});

test("over the recorded store the change's pages are proved through the engine's route nodes, from a frontend helper and from a backend repository", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const map = {
      builtAtSha: h.sha,
      routes: [{ path: "/orders" }, { path: "/profile" }],
      api: [{ operationId: "listOrders", method: "GET", path: "/api/orders" }],
      feBe: [{ route: "/orders", operationId: "listOrders" }],
    };
    const scopes = new ChangeScopePortAdapter({ codeGraph: h.adapter, budget: BUDGET, proofs: [fileImplementsPage, handlerServesOperation(routeServesOperation)], loadMap: () => map });
    const repoOf = (file: string, line: number) => ({ repo: "org/app", role: "primary" as const, repoDir: h.mirror, headSha: h.sha, changedFiles: [file], touchedLines: new Map([[file, new Set([line])]]) });
    const pagesOf = (scope: Awaited<ReturnType<typeof scopes.resolve>>) => scope.reach.filter((r) => r.entry.kind === "page").map((r) => ({ route: (r.entry as { route: string }).route, proof: r.evidence }));

    const fromHelper = await scopes.resolve({ specDir: "/s", repos: [repoOf(FORMAT, 2)] });
    assert.deepEqual(pagesOf(fromHelper).map((p) => [p.route, p.proof.length]).sort(), [["/orders", 3], ["/profile", 3]]);

    const repository = "api/src/main/java/demo/repo/OrderRepository.java";
    const fromBackend = await scopes.resolve({ specDir: "/s", repos: [repoOf(repository, 7)] });
    assert.deepEqual(pagesOf(fromBackend), [{
      route: "/orders",
      proof: [`${repository}::loadAll`, "api/src/main/java/demo/service/OrderService.java::findAll", "api/src/main/java/demo/web/OrderController.java::listOrders", "GET /api/orders (listOrders)", "page /orders"],
    }]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

/* A recorded store whose extraction version the store reader does not accept. */
function unsupportedStore(root: string): string {
  const path = join(root, "unsupported.db");
  copyFileSync(STORE, path);
  const db = new DatabaseSync(path);
  db.prepare("UPDATE project_metadata SET value = '999' WHERE key = 'indexed_with_extraction_version'").run();
  db.close();
  return path;
}

test("a store the reader does not accept is a logged failure, never an index that answers empty and never cached", async (t: TestContext) => {
  const h = harness();
  const warn = t.mock.method(console, "warn", () => {});
  try {
    h.engine.store = unsupportedStore(h.root);

    const record = await h.adapter.syncTo(h.mirror, h.sha);

    assert.equal(record.outcome, "failed");
    assert.match(record.reason ?? "", /store reader does not accept/);
    assert.equal(h.cache.meta("org__shop"), undefined);
    assert.equal((await h.adapter.routes(h.mirror)).ok, false, "unavailable, not an empty graph");
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /does not accept the store/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a cached store the sync leaves unreadable is rebuilt", async (t: TestContext) => {
  const h = harness();
  t.mock.method(console, "warn", () => {});
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    h.engine.syncStore = unsupportedStore(h.root);
    h.engine.calls.length = 0;

    const record = await h.adapter.syncTo(h.mirror, h.sha);

    assert.equal(record.outcome, "built");
    assert.deepEqual(h.engine.calls, ["sync", "status", "init", "status"]);
    assert.equal((await h.adapter.routes(h.mirror)).ok, true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a sync the run's abort ends keeps the cached store: an abort is not a slow sync", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const controller = new AbortController();
    controller.abort();
    /* The runner reports a child it ended on abort as timed out. */
    h.engine.fail.sync = { exitCode: null, stdout: "", stderr: "", timedOut: true };

    const aborted = await h.adapter.syncTo(h.mirror, h.sha, controller.signal);

    assert.notEqual(aborted.outcome, "reused");
    assert.notEqual(h.cache.meta("org__shop"), undefined, "the cached store survives the abort");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a sync that times out forgets the cached store, so the next run builds it instead of repeating the sync", async (t: TestContext) => {
  const h = harness();
  const warn = t.mock.method(console, "warn", () => {});
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    h.engine.fail.sync = { exitCode: null, stdout: "", stderr: "", timedOut: true };
    h.engine.calls.length = 0;

    const timedOut = await h.adapter.syncTo(h.mirror, h.sha);

    assert.equal(timedOut.outcome, "timeout");
    assert.equal(h.cache.meta("org__shop"), undefined);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /timed out/);

    h.engine.calls.length = 0;
    const next = await h.adapter.syncTo(h.mirror, h.sha);
    assert.equal(next.outcome, "built");
    assert.deepEqual(h.engine.calls, ["init", "status"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the abort signal the index build is given reaches every engine process and every store read of that run", async () => {
  const controller = new AbortController();
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha, controller.signal);
    await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), BUDGET);
    await h.adapter.explore(h.mirror, ["formatMoney"], 12);

    const engineCalls = h.engine.signals.slice(h.engine.signals.length - (h.engine.calls.length + 3));
    assert.ok(engineCalls.length > 0);
    assert.ok(engineCalls.every((s) => s === controller.signal), "no engine call runs without the signal");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a change of more files than the reader bound still answers, cut deterministically and reported truncated", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const pad = Array.from({ length: 2500 }, (_, i) => `zz/renamed/f${String(i).padStart(4, "0")}.ts`);
    const changed = BlastRadius.of(Sha.of(h.sha), [FORMAT, ...pad]);

    const report = await h.adapter.impactedSymbols(h.mirror, changed, BUDGET);

    assert.ok(report.ok, "not unavailable");
    assert.equal(report.value.truncated, true);
    assert.deepEqual(report.value.symbols.filter((s) => s.depth === 0).map((s) => s.symbol), ["formatMoney", "roundCents"], "the first files in order are kept");
    const again = await h.adapter.impactedSymbols(h.mirror, changed, BUDGET);
    assert.deepEqual(again, report);

    const many = Array.from({ length: 2500 }, (_, i) => ({ file: `zz/f${i}.ts`, symbol: `s${i}` }));
    const callers = await h.adapter.callersOf(h.mirror, [{ file: FORMAT, symbol: "formatMoney" }, ...many], BUDGET);
    assert.ok(callers.ok);
    assert.equal(callers.value.truncated, true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a changed file the read diff has no line for (a mode change, a pure rename) seeds nothing, and an unread diff seeds the whole file", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);

    const noLines = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map()), BUDGET);
    assert.ok(noLines.ok);
    assert.deepEqual(noLines.value.symbols, []);

    const unread = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), BUDGET);
    assert.ok(unread.ok);
    assert.deepEqual(unread.value.symbols.filter((s) => s.depth === 0).map((s) => s.symbol), ["formatMoney", "roundCents"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("selectSeeds leaves a changed file without lines out when the diff was read, and a deleted file seeds nothing", () => {
  const symbols: StoreSymbol[] = [{ id: "f", file: "a.ts", symbol: "f", kind: "function", startLine: 1, endLine: 5 }];
  assert.deepEqual(selectSeeds(symbols, ["a.ts", "gone.ts"], new Map([["b.ts", new Set([1])]])), []);
  assert.deepEqual(selectSeeds(symbols, ["a.ts", "gone.ts"], undefined).map((s) => s.symbol), ["f"]);
});

/* A walk whose budget cuts it keeps the same callers on every run, whatever order the store holds its edges in. */
test("when the budget leaves seeds partial, the answer does not depend on the order the store lists its edges", async () => {
  const h = harness();
  try {
    const answers: string[] = [];
    for (const order of [["e", "d", "c", "b", "a"], ["a", "b", "c", "d", "e"]]) {
      const store = join(h.root, `reordered-${order[0]}.db`);
      copyFileSync(STORE, store);
      const db = new DatabaseSync(store);
      const target = (db.prepare("SELECT id FROM nodes WHERE name = 'formatMoney' AND kind = 'function'").get() as { id: string }).id;
      const insertNode = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, 'function', ?, ?, 'a/first.ts', 'typescript', 1, 2, 0, 0, 0)");
      const insertEdge = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, 'calls')");
      for (const name of order) {
        insertNode.run(`function:${name}`, name, name);
        insertEdge.run(`function:${name}`, target);
      }
      db.close();
      h.engine.store = store;
      await h.adapter.syncTo(h.mirror, h.sha);

      const report = await h.adapter.callersOf(h.mirror, [{ file: FORMAT, symbol: "formatMoney" }, { file: "web/src/app/shared/format.ts", symbol: "roundCents" }], policyOf({ depth: 2, expansions: 2 }));

      assert.ok(report.ok);
      assert.equal(report.value.truncated, true);
      answers.push(JSON.stringify(report.value));
    }
    assert.equal(answers[0], answers[1]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

const NODE_SQL = "INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, ?, ?, ?, ?, 'typescript', ?, ?, 0, 0, 0)";

/* The recorded store plus the nodes and edges a test adds by SQL; `edges` are [source, target, kind, metadata?]. */
function storeWith(h: Harness, name: string, nodes: Array<[id: string, kind: string, name: string, file: string, start: number, end: number]>, edges: Array<[string, string, string, string?]>): void {
  const store = join(h.root, name);
  copyFileSync(STORE, store);
  const db = new DatabaseSync(store);
  const insertNode = db.prepare(NODE_SQL);
  for (const [id, kind, symbol, file, start, end] of nodes) insertNode.run(id, kind, symbol, symbol, file, start, end);
  const insertEdge = db.prepare("INSERT INTO edges (source, target, kind, metadata) VALUES (?, ?, ?, ?)");
  for (const [source, target, kind, metadata] of edges) insertEdge.run(source, target, kind, metadata ?? null);
  db.close();
  h.engine.store = store;
}

const CHAIN_NODES: Array<[string, string, string, string, number, number]> = [
  ["function:leaf", "function", "leaf", "a/chain.ts", 1, 3],
  ["function:mid", "function", "mid", "a/chain.ts", 5, 7],
  ["function:top", "function", "top", "a/chain.ts", 9, 11],
];

test("a reached symbol carries the lowest confidence of the edges on its path, and an edge without metadata counts as certain", async () => {
  const h = harness();
  try {
    storeWith(h, "confidence.db", CHAIN_NODES, [
      ["function:mid", "function:leaf", "calls", '{"confidence":0.5,"resolvedBy":"instance-method"}'],
      ["function:top", "function:mid", "calls", '{"confidence":0.8}'],
    ]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/chain.ts", symbol: "leaf" }], BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => [s.symbol, s.depth, s.confidence]), [["leaf", 0, 1], ["mid", 1, 0.5], ["top", 2, 0.5]]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("an edge whose metadata is not JSON, or whose confidence is not a number in [0, 1], reads as certain instead of failing the walk", async () => {
  const h = harness();
  try {
    storeWith(h, "bad-metadata.db", CHAIN_NODES, [["function:mid", "function:leaf", "calls", "not json"], ["function:top", "function:mid", "calls", '{"confidence":"0.2"}']]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/chain.ts", symbol: "leaf" }], BUDGET);

    assert.ok(report.ok, JSON.stringify(report));
    assert.deepEqual(report.value.symbols.map((s) => s.confidence), [1, 1, 1]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("an edge confidence above 1 or below 0 reads as certain", async () => {
  const h = harness();
  try {
    storeWith(h, "out-of-range.db", CHAIN_NODES, [["function:mid", "function:leaf", "calls", '{"confidence":5}'], ["function:top", "function:mid", "calls", '{"confidence":-1}']]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/chain.ts", symbol: "leaf" }], BUDGET);

    assert.ok(report.ok, JSON.stringify(report));
    assert.deepEqual(report.value.symbols.map((s) => s.confidence), [1, 1, 1]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("an edge whose metadata holds no confidence reads as certain", async () => {
  const h = harness();
  try {
    storeWith(h, "no-confidence.db", CHAIN_NODES, [["function:mid", "function:leaf", "calls", '{"resolvedBy":"import"}'], ["function:top", "function:mid", "calls"]]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/chain.ts", symbol: "leaf" }], BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => s.confidence), [1, 1, 1]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a changed symbol carries the range the store holds for it, and a reached one carries none", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const store = new DatabaseSync(STORE, { readOnly: true });
    const row = store.prepare("SELECT start_line AS start, end_line AS end FROM nodes WHERE name = 'formatMoney' AND kind = 'function'").get() as { start: number; end: number };
    store.close();

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT], new Map([[FORMAT, new Set([row.start])]])), BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.find((s) => s.symbol === "formatMoney")?.range, { start: row.start, end: row.end });
    assert.ok(report.value.symbols.filter((s) => s.depth > 0).every((s) => s.range === undefined));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the report says whether the seeds came from the touched lines, from whole files, or from no symbol at all", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const sha = Sha.of(h.sha);

    const lines = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(sha, [FORMAT], new Map([[FORMAT, new Set([2])]])), BUDGET);
    const whole = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(sha, [FORMAT]), BUDGET);
    const between = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(sha, [FORMAT], new Map([[FORMAT, new Set([100000])]])), BUDGET);
    const noSymbol = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(sha, ["web/src/no-such-file.ts"]), BUDGET);

    assert.deepEqual([lines, whole, between, noSymbol].map((r) => (r.ok ? r.value.seedBasis : "unavailable")), ["lines", "whole-file", "none", "none"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a changed free function seeds the walk and its free caller is reached one hop away", async () => {
  const h = harness();
  try {
    storeWith(h, "free.db", CHAIN_NODES, [["function:mid", "function:leaf", "calls", '{"confidence":1}']]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), ["a/chain.ts"], new Map([["a/chain.ts", new Set([2])]])), BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => [s.symbol, s.depth]), [["leaf", 0], ["mid", 1]]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a changed arrow component seeds the walk", async () => {
  const h = harness();
  try {
    storeWith(h, "arrow.db", [["component:Widget", "component", "Widget", "a/widget.tsx", 3, 9]], []);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), ["a/widget.tsx"], new Map([["a/widget.tsx", new Set([5])]])), BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => [s.symbol, s.kind, s.depth]), [["Widget", "component", 0]]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

/* `count` functions in `file`, named `<prefix>000`, `<prefix>001`, …, each one line long. */
const manyNodes = (prefix: string, file: string, count: number): Array<[string, string, string, string, number, number]> =>
  Array.from({ length: count }, (_, i) => {
    const name = `${prefix}${String(i).padStart(3, "0")}`;
    return [`function:${name}`, "function", name, file, i + 1, i + 1];
  });

test("no global symbol cap cuts a walk: every caller within the depth is reached while the expansion budget lasts", async () => {
  const h = harness();
  try {
    const callers = manyNodes("c", "a/callers.ts", 400);
    storeWith(h, "wide.db", [["function:leaf", "function", "leaf", "a/wide.ts", 1, 3], ...callers], callers.map(([id]): [string, string, string] => [id, "function:leaf", "calls"]));
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/wide.ts", symbol: "leaf" }], policyOf({ depth: 1, fanInLimit: 1000 }));

    assert.ok(report.ok);
    assert.equal(report.value.truncated, false);
    assert.equal(report.value.symbols.length, 401);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

const HUB_USERS = manyNodes("user", "a/users.ts", 4);
const HUB_NODES: Array<[string, string, string, string, number, number]> = [
  ["function:alpha", "function", "alpha", "a/seeds.ts", 1, 3],
  ["function:beta", "function", "beta", "a/seeds.ts", 5, 7],
  ["function:shared", "function", "shared", "a/hub.ts", 1, 9],
  ["function:bmid", "function", "bmid", "a/b.ts", 1, 3],
  ["function:btop", "function", "btop", "a/b.ts", 5, 7],
  ...HUB_USERS,
];
const HUB_EDGES: Array<[string, string, string]> = [
  ["function:shared", "function:alpha", "calls"],
  ["function:bmid", "function:beta", "calls"],
  ["function:btop", "function:bmid", "calls"],
  ...HUB_USERS.map(([id]): [string, string, string] => [id, "function:shared", "calls"]),
];
const HUB_SEEDS = [{ file: "a/seeds.ts", symbol: "alpha" }, { file: "a/seeds.ts", symbol: "beta" }];

test("a node whose fan-in is above the limit is a hub: recorded with the seeds that reach it, not expanded, while other paths go on", async () => {
  const h = harness();
  try {
    storeWith(h, "hub.db", HUB_NODES, HUB_EDGES);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, HUB_SEEDS, policyOf({ fanInLimit: 3 }));

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => `${s.depth} ${s.symbol}`), ["0 alpha", "0 beta", "1 bmid", "1 shared", "2 btop"]);
    assert.deepEqual(report.value.hubNodes?.map((n) => ({ symbol: n.symbol, fanIn: n.fanIn, depth: n.depth, seeds: n.seeds.map((s) => s.symbol) })), [{ symbol: "shared", fanIn: 4, depth: 1, seeds: ["alpha"] }]);
    assert.equal(report.value.truncated, false, "a pruned hub is not a cut");
    assert.equal(report.value.cost?.fanInLimit, 3);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a hub's closure is what it reaches within the depth left, and a closure the closure budget cuts is not complete", async () => {
  const h = harness();
  try {
    storeWith(h, "closure.db", HUB_NODES, HUB_EDGES);
    await h.adapter.syncTo(h.mirror, h.sha);

    const closed = await h.adapter.callersOf(h.mirror, HUB_SEEDS, policyOf({ fanInLimit: 3 }));
    const starved = await h.adapter.callersOf(h.mirror, HUB_SEEDS, policyOf({ fanInLimit: 3, closures: 0 }));

    assert.ok(closed.ok && starved.ok);
    const closure = closed.value.hubNodes?.[0]?.closure;
    assert.deepEqual(closure?.symbols.map((s) => `${s.depth} ${s.symbol}`), ["1 shared", "2 user000", "2 user001", "2 user002", "2 user003"]);
    assert.deepEqual(closure?.symbols.slice(1).map((s) => s.via?.symbol), ["shared", "shared", "shared", "shared"]);
    assert.equal(closure?.complete, true);
    assert.equal(starved.value.hubNodes?.[0]?.closure.complete, false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("when the expansion budget runs out mid-depth only the seeds with an open frontier are partial", async () => {
  const h = harness();
  try {
    storeWith(h, "partial.db", [...CHAIN_NODES, ["function:alone", "function", "alone", "a/zz.ts", 1, 2]], [["function:mid", "function:leaf", "calls"], ["function:top", "function:mid", "calls"]]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/chain.ts", symbol: "leaf" }, { file: "a/zz.ts", symbol: "alone" }], policyOf({ expansions: 2 }));

    assert.ok(report.ok);
    assert.deepEqual(report.value.symbols.map((s) => `${s.depth} ${s.symbol}`), ["0 leaf", "0 alone", "1 mid"]);
    assert.deepEqual(report.value.partialSeeds, [{ file: "a/chain.ts", symbol: "leaf" }]);
    assert.equal(report.value.truncated, true);
    assert.deepEqual(report.value.cost && [report.value.cost.expansions, report.value.cost.budget], [2, 2]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a node two seeds reach through a shared caller records both seeds, not only the one that got there first", async () => {
  const h = harness();
  try {
    storeWith(
      h,
      "shared-caller.db",
      [
        ["method:openMenuById", "function", "openMenuById", "a/home.page.ts", 20, 24],
        ["function:restaurant", "function", "restaurant", "a/card.ts", 1, 5],
        ["function:constructor", "function", "constructor", "a/home.page.ts", 2, 10],
      ],
      [["function:constructor", "method:openMenuById", "calls"], ["function:constructor", "function:restaurant", "calls"]],
    );
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/home.page.ts", symbol: "openMenuById" }, { file: "a/card.ts", symbol: "restaurant" }], BUDGET);

    assert.ok(report.ok);
    const shared = report.value.symbols.find((s) => s.symbol === "constructor");
    assert.deepEqual(shared?.seeds, [{ file: "a/card.ts", symbol: "restaurant", hops: 1 }, { file: "a/home.page.ts", symbol: "openMenuById", hops: 1 }]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a route node the walk reaches is kept in the report's routes, with the seeds that reach it, never among the symbols", async () => {
  const h = harness();
  try {
    storeWith(h, "route.db", [["component:OrdersPage", "component", "OrdersPage", "a/orders.page.ts", 1, 30], ["route:/orders", "route", "/orders", "a/app.routes.ts", 4, 4]], [["route:/orders", "component:OrdersPage", "references"]]);
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/orders.page.ts", symbol: "OrdersPage" }], BUDGET);

    assert.ok(report.ok);
    assert.deepEqual(report.value.routes, [{ file: "a/app.routes.ts", line: 4, path: "/orders", depth: 1, via: { file: "a/orders.page.ts", symbol: "OrdersPage" }, seeds: [{ file: "a/orders.page.ts", symbol: "OrdersPage", hops: 1 }] }]);
    assert.deepEqual(report.value.symbols.map((s) => s.symbol), ["OrdersPage"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("code in test files never calls: it is not walked and does not count toward a node's fan-in", async () => {
  const h = harness();
  try {
    storeWith(
      h,
      "test-callers.db",
      [...CHAIN_NODES, ["function:specA", "function", "specA", "a/chain.spec.ts", 1, 3], ["function:specB", "function", "specB", "a/chain.spec.ts", 5, 7]],
      [["function:mid", "function:leaf", "calls"], ["function:specA", "function:leaf", "calls"], ["function:specB", "function:leaf", "calls"], ["function:top", "function:mid", "calls"]],
    );
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: "a/chain.ts", symbol: "leaf" }], policyOf({ fanInLimit: 2 }));

    assert.ok(report.ok);
    assert.deepEqual(report.value.hubNodes, [], "two test callers and one caller of the app's code is a fan-in of one");
    assert.deepEqual(report.value.symbols.map((s) => s.symbol), ["leaf", "mid", "top"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the fan-in limit is the index's own in-degree percentile, clamped to the policy's floor and ceiling", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const testFiles = Object.keys(REPO).filter((f) => LanguageRegistry.isTestFile(f));
    const reader = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, STORE, JSON.stringify({ op: "degrees", percentile: 99, excludeFiles: testFiles })], { encoding: "utf8" });
    const p99 = (JSON.parse(reader.stdout) as { value: number }).value;
    const limitUnder = async (floor: number, ceiling: number) => {
      const r = await h.adapter.callersOf(h.mirror, [{ file: FORMAT, symbol: "formatMoney" }], { ...BUDGET, fanIn: { percentile: 99, floor, ceiling } });
      return r.ok ? r.value.cost?.fanInLimit : undefined;
    };

    assert.equal(await limitUnder(1, 1000), Math.max(1, p99));
    assert.equal(await limitUnder(50, 60), 50);
    assert.equal(await limitUnder(1, 1), 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a page two changed symbols reach through the same caller is credited to both, whichever reached the caller first", async () => {
  const h = harness();
  try {
    const home = "a/home.page.ts";
    const opener = { file: "a/home.helpers.ts", symbol: "openMenuById" };
    const card = { file: "a/restaurant-map-card.component.ts", symbol: "restaurant" };
    storeWith(
      h,
      "two-seeds.db",
      [
        ["function:openMenuById", "function", opener.symbol, opener.file, 1, 5],
        ["function:restaurant", "function", card.symbol, card.file, 1, 5],
        ["function:homeConstructor", "function", "constructor", home, 2, 10],
      ],
      [["function:homeConstructor", "function:openMenuById", "calls"], ["function:homeConstructor", "function:restaurant", "calls"]],
    );
    await h.adapter.syncTo(h.mirror, h.sha);
    const map = { builtAtSha: h.sha, routes: [{ path: "/home", implementationFiles: [home] }] };
    const scopes = new ChangeScopePortAdapter({ codeGraph: h.adapter, budget: BUDGET, proofs: [fileImplementsPage], loadMap: () => map });

    const scope = await scopes.resolve({
      specDir: "/s",
      repos: [{ repo: "org/app", role: "primary", repoDir: h.mirror, headSha: h.sha, changedFiles: [opener.file, card.file], touchedLines: new Map([[opener.file, new Set([2])], [card.file, new Set([2])]]) }],
    });

    assert.deepEqual(scope.hubs, []);
    assert.deepEqual(scope.reach.map((r) => [(r.entry as { route: string }).route, r.seeds.map((s) => s.symbol).sort()]), [["/home", ["openMenuById", "restaurant"]]]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf names the files that import each file, tests included, from the index's import edges", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const page = "web/src/app/orders/orders.page.ts";
    const spec = "web/src/app/orders/orders.page.spec.ts";

    const answered = await h.adapter.importersOf!(h.mirror, [page, FORMAT, spec, "web/src/app/no-such-file.ts"]);

    assert.equal(answered.ok, true);
    if (!answered.ok) return;
    assert.equal(answered.value.indexedSha, h.sha);
    assert.deepEqual(answered.value.files, [
      { file: page, indexed: true, importers: ["web/src/app/app.routes.ts", spec], users: ["web/src/app/app.routes.ts", spec], namedBy: ["web/src/app/app.routes.ts", spec], complete: true },
      { file: FORMAT, indexed: true, importers: [page, "web/src/app/profile/profile.page.ts"], users: [page, "web/src/app/profile/profile.page.ts"], namedBy: [], complete: true },
      { file: spec, indexed: true, importers: [], users: [], namedBy: [], complete: true },
      { file: "web/src/app/no-such-file.ts", indexed: false, importers: [], users: [], namedBy: [], complete: false },
    ]);
    assert.deepEqual(answered.value.dynamicLoaders, { files: [], complete: true });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

/* A store with a helper only a spec imports, in the shape the pinned engine leaves for a use it cannot see as an import. */
const HELPER_FILE = "web/src/app/shared/helper.ts";
const HELPER_SPEC = "web/src/app/shared/helper.spec.ts";
function storeWithHelper(root: string, extra: (db: DatabaseSync) => void): string {
  const store = join(root, "helper.db");
  copyFileSync(STORE, store);
  const db = new DatabaseSync(store);
  const node = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, ?, ?, ?, ?, 'typescript', 1, 5, 0, 0, 0)");
  node.run("file:helper", "file", "helper.ts", HELPER_FILE, HELPER_FILE);
  node.run("function:helper", "function", "buildHelper", "buildHelper", HELPER_FILE);
  node.run("file:helper-spec", "file", "helper.spec.ts", HELPER_SPEC, HELPER_SPEC);
  node.run("function:helper-spec", "function", "specCase", "specCase", HELPER_SPEC);
  db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)").run("file:helper-spec", "function:helper", "imports");
  extra(db);
  db.close();
  return store;
}
const importersFrom = async (h: Harness, store: string) => {
  h.engine.store = store;
  await h.adapter.syncTo(h.mirror, h.sha);
  const answered = await h.adapter.importersOf!(h.mirror, [HELPER_FILE]);
  assert.equal(answered.ok, true);
  return answered.ok ? answered.value : undefined;
};

test("importersOf reports a use that needs no import statement: an edge of another kind from production code", async () => {
  const h = harness();
  try {
    const store = storeWithHelper(h.root, (db) => {
      /* a same-package class: the index links the call, not an import */
      db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)").run("class:ddba1a21d9494dfc68fa6376e98b123e", "function:helper", "calls");
    });

    const report = await importersFrom(h, store);

    assert.deepEqual(report?.files, [{ file: HELPER_FILE, indexed: true, importers: [HELPER_SPEC], users: ["web/src/app/orders/orders.page.ts", HELPER_SPEC], namedBy: [], complete: true }]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf reports the production files that name a file the index could not link, and the ones that load modules by an unresolved name", async () => {
  const h = harness();
  try {
    const store = storeWithHelper(h.root, (db) => {
      const unresolved = db.prepare("INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail) VALUES (?, ?, ?, 1, 0, ?, 'typescript', 'failed', ?)");
      unresolved.run("constant:048f76842968940f49e69e3086fc228a", "buildHelper", "calls", "web/src/app/app.routes.ts", "buildHelper");
      unresolved.run("constant:048f76842968940f49e69e3086fc228a", "import().then", "calls", "web/src/app/lazy.routes.ts", "then");
      unresolved.run("constant:048f76842968940f49e69e3086fc228a", "import", "calls", "web/src/app/lazy.routes.ts", "import");
    });

    const report = await importersFrom(h, store);

    assert.deepEqual(report?.files[0]?.namedBy, ["web/src/app/app.routes.ts"]);
    assert.deepEqual(report?.dynamicLoaders, { files: ["web/src/app/lazy.routes.ts"], complete: true });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

/* ── module specifiers the index could not resolve, resolved by the language's own module resolution ── */

const LAZY_ROUTES = "web/src/app/lazy.routes.ts";
const ORDERS_PAGE = "web/src/app/orders/orders.page.ts";
const KIT_INDEX = "web/src/app/shared/kit/index.ts";
const KIT_SPEC = "web/src/app/shared/kit/kit.spec.ts";
const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } } });

/* The mirror's working copy gains `files`; the store records an unresolved reference per [file, name, kind, line, col]. */
function withSources(h: Harness, files: Record<string, string>, refs: Array<[file: string, name: string, kind: string, line: number, col: number]>, extra: (db: DatabaseSync) => void = () => {}): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(h.mirror, path, ".."), { recursive: true });
    writeFileSync(join(h.mirror, path), text);
  }
  return storeWithHelper(h.root, (db) => {
    const unresolved = db.prepare("INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail) VALUES (?, ?, ?, ?, ?, ?, 'typescript', 'failed', ?)");
    for (const [file, name, kind, line, col] of refs) unresolved.run("constant:048f76842968940f49e69e3086fc228a", name, kind, line, col, file, name.split(".").at(-1)!.replace("()", ""));
    extra(db);
  });
}
const colOf = (text: string, line: number, needle: string): number => text.split("\n")[line - 1]!.indexOf(needle);
const askImporters = async (h: Harness, store: string, files: string[]) => {
  h.engine.store = store;
  await h.adapter.syncTo(h.mirror, h.sha);
  const answered = await h.adapter.importersOf!(h.mirror, files);
  assert.equal(answered.ok, true);
  return answered.ok ? answered.value : undefined;
};

test("importersOf resolves a production loader's literal dynamic imports through the language's module resolution: the file it names gains it as an importer, and it no longer loads just anything", async () => {
  const h = harness();
  try {
    const lazy = [
      "export const routes = [",
      "  { path: 'orders', loadComponent: () => import('@app/orders/orders.page').then((m) => m.OrdersPage) },",
      "  { path: 'router', loadChildren: () => import('@angular/router') },",
      "];",
    ].join("\n");
    const store = withSources(h, { "web/tsconfig.json": TSCONFIG, [LAZY_ROUTES]: lazy }, [
      [LAZY_ROUTES, "import", "calls", 2, colOf(lazy, 2, "import(")],
      [LAZY_ROUTES, "import().then", "calls", 2, colOf(lazy, 2, "import(")],
      [LAZY_ROUTES, "import", "calls", 3, colOf(lazy, 3, "import(")],
    ]);

    const report = await askImporters(h, store, [HELPER_FILE, ORDERS_PAGE]);

    assert.deepEqual(report?.dynamicLoaders, { files: [], complete: true });
    assert.deepEqual(report?.files[0], { file: HELPER_FILE, indexed: true, importers: [HELPER_SPEC], users: [HELPER_SPEC], namedBy: [], complete: true });
    assert.ok(report?.files[1]?.importers.includes(LAZY_ROUTES), "the lazy route imports the page it loads");
    assert.ok(report?.files[1]?.users.includes(LAZY_ROUTES));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf keeps a loader whose specifier is computed, names no file, or cannot be read as one that may load anything", async () => {
  const h = harness();
  try {
    const computed = "export const load = (name: string) => import(`./pages/${name}.page`);\n";
    const missing = "export const load = () => import('./no-such-page');\n";
    const store = withSources(h, { "web/src/app/computed.ts": computed, "web/src/app/missing.ts": missing }, [
      ["web/src/app/computed.ts", "import", "calls", 1, colOf(computed, 1, "import(")],
      ["web/src/app/missing.ts", "import", "calls", 1, colOf(missing, 1, "import(")],
      [LAZY_ROUTES, "import", "calls", 1, 0],
    ]);

    const report = await askImporters(h, store, [HELPER_FILE]);

    assert.deepEqual(report?.dynamicLoaders, { files: ["web/src/app/computed.ts", LAZY_ROUTES, "web/src/app/missing.ts"], complete: true }, "the lazy routes file is not in the working copy");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf reads every production source whole: a load the index never recorded (import.meta.glob), require.context, a computed require, or a source it cannot read may load anything; a test's is no guard", async () => {
  const h = harness();
  try {
    const sources = {
      "web/src/app/glob.ts": "export const pages = import.meta.glob('./pages/*.ts');\n",
      "web/src/app/context.ts": "declare const require: any;\nexport const pages = require.context('./pages', true);\n",
      "web/src/app/computed.ts": "declare const require: any;\nexport const load = (name: string) => require(name);\n",
      "web/src/app/plain.ts": "export const env = import.meta.env;\nexport const page = () => import('@angular/router');\n",
      "web/src/app/glob.spec.ts": "export const pages = import.meta.glob('./pages/*.ts');\n",
      "web/real.ts": "export const real = 1;\n",
    };
    const store = withSources(h, { "web/package.json": JSON.stringify({ dependencies: { "@angular/router": "1" } }), ...sources }, [], (db) => {
      const node = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, 'file', ?, ?, ?, 'typescript', 1, 1, 0, 0, 0)");
      for (const file of [...Object.keys(sources), "web/src/app/linked.ts"]) node.run(`file:${file}`, file, file, file);
    });
    symlinkSync(join(h.mirror, "web/real.ts"), join(h.mirror, "web/src/app/linked.ts"));

    const report = await askImporters(h, store, [HELPER_FILE]);

    assert.deepEqual(report?.dynamicLoaders, { files: ["web/src/app/computed.ts", "web/src/app/context.ts", "web/src/app/glob.ts", "web/src/app/linked.ts"], complete: true });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf counts a production import the index could not resolve, and the module resolution can, as a use of the file it names; a test file's is a test use", async () => {
  const h = harness();
  try {
    const store = withSources(h, { "web/tsconfig.json": TSCONFIG, [KIT_INDEX]: "export const kit = 1;\n", [KIT_SPEC]: "import { kit } from '@app/shared/kit';\n" }, [
      [ORDERS_PAGE, "@app/shared/kit", "imports", 1, 0],
      [KIT_SPEC, "@app/shared/kit", "imports", 1, 0],
    ], (db) => {
      const node = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, ?, ?, ?, ?, 'typescript', 1, 1, 0, 0, 0)");
      node.run("file:kit", "file", "index.ts", KIT_INDEX, KIT_INDEX);
      node.run("constant:kit", "constant", "kit", "kit", KIT_INDEX);
      node.run("file:kit-spec", "file", "kit.spec.ts", KIT_SPEC, KIT_SPEC);
      db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)").run("file:kit-spec", "constant:kit", "imports");
    });

    const report = await askImporters(h, store, [KIT_INDEX]);

    assert.deepEqual(report?.files, [{ file: KIT_INDEX, indexed: true, importers: [ORDERS_PAGE, KIT_SPEC], users: [ORDERS_PAGE, KIT_SPEC], namedBy: [], complete: true }]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf counts every production file that imports a file through the same alias, from any directory, and none whose alias names no file", async () => {
  const h = harness();
  try {
    const billing = "web/src/app/billing/billing.page.ts";
    const store = withSources(h, { "web/tsconfig.json": TSCONFIG, [KIT_INDEX]: "export const kit = 1;\n" }, [
      [ORDERS_PAGE, "@app/shared/kit", "imports", 1, 0],
      [billing, "@app/shared/kit", "imports", 1, 0],
      [billing, "kit", "imports", 1, 9],
      ["web/src/app/stray.ts", "@app/shared/none", "imports", 1, 0],
    ]);

    const report = await askImporters(h, store, [KIT_INDEX]);

    assert.deepEqual(report?.files[0]?.importers, [billing, ORDERS_PAGE]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf over more unresolved imports than the reader lists reads every file's uses as a lower bound", async () => {
  const h = harness();
  try {
    const store = withSources(h, {}, [], (db) => {
      const unresolved = db.prepare("INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail) VALUES (?, ?, 'imports', 1, 0, ?, 'typescript', 'failed', ?)");
      db.exec("BEGIN");
      for (let i = 0; i <= 50_000; i++) unresolved.run("constant:048f76842968940f49e69e3086fc228a", `pkg-${i}`, `web/src/gen/m${i}.ts`, `pkg-${i}`);
      db.exec("COMMIT");
    });

    const report = await askImporters(h, store, [HELPER_FILE]);

    assert.equal(report?.files[0]?.complete, false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf over more files than the reader bound leaves the rest unread, never read as having no importer", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    const files = [FORMAT, ...Array.from({ length: 2100 }, (_, i) => `zz/f${String(i).padStart(4, "0")}.ts`)];

    const answered = await h.adapter.importersOf!(h.mirror, files);

    assert.equal(answered.ok, true);
    if (!answered.ok) return;
    assert.equal(answered.value.files.length, files.length);
    assert.equal(answered.value.files[0]!.importers.length, 2);
    const unread = answered.value.files.filter((f) => f.file !== FORMAT && f.indexed === false && f.complete === false);
    assert.equal(unread.length, 2100);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("importersOf of a repo the run did not index answers unavailable", async () => {
  const h = harness();
  try {
    assert.equal((await h.adapter.importersOf!(h.mirror, [FORMAT])).ok, false);
    assert.deepEqual(await h.adapter.importersOf!(h.mirror, []), { ok: true, value: { indexedSha: "", files: [], dynamicLoaders: { files: [], complete: true } } });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
