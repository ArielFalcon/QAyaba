/* StructuralSignalPort: advisory blast-radius from the code graph and the git co-change history. Unindexed repo → empty. One walk answers the whole change: its depth-0 symbols are the changed ones, the rest are what reaches them. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import type { CoupledFile, ImpactBudget, ImpactedSymbol } from "@kernel/code/index.ts";
import type { StructuralSignalPort, StructuralSignalResult } from "../../application/ports/index.ts";
import { hasSymbolBlocks, renderBlastRadiusSignal } from "./blast-radius-signal.ts";

export const ADVISORY_BUDGET: ImpactBudget = { depth: 3, maxSymbols: 300 };

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
  ) {}

  async render(_repoDir: string, changed: BlastRadius): Promise<StructuralSignalResult> {
    /* An empty BlastRadius (non-diff mode, or a diff-mode run with no changed files) has nothing to ask about. */
    if (changed.isEmpty) return { text: "", hasSymbols: false };

    const [reached, coupled] = await Promise.all([safeImpacted(this.codeGraph, this.repoDir, changed), safeCoupled(this.coChange, this.repoDir, changed)]);
    const ref = (s: ImpactedSymbol) => ({ file: s.file, symbol: s.symbol });
    const impacted = reached.symbols.filter((s) => s.depth === 0).map(ref);
    const callers = reached.symbols.filter((s) => s.depth > 0).map(ref);
    return {
      text: renderBlastRadiusSignal({ impacted, callers, coupled }),
      hasSymbols: hasSymbolBlocks({ impacted, callers }),
      ...(reached.indexedSha !== undefined ? { indexedSha: reached.indexedSha } : {}),
    };
  }
}
