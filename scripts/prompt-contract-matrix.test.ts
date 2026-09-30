/* The prompt-contract matrix: every run shape that can reach the generator, assembled with the real builders and linted against both static role layers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaselineIncreaseError,
  DIMENSIONS,
  GLOBAL_USER_PROMPT_BASELINE_BYTES,
  allValidSpecs,
  bucketOf,
  buildInput,
  buildMatrix,
  cellName,
  collectFindings,
  isValidSpec,
  loadBaseline,
  loadStaticLayer,
  lintMatrixCell,
  recordBaseline,
  splitAssembledSections,
  type Baseline,
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

test("every value of every dimension is reachable in at least one combination that can reach the agent", () => {
  const valid = allValidSpecs();
  for (const dimension of dimensionNames) {
    for (const value of DIMENSIONS[dimension] as readonly unknown[]) {
      assert.ok(valid.some((s) => s[dimension] === value), `${dimension}=${String(value)} is exercised by some combination`);
    }
  }
});

test("only combinations that can reach the agent are in the matrix", () => {
  const valid = allValidSpecs();
  assert.ok(valid.length > 0 && valid.every(isValidSpec));
  assert.ok(valid.every((s) => s.mode !== "context" || (s.phase === "first" && s.grounding === "none" && s.tree === "none")));
  assert.ok(valid.every((s) => s.target !== "code" || (s.tree === "none" && !s.contextMap && !s.authSeedUnauthored && !s.harnessFacts && !s.service)));
  assert.ok(valid.every((s) => s.mode !== "context" || !s.harnessFacts));
  assert.ok(valid.every((s) => s.tree === "none" || s.phase === "regen-fix" || s.phase === "selector-fix"));
  assert.ok(valid.every((s) => !s.structuralSignal || s.grounding === "none" || s.grounding === "pack"));
  assert.ok(valid.every((s) => s.briefBlast === "filled" || s.grounding === "brief" || s.grounding === "brief+pack"));
  assert.ok(valid.every((s) => s.packDom || ((s.grounding === "pack" || s.grounding === "brief+pack") && s.contextMap)));
  assert.equal(new Set(valid.map(cellName)).size, valid.length, "cell names are unique");
});

test("a code run can be asked to cover a change it already tested, but never to fix a selector", () => {
  const codePhases = new Set(allValidSpecs().filter((s) => s.target === "code").map((s) => s.phase));
  assert.ok(codePhases.has("regen-coverage"));
  assert.equal(codePhases.has("selector-fix"), false);
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
  for (const spec of allValidSpecs().filter((_, i) => i % 7 === 0)) {
    const assembled = buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 });
    const sections = splitAssembledSections(assembled);
    assert.equal(sections.map((s) => s.text).join("\n"), assembled.text, cellName(spec));
    assert.deepEqual(sections.map((s) => s.id), Object.keys(assembled.sectionSizes), cellName(spec));
  }
});

test("the shapes the matrix adds are really assembled: a pack with no DOM, a brief with no blast radius, and the service block", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const spec = (over: Partial<CellSpec>): CellSpec => ({
    ...allValidSpecs().find((s) => s.mode === "diff" && s.target === "e2e" && s.phase === "regen-fix" && s.tree === "none" && s.grounding === "brief+pack" && s.contextMap && !s.service && s.briefBlast === "filled" && s.packDom)!,
    ...over,
  });
  const claimsOf = async (s: CellSpec) => Object.values(buildPromptAssembled(await buildInput(s), { budgetBytes: 0 }).claims).flat();
  const full = await claimsOf(spec({}));
  assert.ok(full.some((c) => c.kind === "provides" && c.fact === "dom-live"));
  assert.ok(full.some((c) => c.kind === "provides" && c.fact === "blast-radius"));

  const contractsOnly = await claimsOf(spec({ packDom: false }));
  assert.equal(contractsOnly.some((c) => c.kind === "provides" && c.fact === "dom-live"), false, "no live DOM without a DOM capture");
  assert.ok(contractsOnly.some((c) => c.kind === "provides" && c.fact === "api-operations"), "the pack still holds the contracts");

  const noBlast = await claimsOf(spec({ briefBlast: "empty" }));
  assert.equal(noBlast.some((c) => c.kind === "provides" && c.fact === "blast-radius"), false);

  const withService = await buildInput(spec({ service: true }));
  assert.equal(withService.service?.repo !== undefined, true);
  assert.equal((await buildInput(spec({}))).service, undefined);
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

test("no combination exceeds the recorded user-prompt size or directive volume, and no static layer its recorded size", async () => {
  const baseline = loadBaseline(ROOT);
  const breaches = (await matrixOnce()).flatMap((cell) =>
    lintMatrixCell(cell, baseline)
      .filter((f) => f.rule === "R9")
      .map((f) => `${cell.key}: ${f.budget} ${f.measured} exceeds ${f.limit}`),
  );
  assert.deepEqual(breaches, []);
});

test("the recorded global size is the reference production prompt size the module declares", () => {
  assert.equal(loadBaseline(ROOT).globalUserPromptBytes, GLOBAL_USER_PROMPT_BASELINE_BYTES);
});

test("every combination that can reach the agent has a recorded budget, and the baseline names only combinations that can", () => {
  const baseline = loadBaseline(ROOT);
  const reachable = new Set(allValidSpecs().map(bucketOf));
  assert.deepEqual([...reachable].filter((bucket) => baseline.buckets[bucket] === undefined), [], "a reachable combination has no budget");
  assert.deepEqual(Object.keys(baseline.buckets).filter((bucket) => !reachable.has(bucket)), [], "a budget names no reachable combination");
  for (const [bucket, measure] of Object.entries(baseline.buckets)) {
    assert.ok(measure.bytes <= baseline.globalUserPromptBytes, bucket);
    assert.ok(measure.bytes <= baseline.ceiling.bytes && measure.directives <= baseline.ceiling.directives, bucket);
  }
});

test("a combination with no recorded budget fails instead of borrowing the ceiling", async () => {
  const baseline = loadBaseline(ROOT);
  const [cell] = await matrixOnce();
  const { [cell!.bucket]: dropped, ...rest } = baseline.buckets;
  assert.ok(dropped);
  const findings = lintMatrixCell(cell!, { ...baseline, buckets: rest });
  assert.ok(findings.some((f) => f.rule === "R9" && f.budget === "unrecorded"));
  assert.equal(lintMatrixCell(cell!, baseline).length, 0, "with its budget recorded the same cell is clean");
});

test("the committed baseline is exactly what recording the current prompts writes, so the ratchet tightens whenever a prompt shrinks", async () => {
  const { lastIncrease, ...committed } = loadBaseline(ROOT);
  void lastIncrease;
  const { lastIncrease: none, ...current } = recordBaseline(await matrixOnce());
  void none;
  assert.deepEqual(committed, current, "run `tsx scripts/prompt-contract-matrix.ts --record` (a raise also needs `--allow-increase \"<reason>\"`)");
});

test("a static layer that grows past its recorded size breaches its budget", async () => {
  const baseline = loadBaseline(ROOT);
  const [cell] = await matrixOnce();
  const grown = {
    ...cell!,
    lint: { ...cell!.lint, sections: [...cell!.lint.sections, { id: "static/added", layer: "static" as const, text: "z".repeat(4096), claims: [] }] },
  };
  const breaches = lintMatrixCell(grown, baseline).filter((f) => f.rule === "R9" && f.budget === "static-bytes");
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]?.measured, (breaches[0]?.limit ?? 0) + 4096);
});

/* ── the ratchet only tightens ── */

function raisedTightenedBudgets(committed: Baseline): Array<[string, Baseline]> {
  const bucket = Object.keys(committed.buckets)[0]!;
  const tightened = (mutate: (copy: Baseline) => void): Baseline => {
    const copy = structuredClone(committed);
    mutate(copy);
    return copy;
  };
  return [
    ["a bucket's bytes", tightened((b) => void (b.buckets[bucket]!.bytes -= 1))],
    ["a bucket's directives", tightened((b) => void (b.buckets[bucket]!.directives -= 1))],
    ["the ceiling's bytes", tightened((b) => void (b.ceiling.bytes -= 1))],
    ["the ceiling's directives", tightened((b) => void (b.ceiling.directives -= 1))],
    ["the opencode static layer", tightened((b) => void (b.staticLayers.opencode -= 1))],
    ["the codex static layer", tightened((b) => void (b.staticLayers.codex -= 1))],
  ];
}

test("recording refuses to raise any budget over the committed baseline unless a reason is given", async () => {
  const cells = await matrixOnce();
  const measured = recordBaseline(cells);
  for (const [what, committed] of raisedTightenedBudgets(measured)) {
    assert.throws(() => recordBaseline(cells, committed), BaselineIncreaseError, what);
    assert.throws(() => recordBaseline(cells, committed, { increaseReason: "   " }), BaselineIncreaseError, `${what}: a blank reason is no reason`);
  }
});

test("a raise recorded with a reason stores the reason and the budgets it raised, and a later record without a raise keeps it", async () => {
  const cells = await matrixOnce();
  const measured = recordBaseline(cells);
  const bucket = Object.keys(measured.buckets)[0]!;
  const committed = structuredClone(measured);
  committed.buckets[bucket]!.bytes -= 1;
  committed.staticLayers.codex -= 1;
  const raised = recordBaseline(cells, committed, { increaseReason: "a section the prompt now needs" });
  assert.deepEqual(raised.lastIncrease, { reason: "a section the prompt now needs", budgets: [`${bucket}:bytes`, "static:codex"] });
  assert.deepEqual(recordBaseline(cells, raised).lastIncrease, raised.lastIncrease);
});

test("recording accepts a baseline that only shrinks, drops a combination or adds one, and states no raise", async () => {
  const cells = await matrixOnce();
  const measured = recordBaseline(cells);
  const [first, second] = Object.keys(measured.buckets);
  const looser = structuredClone(measured);
  looser.buckets[first!]!.bytes += 100;
  looser.ceiling.bytes += 100;
  looser.staticLayers.opencode += 100;
  delete looser.buckets[second!];
  const shrunk = recordBaseline(cells, looser);
  assert.deepEqual(shrunk.buckets, measured.buckets);
  assert.equal(shrunk.lastIncrease, undefined);
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

test("a brief section that keeps its established framing but is reworded to disown its facts is reported", async () => {
  const cells = await matrixOnce();
  const establishedOnly = (s: MatrixCell["lint"]["sections"][number]): boolean => {
    const stances = s.claims.flatMap((k) => (k.kind === "frames" ? [k.as] : []));
    return s.id === "context-brief" && stances.length > 0 && stances.every((stance) => stance === "established");
  };
  const cell = cells.find((c) => c.layer === "opencode" && c.lint.sections.some(establishedOnly));
  assert.ok(cell, "the matrix has a cell with a brief that frames only established facts");
  const reworded = {
    ...cell,
    lint: {
      ...cell.lint,
      sections: cell.lint.sections.map((s) => (s.id === "context-brief" ? { ...s, text: `${s.text}\n(The brief above is NOT authoritative and must be verified against the live DOM.)` } : s)),
    },
  };
  assert.deepEqual(lintMatrixCell(cell, loadBaseline(ROOT)).filter((f) => f.rule === "R14"), [], "the real section agrees with its framing");
  const findings = lintMatrixCell(reworded, undefined).filter((f) => f.rule === "R14");
  assert.deepEqual(findings.map((f) => f.sections), [["context-brief"]]);
});
