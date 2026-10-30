/* Coverage dump reader. Fail-open: an absent, unusable or corrupt dump degrades to an empty result — never throws, never waits, never leaves the mirror. An empty report is unmeasured → unknown → never blocks publish. What a run of the tests leaves is the agent's to shape, so every read goes through run-output-reader (the strict read under a cap; what cannot be used is said aloud, quoting nothing of it). The dumps of a run are used whole or not at all: the coverage of some of them is a ratio of a part of what the run did, lower than the real one, and under enforce it would block a valid change, so when any of them cannot be used none of them is used and the result is empty. The files are read here, confined; decoding them is CPU work on bytes the agent shaped, which a dump of tens of megabytes makes last seconds, so it runs in a worker thread started for the one call (`OffLoopExecutor`, `coverage-decode.ts`) and never on the orchestrator's event loop. */
import { engineLog } from "@kernel/ports/process-logger.ts";
import { join } from "node:path";
import type { CoverageRead, CoverageScripts, MutantEdit } from "../domain/coverage-collector.ts";
import { unusedOutcome, type DumpOutcome } from "../domain/dump-outcome.ts";
import { MAX_V8_DUMP_BYTES, MAX_V8_DUMP_FILES, MAX_V8_DUMPS_TOTAL_BYTES } from "../domain/dump-sanitizers.ts";
import type { CoveredLines } from "./v8-browser-coverage.adapter.ts";
import type { BranchSink } from "./v8-branch-coverage.ts";
import { mergeDecodedDump, type DecodeContext } from "./coverage-decode.ts";
import { scanRunOutputDir, UNUSABLE, wholeSetOf, workerFailureReason, type RunOutputLimits, type RunOutputScan } from "../../../shared-infrastructure/run-output-reader.ts";
import { createWorkerExecutor, runWithin, type OffLoopExecutor } from "../../../shared-infrastructure/worker/off-loop-executor.ts";

interface RawDump {
  name: string;
  bytes: Buffer;
}

export const V8_DUMP_LIMITS: RunOutputLimits = { maxFileBytes: MAX_V8_DUMP_BYTES, maxTotalBytes: MAX_V8_DUMPS_TOTAL_BYTES, maxFiles: MAX_V8_DUMP_FILES };

/* The time all the dumps of a run are given to be decoded, together: a suite of fifty dumps of the largest size measured is some ten seconds at the speed it ran at, and a hundred megabytes of the slowest map is five. It is how long the read waits for the worker once the worker has begun, which is then ended; past it the set is unused. The worker's own start (its thread, its module, the bytes handed over: 1.6 to 2.5 s on real dumps) is no part of it, and is bounded on its own (`WORKER_START_BUDGET_MS`). */
export const V8_DECODE_BUDGET_MS = 10_000;

/* The heap a coverage-decode worker may use, in MiB: the process default, so that it admits what the byte cap of a dump admits (a dump of the worst shape at the cap takes 1.4 GB of heap to parse). */
const DECODE_WORKER_HEAP_MB = 2_048;

/* One worker per call. */
export function createCoverageDecodeExecutor(): OffLoopExecutor {
  return createWorkerExecutor({ worker: new URL("./coverage-decode.worker.ts", import.meta.url), maxHeapMb: DECODE_WORKER_HEAP_MB });
}

/* The lines of `changedFiles` that the dumps of a namespace cover (and, in `scripts` when given, how many scripts they held and how many carried a source map; in `branches`, the decisions of the changed files they ran), one entry per dump in the order of their names; in `ranBy`, when given, the names of the dumps that ran a line of each changed file, added only when the set is used. The dumps are decoded by `executor` within `budgetMs` and each is reduced to the lines of the changed files, so the result is as small as those lines, however many dumps and however large. A dump `keep` refuses (by its name) is neither read nor decoded; a dump a mutant's re-run wrote (`mutant`) is decoded with the mutant's edit undone. A worker that does not answer within the time, that runs out of memory, that dies or that cannot be started leaves the set unused, said once with its own reason, and adds nothing to `scripts`, `branches` or `executable`. How the read ended, whatever it came to, is told to `reads` when given: one record, with the dumps and bytes it was given, its time and its outcome, so an empty result can be told from a folder that was not there. */
export async function readV8Coverage(e2eDir: string, namespace: string, changedFiles: string[], limits: RunOutputLimits = V8_DUMP_LIMITS, executor: OffLoopExecutor = createCoverageDecodeExecutor(), budgetMs: number = V8_DECODE_BUDGET_MS, scripts?: CoverageScripts, branches?: BranchSink, keep: (name: string) => boolean = () => true, executable?: CoveredLines, mutant?: MutantEdit, ranBy?: Map<string, Set<string>>, reads?: CoverageRead[]): Promise<CoveredLines[]> {
  const startedAt = Date.now();
  const began = performance.now();
  let outcome: DumpOutcome = "completed";
  let timing: { startMs: number | null; workMs: number } = { startMs: null, workMs: 0 };
  /* The bytes are counted before the decode: a worker is handed them by transfer, and what it holds is no longer this side's to read. */
  let given = { dumps: 0, bytes: 0 };
  const told = (): void => {
    reads?.push({ namespace, startedAt, durationMs: performance.now() - began, ...given, outcome, ...timing });
  };
  const rel = `.qa/coverage/${namespace}`;
  const root = { mirrorDir: e2eDir, specDir: e2eDir };
  const scan = scanRunOutputDir<RawDump>(root, rel, (name) => name.endsWith(".json") && keep(name), (name, bytes) => ({ name, bytes }), limits, { readCut: false });
  const files = "files" in scan ? scan.files : [];
  const leftOut = "files" in scan ? [...scan.leftOut] : [];
  const named: Array<[string, CoveredLines]> = [];
  given = { dumps: files.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) };
  if (files.length > 0) {
    const context: DecodeContext = { changedFiles, ...(mutant ? { mutant } : {}), executable: executable !== undefined, branches: branches?.open ?? false };
    const decode = await runWithin(executor, files.map((file) => file.bytes), budgetMs, context);
    timing = { startMs: decode.timing?.startMs ?? null, workMs: decode.timing?.workMs ?? 0 };
    if (decode.kind === "failed" && decode.reason === "aborted") {
      engineLog.warn(`[qa] WARNING: ${join(e2eDir, rel)}: the dumps were not all decoded in the time a run is given (${budgetMs} ms); none of them is used, so the coverage is unknown this run (non-blocking).`);
      outcome = "aborted";
      told();
      return [];
    }
    if (decode.kind === "failed") {
      outcome = decode.reason;
      leftOut.push(...files.map(() => workerFailureReason(decode.reason, "decodes")));
    } else {
      for (const [index, file] of files.entries()) {
        const covered = mergeDecodedDump(file.name, decode.outputs[index], { scripts, branches, executable });
        if (covered) named.push([file.name, covered]);
        else leftOut.push(UNUSABLE);
      }
    }
  }
  const decoded: RunOutputScan<[string, CoveredLines]> = "files" in scan ? { files: named, leftOut, cut: scan.cut } : scan;
  const dumps = wholeSetOf(root, rel, decoded, limits);
  /* An outcome the executor already gave stands; otherwise no dump was there (no folder, or no file in it), or its files were not all used and the cap or the content is why. */
  if (outcome === "completed") {
    if ("absent" in scan || (files.length === 0 && leftOut.length === 0 && dumps !== undefined)) outcome = "absent";
    else if (!dumps) outcome = "unusable" in scan ? "unusable" : unusedOutcome({ cut: scan.cut, leftOut });
  }
  told();
  if (!dumps) return [];
  /* The dumps are used whole or not at all: which ran what is told only of a set that is used. */
  if (ranBy) {
    for (const [name, covered] of dumps) {
      for (const [file, lines] of covered) if (lines.size > 0) ranBy.set(file, (ranBy.get(file) ?? new Set<string>()).add(name));
    }
  }
  return dumps.map(([, covered]) => covered);
}
