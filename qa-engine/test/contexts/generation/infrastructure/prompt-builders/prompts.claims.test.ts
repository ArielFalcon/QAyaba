/* The claims a prompt declares per section: what it provides, how it frames a fact, what it directs the agent to do. The prompt-contract lint reads them, so each behavior here is asserted on claims and section sizes, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import type { FactId, PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
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
