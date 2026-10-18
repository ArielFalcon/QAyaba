/*
 * The shell's side of JudgeAgentPort: one call to the tool-less `qa-judge` role of the OpenCode runtime. The call opens a session in an
 * empty directory, sends the prompt with every tool switched off (on top of the role's own denial in agents/opencode.json), reads the
 * answer and closes the session. It is not part of the run's trace or its agent_turns (the judge belongs to no run); the tokens it
 * reports feed the day's budget in the judge ledger.
 *
 * The role is deliberately NOT in the role table (src/agent-runtime/types.ts): that table is what the facade routes a run's roles by, and
 * a judge is not routed by a run's assignment. Which model answers is the `qa-judge` block of agents/opencode.json, and nothing here names one.
 */

import type { AgentDeps, AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";
import type { JudgeAgentPort, JudgeAnswer } from "@contexts/evaluation/application/ports/judge-ports";

/* The key of the judge role in agents/opencode.json and the stem of agents/agent/qa-judge.md. */
export const JUDGE_AGENT_NAME = "qa-judge";

export interface JudgeAgentDeps {
  deps: () => Promise<AgentDeps>;
  /* The empty directory the session opens in, visible to the agents container. */
  workDir: () => string;
  timeoutMs: number;
}

const sum = (values: ReadonlyArray<number | null>): number | null => (values.every((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0));

export function createJudgeAgent(d: JudgeAgentDeps): JudgeAgentPort {
  return {
    async ask(prompt: string, signal?: AbortSignal): Promise<JudgeAnswer> {
      const deps = await d.deps();
      let turn: AgentTurnEvent | undefined;
      const session = await deps.open(JUDGE_AGENT_NAME, d.workDir(), {
        timeoutMs: d.timeoutMs,
        ...(signal ? { signal } : {}),
        onTurn: (t) => {
          turn = t;
        },
        descriptor: { role: JUDGE_AGENT_NAME, liveObservation: false },
      });
      try {
        const output = await session.prompt(prompt, { withoutTools: true });
        return {
          output,
          tokens: turn ? sum([turn.tokensInput, turn.tokensOutput, turn.tokensReasoning]) : null,
          model: turn?.modelAnswered ?? undefined,
        };
      } finally {
        await session.dispose();
      }
    },
  };
}
