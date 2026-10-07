/* The cheap stand-in for the exhaustive matrix test: a deterministic sample of the reachable combinations, plus the few shapes the rule checks below need, linted against the recorded baseline. A mutation run gives each mutant a short timeout that linting every combination cannot meet, and this sample still puts real prompts through every rule. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIMENSIONS,
  allValidSpecs,
  buildMatrix,
  cellName,
  collectFindings,
  lintMatrixCell,
  loadBaseline,
  type CellSpec,
  type MatrixCell,
} from "./prompt-contract-matrix.ts";
import { ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { hasTrustLanguage, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* Prime to the size of the dimensions' cycles, so the sample walks through every value of every dimension. The smallest prime whose sample, assembled once per layer for each combination, stays within the prompts a mutant run is sized for. */
const SAMPLE_STRIDE = 47;

/* A brief and a pack in one prompt with no tree: the shape whose brief frames only established facts. */
const isBriefWithPack = (s: CellSpec): boolean => s.grounding === "brief+pack" && s.mode === "diff" && s.target === "e2e" && s.tree === "none";

/* A signal of co-change files alone is a few dozen combinations the stride mostly skips: the first one of each phase and target keeps the decision it bears on (is a blast radius explored?) in the sample, on a first pass and on every regeneration. */
const firstCoChangeOfEachPhaseAndTarget = (all: readonly CellSpec[]): CellSpec[] => {
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = `${s.phase}/${s.target}`;
    if (s.structuralSignal !== "co-change" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sampleSpecs = (): CellSpec[] => {
  const all = allValidSpecs();
  const chosen = new Map<string, CellSpec>();
  for (const spec of [...all.filter((_, i) => i % SAMPLE_STRIDE === 0), ...all.filter(isBriefWithPack).slice(0, 4), ...firstCoChangeOfEachPhaseAndTarget(all)]) chosen.set(cellName(spec), spec);
  /* A value the stride skipped (a rare one, like the context mode) is brought in by the first combination that has it. */
  for (const dimension of Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>) {
    for (const value of DIMENSIONS[dimension] as readonly unknown[]) {
      const rare = all.find((s) => s[dimension] === value);
      if (rare && ![...chosen.values()].some((s) => s[dimension] === value)) chosen.set(cellName(rare), rare);
    }
  }
  return [...chosen.values()];
};

let cells: Promise<MatrixCell[]> | undefined;
const cellsOnce = (): Promise<MatrixCell[]> => (cells ??= buildMatrix(ROOT, sampleSpecs()));

test("the sample exercises every value of every dimension, and both static layers", async () => {
  const specs = sampleSpecs();
  for (const dimension of Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>) {
    for (const value of DIMENSIONS[dimension] as readonly unknown[]) {
      assert.ok(specs.some((s) => s[dimension] === value), `${dimension}=${String(value)} is in the sample`);
    }
  }
  assert.deepEqual([...new Set((await cellsOnce()).map((c) => c.layer))].sort(), ["codex", "opencode"]);
});

/* The most prompts the sample may assemble: the work one mutant's run of the whole preset is sized for, against the 15 second timeout every mutant gets. Each cell of a layer is assembled from its own input, so every combination in the sample costs two prompts. */
const MOST_PROMPTS_A_MUTANT_RUN_ASSEMBLES = 860;

test("the sample assembles no more prompts than a mutant run is sized for, so every mutant fits its timeout", async () => {
  const cells = await cellsOnce();
  assert.ok(cells.length > 0, "setup: the sample is assembled");
  assert.ok(cells.length <= MOST_PROMPTS_A_MUTANT_RUN_ASSEMBLES, `${cells.length} prompts are assembled, over the ${MOST_PROMPTS_A_MUTANT_RUN_ASSEMBLES} a mutant run is sized for`);
});

test("the sample carries a signal of co-change files alone on a first pass and on every kind of regeneration, in both targets", () => {
  const coChange = sampleSpecs().filter((s) => s.structuralSignal === "co-change");
  assert.ok(coChange.some((s) => s.phase === "first"), "a first pass");
  for (const phase of DIMENSIONS.phase.filter((p) => p !== "first")) assert.ok(coChange.some((s) => s.phase === phase), `${phase} regeneration`);
  for (const target of DIMENSIONS.target) assert.ok(coChange.some((s) => s.target === target), target);
});

test("a sample of the reachable combinations is clean against the recorded baseline", async () => {
  assert.deepEqual([...collectFindings(await cellsOnce(), loadBaseline(ROOT)).keys()], []);
});

test("dropping the framing a section declares makes the trust-language check report that section", async () => {
  const withFraming = (await cellsOnce()).filter((c) =>
    c.lint.sections.some((s) => s.layer === "assembled" && s.claims.some((k) => k.kind === "frames") && hasTrustLanguage(s.text)),
  );
  assert.ok(withFraming.length > 0, "the sample has sections that both use trust language and declare a framing");
  for (const cell of withFraming.slice(0, 20)) {
    const stripped = {
      ...cell.lint,
      sections: cell.lint.sections.map((s) => ({ ...s, claims: s.claims.filter((k) => k.kind !== "frames") })),
    };
    const findings = lintCell(stripped, { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES, artifactReferences: ARTIFACT_REFERENCES });
    assert.ok(findings.some((f) => f.rule === "R10"), `${cell.key}: an undeclared framing is reported`);
  }
});

test("a brief section that keeps its established framing but is reworded to disown its facts is reported", async () => {
  const establishedOnly = (s: MatrixCell["lint"]["sections"][number]): boolean => {
    const stances = s.claims.flatMap((k) => (k.kind === "frames" ? [k.as] : []));
    return s.id === "context-brief" && stances.length > 0 && stances.every((stance) => stance === "established");
  };
  const cell = (await cellsOnce()).find((c) => c.layer === "opencode" && c.lint.sections.some(establishedOnly));
  assert.ok(cell, "the sample has a cell with a brief that frames only established facts");
  const reworded = {
    ...cell,
    lint: {
      ...cell.lint,
      sections: cell.lint.sections.map((s) => (s.id === "context-brief" ? { ...s, text: `${s.text}\n(The brief above is NOT authoritative and must be verified against the live DOM.)` } : s)),
    },
  };
  assert.deepEqual(lintMatrixCell(cell, loadBaseline(ROOT)).filter((f) => f.rule === "R14"), [], "the real section agrees with its framing");
  assert.deepEqual(lintMatrixCell(reworded, undefined).filter((f) => f.rule === "R14").map((f) => f.sections), [["context-brief"]]);
});
