/* Every fact in the generator prompt has one owner: one section provides it, one section frames its trust, and orientation guidance is dropped exactly when the fact it would orient towards is supplied. Asserted on claims, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  renderArchitectureContext,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import { countDirectives, type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { ArchitectureContext } from "@contexts/generation/domain/generation-input.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { setAgentsConfigPath } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { rosterFixturePath } from "../../../../support/roster-fixture.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/app/cart/cart.service.ts"] },
    ...overrides,
  };
}

const MAP: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/cart", component: "CartComponent" }],
  api: [{ operationId: "applyCoupon", method: "POST", path: "/cart/coupon" }],
  feBe: [{ route: "/cart", operationId: "applyCoupon" }],
};

const packOf = (...headings: string[]): string =>
  [`## ${PACK_HEADINGS.pack}`, "", ...headings.map((h) => `### ${h} (x)\n  a line`)].join("\n");
const DOM_PACK = packOf(PACK_HEADINGS.liveDom);
const CONTRACTS_PACK = packOf(PACK_HEADINGS.contracts);
const TREE = "  heading: Cart\n  button: Apply";

const claimsOf = (a: AssembledPrompt, id: string): readonly PromptClaim[] => a.claims[id] ?? [];
const providers = (a: AssembledPrompt, fact: FactId): string[] =>
  Object.entries(a.claims)
    .filter(([, cs]) => cs.some((c) => c.kind === "provides" && c.fact === fact))
    .map(([id]) => id)
    .sort();
const framers = (a: AssembledPrompt, fact: FactId): string[] =>
  Object.entries(a.claims)
    .filter(([, cs]) => cs.some((c) => c.kind === "frames" && c.fact === fact))
    .map(([id]) => id)
    .sort();
const stance = (a: AssembledPrompt, id: string, fact: FactId): string | undefined => {
  const c = claimsOf(a, id).find((k) => k.kind === "frames" && k.fact === fact);
  return c?.kind === "frames" ? c.as : undefined;
};
const directs = (a: AssembledPrompt, id: string, action: string, target?: FactId): boolean =>
  claimsOf(a, id).some((c) => c.kind === "directs" && c.action === action && (target === undefined || c.target === target));

/* ── API operations have one owner ── */

test("the architecture map omits its API operations list when the pack's contracts section owns them", () => {
  const withPackContracts = buildPromptAssembled(mkInput({ contextMap: MAP, contextPack: CONTRACTS_PACK }));
  assert.deepEqual(providers(withPackContracts, "api-operations"), ["context-pack"]);
  assert.ok(withPackContracts.claims["arch-map"], "the map itself stays");

  const withoutPackContracts = buildPromptAssembled(mkInput({ contextMap: MAP, contextPack: DOM_PACK }));
  assert.deepEqual(providers(withoutPackContracts, "api-operations"), ["arch-map"]);
});

test("renderArchitectureContext lists each API operation once: never when told to yield them, otherwise always", () => {
  const listed = renderArchitectureContext(MAP, undefined, {});
  const yielded = renderArchitectureContext(MAP, undefined, { suppressApiOperations: true });
  assert.ok(listed?.includes("applyCoupon") && /API operations/.test(listed));
  assert.equal(yielded?.includes("applyCoupon") && /### API operations/.test(yielded), false);
  assert.ok(yielded?.includes("/cart"), "the routes stay");
});

/* ── FE-BE links have one owner ── */

test("FE-BE links belong to the architecture map, whatever else is in the prompt, and never to the pack", () => {
  for (const extra of [{}, { contextPack: DOM_PACK }] as Array<Partial<OpencodeRunInput>>) {
    const a = buildPromptAssembled(mkInput({ contextMap: MAP, ...extra }));
    assert.deepEqual(providers(a, "fe-be-links"), ["arch-map"]);
  }
  assert.equal(buildPromptAssembled(mkInput({ contextPack: DOM_PACK })).claims["context-pack"]?.some((c) => c.kind === "provides" && c.fact === "fe-be-links"), false);
});

/* ── orientation guards are per fact ── */

test("the symbol-reference orientation is dropped only when the prompt carries a structural signal that names symbols", () => {
  const table: Array<[string, Partial<OpencodeRunInput>, boolean]> = [
    ["a structural signal that names symbols", { staticSignal: "## Structural blast radius\n- `save` (src/Foo.java)", staticSignalHasSymbols: true }, false],
    ["a pack with only a DOM", { contextPack: DOM_PACK }, true],
    ["a structural signal of co-change files alone", { staticSignal: renderBlastRadiusSignal({ impacted: [], callers: [], coupled: [{ file: "src/Other.java", couplingScore: 0.82, coChanges: 14 }] }) }, true],
    ["nothing", {}, true],
  ];
  for (const [label, extra, orients] of table) {
    const a = buildPromptAssembled(mkInput(extra));
    assert.equal(directs(a, "task", "orient", "blast-radius"), orients, label);
  }
});

test("the map is not sent to be read from disk when it is already in the prompt, and is when it is not", () => {
  assert.equal(directs(buildPromptAssembled(mkInput({ contextMap: MAP })), "task", "read", "arch-map"), false);
  assert.equal(directs(buildPromptAssembled(mkInput()), "task", "read", "arch-map"), true);
  const emptyMap: ArchitectureContext = { builtAtSha: "abc1234", routes: [], api: [], feBe: [] };
  assert.equal(directs(buildPromptAssembled(mkInput({ contextMap: emptyMap })), "task", "read", "arch-map"), true, "a map that renders nothing is not injected");
});

test("the map's trust is framed once: by the map section when injected, by the read instruction otherwise", () => {
  assert.deepEqual(framers(buildPromptAssembled(mkInput({ contextMap: MAP })), "arch-map"), ["arch-map"]);
  assert.deepEqual(framers(buildPromptAssembled(mkInput()), "arch-map"), ["task"]);
});

test("the map's framing is a staleness statement only: it directs nothing", () => {
  const a = buildPromptAssembled(mkInput({ contextMap: MAP }));
  assert.equal(stance(a, "arch-map", "arch-map"), "unverified");
  assert.equal(claimsOf(a, "arch-map").some((c) => c.kind === "directs"), false);
  assert.equal(countDirectives(renderArchitectureContext(MAP) ?? ""), 0);
});

/* ── the live DOM has one section ── */

const MIXED_PACK = [
  `## ${PACK_HEADINGS.pack}`,
  "",
  "the pack header",
  "",
  `### ${PACK_HEADINGS.liveDom} (x)`,
  "  heading: STALE-PACK-LINE",
  "",
  `### ${PACK_HEADINGS.contracts} (x)`,
  "- `applyCoupon`: POST /cart/coupon",
].join("\n");

test("a freshly captured tree and the pack's live DOM never both appear: the tree wins and the pack keeps its other sections", () => {
  const a = buildPromptAssembled(mkInput({ contextPack: MIXED_PACK, domSnapshot: TREE }));
  assert.deepEqual(providers(a, "dom-live"), ["dom-snapshot"]);
  assert.deepEqual(providers(a, "api-operations"), ["context-pack"]);
  assert.equal(a.text.includes("STALE-PACK-LINE"), false);
  assert.deepEqual(framers(a, "dom-live"), ["dom-snapshot"]);
});

test("a pack whose only section was the live DOM disappears when a captured tree is injected", () => {
  const onlyDom = [`## ${PACK_HEADINGS.pack}`, "", "the pack header", "", `### ${PACK_HEADINGS.liveDom} (x)`, "  heading: STALE-PACK-LINE"].join("\n");
  const a = buildPromptAssembled(mkInput({ contextPack: onlyDom, domSnapshot: TREE }));
  assert.equal(a.sectionSizes["context-pack"], undefined);
  assert.deepEqual(providers(a, "dom-live"), ["dom-snapshot"]);
});

test("a failure tree is a different fact from the pack's live DOM, so both stay", () => {
  const a = buildPromptAssembled(mkInput({ contextPack: MIXED_PACK, domSnapshot: TREE, failureSourced: true, fixCases: [{ name: "t", status: "fail" }] }));
  assert.deepEqual(providers(a, "dom-live"), ["context-pack"]);
  assert.deepEqual(providers(a, "dom-failure"), ["dom-snapshot"]);
});

test("the working rules restate no trust level of the DOM: the section that holds the tree frames it", () => {
  for (const extra of [{ contextPack: MIXED_PACK }, { domSnapshot: TREE }, {}] as Array<Partial<OpencodeRunInput>>) {
    const a = buildPromptAssembled(mkInput(extra));
    assert.equal(claimsOf(a, "working-rules").some((c) => c.kind === "frames"), false);
  }
});

/* ── the advisory riders ── */

const SIGNAL = "## Structural blast radius\n- `save` (src/Foo.java)";

test("the structural signal is assembled whatever else is in the prompt", () => {
  assert.ok(buildPromptAssembled(mkInput({ staticSignal: SIGNAL })).sectionSizes["static-signal"] !== undefined);
  assert.ok(buildPromptAssembled(mkInput({ contextPack: DOM_PACK, staticSignal: SIGNAL })).sectionSizes["static-signal"] !== undefined);
});

test("the cross-service links are advisory data: framed as unverified, with nothing directed about them", () => {
  const link = {
    from: { repo: "org/app", file: "src/cart.client.ts", symbol: "applyCoupon" },
    to: { repo: "org/orders", file: "src/Orders.java", symbol: "OrdersController.applyCoupon" },
    transport: "http" as const,
    contractRef: "POST /cart/coupon",
    confidence: 0.9,
    source: "openapi-join",
  };
  const a = buildPromptAssembled(mkInput({ serviceLinks: [link] }));
  assert.ok(a.sectionSizes["service-links"] !== undefined, "the section is rendered");
  assert.deepEqual(providers(a, "service-links"), ["service-links"]);
  assert.equal(stance(a, "service-links", "service-links"), "unverified");
  assert.equal(claimsOf(a, "service-links").some((c) => c.kind === "directs"), false, "it directs the agent to do nothing about the links");
  assert.ok(a.text.includes(PROMPT_HEADINGS.crossServiceLinks));
});
