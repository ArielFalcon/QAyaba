import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";

/**
 * What one generation hands the run. `end` says how it ended: with specs the run continues;
 * without them, only a declared no-op is a decision, and the other ends say why nothing was
 * written. `reviewed` is whether an independent reviewer looked at the specs: `approved` is
 * that reviewer's verdict only when it is true — otherwise it is a placeholder, and the run must
 * read it through `reviewerApprovalOf`. `note` explains an end that wrote nothing.
 * `specSources` is just-generated spec text for selector checks; absent/empty is never
 * fabricated. `specMetas` is the flow/objective projection for publication; absent/empty omits
 * the "tested" section. `parsed` is false only when no verdict JSON could be parsed. `turn` is
 * what the generation's main turn measured, when its runtime can measure a turn. `declaredSpecs`
 * is what the verdict declared for each delivered spec (flow, objective), the lead's own word:
 * what the run carries into its later regenerations. Absent when no spec was delivered.
 */
export interface GenerationOutput {
  specs: string[];
  declaredSpecs?: DeliveredSpec[];
  end: GenerationEndKind;
  /** For a declared no-op, the reason its verdict named (`unspecified` when it named none). Absent for every other end. Observe-only. */
  noopKind?: NoopKind;
  reviewed: boolean;
  approved: boolean;
  note?: string;
  specSources?: string[];
  parsed?: boolean;
  specMetas?: { flow?: string; objective?: string }[];
  turn?: AgentTurnStats;
  /* The generator's typed claim that the test is correct; a claim, never evidence. Absent unless the verdict carried one. */
  testCorrect?: { cause: "env" | "app"; reason: string };
  /* The findings the generator disputes instead of correcting, each with the basis the run must check. Absent unless the verdict carried one. */
  rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[];
}

/** The reviewer's verdict on a generation, or undefined when no reviewer looked at it: the one way the run reads `approved`. */
export function reviewerApprovalOf(generation: Pick<GenerationOutput, "reviewed" | "approved">): boolean | undefined {
  return generation.reviewed ? generation.approved : undefined;
}
