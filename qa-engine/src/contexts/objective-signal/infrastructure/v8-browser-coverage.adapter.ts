/* src/contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts CoverageCollectorPort over V8/Chromium browser coverage dumps (.json files in .qa/coverage/<ns>/). The missing DI seam: the read of the dumps is injected (no hard-coded readdirSync/readFileSync), so this is unit-testable without disk and fail-open by contract (no dumps → empty report, never a throw). The injected read hands back what each dump covers (the lines of the changed files), not the dump: a dump holds every script a page loaded with its source map, megabytes of it, and the dumps of a suite are many, so each is reduced as it is read and none is kept.
   A dump is written by code the agent wrote, so what decoding it costs is bounded by its size and never by how its numbers are chosen: ranges that each cover the whole script, a script of nothing but line breaks or a source map of a million segments cost the script's length or the dump's size, once, and a dump past a bound is not decoded at all. How fast the segments of a source map decode still varies with their shape (a fifth of the usual speed on a map made to be slow), so the decoding is also asked, as it goes, whether the time it was given is spent (`TimeSpent`), and stops when it is. */
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

interface RawSourceMap {
  version?: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  sourceRoot?: string;
}

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface V8Entry {
  url?: string;
  source?: string;
  functions?: Array<{ ranges?: V8Range[] }>;
  map?: RawSourceMap;
}

/* What one dump covers: the lines (1-based) of each changed file that a script of the dump ran. */
export type CoveredLines = Map<string, Set<number>>;

/* Reads the dumps of a namespace and reduces each to the lines of `changedFiles` it covers, one dump at a time. */
export type ReadV8Coverage = (specDir: string, namespace: string, changedFiles: string[]) => Promise<CoveredLines[]>;

export class V8BrowserCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readCoverage: ReadV8Coverage,
    private readonly changedFiles: string[],
  ) {}

  async collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport> {
    const dumps = await this.readCoverage(specDir, namespace, changedFiles ?? this.changedFiles);
    const merged = new Map<string, Set<number>>();
    for (const covered of dumps) {
      for (const [file, lines] of covered) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

/* A script an app serves has some lines per kilobyte at the most, and a file of its sources some hundreds of thousands of lines: past these a dump is not decoded, which leaves the set of dumps unused. */
export const MAX_V8_SCRIPT_LINES = 1_000_000;
export const MAX_V8_COVERED_LINES_PER_FILE = 1_000_000;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* The numbers of one segment of a source map: base-64 digits of five bits each, the sixth bit saying that another digit follows and the lowest bit of the whole saying that the number is negative. A character that is no digit is skipped. */
function decodeVlq(segment: string): number[] {
  const result: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    if (digit === -1) continue;
    const hasContinuation = digit & 32;
    value += (digit & 31) << shift;
    if (hasContinuation) {
      shift += 5;
    } else {
      const negate = value & 1;
      value >>= 1;
      result.push(negate ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return result;
}

/* Where a segment of a source map starts in the generated script, and the line of the source it comes from. */
interface MappingSegment {
  genLine: number;
  genCol: number;
  sourceIndex: number;
  origLine: number;
}

const SEMICOLON = 59;
const COMMA = 44;

/* The segments of a source map's `mappings`, one at a time and in one pass over the string: none is kept, and no list of lines or of segments is made, however many there are. A segment of four fields or five (the fifth is the index of a name) maps; one of fewer only moves the column. The column of the source is not kept: nothing here asks for it. */
function* decodeMappings(mappings: string): Generator<MappingSegment> {
  let sourceIndex = 0;
  let origLine = 0;
  let genLine = 0;
  let genCol = 0;
  let segmentStart = 0;
  for (let at = 0; at <= mappings.length; at++) {
    const code = at < mappings.length ? mappings.charCodeAt(at) : SEMICOLON;
    if (code !== COMMA && code !== SEMICOLON) continue;
    const fields = decodeVlq(mappings.slice(segmentStart, at));
    if (fields.length > 0) {
      genCol += fields[0]!;
      if (fields.length >= 4) {
        sourceIndex += fields[1]!;
        origLine += fields[2]!;
        yield { genLine, genCol, sourceIndex, origLine };
      }
    }
    segmentStart = at + 1;
    if (code === SEMICOLON) {
      genLine += 1;
      genCol = 0;
    }
  }
}

/* A source of a map as a path to match against the changed files: the map's source root put before it, with one separator between. What is before the repository's own path (a scheme, `../`, `./`, a separator) needs no taking off, since a path is matched to a changed file by its end. */
function sourcePathOf(source: string, sourceRoot?: string): string {
  return sourceRoot ? sourceRoot.replace(/\/$/, "") + "/" + source.replace(/^\//, "") : source;
}

function resolveUrlToRepoFile(url: string, changedFiles: string[]): string | null {
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

/* Where each line of a script starts. The count is bounded before the list is made: a script of nothing but line breaks would otherwise make a list of its own length. */
function lineStartOffsets(source: string): Int32Array {
  let count = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) {
    count += 1;
    if (count > MAX_V8_SCRIPT_LINES) throw new RangeError();
  }
  const starts = new Int32Array(count);
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) starts[line++] = at + 1;
  return starts;
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

/* Whether the time the decoding was given is spent. It is asked as the decoding goes, so that a dump made to be slow to decode costs that time at the most and not what its numbers say. */
export type TimeSpent = () => boolean;

/* How many segments of a source map are decoded between two looks at the time: a millisecond or so of decoding, however the map is made. */
const SEGMENTS_BETWEEN_LOOKS_AT_THE_TIME = 4096;

/* Hands each line of a changed file that the covered bytes of a script come from, by its source map, to `cover`. `files[i]` is the changed file the map's source `i` is, or null. Throws when the time is spent. */
function coverOriginalLines(map: RawSourceMap, files: ReadonlyArray<string | null>, starts: Int32Array, ran: Uint8Array, cover: (file: string, line: number) => void, spent?: TimeSpent): void {
  let segments = 0;
  for (const seg of decodeMappings(map.mappings)) {
    if (++segments % SEGMENTS_BETWEEN_LOOKS_AT_THE_TIME === 0 && spent?.()) throw new RangeError();
    const lineStart = starts[seg.genLine];
    if (lineStart === undefined) continue;
    if (ran[lineStart + seg.genCol] !== 1) continue;
    const repoFile = files[seg.sourceIndex];
    if (!repoFile) continue;
    cover(repoFile, seg.origLine + 1);
  }
}

/* What the entries of one dump cover of the changed files. A script is reduced only when it is a changed file or maps to one. Throws on a dump that cannot be decoded within the bounds above, or before the time `spent` speaks of is. */
export function defaultParseV8Coverage(entries: V8Entry[], changedFiles: string[], spent?: TimeSpent): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  /* The one place a covered line is kept: the lines of a file are bounded however many scripts and segments claim them. */
  const cover = (file: string, line: number): void => {
    let set = out.get(file);
    if (!set) {
      set = new Set<number>();
      out.set(file, set);
    }
    set.add(line);
    if (set.size > MAX_V8_COVERED_LINES_PER_FILE) throw new RangeError();
  };
  for (const entry of entries) {
    if (typeof entry?.source !== "string" || typeof entry.url !== "string") continue;
    const source = entry.source;
    const directFile = resolveUrlToRepoFile(entry.url, changedFiles);
    const map = entry.map;
    const mapped = !directFile && typeof map?.mappings === "string" && Array.isArray(map.sources);
    const files = mapped ? map.sources.map((s) => resolveUrlToRepoFile(sourcePathOf(s, map.sourceRoot), changedFiles)) : [];
    if (!directFile && !files.some((f) => f !== null)) continue;
    if (spent?.()) throw new RangeError();

    const ran = bytesThatRan(source.length, entry.functions);
    const starts = lineStartOffsets(source);
    if (directFile) for (const line of linesThatRan(ran, starts)) cover(directFile, line);
    else coverOriginalLines(map!, files, starts, ran, cover, spent);
  }
  return out;
}
