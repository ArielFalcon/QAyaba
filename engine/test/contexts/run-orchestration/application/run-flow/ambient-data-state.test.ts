/* What the run does with a passing case that checked a page only as DEV served it empty: the change's untaken arms on that page are attributed to the data DEV lacks there, and the flow that owns the case's spec is told how to give the page data. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ambientPinFindings, armsOnPinnedPages } from "@contexts/run-orchestration/application/run-flow/ambient-data-state.ts";
import { gapUnits } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { flowOfFinding } from "@contexts/coordination/application/lead-correction.ts";
import type { AmbientDataPin } from "@kernel/page-data-read.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const PIN: AmbientDataPin = { file: "flows/listing.spec.ts", test: "listing › renders the empty listing", pages: ["/listing/madrid"] };
const arm = (file: string, line: number) => ({ file, line, column: 0, kind: "if", arm: "then" });
const seeded = (route: string, file: string) => pageCandidate(route, undefined, { seeds: [{ file, symbol: "render" }] });

test("an untaken arm whose file seeds a use case on a pinned page is attributed to that page, and one on no pinned page is not", () => {
  const candidates = [seeded("/listing/:city", "src/listing.ts"), seeded("/cart", "src/cart.ts")];
  const attributed = armsOnPinnedPages([arm("src/listing.ts", 12), arm("src/cart.ts", 4), arm("src/stray.ts", 1)], [PIN], candidates);
  assert.deepEqual(attributed.map((a) => [`${a.file}:${a.line}`, a.pages]), [["src/listing.ts:12", ["/listing/madrid"]]]);
  assert.deepEqual(armsOnPinnedPages([arm("src/listing.ts", 12)], [], candidates), []);
});

test("the gap's unit of an attributed arm says the page DEV served empty, and an arm on no pinned page reads as before", () => {
  const listing = arm("src/listing.ts", 12);
  const cart = arm("src/cart.ts", 4);
  const before = gapUnits([], [listing, cart], []);
  const after = gapUnits([], [listing, cart], [], [], [{ ...listing, pages: ["/listing/madrid"] }]);
  assert.ok(after[0]!.text.includes("/listing/madrid") && !before[0]!.text.includes("/listing/madrid"), "the attributed arm names the page");
  assert.equal(after[1]!.text, before[1]!.text, "an arm on no pinned page is unchanged");
  assert.deepEqual(after.map((u) => [u.finding.file, u.finding.line]), before.map((u) => [u.finding.file, u.finding.line]), "routing by file and line is unchanged");
});

test("each pinned case is a finding for the flow that owns its spec, naming the places the app declares when it declares any", () => {
  const [finding] = ambientPinFindings([PIN], ["north", "south"]);
  const flows = [
    { id: "cart", objective: "the cart", specFile: "flows/cart.spec.ts", sessionOpen: true, seedFiles: [] },
    { id: "listing", objective: "the listing", specFile: "flows/listing.spec.ts", sessionOpen: true, seedFiles: [] },
  ];
  assert.equal(flowOfFinding(finding!.finding, flows), "listing");
  assert.equal(finding!.finding.spec, PIN.file);
  for (const part of [PIN.test, ...PIN.pages, "north", "south", "set_geolocation"]) assert.ok(finding!.finding.text.includes(part), part);
});

test("with no place declared, the pinned case's finding says the state is DEV's and never to intercept requests", () => {
  const [finding] = ambientPinFindings([PIN], []);
  assert.ok(finding!.finding.text.includes("Never intercept requests"), "it forbids the faked route");
  assert.equal(finding!.finding.text.includes("set_geolocation"), false, "it names no place");
});

const COUNT_PIN: AmbientDataPin = { file: "flows/search.spec.ts", test: "search › lists the results", pages: [], counts: [{ page: "/search", count: 7 }] };

test("a case that asserts the result count the pack read is a finding for its spec's flow that names the page and the count, and never asks for a place", () => {
  const findings = ambientPinFindings([COUNT_PIN], ["north"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.finding.spec, COUNT_PIN.file);
  for (const part of [COUNT_PIN.test, "/search", "7"]) assert.ok(findings[0]!.finding.text.includes(part), part);
  assert.equal(findings[0]!.finding.text.includes("north"), false, "the count is not given by moving to a place");
});

test("a case pinned on an empty page and on a read count gets one finding for each", () => {
  const both: AmbientDataPin = { ...PIN, counts: COUNT_PIN.counts };
  assert.equal(ambientPinFindings([both], []).length, 2);
});
