/*
 * The change evidence of the routes a capture could not show at their own address: E1 from the route table at the run's base
 * and at head, E2 from the guards it lists checked against the change's closure over the code graph, E3 from the use cases the
 * change makes testable (a page whose own implementation the change reaches). Built once per capture, and only when a route was
 * unavailable. A cross-repo run, a run with no diff, no base or no reader of it, and a framework with no extractor, have no route
 * table: their routes' declaration evidence is unknown.
 */
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { ChangeClosure } from "@kernel/route-availability.ts";
import { pathOnly } from "@kernel/route-availability.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { RouteChangeEvidence, RouteNavigation } from "../../domain/route-availability-classifier.ts";
import { declarationEvidence, guardEvidence, guardsOf, matchRoute, unresolvedLinks } from "../../domain/route-table.ts";
import { routeTablesOf, type RouteTables } from "../route-table/route-tables.source.ts";

export interface RouteEvidenceInput {
  mirrorDir?: string;
  changedFiles: readonly string[];
  /* The run's base (its range start) and a reader of a file at a commit, through the confined mirror reader. */
  baseRef?: string;
  readAtRef?: (ref: string, file: string) => Promise<string | undefined>;
  closure?: () => Promise<ChangeClosure | undefined>;
  candidates?: readonly UseCaseCandidate[];
  /* A cross-repo run: the change is not in this working copy. */
  crossRepo: boolean;
}

/* The bases by which a use case is the page's own implementation (not its declaration, which E1 reads). */
const IMPLEMENTATION_BASES: ReadonlySet<string> = new Set(["implementation", "graph"]);

export async function routeChangeEvidence(input: RouteEvidenceInput): Promise<(navigation: RouteNavigation) => RouteChangeEvidence> {
  let tables: RouteTables | undefined;
  /* Why there is no route table, when there is none. */
  let noTable = "the repository's manifest names no framework with a route-table extractor";
  const { mirrorDir, baseRef, readAtRef } = input;
  if (input.crossRepo) noTable = "the change lives in another repository of a cross-repo run";
  else if (mirrorDir === undefined || baseRef === undefined || readAtRef === undefined) noTable = "the run has no base to read the route table at";
  else if (input.changedFiles.length === 0) noTable = "the run has no changed files";
  else {
    try {
      tables = await routeTablesOf({ mirrorDir, changedFiles: input.changedFiles, readAtBase: (file) => readAtRef(baseRef, file) });
    } catch (err) {
      noTable = "the route table could not be read";
      engineLog.warn(`[qa] route availability: the route table could not be read (${err instanceof Error ? err.message : String(err)}); declarations are unknown this run`);
    }
  }
  let closure: ChangeClosure | undefined;
  if (tables !== undefined && input.closure !== undefined) {
    try {
      closure = await input.closure();
    } catch (err) {
      engineLog.warn(`[qa] route availability: the change's closure over the code graph was not read (${err instanceof Error ? err.message : String(err)}); guards are not proven unreached this run`);
    }
  }
  const implemented = new Set(
    (input.candidates ?? []).flatMap((c) => (c.entry.kind === "page" && IMPLEMENTATION_BASES.has(c.basis) ? [pathOnly(c.entry.route)] : [])),
  );
  return (navigation) => {
    const implementsPage = implemented.has(pathOnly(navigation.route)) || (navigation.template !== undefined && implemented.has(pathOnly(navigation.template)));
    if (tables === undefined) return { declaration: { status: "unknown" }, unresolved: [noTable], implements: implementsPage };
    const declaration = declarationEvidence(tables.head, tables.base, navigation.route);
    const match = matchRoute(tables.head, navigation.route);
    const guards = match !== undefined && "steps" in match ? guardEvidence(guardsOf(match), closure) : undefined;
    const unresolved = declaration.status === "unknown" || guards === undefined || guards.status === "partial" ? unresolvedLinks(tables.head, tables.base, navigation.route) : [];
    return { declaration, ...(guards !== undefined ? { guards } : {}), ...(unresolved.length > 0 ? { unresolved } : {}), implements: implementsPage };
  };
}
