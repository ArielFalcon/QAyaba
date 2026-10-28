/* src/contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts CoverageCollectorPort over V8/Chromium browser coverage dumps (.json files in .qa/coverage/<ns>/). The missing DI seam: the read of the dumps is injected (no hard-coded readdirSync/readFileSync), so this is unit-testable without disk and fail-open by contract (no dumps → empty report, never a throw). The injected read hands back what each dump covers (the lines of the changed files), not the dump: a dump holds every script a page loaded with its source map, megabytes of it, and the dumps of a suite are many, so each is reduced as it is read and none is kept.
   A dump is written by code the agent wrote, so what decoding it costs is bounded by its size and never by how its numbers are chosen: ranges that each cover the whole script, a script of nothing but line breaks or a source map of a million segments cost the script's length or the dump's size, once, and a dump past a bound is not decoded at all. How fast the segments of a source map decode still varies with their shape (a fifth of the usual speed on a map made to be slow), so the decoding is also asked, as it goes, whether the time it was given is spent (`TimeSpent`), and stops when it is. */
import type { CoverageCollectorPort } from "../application/ports/coverage-collector.port.ts";
import type { CoverageReport, CoverageScripts, DumpSource, MutantEdit } from "../domain/coverage-collector.ts";
import { isDumpOfSpecFile } from "../domain/dump-names.ts";
import { BranchSink } from "./v8-branch-coverage.ts";
import {
  MAX_V8_COVERED_LINES_PER_FILE,
  MAX_V8_SCRIPT_LINES,
  decodeMappings,
  lineStartOffsets,
  type MappingSegment,
  type RawSourceMap,
  type TimeSpent,
  type V8Entry,
  type V8Range,
} from "./v8-source-map.ts";
export { MAX_V8_COVERED_LINES_PER_FILE, MAX_V8_SCRIPT_LINES, decodeMappings, lineStartOffsets };
export type { MappingSegment, RawSourceMap, TimeSpent, V8Entry, V8Range };

/* What one dump covers: the lines (1-based) of each changed file that a script of the dump ran. */
export type CoveredLines = Map<string, Set<number>>;

/* Reads the dumps of a namespace (those `keep` accepts by name, when given) and reduces each to the lines of `changedFiles` it covers, one dump at a time; `branches`, when given, is added the decisions of the changed files each dump ran, `executable` the lines of the changed files the dumps' scripts hold code for, and `ranBy` the names of the dumps that ran a line of each changed file. */
export type ReadV8Coverage = (specDir: string, namespace: string, changedFiles: string[], scripts?: CoverageScripts, branches?: BranchSink, keep?: (name: string) => boolean, executable?: CoveredLines, mutant?: MutantEdit, ranBy?: Map<string, Set<string>>) => Promise<CoveredLines[]>;

export class V8BrowserCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readCoverage: ReadV8Coverage,
    private readonly changedFiles: string[],
  ) {}

  async collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport> {
    return this.recollect(specDir, [{ namespace }], changedFiles);
  }

  /* The dumps of each source, read into one sink as one collection: an arm taken in any of them is taken. A source that yields no dump, other than a mutant's, leaves a report of several sources a part of what was asked for (`incomplete`). */
  async recollect(specDir: string, sources: readonly DumpSource[], changedFiles?: string[]): Promise<CoverageReport> {
    const scripts: CoverageScripts = { total: 0, withSourceMap: 0 };
    const branches = new BranchSink();
    const executable: CoveredLines = new Map();
    const ranBy = new Map<string, Set<string>>();
    const dumps: CoveredLines[] = [];
    let incomplete = false;
    for (const { namespace, exceptSpecFiles = [], onlySpecFiles, mutant } of sources) {
      const keep =
        exceptSpecFiles.length === 0 && onlySpecFiles === undefined
          ? undefined
          : (name: string) => !exceptSpecFiles.some((file) => isDumpOfSpecFile(name, file)) && (onlySpecFiles === undefined || onlySpecFiles.some((file) => isDumpOfSpecFile(name, file)));
      const read = await this.readCoverage(specDir, namespace, changedFiles ?? this.changedFiles, scripts, branches, keep, executable, mutant, ranBy);
      /* A mutant's re-run proves what its dumps ran; one that wrote none proves nothing, and takes nothing from the rest. */
      if (read.length === 0 && !mutant) incomplete = true;
      dumps.push(...read);
    }
    const merged = new Map<string, Set<number>>();
    for (const covered of dumps) {
      for (const [file, lines] of covered) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    /* Branches only beside a measurement: with no dump used there is nothing they could be a part of. */
    const decisions = dumps.length > 0 ? branches.result() : undefined;
    const sites = dumps.length > 0 ? branches.mutationSites() : undefined;
    const code = dumps.length > 0 ? [...executable].map(([file, lines]) => ({ file, lines: [...lines] })) : undefined;
    const ran = dumps.length > 0 ? [...ranBy].map(([file, names]) => ({ file, dumps: [...names].sort() })) : undefined;
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })), ...(code ? { executable: code } : {}), ...(ran ? { ranBy: ran } : {}), scripts, ...(decisions ? { branches: decisions } : {}), ...(sites ? { mutationSites: sites } : {}), ...(incomplete && sources.length > 1 ? { incomplete: true as const } : {}) };
  }
}

/* A source of a map as a path to match against the changed files: the map's source root put before it, with one separator between. What is before the repository's own path (a scheme, `../`, `./`, a separator) needs no taking off, since a path is matched to a changed file by its end. */
export function sourcePathOf(source: string, sourceRoot?: string): string {
  return sourceRoot ? sourceRoot.replace(/\/$/, "") + "/" + source.replace(/^\//, "") : source;
}

export function resolveUrlToRepoFile(url: string, changedFiles: string[]): string | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  path = path.replace(/\\/g, "/").replace(/^\/+/, "");
  let best: string | null = null;
  let bestLen = 0;
  for (const f of changedFiles) {
    const nf = f.replace(/\\/g, "/");
    if (path === nf || path.endsWith("/" + nf) || nf.endsWith("/" + path)) {
      const len = Math.min(path.length, nf.length);
      if (len > bestLen) { best = f; bestLen = len; }
    }
  }
  return best;
}

/* The bytes of a script that ran. The ranges are in the order V8 reported them and a later one decides a byte over the ones before it wherever they overlap. Taken from the last back, the first range to reach a byte is the one that decides it, and `next` skips the bytes already decided, so every byte is decided once and the work is the script's length plus the number of ranges, however the ranges overlap. A range with an offset that is not a whole number reaches no byte. */
function bytesThatRan(length: number, functions: V8Entry["functions"]): Uint8Array {
  const ran = new Uint8Array(length);
  const ranges: V8Range[] = [];
  for (const fn of functions ?? []) for (const range of fn.ranges ?? []) ranges.push(range);

  /* next[i] is the first byte at or after i that no range has decided yet; the byte after the last is the sentinel. */
  const next = new Int32Array(length + 1);
  for (let i = 0; i <= length; i++) next[i] = i;
  const firstUndecided = (from: number): number => {
    let at = from;
    while (next[at] !== at) {
      next[at] = next[next[at]!]!;
      at = next[at]!;
    }
    return at;
  };
  for (let k = ranges.length - 1; k >= 0; k--) {
    const range = ranges[k]!;
    if (!Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)) continue;
    const end = Math.min(length, range.endOffset);
    const value = range.count > 0 ? 1 : 0;
    for (let at = firstUndecided(Math.max(0, range.startOffset)); at < end; at = firstUndecided(at + 1)) {
      ran[at] = value;
      next[at] = at + 1;
    }
  }
  return ran;
}

/* The lines of a script that have a byte that ran. */
function linesThatRan(ran: Uint8Array, starts: Int32Array): number[] {
  const lines: number[] = [];
  let line = 0;
  for (let at = ran.indexOf(1); at !== -1; at = line + 1 < starts.length ? ran.indexOf(1, starts[line + 1]!) : -1) {
    /* The start of a line that is not there compares as false, so the last line is the last that is. */
    while (starts[line + 1]! <= at) line += 1;
    lines.push(line + 1);
  }
  return lines;
}

/* How many segments of a source map are decoded between two looks at the time: a millisecond or so of decoding, however the map is made. */
const SEGMENTS_BETWEEN_LOOKS_AT_THE_TIME = 4096;

/* Hands each line of a changed file that the covered bytes of a script come from, by its source map, to `cover`, and each line of a changed file any segment of the script maps code to, ran or not, to `code`. `files[i]` is the changed file the map's source `i` is, or null. Throws when the time is spent. */
function coverOriginalLines(map: RawSourceMap, files: ReadonlyArray<string | null>, starts: Int32Array, ran: Uint8Array, cover: (file: string, line: number) => void, code?: (file: string, line: number) => void, spent?: TimeSpent): void {
  let segments = 0;
  for (const seg of decodeMappings(map.mappings)) {
    if (++segments % SEGMENTS_BETWEEN_LOOKS_AT_THE_TIME === 0 && spent?.()) throw new RangeError();
    const lineStart = starts[seg.genLine];
    if (lineStart === undefined) continue;
    const repoFile = files[seg.sourceIndex];
    if (!repoFile) continue;
    code?.(repoFile, seg.origLine + 1);
    if (ran[lineStart + seg.genCol] !== 1) continue;
    cover(repoFile, seg.origLine + 1);
  }
}

/* The lines of a script that hold anything but white space: the code of a script served as it is written. */
function nonBlankLines(source: string, starts: Int32Array): number[] {
  const lines: number[] = [];
  for (let line = 0; line < starts.length; line++) {
    const end = line + 1 < starts.length ? starts[line + 1]! : source.length;
    if (source.slice(starts[line]!, end).trim() !== "") lines.push(line + 1);
  }
  return lines;
}

/* What the entries of one dump cover of the changed files; `scripts`, when given, is added the scripts the dump held and the ones that carried a source map, `branches` the decisions of the changed files they hold with what of them ran, and `executable` the lines of the changed files they hold code for. A script is reduced only when it is a changed file or maps to one. Throws on a dump that cannot be decoded within the bounds above, or before the time `spent` speaks of is. */
export function defaultParseV8Coverage(entries: V8Entry[], changedFiles: string[], spent?: TimeSpent, scripts?: CoverageScripts, branches?: BranchSink, executable?: Map<string, Set<number>>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  /* The one place a line is kept: the lines of a file are bounded however many scripts and segments claim them. */
  const keepIn = (lines: Map<string, Set<number>>) => (file: string, line: number): void => {
    let set = lines.get(file);
    if (!set) {
      set = new Set<number>();
      lines.set(file, set);
    }
    set.add(line);
    if (set.size > MAX_V8_COVERED_LINES_PER_FILE) throw new RangeError();
  };
  const cover = keepIn(out);
  const code = executable ? keepIn(executable) : undefined;
  for (const entry of entries) {
    if (typeof entry?.source !== "string" || typeof entry.url !== "string") continue;
    const source = entry.source;
    const map = entry.map;
    const hasSourceMap = typeof map === "object" && map !== null && typeof map.mappings === "string" && Array.isArray(map.sources);
    if (scripts) {
      scripts.total += 1;
      if (hasSourceMap) scripts.withSourceMap += 1;
    }
    const directFile = resolveUrlToRepoFile(entry.url, changedFiles);
    const mapped = !directFile && hasSourceMap && !!map;
    const files = mapped ? map.sources.map((s) => resolveUrlToRepoFile(sourcePathOf(s, map.sourceRoot), changedFiles)) : [];
    if (!directFile && !files.some((f) => f !== null)) continue;
    if (spent?.()) throw new RangeError();

    const ran = bytesThatRan(source.length, entry.functions);
    const starts = lineStartOffsets(source);
    if (directFile) {
      for (const line of linesThatRan(ran, starts)) cover(directFile, line);
      if (code) for (const line of nonBlankLines(source, starts)) code(directFile, line);
    } else coverOriginalLines(map!, files, starts, ran, cover, code, spent);
    branches?.add(entry, directFile, files, spent);
  }
  return out;
}
