/* The file boundary of the execution sandbox, proven instead of assumed. Dropping to the sandbox uid keeps agent code away from the orchestrator's secrets, code and config only where the filesystem enforces permissions, and not every one does: a bind mount of Docker Desktop's file sharing (`fakeowner`) grants every uid whatever it asks, so a mode set at boot says nothing there. At every boot the container therefore tries, as the sandbox uid, everything that uid must not be able to do, and the service refuses agent code when one attempt succeeds.

   What is tried is planned here from the layout the composition root passes (the secret files, the directories that must stay closed, the paths that must stay unwritable) and from the mount table: every mount at or under the app root must refuse a write, so a bind added to the container later is checked without anyone listing it. The probes run in a child of that uid (src/server/file-boundary-check.ts) and report raw outcomes; the judgment is made here, by the orchestrator, and fails closed: an attempt with no result, or an error that proves nothing, is not a pass. */

import { closeSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface FileBoundaryLayout {
  /* The orchestrator's root: it and every mount under it must refuse a write. */
  appRoot: string;
  /* Files the sandbox uid must not read: the service's environment, the API token. */
  secretFiles: readonly string[];
  /* Directories it must not list: the data and auth directories, the app configs, the code graph, the mirrors volume. */
  closedDirs: readonly string[];
  /* Paths it must not write besides the mounts: the orchestrator's code and config, the status files the service trusts. */
  unwritable: readonly string[];
}

export type FileBoundaryProbeKind = "read" | "list" | "write";

export interface FileBoundaryProbe {
  kind: FileBoundaryProbeKind;
  path: string;
}

export type FileBoundaryOutcome = "refused" | "absent" | "allowed" | "inconclusive";

export interface FileBoundaryProbeResult {
  probe: FileBoundaryProbe;
  outcome: FileBoundaryOutcome;
  /* The error code of an inconclusive attempt. */
  code?: string;
}

export type FileBoundaryVerdict = { holds: true } | { holds: false; exposures: string[] };

/* Decodes the octal escapes the kernel writes for a space, a tab, a newline and a backslash in a mountinfo path. */
function unescapeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/* The mount points at or under `root` in /proc/self/mountinfo, in the order the kernel lists them. A line that is not a mountinfo line is skipped. */
export function mountPointsUnder(mountinfo: string, root: string): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const out: string[] = [];
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-")) continue;
    const mountPoint = unescapeMountPath(fields[4]!);
    if ((mountPoint === root || mountPoint.startsWith(prefix)) && !out.includes(mountPoint)) out.push(mountPoint);
  }
  return out;
}

/* Every attempt the boot check makes, each path once per kind. */
export function planFileBoundaryProbes(layout: FileBoundaryLayout, mounts: readonly string[]): FileBoundaryProbe[] {
  const probes: FileBoundaryProbe[] = [];
  const add = (kind: FileBoundaryProbeKind, path: string): void => {
    if (!probes.some((p) => p.kind === kind && p.path === path)) probes.push({ kind, path });
  };
  for (const path of layout.secretFiles) add("read", path);
  for (const path of layout.closedDirs) add("list", path);
  add("write", layout.appRoot);
  for (const path of mounts) add("write", path);
  for (const path of layout.unwritable) add("write", path);
  return probes;
}

/* The filesystem calls a probe makes, as the uid it runs as; each throws the call's error. */
export interface FileBoundaryProbeOps {
  readFile(path: string): void;
  list(path: string): void;
  kind(path: string): "dir" | "file" | "other";
  /* Creates a file of its own in the directory and removes it again. */
  createIn(dir: string): void;
  /* Opens an existing file for writing and closes it: no byte of it changes. */
  openForWrite(path: string): void;
}

export const realFileBoundaryProbeOps: FileBoundaryProbeOps = {
  readFile: (path) => closeSync(openSync(path, "r")),
  list: (path) => {
    readdirSync(path);
  },
  kind: (path) => {
    const st = statSync(path);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  },
  createIn: (dir) => {
    const path = join(dir, `.qa-file-boundary-probe-${process.pid}-${randomBytes(6).toString("hex")}`);
    closeSync(openSync(path, "wx", 0o600));
    unlinkSync(path);
  },
  openForWrite: (path) => closeSync(openSync(path, "r+")),
};

const REFUSED = new Set(["EACCES", "EPERM", "EROFS"]);
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

function attempt(action: () => void): Omit<FileBoundaryProbeResult, "probe"> {
  try {
    action();
    return { outcome: "allowed" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    if (REFUSED.has(code)) return { outcome: "refused" };
    if (ABSENT.has(code)) return { outcome: "absent" };
    return { outcome: "inconclusive", code };
  }
}

/* Makes every attempt with `ops` and reports what each came to. A write first asks what the path is: a directory is written by creating a file in it, a file by opening it for writing, anything else proves nothing. */
export function runFileBoundaryProbes(probes: readonly FileBoundaryProbe[], ops: FileBoundaryProbeOps = realFileBoundaryProbeOps): FileBoundaryProbeResult[] {
  return probes.map((probe) => {
    if (probe.kind === "read") return { probe, ...attempt(() => ops.readFile(probe.path)) };
    if (probe.kind === "list") return { probe, ...attempt(() => ops.list(probe.path)) };
    const kinds: Array<"dir" | "file" | "other"> = [];
    const found = attempt(() => {
      kinds.push(ops.kind(probe.path));
    });
    if (found.outcome !== "allowed") return { probe, ...found };
    const kind = kinds[0];
    if (kind === "dir") return { probe, ...attempt(() => ops.createIn(probe.path)) };
    if (kind === "file") return { probe, ...attempt(() => ops.openForWrite(probe.path)) };
    return { probe, outcome: "inconclusive", code: "not a file or a directory" };
  });
}

const OUTCOMES: readonly FileBoundaryOutcome[] = ["refused", "absent", "allowed", "inconclusive"];

/* The outcomes the probing child printed, one per planned attempt and in its order (it prints `runFileBoundaryProbes` without the probes). Anything that is not exactly that is no report at all, which the judgment takes as attempts that were not made. */
export function readProbeReport(probes: readonly FileBoundaryProbe[], text: string): FileBoundaryProbeResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length !== probes.length) return [];
  const results: FileBoundaryProbeResult[] = [];
  for (const [i, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) return [];
    const { outcome, code } = entry as { outcome?: unknown; code?: unknown };
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as FileBoundaryOutcome)) return [];
    results.push({ probe: probes[i]!, outcome: outcome as FileBoundaryOutcome, ...(typeof code === "string" ? { code: code.slice(0, 80) } : {}) });
  }
  return results;
}

const VERB: Record<FileBoundaryProbeKind, string> = { read: "readable", list: "listable", write: "writable" };

/* Holds only when every planned attempt was refused or found nothing there. */
export function judgeFileBoundary(probes: readonly FileBoundaryProbe[], results: readonly FileBoundaryProbeResult[]): FileBoundaryVerdict {
  const exposures: string[] = [];
  for (const probe of probes) {
    const result = results.find((r) => r.probe.kind === probe.kind && r.probe.path === probe.path);
    if (!result) exposures.push(`${probe.path} was not checked (${probe.kind})`);
    else if (result.outcome === "allowed") exposures.push(`${probe.path} is ${VERB[probe.kind]} by the sandbox uid`);
    else if (result.outcome === "inconclusive") exposures.push(`${probe.path} could not be checked (${result.code ?? "unknown"}) for ${probe.kind}`);
  }
  return exposures.length === 0 ? { holds: true } : { holds: false, exposures };
}

const STATUS_OK = "ok";
const STATUS_BREACH = "breach: ";
const MAX_REASON_CHARS = 1500;

/* The one line the boot check leaves for the service. */
export function formatFileBoundaryStatus(verdict: FileBoundaryVerdict): string {
  if (verdict.holds) return `${STATUS_OK}\n`;
  const kept: string[] = [];
  let length = 0;
  for (const exposure of verdict.exposures) {
    if (length + exposure.length + 2 > MAX_REASON_CHARS) break;
    kept.push(exposure);
    length += exposure.length + 2;
  }
  const left = verdict.exposures.length - kept.length;
  const reason = left > 0 ? `${kept.join("; ")}; (${left} more)` : kept.join("; ");
  return `${STATUS_BREACH}${reason.replace(/[\r\n]+/g, " ")}\n`;
}

/* What the service makes of the status file: `ok` holds; a missing, empty or unknown status does not, since the check did not say it holds. */
export function parseFileBoundaryStatus(text: string | undefined): { holds: boolean; reason?: string } {
  if (text === undefined) return { holds: false, reason: "no boot check result: the file boundary was never checked on this host" };
  const line = text.trim();
  if (line === STATUS_OK) return { holds: true };
  if (line.startsWith(STATUS_BREACH) && line.length > STATUS_BREACH.length) return { holds: false, reason: line.slice(STATUS_BREACH.length) };
  return { holds: false, reason: "the boot check left a status that does not say the boundary holds" };
}
