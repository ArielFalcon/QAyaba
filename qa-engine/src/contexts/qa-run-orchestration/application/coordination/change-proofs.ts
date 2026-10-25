/* How the change reaches a flow's pages, for its sidekick's brief (S15): the proof the call graph found for each change page the flow visits, symbol and file names only, so the flow's assertions aim at the changed behaviour. Bounded per brief and per proof. Pure. */
import type { GraphPage } from "@kernel/change-pages.ts";
import { namesTemplatePage } from "@contexts/generation/domain/route-instantiation.ts";

export const MAX_BRIEF_PROOFS = 3;
export const MAX_PROOF_STEPS = 8;

/* A proof longer than the bound keeps where it starts (the change) and where it ends (the page), and says how many steps it left out between them. */
function boundedSteps(proof: readonly string[]): string[] {
  if (proof.length <= MAX_PROOF_STEPS) return [...proof];
  const head = Math.floor((MAX_PROOF_STEPS - 1) / 2);
  const tail = MAX_PROOF_STEPS - 1 - head;
  return [...proof.slice(0, head), `(${proof.length - head - tail} more)`, ...proof.slice(proof.length - tail)];
}

/* The proofs of the change pages the flow's routes name, one line each (`route: step > step > ...`); nothing when none. */
export function proofsFor(proofs: readonly GraphPage[] | undefined, routes: readonly string[]): string[] | undefined {
  const lines = (proofs ?? [])
    .filter((page) => routes.some((route) => namesTemplatePage(page.route, route)))
    .slice(0, MAX_BRIEF_PROOFS)
    .map((page) => `${page.route}: ${boundedSteps(page.proof).join(" > ")}`);
  return lines.length > 0 ? lines : undefined;
}
