/* OpenAPI-anchored FE↔BE HTTP link resolver. App-specific patterns come from the injected HttpBoundaryProfile. Per-repo errors degrade to an empty result for that repo — never throws. from.symbol walks the AST to the enclosing method; falls back to a backward-scan heuristic if tree-sitter fails to load. */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type {
  RepoRef, ServiceLink, ServiceSymbolRef, ContractDrift, ExternalCall, UnresolvedCall,
  HttpBoundaryProfile,
} from "../domain/index.ts";
import { CallSiteCatalog, type CallSiteOccurrence } from "./call-site-catalog.ts";
import { compilePrefixTemplate, compileRepoTemplate, type PrefixMatch } from "./boundary-template.ts";
import { compileFileGlob } from "./glob-suffix.ts";
import { walkRepoFiles } from "./repo-walk.ts";
import { parseOpenApiYaml, findOp, segs, isParam, type IngressOp } from "./openapi-ingress.ts";

const CONST_RE = /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

interface EgressCallSite {
  file: string;
  verb: string;
  rawArg: string;
  path: string | null;
  enclosingMethod: string | null;
}

/** Build a const-resolution map from all *.api.ts files. Cross-file const refs use the last-seen value. */
function buildConstMap(apiFiles: string[]): Record<string, string> {
  const consts: Record<string, string> = {};
  for (const f of apiFiles) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    CONST_RE.lastIndex = 0;
    for (let m; (m = CONST_RE.exec(text)) !== null;) {
      const name = m[1];
      const value = m[3];
      if (name !== undefined && value !== undefined) consts[name] = value;
    }
  }
  return consts;
}

/** Recursively resolve template literals and const refs (same as spike). Returns null on unresolvable. */
function resolveVal(raw: string, consts: Record<string, string>, seen = new Set<string>()): string {
  return String(raw).replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const k = expr.trim();
    if (consts[k] !== undefined && !seen.has(k)) {
      const childSeen = new Set(seen);
      childSeen.add(k);
      return resolveVal(consts[k]!, consts, childSeen);
    }
    return "{p}";
  });
}

/** Resolve a single call-site arg to a path string (or null = unresolvable method param). */
function resolveArg(arg: string, consts: Record<string, string>): string | null {
  const trimmed = arg.trim();
  const q = trimmed[0];
  if (q === "'" || q === '"' || q === "`") {
    const close = trimmed.indexOf(q, 1);
    return resolveVal(close === -1 ? trimmed.slice(1) : trimmed.slice(1, close), consts);
  }
  if (consts[trimmed] !== undefined) return resolveVal(consts[trimmed]!, consts);
  return null;
}


const ENCLOSING_NODE_TYPES = new Set([
  "method_definition",
  "function_declaration",
  "function",
  "method_signature",
  "public_field_definition",
]);

/* Lazily-resolved tree-sitter parser for TypeScript. null = failed to load (fail-open). Using a module-level promise so initialization runs once across all resolver calls. */
type TsParser = { parse(src: string): { rootNode: { namedDescendantForIndex(i: number): TsSyntaxNode } } };
type TsSyntaxNode = {
  type: string;
  parent: TsSyntaxNode | null;
  children: TsSyntaxNode[];
  namedChildren: TsSyntaxNode[];
  text: string;
};
let tsParserPromise: Promise<TsParser | null> | null = null;

function getTsParser(): Promise<TsParser | null> {
  if (tsParserPromise) return tsParserPromise;
  tsParserPromise = (async (): Promise<TsParser | null> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const Parser = (await import("web-tree-sitter")).default;
      await (Parser as { init(): Promise<void> }).init();
      const _require = createRequire(import.meta.url);
      let wasmPath: string;
      try {
        const pkgJson = _require.resolve("tree-sitter-wasms/package.json");
        wasmPath = resolve(dirname(pkgJson), "out", "tree-sitter-typescript.wasm");
      } catch (err) {
        console.warn(
          "[OpenApiHttpResolver] tree-sitter-wasms not installed — enclosing-method extraction will use fallback backward scan. Install tree-sitter-wasms@0.1.13 for accurate results.",
          err instanceof Error ? err.message : String(err),
        );
        return null; /* tree-sitter-wasms not installed — fail-open */
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      const language = await (Parser as any).Language.load(wasmPath);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
      const parser = new (Parser as any)();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      parser.setLanguage(language);
      return parser as TsParser;
    } catch (err) {
      console.warn(
        "[OpenApiHttpResolver] web-tree-sitter failed to load — enclosing-method extraction will use fallback backward scan. Install web-tree-sitter@0.20.8 for accurate results.",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  })();
  return tsParserPromise;
}

/** Walk UP the AST from `node` to the nearest enclosing named method/function.
 *  Returns the method name string, or null if none found.
 *
 *  Handles two patterns:
 *  1. ENCLOSING_NODE_TYPES nodes (method_definition, function_declaration, etc.) — the name is
 *     a direct named child of type "property_identifier" or "identifier".
 *  2. variable_declarator — `const listOrders = () => ...` in tree-sitter produces:
 *       lexical_declaration → variable_declarator[identifier "listOrders", arrow_function]
 *     The arrow_function has no name child; the identifier is a SIBLING inside variable_declarator.
 *     We detect this by checking cur.parent.type === "variable_declarator" and extracting
 *     the identifier sibling. */
function walkUpToMethod(node: TsSyntaxNode | null): string | null {
  let cur = node?.parent ?? null;
  while (cur !== null) {
    if (ENCLOSING_NODE_TYPES.has(cur.type)) {
      for (const child of cur.namedChildren) {
        if (child.type === "property_identifier" || child.type === "identifier") {
          const name = child.text;
          if (name && name.length > 0) return name;
        }
      }
    } else if (cur.type === "variable_declarator") {
      for (const child of cur.namedChildren) {
        if (child.type === "identifier") {
          const name = child.text;
          if (name && name.length > 0) return name;
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

const BACKWARD_SCAN_LIMIT = 2048;

/** Fallback backward-scan heuristic: scan the text before `matchIndex` for the last
 *  "name(" pattern that is not a keyword. Used only when tree-sitter fails to load.
 *  Exported for isolated unit-testing of the fallback path (independent of WASM availability). */
export function extractEnclosingMethodFallback(text: string, matchIndex: number): string | null {
  const start = Math.max(0, matchIndex - BACKWARD_SCAN_LIMIT);
  const slice = text.slice(start, matchIndex);
  const METHOD_DECL_RE = /\b(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]*)?\s*\{/g;
  let lastName: string | null = null;
  for (let mm; (mm = METHOD_DECL_RE.exec(slice)) !== null;) {
    const name = mm[1];
    if (
      name !== undefined &&
      name !== "if" && name !== "for" && name !== "while" && name !== "switch" &&
      name !== "catch" && name !== "function" && name !== "return" && name !== "new" &&
      name !== "typeof" && name !== "instanceof" && name !== "await" && name !== "get" &&
      name !== "set" && name !== "this" && name !== "rest"
    ) {
      lastName = name;
    }
  }
  return lastName;
}

/** Build a per-file enclosing-method map using tree-sitter.
 *  Maps each call-site match index (from the CallSiteCatalog extractor) → enclosing method name.
 *  Uses the parser when available; returns empty map on failure (fallback path kicks in). */
async function buildEnclosingMethodMap(
  text: string,
  matchIndices: number[],
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (matchIndices.length === 0) return result;
  const parser = await getTsParser();
  if (!parser) return result;
  let tree: { rootNode: { namedDescendantForIndex(i: number): TsSyntaxNode } };
  try {
    tree = parser.parse(text);
  } catch {
    return result;
  }
  for (const idx of matchIndices) {
    try {
      const callNode = tree.rootNode.namedDescendantForIndex(idx);
      result.set(idx, walkUpToMethod(callNode));
    } catch {
      result.set(idx, null);
    }
  }
  return result;
}

/** Extract all HTTP call-sites from a set of front egress files, using the call-site shape
 *  selected by `frontCallSite.kind` (looked up in the in-core CallSiteCatalog) and the concrete
 *  receiver from config. Async because tree-sitter initialization is async (WASM load). */
async function extractEgress(
  apiFiles: string[],
  mirrorDir: string,
  consts: Record<string, string>,
  frontCallSite: HttpBoundaryProfile["frontCallSite"],
): Promise<EgressCallSite[]> {
  const extractor = CallSiteCatalog[frontCallSite.kind];
  if (!extractor) return []; /* unknown call-site kind in config — fail-open, no match */

  const result: EgressCallSite[] = [];
  for (const full of apiFiles) {
    let text: string;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    const relFile = full.slice(mirrorDir.length + 1);

    const callSites: CallSiteOccurrence[] = extractor(text, frontCallSite);

    const enclosingMap = await buildEnclosingMethodMap(text, callSites.map((c) => c.index));

    for (const { index, verb, rawArg } of callSites) {
      let enclosingMethod: string | null;
      if (enclosingMap.has(index)) {
        enclosingMethod = enclosingMap.get(index) ?? null;
      } else {
        enclosingMethod = extractEnclosingMethodFallback(text, index);
      }
      result.push({
        file: relFile,
        verb: verb.toUpperCase(),
        rawArg,
        path: resolveArg(rawArg, consts),
        enclosingMethod,
      });
    }
  }
  return result;
}

export class OpenApiHttpResolver implements ServiceBoundaryResolverPort {
  /* Compiled once from the injected profile — the ONLY place these app-specific shapes are read from config rather than hardcoded (Invariant #1). */
  private readonly serviceOfRepoSlug: (slug: string) => string;
  private readonly matchServicePrefix: (path: string) => PrefixMatch | null;
  private readonly isFrontEgressFile: (filename: string) => boolean;

  constructor(private readonly profile: HttpBoundaryProfile) {
    this.serviceOfRepoSlug = compileRepoTemplate(profile.serviceRepoTemplate);
    this.matchServicePrefix = compilePrefixTemplate(profile.servicePrefixTemplate);
    this.isFrontEgressFile = compileFileGlob(profile.frontFiles);
  }

  /** Derive the service name for a repo via the config-supplied serviceRepoTemplate
   *  (e.g. nname's "ms-name-{service}": ms-name-orders → "orders"). Single source of truth —
   *  every call-site that needs a repo's service name goes through this one method. */
  private serviceOfRepo(repo: RepoRef): string {
    const slug = repo.repo.split("/").pop() ?? repo.repo;
    return this.serviceOfRepoSlug(slug);
  }

  async resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult> {
    const ingress: IngressOp[] = [];
    const knownServices = new Set<string>();
    const repoOfService = new Map<string, RepoRef>();
    for (const repo of system) {
      const openapiPath = join(repo.mirrorDir, this.profile.openApiPath);
      let content: string;
      try { content = readFileSync(openapiPath, "utf8"); } catch { continue; }
      const service = this.serviceOfRepo(repo);
      knownServices.add(service);
      repoOfService.set(service, repo);
      ingress.push(...parseOpenApiYaml(service, content));
    }

    const apiFiles = walkRepoFiles(front.mirrorDir, (name) => this.isFrontEgressFile(name));
    const consts = buildConstMap(apiFiles);
    const egress = await extractEgress(apiFiles, front.mirrorDir, consts, this.profile.frontCallSite);

    const links: ServiceLink[] = [];
    const drift: ContractDrift[] = [];
    const external: ExternalCall[] = [];
    const unresolved: UnresolvedCall[] = [];

    for (const e of egress) {
      if (e.path === null) {
        unresolved.push({ rawArg: e.rawArg, file: e.file });
        continue;
      }

      const m = this.matchServicePrefix(e.path);
      if (!m) {
        unresolved.push({ rawArg: e.rawArg, file: e.file });
        continue;
      }
      const { service, resource } = m;

      if (!knownServices.has(service)) {
        external.push({
          path: e.path,
          verb: e.verb,
          from: { repo: front.repo, file: e.file, symbol: e.enclosingMethod ?? e.rawArg },
        });
        continue;
      }

      const resourceSegs = segs(resource);
      const op = findOp(ingress, service, e.verb, resourceSegs);
      if (op) {
        const fromRef: ServiceSymbolRef = {
          repo: front.repo,
          file: e.file,
          symbol: e.enclosingMethod ?? e.rawArg,
        };
        const backendRepo = repoOfService.get(service);
        const toRef: ServiceSymbolRef = {
          repo: backendRepo?.repo ?? `service:${service}`,
          file: this.profile.openApiPath,
          symbol: op.operationId,
        };
        const hasPlaceholderSegment = resourceSegs.some((s) => s === "{p}");
        const consumedPlaceholder = hasPlaceholderSegment && op.segs.some(isParam);
        const confidence = consumedPlaceholder ? 0.6 : 1.0;
        links.push({
          from: fromRef,
          to: toRef,
          transport: "http",
          contractRef: op.operationId,
          confidence,
          source: "openapi-http",
        });
      } else {
        drift.push({
          from: {
            repo: front.repo,
            file: e.file,
            symbol: e.enclosingMethod ?? e.rawArg,
          },
          verb: e.verb,
          path: e.path,
        });
      }
    }

    return { links, drift, external, unresolved };
  }
}
