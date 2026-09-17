/* OpenAPI-anchored BE→BE HTTP link resolver. App-specific patterns come from the injected HttpBackendBoundaryProfile. resolveLinks never throws: per-repo/per-file errors skip that unit; an unknown callPattern.kind degrades to an empty result. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type {
  RepoRef, ServiceLink, ServiceSymbolRef, ContractDrift, ExternalCall, UnresolvedCall,
  HttpBackendBoundaryProfile,
} from "../domain/index.ts";
import { CallPatternCatalog } from "./call-pattern-catalog.ts";
import { compilePrefixTemplate, compileRepoTemplate, type PrefixMatch } from "./boundary-template.ts";
import { compileFileGlob } from "./glob-suffix.ts";
import { walkRepoFiles } from "./repo-walk.ts";
import { parseOpenApiYaml, findOp, findOpAnyService, segs, type IngressOp } from "./openapi-ingress.ts";

const EMPTY: ResolveLinksResult = { links: [], drift: [], external: [], unresolved: [] };

/** Resolve a catalog rawArg to a static path, or null when the argument is dynamic. */
function resolveLiteralPath(rawArg: string): string | null {
  const trimmed = rawArg.trim();
  const q = trimmed[0];
  if (q === "'" || q === '"' || q === "`") {
    const close = trimmed.indexOf(q, 1);
    if (close <= 1) return null;
    return trimmed.slice(1, close);
  }
  if (trimmed.startsWith("/")) return trimmed;
  return null;
}

export class HttpBackendResolver implements ServiceBoundaryResolverPort {
  private readonly serviceOfRepoSlug: (slug: string) => string;
  private readonly matchServicePrefix: (path: string) => PrefixMatch | null;
  private readonly isSourceFile: (filename: string) => boolean;

  constructor(private readonly profile: HttpBackendBoundaryProfile) {
    this.serviceOfRepoSlug = compileRepoTemplate(profile.serviceRepoTemplate);
    this.matchServicePrefix = compilePrefixTemplate(profile.servicePrefixTemplate);
    this.isSourceFile = compileFileGlob(profile.sourceFiles);
  }

  private serviceOfRepo(repo: RepoRef): string {
    const slug = repo.repo.split("/").pop() ?? repo.repo;
    return this.serviceOfRepoSlug(slug);
  }

  async resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult> {
    try {
      return this.resolveLinksUnsafe(system, front);
    } catch {
      return EMPTY;
    }
  }

  private resolveLinksUnsafe(system: RepoRef[], front: RepoRef): ResolveLinksResult {
    const extractor = CallPatternCatalog[this.profile.callPattern.kind];
    if (!extractor) return EMPTY;

    const seenRepos = new Set<string>();
    const pool: RepoRef[] = [];
    for (const repo of [...system, front]) {
      if (seenRepos.has(repo.repo)) continue;
      seenRepos.add(repo.repo);
      pool.push(repo);
    }

    const ingress: IngressOp[] = [];
    const knownServices = new Set<string>();
    const repoOfService = new Map<string, RepoRef>();
    for (const repo of pool) {
      const openapiPath = join(repo.mirrorDir, this.profile.openApiPath);
      let content: string;
      try { content = readFileSync(openapiPath, "utf8"); } catch { continue; }
      const service = this.serviceOfRepo(repo);
      knownServices.add(service);
      repoOfService.set(service, repo);
      ingress.push(...parseOpenApiYaml(service, content));
    }

    const links: ServiceLink[] = [];
    const drift: ContractDrift[] = [];
    const external: ExternalCall[] = [];
    const unresolved: UnresolvedCall[] = [];

    for (const repo of pool) {
      const files = walkRepoFiles(repo.mirrorDir, (name) => this.isSourceFile(name));
      for (const full of files) {
        let text: string;
        try { text = readFileSync(full, "utf8"); } catch { continue; }
        const relFile = full.slice(repo.mirrorDir.length + 1);
        for (const occ of extractor(text, this.profile.callPattern)) {
          const path = resolveLiteralPath(occ.rawArg);
          const fromSymbol = occ.enclosingMethod ?? occ.enclosingClass ?? occ.rawArg;
          const fromRef: ServiceSymbolRef = { repo: repo.repo, file: relFile, symbol: fromSymbol };

          if (path === null) {
            unresolved.push({ rawArg: occ.rawArg, file: relFile });
            continue;
          }

          const verb = occ.verb.toUpperCase();
          const prefix = this.matchServicePrefix(path);
          let op: IngressOp | undefined;
          if (prefix) {
            if (!knownServices.has(prefix.service)) {
              external.push({ path, verb, from: fromRef });
              continue;
            }
            op = findOp(ingress, prefix.service, verb, segs(prefix.resource));
          } else {
            op = findOpAnyService(ingress, verb, segs(path));
          }

          if (op) {
            const backendRepo = repoOfService.get(op.service);
            links.push({
              from: fromRef,
              to: {
                repo: backendRepo?.repo ?? `service:${op.service}`,
                file: this.profile.openApiPath,
                symbol: op.operationId,
              },
              transport: "http",
              contractRef: op.operationId,
              confidence: 1.0,
              source: "http-backend-resolver",
            });
          } else {
            drift.push({ from: fromRef, verb, path });
          }
        }
      }
    }

    return { links, drift, external, unresolved };
  }
}
