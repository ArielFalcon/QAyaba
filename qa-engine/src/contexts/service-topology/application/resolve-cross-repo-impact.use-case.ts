/* Cross-repo impact for a triggering service: per-service VCS read plus a repo-agnostic code graph. resolve() fails open (→ null) on any error but one: UntrustedGitTreeError means untrusted code replaced the mirror's git dir, so it is rethrown, never turned into "no impact". Cheap pre-filter when no link targets the trigger repo. Best-effort git fetch before the diff; its result is unread. */
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import { MATCH_TIER, type CrossRepoImpact, type ImpactedLink } from "@kernel/service-links.ts";
import { existsSync } from "node:fs";
import type { BlastRadius } from "../../../shared-kernel/blast-radius.ts";
import { Sha } from "../../../shared-kernel/sha.ts";
import type { CodeGraphPort } from "../../../shared-kernel/ports/code-graph.port.ts";
import { DEFAULT_WALK_POLICY } from "../../../shared-kernel/code/index.ts";
import { rethrowIfUntrusted } from "../../../shared-kernel/domain-error.ts";
import type { MirrorRefreshPort } from "./ports/mirror-refresh.port.ts";
import { routeServesOperation } from "../domain/cross-repo-impact.ts";
import { diffOperations, type OperationChange } from "../domain/operation-diff.ts";
import { parse as parseYaml } from "yaml";

/** Minimal read-side VCS surface — structural match to VcsReadPort.blastRadius without importing that context. */
export interface CrossRepoVcsRead {
  blastRadius(sha: Sha): Promise<BlastRadius>;
  /* A file as it was at a commit; undefined when it did not exist or cannot be read. Absent: contract files are compared as whole files. */
  fileAt?(ref: string, path: string): Promise<string | undefined>;
}

export interface MirrorRegistryLike {
  mirrorDir(repo: string): Promise<string>;
}


export class ResolveCrossRepoImpactUseCase {
  constructor(
    private readonly mirrors: MirrorRegistryLike,
    private readonly makeVcs: (repoDir: string) => CrossRepoVcsRead,
    /* Absent: only the contract-file tier matches. */
    private readonly codeGraph: CodeGraphPort | undefined,
    private readonly mirrorRefresh: MirrorRefreshPort,
  ) {}

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[], baseRef?: string): Promise<CrossRepoImpact | null> {
    try {
      const candidateLinks = resolvedLinks.filter((l) => l.to.repo === triggerRepo);
      if (candidateLinks.length === 0) return null;

      const mirrorDir = await this.mirrors.mirrorDir(triggerRepo);
      if (!existsSync(mirrorDir)) return null;

      /* Best-effort mirror-freshness fetch before the diff is read. exitCode/timedOut are unread — a failed fetch falls through with whatever is already on disk. */
      await this.mirrorRefresh.refresh(mirrorDir);

      const vcs = this.makeVcs(mirrorDir);
      const blast = await vcs.blastRadius(Sha.of(triggerSha));
      if (blast.isEmpty) return null;

      const impactedLinks: ImpactedLink[] = [];
      const matchedKeys = new Set<string>();

      /* A changed contract file impacts only the links whose operation changed in it; a file whose two versions cannot be compared impacts every link on it, said on the link. */
      const diffs = new Map<string, OperationChange[] | undefined>();
      for (const link of candidateLinks) {
        if (!blast.changedFiles.includes(link.to.file)) continue;
        if (!diffs.has(link.to.file)) diffs.set(link.to.file, await this.operationsChanged(vcs, link.to.file, triggerSha, baseRef));
        const changes = diffs.get(link.to.file);
        const operation = link.operation;
        if (changes === undefined || operation === undefined) {
          impactedLinks.push({ link, tier: MATCH_TIER.CONTRACT_FILE, basis: "contract-file" });
          matchedKeys.add(this.linkKey(link));
          continue;
        }
        const change = changes.find((c) => c.verb === operation.verb.toUpperCase() && samePath(c.path, operation.path));
        if (change) {
          impactedLinks.push({ link, tier: MATCH_TIER.CONTRACT_FILE, operationChange: change.change });
          matchedKeys.add(this.linkKey(link));
        }
      }

      /*
       * Tier 2: a link is impacted when its operation is reached from a changed symbol (a changed handler counts: it is
       * reached at depth 0), by either key. The operationId: a codegen interface, and the controller implementing it, name
       * the method after it. The handler's verb and path: a hand-written controller's route node names them.
       */
      const impactedRes = this.codeGraph ? await this.codeGraph.impactedSymbols(mirrorDir, blast, DEFAULT_WALK_POLICY) : undefined;
      if (impactedRes && !impactedRes.ok) engineLog.warn(`[qa] WARNING: the index did not answer the cross-repo impact walk of ${triggerRepo}, so only the contract-file tier applies (non-blocking): ${impactedRes.error.reason}`);
      if (impactedRes?.ok && impactedRes.value.truncated) engineLog.warn(`[qa] WARNING: the cross-repo impact walk of ${triggerRepo} left ${impactedRes.value.partialSeeds?.length ?? 0} seed(s) partial at its expansion budget; a link one of them would reach may be missing (non-blocking).`);
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
      engineLog.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, advisory-only):", { error: err });
      return null;
    }
  }

  /* The operations of a contract file that changed between the change's base and head; undefined when the file's two versions cannot be read and parsed. */
  private async operationsChanged(vcs: CrossRepoVcsRead, file: string, headSha: string, baseRef: string | undefined): Promise<OperationChange[] | undefined> {
    if (!vcs.fileAt) return undefined;
    try {
      const [before, after] = await Promise.all([vcs.fileAt(baseRef ?? `${headSha}^`, file), vcs.fileAt(headSha, file)]);
      if (before === undefined || after === undefined) return undefined;
      return diffOperations(parseYaml(before), parseYaml(after));
    } catch (err) {
      rethrowIfUntrusted(err);
      engineLog.warn(`[qa] WARNING: the two versions of ${file} could not be compared, so every link on it is impacted (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /* The backend routes whose handler the walk reached. An unavailable route list matches nothing. */
  private async reachedHandlerRoutes(codeGraph: CodeGraphPort, mirrorDir: string, reachedRefs: ReadonlySet<string>): Promise<{ method: string; path: string }[]> {
    const routes = await codeGraph.routes(mirrorDir);
    if (!routes.ok) {
      engineLog.warn(`[qa] WARNING: the routes of ${mirrorDir} could not be listed, so no link is matched by handler route (non-blocking): ${routes.error.reason}`);
      return [];
    }
    return routes.value.flatMap((r) => (r.method !== undefined && r.target && reachedRefs.has(`${r.target.file}::${r.target.symbol}`) ? [{ method: r.method, path: r.path }] : []));
  }

  private linkKey(link: ServiceLink): string {
    return `${link.from.repo}/${link.from.file}#${link.from.symbol}->${link.to.repo}`;
  }
}

/* Two OpenAPI paths name one operation when they match segment by segment, a parameter standing for any parameter. */
function samePath(a: string, b: string): boolean {
  const segs = (p: string): string[] => p.split("/").filter(Boolean).map((s) => (/^\{.*\}$/.test(s) ? "{}" : s));
  const x = segs(a);
  const y = segs(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}
