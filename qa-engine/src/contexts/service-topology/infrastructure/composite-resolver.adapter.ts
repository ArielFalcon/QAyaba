/* service-topology/infrastructure/composite-resolver.adapter.ts Composite ServiceBoundaryResolverPort: per-resolver timeout + error isolation + link dedup. Mirrors CoverageCollectorAdapter's fail-open pattern (coverage-collector.adapter.ts). */
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type { RepoRef, ServiceLink, ContractDrift, ExternalCall, UnresolvedCall } from "../domain/index.ts";

const RESOLVER_TIMEOUT_MS = 30_000;

/** Wraps one resolver call with a bounded timeout. A stuck or throwing resolver degrades to empty. Guards against both async rejection AND synchronous throw before Promise is returned. */
async function resolveWithTimeout(
  resolver: ServiceBoundaryResolverPort,
  system: RepoRef[],
  front: RepoRef,
  timeoutMs: number,
): Promise<ResolveLinksResult> {
  const empty: ResolveLinksResult = { links: [], drift: [], external: [], unresolved: [] };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(empty), timeoutMs);
    Promise.resolve()
      .then(() => resolver.resolveLinks(system, front))
      .then(
        (r) => { clearTimeout(timer); resolve(r); },
        (err) => {
          clearTimeout(timer);
          /* Surface error loudly; degrade to empty (fail-open, never blocks). */
          console.error("[CompositeServiceBoundaryResolver] resolver failed:", err instanceof Error ? err.message : String(err));
          resolve(empty);
        },
      );
  });
}

/** Dedup key: same (from, to, transport, contractRef) pair = same link; keep highest confidence. */
function linkKey(l: ServiceLink): string {
  return `${l.from.repo}|${l.from.file}|${l.from.symbol}|${l.to.repo}|${l.to.file}|${l.to.symbol}|${l.transport}|${l.contractRef ?? ""}`;
}

export class CompositeServiceBoundaryResolver implements ServiceBoundaryResolverPort {
  constructor(
    private readonly resolvers: readonly ServiceBoundaryResolverPort[],
    private readonly timeoutMs = RESOLVER_TIMEOUT_MS,
  ) {}

  async resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult> {
    const all = await Promise.all(
      this.resolvers.map((r) => resolveWithTimeout(r, system, front, this.timeoutMs)),
    );

    const seenLinks = new Map<string, ServiceLink>();
    const seenDrift = new Set<string>();
    const seenExternal = new Set<string>();
    const seenUnresolved = new Set<string>();

    const drift: ContractDrift[] = [];
    const external: ExternalCall[] = [];
    const unresolved: UnresolvedCall[] = [];

    for (const result of all) {
      for (const link of result.links) {
        const key = linkKey(link);
        const existing = seenLinks.get(key);
        if (!existing || link.confidence > existing.confidence) seenLinks.set(key, link);
      }
      for (const d of result.drift) {
        const key = `${d.from.file}|${d.from.symbol}|${d.verb}|${d.path}`;
        if (!seenDrift.has(key)) { seenDrift.add(key); drift.push(d); }
      }
      for (const e of result.external) {
        const key = `${e.from?.file ?? ""}|${e.verb}|${e.path}`;
        if (!seenExternal.has(key)) { seenExternal.add(key); external.push(e); }
      }
      for (const u of result.unresolved) {
        const key = `${u.file}|${u.rawArg}`;
        if (!seenUnresolved.has(key)) { seenUnresolved.add(key); unresolved.push(u); }
      }
    }

    return { links: [...seenLinks.values()], drift, external, unresolved };
  }
}
