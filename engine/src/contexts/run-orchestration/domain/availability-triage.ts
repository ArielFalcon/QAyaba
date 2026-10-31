/*
 * What a failing case says once the run's route availability facts are read beside it. A case whose spec opens a route the capture
 * classified, and whose failure point is exactly where that route sent the capture (the redirect target, or the same HTTP error), met
 * the route's availability, not a defect of its own page. The class of the fact decides: a route the change governs or one this change
 * did not cause is a test that has to assert where the route ends (a correction); a route sent away by the environment (no session, a
 * DEV gate, missing data) is a precondition; a route whose change also raised a runtime error is a possible regression a human judges.
 * An unexplained fact decides nothing. Never a re-read. Pure, apart from the spec reads it is handed.
 */

import type { QaCase } from "@kernel/qa-case.ts";
import { AVAILABILITY_CLASS, availabilityWhy, outcomeText, pathOnly, type RouteAvailabilityFact } from "@kernel/route-availability.ts";

export interface AvailabilityTriageInput {
  readonly facts: readonly RouteAvailabilityFact[];
  /* The pathnames a spec file opens (its `goto` calls), read through the confined reader; empty when it cannot be read. */
  specOpens(file: string): Promise<readonly string[]>;
}

export interface AvailabilityMatch {
  readonly case: QaCase;
  readonly fact: RouteAvailabilityFact;
}

export type AvailabilityDecision =
  /* A failure the change may have caused on a route it governs, with a runtime error: a human judges it. */
  | { kind: "needs-human"; reason: string }
  /* Every failure met a route the environment sends away: the run could not reach the page. */
  | { kind: "precondition"; reason: string }
  /* The failures that met a route the test must assert the end of, each with the fact it is corrected by, by case name. */
  | { kind: "correct"; notes: ReadonlyMap<string, string> };

const GOTO = /\bgoto\(\s*(['"`])([^'"`\n]*)\1/g;

/* The pathnames a spec's source opens with `goto`, once each, in order. */
export function routesOpenedBy(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(GOTO)) {
    const path = pathOnly(m[2]!);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/* Whether a pathname opens a route: equal, or equal segment by segment where the route has a `:parameter` segment. */
function opens(route: string, pathname: string): boolean {
  const wanted = pathOnly(route).split("/");
  const got = pathOnly(pathname).split("/");
  return wanted.length === got.length && wanted.every((segment, i) => segment === got[i] || segment.startsWith(":"));
}

/* Whether the case's failure point is where the fact says the route ends. */
function endsAsClassified(c: QaCase, fact: RouteAvailabilityFact): boolean {
  if (fact.outcome.kind === "http-error") return c.httpStatus === fact.outcome.status;
  return c.finalUrl !== undefined && pathOnly(c.finalUrl) === pathOnly(fact.outcome.to);
}

/* The failed cases a fact explains: their spec opens the fact's route (or a page of its template) and they failed where the route ends. */
export async function matchAvailability(failed: readonly QaCase[], input: AvailabilityTriageInput): Promise<AvailabilityMatch[]> {
  if (input.facts.length === 0) return [];
  const opened = new Map<string, readonly string[]>();
  const out: AvailabilityMatch[] = [];
  for (const c of failed) {
    if (c.file === undefined) continue;
    if (!opened.has(c.file)) opened.set(c.file, await input.specOpens(c.file));
    const paths = opened.get(c.file)!;
    const fact = input.facts.find((f) => paths.some((path) => opens(f.route, path) || (f.template !== undefined && opens(f.template, path))) && endsAsClassified(c, f));
    if (fact) out.push({ case: c, fact });
  }
  return out;
}

function cause(fact: RouteAvailabilityFact): string {
  const basis = fact.basis;
  switch (basis.class) {
    case AVAILABILITY_CLASS.CHANGE_INTRODUCED:
      return `this change's ${basis.via === "route-guard" ? "route guard" : "route declaration"} at ${basis.at}`;
    case AVAILABILITY_CLASS.PRE_EXISTING:
      return basis.why === "session-consistent" ? "the login page sends a signed-in session away" : "not caused by this change: its route entry and guards are unchanged";
    default:
      return availabilityWhy(basis);
  }
}

function line(fact: RouteAvailabilityFact): string {
  return `${fact.route} ends on ${outcomeText(fact.outcome)} (${cause(fact)})`;
}

/* What the matches decide about the round, or undefined when no failure met a classified route or every match is unexplained. */
export function availabilityDecision(matches: readonly AvailabilityMatch[], failedCount: number): AvailabilityDecision | undefined {
  const regression = matches.find((m) => m.fact.basis.class === AVAILABILITY_CLASS.REGRESSION_CANDIDATE);
  if (regression) return { kind: "needs-human", reason: `A failure met a route this change governs that also raised a runtime error (${line(regression.fact)}): a possible regression a human must judge.` };
  const environment = matches.filter((m) => m.fact.basis.class === AVAILABILITY_CLASS.ENVIRONMENT);
  if (failedCount > 0 && environment.length === failedCount) {
    return { kind: "precondition", reason: `Every failure met a route the environment sends away (${line(environment[0]!.fact)}): the run could not reach the page under test.` };
  }
  const notes = new Map<string, string>();
  for (const m of matches) {
    const cls = m.fact.basis.class;
    if (cls !== AVAILABILITY_CLASS.CHANGE_INTRODUCED && cls !== AVAILABILITY_CLASS.PRE_EXISTING) continue;
    notes.set(m.case.name, `Route availability: ${line(m.fact)}. Assert where the route ends for this run's client instead of the page it no longer shows, or remove the case.`);
  }
  return notes.size > 0 ? { kind: "correct", notes } : undefined;
}
