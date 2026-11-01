/*
 * Which data contradictions are a defect of the run by themselves. A contradiction is a field the consumer's own code expects of an
 * operation's answer (its declared type holds it, non-test code reads it and nothing writes it) that no live response of the operation
 * carries. It is a defect, with no failing test needed, when the provider's contract describes the answer and does not declare the field
 * (`provider-undeclared`: the consumer reads what the provider never promised, so the interface is broken whatever data DEV holds) and the
 * change reaches the page that read it or the operation it was read from. A field the contract declares and the live answers lack
 * (`provider-declared-absent`) may be an optional field DEV's data does not hold, and an answer with no known contract proves nothing:
 * both stay possible contradictions. The reach is the one the causal label uses, positive evidence only: a scope that is missing, or that
 * does not place the fact, makes no defect. Pure.
 */
import type { DataContradiction, DefectFact } from "@kernel/data-contradiction.ts";
import { pathOnly } from "@kernel/route-availability.ts";
import { pageReach, requestReach, type CausalMatchers, type CausalScope, type Found } from "./causal-label.ts";

export interface ContradictionDefectsInput {
  facts: readonly DataContradiction[];
  scope: CausalScope | undefined;
  matchers: CausalMatchers;
}

/* The path of the operation a fact names, `METHOD origin/path`. */
function operationPath(operation: string): string | undefined {
  try {
    return new URL(operation.slice(operation.indexOf(" ") + 1)).pathname;
  } catch {
    return undefined;
  }
}

function placed(fact: DataContradiction, { scope, matchers }: ContradictionDefectsInput): Found | undefined {
  const byPage = pageReach(pathOnly(fact.route), scope, matchers);
  if (byPage.reach === "in-reach") return byPage;
  const path = operationPath(fact.operation);
  const byRequest = path === undefined ? undefined : requestReach([path], scope, matchers);
  return byRequest?.reach === "in-reach" ? byRequest : undefined;
}

/* The contradictions that are a defect of the run, in the order of the facts. */
export function contradictionDefects(input: ContradictionDefectsInput): DefectFact[] {
  return input.facts.flatMap((fact) => {
    if (fact.provider !== "provider-undeclared") return [];
    const found = placed(fact, input);
    return found === undefined ? [] : [{ fact, basis: found.basis === "request" ? ("request" as const) : ("page" as const), via: found.via }];
  });
}
