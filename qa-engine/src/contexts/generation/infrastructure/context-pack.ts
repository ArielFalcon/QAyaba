/* Deterministic pre-generation context pack (DOM + explorer brief + contracts). Read-only on watched repos. Every component is fail-open: a failed piece yields an absent section, never a crashed run. */

import { sanitizeText } from "./sanitize-text.ts";
import { capDomLines, captureDomForRoutes, defaultCaptureDomDeps } from "./dom-snapshot.ts";
import type { CaptureDomDeps } from "./dom-snapshot.ts";
import type { ExplorationBrief, ArchitectureContext, ApiOperation } from "../application/ports/generation-ports.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";


export interface ContextPackInput {
  brief?: ExplorationBrief;

  baseUrl?: string;

  e2eDir?: string;

  contextMap?: ArchitectureContext;

  prChangedFiles?: string[];

  /* Diff/guidance selector signals forwarded to formatDomSnapshot for [CHANGED: …] annotation. Absent/empty → no annotation. */
  changedElements?: ChangedElement[];

  /* Pillar 1 (selector grounding): the config-declared test-id convention (e.g. "data-cy"), forwarded to captureDomForRoutes so the DOM capture queries the right attribute and the agent transcribes real test-ids instead of guessing. Absent → capture defaults to "data-testid". */
  testIdAttribute?: string;

  /* Before this field, candidateRoutes was populated ONLY from a brief (briefRoutePaths / contextMapRoutes gated on brief.feBe) — with the explorer pass unwired by design in production, there was NO brief-less route path at all, so the pack was structurally empty on every real run. */
  routes?: string[];
}

export interface ContextPackAssembly {
  text: string | undefined;

  blastRadiusBytes: number;
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

function renderBlastRadius(brief: ExplorationBrief): string {
  if (!brief.blastRadius.length) return "";
  const lines: string[] = ["### Blast radius (code — distilled from Serena)"];
  for (const n of brief.blastRadius.slice(0, 200)) {
    lines.push(`- \`${s(n.symbol)}\` (${s(n.file)}) — ${s(n.role)}`);
  }
  if (brief.feBe?.length) {
    lines.push("### FE↔BE links");
    for (const l of brief.feBe.slice(0, 50)) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
  }
  if (brief.risks?.length) {
    lines.push("### Risks / assert to catch regression");
    for (const r of brief.risks.slice(0, 20)) lines.push(`- ${s(r)}`);
  }
  return lines.join("\n");
}

function renderContracts(ops: ApiOperation[]): string {
  if (!ops.length) return "";
  const lines: string[] = ["### Relevant API contracts (from context.json — assert these at the boundary)"];
  for (const op of ops) {
    lines.push(`- \`${s(op.operationId)}\`: ${s(op.method)} ${s(op.path)}${op.service ? ` (${s(op.service)})` : ""}`);
  }
  return lines.join("\n");
}


export async function buildContextPack(
  input: ContextPackInput,
  deps: ContextPackDeps,
): Promise<ContextPackAssembly> {
  const log = deps.log ?? (() => {});
  const domBudgetChars = Math.floor(DOM_BUDGET_BYTES / BYTES_PER_CHAR);

  let blastSection = "";
  if (input.brief && input.brief.blastRadius.length > 0) {
    blastSection = renderBlastRadius(input.brief);
  }

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
          "### Live DOM (a11y tree — GROUND TRUTH for selectors)",
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

  const blastRadiusBytes = Buffer.byteLength(blastSection, "utf8");
  const domBytes = Buffer.byteLength(domSection, "utf8");
  const contractBytes = Buffer.byteLength(contractSection, "utf8");

  const parts = [blastSection, domSection, contractSection].filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
  }

  const packHeader = [
    "## Context Pack (pushed by the orchestrator before the first write)",
    "",
    "This pack is the ground truth for this objective. It was built deterministically by",
    "the orchestrator BEFORE this session started. Use it to transcribe real selectors and",
    "verify blast-radius symbols; do NOT re-navigate routes already covered here or re-read",
    "code symbols already in the blast-radius section (the brief already distilled them).",
    "If the pack is absent for a route, fall back to the Playwright MCP to explore it yourself.",
    "",
  ].join("\n");

  const text = packHeader + parts.join("\n\n");
  return { text, blastRadiusBytes, domBytes, contractBytes };
}
