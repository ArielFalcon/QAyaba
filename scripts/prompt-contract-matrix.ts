/*
 * Prompt-contract matrix: assembles the REAL generator prompt (real builders, the real shell brief
 * renderer, the real context-pack builder over fake capture deps) across the run shapes that can
 * reach the agent, pairs each with both static role layers (OpenCode and Codex) and lints every
 * combination. The lint lives in qa-engine; this module lives in scripts/ because it wires the
 * shell's brief renderer, which qa-engine may not import.
 *
 * Commands:
 *   tsx scripts/prompt-contract-matrix.ts              print the unique findings of the current tree
 *   tsx scripts/prompt-contract-matrix.ts --record     rewrite scripts/prompt-contract-baseline.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  ASSEMBLED_ARTIFACT_NAMES,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { buildContextPack, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { formatDomSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import {
  countDirectives,
  findingKey,
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
import { coerceExplorationBrief, parseExplorationBrief, renderExplorationBrief } from "../src/qa/exploration-brief.ts";
import { codexPreambleParts } from "../src/agent-runtime/codex-strategy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* The user prompt of the reference production run, in bytes, before any hygiene work: no cell may exceed it. */
export const GLOBAL_USER_PROMPT_BASELINE_BYTES = 20_083;

export const DIMENSIONS = {
  mode: ["diff", "complete", "exhaustive", "manual", "context"],
  phase: ["first", "regen-fix", "regen-review", "regen-coverage", "selector-fix"],
  tree: ["none", "failure", "live"],
  grounding: ["none", "brief", "pack", "brief+pack"],
  target: ["e2e", "code"],
  contextMap: [false, true],
  structuralSignal: [false, true],
  authSeedUnauthored: [false, true],
  serviceLinks: [false, true],
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
    if (isCode || spec.structuralSignal || spec.authSeedUnauthored || spec.serviceLinks) return false;
  }
  if (isCode) {
    if (spec.tree !== "none" || spec.contextMap || spec.authSeedUnauthored || spec.serviceLinks) return false;
    if (spec.grounding === "pack" || spec.grounding === "brief+pack") return false;
    if (spec.phase === "regen-coverage" || spec.phase === "selector-fix") return false;
  }
  if (spec.tree !== "none" && !regenWithTree) return false;
  if (spec.structuralSignal && (spec.grounding === "brief" || spec.grounding === "brief+pack")) return false;
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

type Pair = string;

/* Every pair of dimension values that co-occurs in at least one valid combination. */
export function pairsOf(spec: CellSpec): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < DIMENSION_NAMES.length; i++) {
    for (let j = i + 1; j < DIMENSION_NAMES.length; j++) {
      const a = DIMENSION_NAMES[i]!;
      const b = DIMENSION_NAMES[j]!;
      out.push(`${a}=${String(spec[a])}|${b}=${String(spec[b])}`);
    }
  }
  return out;
}

/* Deterministic greedy all-pairs cover of the valid combinations: each pick takes the combination covering the most still-uncovered pairs (first in enumeration order on ties). */
export function pairwiseSpecs(): CellSpec[] {
  const candidates = allValidSpecs();
  const uncovered = new Set<Pair>(candidates.flatMap(pairsOf));
  const picked: CellSpec[] = [];
  while (uncovered.size > 0) {
    let best: CellSpec | undefined;
    let bestGain = 0;
    for (const candidate of candidates) {
      const gain = pairsOf(candidate).filter((p) => uncovered.has(p)).length;
      if (gain > bestGain) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (!best) break;
    picked.push(best);
    for (const p of pairsOf(best)) uncovered.delete(p);
  }
  return picked;
}

export function cellName(spec: CellSpec): string {
  const flags = [
    spec.contextMap ? "map" : "",
    spec.structuralSignal ? "signal" : "",
    spec.authSeedUnauthored ? "login" : "",
    spec.serviceLinks ? "links" : "",
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

const packDeps: ContextPackDeps = {
  captureDomForRoutes: async () => TREE_TEXT,
  domDeps: { render: async () => [] },
  log: () => {},
};

const CHANGED_FILES = ["src/app/cart/cart.service.ts", "src/app/cart/cart.component.ts"];

async function buildPack(spec: CellSpec): Promise<string | undefined> {
  const { text } = await buildContextPack(
    {
      ...(spec.grounding === "brief+pack" ? { brief: BRIEF } : {}),
      ...(spec.contextMap ? { contextMap: CONTEXT_MAP } : {}),
      baseUrl: "http://localhost:3000",
      e2eDir: "/mirrors/org__app/e2e",
      prChangedFiles: CHANGED_FILES,
      routes: ["/cart"],
    },
    packDeps,
  );
  return text;
}

const STRUCTURAL_SIGNAL = renderBlastRadiusSignal({
  impacted: [{ symbol: "CartService.applyCoupon", file: "src/app/cart/cart.service.ts" }],
  callers: [{ symbol: "CartComponent.onApply", file: "src/app/cart/cart.component.ts" }],
  coupled: [],
});

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

  if (spec.grounding === "brief" || spec.grounding === "brief+pack") input.contextBrief = BRIEF;
  if (spec.grounding === "pack" || spec.grounding === "brief+pack") {
    const pack = await buildPack(spec);
    if (pack) input.contextPack = pack;
  }
  if (spec.contextMap) input.contextMap = CONTEXT_MAP;
  if (spec.structuralSignal) input.staticSignal = STRUCTURAL_SIGNAL;
  if (spec.authSeedUnauthored) input.authSeedUnauthored = true;
  if (spec.serviceLinks) input.serviceLinks = SERVICE_LINKS;
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
  }));
}

export interface MatrixCell {
  key: string;
  name: string;
  layer: StaticLayerName;
  spec: CellSpec;
  /* Part of the pairwise reference set whose sizes are recorded one by one in the baseline. */
  reference: boolean;
  lint: LintCell;
  assembledBytes: number;
  directives: number;
}

export interface CellMeasure {
  bytes: number;
  directives: number;
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

/* Every combination that can reach the agent is linted for contradictions and duplicates; a pairwise cover of them is the reference set whose sizes are recorded one by one. */
export async function buildMatrix(root: string = ROOT): Promise<MatrixCell[]> {
  wireShellBriefRenderer();
  const layers: StaticLayerName[] = ["opencode", "codex"];
  const staticByLayer = new Map(layers.map((l) => [l, loadStaticLayer(l, root)] as const));
  const referenceNames = new Set(pairwiseSpecs().map(cellName));
  const cells: MatrixCell[] = [];
  for (const spec of allValidSpecs()) {
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
        reference: referenceNames.has(cellName(spec)),
        lint: { name: `${cellName(spec)}|${layer}`, regen: spec.phase !== "first", sections: [...staticByLayer.get(layer)!, ...sections] },
        assembledBytes: measure.bytes,
        directives: measure.directives,
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
  /* Per-cell sizes of the pairwise reference set. */
  cells: Record<string, CellMeasure>;
}

export function baselinePath(root: string = ROOT): string {
  return join(root, "scripts", "prompt-contract-baseline.json");
}

export function loadBaseline(root: string = ROOT): Baseline {
  return JSON.parse(readText(baselinePath(root))) as Baseline;
}

export function recordBaseline(cells: readonly MatrixCell[]): Baseline {
  const byName: Record<string, CellMeasure> = {};
  for (const cell of cells) {
    if (cell.reference) byName[cell.name] = { bytes: cell.assembledBytes, directives: cell.directives };
  }
  const sorted = Object.fromEntries(Object.entries(byName).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    globalUserPromptBytes: GLOBAL_USER_PROMPT_BASELINE_BYTES,
    ceiling: {
      bytes: Math.max(...cells.map((c) => c.assembledBytes)),
      directives: Math.max(...cells.map((c) => c.directives)),
    },
    cells: sorted,
  };
}

export function lintMatrixCell(cell: MatrixCell, baseline?: Baseline): readonly LintFinding[] {
  const recorded = baseline ? (baseline.cells[cell.name] ?? baseline.ceiling) : undefined;
  return lintCell(cell.lint, {
    assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES,
    ...(baseline && recorded
      ? {
          budget: {
            maxAssembledBytes: Math.min(baseline.globalUserPromptBytes, recorded.bytes),
            maxDirectives: recorded.directives,
          },
        }
      : {}),
  });
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
    writeFileSync(baselinePath(), JSON.stringify(recordBaseline(cells), null, 2) + "\n");
    console.log(`recorded the baseline of ${cells.filter((c) => c.reference).length / 2} reference cells (${cells.length / 2} combinations) to ${baselinePath()}`);
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
