/* Every fact in the generator prompt has one owner: one section provides it, one section frames its trust, and orientation guidance is dropped exactly when the fact it would orient towards is supplied. Asserted on claims and on the options the builders hand to the brief renderer, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  renderArchitectureContext,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import { countDirectives, type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { ArchitectureContext, OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

let lastBriefOptions: { omitLandmarks?: boolean } | undefined;
setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief, opts?: { omitLandmarks?: boolean }) => {
    lastBriefOptions = opts;
    return `## Exploration brief\nObjective: ${brief.objective}`;
  },
});

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

const BRIEF: ExplorationBrief = {
  builtForSha: "abc1234",
  objective: "checkout flow",
  blastRadius: [{ symbol: "Pay.go", file: "src/pay.ts", role: "pays" }],
  feBe: [{ route: "/cart", operationId: "applyCoupon" }],
  contracts: [{ operationId: "applyCoupon", method: "POST", path: "/cart/coupon" }],
  risks: ["assert the total"],
  routes: [{ path: "/cart", verified: false, domLandmarks: ["button Apply"] }],
};

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

/* ── the brief frames the facts it distilled, once ── */

test("the brief section frames its blast radius, risks and contracts as established, and nobody else frames them", () => {
  const a = buildPromptAssembled(mkInput({ contextBrief: BRIEF, contextPack: DOM_PACK, contextMap: MAP }));
  for (const fact of ["blast-radius", "risks", "contracts"] as const) {
    assert.deepEqual(framers(a, fact), ["context-brief"], fact);
    assert.equal(stance(a, "context-brief", fact), "established", fact);
  }
});

test("the pack no longer provides the blast radius, FE-BE links or risks, so the brief is their only provider", () => {
  const a = buildPromptAssembled(mkInput({ contextBrief: BRIEF, contextPack: DOM_PACK }));
  for (const fact of ["blast-radius", "risks", "fe-be-links"] as const) assert.deepEqual(providers(a, fact), ["context-brief"], fact);
});

/* ── landmarks are dropped when a DOM tree exists ── */

test("the brief is rendered without landmarks when the pack, a live tree or a failure tree is in the prompt", () => {
  const withTree: Array<Partial<OpencodeRunInput>> = [
    { contextPack: DOM_PACK },
    { domSnapshot: TREE },
    { domSnapshot: TREE, failureSourced: true, fixCases: [{ name: "t", status: "fail" }] },
  ];
  for (const extra of withTree) {
    const a = buildPromptAssembled(mkInput({ contextBrief: BRIEF, ...extra }));
    assert.equal(lastBriefOptions?.omitLandmarks, true, JSON.stringify(Object.keys(extra)));
    assert.equal(providers(a, "landmarks").length, 0);
  }
});

test("the brief keeps its landmarks, framed as hints, when no DOM tree is in the prompt", () => {
  for (const extra of [{}, { contextPack: CONTRACTS_PACK }] as Array<Partial<OpencodeRunInput>>) {
    const a = buildPromptAssembled(mkInput({ contextBrief: BRIEF, ...extra }));
    assert.notEqual(lastBriefOptions?.omitLandmarks, true);
    assert.deepEqual(providers(a, "landmarks"), ["context-brief"]);
    assert.equal(stance(a, "context-brief", "landmarks"), "unverified");
  }
});

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

test("FE-BE links belong to the brief when it carries them, whatever else is in the prompt", () => {
  for (const extra of [{}, { contextPack: DOM_PACK }] as Array<Partial<OpencodeRunInput>>) {
    const a = buildPromptAssembled(mkInput({ contextBrief: BRIEF, contextMap: MAP, ...extra }));
    assert.deepEqual(providers(a, "fe-be-links"), ["context-brief"]);
  }
});

test("FE-BE links belong to the architecture map when the brief carries none, and never to the pack", () => {
  const briefWithoutLinks = { ...BRIEF, feBe: undefined };
  const a = buildPromptAssembled(mkInput({ contextBrief: briefWithoutLinks, contextMap: MAP, contextPack: DOM_PACK }));
  assert.deepEqual(providers(a, "fe-be-links"), ["arch-map"]);
  assert.equal(buildPromptAssembled(mkInput({ contextPack: DOM_PACK })).claims["context-pack"]?.some((c) => c.kind === "provides" && c.fact === "fe-be-links"), false);
});

/* ── orientation guards are per fact ── */

test("the symbol-reference orientation is dropped only when a brief with a blast radius supplies it", () => {
  const table: Array<[string, Partial<OpencodeRunInput>, boolean]> = [
    ["a brief with a blast radius", { contextBrief: BRIEF }, false],
    ["a brief with an empty blast radius", { contextBrief: { ...BRIEF, blastRadius: [] } }, true],
    ["a pack with only a DOM", { contextPack: DOM_PACK }, true],
    ["only the advisory structural signal", { staticSignal: "## Structural blast radius\n- a" }, true],
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
