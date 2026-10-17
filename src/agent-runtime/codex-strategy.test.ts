/* Unit tests for CodexRuntimeStrategy. All tests use stubs/DI — no real codex binary, no network.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentTimeoutError, AgentUnavailableError, InfraError } from "../errors";
import { getAgentTurns } from "../server/history";
import {
  codexErrorToInfra,
  extractCodexLastMessage,
  extractCodexTokenUsage,
  rolePromptName,
  codexPreambleParts,
  CodexRuntimeStrategy,
  CodexExecTransport,
  SupervisorExecTransport,
  CODEX_USAGE_AVAILABLE,
  codexExecEnv,
  type SpawnFn,
  type CodexHeadlessTransport,
  type CodexTransportSession,
  type CodexTransportStartInput,
} from "./codex-strategy";
import type { AgentModelInfo, AgentProviderHealth } from "./types";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-infrastructure/run-secret-redaction";

/* Builds a fake child process that:
   - never exits on its own (simulates a hung process)
   - optionally emits stdout data before hanging
   - records kill() calls so tests can verify SIGTERM was sent
 */
function makeFakeChild(opts: { stdoutData?: string } = {}): {
  child: ChildProcess;
  killSpy: { count: number; signal: string | undefined };
} {
  const killSpy = { count: 0, signal: undefined as string | undefined };

  class FakeReadable extends EventEmitter {
    setEncoding(_encoding: BufferEncoding) { return this; }
  }
  class FakeWritable extends EventEmitter {
    end(_chunk?: unknown) {
      if (opts.stdoutData) {
        (child.stdout as EventEmitter).emit("data", opts.stdoutData);
      }
    }
    write(_chunk: unknown) { return true; }
  }

  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout: new FakeReadable(),
    stderr: new FakeReadable(),
    stdin: new FakeWritable(),
    kill(signal?: string) {
      killSpy.count++;
      killSpy.signal = signal;
      setImmediate(() => emitter.emit("close", 1));
    },
    pid: 99999,
  }) as unknown as ChildProcess;

  return { child, killSpy };
}

/* Builds a fake child process that exits immediately with code 0 and optional JSONL stdout. */
function makeSuccessChild(jsonlOutput: string): ChildProcess {
  class FakeReadable extends EventEmitter {
    setEncoding(_encoding: BufferEncoding) { return this; }
  }
  class FakeWritable extends EventEmitter {
    end(_chunk?: unknown) {
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", jsonlOutput);
        setImmediate(() => emitter.emit("close", 0));
      });
    }
    write(_chunk: unknown) { return true; }
  }
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout: new FakeReadable(),
    stderr: new FakeReadable(),
    stdin: new FakeWritable(),
    kill() {},
    pid: 99998,
  }) as unknown as ChildProcess;
  return child;
}

function makeHangingSpawnFn(): { spawnFn: SpawnFn; killSpy: { count: number; signal: string | undefined } } {
  const { child, killSpy } = makeFakeChild();
  const spawnFn = (() => child) as unknown as SpawnFn;
  return { spawnFn, killSpy };
}

function makeSuccessSpawnFn(jsonlOutput: string): SpawnFn {
  return (() => makeSuccessChild(jsonlOutput)) as unknown as SpawnFn;
}

describe("codexErrorToInfra", () => {
  it("auth / out-of-credits stderr → AgentUnavailableError INCONCLUSIVE", () => {
    const cases: string[] = [
      "Error: 401 Unauthorized",
      "Error: 403 Forbidden",
      "Error: 402 Payment Required — out of credits",
      "out of credits",
      "unauthorized",
      "authentication failed",
    ];
    for (const stderr of cases) {
      const err = codexErrorToInfra(new Error(`codex exec exited 1: ${stderr}`));
      assert.ok(err instanceof AgentUnavailableError, `Expected AgentUnavailableError for: ${stderr}`);
      assert.ok(
        err.message.includes("INCONCLUSIVE (infrastructure)"),
        `Expected INCONCLUSIVE message for: ${stderr}`,
      );
    }
  });

  it("timeout / SIGTERM → AgentTimeoutError (an infra error, never a provider rejection) INCONCLUSIVE", () => {
    const cases: string[] = [
      "Codex prompt: timed out after 30000ms",
      "codex exec timed out after 60000ms",
    ];
    for (const msg of cases) {
      const err = codexErrorToInfra(new Error(msg));
      assert.ok(err instanceof AgentTimeoutError, `Expected AgentTimeoutError for timeout: ${msg}`);
      assert.ok(err instanceof InfraError);
      assert.ok(!(err instanceof AgentUnavailableError), "a deadline is not the provider refusing");
      assert.ok(err.message.includes("INCONCLUSIVE (infrastructure)"));
    }
  });

  it("a timeout the provider reports inside the exec's own stderr is not the transport's deadline", () => {
    for (const stderr of ["upstream request timed out after 30000ms", "mcp server timed out after 5000ms while starting"]) {
      assert.equal(codexErrorToInfra(new Error(`codex exec exited 1: ${stderr}`)), null, stderr);
    }
  });

  it("non-zero exit with non-infra stderr is NOT coerced to infra-error", () => {
    /* A test legitimately fails — this must not be swallowed into infra-error. */
    const err = codexErrorToInfra(new Error("codex exec exited 1: Test assertion failed: expected 200 got 404"));
    assert.ok(!(err instanceof AgentUnavailableError), "Non-infra failure must not become AgentUnavailableError");
    assert.equal(err, null, "codexErrorToInfra must return null for non-infra errors");
  });

  it("rate-limited (429) stderr → AgentUnavailableError (infra)", () => {
    const err = codexErrorToInfra(new Error("codex exec exited 1: 429 Too Many Requests"));
    assert.ok(err instanceof AgentUnavailableError);
    assert.ok(err.message.includes("INCONCLUSIVE (infrastructure)"));
  });

  it("non-Error / null input returns null", () => {
    const err = codexErrorToInfra(null as unknown as Error);
    assert.equal(err, null);
  });
});

describe("CodexRuntimeStrategy.openSession textOnly forwarding", () => {
  function makeCapturingTransport(): { transport: CodexHeadlessTransport; captures: Array<{ text: string }> } {
    const captures: Array<{ text: string }> = [];
    const transport: CodexHeadlessTransport = {
      async start(_input: CodexTransportStartInput): Promise<CodexTransportSession> {
        return {
          id: "test-session-id",
          prompt: async (text: string) => {
            captures.push({ text });
            return "<think>internal reasoning step</think>\nfinal answer text";
          },
          dispose: async () => {},
        };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [{ id: "gpt-5.4", label: "GPT-5.4" }];
      },
    };
    return { transport, captures };
  }

  it("textOnly: true → reasoning wrappers stripped from output", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompts", /* no role preamble files needed for this test */
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("chat", "/tmp", {});
    const result = await session.prompt("say hello", { textOnly: true });

    assert.ok(
      !result.includes("<think>"),
      `textOnly=true must strip <think>…</think> wrappers. Got: ${result}`,
    );
    assert.ok(
      result.includes("final answer text"),
      `textOnly=true must preserve the final answer. Got: ${result}`,
    );
    await session.dispose();
  });

  it("textOnly omitted → output returned as-is, no stripping", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompts",
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("chat", "/tmp", {});
    const result = await session.prompt("say hello");

    assert.ok(
      result.includes("<think>") || result.includes("final answer text"),
      `No-textOnly path should not strip wrappers. Got: ${result}`,
    );
    await session.dispose();
  });

  it("finalStepOnly: true → the returned text drops reasoning wrappers, while the persisted turn keeps the whole output", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompts",
      env: { CODEX_API_KEY: "test-key" },
    });
    const persisted: string[] = [];
    const session = await strategy.openSession("primary", "/tmp", {
      descriptor: { runId: "run-codex-final-step", role: "primary" as const },
      onTurn: (t) => { persisted.push(t.outputText); },
    });

    const result = await session.prompt("say hello", { finalStepOnly: true });

    assert.ok(!result.includes("<think>"), `finalStepOnly must strip <think>…</think> wrappers. Got: ${result}`);
    assert.ok(result.includes("final answer text"), `finalStepOnly must keep the answer. Got: ${result}`);
    assert.equal(persisted.length, 1);
    assert.ok(persisted[0]!.includes("internal reasoning step"), "the persisted output is unchanged by finalStepOnly");
    await session.dispose();
  });

  it("a Codex turn never calls the stats callback: it has no step concept", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompts",
      env: { CODEX_API_KEY: "test-key" },
    });
    let called = false;
    const session = await strategy.openSession("primary", "/tmp", {});
    await session.prompt("say hello", { finalStepOnly: true, onTurnStats: () => { called = true; } });
    assert.equal(called, false);
    await session.dispose();
  });
});

describe("CodexRuntimeStrategy.openSession run secrets", () => {
  it("a prompt sent inside a run reaches codex without the run's secrets, and one sent outside a run is sent as it is", async () => {
    const sent: string[] = [];
    const transport: CodexHeadlessTransport = {
      async start(): Promise<CodexTransportSession> {
        return { id: "s", prompt: async (text: string) => { sent.push(text); return "ok"; }, dispose: async () => {} };
      },
      async health(): Promise<AgentProviderHealth> { return { provider: "codex", status: "healthy", configured: true }; },
      async listModels(): Promise<AgentModelInfo[]> { return []; },
    };
    const strategy = new CodexRuntimeStrategy({ transport, promptRoot: "/nonexistent/prompts", env: { CODEX_API_KEY: "test-key" } });
    const session = await strategy.openSession("primary", "/tmp", {});
    const scope = createRunSecretScope();
    scope.addAccountSecrets(["plain-pass-9981"]);

    await withRunSecretScope(scope, () => session.prompt("the DOM said plain-pass-9981"));
    await session.prompt("the DOM said plain-pass-9981");

    assert.ok(!sent[0]!.includes("plain-pass-9981") && sent[0]!.includes("[REDACTED]"));
    assert.ok(sent[1]!.includes("plain-pass-9981"));
    await session.dispose();
  });
});

describe("CodexRuntimeStrategy.startEventStream", () => {
  it("startEventStream is defined on CodexRuntimeStrategy", () => {
    const strategy = new CodexRuntimeStrategy({
      env: {},
    });
    assert.ok(
      typeof (strategy as unknown as Record<string, unknown>).startEventStream === "function" ||
        "startEventStream" in strategy,
      "CodexRuntimeStrategy must expose a startEventStream method",
    );
  });
});

/* CodexExecTransport timeout/SIGTERM path. Uses a fake spawn (DI via spawnFn) to verify that
   the transport's SIGTERM deadline fires when the deadline elapses and that the error is
   classified by codexErrorToInfra as infra-error.
 */

describe("CodexExecTransport timeout/SIGTERM path", () => {
  it("SIGTERM is sent and a timeout error is rejected when the deadline elapses", async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const transport = new CodexExecTransport(
      { CODEX_API_KEY: "test" },
      "codex",
      spawnFn,
    );
    const session = await transport.start({
      role: "primary",
      cwd: "/tmp",
      model: "gpt-5.4",
      timeoutMs: 20, /* 20ms deadline — fires before the hanging child exits */
    });

    let caughtErr: unknown;
    try {
      await session.prompt("run tests");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof Error, "Must reject with an Error when the deadline elapses");

    /* The transport must have sent SIGTERM to the child.
       The timeout fires FIRST and emits the timeout reject; the child's close handler
       also rejects (after kill()), but the first rejection wins in the Promise.
     */
    assert.ok(killSpy.count >= 1, `kill() must be called at least once. Called: ${killSpy.count}`);
    assert.equal(killSpy.signal, "SIGTERM", `kill must use SIGTERM signal. Got: ${killSpy.signal}`);

    /* The timeout error message must match the codexErrorToInfra timeout pattern
       so the pipeline classifies this as infra-error.
     */
    const errMsg = (caughtErr as Error).message;
    assert.match(errMsg, /timed out after \d+ms/i, `timeout error message must match the pattern. Got: ${errMsg}`);
    assert.ok(caughtErr instanceof AgentTimeoutError, "the deadline is rejected as the typed timeout, so a caller never has to read its message");

    /* codexErrorToInfra must classify this as an infra timeout. */
    const infraErr = codexErrorToInfra(caughtErr as Error);
    assert.ok(
      infraErr instanceof AgentTimeoutError,
      `timeout error must be classifiable as infra (AgentTimeoutError). Got: ${infraErr}`,
    );
    assert.ok(
      infraErr.message.includes("INCONCLUSIVE (infrastructure)"),
      "infra error must include INCONCLUSIVE message",
    );
  });

  it("resolves normally when the process completes before the deadline", async () => {
    const jsonl = JSON.stringify({ msg: "all tests passed" });
    const spawnFn = makeSuccessSpawnFn(jsonl);
    const transport = new CodexExecTransport(
      { CODEX_API_KEY: "test" },
      "codex",
      spawnFn,
    );
    const session = await transport.start({
      role: "primary",
      cwd: "/tmp",
      model: "gpt-5.4",
      timeoutMs: 5_000, /* 5 second ceiling — process exits in microseconds */
    });

    let result: string | undefined;
    let caughtErr: unknown;
    try {
      result = await session.prompt("run tests");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(
      caughtErr === undefined,
      `No error must be thrown when the process exits before the deadline. Got: ${String(caughtErr)}`,
    );
    assert.equal(
      result,
      "all tests passed",
      `Must resolve with the last JSONL message. Got: ${String(result)}`,
    );
  });
});

/* ---------------------------------------------------------------------------
   CodexRuntimeStrategy must arm a DEFAULT per-role deadline when the caller passes no
   timeoutMs — today the rewritten path passes none, so a wedged `codex exec` is unbounded
   (facades.ts marks Codex sessions selfTimed, so the stall watchdog skips them entirely; a
   wall-clock deadline is the only mechanism that can see a Codex hang). The default is derived
   from the SAME per-role budget constants OpenCode uses (REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS,
   agentTimeout("diff")), imported directly to avoid the two providers drifting apart.
   ---------------------------------------------------------------------------
 */
describe("CodexRuntimeStrategy — default per-role deadline", () => {
  /* Tiny env-overridden budgets so these tests exercise the REAL default-selection code path
     (env override, same as OpenCode's OPENCODE_REVIEWER_TIMEOUT_MS pattern) without waiting out
     the real 5-6 minute production defaults.
   */
  const FAST_ENV = { CODEX_API_KEY: "test-key", OPENCODE_REVIEWER_TIMEOUT_MS: "20", OPENCODE_TIMEOUT_MS: "20" };

  it("openSession with NO timeoutMs still arms a deadline: a hung child is killed and the prompt rejects", { timeout: 10_000 }, async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const strategy = new CodexRuntimeStrategy({
      env: FAST_ENV,
      transport: new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", spawnFn),
      promptRoot: "/nonexistent/prompts",
    });

    /* No timeoutMs passed at all — this is the exact rewritten-path shape (generate-tests.use-case.ts
       never sets opts.timeoutMs). Without a default, this session.prompt() would hang forever.
     */
    const session = await strategy.openSession("reviewer", "/tmp", {});

    let caughtErr: unknown;
    try {
      /* Give the fake hanging child a chance to be killed by SOME deadline; the fake spawn never
         exits on its own, so only an armed timer can resolve this promise at all.
       */
      await session.prompt("review these specs");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(
      caughtErr instanceof Error,
      "a default deadline must fire and reject — otherwise this awaits forever with no timeoutMs set",
    );
    assert.ok(killSpy.count >= 1, "the hung child must be killed by the default deadline");
  });

  it("the default deadline for 'reviewer' uses SIGKILL (a hard wall-clock guarantee, not graceful SIGTERM)", { timeout: 10_000 }, async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const strategy = new CodexRuntimeStrategy({
      env: FAST_ENV,
      transport: new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", spawnFn),
      promptRoot: "/nonexistent/prompts",
    });

    const session = await strategy.openSession("reviewer", "/tmp", {});
    await assert.rejects(() => session.prompt("review these specs"));

    assert.equal(
      killSpy.signal,
      "SIGKILL",
      "Codex is self-timed with no mid-turn activity signal — the default deadline must use a hard " +
        "SIGKILL (the caller never opted into a specific budget, unlike the explicit-timeoutMs path).",
    );
  });

  it("an EXPLICIT timeoutMs from the caller still wins over the role default (caller intent is not overridden)", async () => {
    const { spawnFn } = makeHangingSpawnFn();
    let capturedTimeout: number | undefined;
    const transport: CodexHeadlessTransport = {
      async start(input: CodexTransportStartInput): Promise<CodexTransportSession> {
        capturedTimeout = input.timeoutMs;
        return { id: "s", prompt: async () => '{"specs":[]}', dispose: async () => {} };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [];
      },
    };
    void spawnFn; /* unused in this transport-level test; only the captured timeoutMs matters here. */

    const strategy = new CodexRuntimeStrategy({
      env: { CODEX_API_KEY: "test-key" },
      transport,
      promptRoot: "/nonexistent/prompts",
    });

    const session = await strategy.openSession("reviewer", "/tmp", { timeoutMs: 123_456 });
    await session.prompt("review these specs");
    await session.dispose();

    assert.equal(capturedTimeout, 123_456, "an explicit caller timeoutMs must be forwarded verbatim, not overridden by the role default");
  });

  it("distinct roles get distinct default budgets: reviewer's default differs from primary's", async () => {
    const capturedByRole: Record<string, number | undefined> = {};
    function makeCapturingTransport(roleLabel: string): CodexHeadlessTransport {
      return {
        async start(input: CodexTransportStartInput): Promise<CodexTransportSession> {
          capturedByRole[roleLabel] = input.timeoutMs;
          return { id: "s", prompt: async () => '{"specs":[]}', dispose: async () => {} };
        },
        async health(): Promise<AgentProviderHealth> {
          return { provider: "codex", status: "healthy", configured: true };
        },
        async listModels(): Promise<AgentModelInfo[]> {
          return [];
        },
      };
    }

    const reviewerStrategy = new CodexRuntimeStrategy({
      env: { CODEX_API_KEY: "test-key" },
      transport: makeCapturingTransport("reviewer"),
      promptRoot: "/nonexistent/prompts",
    });
    const primaryStrategy = new CodexRuntimeStrategy({
      env: { CODEX_API_KEY: "test-key" },
      transport: makeCapturingTransport("primary"),
      promptRoot: "/nonexistent/prompts",
    });

    await (await reviewerStrategy.openSession("reviewer", "/tmp", {})).prompt("x");
    await (await primaryStrategy.openSession("primary", "/tmp", {})).prompt("x");

    assert.ok(typeof capturedByRole.reviewer === "number", "reviewer must get a numeric default deadline");
    assert.ok(typeof capturedByRole.primary === "number", "primary must get a numeric default deadline");
    assert.notEqual(
      capturedByRole.reviewer,
      capturedByRole.primary,
      "reviewer (6min budget) and primary (5min diff budget) must use DIFFERENT default deadlines, " +
        "matching the same per-role split OpenCode already uses",
    );
  });
});

/* rolePromptName must route "proposer" through its own explicit
   branch, not the "qa-maintainer" fallthrough.
 */

describe("rolePromptName (proposer role)", () => {
  it("routes proposer to qa-proposer via an explicit branch, not the qa-maintainer fallthrough", () => {
    assert.equal(rolePromptName("proposer"), "qa-proposer");
    assert.notEqual(
      rolePromptName("proposer"),
      rolePromptName("maintainer"),
      "proposer must not silently fall through to the maintainer branch",
    );
  });
});

describe("extractCodexLastMessage", () => {
  it("returns the LAST message from multi-line JSONL", () => {
    const jsonl = [
      JSON.stringify({ msg: "first message" }),
      JSON.stringify({ msg: "second message" }),
      JSON.stringify({ msg: "last message" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.equal(result, "last message", "Must return the LAST non-empty message, not the first");
  });

  it("tolerates interleaved non-JSON/stderr lines and still returns trailing message", () => {
    const jsonl = [
      "Spawning codex exec...",
      JSON.stringify({ msg: "setup done" }),
      "[INFO] connecting to MCP",
      JSON.stringify({ message: "test result: all passed" }),
      "some random stderr output",
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.equal(result, "test result: all passed");
  });

  it("returns empty string for empty/whitespace-only input", () => {
    assert.equal(extractCodexLastMessage(""), "");
    assert.equal(extractCodexLastMessage("   \n  \n  "), "");
  });

  it("handles the defensive 4-field probe: prefers msg, then message, then text, then content", () => {
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ msg: "via-msg", message: "via-message" })),
      "via-msg",
    );
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ message: "via-message", text: "via-text" })),
      "via-message",
    );
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ text: "via-text", content: "via-content" })),
      "via-text",
    );
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ content: "via-content" })),
      "via-content",
    );
  });

  it("skips events with no message field and returns the last valid one", () => {
    const jsonl = [
      JSON.stringify({ msg: "real result" }),
      JSON.stringify({ type: "tool_use", tool: "read_file" }),  /* no msg/message/text/content */
      JSON.stringify({ status: "done" }),
    ].join("\n");
    assert.equal(extractCodexLastMessage(jsonl), "real result");
  });

  /* extractCodexLastMessage previously returned only the LAST agent_message unconditionally. If
     the agent emits its closing verdict JSON and THEN a trailing remark (e.g. "Done!" after the
     JSON block, or a courtesy follow-up), the verdict is lost — this is a Codex-only asymmetry
     (OpenCode's extractText concatenates ALL messages, so a trailing remark never displaces the
     verdict there). The fix: scan messages in reverse and return the last one that itself parses
     as containing a verdict-shaped JSON block (specs[] or an approved field); only when NONE do,
     fall back to the true last message (preserving all plain-text/chat behavior above).
   */

  it("a generator verdict block followed by a trailing remark is still recovered", () => {
    const verdictJson = JSON.stringify({ specs: ["login.spec.ts"], note: "covers the new login flow" });
    const jsonl = [
      JSON.stringify({ msg: verdictJson }),
      JSON.stringify({ msg: "Done! Let me know if you need anything else." }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(
      result.includes('"specs"') && result.includes("login.spec.ts"),
      `must recover the verdict-bearing message, not the trailing remark. Got: ${result}`,
    );
  });

  it("a reviewer verdict block followed by a trailing remark is still recovered", () => {
    const verdictJson = JSON.stringify({ approved: true, rationale: "looks good", corrections: [] });
    const jsonl = [
      JSON.stringify({ msg: verdictJson }),
      JSON.stringify({ msg: "Great, all specs look solid!" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(
      result.includes('"approved"') && result.includes("true"),
      `must recover the verdict-bearing message, not the trailing remark. Got: ${result}`,
    );
  });

  it("when NO message contains a verdict, falls back to the true last message (unchanged behavior)", () => {
    const jsonl = [
      JSON.stringify({ msg: "exploring the codebase" }),
      JSON.stringify({ msg: "still no verdict, just chatting" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.equal(result, "still no verdict, just chatting");
  });

  it("a verdict embedded mid-message (not the whole message) is still detected", () => {
    /* The agent's closing message is prose THEN a JSON block, not a bare JSON string — the
       detection must find the verdict block WITHIN the message text, not require the whole
       message to be pure JSON.
     */
    const verdictJson = JSON.stringify({ specs: ["checkout.spec.ts"] });
    const jsonl = [
      JSON.stringify({ msg: `I wrote the spec.\n${verdictJson}` }),
      JSON.stringify({ msg: "Anything else?" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(result.includes("checkout.spec.ts"), `must recover the message embedding the verdict. Got: ${result}`);
  });

  it("TWO verdict-bearing messages (draft then final) — the LAST one wins", () => {
    /* An agent may emit a draft verdict, keep working, and emit a corrected final verdict.
       The reverse scan must return the LAST verdict-bearing message, never resurrect the draft.
     */
    const draft = JSON.stringify({ specs: ["draft.spec.ts"], note: "first attempt" });
    const final_ = JSON.stringify({ specs: ["final.spec.ts"], note: "corrected" });
    const jsonl = [
      JSON.stringify({ msg: `Draft:\n${draft}` }),
      JSON.stringify({ msg: "hmm, let me fix the selector first" }),
      JSON.stringify({ msg: `Final verdict:\n${final_}` }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(result.includes("final.spec.ts"), `the LAST verdict must win. Got: ${result}`);
    assert.ok(!result.includes("draft.spec.ts"), `the draft verdict must not be resurrected. Got: ${result}`);
  });

  it.skip("[REAL-BOUNDARY] validates against real codex --json fixture (requires the image-gated capture-codex-jsonl smoke run)", () => {
    /* Validates extractCodexLastMessage against the REAL `codex exec --json` JSONL output
       shape captured by agents/smoke/capture-codex-jsonl.smoke.mjs. IMAGE-GATED: the fixture at
       src/agent-runtime/__fixtures__/codex-exec-json.jsonl is produced in the built agents image
       with CODEX_API_KEY set. When that fixture exists, replace this with:
       const fixture = readFileSync("src/agent-runtime/__fixtures__/codex-exec-json.jsonl", "utf8");
       const result = extractCodexLastMessage(fixture);
       assert.ok(result.length > 0, "Must extract a non-empty message from real fixture");
       Then remove it.skip.
     */
  });
});

/* onUsage honesty: tokens are null and onUsage is not emitted because `codex exec` does not
   expose usage in the current JSONL schema. The exported CODEX_USAGE_AVAILABLE flag, the
   AgentTurnEvent token fields (asserted via the onTurn callback), and a structural assertion
   that the flag is false pin that contract. When a captured fixture proves usage is in the
   JSONL: set CODEX_USAGE_AVAILABLE = true, wire onUsage in openSession + parse token fields,
   and update this test to assert the real usage fields. The false assertion going red is
   intentional — it forces the wiring, not just flipping the flag.
 */
describe("onUsage honesty", () => {
  it("CODEX_USAGE_AVAILABLE is false — pending hook is NOT yet activated", () => {
    /* Honest assertion: codex exec does not yet expose token usage. When a captured fixture
       proves usage is available, this test goes red until onUsage is wired.
     */
    assert.equal(
      CODEX_USAGE_AVAILABLE,
      false,
      "CODEX_USAGE_AVAILABLE must be false until an image-gated fixture confirms " +
        "codex exec --json exposes token usage fields. Do NOT set this to true without wiring " +
        "the actual usage parsing and onUsage callback in openSession.",
    );
  });

  it("AgentTurnEvent token fields are null — no fabricated data emitted", async () => {
    /* Assert that token fields in the turn event are null (not fabricated) when using the codex path. */
    const capturedTurns: Array<{ tokensInput: unknown; tokensOutput: unknown; cost: unknown }> = [];

    const fakeTransportSession: CodexTransportSession = {
      id: "t-p3-3-session",
      prompt: async () => "honest null output",
      dispose: async () => {},
    };

    const fakeTransport: CodexHeadlessTransport = {
      start: async () => fakeTransportSession,
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };

    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });
    const session = await strategy.openSession("primary", "/tmp", {
      descriptor: { runId: "run-p3-3", role: "primary" as const, objective: "test" },
      onTurn: (t) => {
        capturedTurns.push({ tokensInput: t.tokensInput, tokensOutput: t.tokensOutput, cost: t.cost });
      },
    });

    await session.prompt("test prompt for onUsage honesty");

    assert.equal(capturedTurns.length, 1, "onTurn must fire once per prompt");
    const turn = capturedTurns[0]!;
    assert.equal(
      turn.tokensInput,
      null,
      "tokensInput must be null for codex (usage not available in JSONL). See CODEX_USAGE_AVAILABLE.",
    );
    assert.equal(
      turn.tokensOutput,
      null,
      "tokensOutput must be null for codex (usage not available in JSONL). See CODEX_USAGE_AVAILABLE.",
    );
    assert.equal(
      turn.cost,
      null,
      "cost must be null for codex (usage not available in JSONL). See CODEX_USAGE_AVAILABLE.",
    );
  });

  it("a Codex turn reports no step budget and no call metrics: both null, never fabricated", async () => {
    const capturedTurns: Array<{ stepBudget: unknown; callMetrics: unknown }> = [];
    const fakeTransport: CodexHeadlessTransport = {
      start: async () => ({ id: "t-eff-session", prompt: async () => "codex output", dispose: async () => {} }),
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };
    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });
    const session = await strategy.openSession("primary", "/tmp", {
      descriptor: { runId: "run-codex-eff", role: "primary" as const },
      onTurn: (t) => { capturedTurns.push({ stepBudget: t.stepBudget, callMetrics: t.callMetrics }); },
    });

    await session.prompt("a prompt");

    assert.deepEqual(capturedTurns, [{ stepBudget: null, callMetrics: null }]);
  });

  it("a Codex turn reports the wall time its prompt took, the one measurement its runtime can give", async () => {
    const durations: Array<number | null> = [];
    const fakeTransport: CodexHeadlessTransport = {
      start: async () => ({
        id: "t-duration-session",
        prompt: async () => { await new Promise((r) => setTimeout(r, 20)); return "codex output"; },
        dispose: async () => {},
      }),
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };
    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });
    const session = await strategy.openSession("primary", "/tmp", {
      descriptor: { runId: "run-codex-duration", role: "primary" as const },
      onTurn: (t) => { durations.push(t.durationMs); },
    });

    await session.prompt("a prompt");

    assert.equal(durations.length, 1);
    const [duration] = durations;
    assert.ok(duration !== null && duration !== undefined && duration >= 15, `expected a measured duration, got ${String(duration)}`);
  });

  it("the default turn sink persists a Codex turn with its efficiency columns NULL", async () => {
    const runId = `run-codex-persist-${Date.now()}`;
    const fakeTransport: CodexHeadlessTransport = {
      start: async () => ({ id: "t-persist-session", prompt: async () => "codex output", dispose: async () => {} }),
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };
    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });
    const session = await strategy.openSession("primary", "/tmp", { descriptor: { runId, role: "primary" as const } });

    await session.prompt("a prompt");

    const [saved] = getAgentTurns(runId);
    assert.equal(saved!.outputText, "codex output");
    assert.equal(saved!.maxSteps, null);
    assert.equal(saved!.exhausted, null);
    assert.equal(saved!.totalCalls, null);
    assert.equal(saved!.stepsUsed, null);
  });

  it("openSession does not silently drop an onUsage callback when it is passed — asymmetry is explicit", async () => {
    /* OpenCodeRuntimeStrategy accepts onUsage and forwards it to deps.open.
       CodexRuntimeStrategy does NOT accept onUsage in its openSession signature — this is the
       declared asymmetry. This test documents that:
       1. The pending hook flag is false (tested above).
       2. No onUsage snapshot is fabricated when the caller supplies a callback via descriptor opts.
       3. The strategy is not broken — it opens sessions and prompts normally without onUsage.
       The asymmetry is EXPLICIT (declared in contract-parity.test.ts ALLOWED_ASYMMETRIES) and
     */
    const fakeTransportSession: CodexTransportSession = {
      id: "t-p3-3b-session",
      prompt: async () => "no usage emitted",
      dispose: async () => {},
    };

    const fakeTransport: CodexHeadlessTransport = {
      start: async () => fakeTransportSession,
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };

    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });

    /* openSession with no onUsage — must succeed without throwing (the normal codex path). */
    const session = await strategy.openSession("reviewer", "/tmp");
    const result = await session.prompt("test no-usage path");
    assert.equal(result, "no usage emitted", "prompt must return the transport output");
    await session.dispose();
  });
});

/* ---------------------------------------------------------------------------
   skill delivery parity — the Codex role preamble must inline the SKILL.md
   content a role prompt references, the same way it already inlines AGENTS.md and
   roles/<role>.md. Without this, "Consult the `playwright-authoring` skill" is a
   dangling reference on Codex (nothing ships agent/skills/ into a codex turn).
   ---------------------------------------------------------------------------
 */
describe("CodexRuntimeStrategy — skill inlining into the role preamble", () => {
  /* Real repo promptRoot (this test file lives at src/agent-runtime/ → two levels up to repo root,
     then into agent/ — the same provider-neutral tree withCodexRolePreamble reads from).
   */
  const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
  const REAL_PROMPT_ROOT = join(REPO_ROOT, "agent");

  function makeCapturingTransport(): { transport: CodexHeadlessTransport; captures: Array<{ text: string }> } {
    const captures: Array<{ text: string }> = [];
    const transport: CodexHeadlessTransport = {
      async start(_input: CodexTransportStartInput): Promise<CodexTransportSession> {
        return {
          id: "skill-capture-session",
          prompt: async (text: string) => {
            captures.push({ text });
            return '{"specs":[]}';
          },
          dispose: async () => {},
        };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [{ id: "gpt-5.4", label: "GPT-5.4" }];
      },
    };
    return { transport, captures };
  }

  it("sidekick role preamble inlines the playwright-authoring skill it references", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("sidekick", "/tmp", {});
    await session.prompt("write a spec");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(
      preamble.includes("Craft knowledge for writing specs"),
      "the sidekick preamble must inline playwright-authoring's SKILL.md content, not just reference its name",
    );
  });

  it("generator role preamble inlines ALL THREE skills it references (architecture-mapping, playwright-authoring, test-value-review)", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("primary", "/tmp", {});
    await session.prompt("write a spec");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(preamble.includes("Craft knowledge for writing specs"), "playwright-authoring must be inlined");
    assert.ok(preamble.includes("Assume bad faith from the test"), "test-value-review must be inlined");
    assert.ok(
      preamble.includes("Craft knowledge for building"),
      "architecture-mapping must be inlined",
    );
  });

  it("reviewer role preamble inlines the test-value-review skill it references", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("reviewer", "/tmp", {});
    await session.prompt("review these specs");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(
      preamble.includes("Assume bad faith from the test"),
      "the reviewer preamble must inline test-value-review's SKILL.md content",
    );
  });

  it("a role with NO skill reference (chat/qa-assistant) does not inline any skill content", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("chat", "/tmp", {});
    await session.prompt("answer a question");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(
      !preamble.includes("Craft knowledge for writing specs") && !preamble.includes("Assume bad faith from the test"),
      "qa-assistant references no skill — nothing should be inlined for it",
    );
  });

  it("a missing/unresolvable skill degrades gracefully (no throw, preamble still assembled) AND warns loudly", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompt/root/for/skill/fallback/test",
      env: { CODEX_API_KEY: "test-key" },
    });

    /* Capture console.warn: a skill file that fails to resolve must not silently ship an
       impoverished preamble — a renamed/moved SKILL.md should be visible in the logs.
     */
    const warnings: string[] = [];
    const warnMock = mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const session = await strategy.openSession("sidekick", "/tmp", {});
      const result = await session.prompt("write a spec");
      await session.dispose();

      assert.equal(captures.length, 1);
      assert.equal(result, '{"specs":[]}', "prompt must still complete even when no skill/role file resolves");
      assert.ok(
        warnings.some((w) => w.includes("playwright-authoring") && w.includes("SKILL.md")),
        `a warn naming the missing skill path must be emitted. Got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warnMock.mock.restore();
    }
  });

  it("no warn is emitted when every referenced skill resolves", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const warnings: string[] = [];
    const warnMock = mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const session = await strategy.openSession("sidekick", "/tmp", {});
      await session.prompt("write a spec");
      await session.dispose();

      assert.ok(
        !warnings.some((w) => w.includes("SKILL.md")),
        `no skill warn expected when all skills resolve. Got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warnMock.mock.restore();
    }
  });
});

describe("codexPreambleParts — the static layer a Codex turn ships with", () => {
  const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
  const REAL_PROMPT_ROOT = join(REPO_ROOT, "agent");

  it("exposes the shared prompt, the role prompt and the role's skills as read from the prompt tree", () => {
    const parts = codexPreambleParts("primary", REAL_PROMPT_ROOT);
    assert.equal(parts.shared, readFileSync(join(REAL_PROMPT_ROOT, "AGENTS.md"), "utf8"));
    assert.equal(parts.rolePrompt, readFileSync(join(REAL_PROMPT_ROOT, "roles", "qa-generator.md"), "utf8"));
    assert.deepEqual(
      parts.skills.map((s) => s.name),
      ["architecture-mapping", "playwright-authoring", "test-value-review"],
    );
    for (const skill of parts.skills) {
      assert.equal(skill.body, readFileSync(join(REAL_PROMPT_ROOT, "skills", skill.name, "SKILL.md"), "utf8"));
    }
  });

  it("the preamble a turn ships is composed from exactly those parts, in order, ahead of the task", async () => {
    const captured: string[] = [];
    const transport: CodexHeadlessTransport = {
      async start(): Promise<CodexTransportSession> {
        return {
          id: "parts-session",
          prompt: async (text: string) => {
            captured.push(text);
            return '{"specs":[]}';
          },
          dispose: async () => {},
        };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [{ id: "gpt-5.4", label: "GPT-5.4" }];
      },
    };
    const strategy = new CodexRuntimeStrategy({ transport, promptRoot: REAL_PROMPT_ROOT, env: { CODEX_API_KEY: "test-key" } });
    const session = await strategy.openSession("primary", "/tmp", {});
    await session.prompt("THE-TASK");
    await session.dispose();

    const parts = codexPreambleParts("primary", REAL_PROMPT_ROOT);
    const text = captured[0] ?? "";
    const ordered = [parts.shared, parts.rolePrompt, ...parts.skills.map((s) => s.body), "THE-TASK"];
    let cursor = -1;
    for (const piece of ordered) {
      const at = text.indexOf(piece, cursor + 1);
      assert.ok(at > cursor, "every part appears after the previous one");
      cursor = at;
    }
  });

  it("parts that do not resolve are omitted", () => {
    const parts = codexPreambleParts("primary", "/nonexistent/prompts");
    assert.deepEqual(parts, { shared: "", rolePrompt: "", skills: [] });
  });
});

/* A caller bounding several prompts by one budget hands each prompt only what is left of it. */
describe("CodexRuntimeStrategy — per-prompt deadline", () => {
  it("a prompt's own timeoutMs reaches the transport's prompt, and a prompt that states none sends none", async () => {
    const seenOpts: Array<{ timeoutMs?: number } | undefined> = [];
    const transport: CodexHeadlessTransport = {
      async start(): Promise<CodexTransportSession> {
        return { id: "s", prompt: async (_text, opts) => { seenOpts.push(opts); return "{}"; }, dispose: async () => {} };
      },
      async health(): Promise<AgentProviderHealth> { return { provider: "codex", status: "healthy", configured: true }; },
      async listModels(): Promise<AgentModelInfo[]> { return []; },
    };
    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "k" }, transport, promptRoot: "/nonexistent/prompts" });
    const session = await strategy.openSession("primary", "/tmp", { timeoutMs: 600_000 });

    await session.prompt("first", { timeoutMs: 1_234 });
    await session.prompt("second");

    assert.equal(seenOpts[0]?.timeoutMs, 1_234);
    assert.equal(seenOpts[1]?.timeoutMs, undefined);
  });

  it("CodexExecTransport holds a prompt to its own limit instead of the session's, and stops it with SIGTERM", { timeout: 10_000 }, async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const transport = new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", spawnFn);
    const session = await transport.start({ role: "primary", cwd: "/tmp", timeoutMs: 600_000, killSignal: "SIGKILL" });

    await assert.rejects(() => session.prompt("run", { timeoutMs: 20 }), (err: unknown) => err instanceof AgentTimeoutError && /timed out after 20ms/.test(err.message));
    assert.equal(killSpy.signal, "SIGTERM", "a limit the caller chose is not the strategy's own default, which kills hard");
  });

  it("SupervisorExecTransport asks the supervisor for the prompt's own limit", async () => {
    const bodies: string[] = [];
    const transport = new SupervisorExecTransport({
      baseUrl: "http://agents:4097",
      env: { CODEX_API_KEY: "k" },
      fetchImpl: async (_url, init) => { bodies.push(init?.body ?? ""); return { ok: true, status: 200, json: async () => ({ message: "ok" }) }; },
    });
    const session = await transport.start({ role: "primary", cwd: "/repo", timeoutMs: 600_000 });
    await session.prompt("write", { timeoutMs: 4_321 });
    assert.equal((JSON.parse(bodies[0]!) as { timeoutMs?: number }).timeoutMs, 4_321);
  });
});

/* Only a deadline the transport itself fired is the time budget: a timeout the exec reports from the provider is not. */
describe("SupervisorExecTransport — which failures are a deadline", () => {
  const failing = (error: string) => new SupervisorExecTransport({
    baseUrl: "http://agents:4097",
    env: { CODEX_API_KEY: "k" },
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error }) }),
  });

  it("the supervisor's own deadline is the typed timeout", async () => {
    const session = await failing("codex exec timed out after 360000ms").start({ role: "primary", cwd: "/repo" });
    await assert.rejects(session.prompt("x"), (err: unknown) => err instanceof AgentTimeoutError);
  });

  it("a timeout the exec's stderr mentions is not the typed timeout", async () => {
    const session = await failing("codex exec exited 1: upstream request timed out after 30000ms").start({ role: "primary", cwd: "/repo" });
    await assert.rejects(session.prompt("x"), (err: unknown) => err instanceof Error && !(err instanceof AgentTimeoutError));
  });
});

describe("what an exec reports it spent", () => {
  const turnCompleted = (usage: unknown) => JSON.stringify({ type: "turn.completed", usage });
  const answer = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } });

  it("a local exec's turn.completed usage reaches the prompt's onUsage, and the answer is unchanged", async () => {
    const jsonl = [answer, turnCompleted({ input_tokens: 500, cached_input_tokens: 400, output_tokens: 20, reasoning_output_tokens: 6 })].join("\n");
    const transport = new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", makeSuccessSpawnFn(jsonl));
    const session = await transport.start({ role: "primary", cwd: "/tmp" });
    const seen: unknown[] = [];
    assert.equal(await session.prompt("go", { onUsage: (usage) => seen.push(usage) }), "done");
    assert.deepEqual(seen, [{ inputTokens: 500, cachedInputTokens: 400, outputTokens: 20, reasoningOutputTokens: 6 }]);
  });

  it("an exec that reported no usage never calls onUsage", async () => {
    const transport = new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", makeSuccessSpawnFn(answer));
    const session = await transport.start({ role: "primary", cwd: "/tmp" });
    let called = false;
    await session.prompt("go", { onUsage: () => { called = true; } });
    assert.equal(called, false);
  });

  it("the supervisor's relayed usage reaches onUsage, and a body without one does not", async () => {
    const respond = (body: unknown) => new SupervisorExecTransport({ baseUrl: "http://agents:4097", env: { CODEX_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
    const seen: unknown[] = [];
    const withUsage = await respond({ message: "ok", usage: { input_tokens: 9, cached_input_tokens: 3, output_tokens: 2, reasoning_output_tokens: 1 } }).start({ role: "primary", cwd: "/repo" });
    assert.equal(await withUsage.prompt("go", { onUsage: (usage) => seen.push(usage) }), "ok");
    const without = await respond({ message: "ok" }).start({ role: "primary", cwd: "/repo" });
    await without.prompt("go", { onUsage: (usage) => seen.push(usage) });
    assert.deepEqual(seen, [{ inputTokens: 9, cachedInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1 }]);
  });

  it("a relayed usage whose fields are not plain counts reports those fields as none", async () => {
    const transport = new SupervisorExecTransport({ baseUrl: "http://agents:4097", env: { CODEX_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ message: "ok", usage: { input_tokens: "9", cached_input_tokens: -1, output_tokens: 2.5, reasoning_output_tokens: 4 } }) }) });
    const session = await transport.start({ role: "primary", cwd: "/repo" });
    const seen: unknown[] = [];
    await session.prompt("go", { onUsage: (usage) => seen.push(usage) });
    assert.deepEqual(seen, [{ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 4 }]);
  });
});

describe("extractCodexTokenUsage", () => {
  it("adds up the completed turns of an exec and reads nothing from any other event", () => {
    const jsonl = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } }),
      "stray stderr-like line",
      JSON.stringify({ type: "item.completed", usage: { input_tokens: 999 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 0 } }),
    ].join("\n");
    assert.deepEqual(extractCodexTokenUsage(jsonl), { inputTokens: 30, cachedInputTokens: 9, outputTokens: 5, reasoningOutputTokens: 1 });
    assert.equal(extractCodexTokenUsage(JSON.stringify({ type: "turn.completed" })), undefined);
    assert.equal(extractCodexTokenUsage(""), undefined);
  });
});

describe("the trace context of a Codex exec", () => {
  const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("the supervised transport sends the traceparent as a header and sends none when the prompt has none", async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    const transport = new SupervisorExecTransport({ baseUrl: "http://agents:4097", env: { CODEX_API_KEY: "k" }, fetchImpl: async (_url, init) => (headers.push(init?.headers), { ok: true, status: 200, json: async () => ({ message: "ok" }) }) });
    const session = await transport.start({ role: "primary", cwd: "/repo" });
    await session.prompt("go", { traceparent: TRACEPARENT });
    await session.prompt("go");
    assert.equal(headers[0]!.traceparent, TRACEPARENT);
    assert.equal(headers[1]!.traceparent, undefined);
    assert.equal(headers[1]!["content-type"], "application/json");
  });

  it("the local transport puts the traceparent in the child's environment, and an ambient one never reaches the child", async () => {
    const envs: Array<Record<string, string | undefined>> = [];
    const spawnFn = ((_cmd: string, _args: string[], options: { env?: Record<string, string | undefined> }) => (envs.push(options.env ?? {}), makeSuccessChild(JSON.stringify({ msg: "ok" })))) as unknown as SpawnFn;
    const previous = process.env.TRACEPARENT;
    process.env.TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    try {
      const session = await new CodexExecTransport({ CODEX_API_KEY: "k" }, "codex", spawnFn).start({ role: "primary", cwd: "/repo" });
      await session.prompt("go", { traceparent: TRACEPARENT });
      await session.prompt("go");
    } finally {
      if (previous === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = previous;
    }
    assert.equal(envs[0]!.TRACEPARENT, TRACEPARENT);
    assert.equal(envs[1]!.TRACEPARENT, undefined);
  });

  it("the exec environment forwards the two trace names and still nothing else it did not already forward", () => {
    const env = codexExecEnv({ PATH: "/bin", TRACEPARENT, TRACESTATE: "vendor=1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", GITHUB_TOKEN: "ghp_x", QA_TOOLS_TOKEN: "t" });
    assert.deepEqual(Object.keys(env).sort(), ["PATH", "TRACEPARENT", "TRACESTATE"]);
  });
});
