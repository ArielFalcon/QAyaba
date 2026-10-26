/*
 * A reached symbol is a handler whose route serves an operation of the map (verb and path), or is named for the operationId
 * (a generated contract interface yields no route node). The operation is an entry point; so is each page the map's feBe joins
 * to it. How a route serves an operation is the caller's rule, handed in, so this domain imports no other context. Pure.
 */
import { isText, keyOf, pagesByOperation } from "../page-files.ts";
import { changedSymbolOf, walkChains, type ProofInput, type ReachHit, type ReachProof } from "../reach-proof.ts";

export type ServesOperation = (route: { method: string; path: string }, operation: { verb: string; path: string }) => boolean;

export function handlerServesOperation(serves: ServesOperation): ReachProof {
  return {
    id: "handler-serves-operation",
    prove(input: ProofInput): readonly ReachHit[] {
      const joined = pagesByOperation(input.map);
      const operations = (input.map.api ?? []).filter((op) => op && isText(op.operationId) && isText(op.method) && isText(op.path)) as Array<{ operationId: string; method: string; path: string }>;
      const out: ReachHit[] = [];
      for (const walk of input.walks) {
        if (!walk.handlers) continue;
        for (const { symbol, seed, chain, steps } of walkChains(walk)) {
          const handled = input.handlerRoutes.filter((h) => h.method !== undefined && h.target !== undefined && keyOf(h.target) === keyOf(symbol));
          for (const op of operations) {
            if (!(op.operationId === symbol.symbol || handled.some((h) => serves({ method: h.method!, path: h.path }, { verb: op.method, path: op.path })))) continue;
            const common = { basis: "handler" as const, seed: changedSymbolOf(seed), hops: chain.length - 1, confidence: symbol.confidence, seedCut: walk.truncated === true };
            const operationStep = `${op.method.toUpperCase()} ${op.path} (${op.operationId})`;
            out.push({ ...common, entry: { kind: "operation", repo: walk.repo, verb: op.method.toUpperCase(), path: op.path, operationId: op.operationId }, evidence: [...steps, operationStep] });
            for (const route of joined.get(op.operationId) ?? []) out.push({ ...common, entry: { kind: "page", repo: walk.repo, route }, evidence: [...steps, operationStep, `page ${route}`] });
          }
        }
      }
      return out;
    },
  };
}
