/*
 * Prompt-contract matrix: assembles the REAL generator prompt (real builders, the real
 * context-pack builder over fake capture deps) across the run shapes that can
 * reach the agent, pairs each with the static role layer of the runtime and lints every
 * combination. A layer's cell is assembled from the input its own runtime hands the prompt: the
 * OpenCode runtime enforces a step limit and the prompt is given it, or states none for a role it reports no cap for.
 * The lint lives in qa-engine; this module lives in scripts/ because it also reads the static role layers and the baseline file.
 *
 * Every combination is budgeted: its user-prompt bytes and directive volume against the largest
 * recorded for its bucket (mode, target, phase, tree and grounding; a cell with a step limit has the
 * bucket of its twin without one, plus a suffix), and each static layer against its recorded size.
 * The baseline only tightens: recording refuses any raise over the committed one unless a reason is
 * given, and the reason is kept in the file.
 *
 * Commands:
 *   tsx scripts/prompt-contract-matrix.ts                                    print the unique findings of the current tree
 *   tsx scripts/prompt-contract-matrix.ts --record                           rewrite scripts/prompt-contract-baseline.json
 *   tsx scripts/prompt-contract-matrix.ts --record --allow-increase "<why>"  the same, raising budgets for the stated reason
 *   tsx scripts/prompt-contract-matrix.ts --record-digests                   rewrite scripts/prompt-section-digests.txt (see the digest pin below)
 */
import type { ServiceLink } from "@kernel/service-links";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  ASSEMBLED_ARTIFACT_NAMES,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { buildContextPack, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { formatDomCapture, formatDomSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { type RouteSnapshot } from "@contexts/generation/domain/route-snapshot.ts";
import { hasSymbolBlocks, renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import {
  countDirectives,
  findingKey,
  AGENT_BROWSER_SECTION_ID,
  CLOSED_LOOP_SECTION_ID,
  HARNESS_FACTS_SECTION_ID,
  STEP_LIMIT_SECTION_ID,
  lintCell,
  type LintCell,
  type LintFinding,
  type LintSection,
} from "@contexts/generation/application/index.ts";
import type { ArchitectureContext, DelegationGrant, OpencodeRunInput, ReviewInput } from "@contexts/generation/application/index.ts";
import {
  CORRECTION_ORIGIN,
  assembleExploreBrief,
  assembleExploreOutcome,
  assembleLeadCorrection,
  assembleLeadReview,
  assembleRefusedCorrection,
  assembleRejectedPlanRequest,
  assembleReplanRequest,
  assembleSidekickBrief,
  assembleSidekickFeedback,
  createDelegationBrief,
  type CorrectionOrigin,
} from "@contexts/coordination/application/index.ts";
import { DEFAULT_CLOSED_LOOP_LIMITS } from "@kernel/closed-loop.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS } from "@kernel/agent-browser.ts";
import { DEFAULT_COORDINATION_SETTINGS } from "@kernel/coordination.ts";
import { LISTING_MAX_DO_NOT_REWRITE, LISTING_MAX_UNNAMED_EDITABLE } from "@contexts/generation/application/index.ts";
import { formatSuiteEntry } from "@contexts/generation/application/index.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/application/index.ts";
import type { HarnessFacts } from "@contexts/generation/application/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* The user prompt of the reference production run, in bytes, before any hygiene work: no cell may exceed it. The baseline file repeats it and a test keeps the two equal. */
export const GLOBAL_USER_PROMPT_BASELINE_BYTES = 20_083;

export const DIMENSIONS = {
  mode: ["diff", "complete", "exhaustive", "manual", "context"],
  phase: ["first", "regen-fix", "regen-review", "regen-coverage", "selector-fix"],
  tree: ["none", "failure", "live"],
  grounding: ["none", "pack"],
  target: ["e2e", "code"],
  contextMap: [false, true],
  /* What the structural signal holds: nothing, symbol blocks (impacted symbols and callers), or co-change files alone, which are no blast radius. */
  structuralSignal: ["none", "symbols", "co-change"],
  authSeedUnauthored: [false, true],
  serviceLinks: [false, true],
  harnessFacts: [false, true],
  /* Whether the pack captured a live DOM; without one it holds the contracts alone. */
  packDom: [true, false],
  /* Whether a gated route redirected, so the pack lists the page it reached as a section of its own; only a pack with a captured DOM can. */
  packRedirect: [false, true],
  /* The change belongs to a microservice rather than to the frontend repo. */
  service: [false, true],
  /* Whether the run lists any spec: the suite as the grounding folded it, on a diff or a manual run, and on a regeneration the specs the run has delivered. `large` is the worst case of a listing: a diff or manual run that delivered more specs than the listing shows of the ones it can say nothing of, over a suite that has more than it shows of the ones to leave alone, and then could not say which spec to change. */
  suite: ["listed", "none", "large"],
  /* Whether the run granted the generator the run_spec tool, so its prompt states the budget. Only an e2e run that writes tests has it. */
  closedLoop: [false, true],
  /* Whether the run also granted the authoring agents the authenticated browser, so its prompt states that budget as well. Like the run_spec budget, only an e2e run that writes tests has it; the combinations that carry it are the granted ones of the run_spec budget, since its block is as small and as independent of every other. */
  agentBrowser: [false, true],
  /* Whether the prompt is the planning turn of a coordinated run, so it carries the plan contract. Only the first pass of an e2e run that writes tests has it (the lead is held from writing on that turn). */
  planning: [false, true],
} as const;

export type CellSpec = { -readonly [K in keyof typeof DIMENSIONS]: (typeof DIMENSIONS)[K][number] };
type DimensionName = keyof typeof DIMENSIONS;

const DIMENSION_NAMES = Object.keys(DIMENSIONS) as DimensionName[];

/* Combinations that cannot reach the agent are filtered out, not linted. */
export function isValidSpec(spec: CellSpec): boolean {
  const isContext = spec.mode === "context";
  const isCode = spec.target === "code";
  const regenWithTree = spec.phase === "regen-fix" || spec.phase === "selector-fix";
  if (isContext) {
    if (spec.phase !== "first" || spec.tree !== "none" || spec.grounding !== "none") return false;
    if (isCode || spec.structuralSignal !== "none" || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts) return false;
  }
  if (isCode) {
    if (spec.tree !== "none" || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service) return false;
    if (spec.grounding === "pack") return false;
    if (spec.phase === "selector-fix") return false;
  }
  if (spec.tree !== "none" && !regenWithTree) return false;
  const hasPack = spec.grounding === "pack";
  /* A signal of co-change files alone bears on one decision, whether the prompt carries an explored blast radius, and the optional blocks do not change it: it meets every phase, tree and grounding of a diff run (the only run that has a signal at all), but not their cross product with the blocks. */
  if (
    spec.structuralSignal === "co-change" &&
    (spec.mode !== "diff" || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service || spec.packRedirect)
  ) {
    return false;
  }
  /* A pack without a DOM is the contracts alone, which the architecture map supplies. */
  if (spec.packDom === false && !(hasPack && spec.contextMap)) return false;
  if (spec.packRedirect && !(hasPack && spec.packDom)) return false;
  /* A run lists the suite on a diff or a manual first pass and carries the specs it has delivered on every regeneration; a complete, exhaustive or context first pass lists none, so its only combinations are the listed ones. Having nothing to list bears on the task and the fix, not on the optional blocks, and meets every phase, tree and grounding of a run without them. */
  if (spec.suite === "none") {
    const lists = spec.mode === "diff" || spec.mode === "manual" || spec.phase !== "first";
    if (!lists || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service || spec.packRedirect) return false;
  }
  /* The worst case of a listing is one shape of its own, not a copy of the cross product: the regenerations that cannot say which spec to change (a coverage gap, a contradiction no spec is attributed to) of a run that lists its suite, with none of the optional blocks and the signals of a plain run. */
  if (spec.suite === "large") {
    const cannotSayWhich = spec.phase === "regen-coverage" || spec.phase === "selector-fix";
    const listsItsSuite = spec.mode === "diff" || spec.mode === "manual";
    if (!cannotSayWhich || !listsItsSuite || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service || spec.packRedirect) return false;
    if (spec.structuralSignal !== "none" || !spec.packDom) return false;
  }
  /* The budget is one small block that bears on no other decision: it meets every phase, tree and grounding of an e2e run that writes tests, with the plain signals and none of the optional blocks. */
  if (spec.closedLoop) {
    if (isContext || isCode || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service || spec.packRedirect) return false;
    if (spec.structuralSignal !== "none" || !spec.packDom || spec.suite !== "listed") return false;
  }
  /* The browser's budget meets exactly the shapes the run_spec budget does, and is granted on top of it. */
  if (spec.agentBrowser && !spec.closedLoop) return false;
  /* The plan contract is one block that bears on no other decision: it meets the first pass of an e2e run that writes tests, over every grounding, with the plain signals and none of the optional blocks, and apart from the tool budgets. */
  if (spec.planning) {
    if (isContext || isCode || spec.phase !== "first" || spec.tree !== "none" || spec.closedLoop || spec.agentBrowser) return false;
    if (spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service || spec.packRedirect) return false;
    if (spec.structuralSignal !== "none" || !spec.packDom || spec.suite !== "listed") return false;
  }
  /* The service block belongs to the diff-shaped first pass and to every regeneration of an e2e run. */
  if (spec.service && (isContext || (spec.mode !== "diff" && spec.phase === "first"))) return false;
  return true;
}

let validSpecs: CellSpec[] | undefined;

/* Every combination of the dimensions that can reach the agent. Cached: the walk covers the full
   cross product and every caller only reads the list.
   shortcut: the cached array is shared, not copied; keep callers read-only (today all are filter/find/map/for). */
export function allValidSpecs(): CellSpec[] {
  return (validSpecs ??= collectValidSpecs());
}

function collectValidSpecs(): CellSpec[] {
  const specs: CellSpec[] = [];
  const partial = {} as Partial<Record<DimensionName, unknown>>;
  const walk = (index: number): void => {
    const name = DIMENSION_NAMES[index];
    if (name === undefined) {
      if (isValidSpec(partial as unknown as CellSpec)) specs.push({ ...partial } as CellSpec);
      return;
    }
    for (const value of DIMENSIONS[name] as readonly unknown[]) {
      partial[name] = value;
      walk(index + 1);
    }
  };
  walk(0);
  return specs;
}

/* How a signal that holds something is named in a cell name and a bucket. */
const SIGNAL_FLAG = { symbols: "signal", "co-change": "co-change" } as const;

export function cellName(spec: CellSpec): string {
  const flags = [
    spec.contextMap ? "map" : "",
    spec.structuralSignal === "none" ? "" : SIGNAL_FLAG[spec.structuralSignal],
    spec.authSeedUnauthored ? "login" : "",
    spec.serviceLinks ? "links" : "",
    spec.harnessFacts ? "facts" : "",
    spec.packDom ? "" : "nodom",
    spec.packRedirect ? "redirect" : "",
    spec.service ? "service" : "",
    spec.suite === "none" ? "nosuite" : "",
    spec.suite === "large" ? "largesuite" : "",
    spec.closedLoop ? "loop" : "",
    spec.agentBrowser ? "browser" : "",
    spec.planning ? "planning" : "",
  ].filter(Boolean);
  return [
    spec.mode,
    spec.target,
    spec.phase,
    `tree-${spec.tree}`,
    spec.grounding,
    ...(flags.length ? [flags.join("+")] : []),
  ].join("/");
}

/* ── fixtures: small, deterministic, and shaped like what the run loop really produces ── */

const TREE_TEXT = formatDomSnapshot([
  {
    route: "/cart",
    settled: true,
    nodes: ["heading: Cart", "textbox: Coupon code", "button: Apply coupon"],
  },
]);

const CONTEXT_MAP: ArchitectureContext = {
  builtAtSha: "abc1234def",
  routes: [{ path: "/cart", component: "CartComponent" }, { path: "/checkout", component: "CheckoutComponent" }],
  api: [
    { operationId: "applyCoupon", method: "POST", path: "/cart/coupon" },
    { operationId: "createOrder", method: "POST", path: "/orders", service: "orders" },
  ],
  feBe: [
    { route: "/cart", operationId: "applyCoupon", via: "CartClient.applyCoupon" },
    { route: "/checkout", operationId: "createOrder" },
  ],
  flows: [{ id: "checkout", routes: ["/cart", "/checkout"], operations: ["applyCoupon", "createOrder"] }],
};

const SERVICE_LINKS: ServiceLink[] = [
  {
    from: { repo: "org/app", file: "src/app/cart/cart.client.ts", symbol: "applyCoupon" },
    to: { repo: "org/orders", file: "src/main/java/orders/OrdersController.java", symbol: "OrdersController.applyCoupon" },
    transport: "http",
    contractRef: "POST /cart/coupon",
    confidence: 0.92,
    source: "openapi-join",
  },
];

const SERVICE: NonNullable<OpencodeRunInput["service"]> = {
  repo: "org/orders",
  mirrorDir: "/mirrors/org__orders-staged",
  openapi: "orders-api.yaml",
};

const HARNESS_FACTS: HarnessFacts = {
  testIdAttribute: "data-cy",
  fixtures: { file: "fixtures.ts", exports: ["test", "expect", "authenticate"] },
};

const DIFF = [
  "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts",
  "--- a/src/app/cart/cart.service.ts",
  "+++ b/src/app/cart/cart.service.ts",
  "@@ -10,3 +10,8 @@ export class CartService {",
  "+  applyCoupon(code: string) {",
  "+    return this.http.post('/cart/coupon', { code }).pipe(tap(() => this.refresh()));",
  "+  }",
  "diff --git a/src/app/cart/cart.component.ts b/src/app/cart/cart.component.ts",
  "--- a/src/app/cart/cart.component.ts",
  "+++ b/src/app/cart/cart.component.ts",
  "@@ -4,2 +4,3 @@ export class CartComponent {",
  "+  total$ = this.cart.total$;",
  "",
].join("\n");

/* A gated route: the browser ended on the login page, which the capture reports as a page reached, apart from the routes it grounded. */
const REDIRECT_SNAPS: RouteSnapshot[] = [
  { route: "/cart", settled: true, nodes: ["heading: Cart", "textbox: Coupon code", "button: Apply coupon"] },
  {
    route: "/checkout",
    settled: true,
    nodes: ["heading: Sign in", "textbox: Email", "textbox: Password", "button: Sign in"],
    attrs: [{ key: "textbox: Password", inputType: "password" }],
    finalUrl: "http://localhost:3000/login",
  },
];
const REDIRECT_TEXT = formatDomCapture(REDIRECT_SNAPS);

const packDeps: ContextPackDeps = {
  captureDomForRoutes: async () => TREE_TEXT,
  domDeps: { render: async () => [] },
  log: () => {},
};

const CHANGED_FILES = ["src/app/cart/cart.service.ts", "src/app/cart/cart.component.ts"];

async function buildPack(spec: CellSpec): Promise<string | undefined> {
  const capture = !spec.packDom ? undefined : spec.packRedirect ? REDIRECT_TEXT : TREE_TEXT;
  const deps: ContextPackDeps = { ...packDeps, captureDomForRoutes: async () => capture };
  const { text } = await buildContextPack(
    {
      ...(spec.contextMap ? { contextMap: CONTEXT_MAP } : {}),
      baseUrl: "http://localhost:3000",
      e2eDir: "/mirrors/org__app/e2e",
      prChangedFiles: CHANGED_FILES,
      routes: ["/cart"],
    },
    deps,
  );
  return text;
}

/* What the graph returned for the diff, per signal shape: the real renderer draws the block and the real predicate derives the flag the run sends with it. */
const SIGNAL_SHAPES = {
  symbols: {
    impacted: [{ symbol: "CartService.applyCoupon", file: "src/app/cart/cart.service.ts" }],
    callers: [{ symbol: "CartComponent.onApply", file: "src/app/cart/cart.component.ts" }],
    coupled: [],
  },
  "co-change": {
    impacted: [],
    callers: [],
    coupled: [{ file: "src/app/cart/cart.model.ts", couplingScore: 0.82, coChanges: 14 }],
  },
} as const;

/* The specs a run has delivered by the time a regeneration is built: the lead's, with the flow and the objective it declared (it refreshes the suite's own line for the same file), and a sidekick's, by path alone. An exhaustive run has delivered more than the listing shows of the specs it leaves alone, so its cells carry the cap's worth of them and some more. */
const DELIVERED_LEAD: DeliveredSpec = { file: "flows/cart.spec.ts", flow: "cart coupon", objective: "the discounted total shows after the cart re-queries" };
const DELIVERED_SIDEKICK: DeliveredSpec = { file: "flows/checkout.spec.ts" };
export const EXHAUSTIVE_EXTRA_DELIVERED = LISTING_MAX_DO_NOT_REWRITE + 5;

function deliveredFor(spec: CellSpec): DeliveredSpec[] {
  const extra = spec.mode === "exhaustive" ? Array.from({ length: EXHAUSTIVE_EXTRA_DELIVERED }, (_, index): DeliveredSpec => ({ file: `flows/suite-${String(index).padStart(2, "0")}.spec.ts` })) : [];
  return [DELIVERED_LEAD, DELIVERED_SIDEKICK, ...extra];
}

/* The worst case of a listing: the specs a run delivered, and the lines its suite had, when each is more than the listing shows of the group it falls in. Every spec carries the flow and the objective its lead declared, at the length of a long, real one, so that the groups are the longest the section can really have. */
const LARGE_DELIVERED_COUNT = LISTING_MAX_UNNAMED_EDITABLE + 10;
const LARGE_EXISTING_COUNT = LISTING_MAX_DO_NOT_REWRITE + 7;
const LARGE_AREAS = ["cart", "checkout", "account", "catalog", "search", "orders", "profile", "wishlist"] as const;

function largeSpec(folder: string, index: number): DeliveredSpec {
  const area = LARGE_AREAS[index % LARGE_AREAS.length]!;
  const id = String(index).padStart(2, "0");
  return {
    file: `${folder}/${area}-${id}.spec.ts`,
    flow: `${area} ${id}: a signed-in user changes the ${area} and sees it saved`,
    objective: `the ${area} page shows the saved change after it is reloaded`,
  };
}

const LARGE_DELIVERED: readonly DeliveredSpec[] = Array.from({ length: LARGE_DELIVERED_COUNT }, (_, index) => largeSpec("flows", index));
const LARGE_EXISTING: readonly string[] = Array.from({ length: LARGE_EXISTING_COUNT }, (_, index) => formatSuiteEntry(largeSpec("suite", index)));

/* The suite lines the grounding folded before the run, and the specs the run has delivered by the time a regeneration is built. */
function suiteLinesFor(spec: CellSpec): string[] | undefined {
  if (spec.suite === "large") return [...LARGE_EXISTING];
  return spec.suite === "listed" && (spec.mode === "diff" || spec.mode === "manual") ? ["flows/cart.spec.ts"] : undefined;
}

function deliveredSpecsFor(spec: CellSpec): DeliveredSpec[] | undefined {
  if (spec.suite === "large") return [...LARGE_DELIVERED];
  return spec.suite === "listed" && spec.phase !== "first" ? deliveredFor(spec) : undefined;
}

/* The step limit a cell of the OpenCode layer is assembled with. That runtime caps an agent's steps and reports the cap. */
export const MATRIX_STEP_LIMIT = 40;

/* The run_spec budget a granted cell is assembled with: the shipped defaults. */
export const MATRIX_CLOSED_LOOP = DEFAULT_CLOSED_LOOP_LIMITS;

/* The browser budget a granted cell is assembled with: the shipped defaults. */
export const MATRIX_AGENT_BROWSER = DEFAULT_AGENT_BROWSER_LIMITS;

/* The limits a planning cell is assembled with: the shipped defaults of the lead/sidekick mode. */
export const MATRIX_PLANNING = { maxFlows: DEFAULT_COORDINATION_SETTINGS.maxFlows, maxParallel: DEFAULT_COORDINATION_SETTINGS.maxParallel, budgetMs: DEFAULT_COORDINATION_SETTINGS.planBudgetMs };

/* The run input of a combination; `stepLimit` is the cap the runtime resolved for the generator, absent when it states none. */
export async function buildInput(spec: CellSpec, stepLimit?: number): Promise<OpencodeRunInput> {
  const isCode = spec.target === "code";
  const suiteLines = suiteLinesFor(spec);
  const deliveredSpecs = deliveredSpecsFor(spec);
  const input: OpencodeRunInput = {
    repo: "org/app",
    sha: "abc1234def",
    diff: DIFF,
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    target: spec.target,
    mode: spec.mode,
    appName: "shop",
    ...(isCode ? {} : { baseUrl: "http://localhost:3000" }),
    openapi: "api-definition.yaml",
    intent: {
      type: "feat",
      breaking: false,
      message: "feat(cart): show the discounted total",
      body: "Applies the coupon after the cart re-queries and shows the new total.",
      changedFiles: CHANGED_FILES,
    },
    ...(spec.mode === "manual" ? { guidance: "cover the coupon form on the cart page" } : {}),
    ...(suiteLines ? { existingSpecFiles: suiteLines } : {}),
    ...(deliveredSpecs ? { deliveredSpecs } : {}),
    ...(stepLimit !== undefined ? { stepLimit } : {}),
    ...(spec.closedLoop ? { closedLoop: MATRIX_CLOSED_LOOP } : {}),
    ...(spec.agentBrowser ? { agentBrowser: MATRIX_AGENT_BROWSER } : {}),
    ...(spec.planning ? { planning: MATRIX_PLANNING } : {}),
  };

  if (spec.grounding === "pack") {
    const pack = await buildPack(spec);
    if (pack) input.contextPack = pack;
  }
  if (spec.contextMap) input.contextMap = CONTEXT_MAP;
  if (spec.structuralSignal !== "none") {
    const shape = SIGNAL_SHAPES[spec.structuralSignal];
    input.staticSignal = renderBlastRadiusSignal(shape);
    if (hasSymbolBlocks(shape)) input.staticSignalHasSymbols = true;
  }
  if (spec.authSeedUnauthored) input.authSeedUnauthored = true;
  if (spec.serviceLinks) input.serviceLinks = SERVICE_LINKS;
  if (spec.harnessFacts) input.harnessFacts = HARNESS_FACTS;
  if (spec.service) input.service = SERVICE;
  if (spec.tree !== "none") {
    input.domSnapshot = TREE_TEXT;
    if (spec.tree === "failure") input.failureSourced = true;
  }

  switch (spec.phase) {
    case "regen-fix":
      input.fixCases = [{ name: "cart applies a coupon", status: "fail", detail: "locator.click: element not found", file: "flows/cart.spec.ts" }];
      break;
    case "regen-review":
      input.reviewCorrections = ["[fragile-selector] cart.spec.ts: scope the coupon button to the cart form"];
      break;
    case "regen-coverage":
      input.coverageGap = "src/app/cart/cart.service.ts: lines 10-14 were not executed";
      break;
    case "selector-fix":
      input.selectorContradictions = ["button:Apply is NOT in the captured tree; present roles: button:Apply coupon"];
      break;
    case "first":
      break;
  }
  return input;
}

/* ── the static layers the agent ships with ── */

/* The runtimes whose static role layer is linted. Add a member and its layer in loadStaticLayer to cover another runtime. */
export type StaticLayerName = "opencode";

/* The step limits a layer's prompt is assembled with: the cap the runtime reports, and none for a role it reports no cap for. */
const STEP_LIMITS_BY_LAYER: Readonly<Record<StaticLayerName, ReadonlyArray<number | undefined>>> = { opencode: [MATRIX_STEP_LIMIT, undefined] };

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/* The agent whose role prompt a cell's static layer holds: the lead on a planning turn, the author on every other. */
export type StaticLayerRole = "author" | "lead";

const ROLE_PROMPT_FILE: Readonly<Record<StaticLayerRole, string>> = { author: "qa-author.md", lead: "qa-lead.md" };

export function loadStaticLayer(layer: StaticLayerName, root: string = ROOT, role: StaticLayerRole = "author"): LintSection[] {
  const section = (id: string, text: string): LintSection => ({ id, layer: "static", text, claims: [] });
  return [
    section("opencode/AGENTS.md", readText(join(root, "agents", "AGENTS.md"))),
    section(`opencode/${ROLE_PROMPT_FILE[role]}`, readText(join(root, "agents", "agent", ROLE_PROMPT_FILE[role]))),
  ];
}

/* ── assembling a cell ── */

/* The assembler joins the surviving sections with one newline in a stable order, and reports each one's byte size in that same order. */
export function splitAssembledSections(assembled: AssembledPrompt): Array<{ id: string; text: string }> {
  const bytes = Buffer.from(assembled.text, "utf8");
  const out: Array<{ id: string; text: string }> = [];
  let offset = 0;
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    out.push({ id, text: bytes.subarray(offset, offset + size).toString("utf8") });
    offset += size + 1;
  }
  return out;
}

const VERBATIM_SECTION_IDS: ReadonlySet<string> = new Set(["diff"]);

export function assembledLintSections(assembled: AssembledPrompt): LintSection[] {
  return splitAssembledSections(assembled).map(({ id, text }) => ({
    id,
    layer: "assembled" as const,
    text,
    claims: assembled.claims[id] ?? [],
    ...(VERBATIM_SECTION_IDS.has(id) ? { verbatim: true } : {}),
    ...(id === HARNESS_FACTS_SECTION_ID || id === STEP_LIMIT_SECTION_ID || id === CLOSED_LOOP_SECTION_ID || id === AGENT_BROWSER_SECTION_ID ? { factsOnly: true } : {}),
  }));
}

export interface MatrixCell {
  key: string;
  name: string;
  layer: StaticLayerName;
  spec: CellSpec;
  /* The step limit the cell's prompt was assembled with; absent for a runtime that states none. */
  stepLimit?: number;
  /* The group of combinations that share a recorded budget. */
  bucket: string;
  lint: LintCell;
  assembledBytes: number;
  directives: number;
  staticBytes: number;
}

/* What follows the bucket of a cell whose prompt states a step limit. */
export const LIMIT_BUCKET_SUFFIX = "/limit";

/* Combinations that differ only in the small optional sections they carry share a budget: the largest of the group. The shapes that exclude one another, and the blocks that are large by themselves (the structural signal, the microservice change), stay in the key so they are budgeted apart. A pack that lists the page a redirect reached carries one more block, bounded by its own size: every such combination shares one budget, the largest of them, so growth of that block is caught, while the same prompts without it stay in their own tight buckets. */
function combinationBucket(spec: CellSpec): string {
  if (spec.packRedirect) return "redirect";
  return [
    spec.mode,
    spec.target,
    spec.phase,
    `tree-${spec.tree}`,
    spec.grounding,
    ...(spec.packDom ? [] : ["contracts-only"]),
    ...(spec.structuralSignal === "none" ? [] : [SIGNAL_FLAG[spec.structuralSignal]]),
    ...(spec.service ? ["service"] : []),
    ...(spec.suite === "none" ? ["no-suite"] : []),
    ...(spec.suite === "large" ? ["large-suite"] : []),
    ...(spec.closedLoop ? ["loop"] : []),
    ...(spec.agentBrowser ? ["browser"] : []),
    ...(spec.planning ? ["planning"] : []),
  ].join("/");
}

/* The bucket a combination's budget is recorded in. A prompt that states a step limit is budgeted apart from its twin without one, in the same bucket plus a suffix: the runtime that states no limit keeps the budgets it always had, and what the limit adds reads as a raise over its twin. */
export function bucketOf(spec: CellSpec, limited = false): string {
  return limited ? `${combinationBucket(spec)}${LIMIT_BUCKET_SUFFIX}` : combinationBucket(spec);
}

export interface CellMeasure {
  bytes: number;
  directives: number;
}

export function measureStatic(sections: readonly LintSection[]): number {
  return sections.filter((s) => s.layer === "static").reduce((sum, s) => sum + Buffer.byteLength(s.text, "utf8"), 0);
}

export function measureAssembled(sections: readonly LintSection[]): CellMeasure {
  const assembled = sections.filter((s) => s.layer === "assembled");
  return {
    bytes: assembled.reduce((sum, s) => sum + Buffer.byteLength(s.text, "utf8"), 0),
    directives: assembled.filter((s) => !s.verbatim).reduce((sum, s) => sum + countDirectives(s.text), 0),
  };
}

/* Every combination that can reach the agent is linted for contradictions and duplicates and measured against the budget recorded for its bucket. */
export async function buildMatrix(root: string = ROOT, specs: readonly CellSpec[] = allValidSpecs()): Promise<MatrixCell[]> {
  const layers: StaticLayerName[] = ["opencode"];
  const staticByLayer = new Map(layers.map((l) => [l, loadStaticLayer(l, root)] as const));
  const leadStaticByLayer = new Map(layers.map((l) => [l, loadStaticLayer(l, root, "lead")] as const));
  const cells: MatrixCell[] = [];
  for (const spec of specs) {
    for (const layer of layers) for (const stepLimit of STEP_LIMITS_BY_LAYER[layer]) {
      /* A cell is assembled from the input its runtime hands the prompt, and records the limit that input carries. */
      /* A prompt that states the run_spec budget, the browser budget or the plan contract is built for a role the runtime caps, so it always states the step limit. */
      if (stepLimit === undefined && (spec.closedLoop || spec.agentBrowser || spec.planning)) continue;
      const input = await buildInput(spec, stepLimit);
      const cellKey = `${cellName(spec)}|${layer}${stepLimit === undefined ? "|no-limit" : ""}`;
      const staticSections = (spec.planning ? leadStaticByLayer : staticByLayer).get(layer)!;
      /* Budget 0 disables shedding: the matrix measures the full prompt, independent of the model window catalog. */
      const assembled = buildPromptAssembled(input, { budgetBytes: 0 });
      const sections = assembledLintSections(assembled);
      const measure = measureAssembled(sections);
      cells.push({
        key: cellKey,
        name: cellName(spec),
        layer,
        spec,
        ...(input.stepLimit !== undefined ? { stepLimit: input.stepLimit } : {}),
        bucket: bucketOf(spec, input.stepLimit !== undefined),
        lint: { name: cellKey, regen: spec.phase !== "first", sections: [...staticSections, ...sections] },
        assembledBytes: measure.bytes,
        directives: measure.directives,
        staticBytes: measureStatic(staticSections),
      });
    }
  }
  return cells;
}

/* ── baseline ── */

export interface Baseline {
  globalUserPromptBytes: number;
  /* The largest user prompt and directive volume over every combination: no combination may exceed it. */
  ceiling: CellMeasure;
  /* The size of the role and shared-rule text each runtime ships with. */
  staticLayers: Record<StaticLayerName, number>;
  /* The largest user prompt and directive volume of each bucket of combinations: every combination that can reach the agent is checked against its bucket. A bucket with the limit suffix holds the cells whose prompt states a step limit; its twin without the suffix holds the cells of a runtime that states none. */
  buckets: Record<string, CellMeasure>;
  /* The reason the budgets were last raised and which ones; kept until the next raise. */
  lastIncrease?: { reason: string; budgets: string[] };
}

export function baselinePath(root: string = ROOT): string {
  return join(root, "scripts", "prompt-contract-baseline.json");
}

export function loadBaseline(root: string = ROOT): Baseline {
  return JSON.parse(readText(baselinePath(root))) as Baseline;
}

export interface RecordOptions {
  /* Why the budgets are being raised; recording a raise without one is refused. */
  increaseReason?: string;
}

export class BaselineIncreaseError extends Error {
  readonly budgets: readonly string[];
  constructor(raised: readonly BudgetRaise[]) {
    super(
      `recording would raise ${raised.length} budget(s) over the committed baseline: ${raised.map((r) => `${r.budget} ${r.from} -> ${r.to}`).join("; ")}. ` +
        `Shrink the prompt, or record with --allow-increase "<reason>".`,
    );
    this.budgets = raised.map((r) => r.budget);
  }
}

interface BudgetRaise {
  budget: string;
  from: number;
  to: number;
}

function measuresOf(name: string, from: CellMeasure | undefined, to: CellMeasure): BudgetRaise[] {
  if (!from) return [];
  return [
    ...(to.bytes > from.bytes ? [{ budget: `${name}:bytes`, from: from.bytes, to: to.bytes }] : []),
    ...(to.directives > from.directives ? [{ budget: `${name}:directives`, from: from.directives, to: to.directives }] : []),
  ];
}

/* What the committed baseline holds a bucket to: its own budget or, for a limited bucket it has not recorded yet, the budget its twin without a limit has there. The first record of the limited buckets is thus held to what their twins already carry, so whatever a prompt adds for the limit shows as a raise instead of arriving as a new bucket. */
function committedBudgetOf(committed: Baseline, bucket: string): CellMeasure | undefined {
  const own = committed.buckets[bucket];
  if (own !== undefined || !bucket.endsWith(LIMIT_BUCKET_SUFFIX)) return own;
  return committed.buckets[bucket.slice(0, -LIMIT_BUCKET_SUFFIX.length)];
}

/* Every budget the next baseline holds above the same budget in the committed one. A combination or layer the committed baseline does not know is new, not raised. */
function budgetRaises(committed: Baseline, next: Baseline): BudgetRaise[] {
  const layers = (Object.keys(next.staticLayers) as StaticLayerName[]).flatMap((layer) =>
    next.staticLayers[layer] > (committed.staticLayers[layer] ?? Infinity)
      ? [{ budget: `static:${layer}`, from: committed.staticLayers[layer]!, to: next.staticLayers[layer] }]
      : [],
  );
  return [
    ...Object.entries(next.buckets).flatMap(([bucket, measure]) => measuresOf(bucket, committedBudgetOf(committed, bucket), measure)),
    ...measuresOf("ceiling", committed.ceiling, next.ceiling),
    ...layers,
  ];
}

export function recordBaseline(cells: readonly MatrixCell[], committed?: Baseline, options: RecordOptions = {}): Baseline {
  const buckets: Record<string, CellMeasure> = {};
  for (const cell of cells) {
    const seen = buckets[cell.bucket];
    buckets[cell.bucket] = {
      bytes: Math.max(seen?.bytes ?? 0, cell.assembledBytes),
      directives: Math.max(seen?.directives ?? 0, cell.directives),
    };
  }
  /* The recorded size of a runtime's static layer is the generator's; a planning cell carries the lead's role prompt and is held to the same bound. */
  const staticLayers = Object.fromEntries(cells.filter((c) => !c.spec.planning).map((c) => [c.layer, c.staticBytes])) as Record<StaticLayerName, number>;
  const next: Baseline = {
    globalUserPromptBytes: GLOBAL_USER_PROMPT_BASELINE_BYTES,
    ceiling: {
      bytes: Math.max(...cells.map((c) => c.assembledBytes)),
      directives: Math.max(...cells.map((c) => c.directives)),
    },
    staticLayers: { opencode: staticLayers.opencode },
    buckets: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  const raises = committed ? budgetRaises(committed, next) : [];
  const reason = options.increaseReason?.trim();
  if (raises.length > 0) {
    if (!reason) throw new BaselineIncreaseError(raises);
    return { ...next, lastIncrease: { reason, budgets: raises.map((r) => r.budget) } };
  }
  return committed?.lastIncrease ? { ...next, lastIncrease: committed.lastIncrease } : next;
}

export function lintMatrixCell(cell: MatrixCell, baseline?: Baseline): readonly LintFinding[] {
  if (!baseline) return lintCell(cell.lint, { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES, artifactReferences: ARTIFACT_REFERENCES });
  const recorded = baseline.buckets[cell.bucket];
  /* A combination nobody recorded has no budget to hold it to; that is a failure to record it, never a reason to borrow the ceiling. */
  const unrecorded: LintFinding[] = recorded ? [] : [{ rule: "R9", sections: [], budget: "unrecorded" }];
  return [
    ...unrecorded,
    ...lintCell(cell.lint, {
      assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES,
      artifactReferences: ARTIFACT_REFERENCES,
      budget: {
        ...(recorded ? { maxAssembledBytes: Math.min(baseline.globalUserPromptBytes, recorded.bytes), maxDirectives: recorded.directives } : {}),
        maxStaticBytes: baseline.staticLayers[cell.layer],
      },
    }),
  ];
}

/* The unique finding keys across the matrix, each with the cells that produced it. */
export function collectFindings(
  cells: readonly MatrixCell[],
  baseline?: Baseline,
): Map<string, { finding: LintFinding; cells: string[] }> {
  const out = new Map<string, { finding: LintFinding; cells: string[] }>();
  for (const cell of cells) {
    for (const finding of lintMatrixCell(cell, baseline)) {
      const key = findingKey(finding);
      const entry = out.get(key) ?? { finding, cells: [] };
      entry.cells.push(cell.key);
      out.set(key, entry);
    }
  }
  return out;
}

/* ── digest pin ──
 * One sha256 per prompt of the matrix (every combination that can reach the agent, with and without a step limit, with no byte budget) and per reviewer
 * prompt of a fixed set of options. A digest covers everything an assembly returns: the text, the size of each section, its claims, its items, the files
 * the prompt provides and the hash of each section. The committed file holds the digests of the prompt builders as they stood before they became section
 * registries, so a change to how a prompt is declared that alters one byte of any of them fails prompt-contract-matrix.test.ts.
 * Record only when a prompt is meant to change, in the commit that changes it: tsx scripts/prompt-contract-matrix.ts --record-digests */

export const DIGESTS_PATH = join(ROOT, "scripts", "prompt-section-digests.txt");

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface DigestSet {
  keys: string[];
  digests: string[];
}

/* Everything an assembly returns, in a fixed shape. */
export function assemblyDigest(assembled: AssembledPrompt): string {
  return sha256(
    JSON.stringify({
      text: assembled.text,
      sectionOrder: Object.keys(assembled.sectionSizes),
      sectionSizes: assembled.sectionSizes,
      claims: assembled.claims,
      sectionItems: assembled.sectionItems,
      providedPaths: assembled.providedPaths,
      sectionHashes: assembled.sectionHashes,
      droppedSections: assembled.droppedSections,
      budgetBytes: assembled.budgetBytes,
    }),
  );
}

/* A prompt that states a tool budget or carries the plan contract is built for a role the runtime caps, so it exists only with a step limit. */
export async function matrixDigests(): Promise<DigestSet> {
  const set: DigestSet = { keys: [], digests: [] };
  for (const spec of allValidSpecs()) {
    for (const stepLimit of [MATRIX_STEP_LIMIT, undefined]) {
      if (stepLimit === undefined && (spec.closedLoop || spec.agentBrowser || spec.planning)) continue;
      const input = await buildInput(spec, stepLimit);
      set.keys.push(`generator|${cellName(spec)}|${stepLimit === undefined ? "no-limit" : "limit"}`);
      set.digests.push(assemblyDigest(buildPromptAssembled(input, { budgetBytes: 0 })));
    }
  }
  return set;
}

const REVIEW_MODES = ["diff", "complete", "exhaustive", "manual"] as const;
const REVIEW_TARGETS = ["e2e", "code"] as const;

/* A reviewer input whose spec contents together exceed the inline cap, written under `mirror`. */
export function overCapReviewerInput(mirror: string): ReviewInput {
  mkdirSync(join(mirror, "e2e", "flows"), { recursive: true });
  const specs = ["big-a.spec.ts", "big-b.spec.ts"].map((name) => `flows/${name}`);
  for (const spec of specs) writeFileSync(join(mirror, "e2e", spec), `import { test } from './fixtures';\n${"// padding line to grow the spec\n".repeat(700)}test('big', async () => {});\n`);
  return { diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const total = 1;\n", specs, mirrorDir: mirror, e2eRelDir: "e2e", appName: "shop", mode: "diff", target: "e2e", baseUrl: "http://localhost:3000" };
}

/* The reviewer prompts over every mode, target and combination of its six optional inputs; the step limit alternates. */
export function reviewerDigests(): DigestSet {
  const mirror = mkdtempSync(join(tmpdir(), "prompt-digests-"));
  try {
    mkdirSync(join(mirror, "e2e", "flows"), { recursive: true });
    writeFileSync(join(mirror, "e2e", "flows", "cart.spec.ts"), "import { test } from './fixtures';\ntest('applies a coupon', async () => {});\n");
    const set: DigestSet = { keys: [], digests: [] };
    let index = 0;
    for (const mode of REVIEW_MODES) for (const target of REVIEW_TARGETS) {
      for (let flags = 0; flags < 64; flags++, index++) {
        const has = (bit: number): boolean => (flags & (1 << bit)) !== 0;
        const input: ReviewInput = {
          diff: "diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1 @@\n+export const total = 1;\n",
          specs: ["flows/cart.spec.ts"],
          mirrorDir: mirror,
          e2eRelDir: "e2e",
          appName: "shop",
          mode,
          target,
          baseUrl: "http://localhost:3000",
          intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/cart.ts"] },
          ...(mode === "manual" ? { guidance: "cover the coupon form" } : {}),
          ...(has(0) ? { domSnapshot: "heading: Cart\nbutton: Apply coupon" } : {}),
          ...(has(1) ? { learnedRules: "## Learned rules\n- prefer getByRole" } : {}),
          ...(has(2) ? { priorCorrections: ["[fragile-selector] cart.spec.ts: scope the button"] } : {}),
          ...(has(3) ? { specChanges: "+ await expect(total).toBeVisible();" } : {}),
          ...(has(4) ? { executionResult: "## RUNTIME EXECUTION RESULT\n- applies a coupon" } : {}),
          ...(has(5) ? { existingSpecFiles: ["flows/other.spec.ts"] } : {}),
          ...(index % 2 === 0 ? { stepLimit: 30 } : {}),
        };
        set.keys.push(`reviewer|${mode}|${target}|${flags}|${index % 2 === 0 ? "limit" : "no-limit"}`);
        set.digests.push(assemblyDigest(buildReviewerPromptAssembled(input)));
      }
    }
    /* The specs together exceed the inline cap: the instruction and the specs section both send the reviewer to read the files. */
    set.keys.push("reviewer|over-cap");
    set.digests.push(assemblyDigest(buildReviewerPromptAssembled(overCapReviewerInput(mirror))));
    return set;
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

export async function currentDigests(): Promise<DigestSet> {
  const generator = await matrixDigests();
  const reviewer = reviewerDigests();
  return { keys: [...generator.keys, ...reviewer.keys], digests: [...generator.digests, ...reviewer.digests] };
}

/* The file is a header (how many prompts, and the hash of their ordered keys) and one digest per line. */
export function digestHeader(keys: readonly string[]): string {
  return `prompts=${keys.length} keys=${sha256(keys.join("\n"))}`;
}

export function loadDigests(path: string = DIGESTS_PATH): { header: string; digests: string[] } {
  const [header = "", ...digests] = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  return { header, digests };
}

/* ── the coordination prompts ──
 * The prompts the lead and its sidekicks are handed after the plan is made (the flow author's and the explore sidekick's briefs, the
 * lead's review, correction, re-plan and exploration turns) are assembled from registered sections like the generator's, so the same lint
 * holds them. Each is paired with the static role layer of the agent that reads it; a delegation brief is also held to its contract
 * (R17) and to what its turn grants (R18). Their budgets are recorded apart, in prompt-contract-coordination-baseline.json. */

export interface CoordinationCell {
  key: string;
  prompt: string;
  /* The agent whose role prompt the cell's static layer holds. */
  role: "qa-author" | "qa-explore" | "qa-lead";
  lint: LintCell;
  assembledBytes: number;
  directives: number;
  staticBytes: number;
}

export interface CoordinationBaseline {
  /* The largest user prompt and directive volume of each cell. */
  cells: Record<string, CellMeasure>;
  /* The size of the static layer each role ships with. */
  staticLayers: Record<string, number>;
  lastIncrease?: { reason: string; budgets: string[] };
}

export const coordinationBaselinePath = (root: string = ROOT): string => join(root, "scripts", "prompt-contract-coordination-baseline.json");

const MATRIX_REDACTION = { redact: (text: string): string => text } as unknown as RedactionPort;

/* The sections of an assembled coordination prompt, which the registry joins with a blank line. */
export function coordinationLintSections(assembled: AssembledPrompt): LintSection[] {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  return Object.entries(assembled.sectionSizes).map(([id, size]) => {
    const text = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 2;
    return { id, layer: "assembled" as const, text, claims: assembled.claims[id] ?? [] };
  });
}

function coordinationBriefs() {
  const scope = { readablePaths: ["."], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] };
  const author = (extra: Parameters<typeof createDelegationBrief>[0] extends infer I ? Partial<I> : never = {}) =>
    createDelegationBrief({ redaction: MATRIX_REDACTION, delegationId: "r1-d1", runId: "r1", objective: "the cart lists the items added to it", task: "Write the Playwright E2E spec for ONE flow.", scope, acceptanceCriteria: ["adding an item shows it in the cart"], tools: ["read", "write", "run_spec"], ...extra } as never);
  const explore = (tools: string[]) =>
    createDelegationBrief({ redaction: MATRIX_REDACTION, delegationId: "r1-explore-q1", runId: "r1", objective: "does the cart page list items?", task: "Answer ONE question for the lead, read-only.", scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] }, tools });
  return { author, explore };
}

function coordinationReviewFixtures() {
  const flow = { id: "cart", objective: "the cart lists items", acceptance: ["adding an item shows it"], outcome: { kind: "delivered" }, answer: { kind: "read", summary: "wrote it", concerns: [] }, runSpec: { calls: 2, maxCalls: 5, lastStatus: "passed" }, verified: true, sessionOpen: true, spec: "test('lists items', async () => {});" };
  const candidate = { id: "uc-00000001", entry: { kind: "page", route: "/cart" }, tier: "direct", basis: "graph", evidence: ["cart.ts::total"], seeds: [], changedFiles: [{ file: "src/cart.ts", addedLines: 4 }], confidence: 1, reachability: "page", pages: ["/cart"], existingSpecs: [] };
  const unchanged = [{ ...flow, answer: { kind: "unreadable" }, spec: undefined, specUnchanged: { sinceTurn: 1, sha256: "0123456789ab", lines: 1 } }] as never;
  return { candidate: candidate as never, unchanged, flows: [flow, { ...flow, id: "orders", verified: false, appDefect: "500 on /orders" }] as never, gaps: { required: [candidate], unvisited: [candidate], unproven: [], others: 1 } as never };
}

/* Every coordination prompt over the shapes that change what it carries. */
export function buildCoordinationMatrix(root: string = ROOT): CoordinationCell[] {
  const briefs = coordinationBriefs();
  const review = coordinationReviewFixtures();
  const correctionFlows = [{ id: "cart", objective: "the cart lists items", specFile: "flows/cart.spec.ts", sessionOpen: true, spec: "test('x', async () => {});", candidates: ["uc-00000001"], seedFiles: ["src/cart.ts"] }];
  const findings = [{ text: "flows/cart.spec.ts: the selector is not scoped", spec: "flows/cart.spec.ts" }, { text: "src/cart.ts:12 no test exercised this line", file: "src/cart.ts", line: 12 }];
  const outcome = { ran: true, questions: [{ id: "q1", question: "does the cart list items?", status: "answered", findings: [{ claim: "the cart lists items", kind: "page", ref: "/cart", evidence: "heading", verification: "verified" }] }, { id: "q2", question: "is there a coupon?", status: "failed", findings: [] }] };
  const prompts: Array<{ prompt: string; variant: string; role: CoordinationCell["role"]; assembled: AssembledPrompt; delegation?: DelegationGrant }> = [
    { prompt: "flow-author-brief", variant: "plain", role: "qa-author", assembled: assembleSidekickBrief(MATRIX_REDACTION, briefs.author()), delegation: { tools: ["read", "write", "run_spec"], writes: true } },
    {
      prompt: "flow-author-brief",
      variant: "full",
      role: "qa-author",
      assembled: assembleSidekickBrief(MATRIX_REDACTION, briefs.author({
        tools: ["read", "write", "run_spec", "authbrowser", "set_geolocation"],
        pages: "route /cart:\n  heading \"Cart\"",
        proofs: ["/cart: src/cart.ts::total > src/CartPage.ts::CartPage > page /cart"],
        candidates: [{ id: "uc-00000001", entry: "page /cart", tier: "direct", evidence: ["src/cart.ts::total"], symbols: ["src/cart.ts::total (lines 10-14)"], hunks: ["@@ -10 +10 @@\n-const total = 0;\n+const total = items.length;"], expectedFrom: [{ kind: "commit-message", ref: "feat(cart): show the item count" }] }],
        suite: ["flows/checkout.spec.ts: checkout completes"],
      })),
      delegation: { tools: ["read", "write", "run_spec", "authbrowser", "set_geolocation"], writes: true },
    },
    { prompt: "explore-brief", variant: "graph", role: "qa-explore", assembled: assembleExploreBrief(MATRIX_REDACTION, briefs.explore(["read", "codegraph"])), delegation: { tools: ["read", "codegraph"], writes: false } },
    { prompt: "explore-brief", variant: "graph-and-browser", role: "qa-explore", assembled: assembleExploreBrief(MATRIX_REDACTION, briefs.explore(["read", "codegraph", "authbrowser"])), delegation: { tools: ["read", "codegraph", "authbrowser"], writes: false } },
    { prompt: "lead-review", variant: "turn-1", role: "qa-lead", assembled: assembleLeadReview(MATRIX_REDACTION, review.flows, { turn: 1, maxTurns: 3 }) },
    { prompt: "lead-review", variant: "last-turn-with-gaps", role: "qa-lead", assembled: assembleLeadReview(MATRIX_REDACTION, review.flows, { turn: 3, maxTurns: 3 }, review.gaps) },
    ...(Object.values(CORRECTION_ORIGIN) as CorrectionOrigin[]).map((origin) => ({ prompt: "lead-correction", variant: origin, role: "qa-lead" as const, assembled: assembleLeadCorrection(MATRIX_REDACTION, correctionFlows, findings, origin) })),
    { prompt: "lead-review", variant: "unreadable-answer-unchanged-spec", role: "qa-lead", assembled: assembleLeadReview(MATRIX_REDACTION, review.unchanged, { turn: 2, maxTurns: 3 }) },
    { prompt: "lead-replan", variant: "refused-drop", role: "qa-lead", assembled: assembleReplanRequest(MATRIX_REDACTION, [review.candidate], [{ candidate: review.candidate, basis: "no-observable-change", why: "its changed code is executable" }] as never) },
    { prompt: "lead-feedback", variant: "plain", role: "qa-author", assembled: assembleSidekickFeedback(MATRIX_REDACTION, "Assert the total row, not the count.", "Respond with the SAME JSON output contract for delegationId=d runId=r.") },
    { prompt: "lead-correction-refused", variant: "plain", role: "qa-lead", assembled: assembleRefusedCorrection([{ flowId: "cart", finding: 3, reason: "the finding is not one of the turn's" }], 2) },
    { prompt: "lead-plan-rejected", variant: "malformed", role: "qa-lead", assembled: assembleRejectedPlanRequest("malformed", 4) },
    { prompt: "lead-explore-outcome", variant: "answered", role: "qa-lead", assembled: assembleExploreOutcome(MATRIX_REDACTION, outcome as never) },
  ];
  const staticByRole = new Map<CoordinationCell["role"], LintSection[]>();
  const staticOf = (role: CoordinationCell["role"]): LintSection[] => {
    if (!staticByRole.has(role)) {
      staticByRole.set(role, [
        { id: "opencode/AGENTS.md", layer: "static", text: readText(join(root, "agents", "AGENTS.md")), claims: [] },
        { id: `opencode/${role}.md`, layer: "static", text: readText(join(root, "agents", "agent", `${role}.md`)), claims: [] },
      ]);
    }
    return staticByRole.get(role)!;
  };
  return prompts.map(({ prompt, variant, role, assembled, delegation }) => {
    const sections = coordinationLintSections(assembled);
    const measure = measureAssembled(sections);
    const key = `${prompt}/${variant}`;
    return {
      key,
      prompt,
      role,
      lint: { name: key, regen: false, sections: [...staticOf(role), ...sections], ...(delegation ? { delegation } : {}) },
      assembledBytes: measure.bytes,
      directives: measure.directives,
      staticBytes: measureStatic(staticOf(role)),
    };
  });
}

export function loadCoordinationBaseline(root: string = ROOT): CoordinationBaseline {
  return JSON.parse(readText(coordinationBaselinePath(root))) as CoordinationBaseline;
}

export function recordCoordinationBaseline(cells: readonly CoordinationCell[], committed?: CoordinationBaseline, options: RecordOptions = {}): CoordinationBaseline {
  const next: CoordinationBaseline = {
    cells: Object.fromEntries(cells.map((c) => [c.key, { bytes: c.assembledBytes, directives: c.directives }]).sort(([a], [b]) => (a! < b! ? -1 : 1))),
    staticLayers: Object.fromEntries([...new Set(cells.map((c) => c.role))].sort().map((role) => [role, cells.find((c) => c.role === role)!.staticBytes])),
  };
  const raised = committed
    ? [
        ...Object.entries(next.cells).flatMap(([key, measure]) => measuresOf(key, committed.cells[key], measure)),
        ...Object.entries(next.staticLayers).flatMap(([role, bytes]) => (committed.staticLayers[role] !== undefined && bytes > committed.staticLayers[role]! ? [{ budget: `static:${role}`, from: committed.staticLayers[role]!, to: bytes }] : [])),
      ]
    : [];
  const reason = options.increaseReason?.trim();
  if (raised.length > 0) {
    if (!reason) throw new BaselineIncreaseError(raised);
    return { ...next, lastIncrease: { reason, budgets: raised.map((r) => r.budget) } };
  }
  return committed?.lastIncrease ? { ...next, lastIncrease: committed.lastIncrease } : next;
}

export function lintCoordinationCell(cell: CoordinationCell, baseline?: CoordinationBaseline): readonly LintFinding[] {
  const recorded = baseline?.cells[cell.key];
  const unrecorded: LintFinding[] = baseline && !recorded ? [{ rule: "R9", sections: [], budget: "unrecorded" }] : [];
  return [
    ...unrecorded,
    ...lintCell(cell.lint, {
      assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES,
      artifactReferences: ARTIFACT_REFERENCES,
      ...(baseline ? { budget: { ...(recorded ? { maxAssembledBytes: recorded.bytes, maxDirectives: recorded.directives } : {}), ...(baseline.staticLayers[cell.role] !== undefined ? { maxStaticBytes: baseline.staticLayers[cell.role]! } : {}) } } : {}),
    }),
  ];
}

async function main(): Promise<void> {
  if (process.argv.includes("--record-digests")) {
    const set = await currentDigests();
    writeFileSync(DIGESTS_PATH, [digestHeader(set.keys), ...set.digests, ""].join("\n"));
    console.log(`recorded ${set.digests.length} digests to ${DIGESTS_PATH}`);
    return;
  }
  if (process.argv.includes("--record-coordination")) {
    const flag = process.argv.indexOf("--allow-increase");
    const reason = flag >= 0 ? process.argv[flag + 1] : undefined;
    if (flag >= 0 && !reason?.trim()) throw new Error('--allow-increase needs a reason: --allow-increase "<why the budgets must grow>"');
    const committed = existsSync(coordinationBaselinePath()) ? loadCoordinationBaseline() : undefined;
    const baseline = recordCoordinationBaseline(buildCoordinationMatrix(), committed, reason ? { increaseReason: reason } : {});
    writeFileSync(coordinationBaselinePath(), JSON.stringify(baseline, null, 2) + "\n");
    console.log(`recorded ${Object.keys(baseline.cells).length} coordination budgets to ${coordinationBaselinePath()}`);
    return;
  }
  const cells = await buildMatrix();
  if (process.argv.includes("--record")) {
    const flag = process.argv.indexOf("--allow-increase");
    const reason = flag >= 0 ? process.argv[flag + 1] : undefined;
    if (flag >= 0 && !reason?.trim()) throw new Error('--allow-increase needs a reason: --allow-increase "<why the budgets must grow>"');
    const committed = existsSync(baselinePath()) ? loadBaseline() : undefined;
    const baseline = recordBaseline(cells, committed, reason ? { increaseReason: reason } : {});
    writeFileSync(baselinePath(), JSON.stringify(baseline, null, 2) + "\n");
    console.log(`recorded ${Object.keys(baseline.buckets).length} budgets over ${cells.length / 2} combinations to ${baselinePath()}`);
    return;
  }
  const findings = collectFindings(cells);
  for (const [key, { finding, cells: where }] of [...findings].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`${key}\t${finding.fact ?? ""}\t(${where.length} cells)`);
  }
  console.log(`${findings.size} unique findings over ${cells.length} cell/layer combinations`);
  const coordination = buildCoordinationMatrix();
  const recorded = existsSync(coordinationBaselinePath()) ? loadCoordinationBaseline() : undefined;
  const coordinationFindings = coordination.flatMap((cell) => lintCoordinationCell(cell, recorded).map((finding) => ({ cell: cell.key, finding })));
  for (const { cell, finding } of coordinationFindings) console.log(`${findingKey(finding)}\t${finding.fact ?? ""}\t(${cell})`);
  console.log(`${coordinationFindings.length} coordination findings over ${coordination.length} prompts`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
