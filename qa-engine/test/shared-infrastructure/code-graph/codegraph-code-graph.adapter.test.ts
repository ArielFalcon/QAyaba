/* The code-graph port over the codegraph engine, end to end on a recorded store: the workspace is exported from a real git
   commit, the engine's build/sync/status are a fake that installs the store recorded by the pinned engine (and its status),
   and every query runs the real store reader on it. What crosses the port is repo-relative, test files excluded, and carries
   the commit of the index it read. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  fail: Partial<Record<"init" | "sync" | "status", SandboxedRunResult>> = {};

  async run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    if (req.command !== "codegraph") {
      const r = spawnSync(req.command, req.args, { cwd: req.cwd, encoding: "utf8" });
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
    }
    const verb = req.args[0] as "init" | "sync" | "status";
    this.calls.push(verb);
    const failure = this.fail[verb];
    if (failure) return { ...failure, stderr: failure.stderr.replaceAll("{cwd}", req.cwd) };
    if (verb === "init") copyFileSync(STORE, join(req.cwd, ".codegraph", "codegraph.db"));
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

test("the cached store is reused at the same commit and synced at a new one, never rebuilt", async () => {
  const h = harness();
  try {
    await h.adapter.syncTo(h.mirror, h.sha);
    h.engine.calls.length = 0;

    const reused = await h.adapter.syncTo(h.mirror, h.sha);
    assert.equal(reused.outcome, "reused");
    assert.deepEqual(h.engine.calls, ["status"]);

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
    assert.deepEqual(h.engine.calls, ["status", "init", "status"]);
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
