/* The claims a prompt declares per section: what it provides, how it frames a fact, what it directs the agent to do. The prompt-contract lint reads them, so each behavior here is asserted on claims and section sizes, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import { lintCell, type FactId, type LintSection, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */


function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    mode: "diff",
    appName: "testapp",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

const provided = (a: AssembledPrompt, id: string): FactId[] =>
  (a.claims[id] ?? []).flatMap((c: PromptClaim) => (c.kind === "provides" ? [c.fact] : [])).sort();

test("a captured a11y tree section declares which tree it provides", () => {
  const live = buildPromptAssembled(mkInput({ domSnapshot: "  button: Save" }));
  assert.deepEqual(provided(live, "dom-snapshot"), ["dom-live"]);
  const failure = buildPromptAssembled(mkInput({ domSnapshot: "  button: Save", failureSourced: true, fixCases: [{ name: "t", status: "fail" }] }));
  assert.deepEqual(provided(failure, "dom-snapshot"), ["dom-failure"]);
});

test("the pack section's claims are derived from the pack it carries", () => {
  const withDom = buildPromptAssembled(mkInput({ contextPack: `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.liveDom} (x)\n  button: Save` }));
  assert.deepEqual(provided(withDom, "context-pack"), ["dom-live"]);
  const withContracts = buildPromptAssembled(mkInput({ contextPack: `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.contracts} (x)\n- a` }));
  assert.deepEqual(provided(withContracts, "context-pack"), ["api-operations"]);
});

test("the architecture map section declares the map with the facts it renders", () => {
  const map = {
    builtAtSha: "abc1234",
    routes: [{ path: "/checkout" }],
    api: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
    feBe: [{ route: "/checkout", operationId: "createOrder" }],
  };
  const assembled = buildPromptAssembled(mkInput({ contextMap: map }));
  assert.deepEqual(provided(assembled, "arch-map"), ["api-operations", "arch-map", "fe-be-links"]);
  const routesOnly = buildPromptAssembled(mkInput({ contextMap: { ...map, api: [], feBe: [] } }));
  assert.deepEqual(provided(routesOnly, "arch-map"), ["arch-map"]);
});

test("the structural signal, service links and the diff each declare what they provide", () => {
  const link = {
    from: { repo: "org/app", file: "a.ts", symbol: "A" },
    to: { repo: "org/svc", symbol: "B" },
    transport: "http",
    source: "s",
    confidence: 0.9,
  };
  const assembled = buildPromptAssembled(
    mkInput({ staticSignal: "## Structural blast radius\n- a", staticSignalHasSymbols: true, serviceLinks: [link as never] }),
  );
  assert.deepEqual(provided(assembled, "static-signal"), ["structural-signal"]);
  assert.deepEqual(provided(assembled, "service-links"), ["service-links"]);
  assert.deepEqual(provided(assembled, "diff"), ["diff"]);
});

test("a structural signal of co-change files alone declares the co-change fact, not the structural signal, and frames only that fact", () => {
  const coChange = buildPromptAssembled(mkInput({ staticSignal: renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }] }) }));
  assert.deepEqual(provided(coChange, "static-signal"), ["co-change"]);
  const framed = (coChange.claims["static-signal"] ?? []).flatMap((c: PromptClaim) => (c.kind === "frames" ? [`${c.fact}:${c.as}`] : []));
  assert.deepEqual(framed, ["co-change:unverified"]);
  const symbols = buildPromptAssembled(mkInput({ staticSignal: "## Structural blast radius\n- a", staticSignalHasSymbols: true }));
  const symbolsFramed = (symbols.claims["static-signal"] ?? []).flatMap((c: PromptClaim) => (c.kind === "frames" ? [`${c.fact}:${c.as}`] : []));
  assert.deepEqual(symbolsFramed, ["structural-signal:unverified"]);
});

function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

const lintSectionsOf = (a: AssembledPrompt): LintSection[] =>
  Object.keys(a.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(a, id),
    claims: a.claims[id] ?? [],
    ...(id === "diff" ? { verbatim: true } : {}),
  }));

const findingsOf = (a: AssembledPrompt, regen = false) =>
  lintCell({ name: "seeded", regen, sections: lintSectionsOf(a) }, { artifactReferences: ARTIFACT_REFERENCES });

const providersOf = (a: AssembledPrompt, fact: FactId): string[] =>
  Object.entries(a.claims)
    .filter(([, claims]) => claims.some((c) => c.kind === "provides" && c.fact === fact))
    .map(([id]) => id)
    .sort();

const directsRead = (a: AssembledPrompt, id: string, target: FactId): boolean =>
  (a.claims[id] ?? []).some((c) => c.kind === "directs" && c.action === "read" && c.target === target);

const SUITE_LISTING = ["flows/cart.spec.ts", "flows/login.spec.ts — flow: login, objective: the user signs in"];

test("the suite listing declares the fact it provides, and the fact has that one provider", () => {
  const a = buildPromptAssembled(mkInput({ existingSpecFiles: SUITE_LISTING }));
  assert.deepEqual(provided(a, "existing-suite-manifest"), ["existing-suite"]);
  assert.deepEqual(providersOf(a, "existing-suite"), ["existing-suite-manifest"]);
});

test("a section that is not rendered provides nothing: no listing means no provider", () => {
  const a = buildPromptAssembled(mkInput());
  assert.deepEqual(providersOf(a, "existing-suite"), []);
  const context = buildPromptAssembled(mkInput({ mode: "context", existingSpecFiles: SUITE_LISTING }));
  assert.deepEqual(providersOf(context, "existing-suite"), [], "context mode");
});

test("a prompt that carries the suite listing refers to it only where it carries it", () => {
  const carrying = buildPromptAssembled(mkInput({ existingSpecFiles: SUITE_LISTING }));
  assert.deepEqual(findingsOf(carrying), []);
  const regen = buildPromptAssembled(
    mkInput({ existingSpecFiles: SUITE_LISTING, fixCases: [{ name: "cart total", status: "fail", detail: "boom" }] }),
  );
  assert.deepEqual(findingsOf(regen, true), []);
});

test("the manual e2e first pass sends the agent to the existing suite only when no listing provides it", () => {
  const dir = "qa-suite";
  const manual = (extra: Partial<OpencodeRunInput>): AssembledPrompt =>
    buildPromptAssembled(mkInput({ mode: "manual", guidance: "cover the coupon form", e2eRelDir: dir, ...extra }));

  const unlisted = manual({});
  assert.equal(directsRead(unlisted, "task", "existing-suite"), true, "no listing: the task reads the suite");
  assert.ok(sectionText(unlisted, "task").includes(`${dir}/`), "the read names the suite directory it points at");
  assert.deepEqual(providersOf(unlisted, "existing-suite"), []);
  assert.deepEqual(findingsOf(unlisted), []);

  for (const listing of [SUITE_LISTING.slice(0, 1), SUITE_LISTING]) {
    const listed = manual({ existingSpecFiles: listing });
    assert.equal(directsRead(listed, "task", "existing-suite"), false, `${listing.length} listed: the listing supplies the suite, so no read`);
    assert.equal(sectionText(listed, "task").includes(`${dir}/`), false, `${listing.length} listed: the task no longer points at the suite directory`);
    assert.deepEqual(providersOf(listed, "existing-suite"), ["existing-suite-manifest"]);
    assert.deepEqual(findingsOf(listed), []);
  }
});

test("the suite listing's section is titled with the name the lint knows it by, so a reference to it by name is checked", () => {
  const a = buildPromptAssembled(mkInput({ existingSpecFiles: SUITE_LISTING }));
  assert.equal(PROMPT_HEADINGS.existingSuiteManifest, "existing-suite-manifest", "the lint knows the section by its id");
  assert.ok(sectionText(a, "existing-suite-manifest").startsWith(`## ${PROMPT_HEADINGS.existingSuiteManifest} (`), "the title is the named constant");
  const dangling = lintCell(
    { name: "seeded", regen: false, sections: [...lintSectionsOf(buildPromptAssembled(mkInput())), { id: "extra", layer: "assembled", text: `See the ${PROMPT_HEADINGS.existingSuiteManifest} above.`, claims: [] }] },
    { artifactReferences: ARTIFACT_REFERENCES },
  );
  assert.deepEqual(dangling.map((f) => [f.rule, f.artifact]), [["R13", "existing-suite"]], "with no listing in the prompt the reference by name dangles");
});

test("a signal of co-change files alone is titled with the name the lint knows it by: a reference to it by name is met by the block and dangles without it", () => {
  const block = renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "src/Other.java", couplingScore: 0.8, coChanges: 5 }] });
  const withBlock = buildPromptAssembled(mkInput({ staticSignal: block }));
  assert.ok(sectionText(withBlock, "static-signal").startsWith(`## ${PROMPT_HEADINGS.coChangeFiles} (`), "the title is the named constant");
  const referring: LintSection = { id: "extra", layer: "assembled", text: `See the ${PROMPT_HEADINGS.coChangeFiles} above.`, claims: [] };
  const lintWithReference = (a: AssembledPrompt) =>
    lintCell({ name: "seeded", regen: false, sections: [...lintSectionsOf(a), referring] }, { artifactReferences: ARTIFACT_REFERENCES });
  assert.deepEqual(lintWithReference(withBlock), [], "the block provides the co-change files the reference points at");
  assert.deepEqual(lintWithReference(buildPromptAssembled(mkInput())).map((f) => [f.rule, f.artifact]), [["R13", "co-change"]], "with no block in the prompt the reference dangles");
});

test("an empty listing supplies nothing, so the manual first pass still reads the suite", () => {
  const empty = buildPromptAssembled(mkInput({ mode: "manual", guidance: "cover the form", existingSpecFiles: [] }));
  assert.equal(directsRead(empty, "task", "existing-suite"), true);
});

test("a prompt over its window declares claims only for the sections it still carries, and a section given a smaller render keeps its claims", () => {
  const input = mkInput({ staticSignal: renderBlastRadiusSignal({ impacted: [{ file: "src/a.ts", symbol: "run" }], callers: Array.from({ length: 300 }, (_, i) => ({ file: `src/c/C${i % 10}.ts`, symbol: `caller${i}` })), coupled: [] }), staticSignalHasSymbols: true });
  const full = buildPromptAssembled(input);
  assert.ok(full.claims["static-signal"], "the section declared claims while it was whole");
  const tight = buildPromptAssembled(input, { fit: ({ bytes }) => (bytes <= Buffer.byteLength(full.text, "utf8") - 3_000 ? "fits" : "over") });
  assert.ok(tight.windowFit?.degraded.some((section) => section.id === "static-signal"), "the structural block was given a smaller render");
  assert.deepEqual(tight.claims["static-signal"], full.claims["static-signal"]);
  assert.ok(Object.keys(tight.claims).every((id) => tight.sectionSizes[id] !== undefined), "claims exist only for sections in the prompt");
});
