import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { OpencodeRunInput, StepLimitRole } from "@contexts/generation/application/ports/generation-ports.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { ExplorerBriefSessionAdapter } from "@contexts/generation/infrastructure/explorer-brief-session.adapter.ts";

const staticCtx = {
  repo: "org/demo",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234-run1",
  needsReview: true,
  target: "e2e" as const,
  mode: "diff" as const,
  appName: "demo",
  timeoutMs: 60_000,
};

function fakeRuntime(session: AgentSession, opens: unknown[] = []): AgentRuntimePort {
  return {
    openSession: async (role, cwd, opts) => {
      opens.push({ role, cwd, opts });
      return session;
    },
  };
}

test("explore(): opens an explorer session, sends the built prompt, and parses the reply into a brief", async () => {
  const opens: unknown[] = [];
  let disposed = false;
  let promptSeen = "";
  const session: AgentSession = {
    prompt: async (text) => {
      promptSeen = text;
      return { output: '{"builtForSha":"deadbeef","objective":"orders","blastRadius":[]}' };
    },
    dispose: async () => {
      disposed = true;
    },
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session, opens),
    parseBrief: (text) => (text.includes("deadbeef") ? { builtForSha: "deadbeef", objective: "orders", blastRadius: [] } : null),
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.deepEqual(brief, { builtForSha: "deadbeef", objective: "orders", blastRadius: [] });
  assert.equal(disposed, true, "dispose must run on the success path");
  assert.match(promptSeen, /deadbeef/, "the built prompt must carry the given sha");
  assert.deepEqual(opens, [
    { role: "explorer", cwd: "/mirrors/org__demo", opts: { timeoutMs: 60_000, timeLimit: "explorer-timeout", descriptor: { role: "qa-explorer", liveObservation: false } } },
  ]);
});

test("explore(): tags the session descriptor with the given runId so the explorer's turns persist attributed to the run", async () => {
  const opens: unknown[] = [];
  const session: AgentSession = {
    prompt: async () => ({ output: '{"builtForSha":"deadbeef","objective":"orders","blastRadius":[]}' }),
    dispose: async () => {},
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session, opens),
    parseBrief: (text) => (text.includes("deadbeef") ? { builtForSha: "deadbeef", objective: "orders", blastRadius: [] } : null),
  });

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef", runId: "run-abc123" });

  assert.deepEqual((opens[0] as { opts: { descriptor: { runId?: string } } }).opts.descriptor, {
    role: "qa-explorer",
    runId: "run-abc123",
    liveObservation: false,
  });
});

test("explore(): with no runId, the descriptor omits it (never fabricated)", async () => {
  const opens: unknown[] = [];
  const session: AgentSession = {
    prompt: async () => ({ output: '{"builtForSha":"deadbeef","objective":"orders","blastRadius":[]}' }),
    dispose: async () => {},
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session, opens),
    parseBrief: (text) => (text.includes("deadbeef") ? { builtForSha: "deadbeef", objective: "orders", blastRadius: [] } : null),
  });

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  const descriptor = (opens[0] as { opts: { descriptor: Record<string, unknown> } }).opts.descriptor;
  assert.equal("runId" in descriptor, false);
});

test("explore(): a session that throws on open resolves to undefined (fail-open), never propagates", async () => {
  const runtime: AgentRuntimePort = {
    openSession: async () => {
      throw new Error("opencode serve unreachable");
    },
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime,
    parseBrief: () => null,
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(brief, undefined);
});

test("explore(): prompt() throwing still disposes the session and resolves to undefined", async () => {
  let disposed = false;
  const session: AgentSession = {
    prompt: async () => {
      throw new Error("turn timed out");
    },
    dispose: async () => {
      disposed = true;
    },
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => null,
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(brief, undefined);
  assert.equal(disposed, true, "dispose must run even when prompt() throws");
});

test("explore(): the run's spent deadline is not fail-open: it propagates, and the session is still disposed", async () => {
  for (const where of ["open", "prompt"] as const) {
    let disposed = false;
    const deadline = new RunDeadlineExceededError(600_000, "diff", "explorer", "before-turn");
    const session: AgentSession = {
      prompt: async () => {
        throw deadline;
      },
      dispose: async () => {
        disposed = true;
      },
    };
    const runtime: AgentRuntimePort = where === "open"
      ? { openSession: async () => { throw deadline; } }
      : fakeRuntime(session);
    const adapter = new ExplorerBriefSessionAdapter(staticCtx, { runtime, parseBrief: () => null });

    await assert.rejects(adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" }), RunDeadlineExceededError, where);
    if (where === "prompt") assert.equal(disposed, true);
  }
});

test("explore(): a parse failure (null) resolves to undefined, still disposes", async () => {
  let disposed = false;
  const session: AgentSession = {
    prompt: async () => ({ output: "not json at all" }),
    dispose: async () => {
      disposed = true;
    },
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => null,
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(brief, undefined);
  assert.equal(disposed, true);
});

test("explore(): a dispose() failure after a successful parse keeps the brief", async () => {
  const session: AgentSession = {
    prompt: async () => ({ output: '{"builtForSha":"deadbeef","objective":"orders","blastRadius":[]}' }),
    dispose: async () => {
      throw new Error("dispose: session already gone");
    },
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => ({ builtForSha: "deadbeef", objective: "orders", blastRadius: [] }),
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(brief?.objective, "orders");
});

test("explore(): a dispose() failure after a failed prompt still resolves to undefined, never propagates", async () => {
  const session: AgentSession = {
    prompt: async () => {
      throw new Error("turn timed out");
    },
    dispose: async () => {
      throw new Error("dispose: session already gone");
    },
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => null,
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(brief, undefined);
});

test("explore(): threads triggerService via the injected serviceContextDir formula, keyed on the call-time cwd", async () => {
  let promptSeen = "";
  const session: AgentSession = {
    prompt: async (text) => {
      promptSeen = text;
      return { output: "{}" };
    },
    dispose: async () => {},
  };
  const adapter = new ExplorerBriefSessionAdapter(
    { ...staticCtx, triggerService: { repo: "org/orders-svc", openapi: "openapi.yaml" } },
    {
      runtime: fakeRuntime(session),
      parseBrief: () => null,
      serviceContextDir: (workingCopyDir, repo) => `${workingCopyDir}/e2e/.qa/service-context/${repo.replaceAll("/", "__")}`,
    },
  );

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.match(promptSeen, /org\/orders-svc/, "the prompt must mention the triggering service repo");
  assert.match(promptSeen, /\/mirrors\/org__demo\/e2e\/\.qa\/service-context\/org__orders-svc/, "mirrorDir must come from the injected serviceContextDir, keyed on the per-call cwd");
});

test("explore(): no serviceContextDir dep + triggerService set → omits the service section (never throws for a missing collaborator)", async () => {
  let promptSeen = "";
  const session: AgentSession = {
    prompt: async (text) => {
      promptSeen = text;
      return { output: "{}" };
    },
    dispose: async () => {},
  };
  const adapter = new ExplorerBriefSessionAdapter(
    { ...staticCtx, triggerService: { repo: "org/orders-svc" } },
    { runtime: fakeRuntime(session), parseBrief: () => null },
  );

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.doesNotMatch(promptSeen, /org\/orders-svc/);
});

test("explore(): forwards the abort signal to openSession", async () => {
  const opens: Array<{ opts?: { signal?: AbortSignal } }> = [];
  const controller = new AbortController();
  const session: AgentSession = { prompt: async () => ({ output: "{}" }), dispose: async () => {} };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session, opens),
    parseBrief: () => null,
  });

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef", signal: controller.signal });

  assert.strictEqual((opens[0] as { opts?: { signal?: AbortSignal } }).opts?.signal, controller.signal);
});

/* The explorer's session runs under a step limit of its own: the shell resolves it from the live runtime and the
   adapter carries it onto the input its prompt is built from. With no resolver, or none for the role, the input
   has no such key (absence is what tells the prompt not to state a limit). */

const idleSession: AgentSession = { prompt: async () => ({ output: "{}" }), dispose: async () => {} };

test("explore(): the explorer's own limit from the resolver reaches the prompt input, asking for the explorer role and for no other", async () => {
  const inputs: OpencodeRunInput[] = [];
  const asked: StepLimitRole[] = [];
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(idleSession),
    parseBrief: () => null,
    buildPrompt: (input) => {
      inputs.push(input);
      return "PROMPT";
    },
    stepLimitFor: async (role) => {
      asked.push(role);
      return role === "explorer" ? 9 : 41;
    },
  });

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(inputs[0]?.stepLimit, 9);
  assert.deepEqual(asked, ["explorer"]);
});

test("explore(): with no resolver, or none for the explorer, the prompt input carries no limit key", async () => {
  const inputs: OpencodeRunInput[] = [];
  const buildPrompt = (input: OpencodeRunInput): string => {
    inputs.push(input);
    return "PROMPT";
  };
  const noResolver = new ExplorerBriefSessionAdapter(staticCtx, { runtime: fakeRuntime(idleSession), parseBrief: () => null, buildPrompt });
  const noLimit = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(idleSession),
    parseBrief: () => null,
    buildPrompt,
    stepLimitFor: async () => undefined,
  });

  await noResolver.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });
  await noLimit.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(inputs.length, 2);
  for (const input of inputs) assert.equal("stepLimit" in input, false);
});

/* The prompt that states the explorer's limit is sent with that limit as an option, so the turn is classified against the number the prompt stated. */

test("explore(): the prompt is sent with the explorer's limit as an option, beside the text-only option it already carried", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const session: AgentSession = {
    prompt: async (_text, opts) => {
      sent.push(opts as Record<string, unknown> | undefined);
      return { output: "{}" };
    },
    dispose: async () => {},
  };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => null,
    stepLimitFor: async (role) => (role === "explorer" ? 9 : 41),
  });

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.stepLimit, 9);
  assert.equal(sent[0]?.textOnly, true);
});

test("explore(): with no resolver, or none for the explorer, the prompt is sent with no limit key", async () => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  const session: AgentSession = {
    prompt: async (_text, opts) => {
      sent.push(opts as Record<string, unknown> | undefined);
      return { output: "{}" };
    },
    dispose: async () => {},
  };
  const noResolver = new ExplorerBriefSessionAdapter(staticCtx, { runtime: fakeRuntime(session), parseBrief: () => null });
  const noLimit = new ExplorerBriefSessionAdapter(staticCtx, { runtime: fakeRuntime(session), parseBrief: () => null, stepLimitFor: async () => undefined });

  await noResolver.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });
  await noLimit.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(sent.length, 2);
  for (const opts of sent) {
    assert.equal("stepLimit" in (opts ?? {}), false);
    assert.equal(opts?.textOnly, true);
  }
});

test("explore(): a resolver that fails keeps the pass fail-open (no brief, no throw) and no session is spent on it", async () => {
  const opens: unknown[] = [];
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(idleSession, opens),
    parseBrief: () => ({ builtForSha: "deadbeef", objective: "orders", blastRadius: [] }),
    stepLimitFor: async () => {
      throw new Error("limit read failed");
    },
  });

  const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(brief, undefined);
  assert.deepEqual(opens, [], "the limit is resolved before a session is opened, so a slow or failed read never holds one");
});

/* The explorer maps the blast radius of something: a commit's diff, or the guidance of a manual run. A run with neither has nothing to map, and an explorer sent after a change that is not there spends its whole step budget looking for it. */
for (const mode of ["context", "complete", "exhaustive"] as const) {
  test(`explore(): a ${mode} run has no change to explore, so no session is opened and no brief is made`, async () => {
    const opens: unknown[] = [];
    const resolved: string[] = [];
    const session: AgentSession = {
      prompt: async () => { throw new Error("the explorer must not be prompted"); },
      dispose: async () => {},
    };
    const adapter = new ExplorerBriefSessionAdapter({ ...staticCtx, mode }, {
      runtime: fakeRuntime(session, opens),
      parseBrief: () => { throw new Error("nothing to parse"); },
      stepLimitFor: async (role) => { resolved.push(role); return 25; },
    });

    const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

    assert.equal(brief, undefined);
    assert.deepEqual(opens, []);
    assert.deepEqual(resolved, [], "no limit is read for a session that is never opened");
  });
}

for (const mode of ["diff", "manual"] as const) {
  test(`explore(): a ${mode} run has something to explore, so the explorer session is opened`, async () => {
    const opens: unknown[] = [];
    const session: AgentSession = {
      prompt: async () => ({ output: "{}" }),
      dispose: async () => {},
    };
    const adapter = new ExplorerBriefSessionAdapter({ ...staticCtx, mode, guidance: "test the contact form" }, {
      runtime: fakeRuntime(session, opens),
      parseBrief: () => ({ builtForSha: "deadbeef", objective: "contact", blastRadius: [] }),
    });

    const brief = await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef", diff: "diff --git a/x b/x" });

    assert.equal(brief?.objective, "contact");
    assert.equal(opens.length, 1);
  });
}

test("explore(): hands the context map to the prompt it builds, so the explorer sees the routes of the app", async () => {
  let built: OpencodeRunInput | undefined;
  const session: AgentSession = { prompt: async () => ({ output: "{}" }), dispose: async () => {} };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => null,
    buildPrompt: (input) => { built = input; return "prompt"; },
  });
  const contextMap = { builtAtSha: "abc1234", routes: [{ path: "/shops/:province/:city" }], api: [], feBe: [] };

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef", contextMap });

  assert.deepEqual(built?.contextMap?.routes, contextMap.routes);
});

test("explore(): with no context map the prompt input carries none", async () => {
  let built: OpencodeRunInput | undefined;
  const session: AgentSession = { prompt: async () => ({ output: "{}" }), dispose: async () => {} };
  const adapter = new ExplorerBriefSessionAdapter(staticCtx, {
    runtime: fakeRuntime(session),
    parseBrief: () => null,
    buildPrompt: (input) => { built = input; return "prompt"; },
  });

  await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef" });

  assert.equal(built?.contextMap, undefined);
});

test("explore(): asks for unwatched observation of its session only when its host enables it, and the descriptor is otherwise exactly as before", async () => {
  const session: AgentSession = { prompt: async () => ({ output: "{}" }), dispose: async () => {} };
  const run = async (observeUnwatched: boolean | undefined) => {
    const opens: Array<{ opts?: { descriptor?: Record<string, unknown> } }> = [];
    const adapter = new ExplorerBriefSessionAdapter(staticCtx, { runtime: fakeRuntime(session, opens), parseBrief: () => null, ...(observeUnwatched !== undefined ? { observeUnwatched } : {}) });
    await adapter.explore({ specDir: "/mirrors/org__demo/e2e", sha: "deadbeef", runId: "run-1" });
    return opens[0]!.opts!.descriptor!;
  };
  assert.deepEqual(await run(undefined), { role: "qa-explorer", runId: "run-1", liveObservation: false });
  assert.deepEqual(await run(false), { role: "qa-explorer", runId: "run-1", liveObservation: false });
  assert.deepEqual(await run(true), { role: "qa-explorer", runId: "run-1", liveObservation: false, observeUnwatched: true });
});
