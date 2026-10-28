/*
 * Possible data contradictions of the captured pages, as gaps between what the consumer's own code expects of an operation's answer
 * and what the live answers carried: a field the consumer's declared response type holds, that its non-test code reads and nothing
 * writes (`ConsumerExpectationsOf`), absent at every depth from every response of the operation the pages read. The operation is
 * the one `METHOD origin/path` the capture recorded, whatever page read it: a name any response of it carries leaves no gap, and so
 * does a response the capture cut (a name missing from it proves nothing), one with no item, and one that is no GET. The expectation
 * comes from the consumer, the absence from the live answers, and the class from the provider's contract: the field is
 * `provider-undeclared` when the contract describes the operation's answer and does not declare it, `provider-declared-absent` when it
 * declares it, and `no-provider-contract` when none is known. Another operation of the page that carries the field is context on the
 * gap, never a fact of its own. No similarity of one answer to another decides anything. A signal for the author and the human
 * reading the PR or the Issue, never a gate: an optional field can be absent from the data DEV holds. Pure.
 */
import type { DataContradiction, ProviderContract } from "@kernel/data-contradiction.ts";
import type { ConsumerExpectationsOf } from "./consumer-expectation.ts";
import type { DataShape, PageDataShapes } from "./route-snapshot.ts";

/* A safety bound on what a page can make the rule report (the shapes come from an untrusted page, the expectation from a repository); what is left out is counted. */
export const MAX_GAPS_PER_PAGE = 20;

/* A captured page and the shapes of the responses its code read. */
export interface PageShapes {
  route: string;
  template?: string;
  shapes: PageDataShapes;
}

/* The field names the provider's OpenAPI documents declare anywhere in an operation's response; undefined when no schema is known for it or it declares none. */
export type ResponseFieldsOf = (method: string, url: string) => ReadonlySet<string> | undefined;

export interface GapSources {
  expectationsOf?: ConsumerExpectationsOf;
  fieldsOf?: ResponseFieldsOf;
}

const operationOf = (shape: DataShape): string => `${shape.method} ${shape.url}`;

function pathnameOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/* What every response of an operation the pages read carried, across the pages. */
interface Observed {
  names: Set<string>;
  items: number;
  complete: boolean;
}

function observedOperations(pages: readonly PageShapes[]): Map<string, Observed> {
  const out = new Map<string, Observed>();
  for (const page of pages) {
    for (const shape of page.shapes.listed) {
      const held = out.get(operationOf(shape)) ?? { names: new Set<string>(), items: 0, complete: true };
      for (const name of [...shape.keys, ...shape.names]) held.names.add(name);
      held.items += shape.items;
      held.complete = held.complete && shape.complete;
      out.set(operationOf(shape), held);
    }
  }
  return out;
}

function classify(fieldsOf: ResponseFieldsOf | undefined, shape: DataShape, key: string): ProviderContract {
  const declared = fieldsOf?.(shape.method, shape.url);
  if (declared === undefined) return "no-provider-contract";
  return declared.has(key) ? "provider-declared-absent" : "provider-undeclared";
}

function gapsOfPage(page: PageShapes, observed: ReadonlyMap<string, Observed>, sources: GapSources): DataContradiction[] {
  const found: DataContradiction[] = [];
  const { expectationsOf, fieldsOf } = sources;
  if (expectationsOf === undefined) return found;
  const done = new Set<string>();
  for (const shape of page.shapes.listed) {
    const operation = operationOf(shape);
    const all = observed.get(operation);
    if (shape.method !== "GET" || all === undefined || !all.complete || all.items < 1 || done.has(operation)) continue;
    done.add(operation);
    const path = pathnameOf(shape.url);
    const expectation = path === undefined ? undefined : expectationsOf({ method: shape.method, path });
    if (expectation === undefined) continue;
    const first = expectation.callSites[0]!;
    for (const field of expectation.fields) {
      if (all.names.has(field.name)) continue;
      const carriers = page.shapes.listed.filter((other) => operationOf(other) !== operation && (other.names.includes(field.name) || other.keys.includes(field.name))).map(operationOf);
      found.push({
        route: page.route,
        ...(page.template !== undefined ? { template: page.template } : {}),
        key: field.name,
        operation,
        items: all.items,
        provider: classify(fieldsOf, shape, field.name),
        consumer: {
          callSite: `${first.site.file}:${first.site.line}`,
          callSites: expectation.callSites.length,
          declaredType: first.declaredType,
          reads: field.reads.map((site) => `${site.file}:${site.line}`),
          readCount: field.readCount,
        },
        ...(carriers.length > 0 ? { alsoCarriedBy: [...new Set(carriers)].sort() } : {}),
      });
    }
  }
  return found;
}

/* The possible contradictions of the pages, in the order of their pages, their operations and then the field; at most MAX_GAPS_PER_PAGE a page, and how many that left out. `pages` is how many pages had a shape to read. */
export function findExpectationGaps(pages: readonly PageShapes[], sources: GapSources): { facts: DataContradiction[]; omitted: number; pages: number } {
  const observed = observedOperations(pages);
  const facts: DataContradiction[] = [];
  let omitted = 0;
  for (const page of pages) {
    const found = gapsOfPage(page, observed, sources);
    facts.push(...found.slice(0, MAX_GAPS_PER_PAGE));
    omitted += Math.max(0, found.length - MAX_GAPS_PER_PAGE);
  }
  return { facts, omitted, pages: pages.filter((page) => page.shapes.listed.length > 0).length };
}
