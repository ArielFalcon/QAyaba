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

/* Prime to the size of the dimensions' cycles, so the sample walks through every value of every dimension. */
const SAMPLE_STRIDE = 23;

/* A brief and a pack in one prompt with no tree: the shape whose brief frames only established facts. */
const isBriefWithPack = (s: CellSpec): boolean => s.grounding === "brief+pack" && s.mode === "diff" && s.target === "e2e" && s.tree === "none";

const sampleSpecs = (): CellSpec[] => {
  const all = allValidSpecs();
  const chosen = new Map<string, CellSpec>();
  for (const spec of [...all.filter((_, i) => i % SAMPLE_STRIDE === 0), ...all.filter(isBriefWithPack).slice(0, 4)]) chosen.set(cellName(spec), spec);
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
