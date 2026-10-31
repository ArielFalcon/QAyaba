/*
 * The resolved links as a graph over repositories (RFC-0011). Pure: it knows no transport, repo name or framework, only the
 * ends of a `ServiceLink`. A walk over it ends because a link enters the answer once and the links are a finite set; no hop
 * count or size constant bounds it.
 */
import { linkIdentity, type ImpactDirection, type ImpactedLink, type ServiceLink } from "@kernel/service-links.ts";

const byKey = (a: ServiceLink, b: ServiceLink): number => (linkIdentity(a) < linkIdentity(b) ? -1 : linkIdentity(a) > linkIdentity(b) ? 1 : 0);

/** The repos a hop walks next and the links that feed each. */
export interface FrontierRepo {
  repo: string;
  fed: ImpactedLink[];
}

export class LinkGraph {
  private readonly intoRepo = new Map<string, ServiceLink[]>();
  private readonly outOfRepo = new Map<string, ServiceLink[]>();

  constructor(links: readonly ServiceLink[]) {
    for (const link of [...links].sort(byKey)) {
      push(this.intoRepo, link.to.repo, link);
      push(this.outOfRepo, link.from.repo, link);
    }
  }

  /** The links whose call lands in `repo`, in identity order. */
  into(repo: string): ServiceLink[] {
    return [...(this.intoRepo.get(repo) ?? [])];
  }

  /** The links whose call site is in `repo`, in identity order. */
  outOf(repo: string): ServiceLink[] {
    return [...(this.outOfRepo.get(repo) ?? [])];
  }

  /** Whether a link out of `repo` lands in a repo that has links out of its own: a chain of two links starts here. */
  hasOnward(repo: string): boolean {
    return this.outOf(repo).some((link) => this.outOf(link.to.repo).length > 0);
  }

  /**
   * The repos the next hop walks, each with the fresh links that feed it, in repo order. Upstream a fresh link feeds the repo
   * its call site is in, and that repo is walked only when some link lands in it; downstream it feeds the repo it lands in,
   * walked only when that repo has links out.
   */
  frontier(direction: ImpactDirection, fresh: readonly ImpactedLink[]): FrontierRepo[] {
    const fed = new Map<string, ImpactedLink[]>();
    for (const impacted of fresh) {
      const repo = direction === "upstream" ? impacted.link.from.repo : impacted.link.to.repo;
      const walkable = direction === "upstream" ? this.intoRepo.has(repo) : this.outOfRepo.has(repo);
      if (walkable) push(fed, repo, impacted);
    }
    return [...fed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([repo, links]) => ({ repo, fed: links.sort((a, b) => byKey(a.link, b.link)) }));
  }
}

/** The links a walk in one direction has already admitted. */
export class LinkWalk {
  private readonly seen = new Set<string>();

  constructor(readonly direction: ImpactDirection) {}

  /** The links not admitted before, in identity order; they are admitted now. */
  admit(links: readonly ImpactedLink[]): ImpactedLink[] {
    const fresh: ImpactedLink[] = [];
    for (const impacted of [...links].sort((a, b) => byKey(a.link, b.link))) {
      const key = linkIdentity(impacted.link);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push(impacted);
    }
    return fresh;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const held = map.get(key);
  if (held) held.push(value);
  else map.set(key, [value]);
}
