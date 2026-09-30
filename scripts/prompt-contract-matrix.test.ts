/* The prompt-contract matrix: every run shape that can reach the generator, assembled with the real builders and linted against both static role layers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIMENSIONS,
  allValidSpecs,
  buildInput,
  buildMatrix,
  cellName,
  collectFindings,
  isValidSpec,
  loadBaseline,
  loadStaticLayer,
  lintMatrixCell,
  pairwiseSpecs,
  splitAssembledSections,
  type CellSpec,
  type MatrixCell,
} from "./prompt-contract-matrix.ts";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { HARNESS_FACTS_SECTION_ID, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { coerceExplorationBrief, parseExplorationBrief, renderExplorationBrief } from "../src/qa/exploration-brief.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dimensionNames = Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>;

let matrix: Promise<MatrixCell[]> | undefined;
const matrixOnce = (): Promise<MatrixCell[]> => (matrix ??= buildMatrix());

/* ── coverage ── */

test("the reference set covers every value of every dimension and every valid pair of values", () => {
  const valid = allValidSpecs();
  const reference = pairwiseSpecs();
  const pairOf = (spec: CellSpec, a: keyof CellSpec, b: keyof CellSpec): string => `${a}=${String(spec[a])}|${b}=${String(spec[b])}`;

  for (const dimension of dimensionNames) {
    for (const value of DIMENSIONS[dimension] as readonly unknown[]) {
      assert.ok(
        valid.some((s) => s[dimension] === value) === reference.some((s) => s[dimension] === value),
        `${dimension}=${String(value)} is reachable exactly when the reference set exercises it`,
      );
    }
  }
  for (let i = 0; i < dimensionNames.length; i++) {
    for (let j = i + 1; j < dimensionNames.length; j++) {
      const a = dimensionNames[i]!;
      const b = dimensionNames[j]!;
      const reachable = new Set(valid.map((s) => pairOf(s, a, b)));
      const covered = new Set(reference.map((s) => pairOf(s, a, b)));
      assert.deepEqual([...reachable].filter((p) => !covered.has(p)), [], `every reachable ${a}/${b} pair is covered`);
    }
  }
});

test("only combinations that can reach the agent are in the matrix", () => {
  const valid = allValidSpecs();
  assert.ok(valid.length > 0 && valid.every(isValidSpec));
  assert.ok(valid.every((s) => s.mode !== "context" || (s.phase === "first" && s.grounding === "none" && s.tree === "none")));
  assert.ok(valid.every((s) => s.target !== "code" || (s.tree === "none" && !s.contextMap && !s.authSeedUnauthored && !s.harnessFacts)));
  assert.ok(valid.every((s) => s.mode !== "context" || !s.harnessFacts));
  assert.ok(valid.every((s) => s.tree === "none" || s.phase === "regen-fix" || s.phase === "selector-fix"));
  assert.ok(valid.every((s) => !s.structuralSignal || s.grounding === "none" || s.grounding === "pack"));
  assert.equal(new Set(valid.map(cellName)).size, valid.length, "cell names are unique");
});

test("the matrix holds every valid combination against both static layers", async () => {
  const cells = await matrixOnce();
  assert.equal(cells.length, allValidSpecs().length * 2);
  assert.deepEqual([...new Set(cells.map((c) => c.layer))].sort(), ["codex", "opencode"]);
  for (const layer of ["opencode", "codex"] as const) {
    const sections = loadStaticLayer(layer, ROOT);
    assert.ok(sections.length > 0 && sections.every((s) => s.layer === "static" && s.text.length > 0), layer);
  }
});

test("a cell's assembled sections reproduce the assembled prompt exactly", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  for (const spec of pairwiseSpecs()) {
    const assembled = buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 });
    const sections = splitAssembledSections(assembled);
    assert.equal(sections.map((s) => s.text).join("\n"), assembled.text, cellName(spec));
    assert.deepEqual(sections.map((s) => s.id), Object.keys(assembled.sectionSizes), cellName(spec));
  }
});

test("cells with harness facts carry the facts-only section, linted as data with no directive or framing", async () => {
  const cells = await matrixOnce();
  const withFacts = cells.filter((c) => c.spec.harnessFacts);
  assert.ok(withFacts.length > 0, "the matrix exercises harness facts");
  for (const cell of withFacts) {
    const section = cell.lint.sections.find((s) => s.id === HARNESS_FACTS_SECTION_ID);
    assert.ok(section?.factsOnly, `${cell.key}: the facts section is present and marked facts-only`);
    assert.equal(section?.claims.some((c) => c.kind === "directs" || c.kind === "frames"), false, cell.key);
  }
  assert.ok(cells.filter((c) => !c.spec.harnessFacts).every((c) => !c.lint.sections.some((s) => s.id === HARNESS_FACTS_SECTION_ID)));
});

/* ── no tolerated violations ── */

test("no violation is tolerated: the matrix has zero findings, no ledger of exceptions exists and the matrix module offers no waiver", async () => {
  const baseline = loadBaseline(ROOT);
  assert.deepEqual([...collectFindings(await matrixOnce(), baseline).keys()], [], "every combination is clean");
  assert.equal(existsSync(join(ROOT, "scripts", "prompt-contract-ledger.json")), false, "no ledger file");
  const exported = Object.keys(await import("./prompt-contract-matrix.ts"));
  assert.deepEqual(exported.filter((name) => /ledger|waiv|tolerat|allow|exempt/i.test(name)), [], "no waiver mechanism");
});

/* ── budgets ── */

test("no combination exceeds the recorded user-prompt size or directive volume", async () => {
  const baseline = loadBaseline(ROOT);
  const breaches = (await matrixOnce()).flatMap((cell) =>
    lintMatrixCell(cell, baseline)
      .filter((f) => f.rule === "R9")
      .map((f) => `${cell.key}: ${f.budget} ${f.measured} exceeds ${f.limit}`),
  );
  assert.deepEqual(breaches, []);
});

test("the recorded baseline stays inside the reference production prompt size and names only reachable cells", async () => {
  const baseline = loadBaseline(ROOT);
  const names = new Set(allValidSpecs().map(cellName));
  assert.ok(Object.keys(baseline.cells).length > 0);
  for (const [name, measure] of Object.entries(baseline.cells)) {
    assert.ok(names.has(name), `${name} is a reachable combination`);
    assert.ok(measure.bytes <= baseline.globalUserPromptBytes, name);
    assert.ok(measure.bytes <= baseline.ceiling.bytes && measure.directives <= baseline.ceiling.directives, name);
  }
});

/* ── the trust-language cross-check is live ── */

test("dropping the framing a section declares makes the trust-language check report that section", async () => {
  const cells = await matrixOnce();
  const withFraming = cells.filter((c) =>
    c.lint.sections.some(
      (s) => s.layer === "assembled" && s.claims.some((k) => k.kind === "frames") && /ground truth|authoritative|stale|unverified/i.test(s.text),
    ),
  );
  assert.ok(withFraming.length > 0, "the matrix has sections that both use trust language and declare a framing");
  for (const cell of withFraming.slice(0, 20)) {
    const stripped = {
      ...cell.lint,
      sections: cell.lint.sections.map((s) => ({ ...s, claims: s.claims.filter((k) => k.kind !== "frames") })),
    };
    const findings = lintCell(stripped, { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES });
    assert.ok(findings.some((f) => f.rule === "R10"), `${cell.key}: an undeclared framing is reported`);
  }
});
