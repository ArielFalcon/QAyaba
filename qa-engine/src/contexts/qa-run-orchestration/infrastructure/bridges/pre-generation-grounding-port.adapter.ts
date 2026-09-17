/* PreGenerationGroundingPort: fail-open explorer + context.json + context pack. Never throws. */

import type { PreGenerationGroundingPort, GroundingResult } from "../../application/ports/index.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildContextPack, defaultContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ArchitectureContext, CommitIntent, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";
import { readManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { raceWithAbort, isAbortError } from "./abort-race.ts";

const diffParser = new DiffParserService();

export interface PreGenerationGroundingStaticContext {
  e2eDir: string;
  baseUrl?: string; /* live DEV base URL — absent -> the pack's DOM component is skipped */
  testIdAttribute?: string; /* config-declared convention (e.g. "data-cy") — forwarded to DOM capture */
  contextMap?: ArchitectureContext; /* the FE<->BE architecture map (context.json), if loaded */
  prChangedFiles?: string[]; /* union of changed files, for contract filtering */
}

export interface PreGenerationGroundingCollaborators {
  /* Optional overrides — default to the real generation/infrastructure primitives. Injectable for testing (existence-level: this bridge is exercised without a real Playwright/browser). */
  buildContextPack?: typeof buildContextPack;
  contextPackDeps?: ContextPackDeps;
  loadContextMap?: (specDir: string) => ArchitectureContext | undefined;
  /* Optional explorer pass. Called fail-open before buildContextPack. Absent → brief stays undefined. */
  exploreBrief?: (args: {
    specDir: string;
    diff?: string;
    signal?: AbortSignal;
    sha?: string;
    intent?: CommitIntent;
  }) => Promise<ExplorationBrief | undefined>;
}

function isValidArchitectureContext(raw: unknown): raw is ArchitectureContext {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const c = raw as Partial<ArchitectureContext>;
  if (typeof c.builtAtSha !== "string" || c.builtAtSha.trim().length === 0) return false;
  if (!Array.isArray(c.routes) || !Array.isArray(c.api) || !Array.isArray(c.feBe)) return false;

  const routePaths = new Set<string>();
  for (const entry of c.routes) {
    const path = (entry as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || path.trim().length === 0) return false;
    if (routePaths.has(path)) return false; /* duplicate path */
    routePaths.add(path);
  }

  const opIds = new Set<string>();
  for (const entry of c.api) {
    const o = entry as { operationId?: unknown; method?: unknown; path?: unknown } | undefined;
    if (typeof o?.operationId !== "string" || o.operationId.trim().length === 0) return false;
    if (opIds.has(o.operationId)) return false; /* duplicate operationId */
    opIds.add(o.operationId);
    if (typeof o?.method !== "string" || o.method.trim().length === 0) return false;
    if (typeof o?.path !== "string" || o.path.trim().length === 0) return false;
  }

  for (const entry of c.feBe) {
    const l = entry as { route?: unknown; operationId?: unknown } | undefined;
    if (typeof l?.route !== "string" || !routePaths.has(l.route)) return false;
    if (typeof l?.operationId !== "string" || !opIds.has(l.operationId)) return false;
  }

  if (c.flows !== undefined && !Array.isArray(c.flows)) return false;

  return true;
}

/* Reads `${specDir}/.qa/context.json`, form-validates it, returns the map when valid. Missing/malformed/invalid → undefined (never throw, never a partial map). */
export function loadContextMapFromDisk(specDir: string): ArchitectureContext | undefined {
  const ctxJsonPath = join(specDir, ".qa", "context.json");
  let raw: string;
  try {
    raw = readFileSync(ctxJsonPath, "utf8");
  } catch {
    return undefined; /* no committed context.json for this run (first run, or app never ran context mode) — graceful. */
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidArchitectureContext(parsed)) {
      console.warn(`[qa] WARNING: ${ctxJsonPath} exists but failed form-validation; contextMap stays absent this run (contracts component degrades gracefully).`);
      return undefined;
    }
    return parsed;
  } catch (err) {
    console.warn(`[qa] WARNING: could not parse ${ctxJsonPath} (non-blocking, contextMap stays absent this run): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function enumerateExistingSpecFiles(dir: string): string[] {
  let results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          results = results.concat(
            enumerateExistingSpecFiles(full).map((rel) => join(entry, rel)),
          );
        } else if (entry.endsWith(".spec.ts")) {
          results.push(entry);
        }
      } catch {
        /* A single entry failing stat (race, permissions) is skipped — never aborts the whole scan. */
      }
    }
  } catch {
  }
  return results;
}

export class PreGenerationGroundingPortAdapter implements PreGenerationGroundingPort {
  constructor(
    private readonly ctx: PreGenerationGroundingStaticContext,
    private readonly collaborators: PreGenerationGroundingCollaborators = {},
  ) {}

  async ground(specDir: string, signal?: AbortSignal, diff?: string, opts?: { sha?: string; intent?: CommitIntent }): Promise<GroundingResult> {
    if (signal?.aborted) return {};

    const result: GroundingResult = {};

    let contextMap = this.ctx.contextMap;
    try {
      const loadContextMap = this.collaborators.loadContextMap ?? loadContextMapFromDisk;
      const loaded = loadContextMap(specDir);
      if (loaded) contextMap = loaded;
    } catch (err) {
      console.warn(`[qa] WARNING: contextMap read-back failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (contextMap) result.contextMap = contextMap;

    try {
      const found = enumerateExistingSpecFiles(this.ctx.e2eDir);
      if (found.length > 0) {
        /* Fold flow/objective from the manifest into each existingSpecFiles string (`path — flow: X, objective: Y`). Filename-only would hide duplicate flows; the field stays string[] so metadata cannot be a separate typed field. Never fabricated. */
        let byFile = new Map<string, { flow: string; objective: string }>();
        try {
          const entries = await readManifest(this.ctx.e2eDir);
          byFile = new Map(
            entries
              .filter((e): e is typeof e & { file: string } => Boolean(e.file))
              .map((e) => [e.file, { flow: e.flow, objective: e.objective }]),
          );
        } catch (err) {
          console.warn(`[qa] WARNING: manifest read failed (non-blocking, existingSpecFiles stays plain): ${err instanceof Error ? err.message : String(err)}`);
        }
        result.existingSpecFiles = found.map((f) => {
          const meta = byFile.get(f);
          return meta ? `${f} — flow: ${meta.flow}, objective: ${meta.objective}` : f;
        });
      }
    } catch (err) {
      console.warn(`[qa] WARNING: existing-spec enumeration failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    /* Explorer pass is optional and fail-open. Throw or absent collaborator → brief undefined; pack degrades to DOM+contracts. */
    let brief: ExplorationBrief | undefined;
    if (this.collaborators.exploreBrief) {
      try {
        brief = await this.collaborators.exploreBrief({
          specDir,
          ...(diff !== undefined ? { diff } : {}),
          ...(signal ? { signal } : {}),
          ...(opts?.sha ? { sha: opts.sha } : {}),
          ...(opts?.intent ? { intent: opts.intent } : {}),
        });
      } catch (err) {
        console.warn(`[qa] WARNING: explorer pass failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (brief) result.contextBrief = brief;

    /* buildContextPack does not accept AbortSignal. Racing unblocks the run on cancel; the in-flight render keeps running to its own timeout and its result is discarded. This port never throws — abort resolves; the use-case routes abort after this call. */
    try {
      const build = this.collaborators.buildContextPack ?? buildContextPack;
      const deps = this.collaborators.contextPackDeps ?? defaultContextPackDeps;
      const deterministicRoutes = contextMap?.routes?.length
        ? contextMap.routes.map((r) => r.path).filter(Boolean)
        : undefined;
      const changedElements = diff ? diffParser.changedElements(diff) : undefined;
      const prChangedFiles = this.ctx.prChangedFiles ?? (diff ? diffParser.changedFiles(diff) : undefined);
      const buildPromise = build(
        {
          baseUrl: this.ctx.baseUrl,
          e2eDir: this.ctx.e2eDir,
          contextMap,
          prChangedFiles,
          testIdAttribute: this.ctx.testIdAttribute,
          ...(brief ? { brief } : {}),
          ...(deterministicRoutes?.length ? { routes: deterministicRoutes } : {}),
          ...(changedElements?.length ? { changedElements } : {}),
        },
        deps,
      );
      const packResult = signal ? await raceWithAbort(buildPromise, signal) : await buildPromise;
      if (packResult.text) result.contextPack = packResult.text;
    } catch (err) {
      if (isAbortError(err)) return result; /* abort: return whatever was gathered so far, never throw — see the note above. */
      console.warn(`[qa] WARNING: context-pack build FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }
}
