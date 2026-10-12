/*
 * The probing child of the boot check (src/server/file-boundary-check.ts), run as the sandbox uid.
 *
 * It is plain JavaScript on purpose and the parent starts it with no loader: a TypeScript loader keeps its transforms in a cache
 * under the temporary directory, which this uid can write and which survives restarts, and loads what it finds there without
 * validating it. A forged transform could report every attempt refused. Nothing here imports anything but node:fs and node:crypto.
 *
 * It reads the planned attempts as JSON on stdin and prints, for each in order, only what the system call answered: its error code
 * (null when it worked) and, for a write, what it found at the path. What an answer means is decided by the parent
 * (qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts).
 */

import { closeSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const realFs = { closeSync, openSync, readdirSync, statSync, unlinkSync };

/* The filesystem calls a probe makes, as the uid it runs as; each throws the call's error. `fs` is only for a test to take a call away. */
export function createProbeOps(fs = realFs) {
  return {
    readFile: (path) => fs.closeSync(fs.openSync(path, "r")),
    list: (path) => {
      fs.readdirSync(path);
    },
    kind: (path) => {
      const st = fs.statSync(path);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    },
    /* Creates a file of its own in the directory and tries to remove it again. The create is the write: it worked, so the directory is writable whether or not the cleanup does. */
    createIn: (dir) => {
      const path = join(dir, `.qa-file-boundary-probe-${process.pid}-${randomBytes(6).toString("hex")}`);
      fs.closeSync(fs.openSync(path, "wx", 0o600));
      try {
        fs.unlinkSync(path);
      } catch {
        /* the boundary is already breached; the leftover file is the lesser matter */
      }
    },
    /* Opens an existing file for writing and closes it: no byte of it changes. */
    openForWrite: (path) => fs.closeSync(fs.openSync(path, "r+")),
  };
}

export const realOps = createProbeOps();

function codeOf(action) {
  try {
    action();
    return null;
  } catch (err) {
    return typeof err?.code === "string" ? err.code : "unknown";
  }
}

/* A write first asks what the path is: a directory is written by creating a file in it, a file by opening it for writing, anything else is not tried. */
export function observeProbe(probe, ops = realOps) {
  if (probe.kind === "read") return { code: codeOf(() => ops.readFile(probe.path)) };
  if (probe.kind === "list") return { code: codeOf(() => ops.list(probe.path)) };
  let kind;
  const statCode = codeOf(() => {
    kind = ops.kind(probe.path);
  });
  if (statCode !== null) return { code: statCode };
  if (kind === "dir") return { kind, code: codeOf(() => ops.createIn(probe.path)) };
  if (kind === "file") return { kind, code: codeOf(() => ops.openForWrite(probe.path)) };
  return { kind: "other", code: null };
}

export function observeProbes(probes, ops = realOps) {
  return probes.map((probe) => observeProbe(probe, ops));
}

/* The planned attempts, or undefined when the text is not a list of them. */
export function parsePlan(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const probes = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" || !["read", "list", "write"].includes(entry.kind)) return undefined;
    probes.push({ kind: entry.kind, path: entry.path });
  }
  return probes;
}

function main() {
  const probes = parsePlan(readFileSync(0, "utf8"));
  if (!probes) return 2;
  process.stdout.write(JSON.stringify(observeProbes(probes)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
