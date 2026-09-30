import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lintCell,
  findingKey,
  countDirectives,
  hasTrustLanguage,
  DIRECTIVE_LEXICON,
  TRUST_LEXICON,
  APP_LOGIN_SECTION_ID,
  HARNESS_FACTS_SECTION_ID,
  type LintCell,
  type LintSection,
  type PromptClaim,
} from "@contexts/generation/domain/prompt-contract-lint.ts";

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

test("short lines, fenced lines, indented tree rows and verbatim sections never count as duplicates", () => {
  const short = "x".repeat(39);
  const findings = lintCell(
    cell([
      sec("a", [], { text: `${short}\n\`\`\`\n${LONG_LINE}\n\`\`\`\n  ${LONG_LINE}` }),
      sec("b", [], { text: `${short}\n\`\`\`\n${LONG_LINE}\n\`\`\`\n  ${LONG_LINE}` }),
      sec("captured", [], { verbatim: true, text: LONG_LINE }),
      sec("captured-too", [], { verbatim: true, text: LONG_LINE }),
    ]),
  );
  assert.deepEqual(findings, []);
});

test("the same line repeated inside one section is not a cross-section duplicate", () => {
  assert.deepEqual(lintCell(cell([sec("a", [], { text: `${LONG_LINE}\n${LONG_LINE}` })])), []);
});

test("static text that names an assembled artifact is reported, assembled text is not", () => {
  const names = ["Context Pack", "Exploration brief"];
  const findings = lintCell(
    cell([
      sec("role", [], { layer: "static", text: "Read the Context Pack first" }),
      sec("agents", [], { layer: "static", text: "nothing to see here" }),
      sec("task", [], { text: "The Exploration brief is below" }),
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

test("trust language in a section that declares no framing is reported; declaring the framing clears it", () => {
  const trusting = sec("dom", [provides("dom-live")], { text: "This tree is GROUND TRUTH for selectors" });
  assert.deepEqual(lintCell(cell([trusting])).map((f) => [f.rule, ...f.sections]), [["R10", "dom"]]);

  const framed = sec("dom", [provides("dom-live"), frames("dom-live", "established")], { text: trusting.text });
  assert.deepEqual(lintCell(cell([framed])), []);
});

test("naming another section by its heading is not trust language, but restating its trust level is", () => {
  const names = ["GROUND TRUTH AT FAILURE"];
  const reference = sec("fix", [], { text: 'The captured tree is injected above as "GROUND TRUTH AT FAILURE".' });
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
