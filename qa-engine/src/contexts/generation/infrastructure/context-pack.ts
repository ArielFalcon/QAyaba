/* Deterministic pre-generation context pack (DOM + explorer brief + contracts). Read-only on watched repos. Every component is fail-open: a failed piece yields an absent section, never a crashed run. */

import { sanitizeText } from "./sanitize-text.ts";
import { capDomLines, captureDomForRoutes, defaultCaptureDomDeps } from "./dom-snapshot.ts";
import type { CaptureDomDeps } from "./dom-snapshot.ts";
import type { ExplorationBrief, ArchitectureContext, ApiOperation } from "../application/ports/generation-ports.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";
import { claim, type FactId, type PromptClaim } from "../domain/prompt-contract-lint.ts";
import { PACK_HEADINGS } from "../domain/prompt-headings.ts";

export { PACK_HEADINGS };

const SECTION_FACTS: ReadonlyArray<readonly [string, FactId]> = [
  [PACK_HEADINGS.blastRadius, "blast-radius"],
  [PACK_HEADINGS.feBe, "fe-be-links"],
  [PACK_HEADINGS.risks, "risks"],
  [PACK_HEADINGS.liveDom, "dom-live"],
  [PACK_HEADINGS.contracts, "api-operations"],
];

const escapeRegExp = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The pack reaches the prompt as an already-built string, so its claims come from the sections it actually rendered: a pack with only a DOM provides only the DOM. The live DOM's own heading labels it ground truth, so that is the one fact the pack frames. */
export function deriveClaimsFromPackText(text: string): PromptClaim[] {
  const claims: PromptClaim[] = [];
  for (const [heading, fact] of SECTION_FACTS) {
    if (!new RegExp(`^### ${escapeRegExp(heading)}`, "m").test(text)) continue;
    claims.push(claim.provides(fact));
    if (fact === "dom-live") claims.push(claim.frames(fact, "established"));
  }
  return claims;
}


export interface ContextPackInput {
  brief?: ExplorationBrief;

  baseUrl?: string;

  e2eDir?: string;

  contextMap?: ArchitectureContext;

  prChangedFiles?: string[];

  /* Diff/guidance selector signals forwarded to formatDomSnapshot for [CHANGED: …] annotation. Absent/empty → no annotation. */
  changedElements?: ChangedElement[];

  /* Selector grounding: the config-declared test-id convention (e.g. "data-cy"), forwarded to captureDomForRoutes so the DOM capture queries the right attribute and the agent transcribes real test-ids instead of guessing. Absent → capture defaults to "data-testid". */
  testIdAttribute?: string;

  /* Before this field, candidateRoutes was populated ONLY from a brief (briefRoutePaths / contextMapRoutes gated on brief.feBe) — with the explorer pass unwired by design in production, there was NO brief-less route path at all, so the pack was structurally empty on every real run. */
  routes?: string[];
}

export interface ContextPackAssembly {
  text: string | undefined;

  domBytes: number;
  contractBytes: number;
}

export interface ContextPackDeps {
  captureDomForRoutes(
    routes: string[],
    input: { e2eDir: string; baseUrl?: string; testIdAttribute?: string },
    domDeps: CaptureDomDeps,
    changed?: ChangedElement[],
  ): Promise<string | undefined>;
  domDeps: CaptureDomDeps;
  log?: (msg: string) => void;
}


export const defaultContextPackDeps: ContextPackDeps = {
  captureDomForRoutes,
  domDeps: defaultCaptureDomDeps,
  log: (msg) => console.log(msg),
};


const DOM_BUDGET_BYTES = 30_000;

const BYTES_PER_CHAR = 1;


function filterRelevantContracts(
  contextMap: ArchitectureContext | undefined,
  brief: ExplorationBrief | undefined,
  prChangedFiles: string[] | undefined,
): ApiOperation[] {
  if (!contextMap || !contextMap.api?.length) return [];

  const relevantIds = new Set<string>();

  if (brief?.feBe?.length) {
    for (const link of brief.feBe) {
      if (link.operationId) relevantIds.add(link.operationId);
    }
  }

  if (brief?.contracts?.length) {
    for (const c of brief.contracts) {
      if (c.operationId) relevantIds.add(c.operationId);
    }
  }

  if (prChangedFiles?.length && contextMap.feBe?.length) {
    for (const link of contextMap.feBe) {
      const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
      if (prChangedFiles.some((f) => terms.some((t) => f.includes(t)))) {
        relevantIds.add(link.operationId);
      }
    }
  }

  if (relevantIds.size === 0) return [];
  return contextMap.api.filter((op) => relevantIds.has(op.operationId)).slice(0, 50);
}


const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;

function renderContracts(ops: ApiOperation[]): string {
  if (!ops.length) return "";
  const lines: string[] = [`### ${PACK_HEADINGS.contracts} (from context.json — assert these at the boundary)`];
  for (const op of ops) {
    lines.push(`- \`${s(op.operationId)}\`: ${s(op.method)} ${s(op.path)}${op.service ? ` (${s(op.service)})` : ""}`);
  }
  return lines.join("\n");
}


/* The pack without one of its sections, for a caller that supplies that content fresher elsewhere. `undefined` when no section remains: a header with nothing under it is no pack. */
export function withoutPackSection(text: string, heading: string): string | undefined {
  const start = new RegExp(`^### ${escapeRegExp(heading)}`);
  const kept: string[] = [];
  let skipping = false;
  let removed = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("### ")) skipping = start.test(line);
    if (skipping) removed = true;
    else kept.push(line);
  }
  if (!removed) return text;
  if (!kept.some((line) => line.startsWith("### "))) return undefined;
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

export async function buildContextPack(
  input: ContextPackInput,
  deps: ContextPackDeps,
): Promise<ContextPackAssembly> {
  const log = deps.log ?? (() => {});
  const domBudgetChars = Math.floor(DOM_BUDGET_BYTES / BYTES_PER_CHAR);

  const DOM_ROUTE_CAP = 6;
  let domSection = "";
  const briefRoutePaths = new Set<string>(
    (input.brief?.routes ?? [])
      .filter((r) => r.path)
      .map((r) => r.path),
  );
  const contextMapRoutes = new Set<string>();
  if (input.contextMap?.feBe?.length && input.brief?.feBe?.length) {
    const briefOps = new Set(input.brief.feBe.map((l) => l.operationId));
    for (const link of input.contextMap.feBe) {
      if (briefOps.has(link.operationId) && link.route) contextMapRoutes.add(link.route);
    }
  }
  const deterministicRoutes = new Set<string>(input.routes ?? []);
  const candidateRoutes = [...briefRoutePaths, ...contextMapRoutes, ...deterministicRoutes].filter(Boolean);
  const briefRoutes = candidateRoutes.slice(0, DOM_ROUTE_CAP);
  if (briefRoutes.length > 0 && input.e2eDir && input.baseUrl) {
    try {
      const rawCaptured = await deps.captureDomForRoutes(briefRoutes, { e2eDir: input.e2eDir, baseUrl: input.baseUrl, testIdAttribute: input.testIdAttribute }, deps.domDeps, input.changedElements);
      const raw = rawCaptured ? sanitizeText(rawCaptured, "model").text : rawCaptured;
      if (raw) {
        const lines = raw.split("\n");
        const maxLines = Math.max(10, Math.floor(domBudgetChars / 60));
        const { kept, dropped } = capDomLines(lines, maxLines);
        domSection = [
          `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
          "These roles + accessible names are what the browser ACTUALLY exposes.",
          "Author selectors ONLY from what appears here — if a role is absent, it is NOT in the tree.",
          kept.join("\n"),
          ...(dropped > 0 ? [`(${dropped} non-priority element(s) omitted — see the full tree with the Playwright MCP if needed)`] : []),
        ].join("\n");
        log(`[qa] context-pack: DOM captured ${kept.length} lines for ${briefRoutes.length} route(s)${dropped > 0 ? ` (${dropped} omitted)` : ""}`);
      } else {
        log(`[qa] context-pack: DOM capture returned nothing for routes [${briefRoutes.join(", ")}] — grounding skipped`);
      }
    } catch (err) {
      log(`[qa] context-pack: DOM capture FAILED (${err instanceof Error ? err.message : String(err)}) — grounding skipped`);
    }
  }

  let contractSection = "";
  const relevantOps = filterRelevantContracts(input.contextMap, input.brief, input.prChangedFiles);
  if (relevantOps.length > 0) {
    contractSection = renderContracts(relevantOps);
    log(`[qa] context-pack: ${relevantOps.length} relevant API contract(s) included`);
  }

  const domBytes = Buffer.byteLength(domSection, "utf8");
  const contractBytes = Buffer.byteLength(contractSection, "utf8");

  const parts = [domSection, contractSection].filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { text: undefined, domBytes: 0, contractBytes: 0 };
  }

  /* The header names the sections the pack actually rendered: a pack with no DOM never mentions one. */
  const held = [
    ...(domSection ? ["the live DOM of the routes it covers"] : []),
    ...(contractSection ? ["the API contracts relevant to this objective"] : []),
  ].join(" and ");
  const packHeader = [
    `## ${PACK_HEADINGS.pack} (pushed by the orchestrator before the first write)`,
    "",
    "The orchestrator built this pack deterministically before this session started.",
    `It holds ${held}.`,
    "",
  ].join("\n");

  const text = packHeader + parts.join("\n\n");
  return { text, domBytes, contractBytes };
}
