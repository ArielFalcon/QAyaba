import type { JudgeAnswer } from "../../domain/judge-evidence.ts";

/* One call to the tool-less judge role. Throws when the call fails; the use case records it and goes on. */
export interface JudgeAgentPort {
  ask(prompt: string, signal?: AbortSignal): Promise<JudgeAnswer>;
}
