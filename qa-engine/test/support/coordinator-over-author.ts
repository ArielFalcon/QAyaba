/*
 * A coordinator for the run tests whose flows deliver what the scripted authoring port delivers: the run tests script what an
 * author writes and how its turn ends, and an e2e run reaches that script through its coordinator, as it does in production.
 * The port is read when the coordinator is asked, so a test that reassigns `author` after building the ports is still served.
 * The grounding the run hands its lead (`plan`) is the grounding the scripted author is briefed with, so a test can assert on
 * what an author is told; the port records it when the coordinator asks the lead to plan.
 */
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { CoordinateInput, CoordinateResult } from "@contexts/coordination/application/lead-sidekicks.ts";
import type { AuthorPort, GenerationEnrichment, LeadPort } from "@contexts/generation/application/index.ts";
import type { RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";

interface Briefing {
  diff: string | undefined;
  enrichment: GenerationEnrichment;
}

const briefings = new WeakMap<object, Briefing>();

/** A lead that records the grounding it is handed and plans nothing; give it to a port that has none of its own. */
export function briefingLead(owner: () => object): NonNullable<LeadPort["plan"]> {
  return async (_specDir, _signal, diff, enrichment) => {
    briefings.set(owner(), { diff, enrichment });
    return { parsed: false, timedOut: false };
  };
}

export async function authoredByCoordinator(port: AuthorPort & Partial<LeadPort>, input: CoordinateInput): Promise<CoordinateResult> {
  if (input.plan) await input.plan({} as never);
  const briefing = briefings.get(port);
  const { planning: _planning, ...briefed } = briefing?.enrichment ?? {};
  const generated = await port.author(input.specDir, input.signal, briefing?.diff, briefing ? briefed : undefined);
  const signal = { plan: "fanout" as const, flows: 1, delivered: generated.specs.length > 0 ? 1 : 0, incomplete: 0 };
  if (generated.end === GENERATION_END.DECLARED_NOOP && generated.specs.length === 0) return { action: "noop", reason: generated.note ?? "nothing worth a test", signal: { ...signal, plan: "noop", flows: 0 } };
  return { action: "fanout", aggregated: { end: generated.end ?? GENERATION_END.DELIVERED, specs: generated.specs, incompleteFlows: [], ...(generated.note !== undefined ? { note: generated.note } : {}) }, proposals: [], signal };
}

/** The `leadSidekicks` dependency that serves a run's flows from an authoring port. */
export const coordinatorOver = (port: AuthorPort & Partial<LeadPort>): { coordinate: (input: CoordinateInput) => Promise<CoordinateResult> } => ({ coordinate: (input) => authoredByCoordinator(port, input) });

/** A run's `generation` and `leadSidekicks` dependencies over one authoring port, to be spread into its deps. A port that cannot plan is given a lead that records the grounding the coordinator is handed. */
export function served<P extends AuthorPort & Partial<LeadPort>>(port: P): { generation: P; leadSidekicks: ReturnType<typeof coordinatorOver> } {
  const generation: P = port.plan ? port : ({ ...port, plan: briefingLead(() => generation) } as P);
  return { generation, leadSidekicks: coordinatorOver(generation) };
}

/**
 * A run whose login is still to be written is authored by one author sidekick in the working copy, with no plan: what that author
 * hands back (sources, manifest entries, the turn, the kind of a declared no-op, what it declares for each spec) reaches the run itself.
 */
export function loginToBeWritten(): Pick<RunQaUseCaseDeps, "authSession" | "authContext"> {
  let calls = 0;
  return {
    authSession: { prepare: async () => ({ unauthored: ++calls === 1 }) },
    authContext: { baseUrl: "https://dev.example", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } },
  };
}
