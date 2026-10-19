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
 */

import { chmodSync, chownSync, lstatSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MAX_V8_DUMP_FILES, MAX_V8_DUMP_BYTES, MAX_V8_DUMPS_TOTAL_BYTES, sanitizeV8Dump } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import { MAX_FAULT_INJECTION_COUNTER_BYTES, MAX_FAULT_INJECTION_COUNTER_FILES, sanitizeFaultCounter } from "@contexts/objective-signal/infrastructure/fault-injection-counter-reader.ts";
import { describeReasons, scanRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";
import { ensureOwnedSpecDir, purgeRefusedDirectory, writeOwnedSpecFile, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";

/* The namespace is the run's data prefix; it names a folder, so it names nothing else: Unicode letters, combining marks and numbers, plus the separators a folder name may carry. A path separator, a control character, and a leading dot or dash (which a hidden or relative name needs) are none of them. */
const NAMESPACE_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,127}$/u;
const DUMP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/;

/* The time all the dumps of a run are given to be checked, together; past it the set is left out, like a set the reader cannot decode in its own time. */
export const DUMP_CHECK_BUDGET_MS = 10_000;

interface DumpKind {
  /* Folder name, below `.qa` in the mirror and below the dump root in the work dir. */
  folder: "coverage" | "fault-injection";
  sanitize(bytes: Buffer): Buffer;
  limits: RunOutputLimits;
}

const KINDS: readonly DumpKind[] = [
  { folder: "coverage", sanitize: sanitizeV8Dump, limits: { maxFileBytes: MAX_V8_DUMP_BYTES, maxTotalBytes: MAX_V8_DUMPS_TOTAL_BYTES, maxFiles: MAX_V8_DUMP_FILES } },
  { folder: "fault-injection", sanitize: sanitizeFaultCounter, limits: { maxFileBytes: MAX_FAULT_INJECTION_COUNTER_BYTES, maxTotalBytes: MAX_FAULT_INJECTION_COUNTER_BYTES * 256, maxFiles: MAX_FAULT_INJECTION_COUNTER_FILES } },
];

export interface DumpBridgeInput {
  /* The suite's directory in the mirror (`e2e`). */
  specDir: string;
  namespace: string;
  /* A directory in the run's work dir, owned by the sandbox, holding one folder per kind (`coverage`, `fault-injection`). */
  dumpRoot: string;
  /* The run's work dir: the root the strict reads of the dump root walk from. */
  workRoot: string;
  now?: () => number;
}

export interface DumpBridge {
  /* To be called once the child is gone: carries the valid dumps over and removes the links. */
  harvest(): void;
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

export function openDumpBridge(input: DumpBridgeInput): DumpBridge {
  if (!NAMESPACE_RE.test(input.namespace)) throw new Error(`invalid namespace ${JSON.stringify(input.namespace)} for a dump folder: must match ${String(NAMESPACE_RE)}`);
  const now = input.now ?? ((): number => performance.now());
  const specRoot: SpecRoot = { mirrorDir: input.specDir, specDir: input.specDir };
  const links = KINDS.map((kind) => join(input.specDir, ".qa", kind.folder, input.namespace));

  for (const [index, kind] of KINDS.entries()) {
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
    harvest() {
      if (done) return;
      done = true;
      removeLinks();
      const workRoot: SpecRoot = { mirrorDir: input.workRoot, specDir: input.workRoot };
      const started = now();
      for (const kind of KINDS) {
        const rel = `${input.dumpRoot.slice(input.workRoot.length).replace(/^\/+/, "")}/${kind.folder}`;
        const scan = scanRunOutputDir(
          workRoot,
          rel,
          (name) => DUMP_NAME_RE.test(name),
          (name, bytes) => {
            if (now() - started > DUMP_CHECK_BUDGET_MS) throw new RangeError("out of time");
            return { name, bytes: kind.sanitize(bytes) };
          },
          kind.limits,
          { readCut: false },
        );
        if ("absent" in scan) continue;
        if ("unusable" in scan) {
          console.warn(`[qa] WARNING: the ${kind.folder} dumps of this run were not read (${scan.unusable}); the signal stays unmeasured this run (non-blocking).`);
          leaveOut(kind);
          continue;
        }
        if (scan.cut || scan.leftOut.length > 0) {
          console.warn(`[qa] WARNING: the ${kind.folder} dumps of this run: ${scan.leftOut.length} file(s) not usable${scan.cut ? " and more entries than are looked at" : ""} (${describeReasons(scan.leftOut)}). None of them is used, so the signal stays unmeasured this run (non-blocking).`);
          leaveOut(kind);
          continue;
        }
        for (const file of scan.files) writeOwnedSpecFile(specRoot, `.qa/${kind.folder}/${input.namespace}/${file.name}`, file.bytes);
      }
    },
    dispose() {
      done = true;
      removeLinks();
    },
  };
}
