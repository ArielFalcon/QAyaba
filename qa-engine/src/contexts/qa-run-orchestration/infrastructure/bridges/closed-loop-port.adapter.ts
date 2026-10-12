/*
 * ClosedLoopPort → the run_spec loop of one run. Opened inside the run (so the run's sandbox scope and its secret scope are the
 * ones active), it keeps a capability for the run, registers it where the generator's session will find it, and answers every
 * call inside a snapshot of that run's async context: the HTTP request that brings a call in has no scope of its own, and the
 * spec it executes must run in this run's sandbox with this run's secrets taken out of what it reports.
 * A run is granted the loop only when it is enabled (the app's setting, or the run's own choice) and the generator's runtime
 * can call the tool. Nothing here decides a verdict: the loop is evidence the generator gathers, and the run reads it back
 * through isClosed (every delivered spec seen passing in its current bytes).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import { MAX_SPEC_SOURCE_BYTES, purgeRefusedDirectory, readOwnedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { PROBE_REL_DIR, RunSpecCapability, loopClosed } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { RunSpecUseCase } from "@contexts/test-execution/application/run-spec.use-case.ts";
import type { SessionRenewalPort, SpecCleanupPort, SpecExecutorPort } from "@contexts/test-execution/application/ports/run-spec.ports.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { AuthSessionContext, AuthSessionPort } from "../../application/ports/auth-session.port.ts";
import type { CleanupPort, ClosedLoopHandle, ClosedLoopOpenInput, ClosedLoopPort, ExecutionPort } from "../../application/ports/index.ts";
import type { ClosedLoopRegistry } from "../closed-loop-registry.ts";

/* How long a capability lives when the run has no deadline armed: far beyond any run, and only a backstop to the revocation the run does itself. */
const DEFAULT_LOOP_TTL_MS = 60 * 60 * 1000;

export interface ClosedLoopPortAdapterDeps {
  registry: ClosedLoopRegistry;
  /* The app's own setting (qa.closedLoop), with the limits already defaulted. */
  setting: { enabled: boolean; limits: ClosedLoopLimits };
  /* Whether the generator role runs on a runtime that can call the tool (OpenCode; never Codex). Read at each open: the runtime is switchable. */
  generatorRuntimeCanCall: () => boolean;
  execution: ExecutionPort;
  /* Absent: nothing removes the data a call created beyond what the spec's own fixtures undo. */
  cleanup?: CleanupPort;
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
}

export class ClosedLoopPortAdapter implements ClosedLoopPort {
  constructor(private readonly deps: ClosedLoopPortAdapterDeps) {}

  async open(input: ClosedLoopOpenInput): Promise<ClosedLoopHandle | undefined> {
    const enabled = input.enabled ?? this.deps.setting.enabled;
    if (!enabled) return undefined;
    if (!this.deps.generatorRuntimeCanCall()) {
      console.warn(`[qa] run_spec is enabled for run ${input.runId} but the generator's runtime cannot call it (only OpenCode can); the run goes on without the loop`);
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
    const useCase = new RunSpecUseCase({
      capability,
      specRoot: root,
      specRelDir: this.deps.specRelDir,
      account: this.deps.account,
      lock: this.deps.lock,
      executor: this.executor(input),
      cleanup: this.cleaner(input),
      ...(this.deps.authSession && this.deps.authContext ? { session: this.renewal(input) } : {}),
      ...(this.deps.deadline ? { deadline: this.deps.deadline } : {}),
      redact: this.deps.redact,
      ...(input.signal ? { signal: input.signal } : {}),
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
          return await inRunContext(() => useCase.run(request, own.signal));
        } finally {
          mine.delete(own);
          if (mine.size === 0) running.delete(request.sessionId);
        }
      },
      cancel: (sessionId) => {
        for (const controller of running.get(sessionId) ?? []) controller.abort();
      },
    });
    return this.handle(input, capability, root, inRunContext);
  }

  private handle(input: ClosedLoopOpenInput, capability: RunSpecCapability, root: SpecRoot, inRunContext: <R>(fn: () => R) => R): ClosedLoopHandle {
    let closed = false;
    return {
      limits: capability.limits,
      sweepProbes: async () => sweepProbeDir(root),
      isClosed: async (delivered) => {
        const current = new Map<string, string | undefined>();
        for (const file of delivered) current.set(normalizeSpecPath(file), currentSha256(root, normalizeSpecPath(file)));
        return loopClosed(capability.ledger, current);
      },
      signals: () => ({ calls: capability.calls, devWrites: capability.devWrites }),
      close: async () => {
        if (closed) return;
        closed = true;
        const pending = capability.pendingNamespace;
        capability.revoke();
        this.deps.registry.unregister(input.runId);
        try {
          sweepProbeDir(root);
        } catch (err) {
          console.error(`[qa] removing the run_spec probes failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (pending !== undefined) await inRunContext(() => this.cleaner(input).cleanup(pending));
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

  private renewal(input: ClosedLoopOpenInput): SessionRenewalPort {
    return {
      renew: async (signal) => {
        try {
          await this.deps.authSession!.prepare({ specDir: input.specDir, baseUrl: this.deps.authContext!.baseUrl, ...(this.deps.authContext!.auth ? { auth: this.deps.authContext!.auth } : {}), phase: "pre-execute" }, signal);
          return true;
        } catch (err) {
          console.error(`[qa] renewing the session for run_spec failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
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
 * opened (the strict purge); an ordinary directory is removed with its tree, and a recursive removal does not follow a link
 * inside it. The known limit of every recursive removal of a tree the agent wrote (see spec-path-confinement.ts): it is not
 * bounded in time or depth.
 */
function sweepProbeDir(root: SpecRoot): void {
  purgeRefusedDirectory(root, PROBE_REL_DIR);
  rmSync(join(root.specDir, PROBE_REL_DIR), { recursive: true, force: true });
}
