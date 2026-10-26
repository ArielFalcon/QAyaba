/* The response oracle is aimed at the operations the change reaches: nothing else is named for corruption. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FAULT_OPERATIONS, faultAimOf } from "@contexts/run-orchestration/application/run-flow/fault-aim.ts";
import { operationKey } from "@contexts/objective-signal/application/index.ts";
import { operationUrlPattern } from "@contexts/service-topology/application/index.ts";
import type { ChangeScope } from "@contexts/change-analysis/application/index.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { EntryPoint } from "@kernel/change-reach.ts";

const op = (verb: string, path: string): EntryPoint => ({ kind: "operation", repo: "api", verb, path });
const scope = (reach: EntryPoint[], over: Partial<ChangeScope> = {}): ChangeScope => ({
  repos: [], reach: reach.map((entry) => ({ entry, tier: "direct", basis: "handler", evidence: [], seeds: [], confidence: 1 })), hubs: [], disagreements: [], omitted: 0, degraded: [], ...over,
});
const candidate = (id: string, entry: EntryPoint, over: Partial<UseCaseCandidate> = {}): UseCaseCandidate => ({
  id, entry, tier: "direct", basis: "handler", evidence: [], seeds: [], confidence: 1, reachability: "via-page", pages: ["/p"], existingSpecs: [], ...over,
});
const key = (verb: string, path: string): string => operationKey({ verb, pattern: operationUrlPattern({ path })! });

test("the aim names the operations the scope reaches and the use cases that stand on them, with the specs written or held for each", () => {
  const orders = op("get", "/orders/{id}");
  const aim = faultAimOf({
    scope: scope([orders, { kind: "page", repo: "web", route: "/p" }]),
    candidates: [candidate("uc-1", orders, { existingSpecs: ["flows/old.spec.ts"] }), candidate("uc-2", { kind: "page", repo: "web", route: "/p" }, { reachability: "page" })],
    flowCandidates: [{ specFile: "flows/new.spec.ts", candidates: ["uc-1"] }],
  });
  assert.deepEqual(aim?.operations.map((o) => o.verb), ["GET"]);
  assert.deepEqual(aim?.candidates, [{ candidateId: "uc-1", operations: [key("GET", "/orders/{id}")] }], "a page use case has no operation to corrupt");
  assert.deepEqual(aim?.specToCandidates.map((m) => [m.specFile, m.candidates]).sort(), [["flows/new.spec.ts", ["uc-1"]], ["flows/old.spec.ts", ["uc-1"]]]);
});

test("an operation behind a use case is named even when the scope's own reach does not list it", () => {
  const aim = faultAimOf({ scope: scope([{ kind: "page", repo: "web", route: "/p" }]), candidates: [candidate("uc-1", op("POST", "/carts"))], flowCandidates: [] });
  assert.deepEqual(aim?.operations.map((o) => `${o.verb} ${o.pattern}`), [key("POST", "/carts")]);
});

test("no scope, a degraded scope, or no operation in reach gives no aim, so nothing is corrupted", () => {
  assert.equal(faultAimOf({ scope: undefined, candidates: [], flowCandidates: [] }), undefined);
  assert.equal(faultAimOf({ scope: scope([op("GET", "/orders")], { degraded: [{ repo: "api", reason: "not indexed" }] }), candidates: [], flowCandidates: [] }), undefined);
  assert.equal(faultAimOf({ scope: scope([{ kind: "page", repo: "web", route: "/p" }]), candidates: [], flowCandidates: [] }), undefined);
  assert.equal(faultAimOf({ scope: scope([op("GET", "/{id}")]), candidates: [], flowCandidates: [] }), undefined, "an operation with no literal segment would match every path");
});

test("at most the seed's bound of operations is named, once each", () => {
  const many = Array.from({ length: MAX_FAULT_OPERATIONS + 10 }, (_, i) => op("GET", `/r${i}/items`));
  const aim = faultAimOf({ scope: scope([...many, many[0]!]), candidates: [], flowCandidates: [] });
  assert.equal(aim?.operations.length, MAX_FAULT_OPERATIONS);
});
