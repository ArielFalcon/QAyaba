/* src/contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts CoverageCollectorPort over V8/Chromium browser coverage dumps (.json files in .qa/coverage/<ns>/). The missing DI seam: the dump read is injected (no hard-coded readdirSync/readFileSync), so this is unit-testable without disk and fail-open by contract (no files → empty report, never a throw). */
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";


interface RawSourceMap {
  version?: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  sourceRoot?: string;
}

interface V8Entry {
  url?: string;
  source?: string;
  functions?: Array<{ ranges?: Array<{ startOffset: number; endOffset: number; count: number }> }>;
  map?: RawSourceMap;
}

export interface V8DumpFile { path: string; entries: V8Entry[]; }
type ReadV8Dumps = (specDir: string, namespace: string) => Promise<V8DumpFile[]>;
type ParseV8 = (entries: V8Entry[], changedFiles: string[]) => Map<string, Set<number>>;

export class V8BrowserCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readDumps: ReadV8Dumps,
    private readonly changedFiles: string[],
    private readonly parse: ParseV8 = defaultParseV8Coverage,
  ) {}

  async collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport> {
    const dumps = await this.readDumps(specDir, namespace);
    const files = changedFiles ?? this.changedFiles;
    const merged = new Map<string, Set<number>>();
    for (const d of dumps) {
      for (const [file, lines] of this.parse(d.entries, files)) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}


const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64[i]!] = i;

function decodeVlq(segment: string): number[] {
  const result: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64_LOOKUP[ch];
    if (digit === undefined) continue;
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

interface MappingSegment {
  genLine: number;
  genCol: number;
  sourceIndex: number;
  origLine: number;
  origCol: number;
}

function decodeMappings(mappings: string): MappingSegment[] {
  const segments: MappingSegment[] = [];
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  const lines = mappings.split(";");
  for (let genLine = 0; genLine < lines.length; genLine++) {
    let genCol = 0;
    const lineStr = lines[genLine]!;
    if (!lineStr) continue;
    for (const segStr of lineStr.split(",")) {
      if (!segStr) continue;
      const f = decodeVlq(segStr);
      if (f.length === 0) continue;
      genCol += f[0]!;
      if (f.length >= 4) {
        sourceIndex += f[1]!;
        origLine += f[2]!;
        origCol += f[3]!;
        segments.push({ genLine, genCol, sourceIndex, origLine, origCol });
      }
    }
  }
  return segments;
}

function normalizeSourcePath(source: string, sourceRoot?: string): string {
  let s = source;
  if (sourceRoot) s = sourceRoot.replace(/\/$/, "") + "/" + s.replace(/^\//, "");
  s = s.replace(/^[a-z-]+:\/\/+/i, "");
  s = s.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "").replace(/^\/+/, "");
  return s;
}

function coveredOriginalLines(
  map: RawSourceMap,
  genLineStartOffsets: number[],
  isByteCovered: (byteOffset: number) => boolean,
  resolve: (normalizedSource: string) => string | null,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const resolvedCache = new Map<number, string | null>();
  for (const seg of decodeMappings(map.mappings)) {
    const lineStart = genLineStartOffsets[seg.genLine];
    if (lineStart === undefined) continue;
    if (!isByteCovered(lineStart + seg.genCol)) continue;
    let repoFile = resolvedCache.get(seg.sourceIndex);
    if (repoFile === undefined) {
      const src = map.sources[seg.sourceIndex];
      repoFile = src ? resolve(normalizeSourcePath(src, map.sourceRoot)) : null;
      resolvedCache.set(seg.sourceIndex, repoFile);
    }
    if (!repoFile) continue;
    let set = out.get(repoFile);
    if (!set) { set = new Set<number>(); out.set(repoFile, set); }
    set.add(seg.origLine + 1);
  }
  return out;
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

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

export function defaultParseV8Coverage(entries: V8Entry[], changedFiles: string[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const addLines = (file: string, lines: Iterable<number>): void => {
    const set = out.get(file) ?? new Set<number>();
    for (const l of lines) set.add(l);
    if (set.size) out.set(file, set);
  };
  for (const entry of entries) {
    if (!entry?.source || !entry.url) continue;
    const source = entry.source;

    const covered = new Uint8Array(source.length);
    for (const fn of entry.functions ?? []) {
      for (const r of fn.ranges ?? []) {
        const start = Math.max(0, r.startOffset);
        const end = Math.min(source.length, r.endOffset);
        const val = r.count > 0 ? 1 : 0;
        for (let i = start; i < end; i++) covered[i] = val;
      }
    }
    const lineStarts = lineStartOffsets(source);

    const directFile = resolveUrlToRepoFile(entry.url, changedFiles);
    if (directFile) {
      const lines: number[] = [];
      for (let ln = 0; ln < lineStarts.length; ln++) {
        const from = lineStarts[ln]!;
        const to = ln + 1 < lineStarts.length ? lineStarts[ln + 1]! : source.length;
        for (let i = from; i < to; i++) {
          if (covered[i]) { lines.push(ln + 1); break; }
        }
      }
      addLines(directFile, lines);
    } else if (entry.map?.mappings && Array.isArray(entry.map.sources)) {
      const mapped = coveredOriginalLines(
        entry.map,
        lineStarts,
        (b) => covered[b] === 1,
        (s) => resolveUrlToRepoFile(s, changedFiles),
      );
      for (const [file, lines] of mapped) addLines(file, lines);
    }
  }
  return out;
}
