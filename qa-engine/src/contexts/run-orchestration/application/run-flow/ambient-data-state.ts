/*
 * What the run does with a passing case that checked a page only as DEV served it confirmed empty (an ambient pin): the change's
 * untaken arms on that page are attributed to the data DEV lacks there, and the flow that owns the case's spec is told how to give the
 * page data: a place the app declares, when it declares any, else a stubbed test beside the live one. A signal: nothing here reads or
 * changes a verdict, a decision or a publication route.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { AmbientDataPin } from "@kernel/page-data-read.ts";
import { candidatesSeededBy } from "@kernel/change-map.ts";
import { candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import { detectAmbientDataPins, type SpecText } from "@contexts/test-execution/application/index.ts";
import type { CorrectionFinding } from "@contexts/coordination/application/index.ts";
import type { WorkspaceRunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";

/* The delivered specs as they stand now, read through the confined reader: a file that is gone or refused contributes nothing. */
export function deliveredSpecTexts(state: Readonly<RunState>, ctx: WorkspaceRunContext): SpecText[] {
  const specs: SpecText[] = [];
  for (const file of new Set(state.generation.delivered.map((d) => d.file))) {
    try {
      specs.push({ file, text: ctx.services.specFiles.read(ctx.services.specRoot, file) });
    } catch {
      /* A spec the reader refuses or no longer finds says nothing. */
    }
  }
  return specs;
}

/*
 * The ambient pins of the run as it stands: the delivered specs read now, the execution's cases, and the pages the pack read as a
 * confirmed empty state. None before an execution, or when the pack read no such page. Off-path: a fault is logged and yields none.
 */
export function ambientPinsOf(state: Readonly<RunState>, ctx: WorkspaceRunContext): AmbientDataPin[] {
  const run = state.execution.run;
  if (run === undefined || state.grounding.emptyDataPages.length === 0) return [];
  try {
    return detectAmbientDataPins({ specs: deliveredSpecTexts(state, ctx), cases: run.cases, emptyPages: state.grounding.emptyDataPages });
  } catch (err) {
    engineLog.warn(`[qa] ambient data-state detection failed (off-path; the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/* The run's pinned cases and the untaken arms of the changed code on their pages, while the measured arms describe the bytes on disk. */
export interface AmbientRecord {
  pins: AmbientDataPin[];
  arms: Array<{ file: string; line: number; kind: string; arm: string; pages: string[] }>;
}

/* The ambient record of the run as it stands, or none when no case is pinned. */
export function ambientRecordOf(state: Readonly<RunState>, ctx: WorkspaceRunContext): AmbientRecord | undefined {
  const pins = ambientPinsOf(state, ctx);
  if (pins.length === 0) return undefined;
  const arms = state.coverage.untakenArmsCurrent ? armsOnPinnedPages(state.coverage.untakenArms, pins, state.grounding.candidates) : [];
  return { pins, arms };
}

/*
 * The arms whose file seeds a use case one of whose pages names a pinned page (`candidatesSeededBy`, `candidatePagesOf`: the seed
 * definition every reader of a use case shares), each with those pinned pages, in the order given. An arm on no pinned page is left out.
 */
export function armsOnPinnedPages<A extends { file: string }>(arms: readonly A[], pins: readonly AmbientDataPin[], candidates: readonly UseCaseCandidate[]): Array<A & { pages: string[] }> {
  const pinned = [...new Set(pins.flatMap((pin) => pin.pages))];
  if (pinned.length === 0) return [];
  return arms.flatMap((arm) => {
    const reached = candidatesSeededBy(arm.file, candidates).flatMap(candidatePagesOf);
    const pages = pinned.filter((page) => reached.some((route) => namesTemplatePage(route, page)));
    return pages.length > 0 ? [{ ...arm, pages }] : [];
  });
}

/* What the flow is told to do so the case tests the change and not DEV's data: move to a declared place that has data, or state the data in a stubbed test. */
function remedyOf(places: readonly string[]): string {
  return places.length > 0
    ? `Give the page data: with set_geolocation, try the places the app declares (${places.join(", ")}) until the authenticated browser shows the page with results, pin that place in the spec with setLocation(context, latitude, longitude), and assert what the change does with the results.`
    : `Cover the state the change handles with a stubbed test ("[stubbed: <the response it states>]", fulfilling only the GET responses the page needs, beside the live test of the page) and assert what the change does with that data.`;
}

/*
 * One finding per pinned case, carrying its spec so the lead's pass hands it to the flow that owns that spec. An empty state stays a
 * legitimate assertion only as the result of a step the test takes.
 */
export function ambientPinFindings(pins: readonly AmbientDataPin[], places: readonly string[]): Array<{ finding: CorrectionFinding }> {
  return pins.map((pin) => ({
    finding: {
      text: `test "${pin.test}" in ${pin.file} checks ${pin.pages.join(", ")} only as DEV served it, which the Context Pack read as a confirmed empty state: every assertion runs on the page as it loaded, before any step of the test's own, so it tests DEV's data, not the change. ${remedyOf(places)} An empty state is worth asserting only as the result of a step the test takes.`,
      spec: pin.file,
    },
  }));
}
