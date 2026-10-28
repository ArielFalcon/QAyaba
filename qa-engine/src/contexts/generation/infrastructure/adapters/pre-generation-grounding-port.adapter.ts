/* PreGenerationGroundingPort: fail-open context.json + context pack + harness facts. Never throws. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { GroundingChange } from "../../domain/grounding-change.ts";
import type { PreGenerationGroundingPort } from "../../application/ports/pre-generation-grounding.port.ts";
import type { GroundingResult } from "../../domain/pre-generation-grounding.ts";
import { exportedSignatures, fixtureMembers, playwrightConfigFacts, type HarnessFacts } from "../../domain/harness-facts.ts";
import { join } from "node:path";
import { buildContextPack, defaultContextPackDeps, packDeliveredItemIds } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ContextPackAssembly, ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ArchitectureContext } from "@contexts/generation/application/index.ts";
import type { ContextProvenance } from "@kernel/telemetry/context-provenance.ts";
import { readManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { extractExportedNames, isSafeAttributeName } from "@contexts/generation/application/index.ts";
import { formatSuiteEntry } from "@contexts/generation/application/index.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { listSpecFiles, readFailureReason, readOwnedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { raceWithAbort, isAbortError } from "@contexts/generation/domain/abort-race.ts";
import { withDeclaredResources } from "./implementation-resources.ts";
import { withChangedElementScopes } from "./changed-element-scope.ts";
import { withUnchangedLines, type MeasuredLabels } from "./changed-label-lines.ts";
import { changedDecisionsOf } from "./changed-decisions.ts";
import { filesLinkedToPages, rankRoutesWithRelevance } from "@contexts/generation/application/index.ts";
import type { PackAvailabilityInput } from "../pack-availability.ts";
import { routeChangeEvidence } from "./route-change-evidence.ts";
import { loadResponseFields } from "../openapi-response-fields.source.ts";
import type { ResponseFieldsOf } from "../../domain/expectation-gaps.ts";
import type { ConsumerExpectationsOf } from "../../domain/consumer-expectation.ts";
import { loadConsumerExpectations } from "../consumer-expectation/consumer-expectations.source.ts";
const diffParser = new DiffParserService();

export interface PreGenerationGroundingStaticContext {
  e2eDir: string;
  baseUrl?: string; /* live DEV base URL — absent -> the pack's DOM component is skipped */
  testIdAttribute?: string; /* config-declared convention (e.g. "data-cy") — forwarded to DOM capture */
  contextMap?: ArchitectureContext; /* the FE<->BE architecture map (context.json), if loaded */
  /* Where the map was effectively read from and how fresh it was. Read after the load, so it describes the source that won. */
  contextMapProvenance?: () => ContextProvenance | undefined;
  prChangedFiles?: string[]; /* union of changed files, for contract filtering */
  domPack?: boolean; /* false → the pack carries no live-DOM capture (no route ranking, no changed-element scopes); contracts and every other grounding source stay */
  /* false → no context pack is built at all (context mode discards it); the map and harness facts still load. */
  contextPack?: boolean;
  mirrorDir?: string; /* the working copy the map's implementationFiles are relative to — absent → a route is tied only to the files the map names */
  stagedRoots?: string[]; /* cross-repo runs only: where the triggering service's snapshot was staged, as the map may name it (present even when empty) — the pack ranks a route only by the spec of an operation it joins, under these roots */
  /* One file of the working copy's repository as it was at a commit, through the confined mirror reader: the route table at the run's base. Absent → no route is proven unchanged. */
  readAtRef?: (ref: string, file: string) => Promise<string | undefined>;
  /* Where the app keeps its OpenAPI documents (the config's `openapi` globs). Absent → files named like one are looked for. */
  openapi?: string | string[];
}

/* Told what grounding supplied, as it supplies it. Read-only: nothing it does reaches what the agent receives, and a fault in it is logged and ignored. */
export interface GroundingTrace {
  contextMap?(map: ArchitectureContext, provenance?: ContextProvenance): void;
  /* A stored map that did not fit the run's commit and was left out: said with the provenance that explains why, so the run does not read as one with no map at all. */
  contextMapLeftOut?(provenance: ContextProvenance): void;
  pack?(assembly: ContextPackAssembly): void;
}

export interface PreGenerationGroundingCollaborators {
  /* Optional observer of the sources (context map, context pack). Absent: nothing is told. */
  trace?: GroundingTrace;
  /* Optional overrides — default to the real generation/infrastructure primitives. Injectable for testing (existence-level: this adapter is exercised without a real Playwright/browser). */
  buildContextPack?: typeof buildContextPack;
  contextPackDeps?: ContextPackDeps;
  loadContextMap?: (specDir: string) => ArchitectureContext | undefined;
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
    /* mutation-scope:begin operation-id-filter */
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

/* A path that can name a file of the repository the map describes: text, not empty, and relative (not rooted, no drive or share, no step out of the repository). */
function isRepoRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (/^([\\/]|[A-Za-z]:)/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

/* The map with each route's implementationFiles reduced to its well-formed entries: an entry that is not a repo-relative path is dropped, a list left empty (or a value that is not a list) is removed from its route, and the route and the map always stay. Returns how many routes are left without any file, and how many entries were dropped, for the one warning the caller gives. */
function keepWellFormedImplementationFiles(map: ArchitectureContext): { map: ArchitectureContext; routesWithoutFiles: number; droppedEntries: number } {
  let routesWithoutFiles = 0;
  let droppedEntries = 0;
  const routes = map.routes.map((route) => {
    const { implementationFiles: declared, ...rest } = route as typeof route & { implementationFiles?: unknown };
    const files = Array.isArray(declared) ? declared.filter(isRepoRelativePath) : [];
    droppedEntries += (Array.isArray(declared) ? declared.length : 0) - files.length;
    if (files.length === 0) {
      routesWithoutFiles += 1;
      return rest;
    }
    return { ...rest, implementationFiles: files };
  });
  return { map: { ...map, routes }, routesWithoutFiles, droppedEntries };
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
    engineLog.warn(`[qa] WARNING: ${ctxJsonPath} could not be read (${readFailureReason(err)}); contextMap stays absent this run (non-blocking).`);
    return undefined;
  }
  if ("absent" in read) return undefined;
  if ("reason" in read) {
    engineLog.warn(`[qa] WARNING: ${ctxJsonPath} was not read (${read.reason}); contextMap stays absent this run (non-blocking).`);
    return undefined;
    /* mutation-scope:end operation-id-filter */
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  /* mutation-scope:begin context-map-json-read */
  } catch {
    engineLog.warn(`[qa] WARNING: ${ctxJsonPath} is not valid JSON; contextMap stays absent this run (non-blocking).`);
    return undefined;
  }
  if (!isValidArchitectureContext(parsed)) {
    engineLog.warn(`[qa] WARNING: ${ctxJsonPath} exists but failed form-validation; contextMap stays absent this run (contracts component degrades gracefully).`);
    return undefined;
  }
  const { map, routesWithoutFiles, droppedEntries } = keepWellFormedImplementationFiles(parsed);
  /* Route ranking ties a changed page file to its route through these files; a route without them is only ranked by the file that declares it. A count only: nothing the file holds is quoted. */
  if (routesWithoutFiles > 0 || droppedEntries > 0) {
    engineLog.warn(`[qa] WARNING: ${ctxJsonPath}: ${routesWithoutFiles} of ${map.routes.length} routes name no implementationFiles${droppedEntries > 0 ? ` (${droppedEntries} malformed entries dropped)` : ""}; a changed page file cannot be tied to them (non-blocking).`);
  }
  return map;
}
/* mutation-scope:end context-map-json-read */

/* Every *.spec.ts under `dir`, relative to it, without following a link: the listing of the module that confines what the agent writes. */
export const enumerateExistingSpecFiles = listSpecFiles;

/* The harness files are repo content of unknown shape: each is read strictly (readOwnedSpecFile: no link anywhere on the way, a regular file within the cap, a pipe never waited on). */
export const MAX_FIXTURES_FILE_BYTES = 256 * 1024;
const FIXTURES_FILE = "fixtures.ts";
const PLAYWRIGHT_CONFIG_FILE = "playwright.config.ts";

function skipHarnessFile(path: string, what: string, reason: string): undefined {
  engineLog.warn(`[qa] WARNING: harness facts: ${what} ${path} not scanned (${reason}) — no ${what} facts this run (non-blocking).`);
  return undefined;
}

/* The text of one harness file, or undefined (with a warning) when it cannot be read; an absent file is silent unless `warnWhenAbsent`. Nothing is thrown. */
function readHarnessText(specDir: string, file: string, what: string, warnWhenAbsent: boolean): string | undefined {
  const path = join(specDir, file);
  try {
    const read = readOwnedSpecFile({ mirrorDir: specDir, specDir }, file, MAX_FIXTURES_FILE_BYTES);
    if ("bytes" in read) return read.bytes.toString("utf8");
    if ("absent" in read) return warnWhenAbsent ? skipHarnessFile(path, what, "not found") : undefined;
    return skipHarnessFile(path, what, read.reason);
  } catch (err) {
    return skipHarnessFile(path, what, readFailureReason(err));
  }
}

function readFixtureFacts(specDir: string): HarnessFacts["fixtures"] {
  const source = readHarnessText(specDir, FIXTURES_FILE, "fixtures file", true);
  if (source === undefined) return undefined;
  /* A name that needed redaction is not a plain identifier worth stating: it is dropped, never passed on redacted. */
  const exports = extractExportedNames(source).filter((name) => sanitizeText(name).text === name);
  if (exports.length === 0) return skipHarnessFile(join(specDir, FIXTURES_FILE), "fixtures file", "no exports found");
  const signatures = exportedSignatures(source);
  const members = fixtureMembers(source);
  return { file: FIXTURES_FILE, exports, ...(signatures.length > 0 ? { signatures } : {}), ...(members.length > 0 ? { members } : {}) };
}

function readPlaywrightFacts(specDir: string): HarnessFacts["playwright"] {
  const source = readHarnessText(specDir, PLAYWRIGHT_CONFIG_FILE, "Playwright config", false);
  return source === undefined ? undefined : playwrightConfigFacts(source);
}

function readAttributeFact(testIdAttribute: string | undefined): string | undefined {
  if (testIdAttribute === undefined) return undefined;
  /* A plain attribute name that redaction would still change is secret-shaped: it is left out, never passed on redacted. */
  if (isSafeAttributeName(testIdAttribute) && sanitizeText(testIdAttribute).text === testIdAttribute) return testIdAttribute;
  engineLog.warn("[qa] WARNING: harness facts: the configured test-id attribute is not a plain attribute name — left out this run (non-blocking).");
  return undefined;
}

/* The configured test-id attribute and what the suite's fixtures file exports, or undefined when there is nothing to state. */
export function readHarnessFacts(input: { specDir: string; testIdAttribute?: string }): HarnessFacts | undefined {
  const testIdAttribute = readAttributeFact(input.testIdAttribute);
  const fixtures = readFixtureFacts(input.specDir);
  const playwright = readPlaywrightFacts(input.specDir);
  if (testIdAttribute === undefined && fixtures === undefined && playwright === undefined) return undefined;
  return { ...(testIdAttribute !== undefined ? { testIdAttribute } : {}), ...(fixtures ? { fixtures } : {}), ...(playwright ? { playwright } : {}) };
}

/* The elements and quoted labels of a diff, with the unchanged lines of the working copy that already hold each label. With a map, the labels of the changed files it links to pages come first (see `filesLinkedToPages`). A single repo only: across repos the diff is the service's, so its labels say nothing about the pages and the working copy belongs to the other repo. */
function changedLabelsOf(diff: string, ctx: PreGenerationGroundingStaticContext, contextMap: ArchitectureContext | undefined): MeasuredLabels {
  if (ctx.stagedRoots !== undefined) return { elements: diffParser.changedElements(diff, { quotedLabels: false }), literals: [] };
  const elements = diffParser.changedElements(diff);
  const linked = contextMap ? filesLinkedToPages(contextMap, diffParser.changedFiles(diff)) : undefined;
  const literals = diffParser.changedLiterals(diff, linked ? { preferFiles: linked } : {});
  if (!ctx.mirrorDir) return { elements, literals };
  try {
    return withUnchangedLines(ctx.mirrorDir, diffParser.changedLines(diff), literals, elements);
  } catch (err) {
    engineLog.warn(`[qa] WARNING: unchanged lines holding the changed labels not read (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    return { elements, literals };
  }
}

/* The pages a capture read with results under the app's declared data state, by the pathname they ended on. */
function confirmedDataRoutes(pages: readonly { route: string; finalUrl?: string; resultExpected?: boolean; resultCount?: number }[]): { path: string; resultCount: number }[] {
  const out: { path: string; resultCount: number }[] = [];
  for (const page of pages) {
    if (page.resultExpected !== true || page.resultCount === undefined || page.resultCount <= 0) continue;
    let path = page.route;
    try {
      if (page.finalUrl !== undefined) path = new URL(page.finalUrl).pathname;
    } catch { /* the route asked for stands */ }
    if (!out.some((r) => r.path === path)) out.push({ path, resultCount: page.resultCount });
  }
  return out;
}

export class PreGenerationGroundingPortAdapter implements PreGenerationGroundingPort {
  constructor(
    private readonly ctx: PreGenerationGroundingStaticContext,
    private readonly collaborators: PreGenerationGroundingCollaborators = {},
  ) {}

  /* The field names the working copy's OpenAPI documents declare in an operation's response, read once per run: what classifies a possible data contradiction. Absent without a working copy or a document; a document that cannot be read costs the class, never the pack. */
  private responseFieldsRead = false;
  private responseFieldsOf: ResponseFieldsOf | undefined;
  private responseFields(): ResponseFieldsOf | undefined {
    if (!this.responseFieldsRead) {
      this.responseFieldsRead = true;
      if (this.ctx.mirrorDir) {
        try {
          this.responseFieldsOf = loadResponseFields({ mirrorDir: this.ctx.mirrorDir, ...(this.ctx.openapi ? { openapi: this.ctx.openapi } : {}) });
        } catch (err) {
          engineLog.warn(`[qa] WARNING: the OpenAPI response schemas were not read (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return this.responseFieldsOf;
  }

  /* What the consumer's sources in the working copy expect of the answer to a request, read once per run (the links the run resolved tie a request to the function that issues it): what a possible data contradiction is a gap against. Absent without a working copy or a source of a declared language; sources that cannot be read cost the contradictions, never the pack. */
  private consumerExpectationsRead = false;
  private consumerExpectationsOf: ConsumerExpectationsOf | undefined;
  private consumerExpectations(change: GroundingChange | undefined): ConsumerExpectationsOf | undefined {
    if (!this.consumerExpectationsRead) {
      this.consumerExpectationsRead = true;
      if (this.ctx.mirrorDir) {
        try {
          this.consumerExpectationsOf = loadConsumerExpectations({ mirrorDir: this.ctx.mirrorDir, excludeDir: this.ctx.e2eDir, ...(change?.serviceLinks?.length ? { links: change.serviceLinks } : {}) });
        } catch (err) {
          engineLog.warn(`[qa] WARNING: the consumer's expectations were not read (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return this.consumerExpectationsOf;
  }

  /* The observer is told in passing: its fault never changes what grounding returns. */
  private tell(notify: () => void): void {
    try {
      notify();
    } catch (err) {
      engineLog.error(`[qa] the grounding trace failed (grounding is unaffected): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* What the pack's availability classification is given: the declared login page, whether the change is another repository's, and the change evidence, built only when a route was unavailable. */
  private availabilityInput(diff: string | undefined, change: GroundingChange | undefined): PackAvailabilityInput {
    const crossRepo = this.ctx.stagedRoots !== undefined;
    return {
      ...(change?.loginPath !== undefined ? { loginPath: change.loginPath } : {}),
      ...(crossRepo ? { changeElsewhere: true } : {}),
      evidence: () =>
        routeChangeEvidence({
          ...(this.ctx.mirrorDir !== undefined ? { mirrorDir: this.ctx.mirrorDir } : {}),
          changedFiles: diff ? diffParser.changedFiles(diff) : [],
          ...(change?.baseRef !== undefined ? { baseRef: change.baseRef } : {}),
          ...(this.ctx.readAtRef !== undefined ? { readAtRef: this.ctx.readAtRef } : {}),
          ...(change?.changeClosure !== undefined ? { closure: change.changeClosure } : {}),
          ...(change?.candidates !== undefined ? { candidates: change.candidates } : {}),
          crossRepo,
        }),
    };
  }

  async ground(specDir: string, signal?: AbortSignal, diff?: string, change?: GroundingChange): Promise<GroundingResult> {
    if (signal?.aborted) return {};

    const result: GroundingResult = {};

    let contextMap = this.ctx.contextMap;
    try {
      const loadContextMap = this.collaborators.loadContextMap ?? loadContextMapFromDisk;
      const loaded = loadContextMap(specDir);
      if (loaded) contextMap = loaded;
    } catch (err) {
      engineLog.warn(`[qa] WARNING: contextMap read-back failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
    /* A page changed through its template or style sheet reaches its route by the files its implementation files declare. A single repo only: across repos the changed files are the service's, and the map's files belong to the other repo. */
    if (contextMap && this.ctx.mirrorDir && this.ctx.stagedRoots === undefined) {
      try {
        contextMap = withDeclaredResources(contextMap, this.ctx.mirrorDir);
      } catch (err) {
        engineLog.warn(`[qa] WARNING: declared resources of the context map not read (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (contextMap) result.contextMap = contextMap;
    if (contextMap) this.tell(() => this.collaborators.trace?.contextMap?.(contextMap, this.ctx.contextMapProvenance?.()));
    else {
      const leftOut = this.ctx.contextMapProvenance?.();
      if (leftOut?.stale === true && leftOut.capturedSha !== undefined) this.tell(() => this.collaborators.trace?.contextMapLeftOut?.(leftOut));
    }

    try {
      const found = enumerateExistingSpecFiles(this.ctx.e2eDir);
      if (found.length > 0) {
        /* Fold flow/objective from the manifest into each existingSpecFiles string (formatSuiteEntry: `path — flow: X, objective: Y`). Filename-only would hide duplicate flows; the field stays string[] so metadata cannot be a separate typed field. Never fabricated: the manifest is read as it is on disk, so an entry that lacks a flow or an objective (an older or hand-edited one) is folded without it and never says `undefined`. */
        let byFile = new Map<string, { flow?: string; objective?: string }>();
        try {
          const entries = await readManifest(this.ctx.e2eDir);
          byFile = new Map(
            entries
              .filter((e): e is typeof e & { file: string } => Boolean(e.file))
              .map((e) => [e.file, { flow: e.flow, objective: e.objective }]),
          );
        } catch (err) {
          engineLog.warn(`[qa] WARNING: manifest read failed (non-blocking, existingSpecFiles stays plain): ${err instanceof Error ? err.message : String(err)}`);
        }
        /* mutation-scope:begin existing-spec-listing */
        result.existingSpecFiles = found.map((file) => formatSuiteEntry({ file, ...byFile.get(file) }));
        /* mutation-scope:end existing-spec-listing */
      }
    } catch (err) {
      engineLog.warn(`[qa] WARNING: existing-spec enumeration failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    const harnessFacts = readHarnessFacts({ specDir, ...(this.ctx.testIdAttribute ? { testIdAttribute: this.ctx.testIdAttribute } : {}) });
    if (harnessFacts) result.harnessFacts = harnessFacts;

    /* A single repo only: across repos the diff is the service's, and the working copy belongs to the other repo. */
    if (diff && this.ctx.mirrorDir && this.ctx.stagedRoots === undefined) {
      try {
        result.changedDecisions = changedDecisionsOf(this.ctx.mirrorDir, diffParser.changedLines(diff));
      } catch (err) {
        engineLog.warn(`[qa] WARNING: the changed decisions were not listed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /* Context mode discards the pack: building it would only spend the live-DOM capture on a value the prompt never reads. */
    if (this.ctx.contextPack === false) return result;

    /* buildContextPack does not accept AbortSignal. Racing unblocks the run on cancel; the in-flight render keeps running to its own timeout and its result is discarded. This port never throws — abort resolves; the use-case routes abort after this call. */
    try {
      const build = this.collaborators.buildContextPack ?? buildContextPack;
      const deps = this.collaborators.contextPackDeps ?? defaultContextPackDeps;
      const domPack = this.ctx.domPack !== false;
      const deterministicRoutes = domPack && contextMap?.routes?.length
        ? contextMap.routes.map((r) => r.path).filter(Boolean)
        : undefined;
      /* A cross-repo run's diff is of the service's tree, not of this working copy: its lines are not looked up here. The changed-element scopes feed only the pack's DOM capture, so they are skipped when the pack carries no DOM. */
      const labels = diff ? changedLabelsOf(diff, this.ctx, contextMap) : undefined;
      const parsed = domPack && diff ? labels?.elements : undefined;
      const changedElements = parsed && this.ctx.mirrorDir && this.ctx.stagedRoots === undefined
        ? withChangedElementScopes(parsed, this.ctx.mirrorDir, this.ctx.testIdAttribute)
        : parsed;
      const prChangedFiles = this.ctx.prChangedFiles ?? (diff ? diffParser.changedFiles(diff) : undefined);
      const candidates = change?.candidates;
      const hubPages = change?.hubPages;
      const buildPromise = build(
        {
          baseUrl: this.ctx.baseUrl,
          e2eDir: this.ctx.e2eDir,
          contextMap,
          prChangedFiles,
          testIdAttribute: this.ctx.testIdAttribute,
          domPack,
          ...(deterministicRoutes?.length ? { routes: deterministicRoutes } : {}),
          ...(this.ctx.stagedRoots ? { stagedRoots: this.ctx.stagedRoots } : {}),
          ...(candidates?.length ? { candidates } : {}),
          ...(hubPages?.length ? { hubPages: [...hubPages] } : {}),
          ...(changedElements?.length ? { changedElements } : {}),
          ...(labels?.literals.length ? { changedLiterals: labels.literals } : {}),
          ...(domPack ? { availability: this.availabilityInput(diff, change) } : {}),
          ...(domPack && this.responseFields() !== undefined ? { responseFields: this.responseFields()! } : {}),
          ...(domPack && this.consumerExpectations(change) !== undefined ? { consumerExpectations: this.consumerExpectations(change)! } : {}),
        },
        deps,
      );
      const packResult = signal ? await raceWithAbort(buildPromise, signal) : await buildPromise;
      if (packResult.text) {
        result.contextPack = packResult.text;
        const delivery = packDeliveredItemIds(packResult);
        result.contextPackItemIds = delivery.ids;
        result.contextPackOmissions = delivery.omissions;
      }
      if (packResult.changedValuesWithMoreNodes?.length) result.changedValuesWithMoreNodes = packResult.changedValuesWithMoreNodes;
      if (packResult.routeAvailability !== undefined) result.routeAvailability = packResult.routeAvailability;
      if (packResult.dataContradictions !== undefined) result.dataContradictions = packResult.dataContradictions;
      const confirmed = confirmedDataRoutes(packResult.trace?.pages ?? []);
      if (confirmed.length > 0) result.packConfirmedDataRoutes = confirmed;
      this.tell(() => this.collaborators.trace?.pack?.(packResult));    } catch (err) {
      if (isAbortError(err)) return result; /* abort: return whatever was gathered so far, never throw — see the note above. */
      engineLog.warn(`[qa] WARNING: context-pack build FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }
}
