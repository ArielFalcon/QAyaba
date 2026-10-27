/* The coordination prompts (the sidekicks' briefs and the lead's review, correction, re-plan and exploration turns) are assembled from the section registry, linted like the generator's and held to budgets recorded apart. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COORDINATION_PROMPTS } from "@contexts/coordination/application/index.ts";
import { BaselineIncreaseError, buildCoordinationMatrix, lintCoordinationCell, loadCoordinationBaseline, recordCoordinationBaseline } from "./prompt-contract-matrix.ts";

const cells = buildCoordinationMatrix();
const baseline = loadCoordinationBaseline();

test("every coordination prompt of the registry has a cell in the matrix", () => {
  const covered = new Set(cells.map((cell) => cell.prompt));
  assert.deepEqual(Object.keys(COORDINATION_PROMPTS).filter((id) => !covered.has(id)), []);
});

test("no coordination prompt breaks a lint rule, and every delegation brief is held to its contract and its grant", () => {
  assert.deepEqual(cells.flatMap((cell) => lintCoordinationCell(cell, baseline).map((finding) => `${cell.key}: ${finding.rule} ${finding.part ?? ""} ${finding.sections.join(",")}`)), []);
  const briefs = cells.filter((cell) => cell.prompt.endsWith("-brief"));
  assert.ok(briefs.length >= 4);
  assert.ok(briefs.every((cell) => cell.lint.delegation !== undefined));
});

test("every coordination cell has a recorded budget and the committed baseline is what recording writes now", () => {
  assert.deepEqual(cells.filter((cell) => baseline.cells[cell.key] === undefined).map((cell) => cell.key), []);
  const { lastIncrease, ...committed } = baseline;
  const { lastIncrease: none, ...current } = recordCoordinationBaseline(cells);
  assert.deepEqual(committed, current);
});

test("a coordination prompt that outgrows its recorded budget fails, and recording the raise needs a reason", () => {
  const grown = cells.map((cell, i) => (i === 0 ? { ...cell, assembledBytes: cell.assembledBytes + 50 } : cell));
  assert.ok(lintCoordinationCell({ ...grown[0]!, lint: { ...grown[0]!.lint, sections: [...grown[0]!.lint.sections, { id: "extra", layer: "assembled", text: "x".repeat(50), claims: [] }] } }, baseline).some((finding) => finding.rule === "R9"));
  assert.throws(() => recordCoordinationBaseline(grown, baseline), BaselineIncreaseError);
  assert.ok(recordCoordinationBaseline(grown, baseline, { increaseReason: "a section the prompt now needs" }).lastIncrease);
});
