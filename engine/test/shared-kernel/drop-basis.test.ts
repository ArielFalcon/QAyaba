/* The drop-basis table is the one statement of what a basis requires: the refusal of a drop answers in its words. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DROP_BASIS, DROP_BASIS_RULES, GOVERNED_ROUTE_RULE, armDeclineRefusal, dropRefusal, refusedDropBasesOf } from "@kernel/drop-basis.ts";
import { pageCandidate } from "../support/use-case-candidate.ts";

const seeded = (files: string[], over = {}) => pageCandidate("/cart", undefined, { seeds: files.map((file) => ({ file, symbol: "*" })), ...over });

test("the reason a drop is refused is the table's wording for its basis", () => {
  const code = dropRefusal(seeded(["src/cart.ts"]), DROP_BASIS.NO_OBSERVABLE_CHANGE) ?? "";
  assert.ok(code.startsWith(DROP_BASIS_RULES[DROP_BASIS.NO_OBSERVABLE_CHANGE].refusedWhen!) && code.includes("src/cart.ts"), code);
  assert.equal(dropRefusal(seeded(["src/cart.ts"]), DROP_BASIS.ALREADY_COVERED), DROP_BASIS_RULES[DROP_BASIS.ALREADY_COVERED].refusedWhen);
  const governed = pageCandidate("/cart", [], { basis: "route-config", evidence: ["route table entry changed"] });
  for (const basis of GOVERNED_ROUTE_RULE.bases) assert.ok((dropRefusal(governed, basis) ?? "").startsWith(GOVERNED_ROUTE_RULE.refusedWhen), basis);
});

test("a basis the table gives no refusal fact for is never refused on the candidate's own facts", () => {
  assert.equal(DROP_BASIS_RULES[DROP_BASIS.NEEDS_UNAVAILABLE_STATE].refusedWhen, undefined);
  assert.equal(dropRefusal(seeded(["src/cart.ts"]), DROP_BASIS.NEEDS_UNAVAILABLE_STATE), undefined);
});

test("the bases announced for a use case are exactly the ones whose drop is refused", () => {
  const cases = [seeded(["src/cart.css"], { existingSpecs: ["flows/cart.spec.ts"] }), seeded(["src/cart.ts"], { existingSpecs: ["flows/cart.spec.ts"] }), seeded(["src/cart.css"]), pageCandidate("/cart", [], { basis: "route-config", evidence: ["x"], existingSpecs: ["flows/cart.spec.ts"] })];
  for (const candidate of cases) {
    const announced = refusedDropBasesOf(candidate);
    for (const basis of Object.values(DROP_BASIS)) assert.equal(announced.includes(basis), dropRefusal(candidate, basis) !== undefined, `${candidate.seeds.map((s) => s.file).join()} ${basis}`);
  }
});

test("the decline of an arm is contradicted only when the basis is refused for every use case its file seeds", () => {
  const code = seeded(["src/cart.ts"]);
  const style = seeded(["src/cart.css"]);

  assert.equal(armDeclineRefusal([code], DROP_BASIS.NO_OBSERVABLE_CHANGE), dropRefusal(code, DROP_BASIS.NO_OBSERVABLE_CHANGE));
  assert.equal(armDeclineRefusal([code, style], DROP_BASIS.NO_OBSERVABLE_CHANGE), undefined, "one use case the basis holds for is enough");
  assert.equal(armDeclineRefusal([], DROP_BASIS.NO_OBSERVABLE_CHANGE), undefined, "a file that seeds no use case contradicts nothing");
  assert.equal(armDeclineRefusal([code], DROP_BASIS.ALREADY_COVERED), DROP_BASIS_RULES[DROP_BASIS.ALREADY_COVERED].refusedWhen);
  assert.equal(armDeclineRefusal([code, seeded(["src/cart.ts"], { existingSpecs: ["flows/cart.spec.ts"] })], DROP_BASIS.ALREADY_COVERED), undefined);
  assert.equal(armDeclineRefusal([code], DROP_BASIS.NEEDS_UNAVAILABLE_STATE), undefined, "a state the orchestrator cannot see stands");
});
