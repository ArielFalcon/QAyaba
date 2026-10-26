/* The code-graph port over the codegraph engine, end to end on a recorded store: the workspace is exported from a real git
   commit, the engine's build/sync/status are a fake that installs the store recorded by the pinned engine (and its status),
   and every query runs the real store reader on it. What crosses the port is repo-relative, test files excluded, and carries
   the commit of the index it read. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodegraphCodeGraphAdapter, selectSeeds, type StoreSymbol } from "../../../src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts";
import { CodegraphEngine } from "../../../src/shared-infrastructure/code-graph/codegraph-engine.ts";
import { CodegraphStoreCache } from "../../../src/shared-infrastructure/code-graph/codegraph-store-cache.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { SandboxedBinaryRunnerAdapter } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { LanguageRegistry } from "../../../src/contexts/change-analysis/domain/language-id.ts";
import { BlastRadius } from "../../../src/shared-kernel/blast-radius.ts";
import { Sha } from "../../../src/shared-kernel/sha.ts";
import { closeGitDir, git } from "../process-sandbox/git-fixtures.ts";
import { ChangePagesPortAdapter } from "../../../src/contexts/service-topology/infrastructure/adapters/change-pages-port.adapter.ts";

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
      const r = spawnSync(req.command, req.args, { cwd: req.cwd, encoding: "utf8" });
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

const BUDGET = { depth: 3, maxSymbols: 300 };
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

test("impactedSymbols seeds every symbol of a changed file the diff gave no lines for, and reports a walk the budget cut", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);

    const whole = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), BUDGET);
    assert.ok(whole.ok);
    assert.deepEqual(whole.value.symbols.filter((s) => s.depth === 0).map((s) => s.symbol), ["formatMoney", "roundCents"]);

    const cut = await h.adapter.impactedSymbols(h.mirror, BlastRadius.of(Sha.of(h.sha), [FORMAT]), { depth: 3, maxSymbols: 2 });
    assert.ok(cut.ok);
    assert.equal(cut.value.truncated, true);
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
    const pages = new ChangePagesPortAdapter({ codeGraph: h.adapter, repoDir: h.mirror, budget: BUDGET });
    const map = {
      builtAtSha: h.sha,
      routes: [{ path: "/orders" }, { path: "/profile" }],
      api: [{ operationId: "listOrders", method: "GET", path: "/api/orders" }],
      feBe: [{ route: "/orders", operationId: "listOrders" }],
    };

    const fromHelper = await pages.resolve({ map, sha: h.sha, changedFiles: [FORMAT], touchedLines: new Map([[FORMAT, new Set([2])]]), linked: new Set() });
    assert.deepEqual(fromHelper?.pages.map((p) => [p.route, p.proof.length]), [["/orders", 3], ["/profile", 3]]);

    const repository = "api/src/main/java/demo/repo/OrderRepository.java";
    const fromBackend = await pages.resolve({ map, sha: h.sha, changedFiles: [repository], touchedLines: new Map([[repository, new Set([7])]]), linked: new Set() });
    assert.deepEqual(fromBackend?.pages, [{
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
test("when the budget cuts a walk the nodes kept do not depend on the order the store lists its edges", async () => {
  const h = harness();
  try {
    const store = join(h.root, "reordered.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    const target = (db.prepare("SELECT id FROM nodes WHERE name = 'formatMoney' AND kind = 'function'").get() as { id: string }).id;
    const insertNode = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, 'function', ?, ?, 'a/first.ts', 'typescript', 1, 2, 0, 0, 0)");
    const insertEdge = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, 'calls')");
    for (const name of ["e", "d", "c", "b", "a"]) {
      insertNode.run(`function:${name}`, name, name);
      insertEdge.run(`function:${name}`, target);
    }
    db.close();
    h.engine.store = store;
    await h.adapter.syncTo(h.mirror, h.sha);

    const report = await h.adapter.callersOf(h.mirror, [{ file: FORMAT, symbol: "formatMoney" }], { depth: 1, maxSymbols: 3 });

    assert.ok(report.ok);
    assert.equal(report.value.truncated, true);
    assert.deepEqual(report.value.symbols.map((s) => s.symbol), ["formatMoney", "a", "b"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
