import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
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
  assert.deepEqual(opens, [{ role: "explorer", cwd: "/mirrors/org__demo", opts: { timeoutMs: 60_000, descriptor: { role: "qa-explorer" } } }]);
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
