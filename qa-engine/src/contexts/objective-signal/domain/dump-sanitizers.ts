/* What the orchestrator keeps of the files a suite leaves behind for the coverage and the response oracles (a V8 dump, a fault-injection counter): the bounds on how many and how large, and the sanitizers that rebuild each file field by field so nothing but the fields the readers use is kept. Pure. */

/* A V8 dump carries every script a page loaded, with its source map: about 3 MiB for a 0.6 MiB bundle and 19 MiB for a 3.4 MiB one (measured with esbuild bundles and V8's own precise coverage), and the fixture writes one per test. Each dump is reduced to the lines of the changed files as it is read and none is kept, so a suite of any size costs the memory of one dump.
   What is bounded is the cost of one dump and the time of all of them. A dump is parsed in the orchestrator's one thread, and one made of nothing but empty arrays costs some fifteen times its size in heap and a second of parse for every 12 MiB (64 MiB took 2 s and 917 MiB of heap), so the cap on a dump is what a freeze and an out-of-memory can cost: 32 MiB is a second and half a gigabyte, and holds a bundle of 5 MiB of script. Decoding runs at some 100 MiB a second on the largest shape measured (114 MiB in a second) and at a fifth of that on a source map made to be slow, so the bytes allowed say nothing sure of the time; the time is bounded by a clock, which the dumps of a run are given together (V8_DECODE_BUDGET_MS) and which the decoding asks as it goes. A dump past the cap, the dumps of one run together past the byte budget or the time, and a directory past the entry cap are far beyond any suite, and leave the whole set unused: unknown, which never blocks. */
export const MAX_V8_DUMP_BYTES = 32 * 1024 * 1024;
export const MAX_V8_DUMPS_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_V8_DUMP_FILES = 2_048;

/* A counter is a few bytes; one worker is one file, and a worker is started again after a failure, so a long suite leaves many. */
export const MAX_FAULT_INJECTION_COUNTER_BYTES = 64 * 1024;
export const MAX_FAULT_INJECTION_COUNTER_FILES = 2_048;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/* A dump as the orchestrator keeps it for the reader: only what the reduction to the lines of the changed files uses (a script's url and source, the ranges V8 says ran, and the source map's sources, root and mappings), rebuilt field by field. The dump is written by the suite's fixtures, which is agent-editable code in a process with the session in reach, and what reaches the mirror can be read by the agent; so nothing is copied that the reader does not use (a key it adds, a map's embedded sources, a name) and a dump of another shape is refused. The strings the reader does use remain strings the writer chose: a payload hidden in a script's source survives this, which is why a dump reaches the mirror only through this function and in bounded size. Throws RangeError on a dump that is not that shape. */
export function sanitizeV8Dump(bytes: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RangeError("not JSON");
  }
  if (!Array.isArray(parsed)) throw new RangeError("not a list of scripts");
  return Buffer.from(JSON.stringify(parsed.map(sanitizeV8Entry)));
}

function sanitizeV8Entry(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new RangeError("a script is not an object");
  const entry: Record<string, unknown> = {};
  if (raw.url !== undefined) {
    if (typeof raw.url !== "string") throw new RangeError("url is not a string");
    entry.url = raw.url;
  }
  if (raw.source !== undefined) {
    if (typeof raw.source !== "string") throw new RangeError("source is not a string");
    entry.source = raw.source;
  }
  if (raw.functions !== undefined) {
    if (!Array.isArray(raw.functions)) throw new RangeError("functions is not a list");
    entry.functions = raw.functions.map((fn: unknown) => {
      if (!isRecord(fn)) throw new RangeError("a function is not an object");
      if (fn.ranges === undefined) return {};
      if (!Array.isArray(fn.ranges)) throw new RangeError("ranges is not a list");
      return {
        ranges: fn.ranges.map((range: unknown) => {
          if (!isRecord(range) || !isCount(range.startOffset) || !isCount(range.endOffset) || !isCount(range.count)) throw new RangeError("a range is not three counts");
          return { startOffset: range.startOffset, endOffset: range.endOffset, count: range.count };
        }),
      };
    });
  }
  if (raw.map !== undefined) {
    const map = raw.map;
    if (!isRecord(map) || !Array.isArray(map.sources) || !map.sources.every((source: unknown) => typeof source === "string") || typeof map.mappings !== "string") throw new RangeError("the source map is not sources and mappings");
    if (map.sourceRoot !== undefined && typeof map.sourceRoot !== "string") throw new RangeError("sourceRoot is not a string");
    if (map.version !== undefined && !isCount(map.version)) throw new RangeError("version is not a count");
    entry.map = {
      ...(map.version !== undefined ? { version: map.version } : {}),
      sources: map.sources,
      ...(map.sourceRoot !== undefined ? { sourceRoot: map.sourceRoot } : {}),
      mappings: map.mappings,
    };
  }
  return entry;
}

/* The largest count a counter may hold: far beyond any suite's responses, and a bound on what the field can carry. */
export const MAX_FAULT_INJECTION_COUNT = 1_000_000_000;

/* The most operations one counter may name, the longest key it may name one by (`<VERB> <pattern>`: a verb and a pattern of at most 200 characters) and the longest test title it may carry. */
export const MAX_FAULT_COUNTER_OPERATIONS = 64;
export const MAX_FAULT_COUNTER_KEY_CHARS = 220;
export const MAX_FAULT_COUNTER_TEST_CHARS = 400;

/* One test's counter: how many responses its run corrupted, per operation, and which test it was. */
export interface FaultCounterRecord {
  corrupted: number;
  /* Absent in a counter that names no operation. */
  byOperation?: Record<string, number>;
  /* `<spec file>::<title>`; absent in a counter that names no test. */
  test?: string;
}

/* The operation counts and the test of a counter, rebuilt field by field. Throws RangeError on a map that is not within the bounds or holds anything but integer counts: the counter is refused whole. */
export function parseFaultCounterFields(parsed: unknown): Pick<FaultCounterRecord, "byOperation" | "test"> {
  const out: Pick<FaultCounterRecord, "byOperation" | "test"> = {};
  const raw = isRecord(parsed) ? parsed : {};
  if (raw.byOperation !== undefined) {
    if (!isRecord(raw.byOperation)) throw new RangeError("byOperation is not an object");
    const entries = Object.entries(raw.byOperation);
    if (entries.length > MAX_FAULT_COUNTER_OPERATIONS) throw new RangeError("too many operations");
    const byOperation: Record<string, number> = {};
    for (const [key, count] of entries) {
      if (key.length > MAX_FAULT_COUNTER_KEY_CHARS) throw new RangeError("an operation key is too long");
      if (!isCount(count) || count > MAX_FAULT_INJECTION_COUNT) throw new RangeError("an operation count is not a count");
      byOperation[key] = count;
    }
    out.byOperation = byOperation;
  }
  if (raw.test !== undefined) {
    if (typeof raw.test !== "string") throw new RangeError("test is not a string");
    out.test = raw.test.slice(0, MAX_FAULT_COUNTER_TEST_CHARS);
  }
  return out;
}

/* A counter as the orchestrator keeps it for the reader: the count, the per-operation counts and the test, each rebuilt and bounded, and nothing else. The counter is written by the suite's fixtures (agent-editable code) and reaches a folder the agent reads, so no other key survives. Throws RangeError on anything that is not a non-negative integer count, or whose operation map is not within its bounds. */
export function sanitizeFaultCounter(bytes: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RangeError("not JSON");
  }
  const corrupted = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { corrupted?: unknown }).corrupted : undefined;
  if (typeof corrupted !== "number" || !Number.isInteger(corrupted) || corrupted < 0 || corrupted > MAX_FAULT_INJECTION_COUNT) throw new RangeError("not a count");
  return Buffer.from(JSON.stringify({ corrupted, ...parseFaultCounterFields(parsed) }));
}
