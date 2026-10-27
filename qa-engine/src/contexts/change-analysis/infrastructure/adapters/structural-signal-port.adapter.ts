/* StructuralSignalPort: advisory blast-radius from the code graph and the git co-change history. Unindexed repo → empty. One walk answers the whole change: its depth-0 symbols are the changed ones, the rest are what reaches them. With the dossier on, the engine's read-equivalent source of the change's top symbols rides in the same block (S14), so the benefit does not depend on a model choosing a tool. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import { DEFAULT_WALK_POLICY, type CoupledFile, type ImpactReport, type ImpactedSymbol, type WalkPolicy } from "@kernel/code/index.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { StructuralSignalPort } from "@kernel/ports/structural-signal.port.ts";
import type { StructuralSignalResult } from "@kernel/ports/structural-signal.port.ts";
import { DOSSIER_HEADING, MAX_DOSSIER_BYTES, hasSymbolBlocks, renderBlastRadiusSignal } from "./blast-radius-signal.ts";
import { shapeExploreAnswer } from "@contexts/agent-tools/application/index.ts";
import { isExploreTerm } from "@contexts/agent-tools/application/index.ts";
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";

/* The walk policy every impact walk of the change shares. */
export const ADVISORY_BUDGET: WalkPolicy = DEFAULT_WALK_POLICY;

/* The most reached symbols the block is rendered from, nearest first: a bound of the prompt block, never of the walk. */
export const RENDERED_SYMBOLS = 300;

/* The change dossier's bounds: how many of the change's symbols it explores, how many files the engine may show, and how much of the block it may take (in bytes, and never more than the block can carry). */
export const DOSSIER_LIMITS = { maxSymbols: 4, maxFiles: 4, maxChars: 8_000 } as const;

export interface StructuralDossier {
  explore: CodeExplorePort;
  limits?: { maxSymbols: number; maxFiles: number; maxChars: number };
}

/* The change's top symbols: the changed ones the most code reaches directly first, then in the walk's order. */
function topChangedSymbols(symbols: readonly ImpactedSymbol[], max: number): string[] {
  const reaching = new Map<string, number>();
  for (const s of symbols) if (s.depth === 1 && s.via) reaching.set(`${s.via.file}::${s.via.symbol}`, (reaching.get(`${s.via.file}::${s.via.symbol}`) ?? 0) + 1);
  const changed = symbols.filter((s) => s.depth === 0 && isExploreTerm(s.symbol));
  const ranked = changed.map((s, i) => ({ s, i, n: reaching.get(`${s.file}::${s.symbol}`) ?? 0 })).sort((a, b) => b.n - a.n || a.i - b.i);
  return [...new Set(ranked.map((r) => r.s.symbol))].slice(0, max);
}

/* The files a kept dossier shows, by its file headings (outside every code block). */
const FILE_HEADING = /^\*\*`([^`]+)`\*\*/;
function filesShown(text: string): string[] {
  const files: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) inBlock = !inBlock;
    else if (!inBlock) {
      const m = FILE_HEADING.exec(line);
      if (m) files.push(m[1]!);
    }
  }
  return [...new Set(files)];
}

/* Says what became of a part of the signal on the open phase's span; the signal is advisory, so a fault here is dropped. */
function note(attrs: Attrs): void {
  try {
    activeExecScope()?.telemetry?.annotate?.(attrs);
  } catch (cause) {
    engineLog.error(`[qa] structural signal telemetry failed and was dropped: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").trim().slice(0, 200);

/* One line of what a walk did: its seeds, the partial ones, the hubs it pruned and the work it spent. */
export function walkSummary(report: ImpactReport): string {
  const seeds = report.symbols.filter((s) => s.depth === 0).length;
  const cost = report.cost;
  const limit = cost?.fanInLimit !== undefined ? ` at fan-in above ${cost.fanInLimit}` : "";
  return `impact walk: ${seeds} seeds (${report.partialSeeds?.length ?? 0} partial), ${report.hubNodes?.length ?? 0} hub nodes pruned${limit}, ${cost?.expansions ?? 0} of ${cost?.budget ?? 0} expansions`;
}

/* The walk's attributes for the open phase's span. */
export function walkAttrs(report: ImpactReport): Attrs {
  return {
    "qayaba.code_graph.walk.seeds": report.symbols.filter((s) => s.depth === 0).length,
    "qayaba.code_graph.walk.seeds_partial": report.partialSeeds?.length ?? 0,
    "qayaba.code_graph.walk.hub_nodes": report.hubNodes?.length ?? 0,
    ...(report.cost ? { "qayaba.code_graph.walk.expansions": report.cost.expansions, "qayaba.code_graph.walk.budget": report.cost.budget } : {}),
    ...(report.cost?.fanInLimit !== undefined ? { "qayaba.code_graph.walk.fan_in_limit": report.cost.fanInLimit } : {}),
  };
}

/* The impact walk, or nothing when it fails; a failed walk, or one that left a seed partial, is logged and recorded, never silent. */
async function safeImpacted(codeGraph: CodeGraphPort, repoDir: string, changed: BlastRadius): Promise<{ symbols: ImpactedSymbol[]; indexedSha?: string }> {
  const failed = (reason: string) => {
    engineLog.warn(`[qa] structural signal: the impact walk failed, so the block lists no symbols: ${reason}`);
    note({ "qayaba.structural.walk": "failed", "qayaba.code_graph.reason": reason });
    return { symbols: [] };
  };
  try {
    const result = await codeGraph.impactedSymbols(repoDir, changed, ADVISORY_BUDGET);
    if (!result.ok) return failed(reasonOf(result.error.reason));
    if (result.value.truncated) engineLog.warn(`[qa] structural signal: ${walkSummary(result.value)}; the block lists only part of what the partial seeds reach`);
    note({ "qayaba.structural.walk": result.value.truncated ? "truncated" : "complete", ...walkAttrs(result.value) });
    return { symbols: result.value.symbols, indexedSha: result.value.indexedSha };
  } catch (cause) {
    return failed(reasonOf(cause));
  }
}

async function safeCoupled(coChange: CoChangePort, repoDir: string, changed: BlastRadius): Promise<CoupledFile[]> {
  try {
    const result = await coChange.coChangeCoupling(repoDir, changed);
    return result.ok ? result.value : [];
  } catch {
    return [];
  }
}

export class StructuralSignalPortAdapter implements StructuralSignalPort {
  constructor(
    private readonly codeGraph: CodeGraphPort,
    private readonly coChange: CoChangePort,
    /* The repo ROOT (composition-time mirrorDir): the repo the run indexed, NOT workspace.specDir's e2e subfolder. */
    private readonly repoDir: string,
    /* The change dossier, when it is on. */
    private readonly dossier?: StructuralDossier,
  ) {}

  /* The dossier text and the files it shows, or nothing: an index that cannot answer leaves the block as it was, and says so. */
  private async dossierOf(symbols: readonly ImpactedSymbol[]): Promise<{ text: string; files: string[] } | undefined> {
    if (!this.dossier) return undefined;
    const limits = this.dossier.limits ?? DOSSIER_LIMITS;
    const terms = topChangedSymbols(symbols, limits.maxSymbols);
    if (terms.length === 0) return undefined;
    const withheld = (outcome: "unavailable" | "empty", why: string): undefined => {
      engineLog.warn(`[qa] structural signal: the change dossier is not in the block (${outcome}): ${why}`);
      note({ "qayaba.structural.dossier": outcome });
      return undefined;
    };
    try {
      const answer = await this.dossier.explore.explore(this.repoDir, terms, limits.maxFiles);
      if (!answer.ok) return withheld("unavailable", reasonOf(answer.error.reason));
      const bytes = (text: string) => Buffer.byteLength(text, "utf8");
      const { result } = shapeExploreAnswer(answer.value.text, Math.min(limits.maxChars, MAX_DOSSIER_BYTES), (text) => sanitizeText(text, "model").text, bytes);
      const files = filesShown(result);
      return files.length > 0 ? { text: result, files } : withheld("empty", "none of the engine's source fit the dossier's budget, or it showed no file");
    } catch (cause) {
      return withheld("unavailable", reasonOf(cause));
    }
  }

  async render(_repoDir: string, changed: BlastRadius): Promise<StructuralSignalResult> {
    /* An empty BlastRadius (non-diff mode, or a diff-mode run with no changed files) has nothing to ask about. */
    if (changed.isEmpty) return { text: "", hasSymbols: false };

    const [reached, coupled] = await Promise.all([safeImpacted(this.codeGraph, this.repoDir, changed), safeCoupled(this.coChange, this.repoDir, changed)]);
    const ref = (s: ImpactedSymbol) => ({ file: s.file, symbol: s.symbol });
    const rendered = reached.symbols.slice(0, RENDERED_SYMBOLS);
    const impacted = rendered.filter((s) => s.depth === 0).map(ref);
    const callers = rendered.filter((s) => s.depth > 0).map(ref);
    const dossier = await this.dossierOf(reached.symbols);
    const text = renderBlastRadiusSignal({ impacted, callers, coupled, ...(dossier ? { dossier: dossier.text } : {}) });
    /* The renderer leaves out a dossier the block's byte budget cannot hold: its files are provided only when the text shows them. */
    const shown = dossier !== undefined && text.includes(DOSSIER_HEADING);
    if (dossier !== undefined) {
      if (!shown) engineLog.warn("[qa] structural signal: the renderer left the change dossier out of the block (over its byte budget)");
      note({ "qayaba.structural.dossier": shown ? "shown" : "over-budget" });
    }
    return {
      text,
      hasSymbols: hasSymbolBlocks({ impacted, callers }),
      ...(reached.indexedSha !== undefined ? { indexedSha: reached.indexedSha } : {}),
      ...(shown ? { providedFiles: dossier.files } : {}),
    };
  }
}
