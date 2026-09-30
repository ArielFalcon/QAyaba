/* The prompt-contract matrix: every run shape that can reach the generator, assembled with the real builders and linted against both static role layers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
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
  assert.ok(valid.every((s) => s.target !== "code" || (s.tree === "none" && !s.contextMap && !s.authSeedUnauthored)));
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

/* ── findings ── */

const LEDGER_PATH = join(ROOT, "scripts", "prompt-contract-ledger.json");

interface LedgerEntry {
  key: string;
  fix: string;
}

function loadLedger(): LedgerEntry[] {
  return (JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as { entries: LedgerEntry[] }).entries;
}

/* Findings the ledger does not record, and ledger entries no cell produces any more. */
function diffLedger(found: ReadonlySet<string>, ledger: readonly LedgerEntry[]): { unrecorded: string[]; stale: string[] } {
  const recorded = new Set(ledger.map((e) => e.key));
  return {
    unrecorded: [...found].filter((k) => !recorded.has(k)).sort(),
    stale: [...recorded].filter((k) => !found.has(k)).sort(),
  };
}

test("a ledger entry no cell produces any more is reported as stale, and a finding it does not record as unrecorded", () => {
  const ledger: LedgerEntry[] = [
    { key: "R1|a|b", fix: "x" },
    { key: "R2|c|d", fix: "x" },
  ];
  assert.deepEqual(diffLedger(new Set(["R1|a|b", "R7|e|f"]), ledger), { unrecorded: ["R7|e|f"], stale: ["R2|c|d"] });
  assert.deepEqual(diffLedger(new Set(["R1|a|b", "R2|c|d"]), ledger), { unrecorded: [], stale: [] });
});

test("every finding of the matrix is recorded in the ledger, and every ledger entry is still produced", async () => {
  const baseline = loadBaseline(ROOT);
  const found = new Set(collectFindings(await matrixOnce(), baseline).keys());
  const { unrecorded, stale } = diffLedger(found, loadLedger());
  assert.deepEqual(unrecorded, [], "a new contract violation must be fixed, not recorded");
  assert.deepEqual(stale, [], "a fixed violation must be removed from the ledger");
});

test("ledger keys are the rule plus the sorted section ids, unique and sorted, each tagged with the change that clears it", () => {
  const ledger = loadLedger();
  const keys = ledger.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate entry");
  assert.deepEqual(keys, [...keys].sort(), "entries are sorted by key");
  for (const entry of ledger) {
    const [rule, ...sections] = entry.key.split("|");
    assert.match(rule ?? "", /^R\d+$/, entry.key);
    assert.ok(sections.length >= 1, entry.key);
    assert.deepEqual(sections, [...sections].sort(), `${entry.key}: section ids are sorted`);
    assert.ok(entry.fix.length > 0, `${entry.key}: tagged with the change that clears it`);
  }
});

/* ── budgets ── */

test("no combination exceeds the recorded user-prompt size or directive volume", async () => {
  const baseline = loadBaseline(ROOT);
  const breaches = (await matrixOnce()).flatMap((cell) =>
    lintMatrixCell(cell, baseline)
      .filter((f) => f.rule === "R9")
      .map((f) => `${cell.key}: ${f.detail}`),
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
