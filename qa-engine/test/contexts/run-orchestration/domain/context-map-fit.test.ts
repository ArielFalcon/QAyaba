import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMapFitsRun } from "@contexts/run-orchestration/domain/context-map-fit.ts";
import type { ChangedFile } from "@contexts/run-orchestration/domain/context-map-validity.ts";

const BUILT = "aaaa111";
const RUN = "bbbb222";
const MAP = {
  routes: [
    { path: "/shops", source: "src/shops.routes.ts", implementationFiles: ["src/shops/shops.page.ts"] },
    { path: "/orders", source: "src/shops.routes.ts", implementationFiles: ["src/orders/orders.page.ts"] },
  ],
  api: [],
  feBe: [{ route: "/shops" }, { route: "/orders" }],
};
const run = { sha: RUN, triggeredByService: false };
const compared = (changes: ChangedFile[] | undefined) => {
  const asked: Array<[string, string]> = [];
  return { asked, changesBetween: (from: string, to: string) => (asked.push([from, to]), changes) };
};

test("a map built at the run's own commit fits without comparing commits", () => {
  const c = compared([]);
  assert.deepEqual(contextMapFitsRun(MAP, RUN, run, c.changesBetween), { fits: true, map: MAP, reason: "none" });
  assert.deepEqual(c.asked, []);
});

test("a map from another commit fits when none of the files it names changed, and the comparison runs from the map's commit to the run's", () => {
  const c = compared([{ status: "M", path: "src/unrelated.ts" }]);
  assert.deepEqual(contextMapFitsRun(MAP, BUILT, run, c.changesBetween), { fits: true, map: MAP, reason: "none" });
  assert.deepEqual(c.asked, [[BUILT, RUN]]);
});

test("a page whose implementation files were only modified keeps its route and loses its front-to-back links", () => {
  const fit = contextMapFitsRun(MAP, BUILT, run, compared([{ status: "M", path: "src/shops/shops.page.ts" }]).changesBetween);
  assert.equal(fit.fits, true);
  assert.deepEqual(fit.map, { ...MAP, feBe: [{ route: "/orders" }] });
  assert.equal(fit.reason, "none");
});

test("a changed route declaration does not fit and names the inputs; commits that cannot be compared do not fit and name the sha", () => {
  assert.deepEqual(contextMapFitsRun(MAP, BUILT, run, compared([{ status: "M", path: "src/shops.routes.ts" }]).changesBetween), { fits: false, map: undefined, reason: "inputs-changed" });
  assert.deepEqual(contextMapFitsRun(MAP, BUILT, run, compared(undefined).changesBetween), { fits: false, map: undefined, reason: "sha-mismatch" });
});

test("a service-triggered run, or one with no sha, keeps the plain sha comparison and still hands the map on", () => {
  const c = compared([]);
  assert.deepEqual(contextMapFitsRun(MAP, BUILT, { sha: RUN, triggeredByService: true }, c.changesBetween), { fits: false, map: MAP, reason: "sha-mismatch" });
  assert.deepEqual(contextMapFitsRun(MAP, BUILT, { sha: undefined, triggeredByService: false }, c.changesBetween), { fits: false, map: MAP, reason: "sha-mismatch" });
  assert.deepEqual(c.asked, []);
  assert.equal(contextMapFitsRun(MAP, RUN, { sha: RUN, triggeredByService: true }, c.changesBetween).fits, true, "the same commit fits whoever triggered the run");
});
