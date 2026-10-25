/* StructuralSignalPort: advisory blast-radius from the code graph and the git co-change history. Unindexed repo → empty. One walk answers the whole change: its depth-0 symbols are the changed ones, the rest are what reaches them. With the dossier on, the engine's read-equivalent source of the change's top symbols rides in the same block (S14), so the benefit does not depend on a model choosing a tool. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import type { CoupledFile, ImpactBudget, ImpactedSymbol } from "@kernel/code/index.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { StructuralSignalPort, StructuralSignalResult } from "../../application/ports/index.ts";
import { hasSymbolBlocks, renderBlastRadiusSignal } from "./blast-radius-signal.ts";
import { shapeExploreAnswer } from "./code-graph-tools-port.adapter.ts";
import { isExploreTerm } from "../../domain/code-graph-query.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";

export const ADVISORY_BUDGET: ImpactBudget = { depth: 3, maxSymbols: 300 };

/* The change dossier's bounds: how many of the change's symbols it explores, how many files the engine may show, and how much of the block it may take. */
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

async function safeImpacted(codeGraph: CodeGraphPort, repoDir: string, changed: BlastRadius): Promise<{ symbols: ImpactedSymbol[]; indexedSha?: string }> {
  try {
    const result = await codeGraph.impactedSymbols(repoDir, changed, ADVISORY_BUDGET);
    return result.ok ? { symbols: result.value.symbols, indexedSha: result.value.indexedSha } : { symbols: [] };
  } catch {
    return { symbols: [] };
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

  /* The dossier text and the files it shows, or nothing: an index that cannot answer leaves the block as it was. */
  private async dossierOf(symbols: readonly ImpactedSymbol[]): Promise<{ text: string; files: string[] } | undefined> {
    if (!this.dossier) return undefined;
    const limits = this.dossier.limits ?? DOSSIER_LIMITS;
    const terms = topChangedSymbols(symbols, limits.maxSymbols);
    if (terms.length === 0) return undefined;
    try {
      const answer = await this.dossier.explore.explore(this.repoDir, terms, limits.maxFiles);
      if (!answer.ok) return undefined;
      const { result } = shapeExploreAnswer(answer.value.text, limits.maxChars, (text) => sanitizeText(text, "model").text);
      const files = filesShown(result);
      return files.length > 0 ? { text: result, files } : undefined;
    } catch {
      return undefined;
    }
  }

  async render(_repoDir: string, changed: BlastRadius): Promise<StructuralSignalResult> {
    /* An empty BlastRadius (non-diff mode, or a diff-mode run with no changed files) has nothing to ask about. */
    if (changed.isEmpty) return { text: "", hasSymbols: false };

    const [reached, coupled] = await Promise.all([safeImpacted(this.codeGraph, this.repoDir, changed), safeCoupled(this.coChange, this.repoDir, changed)]);
    const ref = (s: ImpactedSymbol) => ({ file: s.file, symbol: s.symbol });
    const impacted = reached.symbols.filter((s) => s.depth === 0).map(ref);
    const callers = reached.symbols.filter((s) => s.depth > 0).map(ref);
    const dossier = await this.dossierOf(reached.symbols);
    return {
      text: renderBlastRadiusSignal({ impacted, callers, coupled, ...(dossier ? { dossier: dossier.text } : {}) }),
      hasSymbols: hasSymbolBlocks({ impacted, callers }),
      ...(reached.indexedSha !== undefined ? { indexedSha: reached.indexedSha } : {}),
      ...(dossier ? { providedFiles: dossier.files } : {}),
    };
  }
}
