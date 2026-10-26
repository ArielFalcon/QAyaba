/*
 * The lead's request to explore, as the orchestrator admits it. The request is the lead's word: it names questions, and only the
 * question text, an id and the pages to look at are kept. A request that cannot be admitted as it stands is rejected with its reason;
 * nothing is guessed at. Pure: no clock, no file, no model.
 */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { isRecord, MAX_ROUTE_CHARS, MAX_ROUTES, ROUTE, slugOf, text } from "./lead-plan.ts";

export const MAX_EXPLORE_QUESTIONS = 3;
export const MAX_QUESTION_CHARS = 400;
/* What one explore sidekick may take of the run's time. */
export const EXPLORE_BUDGET_MS = 120_000;
/* Less than this and a sidekick cannot open a page, read it and answer. */
export const MIN_EXPLORE_MS = 30_000;
/* The share of the run's authenticated-browser and code-graph calls that exploration may spend, split between its questions; the rest stays for authoring. */
export const EXPLORE_CALL_SHARE = 0.25;

export const EXPLORE_REJECTED = { NOT_A_LIST: "not-a-list", EMPTY: "empty", OVER_LIMIT: "over-limit", MALFORMED: "malformed", DUPLICATE: "duplicate-question" } as const;
export type ExploreRejection = (typeof EXPLORE_REJECTED)[keyof typeof EXPLORE_REJECTED];

export interface ExploreQuestion {
  id: string;
  question: string;
  routes: string[];
}

export type AdmittedExploreRequest = { kind: "admitted"; questions: ExploreQuestion[] } | { kind: "rejected"; reason: ExploreRejection };

const rejected = (reason: ExploreRejection): AdmittedExploreRequest => ({ kind: "rejected", reason });

/* The pages a question names: every one must be a site-relative path, so a route with a scheme or a host rejects the request. Undefined when one is not. */
function routesOf(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROUTES) return undefined;
  const routes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const route = item.trim();
    /* `//host/path` is a network-path reference, not a page of the app. */
    if (route.length > MAX_ROUTE_CHARS || !ROUTE.test(route) || route.startsWith("//")) return undefined;
    routes.push(route);
  }
  return [...new Set(routes)];
}

export function admitExploreRequest(raw: unknown, redaction: RedactionPort): AdmittedExploreRequest {
  if (!Array.isArray(raw)) return rejected(EXPLORE_REJECTED.NOT_A_LIST);
  if (raw.length === 0) return rejected(EXPLORE_REJECTED.EMPTY);
  if (raw.length > MAX_EXPLORE_QUESTIONS) return rejected(EXPLORE_REJECTED.OVER_LIMIT);
  const questions: ExploreQuestion[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return rejected(EXPLORE_REJECTED.MALFORMED);
    const question = text(redaction, entry.question, MAX_QUESTION_CHARS);
    const routes = routesOf(entry.routes);
    if (question === "" || routes === undefined) return rejected(EXPLORE_REJECTED.MALFORMED);
    const given = typeof entry.id === "string" && entry.id.trim() !== "" ? slugOf(redaction.redact(entry.id)) : `q${index + 1}`;
    questions.push({ id: given, question, routes });
  }
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return rejected(EXPLORE_REJECTED.DUPLICATE);
  return { kind: "admitted", questions };
}
