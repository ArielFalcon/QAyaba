/*
 * What the orchestrator makes of an explore sidekick's findings before the lead sees them. A finding is the sidekick's word: it is
 * `verified` only when the orchestrator holds the thing it is about from a source of its own (a page the Context Pack read, a data
 * route the pack read with results, a page the orchestrator's browser showed that sidekick, a symbol the code graph holds); a claim
 * of an empty data state that the pack read with results contradicts is `contradicted`, and the pack wins. Everything else is
 * `unverified`. Pure: the sets it reads are resolved by the caller.
 */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { observationConflictIn } from "./evidence-precedence.ts";
import { evidenceFromEmptyRead, evidenceFromPackDataRoutes } from "./evidence-from.ts";
import { EXPLORE_FINDING_KIND, type Exploration, type ExploreFinding } from "./exploration.ts";

export const FINDING_VERIFICATION = { VERIFIED: "verified", UNVERIFIED: "unverified", CONTRADICTED: "contradicted" } as const;
export type FindingVerification = (typeof FINDING_VERIFICATION)[keyof typeof FINDING_VERIFICATION];

export interface VerifiedFinding extends ExploreFinding {
  readonly verification: FindingVerification;
  /* Why a contradicted finding is not taken: the orchestrator's own fact. */
  readonly contradictedBy?: string;
}

/* What the orchestrator holds, by its own means, that a finding can be checked against. */
export interface ExplorationGround {
  redaction: RedactionPort;
  /* Whether the run's Context Pack read this path as a page. */
  packReadsPage(path: string): boolean;
  /* The pages the pack read with results under the app's declared data state. */
  dataRoutes: readonly { path: string; resultCount: number }[];
  /* The paths the orchestrator's browser showed the asking sidekick. */
  browserReads: readonly string[];
  /* Whether the code graph holds the symbol a finding names (its ref as written). */
  graphHolds(ref: string): boolean;
}

/* A claim that the data state is empty. */
const SAYS_EMPTY = /\b(no|zero|0)\s+(results?|items?|rows?|entries|records?)\b|\bempty\b|\bnothing\b/i;

/* The path a ref names: no query, no fragment, no trailing slash except the root. */
export function pathOfRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  const path = trimmed.split(/[?#]/)[0]!;
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

function verify(finding: ExploreFinding, ground: ExplorationGround): VerifiedFinding {
  const unverified = { ...finding, verification: FINDING_VERIFICATION.UNVERIFIED };
  if (finding.kind === EXPLORE_FINDING_KIND.SYMBOL) {
    return ground.graphHolds(finding.ref) ? { ...finding, verification: FINDING_VERIFICATION.VERIFIED } : unverified;
  }
  if (finding.kind !== EXPLORE_FINDING_KIND.PAGE && finding.kind !== EXPLORE_FINDING_KIND.DATA_STATE) return unverified;
  const path = pathOfRef(finding.ref);
  if (path === undefined) return unverified;
  if (finding.kind === EXPLORE_FINDING_KIND.DATA_STATE && SAYS_EMPTY.test(finding.claim)) {
    const conflict = observationConflictIn([...evidenceFromPackDataRoutes(ground.redaction, ground.dataRoutes), evidenceFromEmptyRead(ground.redaction, path)]);
    if (conflict) return { ...finding, verification: FINDING_VERIFICATION.CONTRADICTED, contradictedBy: conflict.pack.summary };
  }
  const held = ground.packReadsPage(path) || ground.dataRoutes.some((route) => route.path === path) || ground.browserReads.includes(path);
  return held ? { ...finding, verification: FINDING_VERIFICATION.VERIFIED } : unverified;
}

export function verifyExplorationFindings(findings: readonly ExploreFinding[], ground: ExplorationGround): VerifiedFinding[] {
  return findings.map((finding) => verify(finding, ground));
}

export interface VerifiedExploration {
  readonly id: string;
  readonly question: string;
  readonly status: Exploration["status"] | "failed";
  readonly findings: readonly VerifiedFinding[];
}
