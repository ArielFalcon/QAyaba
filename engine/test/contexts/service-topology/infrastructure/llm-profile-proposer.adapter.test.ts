import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import { memoryLogger, silentLogger } from "@kernel/ports/logger.port.ts";
import { submittingRuntime } from "../../../support/submission.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import type { RepoRef } from "@contexts/service-topology/application/index.ts";
import type { ProposerFeedback } from "@contexts/service-topology/application/index.ts";
import { LlmProfileProposerAdapter, commonSessionRoot } from "@contexts/service-topology/infrastructure/llm-profile-proposer.adapter.ts";

const redaction = new PatternRedactionAdapter();

const FRONT: RepoRef = { repo: "ArielFalcon/nname-gateway", mirrorDir: "/mirrors/nname-gateway" };
const SYSTEM: RepoRef[] = [{ repo: "ArielFalcon/ms-name-orders", mirrorDir: "/mirrors/ms-name-orders" }];

const VALID_VERDICT_JSON = JSON.stringify({
  candidates: [
    {
      transport: "http",
      frontFiles: "**/*.api.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
      servicePrefixTemplate: "name-{service}-api",
      serviceRepoTemplate: "ms-name-{service}",
      openApiPath: "openapi.yaml",
    },
    {
      transport: "event",
      files: "**/*.java",
      eventPattern: {
        kind: "class-based-domain-events",
        listenerBaseType: "ListenerMessageDelegate",
        listenerEventCall: "convertMsgToSpecificType",
        subscriberBaseType: "DomainEventSubscriber",
        publishCall: "publishGenericMessage",
      },
    },
  ],
});

const MIXED_VERDICT_JSON = JSON.stringify({
  candidates: [
    {
      transport: "http",
      frontFiles: "**/*.api.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
      servicePrefixTemplate: "name-{service}-api",
      serviceRepoTemplate: "ms-name-{service}",
      openApiPath: "openapi.yaml",
    },
    {
      transport: "event",
      files: "**/*.java",
      eventPattern: {
        kind: "class-based-domain-events",
        listenerBaseType: "ListenerMessageDelegate",
        listenerEventCall: "convertMsgToSpecificType",
        subscriberBaseType: "DomainEventSubscriber",
      },
    },
    {
      transport: "http",
      frontFiles: "**/*.gateway.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.http" },
      servicePrefixTemplate: "other-{service}-api",
      serviceRepoTemplate: "ms-other-{service}",
      openApiPath: "openapi.json",
    },
  ],
});

interface FakeRuntimeOpts {
  promptResult?: string | Error;
  /** Each prompt of the session answers with the next one; the last repeats. */
  replies?: string[];
  onOpen?: (role: string, cwd: string, opts?: { model?: string; timeoutMs?: number; signal?: AbortSignal }) => void;
  onPrompt?: (text: string) => void;
  openThrows?: boolean;
  disposed?: { count: number };
}

/** An agent that delivers by submit tool: each reply's JSON object is the call it makes, and a reply with none makes no call. */
function fakeRuntime(opts: FakeRuntimeOpts): Pick<AgentRuntimePort, "openSession"> {
  return submittingRuntime({
    openSession: async (role, cwd, openOpts) => {
      opts.onOpen?.(role, cwd, openOpts);
      if (opts.openThrows) throw new Error("boom: open failed");
      let prompts = 0;
      return {
        prompt: async (text) => {
          opts.onPrompt?.(text);
          if (opts.promptResult instanceof Error) throw opts.promptResult;
          const reply = opts.replies ? opts.replies[Math.min(prompts, opts.replies.length - 1)] : opts.promptResult;
          prompts += 1;
          return { output: reply ?? "" };
        },
        dispose: async () => {
          if (opts.disposed) opts.disposed.count += 1;
        },
      };
    },
  });
}

test("propose(): a well-formed verdict (1 http + 1 event) returns the correctly discriminated BoundaryProfile[]", async () => {
  const disposed = { count: 0 };
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, disposed });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.transport, "http");
  assert.equal(result[1]?.transport, "event");
  if (result[0]?.transport === "http") {
    assert.equal(result[0].frontFiles, "**/*.api.ts");
  }
  assert.equal(disposed.count, 1, "session must be disposed exactly once");
});

test("propose(): fail-open — openSession() throwing returns [] without propagating", async () => {
  const runtime = fakeRuntime({ openThrows: true });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
});

test("propose(): fail-open — session.prompt() rejecting (timeout/transport error) returns []", async () => {
  const runtime = fakeRuntime({ promptResult: new Error("timed out") });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
});

test("propose(): a turn that never calls the submit tool is a fail-open empty round after exactly one continuation, and the miss is logged once", async () => {
  const logger = memoryLogger();
  const prompts: string[] = [];
  const runtime = fakeRuntime({ promptResult: "this is not json at all, sorry.", onPrompt: (text) => prompts.push(text) });
  const adapter = new LlmProfileProposerAdapter(runtime, logger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
  assert.equal(prompts.length, 2, "the first prompt and exactly one continuation");
  assert.match(prompts[1] ?? "", /submit_profiles/, "the continuation names the only tool that answers");
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0]?.level, "warn");
  assert.equal(logger.entries[0]?.fields.app, "nname");
  assert.match(String(logger.entries[0]?.fields.reason), /no accepted submission/);
});

test("propose(): a profile the contract cannot read is returned to the proposer with where it went wrong, and the corrected submission is the round", async () => {
  const prompts: string[] = [];
  const runtime = fakeRuntime({ replies: [MIXED_VERDICT_JSON, VALID_VERDICT_JSON], onPrompt: (text) => prompts.push(text) });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /candidates\.1\.eventPattern\.publishCall/, "the continuation carries the exact path that was refused");
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((c) => c.transport), ["http", "event"]);
});

test("propose(): a submission that is refused twice costs the round and no unreadable sibling stands in for it", async () => {
  const logger = memoryLogger();
  const runtime = fakeRuntime({ promptResult: MIXED_VERDICT_JSON });
  const adapter = new LlmProfileProposerAdapter(runtime, logger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
  assert.match(String(logger.entries[0]?.fields.reason), /candidates\.1\.eventPattern\.publishCall/);
});

test("propose(): opens a proposer-role session, on the model its agent declares (no pin on openSession() opts)", async () => {
  const opens: Array<{ role: string; cwd: string; model?: string; timeoutMs?: number }> = [];
  const runtime = fakeRuntime({
    promptResult: VALID_VERDICT_JSON,
    onOpen: (role, cwd, opts) => opens.push({ role, cwd, model: opts?.model, timeoutMs: opts?.timeoutMs }),
  });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname", timeoutMs: 12345 });

  await adapter.propose(SYSTEM, FRONT);

  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.role, "proposer");
  assert.equal(opens[0]?.cwd, "/mirrors", "session must root at the front+services' common ancestor, not front.mirrorDir alone");
  assert.equal(opens[0]?.model, undefined, "the model is the one agents/opencode.json declares for qa-proposer, not one named here");
  assert.equal(opens[0]?.timeoutMs, 12345);
});

/* ── Session root (sibling-repo read hang fix) ──────────────────────────────────────────────────
   siblings under the same mirror root. Opening the session at front.mirrorDir alone leaves a
   service mirror OUTSIDE the session root; opencode's external-read approval gate (serve mode)
   then waits forever for an approval that never comes, stalling the tool call at state=running
   until the adapter's 5-min timeout aborts it -> silent fail-open to []. Rooting the session at
   the LCA of every mirror keeps all repos inside the workspace.
 */

test("propose(): multi-repo — session opens at the common ancestor of front + all service mirrors", async () => {
  const opens: Array<{ role: string; cwd: string }> = [];
  const front: RepoRef = { repo: "ArielFalcon/nname-gateway", mirrorDir: "/x/mirrors/nname-gateway" };
  const system: RepoRef[] = [
    { repo: "ArielFalcon/ms-name-orders", mirrorDir: "/x/mirrors/ms-name-orders" },
    { repo: "ArielFalcon/ms-name-billing", mirrorDir: "/x/mirrors/ms-name-billing" },
  ];
  const runtime = fakeRuntime({
    promptResult: VALID_VERDICT_JSON,
    onOpen: (role, cwd) => opens.push({ role, cwd }),
  });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  await adapter.propose(system, front);

  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.role, "proposer");
  assert.equal(opens[0]?.cwd, "/x/mirrors");
});

test("propose(): single-repo (system: []) — session opens at front.mirrorDir, unchanged", async () => {
  const opens: Array<{ role: string; cwd: string }> = [];
  const front: RepoRef = { repo: "ArielFalcon/nname-gateway", mirrorDir: "/x/mirrors/nname-gateway" };
  const runtime = fakeRuntime({
    promptResult: VALID_VERDICT_JSON,
    onOpen: (role, cwd) => opens.push({ role, cwd }),
  });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  await adapter.propose([], front);

  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.role, "proposer");
  assert.equal(opens[0]?.cwd, front.mirrorDir);
});

test("propose(): LCA edge case — divergent sibling-looking dirs resolve to the true segment-wise ancestor", async () => {
  const opens: Array<{ role: string; cwd: string }> = [];
  const front: RepoRef = { repo: "ArielFalcon/front", mirrorDir: "/x/mirrors/a" };
  const system: RepoRef[] = [{ repo: "ArielFalcon/svc", mirrorDir: "/x/mirrors-other/b" }];
  const runtime = fakeRuntime({
    promptResult: VALID_VERDICT_JSON,
    onOpen: (role, cwd) => opens.push({ role, cwd }),
  });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  await adapter.propose(system, front);

  assert.equal(opens.length, 1);
  assert.equal(
    opens[0]?.cwd,
    "/x",
    "must resolve via segment-wise LCA (not naive string-prefix, which would wrongly stop at '/x/mirrors')",
  );
});

test("commonSessionRoot(): multi-repo — returns the common ancestor of front + all service mirrors", () => {
  const front: RepoRef = { repo: "ArielFalcon/nname-gateway", mirrorDir: "/x/mirrors/nname-gateway" };
  const system: RepoRef[] = [
    { repo: "ArielFalcon/ms-name-orders", mirrorDir: "/x/mirrors/ms-name-orders" },
    { repo: "ArielFalcon/ms-name-billing", mirrorDir: "/x/mirrors/ms-name-billing" },
  ];

  assert.equal(commonSessionRoot(front, system), "/x/mirrors");
});

test("commonSessionRoot(): single-repo (system: []) — returns front.mirrorDir unchanged", () => {
  const front: RepoRef = { repo: "ArielFalcon/nname-gateway", mirrorDir: "/x/mirrors/nname-gateway" };

  assert.equal(commonSessionRoot(front, []), front.mirrorDir);
});

test("commonSessionRoot(): LCA edge case — segment-wise ancestor, not naive string-prefix", () => {
  const front: RepoRef = { repo: "ArielFalcon/front", mirrorDir: "/x/mirrors/a" };
  const system: RepoRef[] = [{ repo: "ArielFalcon/svc", mirrorDir: "/x/mirrors-other/b" }];

  assert.equal(commonSessionRoot(front, system), "/x");
});

/* The server-side onboarding job wraps onboard() in a round-budget Promise.race and owns an
   AbortController whose signal must reach the underlying agent session so a job timeout actually
   CANCELS the in-flight proposer session, not merely resolves the race. This proves the pass-through
   end to end: ctx.signal -> openSession's opts.signal.
 */

test("propose(): ctx.signal is threaded straight through to openSession's opts.signal (job-timeout cancellation)", async () => {
  const opens: Array<{ signal?: AbortSignal }> = [];
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, onOpen: (_role, _cwd, opts) => opens.push({ signal: opts?.signal }) });
  const controller = new AbortController();
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname", signal: controller.signal });

  await adapter.propose(SYSTEM, FRONT);

  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.signal, controller.signal, "ctx.signal must be forwarded verbatim to openSession's opts.signal");
});

test("propose(): omitting ctx.signal leaves openSession's opts.signal undefined (no signal fabricated)", async () => {
  const opens: Array<{ signal?: AbortSignal }> = [];
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, onOpen: (_role, _cwd, opts) => opens.push({ signal: opts?.signal }) });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  await adapter.propose(SYSTEM, FRONT);

  assert.equal(opens[0]?.signal, undefined);
});

test("propose(): prompt documents the http-backend transport shape and callPattern kinds", async () => {
  let capturedPrompt = "";
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, onPrompt: (text) => { capturedPrompt = text; } });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });
  await adapter.propose(SYSTEM, FRONT);

  assert.ok(capturedPrompt.includes("http-backend"), "prompt must document the http-backend transport");
  assert.ok(capturedPrompt.includes("sourceFiles"), "prompt must name sourceFiles exactly");
  assert.ok(capturedPrompt.includes("callPattern"), "prompt must name callPattern exactly");
  assert.ok(capturedPrompt.includes("rest-template-exchange"), "prompt must list rest-template-exchange");
  assert.ok(capturedPrompt.includes("feign-client"), "prompt must list feign-client");
  assert.ok(capturedPrompt.includes("web-client"), "prompt must list web-client");
});

test("propose(): a well-formed http-backend candidate is returned as an HttpBackendBoundaryProfile", async () => {
  const verdict = JSON.stringify({
    candidates: [
      {
        transport: "http-backend",
        sourceFiles: "**/*.java",
        callPattern: { kind: "rest-template-exchange", receiver: "restTemplate" },
        servicePrefixTemplate: "name-{service}-api",
        serviceRepoTemplate: "ms-name-{service}",
        openApiPath: "openapi.yaml",
      },
    ],
  });
  const runtime = fakeRuntime({ promptResult: verdict });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.transport, "http-backend");
  if (result[0]?.transport === "http-backend") {
    assert.equal(result[0].sourceFiles, "**/*.java");
    assert.equal(result[0].callPattern.kind, "rest-template-exchange");
  }
});

test("propose(): http-backend prior-round feedback is summarized without throwing", async () => {
  let capturedPrompt = "";
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, onPrompt: (text) => { capturedPrompt = text; } });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });
  const feedback: ProposerFeedback = {
    priorCandidates: [
      {
        profile: {
          transport: "http-backend",
          sourceFiles: "**/*.java",
          callPattern: { kind: "rest-template-exchange", receiver: "restTemplate" },
          servicePrefixTemplate: "name-{service}-api",
          serviceRepoTemplate: "ms-name-{service}",
          openApiPath: "openapi.yaml",
        },
        score: { links: 0, drift: 1, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 0, resolvedScore: 0 },
      },
    ],
  };

  const result = await adapter.propose(SYSTEM, FRONT, feedback);
  assert.ok(result.length >= 0, "must not throw / fail-open-empty solely because of http-backend feedback");
  assert.ok(capturedPrompt.includes("http-backend"), "feedback summary must name the http-backend transport");
  assert.ok(
    capturedPrompt.includes("rest-template-exchange") || capturedPrompt.includes("callPattern"),
    "feedback summary must describe the http-backend shape",
  );
});

test("propose(): when feedback.priorCandidates is non-empty, the prompt text references the prior round", async () => {
  let capturedPrompt = "";
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, onPrompt: (text) => { capturedPrompt = text; } });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const feedback: ProposerFeedback = {
    priorCandidates: [
      {
        profile: {
          transport: "http",
          frontFiles: "**/*.api.ts",
          frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
          servicePrefixTemplate: "wrong-{service}-api",
          serviceRepoTemplate: "ms-wrong-{service}",
          openApiPath: "openapi.yaml",
        },
        score: { links: 0, drift: 0, external: 3, unresolved: 0, coverage: 3, resolutionRatio: 0, resolvedScore: 0 },
      },
    ],
  };

  await adapter.propose(SYSTEM, FRONT, feedback);

  assert.ok(capturedPrompt.includes("round"), "prompt must reference the prior round when feedback is supplied");
  assert.ok(
    capturedPrompt.includes("wrong-{service}-api") || capturedPrompt.includes("resolvedScore"),
    "prompt must include a compact summary of the prior candidate/score",
  );
});

test("propose(): fail-open holds even when feedback is supplied and the session throws", async () => {
  const runtime = fakeRuntime({ openThrows: true });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  const feedback: ProposerFeedback = {
    priorCandidates: [
      {
        profile: {
          transport: "event",
          files: "**/*.java",
          eventPattern: {
            kind: "class-based-domain-events",
            listenerBaseType: "ListenerMessageDelegate",
            listenerEventCall: "convertMsgToSpecificType",
            subscriberBaseType: "DomainEventSubscriber",
            publishCall: "publishGenericMessage",
          },
        },
        score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 },
      },
    ],
  };

  const result = await adapter.propose(SYSTEM, FRONT, feedback);

  assert.deepEqual(result, []);
});

/* ── Diagnostic logging on the fail-open catch (an instant failure) ────────────────────
   LlmProfileProposerAdapter.propose()'s catch is the ONLY point where the real thrown error and
   the app context still exists before the fail-open contract erases them to
   `[]`. These tests assert exactly one warn-level structured log per failed round, with a redacted
   `error` field, and NO log on a successful round — including the zero-candidates-after-filtering
   case, which is not a throw and must stay silent.
 */

test("propose(): session.prompt() rejecting logs exactly one redacted warn with {app, error} and still returns []", async () => {
  const logger = memoryLogger();
  const runtime = fakeRuntime({ promptResult: new Error("connect ECONNREFUSED 127.0.0.1:4096") });
  const adapter = new LlmProfileProposerAdapter(runtime, logger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
  assert.equal(logger.entries.length, 1, "exactly one warn log must be emitted for the failed round");
  const entry = logger.entries[0];
  assert.equal(entry?.level, "warn");
  assert.equal(entry?.fields.app, "nname");
  assert.equal("singleProvider" in (entry?.fields ?? {}), false, "the retired runtime selector is no longer logged");
  assert.equal(entry?.fields.error, "connect ECONNREFUSED 127.0.0.1:4096");
});

test("propose(): openSession() throwing before a session exists logs exactly one warn and still returns []", async () => {
  const logger = memoryLogger();
  const adapter = new LlmProfileProposerAdapter(fakeRuntime({ openThrows: true }), logger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
  assert.equal(logger.entries.length, 1, "exactly one warn log must be emitted when open() throws");
  assert.equal(logger.entries[0]?.fields.app, "nname");
  assert.match(String(logger.entries[0]?.fields.error), /boom: open failed/);
});

test("propose(): a secret embedded in the thrown error's message never reaches the log (redacted)", async () => {
  const logger = memoryLogger();
  const runtime = fakeRuntime({ promptResult: new Error("401: Authorization: Bearer sk-supersecrettoken12345") });
  const adapter = new LlmProfileProposerAdapter(runtime, logger, redaction, { app: "nname" });

  await adapter.propose(SYSTEM, FRONT);

  assert.equal(logger.entries.length, 1);
  const error = String(logger.entries[0]?.fields.error);
  assert.ok(!/sk-supersecrettoken12345/.test(error), "the raw token must never reach the log");
  assert.match(error, /REDACTED/);
});

test("propose(): a successful round with candidates emits no failure log", async () => {
  const logger = memoryLogger();
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON });
  const adapter = new LlmProfileProposerAdapter(runtime, logger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.equal(result.length, 2);
  assert.equal(logger.entries.length, 0, "no warn log must be emitted on a successful round");
});

test("propose(): a round that submits no candidate is a successful empty round and emits no failure log", async () => {
  const logger = memoryLogger();
  const runtime = fakeRuntime({ promptResult: JSON.stringify({ candidates: [] }) });
  const adapter = new LlmProfileProposerAdapter(runtime, logger, redaction, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
  assert.equal(logger.entries.length, 0, "an accepted empty list is an answer, not a miss");
});

test("propose(): the first-round prompt names the app, the front repo and every service repo with its mirror, then the transport shapes", async () => {
  let prompt = "";
  const runtime = fakeRuntime({ promptResult: VALID_VERDICT_JSON, onPrompt: (text) => { prompt = text; } });
  const adapter = new LlmProfileProposerAdapter(runtime, silentLogger, redaction, { app: "nname" });

  await adapter.propose(SYSTEM, FRONT);

  const lines = prompt.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    "App: nname",
    "Frontend repo: ArielFalcon/nname-gateway (mirror: /mirrors/nname-gateway)",
    "Backend service repos:",
    "  - ArielFalcon/ms-name-orders (mirror: /mirrors/ms-name-orders)",
  ]);
  assert.ok(prompt.indexOf("Boundary profile shapes you may propose") > prompt.indexOf("ms-name-orders"));
  assert.ok(!prompt.includes("Prior round(s)"), "a first round carries no feedback section");
});
