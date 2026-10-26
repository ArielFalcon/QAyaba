/*
 * A contract operation a service change reached: the cross-repo impact keeps a link only when its operation changed in the
 * contract (or the file could not be compared), so each impacted link is an operation entry of its service, with the link's
 * description as evidence. The pages that call it are the call-site proof's. Pure.
 */
import type { ProofInput, ReachHit, ReachProof } from "../reach-proof.ts";

export const openapiOperationDiff: ReachProof = {
  id: "openapi-operation-diff",
  prove(input: ProofInput): readonly ReachHit[] {
    return (input.links ?? []).map((l) => {
      const operation = `${l.verb} ${l.path}`;
      return {
        entry: { kind: "operation", repo: l.repo, verb: l.verb, path: l.path },
        basis: "contract",
        seed: { file: l.file, symbol: operation },
        hops: 0,
        evidence: [`${l.repo}: ${operation}${l.change === "removed" ? " (removed)" : ""}`],
        confidence: l.confidence,
        seedCut: false,
      };
    });
  },
};
