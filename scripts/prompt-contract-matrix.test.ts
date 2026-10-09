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
  LIMIT_BUCKET_SUFFIX,
  MATRIX_STEP_LIMIT,
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
import { enforcedStepLimit } from "../src/agent-runtime/step-limit.ts";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { HARNESS_FACTS_SECTION_ID, STEP_LIMIT_SECTION_ID, hasTrustLanguage, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { STEP_MILESTONE_SECTION_ID, isTestWritingTurn } from "@contexts/generation/domain/step-limit.ts";
import { PACK_HEADINGS, SUITE_LISTING_LABELS } from "@contexts/generation/domain/prompt-headings.ts";
import { LISTING_MAX_DO_NOT_REWRITE } from "@contexts/generation/domain/suite-listing.ts";
import { leftOutLine } from "@contexts/generation/domain/suite-listing-render.ts";
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

/* ── one assembly per layer: the OpenCode runtime enforces a step limit and the Codex runtime states none ── */

test("the step limit the matrix assembles with is one the runtime's resolver accepts", () => {
  assert.equal(enforcedStepLimit(MATRIX_STEP_LIMIT), MATRIX_STEP_LIMIT);
});

test("an OpenCode cell is assembled with the step limit that runtime enforces, and a Codex cell with none", async () => {
  const cells = await matrixOnce();
  const opencode = cells.filter((c) => c.layer === "opencode");
  const codex = cells.filter((c) => c.layer === "codex");
  assert.ok(opencode.length > 0 && codex.length === opencode.length, "every combination has a cell in each layer");
  assert.deepEqual([...new Set(opencode.map((c) => c.stepLimit))], [MATRIX_STEP_LIMIT]);
  assert.deepEqual([...new Set(codex.map((c) => c.stepLimit))], [undefined]);
});

test("the input of a limited cell is the same run input plus the step limit, and an input built without one has no such key", async () => {
  const specs = [
    allValidSpecs().find((s) => s.mode === "diff" && s.target === "e2e" && s.phase === "first")!,
    allValidSpecs().find((s) => s.mode === "diff" && s.target === "code" && s.phase === "regen-fix")!,
    allValidSpecs().find((s) => s.mode === "context")!,
  ];
  for (const spec of specs) {
    const plain = await buildInput(spec);
    const { stepLimit, ...rest } = await buildInput(spec, MATRIX_STEP_LIMIT);
    assert.equal(stepLimit, MATRIX_STEP_LIMIT, cellName(spec));
    assert.deepEqual(rest, plain, `${cellName(spec)}: the limit is the only difference`);
    assert.equal("stepLimit" in plain, false, `${cellName(spec)}: no key without a limit`);
  }
});

test("the bucket of a limited combination is the bucket of its twin without a limit plus a suffix, for every kind of bucket", () => {
  const specs = [
    allValidSpecs().find((s) => s.mode === "diff" && s.target === "e2e" && s.phase === "first" && !s.packRedirect)!,
    allValidSpecs().find((s) => s.packRedirect)!,
  ];
  for (const spec of specs) {
    assert.equal(bucketOf(spec, true), `${bucketOf(spec)}${LIMIT_BUCKET_SUFFIX}`, cellName(spec));
    assert.equal(bucketOf(spec, false), bucketOf(spec), cellName(spec));
    assert.notEqual(bucketOf(spec, true), bucketOf(spec), cellName(spec));
  }
});

test("a cell that states a step limit is budgeted in its limited bucket, and one that states none in its twin's", async () => {
  const cells = await matrixOnce();
  assert.ok(cells.some((c) => c.stepLimit !== undefined) && cells.some((c) => c.stepLimit === undefined), "setup: cells with and without a limit");
  for (const cell of cells) {
    assert.equal(cell.bucket, bucketOf(cell.spec, cell.stepLimit !== undefined), cell.key);
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

/* ── the suite is listed, or the run has nothing to list ── */

const noSuiteSpecs = (): CellSpec[] => allValidSpecs().filter((s) => s.suite === "none");

test("a run lists its suite or lists none, and a run with nothing to list is a narrow shape: no optional block, any phase, target, grounding and tree", () => {
  assert.deepEqual([...DIMENSIONS.suite].sort(), ["listed", "none"]);
  const specs = noSuiteSpecs();
  assert.ok(specs.length > 0 && specs.length < allValidSpecs().filter((s) => s.suite === "listed").length / 10, "a few hundred shapes, not a second copy of the cross product");
  assert.ok(specs.every((s) => !s.contextMap && !s.authSeedUnauthored && !s.serviceLinks && !s.harnessFacts && !s.service && !s.packRedirect));
  assert.ok(specs.every((s) => s.mode === "diff" || s.mode === "manual" || s.phase !== "first"), "a complete, exhaustive or context first pass lists no suite either way, so it has the listed shape alone");
  assert.deepEqual([...new Set(specs.map((s) => s.phase))].sort(), [...DIMENSIONS.phase].sort(), "a first pass and every regeneration phase");
  assert.deepEqual([...new Set(specs.map((s) => s.target))].sort(), [...DIMENSIONS.target].sort());
});

test("a combination with nothing to list is named and budgeted apart from the one that lists, so neither shape hides in the other's budget", () => {
  const none = noSuiteSpecs()[0]!;
  const twin = { ...none, suite: "listed" as const };
  assert.ok(isValidSpec(twin), "setup: the shape has a listed twin");
  assert.notEqual(cellName(none), cellName(twin));
  assert.notEqual(bucketOf(none), bucketOf(twin));
  assert.notEqual(bucketOf(none, true), bucketOf(twin, true));
});

test("a diff first pass with no listing and a regeneration with no carried specs are in the matrix, and are really built without them", async () => {
  const diffFirst = noSuiteSpecs().find((s) => s.mode === "diff" && s.phase === "first")!;
  const regen = noSuiteSpecs().find((s) => s.phase !== "first")!;
  assert.ok(diffFirst && regen);
  for (const spec of [diffFirst, regen]) {
    const input = await buildInput(spec);
    assert.equal(input.existingSpecFiles, undefined, `${cellName(spec)}: no suite lines`);
    assert.equal(input.deliveredSpecs, undefined, `${cellName(spec)}: no delivered specs`);
  }
  const listed = { ...regen, suite: "listed" as const };
  assert.ok(isValidSpec(listed));
  const carried = await buildInput(listed);
  assert.ok((carried.deliveredSpecs ?? []).length > 0, "its listed twin carries the specs the run delivered");
  assert.notEqual(cellName(listed), cellName(regen), "the two are different cells");
});

test("the suite shapes are really assembled: a listing is a provider of the suite and a missing one sends the first pass to read it", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const base = allValidSpecs().find((s) => s.mode === "diff" && s.target === "e2e" && s.phase === "first" && s.suite === "listed" && s.grounding === "none" && s.structuralSignal === "none" && !s.contextMap)!;
  const claimsOf = async (s: CellSpec) => buildPromptAssembled(await buildInput(s), { budgetBytes: 0 }).claims;
  const providers = (claims: Awaited<ReturnType<typeof claimsOf>>) => Object.entries(claims).filter(([, list]) => list.some((c) => c.kind === "provides" && c.fact === "existing-suite")).map(([id]) => id);
  const readsSuite = (claims: Awaited<ReturnType<typeof claimsOf>>) => Object.values(claims).flat().some((c) => c.kind === "directs" && c.action === "read" && c.target === "existing-suite");

  const listed = await claimsOf(base);
  assert.deepEqual(providers(listed), ["existing-suite-manifest"]);
  assert.equal(readsSuite(listed), false);
  const none = await claimsOf({ ...base, suite: "none" });
  assert.deepEqual(providers(none), []);
  assert.equal(readsSuite(none), true, "with no listing the first pass reads the suite itself");
});

test("a regeneration that carries the run's specs lists them under the labels of the turn's work, with the delivered specs refreshing the suite's own line", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  for (const phase of DIMENSIONS.phase.filter((p) => p !== "first")) {
    const spec = allValidSpecs().find((s) => s.mode === "diff" && s.target === "e2e" && s.phase === phase && s.suite === "listed" && s.grounding === "none" && s.tree === "none" && s.structuralSignal === "none" && !s.contextMap && !s.service)!;
    const section = splitAssembledSections(buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 })).find((part) => part.id === "existing-suite-manifest")!;
    assert.ok(section, `${phase}: the listing is in the prompt`);
    assert.ok(section.text.includes(SUITE_LISTING_LABELS.editable), `${phase}: there is a spec to change`);
    assert.equal(section.text.split("\n").filter((line) => line.includes("flows/cart.spec.ts")).length, 1, `${phase}: the suite's line and the run's delivery of the same file are one entry`);
  }
});

test("an exhaustive regeneration carries more of the run's specs than the listing shows of those it leaves alone, and says how many it left out", async () => {
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  const spec = allValidSpecs().find((s) => s.mode === "exhaustive" && s.target === "e2e" && s.phase === "regen-fix" && s.suite === "listed" && s.grounding === "none" && s.tree === "none")!;
  const section = splitAssembledSections(buildPromptAssembled(await buildInput(spec), { budgetBytes: 0 })).find((part) => part.id === "existing-suite-manifest")!;
  const delivered = (await buildInput(spec)).deliveredSpecs ?? [];
  assert.ok(delivered.length - 1 > LISTING_MAX_DO_NOT_REWRITE, "more specs are left alone than the listing can show");
  assert.ok(section.text.split("\n").includes(leftOutLine(delivered.length - 1 - LISTING_MAX_DO_NOT_REWRITE)), "the count left out is stated");
  assert.equal(section.text.split(SUITE_LISTING_LABELS.doNotRewrite).length, 2);
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

test("cells that state a step limit carry the facts-only step-limit section, linted as data with no directive or framing, and cells that state none carry no such section", async () => {
  const cells = await matrixOnce();
  const limited = cells.filter((c) => c.stepLimit !== undefined);
  assert.ok(limited.length > 0 && limited.length < cells.length, "the matrix has cells with and without a limit");
  for (const cell of limited) {
    const section = cell.lint.sections.find((s) => s.id === STEP_LIMIT_SECTION_ID);
    assert.ok(section?.factsOnly, `${cell.key}: the step-limit section is present and marked facts-only`);
    assert.ok(section.text.includes(String(MATRIX_STEP_LIMIT)), `${cell.key}: it carries the limit`);
    assert.equal(section.claims.some((c) => c.kind === "directs" || c.kind === "frames"), false, cell.key);
  }
  assert.ok(cells.filter((c) => c.stepLimit === undefined).every((c) => !c.lint.sections.some((s) => s.id === STEP_LIMIT_SECTION_ID || s.id === STEP_MILESTONE_SECTION_ID)));
});

test("a limited cell carries the milestone exactly when its turn writes tests, as a directive section the lint counts: neither facts-only nor captured data", async () => {
  const cells = await matrixOnce();
  const limited = cells.filter((c) => c.stepLimit !== undefined);
  const writes = (spec: CellSpec): boolean => isTestWritingTurn({ mode: spec.mode, ...(spec.phase !== "first" ? { coverageGap: "a gap" } : {}) });
  assert.ok(limited.some((c) => writes(c.spec)) && limited.some((c) => !writes(c.spec)), "the matrix has limited cells of both kinds");
  for (const cell of limited) {
    const section = cell.lint.sections.find((s) => s.id === STEP_MILESTONE_SECTION_ID);
    assert.equal(section !== undefined, writes(cell.spec), cell.key);
    if (section) {
      assert.equal(section.factsOnly, undefined, `${cell.key}: not facts-only`);
      assert.equal(section.verbatim, undefined, `${cell.key}: not captured data, so its directive words are counted`);
    }
  }
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

test("every combination that can reach the agent has a recorded budget, with a step limit and without, and the baseline names only combinations that can", () => {
  const baseline = loadBaseline(ROOT);
  const reachable = new Set(allValidSpecs().flatMap((spec) => [bucketOf(spec), bucketOf(spec, true)]));
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

/* ── a limited bucket nobody has recorded is held to the budget of its twin without a limit ── */

const isLimited = (bucket: string): boolean => bucket.endsWith(LIMIT_BUCKET_SUFFIX);
const twinOf = (bucket: string): string => bucket.slice(0, -LIMIT_BUCKET_SUFFIX.length);

/* The baseline of a record that has never held a step limit: every bucket but the limited ones. */
function withoutLimitedBuckets(baseline: Baseline): Baseline {
  const copy = structuredClone(baseline);
  for (const bucket of Object.keys(copy.buckets)) if (isLimited(bucket)) delete copy.buckets[bucket];
  return copy;
}

/* The cells of one bucket, each measured larger (or smaller) by what a prompt that stated the limit would add. */
function resized(cells: readonly MatrixCell[], bucket: string, by: { bytes?: number; directives?: number }): MatrixCell[] {
  return cells.map((c) => (c.bucket === bucket ? { ...c, assembledBytes: c.assembledBytes + (by.bytes ?? 0), directives: c.directives + (by.directives ?? 0) } : c));
}

/* The cells as they stand while no prompt states the limit: each limited cell measures what its twin does. The tests of the first record start from them, so they hold whatever the prompts later say about the limit. */
function limitedCellsAsTheirTwins(cells: readonly MatrixCell[]): MatrixCell[] {
  const twins = new Map(cells.filter((c) => c.stepLimit === undefined).map((c) => [c.name, c] as const));
  return cells.map((c) => {
    const twin = c.stepLimit === undefined ? undefined : twins.get(c.name);
    return twin ? { ...c, assembledBytes: twin.assembledBytes, directives: twin.directives } : c;
  });
}

/* A limited bucket well inside the ceiling, so growing it never moves the ceiling the raise check also reads. */
function aLimitedBucket(baseline: Baseline): string {
  const bucket = Object.keys(baseline.buckets).find(
    (b) => isLimited(b) && baseline.buckets[b]!.bytes + 20 <= baseline.ceiling.bytes && baseline.buckets[b]!.directives + 2 <= baseline.ceiling.directives,
  );
  assert.ok(bucket, "setup: the baseline has a limited bucket with room under the ceiling");
  return bucket;
}

test("the first record of the limited buckets states no raise while none is larger than its twin without a limit", async () => {
  const cells = limitedCellsAsTheirTwins(await matrixOnce());
  const measured = recordBaseline(cells);
  const committed = withoutLimitedBuckets(measured);
  const limited = aLimitedBucket(measured);
  assert.equal(committed.buckets[limited], undefined, "setup: the committed baseline holds no limited bucket");
  assert.deepEqual(measured.buckets[limited], measured.buckets[twinOf(limited)], "setup: a limited cell measures what its twin does");

  const recorded = recordBaseline(cells, committed);
  assert.deepEqual(recorded.buckets, measured.buckets);
  assert.equal(recorded.lastIncrease, undefined);

  const smaller = recordBaseline(resized(cells, limited, { bytes: -3 }), committed);
  assert.equal(smaller.buckets[limited]!.bytes, measured.buckets[twinOf(limited)]!.bytes - 3, "a limited bucket below its twin is no raise");
  assert.equal(smaller.lastIncrease, undefined);
});

test("the first record of a limited bucket that outgrows its twin is a raise: it needs a reason, which names that bucket", async () => {
  const cells = limitedCellsAsTheirTwins(await matrixOnce());
  const measured = recordBaseline(cells);
  const committed = withoutLimitedBuckets(measured);
  const limited = aLimitedBucket(measured);
  const reason = "the prompt states the step limit";
  for (const [what, growth, budget] of [
    ["bytes", { bytes: 7 }, `${limited}:bytes`],
    ["directives", { directives: 1 }, `${limited}:directives`],
    ["both", { bytes: 7, directives: 1 }, `${limited}:bytes`],
  ] as const) {
    const grown = resized(cells, limited, growth);
    assert.throws(
      () => recordBaseline(grown, committed),
      (error: unknown) => error instanceof BaselineIncreaseError && error.budgets.includes(budget) && error.budgets.every((b) => b.startsWith(limited)),
      what,
    );
    assert.throws(() => recordBaseline(grown, committed, { increaseReason: "   " }), BaselineIncreaseError, `${what}: a blank reason is no reason`);
    const raised = recordBaseline(grown, committed, { increaseReason: reason });
    assert.equal(raised.lastIncrease?.reason, reason, what);
    assert.ok(raised.lastIncrease?.budgets.includes(budget), `${what}: the stored budgets name ${budget}`);
    assert.equal(raised.buckets[limited]!.bytes, measured.buckets[limited]!.bytes + (growth.bytes ?? 0), what);
  }
});

test("a limited bucket nobody has recorded is held to the budget its twin has in the committed baseline, not to what the twin measures now", async () => {
  const cells = limitedCellsAsTheirTwins(await matrixOnce());
  const measured = recordBaseline(cells);
  const limited = aLimitedBucket(measured);
  const committed = withoutLimitedBuckets(measured);
  committed.buckets[twinOf(limited)]!.bytes += 10;

  const within = recordBaseline(resized(cells, limited, { bytes: 10 }), committed);
  assert.equal(within.buckets[limited]!.bytes, measured.buckets[limited]!.bytes + 10);
  assert.equal(within.lastIncrease, undefined, "up to the twin's recorded budget is no raise");
  assert.throws(() => recordBaseline(resized(cells, limited, { bytes: 11 }), committed), BaselineIncreaseError, "a byte past it is");
});

test("a limited bucket the baseline has recorded is held to its own budget, never to its twin's", async () => {
  const cells = limitedCellsAsTheirTwins(await matrixOnce());
  const measured = recordBaseline(cells);
  const limited = aLimitedBucket(measured);
  const grown = resized(cells, limited, { bytes: 7, directives: 1 });
  const committed = recordBaseline(grown, withoutLimitedBuckets(measured), { increaseReason: "the prompt states the step limit" });
  assert.ok(committed.buckets[limited]!.bytes > committed.buckets[twinOf(limited)]!.bytes, "setup: the recorded limited bucket is larger than its twin");

  assert.doesNotThrow(() => recordBaseline(grown, committed), "recording the same prompts again raises nothing");
  assert.throws(() => recordBaseline(resized(cells, limited, { bytes: 8, directives: 1 }), committed), BaselineIncreaseError, "a byte past its own record is a raise");
  assert.throws(() => recordBaseline(resized(cells, limited, { bytes: 7, directives: 2 }), committed), BaselineIncreaseError, "so is a directive");
});

test("a limited bucket is new, not raised, when its twin is not recorded either", async () => {
  const cells = limitedCellsAsTheirTwins(await matrixOnce());
  const measured = recordBaseline(cells);
  const limited = aLimitedBucket(measured);
  const committed = withoutLimitedBuckets(measured);
  delete committed.buckets[twinOf(limited)];
  const recorded = recordBaseline(resized(cells, limited, { bytes: 7 }), committed);
  assert.equal(recorded.buckets[limited]!.bytes, measured.buckets[limited]!.bytes + 7);
  assert.equal(recorded.lastIncrease, undefined);
});
