/*
 * The availability classification of a Context Pack's capture: the reported pages' navigation, the change evidence the grounding
 * supplies (asked for only when some route was unavailable) and the classifier. Fail-open: evidence that cannot be built is
 * unknown, so the routes fall to the classes that need none, and finally to `unexplained`.
 */
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { classifyCapture, outcomeOf, type RouteChangeEvidence, type RouteNavigation } from "../domain/route-availability-classifier.ts";
import type { CapturedPage } from "./dom-snapshot.ts";
import { loggableRoutes } from "./loggable-route.ts";

export interface PackAvailabilityInput {
  /* The app's declared login page (auth.loginPath). */
  loginPath?: string;
  /* The change lives in another repository (a cross-repo run). */
  changeElsewhere?: boolean;
  /* The change evidence of the given routes, built once. */
  evidence(navigations: readonly RouteNavigation[]): Promise<(navigation: RouteNavigation) => RouteChangeEvidence>;
}

export interface PackAvailability {
  /* Routes the capture read with an outcome the classification trusts. */
  read: number;
  facts: RouteAvailabilityFact[];
}

const UNKNOWN: RouteChangeEvidence = { declaration: { status: "unknown" }, implements: false };

export async function classifyPackAvailability(
  input: PackAvailabilityInput,
  pages: Iterable<CapturedPage>,
  reported: ReadonlySet<string>,
  log: (msg: string, how?: { ship: true }) => void,
): Promise<PackAvailability> {
  const navigations = [...pages].filter((page) => reported.has(page.route) && page.navigation !== undefined).map((page) => page.navigation!);
  const read = navigations.filter((nav) => !nav.captureFailed && nav.settled).length;
  const unavailable = navigations.filter((nav) => !nav.captureFailed && nav.settled && outcomeOf(nav) !== undefined);
  if (unavailable.length === 0) return { read, facts: [] };
  let evidenceOf: (navigation: RouteNavigation) => RouteChangeEvidence = () => UNKNOWN;
  try {
    evidenceOf = await input.evidence(unavailable);
  } catch (err) {
    log(`[qa] route availability: the change evidence could not be built (${err instanceof Error ? err.message : String(err)}); the routes are classified without it`, { ship: true });
  }
  const facts = classifyCapture(navigations.map((navigation) => ({ navigation })), evidenceOf, {
    ...(input.loginPath !== undefined ? { loginPath: input.loginPath } : {}),
    ...(input.changeElsewhere === true ? { changeElsewhere: true } : {}),
  });
  const byClass = new Map<string, string[]>();
  for (const fact of facts) byClass.set(fact.basis.class, [...(byClass.get(fact.basis.class) ?? []), fact.route]);
  log(`[qa] route availability: ${[...byClass].map(([cls, routes]) => `${cls}: ${loggableRoutes(routes)}`).join("; ")}`, { ship: true });
  return { read, facts };
}
