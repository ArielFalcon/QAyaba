/* The decoding of the coverage dumps, as plain data in and plain data out, so that it can run in a worker thread (`coverage-decode.worker.ts`): the CPU work on bytes the agent shaped happens there, and the orchestrator's thread only merges what comes back. A worker resolves no path alias, so this module and everything it imports are relative imports and packages; it touches no file and logs nothing.
   A dump decodes to what it adds to the collection the caller is building: the lines of the changed files it covers (kept only when the dump is used), the lines of them it holds code for, the scripts it counts, and what its scripts say of the changed files' decisions and mutation sites. A dump that cannot be decoded within its bounds is `refused` and carries what it had added to the collection before it was found out, as the in-thread decoding did, so the collection ends as it always did. */
import { createHash } from "node:crypto";
import type { CoverageScripts, MutantEdit } from "../domain/coverage-collector.ts";
import { undoMutant } from "./undo-mutant.ts";
import { defaultParseV8Coverage } from "./v8-browser-coverage.adapter.ts";
import { BranchRecorder, type BranchEvent, type BranchSink } from "./v8-branch-coverage.ts";
import { MAX_V8_COVERED_LINES_PER_FILE, type V8Entry } from "./v8-source-map.ts";

/* What the worker is told besides the dumps: it is the same for every dump of a call. */
export interface DecodeContext {
  changedFiles: string[];
  /* The dumps of a mutant's re-run are read with its edit undone. */
  mutant?: MutantEdit;
  /* Whether the collection wants the lines the scripts hold code for. */
  executable: boolean;
  /* Whether the collection still has branches to add to. */
  branches: boolean;
  /* How many of the inputs, first, are a worker's files of the scripts it kept once (`<sha256>.script.json`): the dumps after them may name a script by its fingerprint instead of carrying it. Absent: none. */
  scriptFiles?: number;
}

export type Lines = Array<[string, number[]]>;

export interface DecodedDump {
  refused: boolean;
  covered: Lines;
  executable: Lines;
  scripts: CoverageScripts;
  branches: BranchEvent[];
}

const linesOf = (lines: Map<string, Set<number>>): Lines => [...lines].map(([file, set]) => [file, [...set]]);

/* A script a worker kept once, by the fingerprint of its source. */
type KeptScripts = Map<string, Pick<V8Entry, "source" | "map">>;

const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/* One call's decoder: it keeps what is shared by the dumps of the call (the scripts the workers kept once, the scripts the branch reader has already analyzed) and nothing else. */
export function openDecoder(context: DecodeContext): (bytes: Buffer) => Buffer {
  const recorder = context.branches ? new BranchRecorder() : undefined;
  const kept: KeptScripts = new Map();
  let index = 0;
  return (bytes) => Buffer.from(JSON.stringify(index++ < (context.scriptFiles ?? 0) ? keepScripts(bytes, kept) : decodeDump(bytes, context, recorder, kept)));
}

/* A worker's file of the scripts it kept: each is kept only when its source is the one its fingerprint names. A file that is not that is refused, which leaves the set unused. */
function keepScripts(bytes: Buffer, kept: KeptScripts): DecodedDump {
  let refused = false;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed)) refused = true;
    else
      for (const entry of parsed as V8Entry[]) {
        if (typeof entry.sha256 !== "string" || typeof entry.source !== "string" || sha256Of(entry.source) !== entry.sha256) refused = true;
        else kept.set(entry.sha256, { source: entry.source, ...(entry.map !== undefined ? { map: entry.map } : {}) });
      }
  } catch {
    refused = true;
  }
  return { refused, covered: [], executable: [], scripts: { total: 0, withSourceMap: 0 }, branches: [] };
}

/* The dump's scripts as the older fixtures wrote them, inline: a script named by its fingerprint gets the source and map its worker kept; one named and not kept cannot be read. */
function inlined(entries: V8Entry[], kept: KeptScripts): V8Entry[] {
  return entries.map((entry) => {
    if (entry.source !== undefined || entry.sha256 === undefined) return entry;
    const script = kept.get(entry.sha256);
    if (!script) throw new RangeError("a dump names a script no worker kept");
    return { ...entry, ...script };
  });
}

export function decodeDump(bytes: Buffer, context: DecodeContext, recorder?: BranchRecorder, kept: KeptScripts = new Map()): DecodedDump {
  const scripts: CoverageScripts = { total: 0, withSourceMap: 0 };
  const executable = context.executable ? new Map<string, Set<number>>() : undefined;
  let covered: Map<string, Set<number>> | undefined;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    const entries = inlined(Array.isArray(parsed) ? (parsed as V8Entry[]) : [], kept);
    covered = defaultParseV8Coverage(context.mutant ? undoMutant(entries, context.mutant) : entries, context.changedFiles, scripts, recorder, executable);
  } catch {
    covered = undefined;
  }
  return { refused: covered === undefined, covered: covered ? linesOf(covered) : [], executable: executable ? linesOf(executable) : [], scripts, branches: recorder?.take() ?? [] };
}

/* What a call builds its collection in. */
export interface DecodeSinks {
  scripts?: CoverageScripts;
  branches?: BranchSink;
  executable?: Map<string, Set<number>>;
}

/* The answer of the worker for one dump, read back; anything that is not the plain data above is a dump that could not be used. */
function readDecoded(output: Buffer | null | undefined): DecodedDump | undefined {
  if (output === null || output === undefined) return undefined;
  try {
    const decoded = JSON.parse(output.toString("utf8")) as DecodedDump;
    return typeof decoded.refused === "boolean" && Array.isArray(decoded.covered) && Array.isArray(decoded.executable) && Array.isArray(decoded.branches) && typeof decoded.scripts?.total === "number" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/* Whether the worker read a file of kept scripts whole: a file it refused, or no answer, leaves the set unused. */
export function keptScriptsRead(output: Buffer | null | undefined): boolean {
  const decoded = readDecoded(output);
  return decoded !== undefined && !decoded.refused;
}

/* Adds what the worker found in a dump to the collection, in the order of the dumps, and gives the lines the dump covers of the changed files; undefined for a dump that is not used. */
export function mergeDecodedDump(name: string, output: Buffer | null | undefined, sinks: DecodeSinks): Map<string, Set<number>> | undefined {
  sinks.branches?.beginDump(name);
  const decoded = readDecoded(output);
  if (!decoded) return undefined;
  let refused = decoded.refused;
  if (sinks.scripts) {
    sinks.scripts.total += decoded.scripts.total;
    sinks.scripts.withSourceMap += decoded.scripts.withSourceMap;
  }
  if (sinks.executable) {
    for (const [file, lines] of decoded.executable) {
      let set = sinks.executable.get(file);
      if (!set) {
        set = new Set<number>();
        sinks.executable.set(file, set);
      }
      /* The bound on the lines of a file holds across the dumps of the collection, and a line past it is not kept. */
      for (const line of lines) {
        set.add(line);
        if (set.size > MAX_V8_COVERED_LINES_PER_FILE) {
          refused = true;
          break;
        }
      }
    }
  }
  sinks.branches?.replay(decoded.branches);
  return refused ? undefined : new Map(decoded.covered.map(([file, lines]) => [file, new Set(lines)]));
}
