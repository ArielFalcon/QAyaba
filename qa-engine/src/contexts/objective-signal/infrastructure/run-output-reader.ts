/* The one reader of what a run of the tests leaves under the spec directory: coverage dumps, the native coverage reports and the fault-injection counters. The tests run code the agent wrote, so every one of these files is the agent's to shape: a named pipe where a file is expected would hold the whole single-threaded orchestrator for ever, a link would put a file outside the mirror in the signal, and a file or a directory as large as the disk allows would fill its memory or its time. Every read goes through the strict read of spec-path-confinement, under a cap, and never throws.
   What it reads is a set, and a set is used whole or not at all: when any file of it cannot be used (refused, over the cap, outside the budget, unreadable, or one `decode` throws on), or the directory holds more entries than are looked at, nothing of it is used and one line says so, in words that quote nothing it holds (the number of files and the reason of each, never a name, a path of the agent's, a parser's message or a byte of a file). The rest of the set measures a part of what the run did, and a ratio or a count of a part is one the run never made, lower than the real one: under enforce it would block a valid change. Nothing used is no measurement, which the keystone reads as "unknown", and unknown never blocks. */

import { join } from "node:path";
import { listOwnedSpecDir, readFailureReason, readOwnedSpecFile, type OwnedSpecRead, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";

export interface RunOutputLimits {
  /* The most one file may hold; a larger one is not read. */
  maxFileBytes: number;
  /* The most the files of one directory may hold together: once the next file would pass it, it and the rest are not read. */
  maxTotalBytes: number;
  /* The most entries of one directory that are looked at; a directory with more is not used. */
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

function warnUnread(where: string, reason: string): void {
  console.warn(`[qa] WARNING: ${where} was not read (${reason}); the signal stays unmeasured this run (non-blocking).`);
}

/* One line for a whole directory, never one per file: an agent can plant thousands. It says how many files could not be used and, for each reason, how many, and names none of them: a file name is the agent's to choose, so it never reaches a log. */
function warnNotRead(where: string, reasons: readonly string[]): void {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const why = [...counts].map(([reason, count]) => `${reason} ×${count}`).join("; ");
  console.warn(`[qa] WARNING: ${where}: ${reasons.length} file(s) not read — ${why}. None of the directory is used, so the signal stays unmeasured this run (non-blocking).`);
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
  const listing = listOwnedSpecDir(root, rel, limits.maxFiles);
  if ("absent" in listing) return [];
  if ("reason" in listing) {
    warnUnread(where, listing.reason);
    return undefined;
  }
  if (listing.truncated) {
    console.warn(`[qa] WARNING: ${where}: more than ${limits.maxFiles} entries; none of the directory is used, so the signal stays unmeasured this run (non-blocking).`);
    return undefined;
  }
  const names = listing.names.filter(accept);
  const out: T[] = [];
  const notRead: string[] = [];
  let total = 0;
  for (const [index, name] of names.entries()) {
    const read = readConfined(root, `${rel}/${name}`, limits.maxFileBytes);
    if ("absent" in read || "reason" in read) {
      notRead.push("reason" in read ? read.reason : GONE);
      continue;
    }
    total += read.bytes.length;
    if (total > limits.maxTotalBytes) {
      notRead.push(...names.slice(index).map(() => OVER_BUDGET));
      break;
    }
    try {
      out.push(decode(name, read.bytes));
    } catch {
      /* The parser's message quotes the file: the reason is ours. */
      notRead.push(UNUSABLE);
    }
  }
  if (notRead.length > 0) {
    warnNotRead(where, notRead);
    return undefined;
  }
  return out;
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
