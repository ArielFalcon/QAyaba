/*
 * The dump folders of a suite run. The suite's fixtures write the coverage dumps and the fault-injection counters under
 * `<spec dir>/.qa/coverage/<namespace>` and `<spec dir>/.qa/fault-injection/<namespace>`, from a process that holds the saved session
 * and runs code the agent wrote. Those folders used to be handed to the sandbox uid inside the mirror, so anything the child wrote
 * there (a cookie, a token, a file) landed where the agent reads the mirror: a channel past the egress filter and the by-value
 * redaction. Now nothing the child writes lands in the mirror. For the length of the child the mirror's folder for the namespace is
 * a link, made by the orchestrator, to a folder in the run's work dir (the fixtures keep writing to the same path, so repositories
 * with an older fixtures file are unaffected). When the child is gone the link is removed and only what the readers use is carried
 * over: each file by name pattern, size cap and parse, rebuilt field by field (objective-signal's `sanitizeV8Dump` and
 * `sanitizeFaultCounter`), written strictly by the orchestrator. The set is whole or nothing, like the readers': one file that
 * cannot be used leaves none of the folder's files behind, so a coverage of some of the dumps is never taken for the run's.
 * The rebuild of a coverage dump is CPU work on bytes the agent shaped, which a dump of tens of megabytes makes last seconds, so it
 * runs in a worker thread started for the one harvest (`OffLoopExecutor`) and never on the orchestrator's event loop; the reads and
 * the writes stay here, confined. The counters are a few bytes each and are rebuilt in place.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { chmodSync, chownSync, lstatSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MAX_V8_DUMP_FILES, MAX_V8_DUMP_BYTES, MAX_V8_DUMPS_TOTAL_BYTES, MAX_FAULT_INJECTION_COUNTER_BYTES, MAX_FAULT_INJECTION_COUNTER_FILES, sanitizeFaultCounter, unusedOutcome, type DumpOutcome } from "@contexts/objective-signal/application/index.ts";
import { describeReasons, OUT_OF_TIME, scanRunOutputDir, UNUSABLE, workerFailureReason, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";
import { ensureOwnedSpecDir, purgeRefusedDirectory, writeOwnedSpecFile, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { createWorkerExecutor, runWithin, type OffLoopExecutor, type OffLoopFailure } from "../../../shared-infrastructure/worker/off-loop-executor.ts";

/* The namespace is the run's data prefix; it names a folder, so it names nothing else: Unicode letters, combining marks and numbers, plus the separators a folder name may carry. A path separator, a control character, and a leading dot or dash (which a hidden or relative name needs) are none of them. */
const NAMESPACE_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,127}$/u;
const DUMP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/;

/* The time the dumps of one kind (the coverage dumps, the fault-injection counters) are given to be checked, together; past it the set of that kind is left out, like a set the reader cannot decode in its own time. Each kind has the time of its own: the bulky coverage dumps must not use up what the small counters, which decide whether a mutant reached a page, are checked in. For the coverage dumps it is how long the harvest waits for the worker, which is then ended; a parse already running in the worker is bounded by the byte cap of one dump, not by this. */
export const DUMP_CHECK_BUDGET_MS = 10_000;

/* The heap a coverage-dump worker may use, in MiB: a dump of the worst shape at the byte cap takes 1.4 GB of heap to parse, so a lower limit would refuse what the cap lets through. */
const DUMP_WORKER_HEAP_MB = 2_048;

interface RawDump {
  name: string;
  bytes: Buffer;
}

/* What a kind's check comes to: the files rebuilt, and why each of the others could not be used; `failure` is the way the check itself ended when it did not complete (the worker, or the time of the kind), and `startMs`/`workMs` how long the worker took to begin and then to work, when it is told. */
interface Checked {
  files: RawDump[];
  leftOut: string[];
  failure?: OffLoopFailure;
  startMs?: number | null;
  workMs?: number;
}

/* One kind of dump as a harvest handled it, whatever it came to: when it began (wall-clock ms), how long it took, the files and bytes it was given, and how it ended. Told to `onHarvested`, which the shell turns into a span. */
export interface DumpHarvest {
  kind: "coverage" | "fault-injection";
  namespace: string;
  startedAt: number;
  durationMs: number;
  dumps: number;
  bytes: number;
  outcome: DumpOutcome;
  /* From the call until the worker said it had begun, and from then to the outcome; absent for a kind rebuilt in place. */
  startMs?: number | null;
  workMs?: number;
}

interface DumpKind {
  /* Folder name, below `.qa` in the mirror and below the dump root in the work dir. */
  folder: "coverage" | "fault-injection";
  limits: RunOutputLimits;
  /* `started` is when the kind's check began, for a kind that rebuilds in place against the clock. */
  check(files: readonly RawDump[], started: number): Promise<Checked>;
}

/* One worker per harvest. */
export function createDumpExecutor(): OffLoopExecutor {
  return createWorkerExecutor({ worker: new URL("./dump-sanitize.worker.ts", import.meta.url), maxHeapMb: DUMP_WORKER_HEAP_MB });
}

const NONE = { count: 0, bytes: 0 };

export interface DumpBridgeInput {
  /* The suite's directory in the mirror (`e2e`). */
  specDir: string;
  namespace: string;
  /* A directory in the run's work dir, owned by the sandbox, holding one folder per kind (`coverage`, `fault-injection`). */
  dumpRoot: string;
  /* The run's work dir: the root the strict reads of the dump root walk from. */
  workRoot: string;
  now?: () => number;
  /* Absent: a worker thread per harvest. */
  executor?: OffLoopExecutor;
  /* Told how each kind of dump was handled, once per kind, whatever it came to. A fault in it never reaches the harvest. */
  onHarvested?: (harvest: DumpHarvest) => void;
  /* Wall-clock ms, for the time a harvest began. */
  wallNow?: () => number;
}

export interface DumpBridge {
  /* To be called once the child is gone: carries the valid dumps over and removes the links. */
  harvest(): Promise<void>;
  /* Removes the links and copies nothing; idempotent, and safe after `harvest`. */
  dispose(): void;
}

function ownedByOrchestrator(path: string): void {
  try {
    if (process.getuid && process.getgid) chownSync(path, process.getuid(), process.getgid());
    chmodSync(path, 0o755);
  } catch {
    /* Not root (a developer's host): the directory is already the orchestrator's. */
  }
}

/* Whatever is at `path`, removed without being followed. */
function removeEntry(path: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isDirectory()) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
  } catch {
    /* Not there. */
  }
}

/* A file reached after the kind's check time ran out is left out like any that cannot be rebuilt. */
function checkInPlace(files: readonly RawDump[], started: number, now: () => number, rebuild: (bytes: Buffer) => Buffer): Checked {
  const checked: Checked = { files: [], leftOut: [] };
  for (const file of files) {
    if (now() - started > DUMP_CHECK_BUDGET_MS) {
      checked.leftOut.push(OUT_OF_TIME);
      checked.failure = "aborted";
      continue;
    }
    try {
      checked.files.push({ name: file.name, bytes: rebuild(file.bytes) });
    } catch {
      checked.leftOut.push(UNUSABLE);
    }
  }
  return checked;
}

/* Waits for the executor at most the kind's check time, counted from when its worker has begun, and then tells it to end its worker. */
async function checkInExecutor(files: readonly RawDump[], executor: OffLoopExecutor): Promise<Checked> {
  if (files.length === 0) return { files: [], leftOut: [] };
  const outcome = await runWithin(executor, files.map((file) => file.bytes), DUMP_CHECK_BUDGET_MS);
  const timing = { startMs: outcome.timing?.startMs ?? null, workMs: outcome.timing?.workMs ?? 0 };
  if (outcome.kind === "failed") return { files: [], leftOut: files.map(() => workerFailureReason(outcome.reason, "checks")), failure: outcome.reason, ...timing };
  const checked: Checked = { files: [], leftOut: [], ...timing };
  for (const [index, file] of files.entries()) {
    const output = outcome.outputs[index];
    if (output === null || output === undefined) checked.leftOut.push(UNUSABLE);
    else checked.files.push({ name: file.name, bytes: output });
  }
  return checked;
}

export function openDumpBridge(input: DumpBridgeInput): DumpBridge {
  if (!NAMESPACE_RE.test(input.namespace)) throw new Error(`invalid namespace ${JSON.stringify(input.namespace)} for a dump folder: must match ${String(NAMESPACE_RE)}`);
  const now = input.now ?? ((): number => performance.now());
  const executor = input.executor ?? createDumpExecutor();
  const kinds: readonly DumpKind[] = [
    { folder: "coverage", limits: { maxFileBytes: MAX_V8_DUMP_BYTES, maxTotalBytes: MAX_V8_DUMPS_TOTAL_BYTES, maxFiles: MAX_V8_DUMP_FILES }, check: (files) => checkInExecutor(files, executor) },
    { folder: "fault-injection", limits: { maxFileBytes: MAX_FAULT_INJECTION_COUNTER_BYTES, maxTotalBytes: MAX_FAULT_INJECTION_COUNTER_BYTES * 256, maxFiles: MAX_FAULT_INJECTION_COUNTER_FILES }, check: async (files, started) => checkInPlace(files, started, now, sanitizeFaultCounter) },
  ];
  const specRoot: SpecRoot = { mirrorDir: input.specDir, specDir: input.specDir };
  const links = kinds.map((kind) => join(input.specDir, ".qa", kind.folder, input.namespace));

  for (const [index, kind] of kinds.entries()) {
    const folder = `.qa/${kind.folder}`;
    /* The folder is the orchestrator's: an older version handed it to the sandbox uid, and a link or a file planted in its place is not followed. */
    purgeRefusedDirectory(specRoot, folder);
    ensureOwnedSpecDir(specRoot, folder);
    ownedByOrchestrator(join(input.specDir, folder));
    removeEntry(links[index]!);
    symlinkSync(join(input.dumpRoot, kind.folder), links[index]!);
  }

  let done = false;
  const removeLinks = (): void => {
    for (const link of links) {
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
      } catch {
        /* Not there. */
      }
    }
  };

  /* A set that is left out is not the same as a run that left none: with nothing in the mirror a reader would take it for "no response was there to corrupt". A plain file where the folder would be is a path every reader refuses to follow, so they report the count unknown. */
  const leaveOut = (kind: DumpKind): void => {
    writeOwnedSpecFile(specRoot, `.qa/${kind.folder}/${input.namespace}`, Buffer.from("the dumps of this run were left out: see the orchestrator's log\n"));
  };

  return {
    async harvest() {
      if (done) return;
      done = true;
      removeLinks();
      const workRoot: SpecRoot = { mirrorDir: input.workRoot, specDir: input.workRoot };
      const wall = input.wallNow ?? Date.now;
      for (const kind of kinds) {
        const started = now();
        const startedAt = wall();
        const told = (outcome: DumpOutcome, given: { count: number; bytes: number }, checked?: Checked): void => {
          if (!input.onHarvested) return;
          try {
            input.onHarvested({
              kind: kind.folder,
              namespace: input.namespace,
              startedAt,
              durationMs: now() - started,
              dumps: given.count,
              bytes: given.bytes,
              outcome,
              ...(checked?.startMs !== undefined ? { startMs: checked.startMs } : {}),
              ...(checked?.workMs !== undefined ? { workMs: checked.workMs } : {}),
            });
          } catch (err) {
            engineLog.error(`[telemetry] a dump harvest could not be recorded (the harvest goes on): ${err instanceof Error ? err.message : String(err)}`);
          }
        };
        const rel = `${input.dumpRoot.slice(input.workRoot.length).replace(/^\/+/, "")}/${kind.folder}`;
        const scan = scanRunOutputDir(workRoot, rel, (name) => DUMP_NAME_RE.test(name), (name, bytes): RawDump => ({ name, bytes }), kind.limits, { readCut: false });
        if ("absent" in scan) {
          told("absent", NONE);
          continue;
        }
        if ("unusable" in scan) {
          engineLog.warn(`[qa] WARNING: the ${kind.folder} dumps of this run were not read (${scan.unusable}); the signal stays unmeasured this run (non-blocking).`);
          leaveOut(kind);
          told("unusable", NONE);
          continue;
        }
        /* The bytes are counted before the check: a worker is handed them by transfer, and what it holds is no longer this side's to read. */
        const given = { count: scan.files.length, bytes: scan.files.reduce((sum, file) => sum + file.bytes.length, 0) };
        const checked = await kind.check(scan.files, started);
        const leftOut = [...scan.leftOut, ...checked.leftOut];
        if (scan.cut || leftOut.length > 0) {
          engineLog.warn(`[qa] WARNING: the ${kind.folder} dumps of this run: ${leftOut.length} file(s) not usable${scan.cut ? " and more entries than are looked at" : ""} (${describeReasons(leftOut)}). None of them is used, so the signal stays unmeasured this run (non-blocking).`);
          leaveOut(kind);
          told(checked.failure ?? unusedOutcome({ cut: scan.cut, leftOut }), given, checked);
          continue;
        }
        for (const file of checked.files) writeOwnedSpecFile(specRoot, `.qa/${kind.folder}/${input.namespace}/${file.name}`, file.bytes);
        /* No dump file was there to hand over: nothing was harvested, which is no more a completed harvest than a folder that is not there. */
        told(given.count === 0 ? "absent" : "completed", given, checked);
      }
    },
    dispose() {
      done = true;
      removeLinks();
    },
  };
}
