/*
 * ClosedLoopPort → the run_spec loop of one run. Opened inside the run (so the run's sandbox scope and its secret scope are the
 * ones active), it keeps a capability for the run, registers it where the generator's session will find it, and answers every
 * call inside a snapshot of that run's async context: the HTTP request that brings a call in has no scope of its own, and the
 * spec it executes must run in this run's sandbox with this run's secrets taken out of what it reports.
 * A run is granted the loop only when it is enabled (the app's setting, or the run's own choice) and the generator's runtime
 * can call the tool. Nothing here decides a verdict: the loop is evidence the generator gathers, and the run reads it back
 * through isClosed (every delivered spec seen passing in its current bytes).
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import { removeTreeBounded } from "../../../../shared-infrastructure/bounded-tree-removal.ts";
import { MAX_SPEC_SOURCE_BYTES, purgeRefusedDirectory, readOwnedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { confinedSpecFiles } from "../../../../shared-infrastructure/spec-files.adapter.ts";
import { typescriptSpecFixtures } from "../../../../shared-infrastructure/spec-fixtures-import.ts";
import { AccountLock } from "@contexts/test-execution/application/index.ts";
import { PROBE_REL_DIR, RUN_SPEC_FLOW_AGENT, RunSpecCapability, loopClosed } from "@contexts/test-execution/application/index.ts";
import { RunSpecUseCase, type RunSpecRequest, type RunSpecResponse } from "@contexts/test-execution/application/index.ts";
import type { SpecCleanupPort, SpecExecutorPort } from "@contexts/test-execution/application/index.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { AuthSessionContext, AuthSessionPort } from "@contexts/app-catalog/application/index.ts";
import type { ClosedLoopCleanupPort } from "../../application/ports/closed-loop-cleanup.port.ts";
import type { ClosedLoopExecutionPort } from "../../application/ports/closed-loop-execution.port.ts";
import type { ClosedLoopHandle, ClosedLoopOpenInput, FlowLoopHandle, FlowLoopOpenInput } from "../../domain/closed-loop.ts";
import type { ClosedLoopPort } from "../../application/ports/closed-loop.port.ts";
import type { ClosedLoopRegistry } from "../closed-loop-registry.ts";
import { trustedSessionRenewal } from "./trusted-session-renewal.ts";
import { traceToolCall, type ToolObserver, type ToolTraceWiring } from "./tool-call-trace.ts";
import { runSpecOutcome } from "./tool-call-outcome.ts";

/* How many times a run's calls may renew the saved session from inside the authoring loop (trusted-session-renewal.ts). */
export const MAX_RUN_SPEC_RENEWALS = 1;

/* How long a capability lives when the run has no deadline armed: far beyond any run, and only a backstop to the revocation the run does itself. */
const DEFAULT_LOOP_TTL_MS = 60 * 60 * 1000;

export interface ClosedLoopPortAdapterDeps {
  registry: ClosedLoopRegistry;
  /* The app's own setting (qa.closedLoop), with the limits already defaulted. */
  setting: { enabled: boolean; limits: ClosedLoopLimits };
  /* Whether the generator role runs on a runtime that can call the tool (OpenCode). Read at each open: the runtime is switchable. */
  generatorRuntimeCanCall: () => boolean;
  execution: ClosedLoopExecutionPort;
  /* Absent: nothing removes the data a call created beyond what the spec's own fixtures undo. */
  cleanup?: ClosedLoopCleanupPort;
  /* With the context: signs in again when a call left the session on the login page. Absent: a lost session is only reported. */
  authSession?: AuthSessionPort;
  authContext?: AuthSessionContext;
  /* The spec directory relative to the mirror (`e2e`). */
  specRelDir: string;
  /* The key two users of one test account contend on. */
  account: string;
  lock: AccountLock;
  deadline?: RunDeadlineView;
  /* Takes the run's secrets out of any text that leaves; called inside the run's scope. */
  redact: (text: string) => string;
  now?: () => number;
  /* With it, every call is a `qayaba.tool.run_spec` span under the attempt of the session that made it. Absent: nothing is traced. */
  trace?: ToolTraceWiring;
}

export class ClosedLoopPortAdapter implements ClosedLoopPort {
  constructor(private readonly deps: ClosedLoopPortAdapterDeps) {}

  async open(input: ClosedLoopOpenInput): Promise<ClosedLoopHandle | undefined> {
    const enabled = input.enabled ?? this.deps.setting.enabled;
    if (!enabled) return undefined;
    if (!this.deps.generatorRuntimeCanCall()) {
      engineLog.warn(`[qa] run_spec is enabled for run ${input.runId} but the generator's runtime cannot call it (only OpenCode can); the run goes on without the loop`);
      return undefined;
    }
    const now = this.deps.now ?? Date.now;
    const left = this.deps.deadline?.remainingMs();
    const capability = new RunSpecCapability({
      runId: input.runId,
      limits: this.deps.setting.limits,
      expiresAtMs: now() + (left !== undefined && left > 0 ? left : DEFAULT_LOOP_TTL_MS),
      now,
    });
    const root: SpecRoot = { mirrorDir: input.mirrorDir, specDir: input.specDir };
    /* One renewal allowance for the whole run: the generator's loop and every flow's draw on the same one. */
    const session = this.deps.authSession && this.deps.authContext ? trustedSessionRenewal(this.deps.authSession, this.deps.authContext, input.specDir, MAX_RUN_SPEC_RENEWALS) : undefined;
    const useCase = new RunSpecUseCase({
      capability,
      specRoot: root,
      specFiles: confinedSpecFiles,
      fixtures: typescriptSpecFixtures,
      specRelDir: this.deps.specRelDir,
      account: this.deps.account,
      lock: this.deps.lock,
      executor: this.executor(input),
      cleanup: this.cleaner(input),
      ...(session ? { session } : {}),
      ...(this.deps.deadline ? { deadline: this.deps.deadline } : {}),
      redact: this.deps.redact,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    /* The run's async context as it is now: the run's sandbox scope and its secret scope. */
    const inRunContext = AsyncLocalStorage.snapshot();
    /* A call belongs to its session: when the session ends (its turn finished, timed out or was cancelled) nobody reads the answer, and a spec left running would overlap the phases that follow. */
    const running = new Map<string, Set<AbortController>>();
    this.deps.registry.register({
      runId: input.runId,
      capability,
      call: async (request) => {
        const own = new AbortController();
        const mine = running.get(request.sessionId) ?? new Set<AbortController>();
        mine.add(own);
        running.set(request.sessionId, mine);
        try {
          return await inRunContext(() => this.served(request, (observer) => useCase.run(request, own.signal, observer)));
        } finally {
          mine.delete(own);
          if (mine.size === 0) running.delete(request.sessionId);
        }
      },
      cancel: (sessionId) => {
        for (const controller of running.get(sessionId) ?? []) controller.abort();
      },
    });
    return this.handle(input, capability, root, inRunContext, session);
  }

  /* One call, as a span of the orchestrator's own when tracing is wired; the answer is the use case's, untouched. */
  private served(request: RunSpecRequest, run: (observer: ToolObserver) => Promise<RunSpecResponse>): Promise<RunSpecResponse> {
    return traceToolCall(this.deps.trace, { span: "qayaba.tool.run_spec", tool: "run_spec", sessionId: request.sessionId, messageId: request.messageId }, run, runSpecOutcome);
  }

  private handle(input: ClosedLoopOpenInput, capability: RunSpecCapability, root: SpecRoot, inRunContext: <R>(fn: () => R) => R, session: ReturnType<typeof trustedSessionRenewal> | undefined): ClosedLoopHandle {
    let closed = false;
    /* The capability of every flow opened, those closed included: what a flow's calls did stays in the run's counts and ledger. */
    const flows = new Map<string, RunSpecCapability>();
    return {
      limits: capability.limits,
      openFlow: (flow) => {
        if (closed) return undefined;
        if (flows.has(flow.delegationId)) throw new Error(`the run_spec loop of flow ${flow.delegationId} is already open`);
        const opened = this.openFlowLoop(input, flow, inRunContext, session);
        flows.set(flow.delegationId, opened.capability);
        return opened.handle;
      },
      sweepProbes: async () => sweepProbeDir(root),
      isClosed: async (delivered) => {
        const current = new Map<string, string | undefined>();
        for (const file of delivered) current.set(normalizeSpecPath(file), currentSha256(root, normalizeSpecPath(file)));
        return loopClosed([...capability.ledger, ...[...flows.values()].flatMap((c) => c.ledger)], current);
      },
      signals: () => ({
        calls: capability.calls + [...flows.values()].reduce((sum, c) => sum + c.calls, 0),
        devWrites: capability.devWrites + [...flows.values()].reduce((sum, c) => sum + c.devWrites, 0),
        ...(flows.size > 0 ? { granted: [...flows.values()].reduce((sum, c) => sum + c.limits.maxCalls, 0) } : {}),
      }),
      close: async () => {
        if (closed) return;
        closed = true;
        const pending = [capability, ...flows.values()].flatMap((c) => (c.pendingNamespace !== undefined ? [c.pendingNamespace] : []));
        capability.revoke();
        for (const c of flows.values()) c.revoke();
        this.deps.registry.unregister(input.runId);
        try {
          sweepProbeDir(root);
        } catch (err) {
          engineLog.error(`[qa] removing the run_spec probes failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (const namespace of pending) await inRunContext(() => this.cleaner(input).cleanup(namespace));
      },
    };
  }

  /*
   * The loop of one flow of a plan: a capability of its own (its share of the calls and of the writes to DEV, its namespace, its
   * sidekick's sessions), a use case that reads the spec from the sidekick's workspace and may run that one spec alone, and an
   * executor that puts that spec in the working copy, inside the call's lease, and runs it from there. Everything else is the
   * run's: the execution, the cleanup, the account lock, the session renewal and the run's scope.
   */
  private openFlowLoop(input: ClosedLoopOpenInput, flow: FlowLoopOpenInput, inRunContext: <R>(fn: () => R) => R, session: ReturnType<typeof trustedSessionRenewal> | undefined): { capability: RunSpecCapability; handle: FlowLoopHandle } {
    const now = this.deps.now ?? Date.now;
    const left = this.deps.deadline?.remainingMs();
    const capability = new RunSpecCapability({
      runId: `${input.runId}-${flow.flowId}`,
      limits: { maxCalls: flow.limits.maxCalls, perCallMs: this.deps.setting.limits.perCallMs, maxDevWrites: flow.limits.maxDevWrites },
      expiresAtMs: now() + (left !== undefined && left > 0 ? left : DEFAULT_LOOP_TTL_MS),
      now,
      agents: new Set([RUN_SPEC_FLOW_AGENT]),
    });
    const workspace: SpecRoot = { mirrorDir: flow.workspace.dir, specDir: flow.workspace.specDir };
    const only = normalizeSpecPath(flow.specFile);
    const useCase = new RunSpecUseCase({
      capability,
      specRoot: workspace,
      specFiles: confinedSpecFiles,
      fixtures: typescriptSpecFixtures,
      specRelDir: this.deps.specRelDir,
      account: this.deps.account,
      lock: this.deps.lock,
      executor: this.stagedExecutor(input, flow),
      cleanup: this.cleaner(input),
      ...(session ? { session } : {}),
      ...(this.deps.deadline ? { deadline: this.deps.deadline } : {}),
      redact: this.deps.redact,
      allowPath: (rel) => normalizeSpecPath(rel) === only,
      allowedDescription: `${this.deps.specRelDir}/${only}`,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    const running = new Map<string, Set<AbortController>>();
    this.deps.registry.register({
      runId: input.runId,
      delegationId: flow.delegationId,
      capability,
      call: async (request) => {
        const own = new AbortController();
        const mine = running.get(request.sessionId) ?? new Set<AbortController>();
        mine.add(own);
        running.set(request.sessionId, mine);
        try {
          return await inRunContext(() => this.served(request, (observer) => useCase.run(request, own.signal, observer)));
        } finally {
          mine.delete(own);
          if (mine.size === 0) running.delete(request.sessionId);
        }
      },
      cancel: (sessionId) => {
        for (const controller of running.get(sessionId) ?? []) controller.abort();
      },
    });
    let closed = false;
    const handle: FlowLoopHandle = {
      limits: capability.limits,
      signals: () => ({ calls: capability.calls, devWrites: capability.devWrites }),
      ledger: () => capability.ledger.map((e) => ({ path: e.path, sha256: e.sha256, status: e.status, devWrites: e.devWrites, ...(e.failures ? { failures: e.failures } : {}) })),
      isClosed: async () => loopClosed(capability.ledger, new Map([[only, currentSha256(workspace, only)]])),
      close: async () => {
        if (closed) return;
        closed = true;
        const pending = capability.pendingNamespace;
        capability.revoke();
        this.deps.registry.unregisterFlow(input.runId, flow.delegationId);
        if (pending !== undefined) await inRunContext(() => this.cleaner(input).cleanup(pending));
      },
    };
    return { capability, handle };
  }

  /* The executor of a flow: the spec the sidekick wrote is put in the working copy first, and what runs is that copy. */
  private stagedExecutor(input: ClosedLoopOpenInput, flow: FlowLoopOpenInput): SpecExecutorPort {
    const run = this.executor(input);
    return {
      execute: async (request) => {
        const staged = await flow.stage();
        if (staged === undefined) throw new Error(`the spec ${request.specFile} is not in the sidekick's workspace`);
        return run.execute({ ...request, specFile: staged });
      },
    };
  }

  private executor(input: ClosedLoopOpenInput): SpecExecutorPort {
    return {
      execute: async (request) => {
        const result = await this.deps.execution.execute(input.specDir, {
          specFiles: [request.specFile],
          namespace: request.namespace,
          timeoutMs: request.timeoutMs,
          retries: 0,
          countWrites: true,
          ...(request.grep !== undefined ? { grep: request.grep } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        return { verdict: result.verdict, cases: result.cases, logs: result.logs, ...(result.devWrites !== undefined ? { devWrites: result.devWrites } : {}) };
      },
    };
  }

  private cleaner(input: ClosedLoopOpenInput): SpecCleanupPort {
    return {
      cleanup: async (namespace, signal) => {
        await this.deps.cleanup?.cleanup(input.specDir, { namespace, ...(signal ? { signal } : {}) });
      },
    };
  }
}

/* The sha256 of the bytes a delivered spec holds now, read strictly, or undefined when the file is gone or cannot be read. */
function currentSha256(root: SpecRoot, rel: string): string | undefined {
  try {
    const read = readOwnedSpecFile(root, rel, MAX_SPEC_SOURCE_BYTES);
    return "bytes" in read ? createHash("sha256").update(read.bytes).digest("hex") : undefined;
  } catch {
    return undefined;
  }
}

/*
 * Removes the probe directory. A link, a pipe or a file where the directory should be is unlinked without being followed or
 * opened (the strict purge); an ordinary directory is removed with its tree by a walk that looks at each entry without following
 * it and is bounded in entries, depth and time (bounded-tree-removal.ts), since the tree is the agent's to make. A tree past a
 * bound is not removed and the sweep fails: the caller must not go on with probes in the working copy.
 */
function sweepProbeDir(root: SpecRoot): void {
  purgeRefusedDirectory(root, PROBE_REL_DIR);
  removeTreeBounded(join(root.specDir, PROBE_REL_DIR));
}
