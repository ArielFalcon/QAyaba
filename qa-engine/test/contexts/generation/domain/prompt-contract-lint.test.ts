import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lintCell,
  findingKey,
  countDirectives,
  hasTrustLanguage,
  DIRECTIVE_LEXICON,
  MIN_DUPLICATE_LINE_BYTES,
  TRUST_LEXICON,
  APP_LOGIN_SECTION_ID,
  HARNESS_FACTS_SECTION_ID,
  STEP_LIMIT_SECTION_ID,
  type ArtifactReference,
  type LintCell,
  type LintSection,
  type PromptClaim,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { ASSEMBLED_ARTIFACT_NAMES, PACK_HEADINGS, PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";

function sec(
  id: string,
  claims: readonly PromptClaim[] = [],
  extra: Partial<Omit<LintSection, "id" | "claims">> = {},
): LintSection {
  return { id, layer: "assembled", text: `body of ${id}`, claims, ...extra };
}

function cell(sections: readonly LintSection[], regen = false): LintCell {
  return { name: "seeded", regen, sections };
}

const provides = (fact: Extract<PromptClaim, { kind: "provides" }>["fact"]): PromptClaim => ({ kind: "provides", fact });
const frames = (
  fact: Extract<PromptClaim, { kind: "frames" }>["fact"],
  as: "established" | "unverified",
): PromptClaim => ({ kind: "frames", fact, as });
const directs = (
  action: Extract<PromptClaim, { kind: "directs" }>["action"],
  target?: Extract<PromptClaim, { kind: "directs" }>["target"],
): PromptClaim => (target ? { kind: "directs", action, target } : { kind: "directs", action });

/* A line long enough to count toward the duplicate-line rule (>= 40 bytes) and free of any lexicon word. */
const LONG_LINE = "The quick brown fox jumps over the lazy dog";

test("a clean cell reports nothing", () => {
  const findings = lintCell(
    cell([
      sec("context-brief", [provides("blast-radius"), frames("blast-radius", "established")]),
      sec("task", [directs("state-outcome")]),
    ]),
  );
  assert.deepEqual(findings, []);
});

test("one fact framed by two sections reports exactly that pair, naming both sections", () => {
  const findings = lintCell(
    cell([
      sec("context-brief", [frames("blast-radius", "established")]),
      sec("context-pack", [frames("blast-radius", "unverified")]),
      sec("task"),
    ]),
  );
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding?.rule, "R1");
  assert.equal(finding?.fact, "blast-radius");
  assert.deepEqual([...(finding?.sections ?? [])].sort(), ["context-brief", "context-pack"]);
});

test("a fact framed once per section is clean even when different facts carry different stances", () => {
  const findings = lintCell(
    cell([
      sec("context-brief", [frames("blast-radius", "established")]),
      sec("arch-map", [frames("arch-map", "unverified")]),
    ]),
  );
  assert.deepEqual(findings, []);
});

test("a single-source fact provided by two sections reports exactly that pair", () => {
  for (const fact of ["blast-radius", "risks", "fe-be-links", "dom-live", "api-operations"] as const) {
    const findings = lintCell(cell([sec("a", [provides(fact)]), sec("b", [provides(fact)]), sec("c")]));
    assert.equal(findings.length, 1, fact);
    assert.equal(findings[0]?.rule, "R2", fact);
    assert.equal(findings[0]?.fact, fact, fact);
    assert.deepEqual([...(findings[0]?.sections ?? [])].sort(), ["a", "b"], fact);
  }
});

test("facts that may legitimately have several providers are not single-source", () => {
  const findings = lintCell(cell([sec("a", [provides("contracts")]), sec("b", [provides("contracts")])]));
  assert.deepEqual(findings, []);
});

test("landmarks and a DOM tree together report the landmark provider and the tree provider", () => {
  for (const tree of ["dom-live", "dom-failure"] as const) {
    const findings = lintCell(cell([sec("context-brief", [provides("landmarks")]), sec("tree", [provides(tree)])]));
    assert.equal(findings.length, 1, tree);
    assert.equal(findings[0]?.rule, "R2", tree);
    assert.equal(findings[0]?.fact, "landmarks", tree);
    assert.deepEqual([...(findings[0]?.sections ?? [])].sort(), ["context-brief", "tree"], tree);
  }
});

test("landmarks without a DOM tree are clean", () => {
  assert.deepEqual(lintCell(cell([sec("context-brief", [provides("landmarks")])])), []);
});

test("directing a read of a fact another section already provides is a contradiction naming both", () => {
  for (const action of ["read", "orient"] as const) {
    const findings = lintCell(cell([sec("arch-map", [provides("arch-map")]), sec("task", [directs(action, "arch-map")])]));
    assert.equal(findings.length, 1, action);
    assert.equal(findings[0]?.rule, "R3", action);
    assert.deepEqual([...(findings[0]?.sections ?? [])].sort(), ["arch-map", "task"], action);
  }
});

test("directing a read of a fact nobody provides is clean (the orientation stays where the fact is absent)", () => {
  assert.deepEqual(lintCell(cell([sec("task", [directs("read", "arch-map")])])), []);
});

test("consulting a fact no section provides is a dangling reference naming the directing section", () => {
  const findings = lintCell(cell([sec("selector-contradictions", [directs("consult", "dom-failure")]), sec("task")]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "R3");
  assert.deepEqual(findings[0]?.sections, ["selector-contradictions"]);
});

test("consulting a provided fact is clean", () => {
  const findings = lintCell(
    cell([sec("dom-snapshot", [provides("dom-failure")]), sec("selector-contradictions", [directs("consult", "dom-failure")])]),
  );
  assert.deepEqual(findings, []);
});

test("a regeneration cell that directs orientation or repo analysis, or re-embeds the diff, reports the section", () => {
  const orient = lintCell(cell([sec("task", [directs("orient")])], true));
  assert.deepEqual(orient.map((f) => [f.rule, ...f.sections]), [["R4", "task"]]);
  const analyze = lintCell(cell([sec("task", [directs("analyze-repo")])], true));
  assert.deepEqual(analyze.map((f) => [f.rule, ...f.sections]), [["R4", "task"]]);
  const diff = lintCell(cell([sec("diff", [provides("diff")])], true));
  assert.deepEqual(diff.map((f) => [f.rule, ...f.sections]), [["R4", "diff"]]);
});

test("a regeneration cell keeps its acceptance-criterion instruction", () => {
  assert.deepEqual(lintCell(cell([sec("task", [directs("state-outcome")])], true)), []);
});

test("the same claims are clean in a first-pass cell", () => {
  const claims = [directs("orient"), directs("analyze-repo"), provides("diff")];
  assert.deepEqual(lintCell(cell([sec("task", claims)], false)), []);
});

test("deriving selectors from source code is never allowed", () => {
  const findings = lintCell(cell([sec("task", [directs("derive-from-code")])]));
  assert.deepEqual(findings.map((f) => [f.rule, ...f.sections]), [["R5", "task"]]);
});

test("a facts-only section carrying a directive claim, a framing or directive language is reported", () => {
  const withDirective = lintCell(
    cell([sec(HARNESS_FACTS_SECTION_ID, [directs("read", "harness-facts")], { factsOnly: true })]),
  );
  assert.deepEqual(withDirective.map((f) => [f.rule, ...f.sections]), [["R6", HARNESS_FACTS_SECTION_ID]]);

  const withFraming = lintCell(
    cell([sec(HARNESS_FACTS_SECTION_ID, [frames("harness-facts", "established")], { factsOnly: true })]),
  );
  assert.deepEqual(withFraming.map((f) => [f.rule, ...f.sections]), [["R6", HARNESS_FACTS_SECTION_ID]]);

  const withLanguage = lintCell(
    cell([
      sec(HARNESS_FACTS_SECTION_ID, [provides("harness-facts")], {
        factsOnly: true,
        text: "fixtures: e2e/fixtures.ts\nYou MUST import test from it and NEVER reimplement it",
      }),
    ]),
  );
  assert.deepEqual(withLanguage.map((f) => [f.rule, ...f.sections]), [["R6", HARNESS_FACTS_SECTION_ID]]);
});

test("a facts-only section of plain data is clean", () => {
  const findings = lintCell(
    cell([
      sec(HARNESS_FACTS_SECTION_ID, [provides("harness-facts")], {
        factsOnly: true,
        text: "testIdAttribute: data-cy\nfixtures: e2e/fixtures.ts exports test, expect, authenticate",
      }),
    ]),
  );
  assert.deepEqual(findings, []);
});

test("an identical scaffold line in two sections is a duplicate naming both sections", () => {
  const findings = lintCell(
    cell([
      sec("a", [], { text: `${LONG_LINE}\nonly in a` }),
      sec("b", [], { text: `only in b\n${LONG_LINE}` }),
    ]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "R7");
  assert.deepEqual([...(findings[0]?.sections ?? [])].sort(), ["a", "b"]);
});

test("a duplicate line across a static layer and an assembled section is reported", () => {
  const findings = lintCell(
    cell([
      sec("static-role", [], { layer: "static", text: `${LONG_LINE}\nrole only` }),
      sec("task", [], { text: `${LONG_LINE}\ntask only` }),
    ]),
  );
  assert.deepEqual(findings.map((f) => f.rule), ["R7"]);
});

test("short lines, fenced lines and verbatim sections never count as duplicates", () => {
  const short = "x".repeat(MIN_DUPLICATE_LINE_BYTES - 1);
  const findings = lintCell(
    cell([
      sec("a", [], { text: `${short}\n\`\`\`\n${LONG_LINE}\n\`\`\`` }),
      sec("b", [], { text: `${short}\n\`\`\`\n${LONG_LINE}\n\`\`\`` }),
      sec("captured", [], { verbatim: true, text: LONG_LINE }),
      sec("captured-too", [], { verbatim: true, text: LONG_LINE }),
    ]),
  );
  assert.deepEqual(findings, []);
});

test("an indented scaffold line repeated in two sections is a duplicate, indented or not", () => {
  for (const indent of ["  ", "    ", "\t"]) {
    const findings = lintCell(cell([sec("a", [], { text: `head\n${indent}${LONG_LINE}` }), sec("b", [], { text: `${indent}${LONG_LINE}\ntail` })]));
    assert.deepEqual(findings.map((f) => [f.rule, ...f.sections]), [["R7", "a", "b"]], JSON.stringify(indent));
  }
  const flush = lintCell(cell([sec("a", [], { text: `  ${LONG_LINE}` }), sec("b", [], { text: LONG_LINE })]));
  assert.equal(flush.length, 1, "the same words indented in one section and flush in the other are one line");
});

test("the rows of a captured DOM tree are data: a section that provides a tree contributes none of its indented lines", () => {
  for (const fact of ["dom-live", "dom-failure"] as const) {
    const rows = `route /cart:\n  ${LONG_LINE}`;
    assert.deepEqual(lintCell(cell([sec("tree-a", [provides(fact)], { text: rows }), sec("tree-b", [provides(fact === "dom-live" ? "dom-failure" : "dom-live")], { text: rows })])), [], fact);
  }
  const scaffold = sec("task", [], { text: `  ${LONG_LINE}` });
  const tree = sec("tree", [provides("dom-live")], { text: `  ${LONG_LINE}` });
  assert.deepEqual(lintCell(cell([scaffold, tree])), [], "a tree's row is never the other half of a duplicate");
  for (const claims of [[provides("risks")], [frames("dom-live", "established")], [directs("consult", "dom-live")]]) {
    const notATree = cell([sec("a", claims, { text: `  ${LONG_LINE}` }), sec("b", [], { text: `  ${LONG_LINE}` })]);
    assert.equal(lintCell(notATree).filter((f) => f.rule === "R7").length, 1, "a section that provides no tree keeps its indented lines as scaffold");
  }
  const flushInTree = sec("tree", [provides("dom-live")], { text: LONG_LINE });
  assert.equal(lintCell(cell([sec("task", [], { text: LONG_LINE }), flushInTree])).length, 1, "only its indented lines are rows; a flush line is scaffold");
});

test("the same line repeated inside one section is not a cross-section duplicate", () => {
  assert.deepEqual(lintCell(cell([sec("a", [], { text: `${LONG_LINE}\n${LONG_LINE}` })])), []);
});

test("static text that names an assembled artifact is reported, assembled text is not", () => {
  const names = [PACK_HEADINGS.pack, PROMPT_HEADINGS.explorationBrief];
  const findings = lintCell(
    cell([
      sec("role", [], { layer: "static", text: `Read the ${PACK_HEADINGS.pack} first` }),
      sec("agents", [], { layer: "static", text: "nothing to see here" }),
      sec("task", [], { text: `The ${PROMPT_HEADINGS.explorationBrief} is below` }),
    ]),
    { assembledArtifactNames: names },
  );
  assert.deepEqual(findings.map((f) => [f.rule, ...f.sections]), [["R8", "role"]]);
});

test("a cell over its byte budget or directive budget fails independently of contradictions", () => {
  const text = "You MUST do it. Never skip. ".repeat(20);
  const big = cell([sec("task", [], { text })]);
  const bytes = Buffer.byteLength(text, "utf8");

  assert.deepEqual(lintCell(big, { budget: { maxAssembledBytes: bytes, maxDirectives: countDirectives(text) } }), []);

  const overBytes = lintCell(big, { budget: { maxAssembledBytes: bytes - 1 } });
  assert.deepEqual(overBytes.map((f) => f.rule), ["R9"]);

  const overDirectives = lintCell(big, { budget: { maxDirectives: countDirectives(text) - 1 } });
  assert.deepEqual(overDirectives.map((f) => f.rule), ["R9"]);
});

test("the directive budget ignores captured verbatim data but the byte budget counts it", () => {
  const diff = sec("diff", [], { verbatim: true, text: "+ you MUST never do this again ".repeat(10) });
  const task = sec("task", [], { text: "plain scaffold" });
  const bytes = Buffer.byteLength(diff.text + task.text, "utf8");
  assert.deepEqual(lintCell(cell([diff, task]), { budget: { maxDirectives: 0, maxAssembledBytes: bytes } }), []);
  assert.deepEqual(lintCell(cell([diff, task]), { budget: { maxAssembledBytes: bytes - 1 } }).map((f) => f.rule), ["R9"]);
});

test("the byte budget counts only assembled sections, never the static layer", () => {
  const findings = lintCell(
    cell([
      sec("role", [], { layer: "static", text: "z".repeat(5000) }),
      sec("task", [], { text: "short" }),
    ]),
    { budget: { maxAssembledBytes: 100 } },
  );
  assert.deepEqual(findings, []);
});

test("the static layer has a byte budget of its own, counted over its sections and never over the user prompt", () => {
  const staticBytes = 5000 + 3000;
  const layered = cell([
    sec("role", [], { layer: "static", text: "z".repeat(5000) }),
    sec("agents", [], { layer: "static", text: "y".repeat(3000) }),
    sec("task", [], { text: "w".repeat(4000) }),
  ]);
  assert.deepEqual(lintCell(layered, { budget: { maxStaticBytes: staticBytes } }), []);
  assert.deepEqual(lintCell(layered, { budget: { maxStaticBytes: staticBytes - 1 } }), [
    { rule: "R9", sections: [], budget: "static-bytes", measured: staticBytes, limit: staticBytes - 1 },
  ]);
});

test("trust language in a section that declares no framing is reported; declaring the framing clears it", () => {
  const trusting = sec("dom", [provides("dom-live")], { text: "This tree is GROUND TRUTH for selectors" });
  assert.deepEqual(lintCell(cell([trusting])).map((f) => [f.rule, ...f.sections]), [["R10", "dom"]]);

  const framed = sec("dom", [provides("dom-live"), frames("dom-live", "established")], { text: trusting.text });
  assert.deepEqual(lintCell(cell([framed])), []);
});

test("naming another section by its heading is not trust language, but restating its trust level is", () => {
  const names = [PROMPT_HEADINGS.groundTruthAtFailure];
  const reference = sec("fix", [], { text: `The captured tree is injected above as "${PROMPT_HEADINGS.groundTruthAtFailure}".` });
  assert.deepEqual(lintCell(cell([reference]), { assembledArtifactNames: names }), []);
  const restated = sec("fix", [], { text: "Consult ONLY the GROUND TRUTH tree above." });
  assert.deepEqual(lintCell(cell([restated]), { assembledArtifactNames: names }).map((f) => f.rule), ["R10"]);
});

test("everyday phrasing that merely contains a trust word is not a framing", () => {
  assert.equal(hasTrustLanguage("Work in the tests folder (source of truth in git)."), false);
  assert.equal(hasTrustLanguage("This tree is the ONLY source of truth for this fix."), true);
});

test("trust language inside captured verbatim data is not judged by the framing rule", () => {
  const diff = sec("diff", [provides("diff")], { verbatim: true, text: "+ // this cache is stale and unverified" });
  assert.deepEqual(lintCell(cell([diff])), []);
});

test("trust language in a static layer is not judged by the framing rule", () => {
  const findings = lintCell(cell([sec("role", [], { layer: "static", text: "The tree is the source of truth" })]));
  assert.deepEqual(findings, []);
});

test("directing runtime signals while a DOM tree is provided reports both sections", () => {
  for (const tree of ["dom-live", "dom-failure"] as const) {
    const findings = lintCell(cell([sec("working-rules", [directs("use-runtime-signals")]), sec("tree", [provides(tree)])]));
    assert.equal(findings.length, 1, tree);
    assert.equal(findings[0]?.rule, "R11", tree);
    assert.deepEqual([...(findings[0]?.sections ?? [])].sort(), ["tree", "working-rules"], tree);
  }
});

test("directing runtime signals without any DOM tree is clean", () => {
  assert.deepEqual(lintCell(cell([sec("working-rules", [directs("use-runtime-signals")])])), []);
});

test("the app-login section never sends the agent to the pack's live DOM", () => {
  const findings = lintCell(
    cell([sec("context-pack", [provides("dom-live")]), sec(APP_LOGIN_SECTION_ID, [directs("consult", "dom-live")])]),
  );
  assert.deepEqual(findings.map((f) => [f.rule, ...f.sections]), [["R12", APP_LOGIN_SECTION_ID]]);
});

test("findings are deterministic: the same cell always yields the same ordered result", () => {
  const seeded = cell([
    sec("z", [frames("blast-radius", "established"), directs("derive-from-code")]),
    sec("a", [frames("blast-radius", "unverified"), directs("derive-from-code")]),
  ]);
  const first = lintCell(seeded);
  const second = lintCell(seeded);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(findingKey), [...first.map(findingKey)].sort());
});

test("finding keys are the rule plus the sorted section ids and ignore the fact", () => {
  assert.equal(findingKey({ rule: "R1", sections: ["z", "a"], fact: "risks" }), "R1|a|z");
  assert.equal(findingKey({ rule: "R5", sections: ["task"] }), "R5|task");
});

test("the lexicons detect directive and trust language case-insensitively", () => {
  assert.ok(DIRECTIVE_LEXICON.length > 0 && TRUST_LEXICON.length > 0);
  assert.equal(countDirectives("plain facts: a=1, b=2"), 0);
  assert.ok(countDirectives("You MUST verify it and never skip") >= 3);
  assert.equal(hasTrustLanguage("plain facts: a=1, b=2"), false);
  assert.equal(hasTrustLanguage("this map is non-authoritative"), true);
});

/* ── what each finding reports, exactly ── */

test("a finding names its sections sorted, whatever order the sections and claims came in", () => {
  const reversed = (fact: Extract<PromptClaim, { kind: "provides" }>["fact"]) => [sec("b", [provides(fact)]), sec("a", [provides(fact)])];
  assert.deepEqual(lintCell(cell(reversed("risks"))).map((f) => f.sections), [["a", "b"]], "R2");
  assert.deepEqual(
    lintCell(cell([sec("b", [frames("risks", "established")]), sec("a", [frames("risks", "established")])])).map((f) => f.sections),
    [["a", "b"]],
    "R1",
  );
  assert.deepEqual(
    lintCell(cell([sec("z-task", [directs("read", "arch-map")]), sec("a-map", [provides("arch-map")])])).map((f) => f.sections),
    [["a-map", "z-task"]],
    "R3",
  );
  assert.deepEqual(
    lintCell(cell([sec("z-rules", [directs("use-runtime-signals")]), sec("a-tree", [provides("dom-live")])])).map((f) => f.sections),
    [["a-tree", "z-rules"]],
    "R11",
  );
  assert.deepEqual(
    lintCell(cell([sec("z-brief", [provides("landmarks")]), sec("a-tree", [provides("dom-live")])])).map((f) => f.sections),
    [["a-tree", "z-brief"]],
    "landmarks",
  );
  assert.deepEqual(
    lintCell(cell([sec("z", [], { text: LONG_LINE }), sec("a", [], { text: LONG_LINE })])).map((f) => f.sections),
    [["a", "z"]],
    "R7",
  );
});

test("findings come out ordered by key and then by fact, so a result is comparable across runs", () => {
  const twoFacts = cell([
    sec("b", [provides("risks"), provides("blast-radius")]),
    sec("a", [provides("risks"), provides("blast-radius")]),
    sec("c", [directs("derive-from-code")]),
  ]);
  const findings = lintCell(twoFacts);
  assert.deepEqual(findings.map((f) => [findingKey(f), f.fact]), [
    ["R2|a|b", "blast-radius"],
    ["R2|a|b", "risks"],
    ["R5|c", undefined],
  ]);
});

test("two different pairs of sections are never mistaken for one whose ids concatenate alike", () => {
  const first = "First shared line that is long enough to count as one";
  const second = "Second shared line that is long enough to count too";
  const findings = lintCell(
    cell([
      sec("ab", [], { text: first }),
      sec("c", [], { text: first }),
      sec("a", [], { text: second }),
      sec("bc", [], { text: second }),
    ]),
  );
  const byPair = new Map(findings.map((f) => [f.sections.join("+"), f.measured]));
  assert.equal(findings.length, 2);
  assert.equal(byPair.get("a+bc"), Buffer.byteLength(second));
  assert.equal(byPair.get("ab+c"), Buffer.byteLength(first));
});

test("a duplicated line reports the bytes it duplicates, summed over the shared lines of a pair", () => {
  const other = "Another line that is long enough to count as one";
  const findings = lintCell(
    cell([
      sec("a", [], { text: `${LONG_LINE}\n${other}\nonly a` }),
      sec("b", [], { text: `${LONG_LINE}\n${other}` }),
      sec("c", [], { text: LONG_LINE }),
    ]),
  );
  const byPair = new Map(findings.map((f) => [f.sections.join("+"), f.measured]));
  assert.equal(byPair.get("a+b"), Buffer.byteLength(LONG_LINE) + Buffer.byteLength(other));
  assert.equal(byPair.get("a+c"), Buffer.byteLength(LONG_LINE));
  assert.equal(byPair.get("b+c"), Buffer.byteLength(LONG_LINE));
  assert.equal(findings.length, 3);
});

test("a line of exactly the minimum size counts as a duplicate and one byte less does not", () => {
  const atLimit = "x".repeat(MIN_DUPLICATE_LINE_BYTES);
  assert.equal(lintCell(cell([sec("a", [], { text: atLimit }), sec("b", [], { text: atLimit })])).length, 1);
  const below = "x".repeat(MIN_DUPLICATE_LINE_BYTES - 1);
  assert.equal(lintCell(cell([sec("a", [], { text: below }), sec("b", [], { text: below })])).length, 0);
  const paddedBelow = `  ${below}  `;
  assert.equal(lintCell(cell([sec("a", [], { text: paddedBelow }), sec("b", [], { text: paddedBelow })])).length, 0, "the size is that of the trimmed line");
});

test("a fence that names its language, or is indented, still hides the lines inside it", () => {
  for (const [open, close] of [["```ts", "```"], ["   ```", "   ```"], ["```", "```"]] as const) {
    const fenced = `${open}\n${LONG_LINE}\n${close}`;
    assert.deepEqual(lintCell(cell([sec("a", [], { text: fenced }), sec("b", [], { text: fenced })])), [], JSON.stringify(open));
  }
  const closedThenLive = `\`\`\`\n${LONG_LINE}\n\`\`\`\n${LONG_LINE}`;
  assert.equal(lintCell(cell([sec("a", [], { text: closedThenLive }), sec("b", [], { text: LONG_LINE })])).length, 1, "a line after the fence closes counts again");
});

test("findings are ordered by key as text, so a later rule's finding can come before an earlier rule's", () => {
  const mixed = cell([
    sec("a", [provides("risks")]),
    sec("b", [provides("risks")]),
    sec("t", [], { text: "this is authoritative" }),
  ]);
  assert.deepEqual(lintCell(mixed).map(findingKey), ["R10|t", "R2|a|b"], "R10 sorts before R2 as text, though rule R2 runs first");
});

test("findings that share a key are ordered by their fact, whatever order the rules found them in", () => {
  const both = cell([
    sec("b", [provides("risks"), provides("fe-be-links")]),
    sec("a", [provides("risks"), provides("fe-be-links")]),
  ]);
  assert.deepEqual(lintCell(both).map((f) => f.fact), ["fe-be-links", "risks"]);
});

test("a budget breach reports what was measured against the limit, for the bytes and for the directives separately", () => {
  const text = "You MUST do it. Never skip. ".repeat(20);
  const bytes = Buffer.byteLength(text, "utf8");
  const directives = countDirectives(text);
  const both = lintCell(cell([sec("task", [], { text })]), { budget: { maxAssembledBytes: bytes - 1, maxDirectives: directives - 1 } });
  assert.deepEqual(both, [
    { rule: "R9", sections: [], budget: "bytes", measured: bytes, limit: bytes - 1 },
    { rule: "R9", sections: [], budget: "directives", measured: directives, limit: directives - 1 },
  ]);
  assert.deepEqual(lintCell(cell([sec("task", [], { text })]), { budget: {} }), [], "no limit, no breach");
});

/* ── what each rule leaves alone ── */

test("directing an action that is neither a read, an orientation nor a consultation is not judged against providers", () => {
  for (const action of ["analyze-repo", "state-outcome", "derive-from-code", "use-runtime-signals"] as const) {
    const findings = lintCell(cell([sec("task", [directs(action, "arch-map")])]));
    assert.deepEqual(findings.filter((f) => f.rule === "R3"), [], action);
  }
});

test("a facts-only section is flagged for a directive even when it also carries a plain provides claim", () => {
  const section = sec(HARNESS_FACTS_SECTION_ID, [provides("harness-facts"), directs("state-outcome")], { factsOnly: true });
  assert.deepEqual(lintCell(cell([section])).map((f) => f.rule), ["R6"]);
  const onlyProvides = sec(HARNESS_FACTS_SECTION_ID, [provides("harness-facts")], { factsOnly: true, text: "a=1" });
  assert.deepEqual(lintCell(cell([onlyProvides])), []);
});

test("a section that is not facts-only may carry directives and framings freely", () => {
  assert.deepEqual(lintCell(cell([sec("task", [directs("read", "arch-map"), frames("diff", "established")], { text: "You MUST never stop" })])), []);
});

test("the login rule judges only the login section, and only a consultation of the live DOM", () => {
  assert.deepEqual(lintCell(cell([sec("dom", [provides("dom-live")]), sec("task", [directs("consult", "dom-live")])])), [], "another section may consult it");
  assert.deepEqual(lintCell(cell([sec("dom", [provides("dom-failure")]), sec(APP_LOGIN_SECTION_ID, [directs("consult", "dom-failure")])])), [], "another fact");
  assert.deepEqual(lintCell(cell([sec(APP_LOGIN_SECTION_ID, [directs("orient", "dom-live")]), sec("dom", [provides("dom-live")])])).map((f) => f.rule), ["R3"], "another action is only judged by the provider rule");
});

test("an empty artifact name never matches, and a heading reference never glues the words around it into a trust word", () => {
  const staticText = sec("role", [], { layer: "static", text: "anything at all" });
  assert.deepEqual(lintCell(cell([staticText]), { assembledArtifactNames: [""] }), []);
  const glued = sec("fix", [], { text: "the trus[NAME]ted tree" });
  assert.deepEqual(lintCell(cell([glued]), { assembledArtifactNames: ["[NAME]"] }), [], "removing the reference must not spell a trust word");
  assert.deepEqual(lintCell(cell([sec("fix", [], { text: "a trusted tree" })]), { assembledArtifactNames: [""] }).map((f) => f.rule), ["R10"]);
});

test("the trust lexicon matches the plain and the past form of trust but not a longer word", () => {
  assert.equal(hasTrustLanguage("trust this tree"), true);
  assert.equal(hasTrustLanguage("a trusted tree"), true);
  assert.equal(hasTrustLanguage("a trustworthy tree"), false);
});

test("static text that names the section of the suite listing, of the co-change files or of the step limit is reported like any other assembled artifact, and a phrase that merely resembles the name is not", () => {
  const options = { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES };
  const named = (text: string): LintSection => ({ id: "static/role.md", layer: "static", text, claims: [] });
  const cases: Array<[name: string, lookalike: string]> = [
    [PROMPT_HEADINGS.existingSuiteManifest, "Read the existing suite manifest first."],
    [PROMPT_HEADINGS.coChangeFiles, "Files that change together in a pull request are reviewed together."],
    [PROMPT_HEADINGS.stepLimit, "The step limit of a role is set by its runtime."],
  ];
  for (const [name, lookalike] of cases) {
    assert.deepEqual(lintCell(cell([named(`Read the ${name} first.`)]), options).map((f) => [f.rule, ...f.sections]), [["R8", "static/role.md"]], name);
    assert.deepEqual(lintCell(cell([named(lookalike)]), options), [], `${name}: a look-alike`);
  }
});

/* ── a reference to an assembled artifact needs the artifact ── */

const TREE_REFERENCE: ArtifactReference = {
  artifact: "tree",
  pattern: /\bthe tree above\b/i,
  provider: { facts: ["dom-live", "dom-failure"] },
};
const LOGIN_REFERENCE: ArtifactReference = { artifact: "login", pattern: new RegExp(PROMPT_HEADINGS.appLogin), provider: { section: APP_LOGIN_SECTION_ID } };

test("a section that refers to an artifact nothing in the cell provides is reported with the artifact it lacks", () => {
  const findings = lintCell(cell([sec("fix", [], { text: "Fix it from the tree above." })]), { artifactReferences: [TREE_REFERENCE] });
  assert.deepEqual(findings, [{ rule: "R13", sections: ["fix"], artifact: "tree" }]);
});

test("a reference is met by any section that provides one of the artifact's facts, including the referring section itself", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  for (const fact of ["dom-live", "dom-failure"] as const) {
    const other = cell([sec("fix", [], { text: "Fix it from the tree above." }), sec("dom", [provides(fact)])]);
    assert.deepEqual(lintCell(other, references), [], `provided by another section: ${fact}`);
    const own = cell([sec("fix", [provides(fact)], { text: "Fix it from the tree above." })]);
    assert.deepEqual(lintCell(own, references), [], `provided by the referring section: ${fact}`);
  }
  assert.deepEqual(lintCell(cell([sec("fix", [], { text: "Fix it from the tree above." }), sec("dom", [provides("risks")])]), references).map((f) => f.rule), ["R13"], "another fact does not meet it");
});

test("an artifact backed by a section is met by the section with that id and by nothing else", () => {
  const references = { artifactReferences: [LOGIN_REFERENCE] };
  const text = `See ${PROMPT_HEADINGS.appLogin} before you write.`;
  assert.deepEqual(lintCell(cell([sec("task", [], { text })]), references).map((f) => f.artifact), ["login"]);
  assert.deepEqual(lintCell(cell([sec("task", [], { text }), sec(APP_LOGIN_SECTION_ID, [], { text: "steps" })]), references), []);
});

test("a heading line is a section's own title and refers to nothing, but the same words in its body do", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "## The tree above\nplain body" })]), references), []);
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "## Title\nlook at the tree above" })]), references).map((f) => f.rule), ["R13"]);
});

test("the same words inside a fenced block are captured data and refer to nothing", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "resolve every item:\n```\n- x is not in the tree above\n```" })]), references), []);
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "```ts\nnot the tree above\n```\nnow the tree above" })]), references).map((f) => f.rule), ["R13"], "prose after the fence closes counts again");
});

test("a fence is recognised whatever follows its backticks or precedes them, and a hash inside a line is no title", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  const referring = "the tree above";
  for (const [open, close] of [["```ts", "```"], ["   ```", "   ```"]] as const) {
    assert.deepEqual(lintCell(cell([sec("task", [], { text: `${open}\n${referring}\n${close}` })]), references), [], JSON.stringify(open));
  }
  assert.deepEqual(lintCell(cell([sec("task", [], { text: `${referring} is item # 3` })]), references).map((f) => f.rule), ["R13"], "a hash after other words starts no title");
  assert.deepEqual(lintCell(cell([sec("task", [], { text: `#hash ${referring}` })]), references).map((f) => f.rule), ["R13"], "a hash with no space after it is no title");
});

test("a fence's own line is markup, and a reference does not span the line break inside a phrase", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "```the tree above\ncaptured\n```" })]), references), [], "the words after the backticks are the fence's label");
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "see the \ntree above" })]), references), [], "two lines are not one phrase");
});

test("a title is a line of one to six hashes and a space, indented by at most three spaces", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  for (const title of ["# The tree above", "###### The tree above", "  ## The tree above", "   ### The tree above"]) {
    assert.deepEqual(lintCell(cell([sec("task", [], { text: `${title}\nplain` })]), references), [], JSON.stringify(title));
  }
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "####### the tree above" })]), references).map((f) => f.rule), ["R13"], "seven hashes are no title");
  assert.deepEqual(lintCell(cell([sec("task", [], { text: "    # the tree above" })]), references).map((f) => f.rule), ["R13"], "four spaces of indent make it code, not a title");
});

test("captured verbatim data and the static layer are not judged for references", () => {
  const references = { artifactReferences: [TREE_REFERENCE] };
  const text = "the tree above";
  assert.deepEqual(lintCell(cell([sec("diff", [], { text, verbatim: true })]), references), []);
  assert.deepEqual(lintCell(cell([sec("role", [], { text, layer: "static" })]), references), []);
});

test("each missing artifact of a section is reported once, and the findings are ordered by artifact", () => {
  const references = { artifactReferences: [LOGIN_REFERENCE, TREE_REFERENCE] };
  const findings = lintCell(cell([sec("task", [], { text: `the tree above, the tree above and ${PROMPT_HEADINGS.appLogin}` })]), references);
  assert.deepEqual(findings.map((f) => f.artifact), ["login", "tree"]);
});

/* ── a section's words agree with the trust it declares ── */

test("a section that declares only an established framing must not say its fact is not to be trusted", () => {
  for (const text of [
    "The brief above is NOT authoritative; the code wins.",
    "This is non-authoritative context.",
    "Verify before trusting any of it.",
    "Verify before trust: it is unchecked.",
    "Every symbol here must be verified against the code.",
  ]) {
    const findings = lintCell(cell([sec("context-brief", [provides("blast-radius"), frames("blast-radius", "established")], { text })]));
    assert.deepEqual(findings.map((f) => [f.rule, ...f.sections]), [["R14", "context-brief"]], text);
  }
});

test("a section that declares only an unverified framing must not call its fact authoritative", () => {
  for (const text of ["This map is authoritative.", "The ground truth for routes.", "The only source of truth here."]) {
    const findings = lintCell(cell([sec("arch-map", [provides("arch-map"), frames("arch-map", "unverified")], { text })]));
    assert.deepEqual(findings.map((f) => [f.rule, ...f.sections]), [["R14", "arch-map"]], text);
  }
});

test("words that agree with the declared framing are clean, and so is a negation of the opposite", () => {
  const established = sec("context-brief", [frames("blast-radius", "established")], { text: "This is authoritative ground truth." });
  const unverified = sec("arch-map", [frames("arch-map", "unverified")], { text: "This may be stale, not authoritative, and must be verified." });
  assert.deepEqual(lintCell(cell([established, unverified])), []);
  const negatedOpposite = sec("arch-map", [frames("arch-map", "unverified")], { text: "This map is not authoritative." });
  assert.deepEqual(lintCell(cell([negatedOpposite])), [], "\"not authoritative\" is not an established claim");
});

test("a section that declares both framings, or none, is not judged for polarity", () => {
  const text = "Some of this is NOT authoritative and the rest is authoritative ground truth.";
  assert.deepEqual(lintCell(cell([sec("mixed", [frames("blast-radius", "established"), frames("landmarks", "unverified")], { text })])), []);
  assert.deepEqual(lintCell(cell([sec("plain", [], { text })])).filter((f) => f.rule === "R14"), []);
});

test("captured verbatim data and the static layer are not judged for polarity", () => {
  const text = "NOT authoritative";
  assert.deepEqual(lintCell(cell([sec("diff", [frames("diff", "established")], { text, verbatim: true })])), []);
  assert.deepEqual(lintCell(cell([sec("role", [frames("diff", "established")], { text, layer: "static" })])), []);
});

test("the polarity lexicons detect their phrases case-insensitively and repeatedly", () => {
  const negated = "Not Authoritative";
  const established = "Ground Truth";
  for (let round = 0; round < 3; round++) {
    assert.equal(lintCell(cell([sec("b", [frames("blast-radius", "established")], { text: negated })])).length, 1, `negated, round ${round}`);
    assert.equal(lintCell(cell([sec("m", [frames("arch-map", "unverified")], { text: established })])).length, 1, `established, round ${round}`);
  }
});

/* ── the step limit, the suite listing, the learned rules, the exemplars and the co-change files: one provider each, framed at most once, and referred to only where carried ── */

const ONCE_PROVIDED_FACTS = ["step-limit", "existing-suite", "learned-rules", "exemplars", "co-change"] as const;

test("each of the step limit, the existing suite, the learned rules, the exemplars and the co-change files has one provider: a second is reported with both sections", () => {
  for (const fact of ONCE_PROVIDED_FACTS) {
    const duplicated = lintCell(cell([sec("b", [provides(fact)]), sec("a", [provides(fact)]), sec("c")]));
    assert.deepEqual(duplicated.map((f) => [f.rule, f.fact, ...f.sections]), [["R2", fact, "a", "b"]], fact);
    assert.deepEqual(lintCell(cell([sec("a", [provides(fact)]), sec("c")])), [], `${fact}: one provider is clean`);
  }
});

test("each of those facts is framed at most once: a second framing section is reported with the first, whatever its stance", () => {
  for (const fact of ONCE_PROVIDED_FACTS) {
    for (const [first, second] of [["established", "unverified"], ["unverified", "unverified"]] as const) {
      const findings = lintCell(cell([sec("b", [frames(fact, second)]), sec("a", [frames(fact, first)])]));
      assert.deepEqual(findings.map((f) => [f.rule, f.fact, ...f.sections]), [["R1", fact, "a", "b"]], `${fact}: ${first} then ${second}`);
    }
    assert.deepEqual(lintCell(cell([sec("a", [frames(fact, "established")]), sec("b")])), [], `${fact}: one framing is clean`);
  }
});

test("directing a read or an orientation of the existing suite while a section lists it is a contradiction naming both; with no listing the read stays clean", () => {
  for (const action of ["read", "orient"] as const) {
    const findings = lintCell(cell([sec("task", [directs(action, "existing-suite")]), sec("existing-suite-manifest", [provides("existing-suite")])]));
    assert.deepEqual(findings.map((f) => [f.rule, f.fact, ...f.sections]), [["R3", "existing-suite", "existing-suite-manifest", "task"]], action);
    assert.deepEqual(lintCell(cell([sec("task", [directs(action, "existing-suite")])])), [], `${action}: nothing lists the suite`);
  }
});

/* ── the structural signal with symbols is the blast radius: a read or an orientation of it is redundant, a consult is not ── */

test("a read or an orientation of the blast radius while a section provides the structural signal is a contradiction naming both", () => {
  for (const action of ["read", "orient"] as const) {
    const findings = lintCell(cell([sec("task", [directs(action, "blast-radius")]), sec("static-signal", [provides("structural-signal")])]));
    assert.deepEqual(findings.map((f) => [f.rule, f.fact, ...f.sections]), [["R3", "blast-radius", "static-signal", "task"]], action);
  }
});

test("the blast radius and the structural signal each contradict the directive when both are provided, one finding per provider", () => {
  const findings = lintCell(
    cell([sec("task", [directs("orient", "blast-radius")]), sec("context-brief", [provides("blast-radius")]), sec("static-signal", [provides("structural-signal")])]),
  );
  assert.deepEqual(
    findings.map((f) => [f.rule, f.fact, ...f.sections]),
    [["R3", "blast-radius", "context-brief", "task"], ["R3", "blast-radius", "static-signal", "task"]],
  );
});

test("the equivalence holds for a read or an orientation only: a consult of the blast radius is not satisfied by the structural signal", () => {
  const consult = lintCell(cell([sec("task", [directs("consult", "blast-radius")]), sec("static-signal", [provides("structural-signal")])]));
  assert.deepEqual(consult.map((f) => [f.rule, f.fact, ...f.sections]), [["R3", "blast-radius", "task"]], "dangling: nothing provides the blast radius itself");
  const met = lintCell(cell([sec("task", [directs("consult", "blast-radius")]), sec("context-brief", [provides("blast-radius")])]));
  assert.deepEqual(met, [], "a section that provides the blast radius still meets a consult of it");
});

test("the equivalence is one way: a read of the structural signal is not made redundant by a section that provides the blast radius", () => {
  for (const action of ["read", "orient"] as const) {
    assert.deepEqual(lintCell(cell([sec("task", [directs(action, "structural-signal")]), sec("context-brief", [provides("blast-radius")])])), [], action);
  }
});

test("co-change files satisfy nothing: a read or an orientation of the blast radius beside a co-change-only signal is clean", () => {
  for (const action of ["read", "orient"] as const) {
    assert.deepEqual(lintCell(cell([sec("task", [directs(action, "blast-radius")]), sec("static-signal", [provides("co-change")])])), [], action);
  }
});

test("a facts-only section is flagged for a directive word inside a fenced block: a fence is no exemption", () => {
  for (const [open, close] of [["```", "```"], ["```text", "```"], ["   ```", "   ```"]] as const) {
    const fenced = sec(STEP_LIMIT_SECTION_ID, [provides("step-limit")], { factsOnly: true, text: `This turn runs at most 40 steps.\n${open}\nnever stop early\n${close}` });
    assert.deepEqual(lintCell(cell([fenced])).map((f) => [f.rule, ...f.sections]), [["R6", STEP_LIMIT_SECTION_ID]], JSON.stringify(open));
  }
  const dataOnly = sec(STEP_LIMIT_SECTION_ID, [provides("step-limit")], { factsOnly: true, text: "This turn runs at most 40 steps.\n```\n40\n```" });
  assert.deepEqual(lintCell(cell([dataOnly])), [], "a fenced block of plain data is clean");
});

interface ReferenceCase {
  artifact: string;
  /* A section that carries the artifact, as the builder declares it. */
  provider: LintSection;
  /* Words a directive uses to point at the artifact. */
  refers: readonly string[];
  /* Words that only look like it. */
  unrelated: readonly string[];
}

const NEW_REFERENCE_CASES: readonly ReferenceCase[] = [
  {
    artifact: "step-limit",
    provider: sec(STEP_LIMIT_SECTION_ID, [provides("step-limit")]),
    refers: ["Finish before the step limit.", "The STEP LIMIT applies to this turn."],
    unrelated: ["Take it one step at a time.", "There is no limit on the specs.", "Mind the step limitations."],
  },
  {
    artifact: "existing-suite",
    provider: sec("existing-suite-manifest", [provides("existing-suite")]),
    refers: [
      "Skim the suite listing above first.",
      "Every spec in the suite listed above is covered.",
      "Suite listing above: it is complete.",
      `Check the ${PROMPT_HEADINGS.existingSuiteManifest} above before adding a spec.`,
    ],
    unrelated: ["The test suite is large.", "Keep a listing of the routes.", "An existing suite manifest is not a section here."],
  },
  {
    artifact: "learned-rules",
    provider: sec("learned-rules", [provides("learned-rules")]),
    refers: ["Apply the learned rules.", "The proven rules below take priority.", "Experimental rules are only hints."],
    unrelated: ["The working rules above apply.", "Rules learned elsewhere do not count."],
  },
  {
    artifact: "co-change",
    provider: sec("static-signal", [provides("co-change")]),
    refers: [`The ${PROMPT_HEADINGS.coChangeFiles} above are only a hint.`, `Skim the ${PROMPT_HEADINGS.coChangeFiles.toUpperCase()} first.`],
    unrelated: ["Files that change together in a pull request.", "Keep the history of the repository clean."],
  },
  {
    artifact: "exemplars",
    provider: sec("skill-exemplars", [provides("exemplars")]),
    refers: ["Follow the exemplars below.", "Adapt one exemplar to the change.", "Apply these test templates.", "Exemplars below match this change's shape."],
    unrelated: ["An exemplary change.", "Page templates are rendered by the app."],
  },
];

test("a section that points at the step limit, the suite listing, the learned rules, the exemplars or the co-change files needs that artifact in the cell", () => {
  const references = { artifactReferences: ARTIFACT_REFERENCES };
  for (const { artifact, provider, refers } of NEW_REFERENCE_CASES) {
    for (let round = 0; round < 3; round++) {
      for (const phrase of refers) {
        const dangling = lintCell(cell([sec("task", [], { text: phrase })]), references);
        assert.deepEqual(dangling, [{ rule: "R13", sections: ["task"], artifact }], `${artifact}: "${phrase}", round ${round}`);
        assert.deepEqual(lintCell(cell([sec("task", [], { text: phrase }), provider]), references), [], `${artifact}: "${phrase}" beside its provider`);
      }
    }
  }
});

test("only the artifact's own provider meets its reference, and words that merely resemble a reference point at nothing", () => {
  const references = { artifactReferences: ARTIFACT_REFERENCES };
  for (const { artifact, refers, unrelated } of NEW_REFERENCE_CASES) {
    for (const other of NEW_REFERENCE_CASES.filter((c) => c.artifact !== artifact)) {
      const findings = lintCell(cell([sec("task", [], { text: refers[0] ?? "" }), other.provider]), references);
      assert.deepEqual(findings.map((f) => f.artifact), [artifact], `${artifact} is not met by the provider of ${other.artifact}`);
    }
    for (const phrase of unrelated) {
      assert.deepEqual(lintCell(cell([sec("task", [], { text: phrase })]), references), [], `${artifact}: "${phrase}"`);
    }
  }
});
