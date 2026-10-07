/*
 * Prompt-contract matrix: assembles the REAL generator prompt (real builders, the real shell brief
 * renderer, the real context-pack builder over fake capture deps) across the run shapes that can
 * reach the agent, pairs each with both static role layers (OpenCode and Codex) and lints every
 * combination. The lint lives in qa-engine; this module lives in scripts/ because it wires the
 * shell's brief renderer, which qa-engine may not import.
 *
 * Every combination is budgeted: its user-prompt bytes and directive volume against the largest
 * recorded for its bucket (mode, target, phase, tree and grounding), and each static layer against
 * its recorded size. The baseline only tightens: recording refuses any raise over the committed one
 * unless a reason is given, and the reason is kept in the file.
 *
 * Commands:
 *   tsx scripts/prompt-contract-matrix.ts                                    print the unique findings of the current tree
 *   tsx scripts/prompt-contract-matrix.ts --record                           rewrite scripts/prompt-contract-baseline.json
 *   tsx scripts/prompt-contract-matrix.ts --record --allow-increase "<why>"  the same, raising budgets for the stated reason
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  ASSEMBLED_ARTIFACT_NAMES,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { buildContextPack, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { formatDomCapture, formatDomSnapshot, type RouteSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { hasSymbolBlocks, renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import {
  countDirectives,
  findingKey,
  HARNESS_FACTS_SECTION_ID,
  lintCell,
  type LintCell,
  type LintFinding,
  type LintSection,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import type {
  ArchitectureContext,
  ExplorationBrief,
  OpencodeRunInput,
} from "@contexts/generation/application/ports/generation-ports.ts";
import type { ServiceLink } from "@contexts/service-topology/domain/index.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import type { HarnessFacts } from "@contexts/generation/domain/harness-facts.ts";
import { coerceExplorationBrief, parseExplorationBrief, renderExplorationBrief } from "../src/qa/exploration-brief.ts";
import { codexPreambleParts } from "../src/agent-runtime/codex-strategy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* The user prompt of the reference production run, in bytes, before any hygiene work: no cell may exceed it. The baseline file repeats it and a test keeps the two equal. */
export const GLOBAL_USER_PROMPT_BASELINE_BYTES = 20_083;

export const DIMENSIONS = {
  mode: ["diff", "complete", "exhaustive", "manual", "context"],
  phase: ["first", "regen-fix", "regen-review", "regen-coverage", "selector-fix"],
  tree: ["none", "failure", "live"],
  grounding: ["none", "brief", "pack", "brief+pack"],
  target: ["e2e", "code"],
  contextMap: [false, true],
  /* What the structural signal holds: nothing, symbol blocks (impacted symbols and callers), or co-change files alone, which are no blast radius. */
  structuralSignal: ["none", "symbols", "co-change"],
  authSeedUnauthored: [false, true],
  serviceLinks: [false, true],
  harnessFacts: [false, true],
  /* Whether the brief distilled any blast radius. */
  briefBlast: ["filled", "empty"],
  /* Whether the pack captured a live DOM; without one it holds the contracts alone. */
  packDom: [true, false],
  /* Whether a gated route redirected, so the pack lists the page it reached as a section of its own; only a pack with a captured DOM can. */
  packRedirect: [false, true],
  /* The change belongs to a microservice rather than to the frontend repo. */
  service: [false, true],
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
    if (spec.grounding === "pack" || spec.grounding === "brief+pack") return false;
    if (spec.phase === "selector-fix") return false;
  }
  if (spec.tree !== "none" && !regenWithTree) return false;
  const hasBrief = spec.grounding === "brief" || spec.grounding === "brief+pack";
  const hasPack = spec.grounding === "pack" || spec.grounding === "brief+pack";
  /* The structural signal stands in only for a brief that distilled no blast radius. */
  if (spec.structuralSignal !== "none" && hasBrief && spec.briefBlast === "filled") return false;
  /* A signal of co-change files alone bears on one decision, whether the prompt carries an explored blast radius, and the optional blocks do not change it: it meets every phase, tree and grounding of a diff run (the only run that has a signal at all), but not their cross product with the blocks. */
  if (
    spec.structuralSignal === "co-change" &&
    (spec.mode !== "diff" || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks || spec.harnessFacts || spec.service || spec.packRedirect)
  ) {
    return false;
  }
  if (spec.briefBlast === "empty" && !hasBrief) return false;
  /* A pack without a DOM is the contracts alone, which the architecture map supplies. */
  if (spec.packDom === false && !(hasPack && spec.contextMap)) return false;
  if (spec.packRedirect && !(hasPack && spec.packDom)) return false;
  /* The service block belongs to the diff-shaped first pass and to every regeneration of an e2e run. */
  if (spec.service && (isContext || (spec.mode !== "diff" && spec.phase === "first"))) return false;
  return true;
}

function* everySpec(): Generator<CellSpec> {
  const walk = function* (index: number, partial: Partial<Record<DimensionName, unknown>>): Generator<CellSpec> {
    const name = DIMENSION_NAMES[index];
    if (name === undefined) {
      yield partial as unknown as CellSpec;
      return;
    }
    for (const value of DIMENSIONS[name] as readonly unknown[]) yield* walk(index + 1, { ...partial, [name]: value });
  };
  yield* walk(0, {});
}

export function allValidSpecs(): CellSpec[] {
  return [...everySpec()].filter(isValidSpec);
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
    spec.briefBlast === "empty" ? "noblast" : "",
    spec.packDom ? "" : "nodom",
    spec.packRedirect ? "redirect" : "",
    spec.service ? "service" : "",
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

const BRIEF: ExplorationBrief = {
  builtForSha: "abc1234def",
  objective: "the discounted total shows after the cart re-queries",
  blastRadius: [
    { symbol: "CartService.applyCoupon", file: "src/app/cart/cart.service.ts", role: "posts the coupon and returns the new total" },
    { symbol: "CartComponent.total", file: "src/app/cart/cart.component.ts", role: "renders the discounted total" },
  ],
  feBe: [{ route: "/cart", operationId: "applyCoupon", via: "CartClient.applyCoupon" }],
  contracts: [{ operationId: "applyCoupon", method: "POST", path: "/cart/coupon", fields: ["code"], errors: ["404 unknown coupon"] }],
  routes: [{ path: "/cart", component: "CartComponent", domLandmarks: ["button Apply coupon"], verified: false }],
  risks: ["assert the discounted total, not only that the request succeeded"],
  notes: "the coupon is applied server-side",
};

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

const briefFor = (spec: CellSpec): ExplorationBrief => (spec.briefBlast === "empty" ? { ...BRIEF, blastRadius: [] } : BRIEF);

async function buildPack(spec: CellSpec): Promise<string | undefined> {
  const capture = !spec.packDom ? undefined : spec.packRedirect ? REDIRECT_TEXT : TREE_TEXT;
  const deps: ContextPackDeps = { ...packDeps, captureDomForRoutes: async () => capture };
  const { text } = await buildContextPack(
    {
      ...(spec.grounding === "brief+pack" ? { brief: briefFor(spec) } : {}),
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

export async function buildInput(spec: CellSpec): Promise<OpencodeRunInput> {
  const isCode = spec.target === "code";
  const input: OpencodeRunInput = {
    repo: "org/app",
    sha: "abc1234def",
    diff: DIFF,
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
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
    ...(spec.mode === "diff" || spec.mode === "manual" ? { existingSpecFiles: ["flows/cart.spec.ts"] } : {}),
  };

  if (spec.grounding === "brief" || spec.grounding === "brief+pack") input.contextBrief = briefFor(spec);
  if (spec.grounding === "pack" || spec.grounding === "brief+pack") {
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
      input.fixCases = [{ name: "cart applies a coupon", status: "fail", detail: "locator.click: element not found" }];
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

export type StaticLayerName = "opencode" | "codex";

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function loadStaticLayer(layer: StaticLayerName, root: string = ROOT): LintSection[] {
  const section = (id: string, text: string): LintSection => ({ id, layer: "static", text, claims: [] });
  if (layer === "opencode") {
    return [
      section("opencode/AGENTS.md", readText(join(root, "agents", "AGENTS.md"))),
      section("opencode/qa-generator.md", readText(join(root, "agents", "agent", "qa-generator.md"))),
    ];
  }
  const parts = codexPreambleParts("primary", join(root, "agent"));
  return [
    section("codex/AGENTS.md", parts.shared),
    section("codex/qa-generator.md", parts.rolePrompt),
    ...parts.skills.map((s) => section(`codex/skill-${s.name}`, s.body)),
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
    ...(id === HARNESS_FACTS_SECTION_ID ? { factsOnly: true } : {}),
  }));
}

export interface MatrixCell {
  key: string;
  name: string;
  layer: StaticLayerName;
  spec: CellSpec;
  /* The group of combinations that share a recorded budget. */
  bucket: string;
  lint: LintCell;
  assembledBytes: number;
  directives: number;
  staticBytes: number;
}

/* Combinations that differ only in the small optional sections they carry share a budget: the largest of the group. The shapes that exclude one another, and the blocks that are large by themselves (the structural signal, the microservice change), stay in the key so they are budgeted apart. A pack that lists the page a redirect reached carries one more block, bounded by its own size: every such combination shares one budget, the largest of them, so growth of that block is caught, while the same prompts without it stay in their own tight buckets. */
export function bucketOf(spec: CellSpec): string {
  if (spec.packRedirect) return "redirect";
  return [
    spec.mode,
    spec.target,
    spec.phase,
    `tree-${spec.tree}`,
    spec.grounding,
    ...(spec.briefBlast === "empty" ? ["no-blast"] : []),
    ...(spec.packDom ? [] : ["contracts-only"]),
    ...(spec.structuralSignal === "none" ? [] : [SIGNAL_FLAG[spec.structuralSignal]]),
    ...(spec.service ? ["service"] : []),
  ].join("/");
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

let briefWired = false;
function wireShellBriefRenderer(): void {
  if (briefWired) return;
  setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });
  briefWired = true;
}

/* Every combination that can reach the agent is linted for contradictions and duplicates and measured against the budget recorded for its bucket. */
export async function buildMatrix(root: string = ROOT, specs: readonly CellSpec[] = allValidSpecs()): Promise<MatrixCell[]> {
  wireShellBriefRenderer();
  const layers: StaticLayerName[] = ["opencode", "codex"];
  const staticByLayer = new Map(layers.map((l) => [l, loadStaticLayer(l, root)] as const));
  const cells: MatrixCell[] = [];
  for (const spec of specs) {
    const input = await buildInput(spec);
    /* Budget 0 disables shedding: the matrix measures the full prompt, independent of the model window catalog. */
    const assembled = buildPromptAssembled(input, { budgetBytes: 0 });
    const sections = assembledLintSections(assembled);
    const measure = measureAssembled(sections);
    for (const layer of layers) {
      cells.push({
        key: `${cellName(spec)}|${layer}`,
        name: cellName(spec),
        layer,
        spec,
        bucket: bucketOf(spec),
        lint: { name: `${cellName(spec)}|${layer}`, regen: spec.phase !== "first", sections: [...staticByLayer.get(layer)!, ...sections] },
        assembledBytes: measure.bytes,
        directives: measure.directives,
        staticBytes: measureStatic(staticByLayer.get(layer)!),
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
  /* The largest user prompt and directive volume of each bucket of combinations: every combination that can reach the agent is checked against its bucket. */
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

/* Every budget the next baseline holds above the same budget in the committed one. A combination or layer the committed baseline does not know is new, not raised. */
function budgetRaises(committed: Baseline, next: Baseline): BudgetRaise[] {
  const layers = (Object.keys(next.staticLayers) as StaticLayerName[]).flatMap((layer) =>
    next.staticLayers[layer] > (committed.staticLayers[layer] ?? Infinity)
      ? [{ budget: `static:${layer}`, from: committed.staticLayers[layer]!, to: next.staticLayers[layer] }]
      : [],
  );
  return [
    ...Object.entries(next.buckets).flatMap(([bucket, measure]) => measuresOf(bucket, committed.buckets[bucket], measure)),
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
  const staticLayers = Object.fromEntries(cells.map((c) => [c.layer, c.staticBytes])) as Record<StaticLayerName, number>;
  const next: Baseline = {
    globalUserPromptBytes: GLOBAL_USER_PROMPT_BASELINE_BYTES,
    ceiling: {
      bytes: Math.max(...cells.map((c) => c.assembledBytes)),
      directives: Math.max(...cells.map((c) => c.directives)),
    },
    staticLayers: { opencode: staticLayers.opencode, codex: staticLayers.codex },
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

async function main(): Promise<void> {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
