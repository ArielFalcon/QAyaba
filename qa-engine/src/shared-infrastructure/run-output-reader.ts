/* The one reader of what a run of the tests leaves in a directory the orchestrator reads back: the coverage dumps, the native coverage reports and the fault-injection counters under the spec directory, and the failure-capture dumps and the Playwright report in the temporary directories the e2e runner makes. The tests run code the agent wrote, so every one of these files is the agent's to shape: a named pipe where a file is expected would hold the whole single-threaded orchestrator for ever, a link would put a file outside the mirror in the signal, and a file or a directory as large as the disk allows would fill its memory or its time. Every read goes through the strict read of spec-path-confinement, under a cap, and never throws.
   What it reads is a set, and what a missing part of the set does to the result is for the caller to say, in one of two ways. A set that measures a whole (a ratio of the change that the dumps cover, a count of the corrupted responses) is used whole or not at all (`readRunOutputDir`): when any file of it cannot be used (refused, over the cap, outside the budget, unreadable, or one `decode` throws on), or the directory holds more entries than are looked at, nothing of it is used and one line says so, in words that quote nothing it holds (the number of files and the reason of each, never a name, a path of the agent's, a parser's message or a byte of a file). The rest of the set measures a part of what the run did, and a ratio or a count of a part is one the run never made, lower than the real one: under enforce it would block a valid change. Nothing used is no measurement, which the keystone reads as "unknown", and unknown never blocks. A set whose files each stand alone (one failure dump grounds one case) is scanned (`scanRunOutputDir`), and the caller uses what could be used and says what could not. */

import { join } from "node:path";
import { listOwnedSpecDir, readFailureReason, readOwnedSpecFile, type OwnedSpecRead, type SpecRoot } from "./spec-path-confinement.ts";

export interface RunOutputLimits {
  /* The most one file may hold; a larger one is not read. */
  maxFileBytes: number;
  /* The most the files of one directory may hold together: once the next file would pass it, it and the rest are not read. */
  maxTotalBytes: number;
  /* The most entries of one directory that are looked at; a directory with more is cut there. */
  maxFiles: number;
}

const UNUSABLE = "its content could not be used";
const GONE = "it was gone when it was read";
const OVER_BUDGET = "the files of this directory already read hold more than the budget";

/* The bytes of a file below the root, or why there are none; never throws. A failure to read a file that is there is told by its code. */
function readConfined(root: SpecRoot, rel: string, maxBytes: number): OwnedSpecRead {
  try {
    return readOwnedSpecFile(root, rel, maxBytes);
  } catch (err) {
    return { reason: readFailureReason(err) };
  }
}

/* What a scan of a directory comes to: nothing there, a directory that cannot be used and why, or what could be used, why each of the rest could not, and whether the directory was cut at the entry cap. */
export type RunOutputScan<T> = { absent: true } | { unusable: string } | { files: T[]; leftOut: string[]; cut: boolean };

/* Decodes every file of the directory at `rel` that `accept` takes, in the order of their names, within `limits`, and says nothing: a directory that is not there is absent; one that cannot be vouched for (a link, a file, one with a link above it) is unusable; and each file that cannot be used (refused, over the cap, outside the budget, unreadable, gone, or one `decode` throws on) is left out with a reason of the module's own, the parser's message being no reason since it quotes the file. A directory with more entries than the cap is cut there; with `readCut` false its files are not read at all. Never throws. */
export function scanRunOutputDir<T>(
  root: SpecRoot,
  rel: string,
  accept: (name: string) => boolean,
  decode: (name: string, bytes: Buffer) => T,
  limits: RunOutputLimits,
  options: { readCut: boolean },
): RunOutputScan<T> {
  const listing = listOwnedSpecDir(root, rel, limits.maxFiles);
  if ("absent" in listing) return { absent: true };
  if ("reason" in listing) return { unusable: listing.reason };
  if (listing.truncated && !options.readCut) return { files: [], leftOut: [], cut: true };
  const names = listing.names.filter(accept);
  const files: T[] = [];
  const leftOut: string[] = [];
  let total = 0;
  for (const [index, name] of names.entries()) {
    const read = readConfined(root, `${rel}/${name}`, limits.maxFileBytes);
    if ("absent" in read || "reason" in read) {
      leftOut.push("reason" in read ? read.reason : GONE);
      continue;
    }
    total += read.bytes.length;
    if (total > limits.maxTotalBytes) {
      leftOut.push(...names.slice(index).map(() => OVER_BUDGET));
      break;
    }
    try {
      files.push(decode(name, read.bytes));
    } catch {
      leftOut.push(UNUSABLE);
    }
  }
  return { files, leftOut, cut: listing.truncated };
}

/* The reasons files were left out, each with the number of files it covers: "reason ×3; another reason ×1". Never a name. */
export function describeReasons(reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${reason} ×${count}`).join("; ");
}

function warnUnread(where: string, reason: string): void {
  console.warn(`[qa] WARNING: ${where} was not read (${reason}); the signal stays unmeasured this run (non-blocking).`);
}

/* One line for a whole directory, never one per file: an agent can plant thousands. It says how many files could not be used and, for each reason, how many, and names none of them: a file name is the agent's to choose, so it never reaches a log. */
function warnNotRead(where: string, reasons: readonly string[]): void {
  console.warn(`[qa] WARNING: ${where}: ${reasons.length} file(s) not read — ${describeReasons(reasons)}. None of the directory is used, so the signal stays unmeasured this run (non-blocking).`);
}

/* Decodes every file of the directory at `rel` that `accept` takes, in the order of their names, within `limits`, or says why it does not: a directory that is not there is no output and nothing to say (an empty list); one that cannot be vouched for (a link, a file, one with a link above it), one with more entries than the cap, and one with a file that cannot be used (refused, over the cap, outside the budget, unreadable, or one `decode` throws on) is not used at all, said once for the directory, and gives undefined. Never throws. */
export function readRunOutputDir<T>(
  root: SpecRoot,
  rel: string,
  accept: (name: string) => boolean,
  decode: (name: string, bytes: Buffer) => T,
  limits: RunOutputLimits,
): T[] | undefined {
  const where = join(root.specDir, rel);
  const scan = scanRunOutputDir(root, rel, accept, decode, limits, { readCut: false });
  if ("absent" in scan) return [];
  if ("unusable" in scan) {
    warnUnread(where, scan.unusable);
    return undefined;
  }
  if (scan.cut) {
    console.warn(`[qa] WARNING: ${where}: more than ${limits.maxFiles} entries; none of the directory is used, so the signal stays unmeasured this run (non-blocking).`);
    return undefined;
  }
  if (scan.leftOut.length > 0) {
    warnNotRead(where, scan.leftOut);
    return undefined;
  }
  return scan.files;
}

/* Decodes the first of the reports at `candidates` (paths below the root, in the order they are tried) that is there, as a list of one; none there is no output and nothing to say (an empty list). The first that is there decides: one that cannot be used (refused, over the cap, unreadable, or one `decode` throws on) is said and gives undefined, and another further down the list does not stand in for it. Never throws. */
export function readFirstReport<T>(root: SpecRoot, candidates: readonly string[], maxBytes: number, decode: (path: string, bytes: Buffer) => T): T[] | undefined {
  for (const rel of candidates) {
    const read = readConfined(root, rel, maxBytes);
    if ("absent" in read) continue;
    const path = join(root.specDir, rel);
    if ("reason" in read) {
      warnUnread(path, read.reason);
      return undefined;
    }
    try {
      return [decode(path, read.bytes)];
    } catch {
      warnUnread(path, UNUSABLE);
      return undefined;
    }
  }
  return [];
}
