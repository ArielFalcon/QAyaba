import { test } from "node:test";
import assert from "node:assert/strict";
import { createJudgeAgent, JUDGE_AGENT_NAME } from "./judge-agent";
import type { AgentDeps, AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";

interface Opened {
  agent: string;
  cwd: string;
  opts: Parameters<AgentDeps["open"]>[2];
  prompts: Array<{ text: string; opts: unknown }>;
  disposed: boolean;
}

function fakeDeps(script: { output?: string; turn?: Partial<AgentTurnEvent>; throwOnPrompt?: Error } = {}): { deps: AgentDeps; opened: Opened[] } {
  const opened: Opened[] = [];
  const deps: AgentDeps = {
    open: async (agent, cwd, opts) => {
      const record: Opened = { agent, cwd, opts, prompts: [], disposed: false };
      opened.push(record);
      return {
        id: "s1",
        prompt: async (text, promptOpts) => {
          record.prompts.push({ text, opts: promptOpts });
          if (script.throwOnPrompt) throw script.throwOnPrompt;
          opts?.onTurn?.({ tokensInput: 100, tokensOutput: 20, tokensReasoning: 5, modelAnswered: "prov/answering", ...script.turn } as AgentTurnEvent);
          return script.output ?? '{"verdict":"pass","critique":"ok"}';
        },
        dispose: async () => {
          record.disposed = true;
        },
      };
    },
  };
  return { deps, opened };
}

const make = (deps: AgentDeps) => createJudgeAgent({ deps: async () => deps, workDir: () => "/mirrors/.qa-judge", timeoutMs: 90_000 });

test("a judge call opens the judge role in the empty work directory, sends the prompt with every tool off and returns the text", async () => {
  const { deps, opened } = fakeDeps();
  const answer = await make(deps).ask("question");
  assert.equal(answer.output, '{"verdict":"pass","critique":"ok"}');
  const [session] = opened;
  assert.equal(session?.agent, JUDGE_AGENT_NAME);
  assert.equal(session?.cwd, "/mirrors/.qa-judge");
  assert.equal((session?.prompts[0]?.opts as { withoutTools?: boolean }).withoutTools, true, "the per-prompt denial is on top of the role's own");
  assert.equal(session?.opts?.timeoutMs, 90_000);
  assert.equal(session?.opts?.descriptor?.liveObservation, false);
});

test("the call reports the tokens the turn used and the model that answered", async () => {
  const { deps } = fakeDeps();
  const answer = await make(deps).ask("q");
  assert.equal(answer.tokens, 125);
  assert.equal(answer.model, "prov/answering");
});

test("a runtime that reports no usage or model leaves both unknown instead of zero", async () => {
  const { deps } = fakeDeps({ turn: { tokensInput: null, tokensOutput: null, tokensReasoning: null, modelAnswered: null } });
  const answer = await make(deps).ask("q");
  assert.equal(answer.tokens, null);
  assert.equal(answer.model, undefined);
});

test("the session is closed after the call, also when the prompt fails, and the failure reaches the caller", async () => {
  const { deps, opened } = fakeDeps({ throwOnPrompt: new Error("provider 529") });
  await assert.rejects(() => make(deps).ask("q"), /provider 529/);
  assert.equal(opened[0]?.disposed, true);
  const ok = fakeDeps();
  await make(ok.deps).ask("q");
  assert.equal(ok.opened[0]?.disposed, true);
});

test("the caller's abort signal is handed to the session", async () => {
  const { deps, opened } = fakeDeps();
  const controller = new AbortController();
  await make(deps).ask("q", controller.signal);
  assert.equal(opened[0]?.opts?.signal, controller.signal);
});
