/* qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.test.ts
   impactedSymbols/callersOf/coChangeCoupling results into ONE markdown block for
   (empty -> "", per-section cap, sanitized cells, byte-budget truncation at a newline boundary).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSymbolBlocks, renderBlastRadiusSignal, type BlastRadiusSignalInput } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { countDirectives } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { LocalSymbolRef, CoupledFile } from "@kernel/code/index.ts";

const impacted = (n: number): LocalSymbolRef[] =>
  Array.from({ length: n }, (_, i) => ({ file: `src/File${i}.java`, symbol: `method${i}` }));

const coupled = (n: number): CoupledFile[] =>
  Array.from({ length: n }, (_, i) => ({
    file: `src/Other${i}.java`,
    couplingScore: 1 - i * 0.01,
    coChanges: 10 - i,
  }));

test("three populated results render a block with three sub-sections", () => {
  const out = renderBlastRadiusSignal({
    impacted: [
      { file: "src/Foo.java", symbol: "save" },
      { file: "src/Bar.java", symbol: "load" },
    ],
    callers: [{ file: "src/Caller.java", symbol: "handle" }],
    coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }],
  });

  assert.match(out, /Structural blast radius/i);
  assert.match(out, /Impacted symbols \(2\)/);
  assert.match(out, /`save` \(src\/Foo\.java\)/);
  assert.match(out, /`load` \(src\/Bar\.java\)/);
  assert.match(out, /Callers of the changed code \(1\)/);
  assert.match(out, /`handle` \(src\/Caller\.java\)/);
  assert.match(out, /co-change \(1\)/i);
  assert.match(out, /src\/Other\.java/);
  assert.match(out, /0\.82/);
  assert.match(out, /14/);
});

test("all-empty inputs render an empty string (no section, fail-open)", () => {
  const out = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [] });
  assert.equal(out, "");
});

test("a single empty sub-block is omitted entirely (no empty heading)", () => {
  const out = renderBlastRadiusSignal({
    impacted: [{ file: "src/Foo.java", symbol: "save" }],
    callers: [],
    coupled: [],
  });

  assert.match(out, /Impacted symbols \(1\)/);
  assert.doesNotMatch(out, /Callers of the changed code/);
  assert.doesNotMatch(out, /co-change/i);
});

test("impacted symbols and callers are sorted by descending confidence when provided", () => {
  const out = renderBlastRadiusSignal({
    impacted: [
      { file: "src/Low.java", symbol: "low", confidence: 0.55 },
      { file: "src/High.java", symbol: "high", confidence: 0.95 },
      { file: "src/Mid.java", symbol: "mid", confidence: 0.7 },
    ] as (LocalSymbolRef & { confidence?: number })[],
    callers: [],
    coupled: [],
  });

  const highIdx = out.indexOf("high");
  const midIdx = out.indexOf("mid");
  const lowIdx = out.indexOf("low");
  assert.ok(highIdx < midIdx && midIdx < lowIdx, "expected descending-confidence ordering: high, mid, low");
});

test("coupled files are sorted by descending couplingScore", () => {
  const out = renderBlastRadiusSignal({
    impacted: [],
    callers: [],
    coupled: [
      { file: "src/Low.java", couplingScore: 0.2, coChanges: 2 },
      { file: "src/High.java", couplingScore: 0.9, coChanges: 9 },
    ],
  });

  const highIdx = out.indexOf("High.java");
  const lowIdx = out.indexOf("Low.java");
  assert.ok(highIdx < lowIdx, "expected descending couplingScore ordering: High before Low");
});

test("each sub-block is capped at MAX_ITEMS (200) items", () => {
  const out = renderBlastRadiusSignal({
    impacted: impacted(250),
    callers: [],
    coupled: [],
  });

  assert.match(out, /Impacted symbols \(250\)/);
  const occurrences = out.split("\n").filter((l) => l.startsWith("- `method")).length;
  assert.equal(occurrences, 200, "impacted sub-block must cap at 200 rendered items even though 250 were supplied");
});

test("coupled sub-block is also capped at MAX_ITEMS (200) items", () => {
  const out = renderBlastRadiusSignal({
    impacted: [],
    callers: [],
    coupled: coupled(250),
  });

  const occurrences = out.split("\n").filter((l) => l.startsWith("- src/Other")).length;
  assert.equal(occurrences, 200, "coupled sub-block must cap at 200 rendered items even though 250 were supplied");
});

test("the whole block is capped at the byte budget, truncated at the last newline boundary", () => {
  /* MAX_ITEMS caps each sub-block at 200 rendered lines — well under the byte budget on its own.
     To actually exercise the whole-block byte-budget truncation, spread the 200-item cap across
     three sub-blocks with long, distinctive symbol/file names so the combined output exceeds
     MAX_LEN (20_000 bytes).
   */
  const long = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ file: `src/main/java/very/long/package/path/${prefix}File${i}Repository.java`, symbol: `${prefix}veryLongMethodNameNumber${i}ForBudgetPadding` }));

  const out = renderBlastRadiusSignal({
    impacted: long("Impacted", 200),
    callers: long("Caller", 200),
    coupled: Array.from({ length: 200 }, (_, i) => ({
      file: `src/main/java/very/long/package/path/Coupled${i}Repository.java`,
      couplingScore: 0.5,
      coChanges: 5,
    })),
  });

  const bytes = Buffer.byteLength(out, "utf8");
  assert.ok(bytes <= 20_000, `expected output <= 20000 bytes, got ${bytes}`);
  assert.match(out, /truncated/);
  assert.ok(out.endsWith("\n…(structural blast radius truncated)"), "must end with the truncation marker");
});

test("every cell is passed through sanitizeText (secrets redacted)", () => {
  const out = renderBlastRadiusSignal({
    impacted: [{ file: "src/sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK.java", symbol: "save" }],
    callers: [],
    coupled: [],
  });

  assert.doesNotMatch(out, /sk-ant-api03-abcdefghijklmnopqrstuvwxyz/, "a secret-shaped path must be redacted, not leaked verbatim into the prompt");
  assert.match(out, /REDACTED/);
});

test("the block is advisory data: it asks for no verification of its own contents", () => {
  const out = renderBlastRadiusSignal({
    impacted: [{ file: "src/Foo.java", symbol: "save" }],
    callers: [{ file: "src/Caller.java", symbol: "handle" }],
    coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }],
  });
  assert.match(out, /advisory/i, "it still says what it is");
  assert.doesNotMatch(out, /\bverif/i);
});

test("an all-CodeGraphUnavailable composition (every collaborator absent) still renders an empty string", () => {
  /* Mirrors what StructuralSignalPortAdapter passes when every CodeGraphPort method returned err(...):
     empty arrays for every field, same as the true all-empty case.
   */
  const out = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [] });
  assert.equal(out, "");
});

/* ── a signal stands for an explored blast radius only when it names symbols ── */

const SAVE = { file: "src/Foo.java", symbol: "save" };
const HANDLE = { file: "src/Caller.java", symbol: "handle" };
const COUPLED = [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }];

test("a signal has symbol blocks when it lists an impacted symbol or a caller, and not when it holds co-change files alone or nothing", () => {
  assert.equal(hasSymbolBlocks({ impacted: [SAVE], callers: [] }), true, "impacted symbols alone");
  assert.equal(hasSymbolBlocks({ impacted: [], callers: [HANDLE] }), true, "callers alone");
  assert.equal(hasSymbolBlocks({ impacted: [SAVE], callers: [HANDLE] }), true, "both");
  assert.equal(hasSymbolBlocks({ impacted: [], callers: [] }), false, "neither: co-change files do not count");
});

test("the symbol-block predicate agrees with what the renderer draws: a symbol is named in the block exactly when the predicate holds", () => {
  const shapes = [
    { impacted: [SAVE], callers: [], coupled: COUPLED },
    { impacted: [], callers: [HANDLE], coupled: COUPLED },
    { impacted: [SAVE], callers: [HANDLE], coupled: [] },
    { impacted: [], callers: [], coupled: COUPLED },
  ];
  for (const shape of shapes) {
    const out = renderBlastRadiusSignal(shape);
    assert.notEqual(out, "", "every shape here renders a block");
    const namesASymbol = out.includes("`save`") || out.includes("`handle`");
    assert.equal(hasSymbolBlocks(shape), namesASymbol, JSON.stringify(shape));
  }
});

/* ── a block of co-change files alone says what it is ──
   The prompt's claims already treat such a block as no blast radius (the lookup stays). The words a model reads must say the same: the lint sees claims, never block text, so the title, the introduction and the truncation marker are pinned here. */

const CO_CHANGE_ONLY: BlastRadiusSignalInput = { impacted: [], callers: [], coupled: COUPLED };
const WITH_SYMBOLS: BlastRadiusSignalInput = { impacted: [SAVE], callers: [HANDLE], coupled: COUPLED };

/* The first line (title) and the second (introduction) of a rendered block. */
const titleOf = (shape: BlastRadiusSignalInput): string => renderBlastRadiusSignal(shape).split("\n")[0] ?? "";
const introOf = (shape: BlastRadiusSignalInput): string => renderBlastRadiusSignal(shape).split("\n")[1] ?? "";

test("a block of co-change files alone is titled and introduced as version-control history: it names no call graph, no confidence and no blast radius", () => {
  const out = renderBlastRadiusSignal(CO_CHANGE_ONLY);
  assert.ok(out.startsWith(`## ${PROMPT_HEADINGS.coChangeFiles} (`), "the title is the name the lint knows the block by");
  assert.ok(introOf(CO_CHANGE_ONLY).length > 0, "an introduction says where the files come from");
  assert.doesNotMatch(out, /call graph|code graph|blast radius|confidence|lombok/i, "nothing in the block claims to come from the code graph or to be an exploration of what the change reaches");
  assert.match(out, /src\/Other\.java/, "the files are still listed");
  assert.match(out, /0\.82/);
  assert.match(out, /advisory/i, "it is still a hint, not a gate");
  assert.equal(countDirectives(out), 0, "and it directs the agent to do nothing");
});

test("the title and the introduction follow the symbol predicate: a block with symbols keeps the structural ones, one without never borrows them", () => {
  const symbolsTitle = titleOf({ impacted: [SAVE], callers: [], coupled: [] });
  const symbolsIntro = introOf({ impacted: [SAVE], callers: [], coupled: [] });
  const coChangeTitle = titleOf(CO_CHANGE_ONLY);
  const coChangeIntro = introOf(CO_CHANGE_ONLY);
  assert.notEqual(coChangeTitle, symbolsTitle);
  assert.notEqual(coChangeIntro, symbolsIntro);

  const shapes: BlastRadiusSignalInput[] = [
    { impacted: [SAVE], callers: [], coupled: [] },
    { impacted: [SAVE], callers: [], coupled: COUPLED },
    { impacted: [], callers: [HANDLE], coupled: [] },
    { impacted: [], callers: [HANDLE], coupled: COUPLED },
    WITH_SYMBOLS,
    CO_CHANGE_ONLY,
  ];
  for (const shape of shapes) {
    const symbolic = hasSymbolBlocks(shape);
    assert.equal(titleOf(shape), symbolic ? symbolsTitle : coChangeTitle, `title: ${JSON.stringify(shape)}`);
    assert.equal(introOf(shape), symbolic ? symbolsIntro : coChangeIntro, `introduction: ${JSON.stringify(shape)}`);
  }
});

test("a block of co-change files alone that outgrows the byte budget is cut with a marker that names the co-change list, never a blast radius", () => {
  const long = Array.from({ length: 200 }, (_, i) => ({
    file: `src/main/java/very/long/package/path/${"nested/".repeat(8)}Coupled${i}Repository.java`,
    couplingScore: 0.5,
    coChanges: 5,
  }));
  const out = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: long });
  const bytes = Buffer.byteLength(out, "utf8");
  assert.ok(bytes <= 20_000, `expected output <= 20000 bytes, got ${bytes}`);
  assert.match(out, /truncated/, "setup: the block really was cut");
  assert.doesNotMatch(out, /blast radius/i);
  assert.ok(out.split("\n").at(-1)!.includes("co-change"), "the marker names what was cut");
});
