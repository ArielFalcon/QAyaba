/*
 * CodeGraphPort over the codegraph engine. Placement: shared-infrastructure, because more than one bounded context asks the
 * graph (the structural signal, the cross-repo impact, the change pages).
 *
 * `syncTo` builds the run's index of one repo: the workspace of the run's commit (codegraph-workspace.ts), the cached store
 * copied in and synced, or a first build, validated, and published back to the cache before any agent-influenced code runs
 * (codegraph-store-cache.ts). Every query then reads that workspace's store through the store reader, a child of the
 * launcher's graph profile. A repo the run did not index answers unavailable, never an empty graph.
 *
 * Nothing the engine names crosses this adapter: no node id, no absolute path, no engine format. Answers are repo-relative,
 * sorted and de-duplicated, and carry the commit of the index they read.
 */

import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { err, ok, type Result } from "../../shared-kernel/result.ts";
import type { BlastRadius, TouchedLines } from "../../shared-kernel/blast-radius.ts";
import type { CodeGraphPort } from "../../shared-kernel/ports/code-graph.port.ts";
import type { CodeExplorePort, ExploreAnswer } from "../../shared-kernel/ports/code-explore.port.ts";
import type { CodeGraphIndexRecord, CodeGraphUnavailable, GraphRoute, ImpactBudget, ImpactReport, ImpactedSymbol, IndexOutcome, LocalSymbolRef } from "../../shared-kernel/code/index.ts";
import type { Sandbox } from "../process-sandbox/sandbox.ts";
import type { SandboxedBinaryRunner } from "../process-sandbox/sandboxed-binary-runner.ts";
import { CODEGRAPH_ENGINE, storePathOf, type CodegraphEngine, type EngineFailure, type EngineStatus } from "./codegraph-engine.ts";
import { exportWorkspace, type WorkspaceScope } from "./codegraph-workspace.ts";
import { repoKeyOf, type CodegraphStoreCache } from "./codegraph-store-cache.ts";

/* A symbol as the store reader lists it. The id is the engine's and stays inside this adapter. */
export interface StoreSymbol {
  id: string;
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
}

interface WalkNode {
  id: string;
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
  depth: number;
  via?: LocalSymbolRef;
}

interface StoreRoute {
  name: string;
  file: string;
  line: number;
  target?: { file: string; symbol: string; kind: string };
}

/* A handler route: its verb (ANY and ALL are the engine's names for a handler that serves every verb) and its path. */
const HTTP_ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|ALL) (\S+)$/;

/* Module-level values the reader lists beside the code that runs: a touched one seeds the walk only where no code holds the line. */
const VALUE_KINDS: ReadonlySet<string> = new Set(["constant", "variable"]);

/*
 * The seeds of a change: for each touched line, the innermost symbol whose range holds it, or the module-level value declared
 * there when no code does; when the diff was not read at all,
 * every symbol of each changed file (its classes and every function and method in them, so the callers of a method are
 * reached, not only the users of its class). A line between symbols seeds nothing, and neither does a changed file the read
 * diff has no line for: a change of mode alone or a pure rename edits no symbol, so it must not spend the budget on all of
 * them. A deleted file has no symbol in the index of the run's commit either, so it seeds nothing (its callers' edges to it
 * do not exist in that index, and the parent commit's index is not built). Pure.
 */
export function selectSeeds(symbols: readonly StoreSymbol[], changedFiles: readonly string[], touched: TouchedLines | undefined): StoreSymbol[] {
  const byFile = new Map<string, StoreSymbol[]>();
  for (const s of symbols) (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
  const seeds = new Map<string, StoreSymbol>();
  for (const file of changedFiles) {
    const all = byFile.get(file) ?? [];
    const inFile = all.filter((s) => !VALUE_KINDS.has(s.kind));
    const values = all.filter((s) => VALUE_KINDS.has(s.kind));
    if (touched === undefined) {
      for (const s of inFile) seeds.set(s.id, s);
      continue;
    }
    const lines = touched.get(file);
    if (lines === undefined) continue;
    for (const line of lines) {
      let best: StoreSymbol | undefined;
      for (const s of inFile) {
        if (s.startLine > line || s.endLine < line) continue;
        if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
      }
      best ??= values.find((s) => s.startLine <= line && s.endLine >= line);
      if (best) seeds.set(best.id, best);
    }
  }
  return [...seeds.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

export interface CodegraphCodeGraphDeps {
  engine: CodegraphEngine;
  /* The trusted git runner the workspace is checked out with. */
  git: SandboxedBinaryRunner;
  /* The app's store cache; absent: every run builds from nothing and publishes nothing. */
  cache?: CodegraphStoreCache;
  /* The run's work directory (the launcher's), where the workspaces live and which the run's end removes. */
  workDir(): string;
  sandbox: Sandbox | null;
  scope: WorkspaceScope;
  /* A test file of a declared language, by its language's conventions: its routes and callers are not the app's. */
  isTestFile(file: string): boolean;
  now?: () => number;
}

interface Indexed {
  workspace: string;
  sha: string;
}

/* What the store was built from besides the commit: a store of another scope is never reused. */
function scopeKeyOf(scope: WorkspaceScope): string {
  const sorted = { extensions: [...scope.extensions].sort(), manifests: [...scope.manifests].sort(), exclude: [...scope.exclude].sort() };
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

export class CodegraphCodeGraphAdapter implements CodeGraphPort, CodeExplorePort {
  private readonly indexed = new Map<string, Indexed>();
  private readonly now: () => number;
  private readonly scopeKey: string;
  private runSignal: AbortSignal | undefined;
  /* The run's answered walks of a change, by index and question: the structural block and the change pages ask the same one. */
  private readonly walks = new Map<string, Promise<Result<ImpactReport, CodeGraphUnavailable>>>();

  constructor(private readonly deps: CodegraphCodeGraphDeps) {
    this.now = deps.now ?? Date.now;
    this.scopeKey = scopeKeyOf(deps.scope);
  }

  async syncTo(repoDir: string, sha: string, signal?: AbortSignal): Promise<CodeGraphIndexRecord> {
    /* One adapter per run: the signal the run's index build is given also bounds the run's later queries. */
    this.runSignal = signal;
    this.walks.clear();
    const started = this.now();
    const repo = repoKeyOf(basename(repoDir));
    let workspace = "";
    /* A reason is engine or git text: it names the run's paths, which never cross the adapter. */
    const clean = (reason: string): string => {
      let out = reason;
      for (const path of [workspace, repoDir]) if (path !== "") out = out.split(path).join(".");
      return out.slice(0, 400);
    };
    const record = (outcome: IndexOutcome, status: EngineStatus | null, reason?: string): CodeGraphIndexRecord => ({
      repo,
      engine: CODEGRAPH_ENGINE,
      engineVersion: status?.version ?? null,
      sha,
      outcome,
      durationMs: this.now() - started,
      nodeCount: status?.nodeCount ?? null,
      edgeCount: status?.edgeCount ?? null,
      ...(reason !== undefined ? { reason: clean(reason) } : {}),
    });
    const failed = (f: EngineFailure): CodeGraphIndexRecord => record(f.kind === "timeout" ? "timeout" : "failed", null, f.reason);

    this.indexed.delete(repoDir);
    try {
      workspace = join(this.deps.workDir(), `graph-${repo}`);
    } catch (e) {
      return record("failed", null, e instanceof Error ? e.message : String(e));
    }
    rmSync(workspace, { recursive: true, force: true });
    const exported = await exportWorkspace({ git: this.deps.git, mirrorDir: repoDir, sha, dir: workspace, scope: this.deps.scope, sandbox: this.deps.sandbox });
    if (!exported.ok) return record(exported.error.reason.startsWith("the commit holds no file") ? "skipped" : "failed", null, exported.error.reason);
    /* The workspace lies in the run's work dir, which the sandbox owns: what is published must be the directory built here. */
    const built = lstatSync(workspace);
    const identity = { dev: built.dev, ino: built.ino };

    const lock = this.deps.cache?.lock(repo);
    try {
      const cached = lock ? this.deps.cache!.meta(repo) : undefined;
      const usable = cached?.engine === CODEGRAPH_ENGINE && cached.scope === this.scopeKey && lock !== undefined && this.deps.cache!.copyIn(repo, workspace, this.deps.sandbox);
      let outcome: IndexOutcome = "built";
      let status: Result<EngineStatus, EngineFailure> | undefined;
      if (usable) {
        /* Always synced, even at the cached commit: the cache's cursor is only a claim about the store, and a sync recomputes just what differs. */
        const synced = await this.deps.engine.sync(workspace, signal);
        if (synced.ok) {
          const afterSync = await this.deps.engine.status(workspace, signal);
          if (afterSync.ok && afterSync.value.version === cached.engineVersion && (await this.readable(workspace, signal, clean))) {
            status = afterSync;
            outcome = cached.sha === sha ? "reused" : "synced";
          }
        } else if (signal?.aborted) {
          /* The runner reports a child the abort ended as timed out: the store was not slow, it stays cached. */
          return record("failed", null, "the run was aborted");
        } else if (synced.error.kind === "timeout") {
          /* The same sync would time out on the same store at every run, and none would resolve it: the store is forgotten so the next run builds it from nothing. */
          this.deps.cache!.discard(repo);
          console.warn(`[qa] the code-graph sync of ${repo} timed out (${clean(synced.error.reason)}); its cached store was discarded and the next run builds it from nothing`);
          return failed(synced.error);
        }
      }
      if (status === undefined) {
        if (signal?.aborted) return record("failed", null, "the run was aborted");
        rmSync(storePathOf(workspace), { force: true });
        const fresh = await this.deps.engine.build(workspace, signal);
        if (!fresh.ok) return failed(fresh.error);
        status = await this.deps.engine.status(workspace, signal);
        outcome = "built";
        if (status.ok && status.value.nodeCount > 0 && !(await this.readable(workspace, signal, clean))) {
          return record("failed", status.value, "the store reader does not accept the store the engine wrote");
        }
      }
      if (!status.ok) return failed(status.error);
      if (status.value.nodeCount === 0) return record("failed", status.value, "the index holds no symbol");
      if (lock && outcome !== "reused") {
        const published = this.deps.cache!.publish(repo, workspace, identity, {
          engine: CODEGRAPH_ENGINE,
          engineVersion: status.value.version,
          scope: this.scopeKey,
          sha,
          nodeCount: status.value.nodeCount,
          edgeCount: status.value.edgeCount,
          fileCount: status.value.fileCount,
          builtAt: new Date(this.now()).toISOString(),
        });
        if (!published.published) console.warn(`[qa] the code-graph store of ${repo} was not cached (${clean(published.reason)}); the next run indexes it again`);
      }
      this.indexed.set(repoDir, { workspace, sha });
      return record(outcome, status.value);
    } finally {
      lock?.release();
    }
  }

  /* Whether the store reader accepts the store in the workspace (its pinned schema and extraction version). A store it refuses answers every query empty, so it is never indexed; the reason is logged. */
  private async readable(workspace: string, signal: AbortSignal | undefined, clean: (reason: string) => string): Promise<boolean> {
    const probe = await this.deps.engine.read<{ ready: boolean }>(workspace, { op: "ping" }, signal);
    if (probe.ok && probe.value.ready === true) return true;
    console.warn(`[qa] the code-graph store reader does not accept the store (${probe.ok ? "no answer" : clean(probe.error.reason)})`);
    return false;
  }

  private indexOf(repoDir: string): Indexed | undefined {
    const entry = this.indexed.get(repoDir);
    return entry && existsSync(storePathOf(entry.workspace)) ? entry : undefined;
  }

  private async read<T>(repoDir: string, request: Record<string, unknown>): Promise<Result<{ value: T; sha: string }, CodeGraphUnavailable>> {
    const entry = this.indexOf(repoDir);
    if (!entry) return err({ reason: "the repo is not indexed in this run" });
    const answer = await this.deps.engine.read<T>(entry.workspace, request, this.runSignal);
    if (!answer.ok) return err({ reason: answer.error.reason });
    return ok({ value: answer.value, sha: entry.sha });
  }

  private async walkFrom(repoDir: string, seeds: readonly StoreSymbol[], budget: ImpactBudget, sha: string, cut: boolean): Promise<Result<ImpactReport, CodeGraphUnavailable>> {
    if (seeds.length === 0) return ok({ indexedSha: sha, symbols: [], truncated: cut });
    const walked = await this.read<{ nodes: WalkNode[]; truncated: boolean }>(repoDir, { op: "walk", seeds: seeds.map((s) => s.id), depth: budget.depth, maxNodes: budget.maxSymbols });
    if (!walked.ok) return walked;
    const symbols: ImpactedSymbol[] = [];
    const seen = new Set<string>();
    for (const n of walked.value.value.nodes) {
      /* A container the walk lifted from a changed member (depth 0 with a predecessor) carries the walk, but was not changed. */
      if (n.kind === "route" || this.deps.isTestFile(n.file) || (n.depth === 0 && n.via !== undefined)) continue;
      const key = `${n.file}::${n.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ file: n.file, symbol: n.symbol, kind: n.kind, depth: n.depth, ...(n.via ? { via: n.via } : {}) });
    }
    return ok({ indexedSha: walked.value.sha, symbols, truncated: walked.value.value.truncated || cut });
  }

  async impactedSymbols(repoDir: string, changed: BlastRadius, budget: ImpactBudget): Promise<Result<ImpactReport, CodeGraphUnavailable>> {
    const files = changed.changedFiles.filter((f) => !this.deps.isTestFile(f));
    const entry = this.indexOf(repoDir);
    if (!entry) return err({ reason: "the repo is not indexed in this run" });
    if (files.length === 0) return ok({ indexedSha: entry.sha, symbols: [], truncated: false });
    const lines = changed.touchedLines ? [...changed.touchedLines].map(([file, set]) => [file, [...set].sort((a, b) => a - b)]).sort() : null;
    const key = JSON.stringify([repoDir, entry.workspace, entry.sha, [...files].sort(), lines, budget.depth, budget.maxSymbols]);
    const known = this.walks.get(key);
    if (known) return known;
    const walk = this.walkChange(repoDir, files, changed.touchedLines, budget);
    this.walks.set(key, walk);
    /* Only an answer is kept: a failed walk may succeed when asked again. */
    void walk.then((result) => { if (!result.ok) this.walks.delete(key); }, () => this.walks.delete(key));
    return walk;
  }

  private async walkChange(repoDir: string, files: string[], touchedLines: TouchedLines | undefined, budget: ImpactBudget): Promise<Result<ImpactReport, CodeGraphUnavailable>> {
    const listed = await this.read<{ symbols: StoreSymbol[]; truncated: boolean }>(repoDir, { op: "symbols", files });
    if (!listed.ok) return listed;
    return this.walkFrom(repoDir, selectSeeds(listed.value.value.symbols, files, touchedLines), budget, listed.value.sha, listed.value.value.truncated);
  }

  async callersOf(repoDir: string, symbols: readonly LocalSymbolRef[], budget: ImpactBudget): Promise<Result<ImpactReport, CodeGraphUnavailable>> {
    const entry = this.indexOf(repoDir);
    if (!entry) return err({ reason: "the repo is not indexed in this run" });
    if (symbols.length === 0) return ok({ indexedSha: entry.sha, symbols: [], truncated: false });
    const found = await this.read<{ symbols: StoreSymbol[]; truncated: boolean }>(repoDir, { op: "find", symbols: symbols.map((s) => ({ file: s.file, symbol: s.symbol })) });
    if (!found.ok) return found;
    return this.walkFrom(repoDir, found.value.value.symbols, budget, found.value.sha, found.value.value.truncated);
  }

  async explore(repoDir: string, terms: readonly string[], maxFiles: number): Promise<Result<ExploreAnswer, CodeGraphUnavailable>> {
    const entry = this.indexOf(repoDir);
    if (!entry) return err({ reason: "the repo is not indexed in this run" });
    if (terms.length === 0) return err({ reason: "no term to explore" });
    const answer = await this.deps.engine.explore(entry.workspace, terms, maxFiles, this.runSignal);
    if (!answer.ok) return err({ reason: answer.error.reason });
    return ok({ text: answer.value, indexedSha: entry.sha });
  }

  async routes(repoDir: string): Promise<Result<GraphRoute[], CodeGraphUnavailable>> {
    const listed = await this.read<{ routes: StoreRoute[] }>(repoDir, { op: "routes" });
    if (!listed.ok) return listed;
    const out: GraphRoute[] = [];
    for (const r of listed.value.value.routes) {
      if (this.deps.isTestFile(r.file)) continue;
      const http = HTTP_ROUTE.exec(r.name);
      out.push({
        file: r.file,
        line: r.line,
        ...(http ? { method: http[1]!, path: http[2]! } : { path: r.name }),
        ...(r.target ? { target: { file: r.target.file, symbol: r.target.symbol, kind: r.target.kind } } : {}),
      });
    }
    return ok(out);
  }
}
