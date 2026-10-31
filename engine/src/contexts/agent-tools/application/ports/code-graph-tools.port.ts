import type { CodeGraphToolsHandle, CodeGraphToolsOpenInput } from "../../domain/code-graph-tools.ts";

/** Grants the lead the read-only `explore` of the run's own code-graph index. `open` answers nothing when the run cannot be granted it. */
export interface CodeGraphToolsPort {
  open(input: CodeGraphToolsOpenInput): Promise<CodeGraphToolsHandle | undefined>;
}
