/* What one test's page did, as the orchestrator keeps it: the requests it depended on and the accessible tree it ended on. The seed's capture records it (PW_OBSERVE) for the re-run of a mutant and for the unmutated re-run it is compared with. Pure types and bounds; no I/O. */

/* One request, by method and origin + pathname (never the query, fragment, body, headers or cookies), with how many times the page made it. */
export interface ObservedRequest {
  method: string;
  url: string;
  count: number;
}

/* The page of the test `name` (the case's name): its requests and the lines of its accessible tree, with the states a line carries. */
export interface ObservedPage {
  name: string;
  requests: ObservedRequest[];
  dom: string[];
}

/* The most distinct requests, the most lines of the tree and the longest line one page keeps; what is past a bound is left out, not cut blind. */
export const MAX_OBSERVED_REQUESTS = 100;
export const MAX_OBSERVED_DOM_LINES = 400;
export const MAX_OBSERVED_LINE_CHARS = 200;
