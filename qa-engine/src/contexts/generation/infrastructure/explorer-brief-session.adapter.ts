/*
 * Explorer pass: opens a short-lived READ-ONLY agent session scoped to one run, renders the
 * explorer prompt, sends it, and parses the reply into an ExplorationBrief. This is the sole
 * producer behind PreGenerationGroundingCollaborators.exploreBrief (see
 * pre-generation-grounding-port.adapter.ts) — that caller is itself fail-open, but this adapter
 * is ALSO fail-open on its own: any throw (session open, prompt, or parse) yields `undefined`,
 * never propagates. The session is always disposed, success or failure; a dispose fault is logged
 * and never replaces the result. `sha` is a required argument, never a fabricated fallback (see
 * ExploreBriefArgs).
 */

import { dirname } from "node:path";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import type { CommitIntent, ExplorationBrief, OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import { buildExplorerPrompt } from "./prompt-builders/prompts.ts";

export interface ExplorerBriefStaticContext {
  repo: string;
  e2eRelDir: string;
  namespace: string;
  needsReview: boolean;
  target: TestTarget;
  mode: RunMode;
  appName: string;
  /** Per-session cap (EXPLORER_TIMEOUT_MS at composition time). */
  timeoutMs: number;
  baseUrl?: string;
  guidance?: string;
  /**
   * The triggering service's staged-context mirrorDir is a function of the per-call cwd (the
   * checked-out working copy), not known at composition time — only repo/openapi are static here.
   * See ExplorerBriefDeps.serviceContextDir for how the mirrorDir is resolved per call.
   */
  triggerService?: { repo: string; openapi?: string | string[] };
}

export interface ExplorerBriefDeps {
  runtime: AgentRuntimePort;
  /** Malformed/empty output must resolve to undefined/null, never throw — this adapter treats both as "no brief". */
  parseBrief: (text: string) => ExplorationBrief | undefined | null;
  buildPrompt?: (input: OpencodeRunInput) => string;
  /**
   * The ONE formula for a staged service's in-root directory (service-context.ts's
   * serviceContextDir) — injected so this module never re-derives it. Only consulted when
   * ctx.triggerService is set.
   */
  serviceContextDir?: (workingCopyDir: string, repo: string) => string;
}

export interface ExploreBriefArgs {
  specDir: string;
  diff?: string;
  signal?: AbortSignal;
  sha: string;
  intent?: CommitIntent;
  /** Threaded from RunQaInput.runId so the explorer's own
   *  turns persist attributed to this run. Never fabricated — absent when
   *  the caller has no run context. */
  runId?: string;
}

/**
 * Constructed once per run by the composition root; `explore()` is wired verbatim as
 * PreGenerationGroundingCollaborators.exploreBrief.
 */
export class ExplorerBriefSessionAdapter {
  constructor(
    private readonly ctx: ExplorerBriefStaticContext,
    private readonly deps: ExplorerBriefDeps,
  ) {}

  async explore(args: ExploreBriefArgs): Promise<ExplorationBrief | undefined> {
    const cwd = dirname(args.specDir);
    let session: AgentSession | undefined;
    try {
      session = await this.deps.runtime.openSession("explorer", cwd, {
        ...(args.signal ? { signal: args.signal } : {}),
        timeoutMs: this.ctx.timeoutMs,
        /*
         * liveObservation: false — the explorer's turns persist
         * (tagged with runId below) but its session must NOT be SSE-registered:
         * that would feed the 180s stall watchdog and change its liveness
         * window relative to today's behavior, a change out of scope here.
         */
        descriptor: {
          role: "qa-explorer",
          ...(args.runId ? { runId: args.runId } : {}),
          liveObservation: false,
        },
      });
      const build = this.deps.buildPrompt ?? buildExplorerPrompt;
      const prompt = build({
        repo: this.ctx.repo,
        sha: args.sha,
        diff: args.diff ?? "",
        mirrorDir: cwd,
        e2eRelDir: this.ctx.e2eRelDir,
        namespace: this.ctx.namespace,
        needsReview: this.ctx.needsReview,
        target: this.ctx.target,
        mode: this.ctx.mode,
        appName: this.ctx.appName,
        explorer: true,
        ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
        ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
        ...(args.intent ? { intent: args.intent } : {}),
        ...(this.ctx.triggerService && this.deps.serviceContextDir
          ? {
              service: {
                repo: this.ctx.triggerService.repo,
                mirrorDir: this.deps.serviceContextDir(cwd, this.ctx.triggerService.repo),
                ...(this.ctx.triggerService.openapi ? { openapi: this.ctx.triggerService.openapi } : {}),
              },
            }
          : {}),
      });
      const { output } = await session.prompt(prompt, { textOnly: true });
      return this.deps.parseBrief(output) ?? undefined;
    } catch (err) {
      console.warn(`[qa] WARNING: explorer pass failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      /* A dispose fault never discards a parsed brief nor escapes the fail-open contract. */
      try {
        await session?.dispose();
      } catch (disposeErr) {
        console.warn(`[qa] WARNING: explorer session dispose failed (non-blocking): ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}`);
      }
    }
  }
}
