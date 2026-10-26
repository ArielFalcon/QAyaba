/*
 * A reached symbol lies in a file that implements a page: the map's implementation files, or, where the map declares none for a
 * route, the file of the symbol the engine's route node for the same path points at. Walks that start at a frontend call site
 * are the call-site proof's. Pure.
 */
import { normalizeFile, pageFiles, sameFile } from "@kernel/page-files.ts";
import { changedSymbolOf, walkChains, type ProofInput, type ProofWalk, type ReachHit, type ReachProof } from "../reach-proof.ts";
import type { ReachBasis } from "../change-scope.ts";

/* The pages whose implementing files hold a symbol the walk reached. `basis` names how the walk got there when it is not the call graph. */
export function pageHitsOfWalk(walk: ProofWalk, files: ReadonlyMap<string, readonly string[]>, basisOf: (depth: number) => ReachBasis): ReachHit[] {
  const out: ReachHit[] = [];
  for (const { symbol, seed, chain, steps } of walkChains(walk)) {
    const file = normalizeFile(symbol.file);
    for (const [route, implementing] of files) {
      if (!implementing.some((f) => sameFile(f, file))) continue;
      out.push({
        entry: { kind: "page", repo: walk.repo, route },
        basis: basisOf(symbol.depth),
        seed: changedSymbolOf(seed),
        hops: chain.length - 1,
        evidence: [...steps, `page ${route}`],
        confidence: symbol.confidence,
        seedCut: walk.truncated === true,
      });
    }
  }
  return out;
}

export const fileImplementsPage: ReachProof = {
  id: "file-implements-page",
  prove(input: ProofInput): readonly ReachHit[] {
    const { files } = pageFiles(input.map, input.pageRoutes);
    return input.walks.filter((w) => w.prefixOf === undefined).flatMap((w) => pageHitsOfWalk(w, files, (depth) => (depth === 0 ? "implementation" : "graph")));
  },
};
