/* A flow's brief carries the evidence of the candidate pages its routes name, bounded per brief and per proof. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageCandidate } from "../../../support/use-case-candidate.ts";
import { MAX_BRIEF_PROOFS, MAX_PROOF_STEPS, proofsFor } from "@contexts/coordination/application/change-proofs.ts";

const page = (route: string, steps: number) => pageCandidate(route, [...Array.from({ length: steps - 1 }, (_, i) => `f${i}.ts::s${i}`), `page ${route}`]);

test("a route names a template page with any parameter values, and a page no route names is left out", () => {
  assert.deepEqual(proofsFor([page("/shops/:city", 3), page("/orders", 3)], ["/shops/madrid"]), ["/shops/:city: f0.ts::s0 > f1.ts::s1 > page /shops/:city"]);
  assert.equal(proofsFor([page("/orders", 3)], ["/login"]), undefined);
  assert.equal(proofsFor(undefined, ["/orders"]), undefined);
});

test("a brief carries at most the declared number of proofs, in the order they came", () => {
  const pages = Array.from({ length: MAX_BRIEF_PROOFS + 2 }, (_, i) => page(`/p${i}`, 2));
  const lines = proofsFor(pages, pages.map((p) => (p.entry as { route: string }).route))!;
  assert.equal(lines.length, MAX_BRIEF_PROOFS);
  assert.ok(lines[0]!.startsWith("/p0:"));
});

test("a proof longer than the bound keeps the change and the page and says how many steps it left out", () => {
  const long = page("/orders", MAX_PROOF_STEPS + 4);
  const [line] = proofsFor([long], ["/orders"])!;
  const steps = line!.slice("/orders: ".length).split(" > ");
  assert.equal(steps.length, MAX_PROOF_STEPS);
  assert.equal(steps[0], "f0.ts::s0");
  assert.equal(steps.at(-1), "page /orders");
  assert.match(line!, /\(5 more\)/);
});
