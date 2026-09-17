/* StructuralSignalPort: advisory blast-radius from the code graph. Unindexed repo → empty. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { LocalSymbolRef, CoupledFile } from "@kernel/code/index.ts";
import type { StructuralSignalPort } from "../../application/ports/index.ts";
import { renderBlastRadiusSignal, type ScoredSymbolRef } from "./blast-radius-signal.ts";

const ADVISORY_DEPTH = 3;

/* Every callersOf query is a REAL process spawn in production (one codebase-memory-mcp CLI invocation per anchor). impactedSymbols can legitimately return hundreds of symbols on a large commit (its own Cypher LIMIT is 200 per direction) — an unbounded Promise.all over that set is a concurrent-spawn storm on the orchestrator host. Advisory signal does not need caller data for EVERY impacted symbol: the first N (input order — the graph's own result order) is proportionate. The renderer separately caps rendered items; this caps the SPAWNS. */
const MAX_CALLER_ANCHORS = 25;

/* Bounds CONCURRENCY, not just count: an unbounded Promise.all over up to MAX_CALLER_ANCHORS anchors still launches that many process spawns at once. Draining in small batches keeps the spawn storm proportionate on the orchestrator host while the total call count stays capped. */
const CALLER_CONCURRENCY = 5;

async function safeImpacted(codeGraph: CodeGraphPort, repoDir: string, changed: BlastRadius): Promise<LocalSymbolRef[]> {
  try {
    const result = await codeGraph.impactedSymbols(repoDir, changed, { depth: ADVISORY_DEPTH });
    return result.ok ? result.value : [];
  } catch {
    return [];
  }
}

async function safeCoupled(codeGraph: CodeGraphPort, repoDir: string, files: string[]): Promise<CoupledFile[]> {
  try {
    const result = await codeGraph.coChangeCoupling(repoDir, files);
    return result.ok ? result.value : [];
  } catch {
    return [];
  }
}

async function safeCallers(codeGraph: CodeGraphPort, repoDir: string, symbol: LocalSymbolRef): Promise<LocalSymbolRef[]> {
  try {
    const result = await codeGraph.callersOf(repoDir, symbol, ADVISORY_DEPTH);
    return result.ok ? result.value : [];
  } catch {
    return [];
  }
}

export class StructuralSignalPortAdapter implements StructuralSignalPort {
  constructor(
    private readonly codeGraph: CodeGraphPort,
    /* The repo ROOT (composition-time mirrorDir) — the codebase-memory graph is indexed here, NOT at workspace.specDir's e2e subfolder. See this module's own header for the full rationale. */
    private readonly repoDir: string,
  ) {}

  async render(_repoDir: string, changed: BlastRadius): Promise<string> {
    /* Short-circuit before ANY query — mirrors CodeGraphPort's own early-return contract (impactedSymbols' own "Early-return ok([]) on changed.isEmpty() WITHOUT spawning" design note). An empty BlastRadius (non-diff mode, or a diff-mode run with no changed files) has nothing to ask the graph about. */
    if (changed.isEmpty) return "";

    const repoDir = this.repoDir;
    const impacted: ScoredSymbolRef[] = await safeImpacted(this.codeGraph, repoDir, changed);
    const coupled = await safeCoupled(this.codeGraph, repoDir, [...changed.changedFiles]);

    /* callersOf is anchored per-symbol (the kernel port's own signature — no "callers of this whole changed set" method exists), so query it once per DISTINCT impacted anchor and union the results. Bounding this to the impacted set (rather than every changed file) keeps the query count proportional to what impactedSymbols already found interesting, matching the design's own "callersOf on the changed anchors" framing (§5.2). */
    const anchors = impacted.slice(0, MAX_CALLER_ANCHORS);
    const callerResults: LocalSymbolRef[][] = [];
    for (let i = 0; i < anchors.length; i += CALLER_CONCURRENCY) {
      const batch = anchors.slice(i, i + CALLER_CONCURRENCY);
      callerResults.push(...await Promise.all(batch.map((symbol) => safeCallers(this.codeGraph, repoDir, symbol))));
    }
    const seen = new Set<string>();
    const callers: ScoredSymbolRef[] = [];
    for (const ref of callerResults.flat()) {
      const key = `${ref.file}::${ref.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callers.push(ref);
    }

    return renderBlastRadiusSignal({ impacted, callers, coupled });
  }
}
