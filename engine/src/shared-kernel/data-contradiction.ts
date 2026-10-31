/*
 * A possible data contradiction, as the run publishes it: a field the consumer's own code expects of an operation's answer (its
 * declared response type holds it, non-test code reads it and nothing writes it) that no live response of the operation carries
 * at any depth, which can be the app's defect and not the test's concern. The expectation comes from the consumer's source, the
 * absence from the responses the DOM capture read (key names and counts only, never a value), and the class from the provider's
 * contract; none from a spec's comment. Shared by the grounding that finds them (generation), the briefs (coordination), the
 * reviewer's evidence filter and the gate signal (run-orchestration) and the publication (workspace-and-publication). Values and wording only.
 */
import { pathOnly } from "./route-availability.ts";

/*
 * What the provider's contract says of the missing field: `provider-undeclared` (the contract describes the answer and does not
 * declare the field: the consumer expects what the provider never promised), `provider-declared-absent` (the contract declares it
 * and the live answer lacks it: the provider breaks its own contract) or `no-provider-contract` (no contract is known for the answer).
 */
export type ProviderContract = "provider-undeclared" | "provider-declared-absent" | "no-provider-contract";

export interface DataContradiction {
  /* The address the capture opened (a page of a template when `template` is set). */
  route: string;
  template?: string;
  /* The field the consumer expects. */
  key: string;
  /* The operation whose live responses lack it, `METHOD origin/path`, and how many items they returned in all. */
  operation: string;
  items: number;
  provider: ProviderContract;
  /* The consumer's side: where the request is issued (`file:line`, and how many call sites serve the operation), the type its code declares for the answer, and where it reads the field. */
  consumer: { callSite: string; callSites: number; declaredType: string; reads: string[]; readCount: number };
  /* Other operations of the page whose answers carry the field: context on the gap, never a fact of their own. */
  alsoCarriedBy?: string[];
}

/* The most facts the gate signal lists; the rest are counted. */
export const MAX_DATA_CONTRADICTIONS_RECORDED = 16;

/* What a run recorded of data contradictions. A signal, never a gate: it reads nothing back into a verdict. Runs stored before the consumer rule carry `carriedBy`, `missingFrom` and `schemaBacked` on a fact instead. */
export interface DataContradictionGateSignal {
  /* Pages the capture read response shapes of. */
  pages: number;
  found: number;
  /* How many facts the provider's contract declares the field of (`provider-declared-absent`; for a stored run, the facts a schema backed). */
  schemaBacked: number;
  facts: Array<{
    route: string;
    key: string;
    operation?: string;
    provider?: ProviderContract;
    callSite?: string;
    readCount?: number;
    alsoCarriedBy?: string[];
    carriedBy?: string;
    missingFrom?: string;
    schemaBacked?: boolean;
  }>;
  omitted: number;
}

export function dataContradictionsSignal(pages: number, facts: readonly DataContradiction[]): DataContradictionGateSignal {
  const listed = facts.slice(0, MAX_DATA_CONTRADICTIONS_RECORDED).map((fact) => ({
    route: fact.route,
    key: fact.key,
    operation: fact.operation,
    provider: fact.provider,
    callSite: fact.consumer.callSite,
    readCount: fact.consumer.readCount,
    ...(fact.alsoCarriedBy?.length ? { alsoCarriedBy: fact.alsoCarriedBy } : {}),
  }));
  return { pages, found: facts.length, schemaBacked: facts.filter((fact) => fact.provider === "provider-declared-absent").length, facts: listed, omitted: Math.max(0, facts.length - listed.length) };
}

const PROVIDER_STATEMENT: Record<ProviderContract, string> = {
  "provider-undeclared": "the provider's OpenAPI response schema does not declare it",
  "provider-declared-absent": "the provider's OpenAPI response schema declares it",
  "no-provider-contract": "no OpenAPI response schema is known for it",
};

/* What the fact states, with no page in front of it. */
export function dataContradictionStatement(fact: DataContradiction): string {
  const items = `${fact.items} item${fact.items === 1 ? "" : "s"}`;
  const more = fact.consumer.readCount - fact.consumer.reads.length;
  const reads = `${fact.consumer.reads.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const sites = fact.consumer.callSites > 1 ? ` (one of ${fact.consumer.callSites} call sites that all expect it)` : "";
  const also = fact.alsoCarriedBy?.length ? `; ${fact.alsoCarriedBy.join(", ")} carries it` : "";
  return `${fact.operation} returned ${items}, none carrying "${fact.key}" at any depth, while the consumer's code expects it: ${fact.consumer.callSite}${sites} declares ${fact.consumer.declaredType} for the answer, ${reads} read${fact.consumer.readCount === 1 ? "s" : ""} it and nothing writes it; ${PROVIDER_STATEMENT[fact.provider]} (${fact.provider})${also}`;
}

/* What a reviewer cites to name a fact: the page's pathname and the key, `<path>#<key>`. */
export function dataContradictionRef(fact: Pick<DataContradiction, "route" | "key">): string {
  return `${pathOnly(fact.route)}#${fact.key}`;
}

/* A citation's reference in the form facts are compared in (the page as a pathname, the key as written), or undefined when it names no key. */
export function normalizedContradictionRef(ref: string): string | undefined {
  const at = ref.lastIndexOf("#");
  if (at <= 0 || at === ref.length - 1) return undefined;
  return `${pathOnly(ref.slice(0, at).trim())}#${ref.slice(at + 1).trim()}`;
}

/* The refs a run's facts can be cited by: the page by its address, and by its template when it was opened from one. */
export function dataContradictionRefs(facts: readonly DataContradiction[]): Set<string> {
  return new Set(facts.flatMap((fact) => [dataContradictionRef(fact), ...(fact.template !== undefined ? [dataContradictionRef({ route: fact.template, key: fact.key })] : [])]));
}
