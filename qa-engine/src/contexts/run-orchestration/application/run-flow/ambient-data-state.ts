/*
 * What the run does with a passing case that checked a page only as DEV served it confirmed empty (an ambient pin): the change's
 * untaken arms on that page are attributed to the data DEV lacks there, and the flow that owns the case's spec is told how to give the
 * page data: a place the app declares, when it declares any, else a stubbed test beside the live one. A signal: nothing here reads or
 * changes a verdict, a decision or a publication route.
 */

import type { AmbientDataPin } from "@kernel/page-data-read.ts";
import { candidatesSeededBy } from "@kernel/change-map.ts";
import { candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import type { EvidenceFinding } from "./phases/generation-services.ts";

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
export function ambientPinFindings(pins: readonly AmbientDataPin[], places: readonly string[]): EvidenceFinding[] {
  return pins.map((pin) => ({
    finding: {
      text: `test "${pin.test}" in ${pin.file} checks ${pin.pages.join(", ")} only as DEV served it, which the Context Pack read as a confirmed empty state: every assertion runs on the page as it loaded, before any step of the test's own, so it tests DEV's data, not the change. ${remedyOf(places)} An empty state is worth asserting only as the result of a step the test takes.`,
      spec: pin.file,
    },
  }));
}
