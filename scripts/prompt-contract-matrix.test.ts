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
import { HARNESS_FACTS_SECTION_ID, hasTrustLanguage, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { coerceExplorationBrief, parseExplorationBrief, renderExplorationBrief } from "../src/qa/exploration-brief.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dimensionNames = Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>;

let matrix: Promise<MatrixCell[]> | undefined;
const matrixOnce = (): Promise<MatrixCell[]> => (matrix ??= buildMatrix());

/* Linting every combination is the slow part, so the two tests that read its result share one pass. */
let findings: Promise<ReturnType<typeof collectFindings>> | undefined;
const findingsOnce = (): Promise<ReturnType<typeof collectFindings>> =>
  (findings ??= matrixOnce().then((cells) => collectFindings(cells, loadBaseline(ROOT))));

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
  assert.ok(valid.every((s) => s.structuralSignal === "none" || s.grounding === "none" || s.grounding === "pack" || s.briefBlast === "empty"));
  assert.ok(valid.every((s) => s.briefBlast === "filled" || s.grounding === "brief" || s.grounding === "brief+pack"));
  assert.ok(valid.every((s) => s.packDom || ((s.grounding === "pack" || s.grounding === "brief+pack") && s.contextMap)));
  assert.ok(valid.every((s) => !s.packRedirect || ((s.grounding === "pack" || s.grounding === "brief+pack") && s.packDom)));
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

/* ── the structural signal has three shapes ── */

const coChangeSpecs = (): CellSpec[] => allValidSpecs().filter((s) => s.structuralSignal === "co-change");

test("the structural signal is none, one that names symbols, or one of co-change files alone", () => {
  assert.deepEqual([...DIMENSIONS.structuralSignal].sort(), ["co-change", "none", "symbols"]);
});

test("a signal of co-change files alone is a narrow shape: diff runs with none of the optional blocks, across every phase, target and grounding that can carry it", () => {
  const specs = coChangeSpecs();
  assert.ok(specs.length > 0 && specs.length < allValidSpecs().filter((s) => s.structuralSignal === "symbols").length / 10, "a few dozen shapes, not a second copy of the signal's cross product");
  assert.ok(specs.every((s) => s.mode === "diff" && !s.contextMap && !s.authSeedUnauthored && !s.serviceLinks && !s.harnessFacts && !s.service && !s.packRedirect));
  assert.deepEqual([...new Set(specs.map((s) => s.phase))].sort(), [...DIMENSIONS.phase].sort(), "a first pass and every regeneration phase");
  assert.deepEqual([...new Set(specs.map((s) => s.target))].sort(), [...DIMENSIONS.target].sort());
  assert.deepEqual([...new Set(specs.map((s) => s.grounding))].sort(), [...DIMENSIONS.grounding].sort());
  assert.deepEqual([...new Set(specs.map((s) => s.tree))].sort(), [...DIMENSIONS.tree].sort());
});

test("the signal shapes are really assembled: symbols give the structural signal and drop the lookup, co-change files give the co-change fact and keep it, none gives neither", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const base = coChangeSpecs().find((s) => s.phase === "first" && s.target === "e2e" && s.grounding === "none")!;
  const claimsOf = async (s: CellSpec) => Object.values(buildPromptAssembled(await buildInput(s), { budgetBytes: 0 }).claims).flat();
  const provides = (claims: Awaited<ReturnType<typeof claimsOf>>, fact: string) => claims.some((c) => c.kind === "provides" && c.fact === fact);
  const looksUp = (claims: Awaited<ReturnType<typeof claimsOf>>) => claims.some((c) => c.kind === "directs" && c.action === "orient" && c.target === "blast-radius");

  const symbols = await claimsOf({ ...base, structuralSignal: "symbols" });
  assert.ok(provides(symbols, "structural-signal") && !provides(symbols, "co-change"));
  assert.equal(looksUp(symbols), false, "a signal with symbols is an explored blast radius");

  const coChange = await claimsOf(base);
  assert.ok(provides(coChange, "co-change") && !provides(coChange, "structural-signal"));
  assert.equal(looksUp(coChange), true, "co-change files are no blast radius");

  const none = await claimsOf({ ...base, structuralSignal: "none" });
  assert.ok(!provides(none, "co-change") && !provides(none, "structural-signal"));
  assert.equal(looksUp(none), true);
});

test("no cell with a signal of co-change files alone titles it as the structural signal is titled, while its twin with symbols does", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const assembledOf = async (spec: CellSpec) => buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 });
  const titleOf = (assembled: Awaited<ReturnType<typeof assembledOf>>): string =>
    splitAssembledSections(assembled).find((section) => section.id === "static-signal")?.text.split("\n")[0] ?? "";
  for (const spec of coChangeSpecs()) {
    const symbols = await assembledOf({ ...spec, structuralSignal: "symbols" });
    const coChange = await assembledOf(spec);
    const symbolsTitle = titleOf(symbols);
    assert.ok(symbolsTitle.length > 0, `${cellName(spec)}: setup, the twin carries the structural signal`);
    assert.equal(symbols.text.includes(symbolsTitle), true, cellName(spec));
    assert.equal(coChange.text.includes(symbolsTitle), false, `${cellName(spec)}: the co-change block borrows no title`);
    assert.notEqual(titleOf(coChange), symbolsTitle, cellName(spec));
  }
});

test("a regeneration with a signal of co-change files alone never says the blast radius was explored, and one with symbols does", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const explored = ARTIFACT_REFERENCES.find((r) => r.artifact === "blast-radius")!.pattern;
  const regens = coChangeSpecs().filter((s) => s.phase !== "first");
  assert.ok(regens.length > 0);
  for (const spec of regens) {
    const withCoChange = buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 });
    assert.equal(explored.test(withCoChange.text), false, cellName(spec));
    const withSymbols = buildPromptAssembled(await buildInput({ ...spec, structuralSignal: "symbols" }), { budgetBytes: 0 });
    assert.equal(explored.test(withSymbols.text), true, `${cellName(spec)} with symbols`);
  }
});

test("the redirect shape is really assembled: the pack lists the page a redirect reached as a section of its own, outside the live DOM", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const base = allValidSpecs().find((s) => s.mode === "diff" && s.target === "e2e" && s.phase === "regen-fix" && s.tree === "none" && s.grounding === "brief+pack" && s.contextMap && !s.service && s.briefBlast === "filled" && s.packDom && !s.packRedirect)!;
  const packOf = async (spec: CellSpec): Promise<string> =>
    splitAssembledSections(buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 })).find((section) => section.id === "context-pack")?.text ?? "";
  const sectionOf = (pack: string, heading: string): string => pack.split(/^### /m).find((part) => part.startsWith(heading)) ?? "";

  const redirected = await packOf({ ...base, packRedirect: true });
  assert.ok(sectionOf(redirected, PACK_HEADINGS.redirected).includes("textbox: Password"), "the page the redirect reached is in its own section");
  assert.equal(sectionOf(redirected, PACK_HEADINGS.liveDom).includes("textbox: Password"), false, "and not under the live DOM");
  assert.equal((await packOf(base)).includes(PACK_HEADINGS.redirected), false, "a pack with no redirect has no such section");
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
  assert.deepEqual([...(await findingsOnce()).keys()], [], "every combination is clean");
  assert.equal(existsSync(join(ROOT, "scripts", "prompt-contract-ledger.json")), false, "no ledger file");
  const exported = Object.keys(await import("./prompt-contract-matrix.ts"));
  assert.deepEqual(exported.filter((name) => /ledger|waiv|tolerat|allow|exempt/i.test(name)), [], "no waiver mechanism");
});

/* ── budgets ── */

test("no combination exceeds the recorded user-prompt size or directive volume, and no static layer its recorded size", async () => {
  const breaches = [...(await findingsOnce()).values()]
    .filter(({ finding }) => finding.rule === "R9")
    .map(({ finding, cells }) => `${cells[0]} (+${cells.length - 1} more): ${finding.budget} ${finding.measured} exceeds ${finding.limit}`);
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
