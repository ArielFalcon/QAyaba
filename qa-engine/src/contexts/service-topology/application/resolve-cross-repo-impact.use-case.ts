/* Cross-repo impact for a triggering service: per-service VCS read plus a repo-agnostic code graph. resolve() fails open (→ null) on any error but one: UntrustedGitTreeError means untrusted code replaced the mirror's git dir, so it is rethrown, never turned into "no impact". Cheap pre-filter when no link targets the trigger repo. Best-effort git fetch before the diff; its result is unread. */
import { existsSync } from "node:fs";
import type { BlastRadius } from "../../../shared-kernel/blast-radius.ts";
import { Sha } from "../../../shared-kernel/sha.ts";
import type { CodeGraphPort } from "../../../shared-kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { hardenGitArgs } from "../../../shared-infrastructure/process-sandbox/git-hardening.ts";
import { rethrowIfUntrusted } from "../../../shared-kernel/domain-error.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { ServiceLink } from "../domain/index.ts";
import { MATCH_TIER, routeServesOperation, type CrossRepoImpact, type ImpactedLink } from "../domain/cross-repo-impact.ts";

/** Minimal read-side VCS surface — structural match to VcsReadPort.blastRadius without importing that context. */
export interface CrossRepoVcsRead {
  blastRadius(sha: Sha): Promise<BlastRadius>;
}

export interface MirrorRegistryLike {
  mirrorDir(repo: string): Promise<string>;
}

const FETCH_TIMEOUT_MS = 30_000;
/* The same walk budget as the structural signal: a hub module cannot blow it. */
const IMPACT_BUDGET = { depth: 3, maxSymbols: 300 } as const;

export class ResolveCrossRepoImpactUseCase {
  constructor(
    private readonly mirrors: MirrorRegistryLike,
    private readonly makeVcs: (repoDir: string) => CrossRepoVcsRead,
    /* Absent: only the contract-file tier matches. */
    private readonly codeGraph: CodeGraphPort | undefined,
    private readonly runner: SandboxedBinaryRunner,
  ) {}

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null> {
    try {
      const candidateLinks = resolvedLinks.filter((l) => l.to.repo === triggerRepo);
      if (candidateLinks.length === 0) return null;

      const mirrorDir = await this.mirrors.mirrorDir(triggerRepo);
      if (!existsSync(mirrorDir)) return null;

      /* Best-effort mirror-freshness fetch before the diff is read. exitCode/timedOut are unread — a failed fetch falls through with whatever is already on disk. */
      await this.runner.run({
        command: "git",
        args: hardenGitArgs(["fetch", "--no-recurse-submodules", "origin"], mirrorDir),
        cwd: mirrorDir,
        env: scrubEnv(),
        timeoutMs: FETCH_TIMEOUT_MS,
      });

      const vcs = this.makeVcs(mirrorDir);
      const blast = await vcs.blastRadius(Sha.of(triggerSha));
      if (blast.isEmpty) return null;

      const impactedLinks: ImpactedLink[] = [];
      const matchedKeys = new Set<string>();

      for (const link of candidateLinks) {
        if (blast.changedFiles.includes(link.to.file)) {
          impactedLinks.push({ link, tier: MATCH_TIER.CONTRACT_FILE });
          matchedKeys.add(this.linkKey(link));
        }
      }

      /*
       * Tier 2: a link is impacted when its operation is reached from a changed symbol (a changed handler counts: it is
       * reached at depth 0), by either key. The operationId: a codegen interface, and the controller implementing it, name
       * the method after it. The handler's verb and path: a hand-written controller's route node names them.
       */
      const impactedRes = this.codeGraph ? await this.codeGraph.impactedSymbols(mirrorDir, blast, IMPACT_BUDGET) : undefined;
      if (impactedRes && !impactedRes.ok) console.warn(`[qa] WARNING: the index did not answer the cross-repo impact walk of ${triggerRepo}, so only the contract-file tier applies (non-blocking): ${impactedRes.error.reason}`);
      if (impactedRes?.ok && impactedRes.value.truncated) console.warn(`[qa] WARNING: the cross-repo impact walk of ${triggerRepo} was cut by its budget; a link it would reach may be missing (non-blocking).`);
      const reached = impactedRes?.ok ? impactedRes.value.symbols : [];
      const reachedNames = new Set(reached.map((s) => s.symbol));
      const reachedRefs = new Set(reached.map((s) => `${s.file}::${s.symbol}`));
      const pending = candidateLinks.filter((l) => !matchedKeys.has(this.linkKey(l)));
      const reachedHandlers = this.codeGraph && reached.length > 0 && pending.some((l) => l.operation)
        ? await this.reachedHandlerRoutes(this.codeGraph, mirrorDir, reachedRefs)
        : [];
      for (const link of pending) {
        const byOperationId = reachedNames.has(link.contractRef ?? link.to.symbol);
        const operation = link.operation;
        const byRoute = operation !== undefined && reachedHandlers.some((route) => routeServesOperation(route, operation));
        if (byOperationId || byRoute) {
          impactedLinks.push({ link, tier: MATCH_TIER.IMPACTED_SYMBOL });
          matchedKeys.add(this.linkKey(link));
        }
      }

      if (impactedLinks.length === 0) return null;

      return { impactedLinks };
    } catch (err) {
      rethrowIfUntrusted(err);
      console.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, advisory-only):", err);
      return null;
    }
  }

  /* The backend routes whose handler the walk reached. An unavailable route list matches nothing. */
  private async reachedHandlerRoutes(codeGraph: CodeGraphPort, mirrorDir: string, reachedRefs: ReadonlySet<string>): Promise<{ method: string; path: string }[]> {
    const routes = await codeGraph.routes(mirrorDir);
    if (!routes.ok) {
      console.warn(`[qa] WARNING: the routes of ${mirrorDir} could not be listed, so no link is matched by handler route (non-blocking): ${routes.error.reason}`);
      return [];
    }
    return routes.value.flatMap((r) => (r.method !== undefined && r.target && reachedRefs.has(`${r.target.file}::${r.target.symbol}`) ? [{ method: r.method, path: r.path }] : []));
  }

  private linkKey(link: ServiceLink): string {
    return `${link.from.repo}/${link.from.file}#${link.from.symbol}->${link.to.repo}`;
  }
}
