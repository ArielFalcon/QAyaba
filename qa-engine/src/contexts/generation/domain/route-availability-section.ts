/*
 * The Context Pack's availability section: one fact per route the capture could not show at its own address, with where the
 * browser ended and why, in plain words and no directive. The change's own unavailabilities come first. Pure; the caller redacts.
 */
import { outcomeText, MAX_AVAILABILITY_FACTS_RECORDED, type AvailabilityBasis, type AvailabilityClass, type RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { PACK_HEADINGS } from "./prompt-headings.ts";

const ORDER: readonly AvailabilityClass[] = ["change-introduced", "regression-candidate", "environment", "pre-existing", "unexplained"];

const EVIDENCE_WORDS: Record<string, string> = {
  declaration: "no route table states how the route is declared",
  "guard-reach": "whether a changed symbol reaches its guards is not known",
  session: "whether the capture held a session is not known",
  "change-repo": "the change lives in another repository",
};

/* Why, in one sentence. */
export function availabilityReason(basis: AvailabilityBasis): string {
  switch (basis.class) {
    case "change-introduced":
      return basis.via === "route-declaration"
        ? `The change governs this route: its route table entry changed at ${basis.at}.`
        : `The change governs this route: a changed symbol reaches its guard ${basis.at}.`;
    case "regression-candidate":
      return basis.reach === "governs"
        ? "The change governs this route and the page logged a runtime error: a possible regression, not a contract."
        : "The change reaches this page and the page logged a runtime error: a possible regression.";
    case "environment":
      switch (basis.why) {
        case "login-without-session":
          return "The environment: the capture held no session and the browser was sent to the login page.";
        case "session-rejected":
          return "The environment: the browser was sent to the login page although the capture held the run's session.";
        case "dev-gate":
          return "The environment: the DEV gate refused the document.";
        case "data-missing":
          return "The environment: a page of the same template that cannot exist ends the same way, so DEV lacks the data.";
      }
      return "The environment.";
    case "pre-existing":
      return basis.why === "session-consistent"
        ? "Pre-existing: the app's login page sends a signed-in session away."
        : `Not caused by this change: the route table entries that decide it (${basis.at ?? "its entry"}) and its guards are unchanged, and no changed symbol reaches them.`;
    case "unexplained": {
      const words = basis.missing.map((id) => EVIDENCE_WORDS[id] ?? id);
      return words.length > 0 ? `Unexplained: ${words.join("; ")}.` : "Unexplained: the change reaches the page itself, which does not say why it is not shown.";
    }
  }
}

/* One fact as a line. */
export function availabilityLine(fact: RouteAvailabilityFact): string {
  const session = fact.sessionAttached === true ? "with this run's session " : fact.sessionAttached === false ? "with no session " : "";
  const where = fact.outcome.kind === "redirected" ? `${session}the browser ends on ${outcomeText(fact.outcome)}` : `${session}the document answers ${outcomeText(fact.outcome)}`;
  const label = fact.template === undefined ? fact.route : `${fact.route} (page of ${fact.template})`;
  return `- ${label}: ${where}. ${availabilityReason(fact.basis)}`;
}

/* The section, or "" when no route was unavailable. */
export function renderAvailabilitySection(facts: readonly RouteAvailabilityFact[]): string {
  if (facts.length === 0) return "";
  const ordered = [...facts].sort((a, b) => ORDER.indexOf(a.basis.class) - ORDER.indexOf(b.basis.class));
  const listed = ordered.slice(0, MAX_AVAILABILITY_FACTS_RECORDED).map(availabilityLine);
  const more = ordered.length - listed.length;
  return [
    `### ${PACK_HEADINGS.availability}`,
    "Routes this run's capture did not show at their own address, each with where the browser ended and why.",
    ...listed,
    ...(more > 0 ? [`(+${more} more)`] : []),
  ].join("\n");
}
