/*
 * What the response oracle may corrupt, aimed at the change: the operations its scope reaches (every tier and repo) and the ones the
 * use cases stand on, each use case with its operations and the specs written or held for it. A run with no scope, a degraded scope
 * or no operation in reach has no aim, and so nothing is corrupted: a response the change does not reach is no evidence about it.
 */
import type { EntryPoint } from "@kernel/change-reach.ts";
import type { ChangeScope } from "@contexts/change-analysis/application/index.ts";
import { operationKey, type FaultAim } from "@contexts/objective-signal/application/index.ts";
import { operationUrlPattern } from "@contexts/service-topology/application/index.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/* The most operations one corrupted re-run is handed; the seed reads at most this many. */
export const MAX_FAULT_OPERATIONS = 64;

type Operation = Extract<EntryPoint, { kind: "operation" }>;

const isOperation = (entry: EntryPoint): entry is Operation => entry.kind === "operation";

function keyOf(operation: Operation): { verb: string; pattern: string; key: string } | undefined {
  const pattern = operationUrlPattern(operation);
  if (pattern === undefined) return undefined;
  const verb = operation.verb.toUpperCase();
  return { verb, pattern, key: operationKey({ verb, pattern }) };
}

export function faultAimOf(input: {
  scope: ChangeScope | undefined;
  candidates: readonly UseCaseCandidate[];
  flowCandidates: ReadonlyArray<{ specFile: string; candidates: readonly string[] }>;
}): FaultAim | undefined {
  const { scope, candidates, flowCandidates } = input;
  if (scope === undefined || scope.degraded.length > 0) return undefined;
  const operations = new Map<string, { verb: string; pattern: string }>();
  const add = (operation: Operation): string | undefined => {
    const found = keyOf(operation);
    if (found === undefined) return undefined;
    if (!operations.has(found.key) && operations.size < MAX_FAULT_OPERATIONS) operations.set(found.key, { verb: found.verb, pattern: found.pattern });
    return operations.has(found.key) ? found.key : undefined;
  };
  for (const reach of scope.reach) if (isOperation(reach.entry)) add(reach.entry);
  const aimed = candidates.flatMap((candidate) => {
    if (!isOperation(candidate.entry)) return [];
    const key = add(candidate.entry);
    return key === undefined ? [] : [{ candidateId: candidate.id, operations: [key] }];
  });
  if (operations.size === 0) return undefined;
  const bySpec = new Map<string, Set<string>>();
  const hold = (specFile: string, id: string) => bySpec.set(specFile, (bySpec.get(specFile) ?? new Set<string>()).add(id));
  for (const flow of flowCandidates) for (const id of flow.candidates) hold(flow.specFile, id);
  for (const candidate of candidates) for (const specFile of candidate.existingSpecs) hold(specFile, candidate.id);
  return {
    operations: [...operations.values()],
    candidates: aimed,
    specToCandidates: [...bySpec].map(([specFile, ids]) => ({ specFile, candidates: [...ids] })),
  };
}
