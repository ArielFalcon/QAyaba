/* The claims a prompt declares per section: what it provides, how it frames a fact, what it directs the agent to do. The prompt-contract lint reads them, so each behavior here is asserted on claims and section sizes, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import { lintCell, type FactId, type LintSection, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: true,
    target: "e2e",
    mode: "diff",
    appName: "testapp",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

const BRIEF: ExplorationBrief = {
  builtForSha: "abc1234",
  objective: "checkout flow",
  blastRadius: [{ symbol: "Pay.go", file: "src/pay.ts", role: "pays" }],
  feBe: [{ route: "/checkout", operationId: "createOrder" }],
  contracts: [{ operationId: "createOrder", method: "POST", path: "/orders" }],
  risks: ["assert the discounted total"],
  routes: [{ path: "/checkout", verified: false, domLandmarks: ["button Pay"] }],
};

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

test("the brief section declares the facts its brief carries", () => {
  const full = buildPromptAssembled(mkInput({ contextBrief: BRIEF }));
  assert.deepEqual(provided(full, "context-brief"), ["blast-radius", "contracts", "fe-be-links", "landmarks", "risks"]);
  const minimal = buildPromptAssembled(mkInput({ contextBrief: { ...BRIEF, feBe: undefined, contracts: undefined, risks: undefined, routes: undefined } }));
  assert.deepEqual(provided(minimal, "context-brief"), ["blast-radius"]);
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
    mkInput({ staticSignal: "## Structural blast radius\n- a", serviceLinks: [link as never] }),
  );
  assert.deepEqual(provided(assembled, "static-signal"), ["structural-signal"]);
  assert.deepEqual(provided(assembled, "service-links"), ["service-links"]);
  assert.deepEqual(provided(assembled, "diff"), ["diff"]);
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

const LEARNED_RULES = [
  "## Proven rules from past QA runs",
  "These proven rules were earned from real failures.",
  "### Rule (selector, confidence=0.9)",
  "- Trigger: a coupon button",
  "- Action: scope it to the cart form",
].join("\n");
const FORM_PATTERN: NonNullable<OpencodeRunInput["structuralPatterns"]> = [{ kind: "form", hasOnSubmit: true, hasValidation: true }];
const SUITE_LISTING = ["flows/cart.spec.ts", "flows/login.spec.ts — flow: login, objective: the user signs in"];

test("the suite listing, the skill exemplars and the learned rules each declare the fact they provide, and each fact has that one provider", () => {
  const a = buildPromptAssembled(mkInput({ existingSpecFiles: SUITE_LISTING, structuralPatterns: FORM_PATTERN, learnedRules: LEARNED_RULES }));
  assert.deepEqual(provided(a, "existing-suite-manifest"), ["existing-suite"]);
  assert.deepEqual(provided(a, "skill-exemplars"), ["exemplars"]);
  assert.deepEqual(provided(a, "learned-rules"), ["learned-rules"]);
  assert.deepEqual(providersOf(a, "existing-suite"), ["existing-suite-manifest"]);
  assert.deepEqual(providersOf(a, "exemplars"), ["skill-exemplars"]);
  assert.deepEqual(providersOf(a, "learned-rules"), ["learned-rules"]);
});

test("a section that is not rendered provides nothing: no listing, no exemplar match and no rules mean no provider", () => {
  const a = buildPromptAssembled(mkInput());
  for (const fact of ["existing-suite", "exemplars", "learned-rules"] as const) assert.deepEqual(providersOf(a, fact), [], fact);
  const context = buildPromptAssembled(mkInput({ mode: "context", existingSpecFiles: SUITE_LISTING, learnedRules: LEARNED_RULES }));
  for (const fact of ["existing-suite", "exemplars", "learned-rules"] as const) assert.deepEqual(providersOf(context, fact), [], `context mode: ${fact}`);
});

/* The matrix assembles neither the exemplars nor the learned rules, so this is where their references meet the real sections: the exemplars' own text points at test templates, and only the section's claim keeps that from being a dangling reference. */
test("a prompt that carries the suite listing, the exemplars and the learned rules refers to each only where it carries it", () => {
  const carrying = buildPromptAssembled(mkInput({ existingSpecFiles: SUITE_LISTING, structuralPatterns: FORM_PATTERN, learnedRules: LEARNED_RULES }));
  assert.deepEqual(findingsOf(carrying), []);
  const regen = buildPromptAssembled(
    mkInput({ existingSpecFiles: SUITE_LISTING, structuralPatterns: FORM_PATTERN, learnedRules: LEARNED_RULES, fixCases: [{ name: "cart total", status: "fail", detail: "boom" }] }),
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

test("an empty listing supplies nothing, so the manual first pass still reads the suite; a code run's manual task never declares that read", () => {
  const empty = buildPromptAssembled(mkInput({ mode: "manual", guidance: "cover the form", existingSpecFiles: [] }));
  assert.equal(directsRead(empty, "task", "existing-suite"), true);
  const code = buildPromptAssembled(mkInput({ mode: "manual", guidance: "cover the form", target: "code", existingSpecFiles: [] }));
  assert.equal(directsRead(code, "task", "existing-suite"), false);
});

test("a section shed by the byte budget contributes no claims and a surviving one keeps them", () => {
  const input = mkInput({ domSnapshot: "  button: Save" });
  const full = buildPromptAssembled(input);
  assert.ok(full.claims["dom-snapshot"], "the section declared claims while it survived");
  const total = Buffer.byteLength(full.text, "utf8");
  const tight = buildPromptAssembled(input, { budgetBytes: total - (full.sectionSizes["dom-snapshot"] ?? 0) });
  assert.equal(tight.sectionSizes["dom-snapshot"], undefined, "the volatile tree was shed");
  assert.equal(tight.claims["dom-snapshot"], undefined);
  assert.ok(Object.keys(tight.claims).every((id) => tight.sectionSizes[id] !== undefined), "claims exist only for surviving sections");
});
