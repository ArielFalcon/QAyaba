/* Placement: shared-infrastructure/ because this port has no single owning bounded context (phases 3/4 both spawn the same binary, precedent #947). RunQaUseCase calls this on the per-run indexing phase when lastIndexedSha differs from the run SHA (both IndexStatusPort and CodeGraphPort must be wired). GROUNDING DEVIATION FROM DESIGN §3.1 LITERAL QUERY TEXT (discovered during 4a fixture-capture against the real codebase-memory-mcp v0.8.1 binary): a `WHERE` clause placed immediately after an `OPTIONAL MATCH` clause causes the CLI to silently fall back to a degenerate default projection (columns become a.name/a.qualified_name/a.label only) instead of executing the intended filter or erroring loudly. Verified reproducible with a minimal isolated probe. WORKAROUND (permitted by the design's own client-side-filter fallback clause in §3.0/§3.1: "where a hop can't express it, filter CLIENT-SIDE in parse()"): the confidence floor on any OPTIONAL MATCH hop is NOT expressed in a trailing Cypher WHERE — the confidence column is returned as a plain RETURN value and filtered client-side in parse(). The floor on the FIRST (non-optional) hop, attached to the anchor MATCH's own WHERE, executes correctly and is used as written. `coChangeCoupling` uses `f.file_path`/`g.file_path`. - FILE_CHANGES_WITH is stored DIRECTED, exactly one row per pair (not two directed rows). A directed-only match anchored on the "changed" side alone would silently drop any pair where the changed file is stored as the edge's TARGET — the match MUST be UNDIRECTED `(f)-[r:FILE_CHANGES_WITH]-(g)`, deduped by the coupled (non-anchor) file. Confirmed response shape (2a's captured fixture pattern, mirrored here): row-oriented, all-string cells — `{ columns: string[], rows: string[][], total: number }`. */
import { ok, err, type Result } from "../../shared-kernel/result.ts";
import type { BlastRadius } from "../../shared-kernel/blast-radius.ts";
import type { CodeGraphPort } from "../../shared-kernel/ports/code-graph.port.ts";
import type {
  LocalSymbolRef,
  CoupledFile,
  SpecCoverage,
  CodeGraphUnavailable,
  IndexFailed,
} from "../../shared-kernel/code/index.ts";

export interface CodebaseMemoryCliClient {
  cli(tool: string, jsonArg: string, repoDir: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const DEFAULT_MIN_CONFIDENCE = 0.55;

const MAX_HOP_DEPTH = 3;

/* --------------------------------------------------------------------------------------------- §3.0 — SAFE literal inlining. Net-new: the sibling adapter inlines a CONSTANT query, this one inlines UNTRUSTED-SHAPED dynamic values (changed file paths, symbol names) into a literal Cypher string. Any value containing a control character or newline is DROPPED (never injected, never escaped-and-kept) — a per-value degrade, never a query-corruption risk. --------------------------------------------------------------------------------------------- */

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_OR_NEWLINE = /[\x00-\x1f\x7f]/;

/** Escapes a single value for a Cypher string literal: `\` -> `\\` then `'` -> `\'`, wraps in single quotes. Returns null (dropped) for a value containing a control char/newline — never injected. */
export function inlineLiteral(value: string): string | null {
  if (CONTROL_CHAR_OR_NEWLINE.test(value)) return null;
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** Escapes and joins a list of values into a Cypher list literal (`['a.java','b\\'c.java']`).
 *  Dropped (control-char/newline) values are excluded from the list. Returns null when the input is
 *  empty or every value was dropped — the caller uses this to short-circuit without issuing a query. */
export function inlineList(values: string[]): string | null {
  const escaped = values.map(inlineLiteral).filter((v): v is string => v !== null);
  if (escaped.length === 0) return null;
  return `[${escaped.join(",")}]`;
}


interface GraphQueryResponse {
  columns: string[];
  rows: string[][];
  total: number;
}

function isGraphQueryResponse(value: unknown): value is GraphQueryResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as GraphQueryResponse).columns) &&
    Array.isArray((value as GraphQueryResponse).rows)
  );
}

function parseRows(stdout: string): Result<GraphQueryResponse, CodeGraphUnavailable> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (e) {
    return err({ reason: e instanceof Error ? e.message : String(e) });
  }
  if (!isGraphQueryResponse(payload)) {
    return err({ reason: "codebase-memory query_graph response missing columns/rows" });
  }
  return ok(payload);
}

function toNumber(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === "") return undefined;
  const n = Number(cell);
  return Number.isFinite(n) ? n : undefined;
}

function refKey(ref: LocalSymbolRef): string {
  return `${ref.file}::${ref.symbol}`;
}


function buildHopQuery(direction: "outbound" | "inbound", filesLiteral: string, minConfidence: number, depth: number): string {
  const arrow = direction === "outbound" ? { left: "-", right: "->" } : { left: "<-", right: "-" };
  const anchorClause = `MATCH (a:Method)${arrow.left}[r1:CALLS]${arrow.right}(b:Method)\nWHERE a.file_path IN ${filesLiteral} AND r1.confidence >= ${minConfidence}`;

  const hopVars = ["a", "b", "c", "d"];
  const returnCols: string[] = ["a.file_path AS a_file", "a.name AS a_name"];
  let query = anchorClause;

  for (let hop = 2; hop <= depth; hop++) {
    const fromVar = hopVars[hop - 1]!;
    const toVar = hopVars[hop]!;
    query += `\nOPTIONAL MATCH (${fromVar})${arrow.left}[r${hop}:CALLS]${arrow.right}(${toVar}:Method)`;
  }

  for (let hop = 1; hop <= depth; hop++) {
    const nodeVar = hopVars[hop]!;
    returnCols.push(`${nodeVar}.name AS ${nodeVar}_name`, `${nodeVar}.file_path AS ${nodeVar}_file`, `r${hop}.confidence AS r${hop}_conf`);
  }

  query += `\nRETURN ${returnCols.join(", ")}\nLIMIT 200`;
  return query;
}

function mapHopRows(response: GraphQueryResponse, depth: number, minConfidence: number): LocalSymbolRef[] {
  const idx = (name: string) => response.columns.indexOf(name);
  const hopVars = ["a", "b", "c", "d"];
  const results: LocalSymbolRef[] = [];
  const seen = new Set<string>();

  const iAFile = idx("a_file");
  const iAName = idx("a_name");

  for (const row of response.rows) {
    const anchorFile = iAFile >= 0 ? row[iAFile] : undefined;
    const anchorName = iAName >= 0 ? row[iAName] : undefined;
    const rowAnchorKey =
      anchorFile !== undefined && anchorName !== undefined ? refKey({ file: anchorFile, symbol: anchorName }) : undefined;

    for (let hop = 1; hop <= depth; hop++) {
      const nodeVar = hopVars[hop]!;
      const iName = idx(`${nodeVar}_name`);
      const iFile = idx(`${nodeVar}_file`);
      const iConf = idx(`r${hop}_conf`);

      const name = iName >= 0 ? row[iName] : undefined;
      const file = iFile >= 0 ? row[iFile] : undefined;
      if (name === undefined || file === undefined || name === "" || file === "") continue;

      const conf = toNumber(iConf >= 0 ? row[iConf] : undefined);
      if (conf === undefined || conf < minConfidence) continue;

      const ref: LocalSymbolRef = { file, symbol: name };
      const key = refKey(ref);
      if (key === rowAnchorKey) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(ref);
    }
  }

  return results;
}


function buildCoChangeQuery(filesLiteral: string): string {
  return (
    `MATCH (f:File)-[r:FILE_CHANGES_WITH]-(g:File)\nWHERE f.file_path IN ${filesLiteral}\n` +
    `RETURN f.file_path AS f_path, g.file_path AS g_path, r.coupling_score AS coupling_score, ` +
    `r.co_changes AS co_changes, r.last_co_change AS last_co_change\nORDER BY r.coupling_score DESC\nLIMIT 200`
  );
}

function mapCoChangeRows(response: GraphQueryResponse, _anchorFiles: ReadonlySet<string>): CoupledFile[] {
  const iFPath = response.columns.indexOf("f_path");
  const iGPath = response.columns.indexOf("g_path");
  const iScore = response.columns.indexOf("coupling_score");
  const iCoChanges = response.columns.indexOf("co_changes");
  const iLastCoChange = response.columns.indexOf("last_co_change");

  const results: CoupledFile[] = [];
  const seen = new Set<string>();

  for (const row of response.rows) {
    const fPath = iFPath >= 0 ? row[iFPath] : undefined;
    const gPath = iGPath >= 0 ? row[iGPath] : undefined;
    if (fPath === undefined || gPath === undefined || fPath === "" || gPath === "") continue;
    if (gPath === fPath) continue;

    const couplingScore = toNumber(iScore >= 0 ? row[iScore] : undefined);
    const coChanges = toNumber(iCoChanges >= 0 ? row[iCoChanges] : undefined);
    if (couplingScore === undefined || coChanges === undefined) continue;

    const lastCoChange = iLastCoChange >= 0 ? row[iLastCoChange] : undefined;

    if (seen.has(gPath)) continue;
    seen.add(gPath);

    results.push({
      file: gPath,
      couplingScore,
      coChanges,
      ...(lastCoChange !== undefined && lastCoChange !== "" ? { lastCoChange } : {}),
    });
  }

  return results;
}


function buildCallersQuery(fileLiteral: string, nameLiteral: string, minConfidence: number, depth: number): string {
  const anchorClause = `MATCH (a:Method)<-[r1:CALLS]-(b:Method)\nWHERE a.file_path IN ${fileLiteral} AND a.name = ${nameLiteral} AND r1.confidence >= ${minConfidence}`;

  const hopVars = ["a", "b", "c", "d"];
  const returnCols: string[] = ["a.file_path AS a_file", "a.name AS a_name"];
  let query = anchorClause;

  for (let hop = 2; hop <= depth; hop++) {
    const fromVar = hopVars[hop - 1]!;
    const toVar = hopVars[hop]!;
    query += `\nOPTIONAL MATCH (${fromVar})<-[r${hop}:CALLS]-(${toVar}:Method)`;
  }

  for (let hop = 1; hop <= depth; hop++) {
    const nodeVar = hopVars[hop]!;
    returnCols.push(`${nodeVar}.name AS ${nodeVar}_name`, `${nodeVar}.file_path AS ${nodeVar}_file`, `r${hop}.confidence AS r${hop}_conf`);
  }

  query += `\nRETURN ${returnCols.join(", ")}\nLIMIT 200`;
  return query;
}

function mapCallerRows(response: GraphQueryResponse, anchor: LocalSymbolRef, depth: number, minConfidence: number): LocalSymbolRef[] {
  const idx = (name: string) => response.columns.indexOf(name);
  const hopVars = ["a", "b", "c", "d"];
  const anchorKey = refKey(anchor);
  const results: LocalSymbolRef[] = [];
  const seen = new Set<string>();

  for (const row of response.rows) {
    for (let hop = 1; hop <= depth; hop++) {
      const nodeVar = hopVars[hop]!;
      const iName = idx(`${nodeVar}_name`);
      const iFile = idx(`${nodeVar}_file`);
      const iConf = idx(`r${hop}_conf`);

      const name = iName >= 0 ? row[iName] : undefined;
      const file = iFile >= 0 ? row[iFile] : undefined;
      if (name === undefined || file === undefined || name === "" || file === "") continue;

      const conf = toNumber(iConf >= 0 ? row[iConf] : undefined);
      if (conf === undefined || conf < minConfidence) continue;

      const ref: LocalSymbolRef = { file, symbol: name };
      const key = refKey(ref);
      if (key === anchorKey) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(ref);
    }
  }

  return results;
}

export class CodebaseMemoryCodeGraphAdapter implements CodeGraphPort {
  constructor(
    private readonly client: CodebaseMemoryCliClient,
    private readonly project = "",
  ) {}

  async impactedSymbols(
    repoDir: string,
    changed: BlastRadius,
    opts: { depth: number; minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    if (changed.isEmpty) return ok([]);

    const filesLiteral = inlineList([...changed.changedFiles]);
    if (filesLiteral === null) return ok([]);

    const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const depth = Math.min(Math.max(1, Math.trunc(opts.depth)), MAX_HOP_DEPTH);

    const outboundResult = await this.runHopQuery(repoDir, "outbound", filesLiteral, minConfidence, depth);
    if (!outboundResult.ok) return outboundResult;

    const inboundResult = await this.runHopQuery(repoDir, "inbound", filesLiteral, minConfidence, depth);
    if (!inboundResult.ok) return inboundResult;

    const seen = new Set<string>();
    const union: LocalSymbolRef[] = [];
    for (const ref of [...outboundResult.value, ...inboundResult.value]) {
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(ref);
    }
    return ok(union);
  }

  private async runHopQuery(
    repoDir: string,
    direction: "outbound" | "inbound",
    filesLiteral: string,
    minConfidence: number,
    depth: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const query = buildHopQuery(direction, filesLiteral, minConfidence, depth);
    const jsonArg = JSON.stringify({ project: this.project, query });
    const res = await this.client.cli("query_graph", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory unavailable" });
    }
    const parsed = parseRows(res.stdout);
    if (!parsed.ok) return parsed;
    return ok(mapHopRows(parsed.value, depth, minConfidence));
  }

  /** Real per design §3.2 (corrected grounding, apply-progress): UNDIRECTED FILE_CHANGES_WITH match
   *  anchored by `WHERE f.file_path IN <inlined files>`, mapped to CoupledFile[] deduped by the
   *  coupled (non-anchor) file. No confidence floor — co-change is a git fact, not a CALLS edge. */
  async coChangeCoupling(
    repoDir: string,
    files: string[],
  ): Promise<Result<CoupledFile[], CodeGraphUnavailable>> {
    if (files.length === 0) return ok([]);

    const filesLiteral = inlineList(files);
    if (filesLiteral === null) return ok([]);

    const query = buildCoChangeQuery(filesLiteral);
    const jsonArg = JSON.stringify({ project: this.project, query });
    const res = await this.client.cli("query_graph", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory unavailable" });
    }
    const parsed = parseRows(res.stdout);
    if (!parsed.ok) return parsed;
    return ok(mapCoChangeRows(parsed.value, new Set(files)));
  }

  /** Real per design §3.3: inbound CALLS anchored on `symbol.file` + `symbol.symbol` (both via
   *  inlineLiteral), explicit unrolled hops to the clamped positional depth, confidence floor
   *  primarily in the anchor's own WHERE + client-side re-check for every hop. */
  async callersOf(
    repoDir: string,
    symbol: LocalSymbolRef,
    depth: number,
    opts?: { minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const fileLiteral = inlineList([symbol.file]);
    const nameLiteral = inlineLiteral(symbol.symbol);
    if (fileLiteral === null || nameLiteral === null) return ok([]);

    const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const clampedDepth = Math.min(Math.max(1, Math.trunc(depth)), MAX_HOP_DEPTH);

    const query = buildCallersQuery(fileLiteral, nameLiteral, minConfidence, clampedDepth);
    const jsonArg = JSON.stringify({ project: this.project, query });
    const res = await this.client.cli("query_graph", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory unavailable" });
    }
    const parsed = parseRows(res.stdout);
    if (!parsed.ok) return parsed;
    return ok(mapCallerRows(parsed.value, symbol, clampedDepth, minConfidence));
  }

  /** OUT OF SCOPE for this entire change (spec §2 non-requirements, Scenario K): the spike proved
   *  zero TESTS/TESTS_FILE/COVERS edges exist. Stays inert — never promoted to real graph data. */
  async existingCoverage(
    _repoDir: string,
    _changed: BlastRadius,
  ): Promise<Result<SpecCoverage[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** OUT OF SCOPE for this entire change (spec §2 non-requirements, Scenario K). */
  async structurallyRelated(
    _repoDir: string,
    _symbols: LocalSymbolRef[],
    _minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** Real per design §6/R11: spawns index_repository, maps a whole-index failure to IndexFailed.
   *  Called by RunQaUseCase's per-run indexing phase when IndexStatusPort says lastIndexedSha
   *  differs from the run SHA (and both ports are wired). An unresolved project is created first
   *  by LazyProjectCodeGraphAdapter.syncTo via index_repository `{ repo_path }` (same shape as
   *  onboarding), then this path updates the named project. IndexFailed / throw are fail-open at
   *  the use-case — lastIndexedSha is not written. */
  async syncTo(
    repoDir: string,
    changedFiles: string[],
    opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>> {
    const jsonArg = JSON.stringify({
      project: this.project,
      repo_path: repoDir,
      changed_files: changedFiles,
      semantic: opts?.semantic ?? false,
    });
    const res = await this.client.cli("index_repository", jsonArg, repoDir);
    if (res.code === null) {
      return err({ reason: res.stderr || "codebase-memory index_repository unavailable" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(res.stdout);
    } catch (e) {
      return err({ reason: e instanceof Error ? e.message : String(e) });
    }
    const shape = typeof payload === "object" && payload !== null ? (payload as { nodes?: unknown; node_count?: unknown }) : {};
    const rawCount = shape.nodes ?? shape.node_count;
    const nodeCount = toNumber(rawCount === undefined ? undefined : String(rawCount));
    if (nodeCount === undefined) {
      return err({ reason: "codebase-memory index_repository response missing nodes/node_count" });
    }
    return ok({ nodeCount });
  }
}
