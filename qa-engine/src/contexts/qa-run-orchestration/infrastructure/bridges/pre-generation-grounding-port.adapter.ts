/* PreGenerationGroundingPort: fail-open explorer + context.json + context pack. Never throws. */

import type { PreGenerationGroundingPort, GroundingResult, HarnessFacts } from "../../application/ports/index.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { buildContextPack, defaultContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ArchitectureContext, CommitIntent, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";
import { readManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { extractExportedNames, isSafeAttributeName } from "@contexts/generation/domain/harness-facts.ts";
import { formatSuiteEntry } from "@contexts/generation/domain/suite-entry.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { listSpecFiles, readFailureReason, readOwnedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { raceWithAbort, isAbortError } from "./abort-race.ts";

const diffParser = new DiffParserService();

export interface PreGenerationGroundingStaticContext {
  e2eDir: string;
  baseUrl?: string; /* live DEV base URL — absent -> the pack's DOM component is skipped */
  testIdAttribute?: string; /* config-declared convention (e.g. "data-cy") — forwarded to DOM capture */
  contextMap?: ArchitectureContext; /* the FE<->BE architecture map (context.json), if loaded */
  prChangedFiles?: string[]; /* union of changed files, for contract filtering */
  stagedRoots?: string[]; /* cross-repo runs only: where the triggering service's snapshot was staged, as the map may name it (present even when empty) — the pack ranks a route only by the spec of an operation it joins, under these roots */
}

export interface PreGenerationGroundingCollaborators {
  /* Optional overrides — default to the real generation/infrastructure primitives. Injectable for testing (existence-level: this bridge is exercised without a real Playwright/browser). */
  buildContextPack?: typeof buildContextPack;
  contextPackDeps?: ContextPackDeps;
  loadContextMap?: (specDir: string) => ArchitectureContext | undefined;
  /*
   * Optional explorer pass. Called fail-open before buildContextPack. Absent collaborator, or a
   * ground() call with no sha, → brief stays undefined (see ground()'s own guard below).
   * `sha` is REQUIRED, not optional: every real caller of ground() (run-qa.use-case.ts) always
   * threads a genuine RunQaInput.sha, so an optional sha here only invited a silent fallback to
   * something else entirely (e.g. the run namespace) instead of a real commit sha.
   */
  exploreBrief?: (args: {
    specDir: string;
    diff?: string;
    signal?: AbortSignal;
    sha: string;
    intent?: CommitIntent;
    /** Threaded from ground()'s own opts.runId — absent when the caller has none. */
    runId?: string;
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

/* Where the context map is, relative to the spec directory, and the most of it the orchestrator reads: a map is a few lines per route and per operation, so the cap is far above any real one, and a larger file is no map. */
const CONTEXT_MAP_FILE = ".qa/context.json";
export const MAX_CONTEXT_MAP_BYTES = 8 * 1024 * 1024;

/* `${specDir}/.qa/context.json` is what the agent writes in context mode, in a directory it writes into, so it is read strictly (readOwnedSpecFile: no link anywhere on the way, a regular file within the cap, a pipe never waited on) and nothing it holds is ever quoted: a warning goes to logs and to Issues, so it names the file and says why in words of its own, never in the file's. Missing → undefined, silently: a first run, or an app that never ran context mode. Anything else that is not a valid map → undefined with a warning (never throw, never a partial map). */
export function loadContextMapFromDisk(specDir: string): ArchitectureContext | undefined {
  const ctxJsonPath = join(specDir, CONTEXT_MAP_FILE);
  let read;
  try {
    read = readOwnedSpecFile({ mirrorDir: specDir, specDir }, CONTEXT_MAP_FILE, MAX_CONTEXT_MAP_BYTES);
  } catch (err) {
    console.warn(`[qa] WARNING: ${ctxJsonPath} could not be read (${readFailureReason(err)}); contextMap stays absent this run (non-blocking).`);
    return undefined;
  }
  if ("absent" in read) return undefined;
  if ("reason" in read) {
    console.warn(`[qa] WARNING: ${ctxJsonPath} was not read (${read.reason}); contextMap stays absent this run (non-blocking).`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    console.warn(`[qa] WARNING: ${ctxJsonPath} is not valid JSON; contextMap stays absent this run (non-blocking).`);
    return undefined;
  }
  if (!isValidArchitectureContext(parsed)) {
    console.warn(`[qa] WARNING: ${ctxJsonPath} exists but failed form-validation; contextMap stays absent this run (contracts component degrades gracefully).`);
    return undefined;
  }
  return parsed;
}

/* Every *.spec.ts under `dir`, relative to it, without following a link: the listing of the module that confines what the agent writes. */
export const enumerateExistingSpecFiles = listSpecFiles;

/* The fixtures file is repo content of unknown shape: it is scanned only when it is a small regular file. */
export const MAX_FIXTURES_FILE_BYTES = 256 * 1024;
const FIXTURES_FILE = "fixtures.ts";

function skipFixtures(path: string, reason: string): undefined {
  console.warn(`[qa] WARNING: harness facts: fixtures file ${path} not scanned (${reason}) — no fixture facts this run (non-blocking).`);
  return undefined;
}

/* A regular file within the size cap, read through a descriptor that does not follow a symlink, and never more than the cap. Any failure omits the fixtures facts with a warning; nothing is thrown and nothing replaces them. */
function readFixtureFacts(specDir: string): HarnessFacts["fixtures"] {
  const path = join(specDir, FIXTURES_FILE);
  try {
    /* Judged by what it is before it is opened: opening a named pipe for reading waits for a writer that never comes. The open does not wait either, should a pipe be put there after that look. */
    if (!lstatSync(path).isFile()) return skipFixtures(path, "not a regular file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let source: string;
    try {
      const { size } = fstatSync(fd);
      if (size > MAX_FIXTURES_FILE_BYTES) return skipFixtures(path, `larger than ${MAX_FIXTURES_FILE_BYTES} bytes`);
      const buffer = Buffer.alloc(size);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      source = buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
    /* A name that needed redaction is not a plain identifier worth stating: it is dropped, never passed on redacted. */
    const exports = extractExportedNames(source).filter((name) => sanitizeText(name).text === name);
    if (exports.length === 0) return skipFixtures(path, "no exports found");
    return { file: FIXTURES_FILE, exports };
  } catch (err) {
    return skipFixtures(path, err instanceof Error ? err.message : String(err));
  }
}

function readAttributeFact(testIdAttribute: string | undefined): string | undefined {
  if (testIdAttribute === undefined) return undefined;
  /* A plain attribute name that redaction would still change is secret-shaped: it is left out, never passed on redacted. */
  if (isSafeAttributeName(testIdAttribute) && sanitizeText(testIdAttribute).text === testIdAttribute) return testIdAttribute;
  console.warn("[qa] WARNING: harness facts: the configured test-id attribute is not a plain attribute name — left out this run (non-blocking).");
  return undefined;
}

/* The configured test-id attribute and what the suite's fixtures file exports, or undefined when there is nothing to state. */
export function readHarnessFacts(input: { specDir: string; testIdAttribute?: string }): HarnessFacts | undefined {
  const testIdAttribute = readAttributeFact(input.testIdAttribute);
  const fixtures = readFixtureFacts(input.specDir);
  if (testIdAttribute === undefined && fixtures === undefined) return undefined;
  return { ...(testIdAttribute !== undefined ? { testIdAttribute } : {}), ...(fixtures ? { fixtures } : {}) };
}

export class PreGenerationGroundingPortAdapter implements PreGenerationGroundingPort {
  constructor(
    private readonly ctx: PreGenerationGroundingStaticContext,
    private readonly collaborators: PreGenerationGroundingCollaborators = {},
  ) {}

  async ground(specDir: string, signal?: AbortSignal, diff?: string, opts?: { sha: string; intent?: CommitIntent; runId?: string }): Promise<GroundingResult> {
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
        /* Fold flow/objective from the manifest into each existingSpecFiles string (formatSuiteEntry: `path — flow: X, objective: Y`). Filename-only would hide duplicate flows; the field stays string[] so metadata cannot be a separate typed field. Never fabricated: the manifest is read as it is on disk, so an entry that lacks a flow or an objective (a legacy or hand-edited one) is folded without it and never says `undefined`. */
        let byFile = new Map<string, { flow?: string; objective?: string }>();
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
        result.existingSpecFiles = found.map((file) => formatSuiteEntry({ file, ...byFile.get(file) }));
      }
    } catch (err) {
      console.warn(`[qa] WARNING: existing-spec enumeration failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    const harnessFacts = readHarnessFacts({ specDir, ...(this.ctx.testIdAttribute ? { testIdAttribute: this.ctx.testIdAttribute } : {}) });
    if (harnessFacts) result.harnessFacts = harnessFacts;

    /*
     * Explorer pass is optional and fail-open. Throw, absent collaborator, or no sha (opts.sha is
     * required on the collaborator's own contract — never fabricated) → brief stays undefined;
     * pack degrades to DOM+contracts.
     */
    let brief: ExplorationBrief | undefined;
    if (this.collaborators.exploreBrief && opts?.sha) {
      try {
        brief = await this.collaborators.exploreBrief({
          specDir,
          sha: opts.sha,
          ...(diff !== undefined ? { diff } : {}),
          ...(signal ? { signal } : {}),
          ...(opts?.intent ? { intent: opts.intent } : {}),
          ...(opts?.runId ? { runId: opts.runId } : {}),
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
          ...(this.ctx.stagedRoots ? { stagedRoots: this.ctx.stagedRoots } : {}),
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
