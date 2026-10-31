import { GENERATION_END } from "@kernel/generation-end.ts";
import type { GenerationOutput } from "@contexts/generation/application/index.ts";

type Scripted = Omit<GenerationOutput, "end"> & Partial<Pick<GenerationOutput, "end">>;

/**
 * A generation result as the run tests script it. Unless a test names the end, it follows the specs:
 * specs are delivered, an unparsed verdict has no verdict, and nothing written is a declared no-op.
 */
export function scriptedGeneration(scripted: Scripted): GenerationOutput {
  const end =
    scripted.specs.length > 0 ? GENERATION_END.DELIVERED : scripted.parsed === false ? GENERATION_END.NO_VERDICT : GENERATION_END.DECLARED_NOOP;
  return { end, ...scripted };
}
