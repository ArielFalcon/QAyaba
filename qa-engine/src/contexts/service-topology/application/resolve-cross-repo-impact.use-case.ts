/* Cross-repo impact for a triggering service, and the later hops of the same walk (RFC-0011): per-service VCS read plus a repo-agnostic code graph. resolve() fails open (→ null) on any error but one: UntrustedGitTreeError means untrusted code replaced the mirror's git dir, so it is rethrown, never turned into "no impact". Cheap pre-filter when no link targets the trigger repo. Best-effort git fetch before the diff; its result is unread. */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { MATCH_TIER, linkIdentity, type ServiceLink, type CrossRepoImpact, type ImpactedLink, type ImpactStop } from "@kernel/service-links.ts";
import { existsSync } from "node:fs";
import type { BlastRadius } from "../../../shared-kernel/blast-radius.ts";
import { Sha } from "../../../shared-kernel/sha.ts";
import type { CodeGraphPort } from "../../../shared-kernel/ports/code-graph.port.ts";
import { DEFAULT_WALK_POLICY, type ImpactedSymbol, type LocalSymbolRef } from "../../../shared-kernel/code/index.ts";
import { rethrowIfUntrusted } from "../../../shared-kernel/domain-error.ts";
import type { MirrorRefreshPort } from "./ports/mirror-refresh.port.ts";
import { routeServesOperation } from "../domain/cross-repo-impact.ts";
import { LinkGraph } from "../domain/link-graph.ts";
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


/* One later hop upstream: `fed` are the impacted links whose call site is in `repo`, whose index is built at `repoDir`. */
export interface UpstreamHopRequest {
  repo: string;
  repoDir: string;
  links: readonly ServiceLink[];
  fed: readonly ImpactedLink[];
}

/* The first hop downstream: the change of `repo` (already indexed at `repoDir`) and the links out of it that it reaches. */
export interface DownstreamRequest {
  repo: string;
  repoDir: string;
  blast: BlastRadius;
  links: readonly ServiceLink[];
}

/* A later hop downstream: `fed` are the links reached downstream that land in `repo`, whose index is built at `repoDir`. */
export interface DownstreamHopRequest {
  repo: string;
  repoDir: string;
  links: readonly ServiceLink[];
  fed: readonly ImpactedLink[];
}

/* What a hop found: the links it newly impacted, and where it could not finish. */
export interface HopResult {
  links: ImpactedLink[];
  stops: ImpactStop[];
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
          matchedKeys.add(linkIdentity(link));
          continue;
        }
        const change = changes.find((c) => c.verb === operation.verb.toUpperCase() && samePath(c.path, operation.path));
        if (change) {
          impactedLinks.push({ link, tier: MATCH_TIER.CONTRACT_FILE, operationChange: change.change });
          matchedKeys.add(linkIdentity(link));
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
      const pending = candidateLinks.filter((l) => !matchedKeys.has(linkIdentity(l)));
      const served = await this.endpointsReached(mirrorDir, impactedRes?.ok ? impactedRes.value.symbols : [], pending);
      for (const link of pending) {
        if (!served.has(link)) continue;
        impactedLinks.push({ link, tier: MATCH_TIER.IMPACTED_SYMBOL });
        matchedKeys.add(linkIdentity(link));
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

  /*
   * One later hop upstream (RFC-0011): the call sites of the links already impacted, whose repo is `repo`, seed one inbound walk
   * of that repo's index; a link into the repo is impacted when its endpoint is among the callers reached, and carries the chain
   * of links crossed from the change. A hop that cannot be walked says where it stopped and claims nothing beyond; a partial
   * walk returns what it reached and says how many seeds stayed open. Never throws, except for an untrusted git dir.
   */
  async resolveUpstreamHop(request: UpstreamHopRequest): Promise<HopResult> {
    const { repo, repoDir, links, fed } = request;
    const stop = (reason: string): HopResult => ({ links: [], stops: [{ repo, direction: "upstream", reason }] });
    const seeds = uniqueRefs(fed.flatMap(({ link }) => (link.from.file && link.from.symbol ? [{ file: link.from.file, symbol: link.from.symbol }] : [])));
    if (seeds.length === 0) return { links: [], stops: [] };
    const codeGraph = this.codeGraph;
    if (!codeGraph) return stop("the run has no code graph");
    try {
      const walk = await codeGraph.callersOf(repoDir, seeds, DEFAULT_WALK_POLICY);
      if (!walk.ok) return stop(`walk: ${walk.error.reason}`);
      const stops: ImpactStop[] = walk.value.truncated
        ? [{ repo, direction: "upstream", reason: `partial: ${walk.value.partialSeeds?.length ?? 0} of ${seeds.length} seed(s) left open at the expansion budget` }]
        : [];
      const served = await this.endpointsReached(repoDir, walk.value.symbols, new LinkGraph(links).into(repo));
      const impacted: ImpactedLink[] = [];
      for (const [link, symbols] of served) {
        const source = feeder(fed, symbols);
        impacted.push({ link, tier: MATCH_TIER.IMPACTED_SYMBOL, reach: { direction: "upstream", via: [...(source.reach?.via ?? []), source.link] } });
      }
      return { links: impacted, stops };
    } catch (err) {
      rethrowIfUntrusted(err);
      engineLog.warn(`[qa] WARNING: the cross-repo hop through ${repo} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return stop(`walk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /*
   * The first hop downstream (RFC-0011): the links out of a changed repo whose call site its change reaches, the call site being a
   * changed symbol or one that reaches a changed symbol. Never throws, except for an untrusted git dir.
   */
  async resolveDownstream(request: DownstreamRequest): Promise<HopResult> {
    const { repo, repoDir, blast, links } = request;
    const stop = (reason: string): HopResult => ({ links: [], stops: [{ repo, direction: "downstream", reason }] });
    const out = new LinkGraph(links).outOf(repo);
    if (out.length === 0) return { links: [], stops: [] };
    const codeGraph = this.codeGraph;
    if (!codeGraph) return stop("the run has no code graph");
    try {
      const walk = await codeGraph.impactedSymbols(repoDir, blast, DEFAULT_WALK_POLICY);
      if (!walk.ok) return stop(`walk: ${walk.error.reason}`);
      const reached = new Set(walk.value.symbols.map(refKey));
      const stops: ImpactStop[] = walk.value.truncated ? [{ repo, direction: "downstream", reason: `partial: ${walk.value.partialSeeds?.length ?? 0} seed(s) left open at the expansion budget` }] : [];
      const impacted: ImpactedLink[] = out.filter((link) => reached.has(refKey(link.from))).map((link) => ({ link, tier: MATCH_TIER.IMPACTED_SYMBOL, reach: { direction: "downstream", via: [] } }));
      return { links: impacted, stops };
    } catch (err) {
      rethrowIfUntrusted(err);
      engineLog.warn(`[qa] WARNING: the downstream walk of ${repo} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return stop(`walk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /*
   * A later hop downstream: the call sites out of `repo` seed one inbound walk of its index; a link out of the repo is impacted
   * when the endpoint of a fed link (the handler it lands on) is among the callers reached, and the walk states that the call
   * site reaches it. A walk that does not say which seeds reach a handler claims nothing. Never throws, except for an untrusted git dir.
   */
  async resolveDownstreamHop(request: DownstreamHopRequest): Promise<HopResult> {
    const { repo, repoDir, links, fed } = request;
    const stop = (reason: string): HopResult => ({ links: [], stops: [{ repo, direction: "downstream", reason }] });
    const out = new LinkGraph(links).outOf(repo).filter((link) => link.from.file && link.from.symbol);
    if (out.length === 0) return { links: [], stops: [] };
    const codeGraph = this.codeGraph;
    if (!codeGraph) return stop("the run has no code graph");
    try {
      const seeds = uniqueRefs(out.map((link) => link.from));
      const walk = await codeGraph.callersOf(repoDir, seeds, DEFAULT_WALK_POLICY);
      if (!walk.ok) return stop(`walk: ${walk.error.reason}`);
      const stops: ImpactStop[] = walk.value.truncated
        ? [{ repo, direction: "downstream", reason: `partial: ${walk.value.partialSeeds?.length ?? 0} of ${seeds.length} seed(s) left open at the expansion budget` }]
        : [];
      const served = await this.endpointsReached(repoDir, walk.value.symbols, fed.map(({ link }) => link));
      const impacted: ImpactedLink[] = [];
      for (const link of out) {
        const entering = fed.find((f) => (served.get(f.link) ?? []).some((endpoint) => (endpoint.seeds ?? []).some((seed) => refKey(seed) === refKey(link.from))));
        if (entering) impacted.push({ link, tier: MATCH_TIER.IMPACTED_SYMBOL, reach: { direction: "downstream", via: [...(entering.reach?.via ?? []), entering.link] } });
      }
      return { links: impacted, stops };
    } catch (err) {
      rethrowIfUntrusted(err);
      engineLog.warn(`[qa] WARNING: the downstream hop through ${repo} failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return stop(`walk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /*
   * The reached symbols that stand for each link's endpoint, for the links with one: a symbol named by the link's operationId (or
   * its handler symbol), and the handler of a backend route serving the link's operation. Both keys apply, as at hop one. An
   * unavailable route list matches nothing by route. One map entry per link reached.
   */
  private async endpointsReached(repoDir: string, reached: readonly ImpactedSymbol[], links: readonly ServiceLink[]): Promise<Map<ServiceLink, ImpactedSymbol[]>> {
    const served = new Map<ServiceLink, ImpactedSymbol[]>();
    if (links.length === 0) return served;
    const byName = new Map<string, ImpactedSymbol[]>();
    const byRef = new Map<string, ImpactedSymbol>();
    for (const symbol of reached) {
      byName.set(symbol.symbol, [...(byName.get(symbol.symbol) ?? []), symbol]);
      byRef.set(refKey(symbol), symbol);
    }
    const routes = this.codeGraph && reached.length > 0 && links.some((l) => l.operation) ? await this.reachedHandlerRoutes(this.codeGraph, repoDir, byRef) : [];
    for (const link of links) {
      const hits = new Set(byName.get(link.contractRef ?? link.to.symbol) ?? []);
      const operation = link.operation;
      if (operation !== undefined) for (const route of routes) if (routeServesOperation(route, operation)) hits.add(route.handler);
      if (hits.size > 0) served.set(link, [...hits]);
    }
    return served;
  }

  /* The backend routes whose handler the walk reached, with the reached symbol that is the handler. An unavailable route list matches nothing. */
  private async reachedHandlerRoutes(codeGraph: CodeGraphPort, repoDir: string, reached: ReadonlyMap<string, ImpactedSymbol>): Promise<{ method: string; path: string; handler: ImpactedSymbol }[]> {
    const routes = await codeGraph.routes(repoDir);
    if (!routes.ok) {
      engineLog.warn(`[qa] WARNING: the routes of ${repoDir} could not be listed, so no link is matched by handler route (non-blocking): ${routes.error.reason}`);
      return [];
    }
    return routes.value.flatMap((r) => {
      const handler = r.method !== undefined && r.target ? reached.get(refKey(r.target)) : undefined;
      return handler ? [{ method: r.method!, path: r.path, handler }] : [];
    });
  }
}

const refKey = (ref: LocalSymbolRef): string => `${ref.file}::${ref.symbol}`;

function uniqueRefs(refs: readonly LocalSymbolRef[]): LocalSymbolRef[] {
  return [...new Map(refs.map((r) => [refKey(r), { file: r.file, symbol: r.symbol }])).values()];
}

/* The fed link whose call site seeds a reached endpoint: the first one among the seeds the walk states for it, else the first fed link (a walk that states none cannot tell them apart). */
function feeder(fed: readonly ImpactedLink[], endpoints: readonly ImpactedSymbol[]): ImpactedLink {
  const stated = new Set(endpoints.flatMap((e) => [...(e.seeds ?? []).map(refKey), ...(e.depth === 0 ? [refKey(e)] : [])]));
  return fed.find(({ link }) => stated.has(refKey(link.from))) ?? fed[0]!;
}

/* Two OpenAPI paths name one operation when they match segment by segment, a parameter standing for any parameter. */
function samePath(a: string, b: string): boolean {
  const segs = (p: string): string[] => p.split("/").filter(Boolean).map((s) => (/^\{.*\}$/.test(s) ? "{}" : s));
  const x = segs(a);
  const y = segs(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}
