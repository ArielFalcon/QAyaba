/* The file boundary of the execution sandbox, proven instead of assumed. Dropping to the sandbox uid keeps agent code away from the orchestrator's secrets, code and config only where the filesystem enforces permissions, and not every one does: a bind mount of Docker Desktop's file sharing (`fakeowner`) grants every uid whatever it asks, so a mode set at boot says nothing there. At every boot the container therefore tries, as the sandbox uid, everything that uid must not be able to do, and the service refuses agent code when one attempt succeeds.

   What is tried is planned here from the layout the composition root passes (the secret files, the directories that must stay closed, the paths that must stay unwritable) and from the mount table: every mount at or under the app root must refuse a write, so a bind added to the container later is checked without anyone listing it. The probes run in a child of that uid (src/server/file-boundary-probe.mjs, plain JavaScript: nothing it loads is a transform or a cache the uid could have planted) and report only what each system call answered; what that means is decided here, by the orchestrator, and fails closed: an attempt with no result, or an error that proves nothing, is not a pass. */

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

const REFUSED = new Set(["EACCES", "EPERM", "EROFS"]);
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const MAX_CODE_CHARS = 80;

/* What the child saw of one attempt, raw: the error code of the system call (null when it succeeded). A write first asks what the path is, so it also says what it found: a directory is written by creating a file in it, a file by opening it for writing, anything else is not tried; a path that could not be examined has no kind and the code of that failure. */
interface ProbeObservation {
  kind?: "dir" | "file" | "other";
  code: string | null;
}

const KINDS: readonly string[] = ["dir", "file", "other"];

function observationOf(probe: FileBoundaryProbe, entry: unknown): ProbeObservation | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { kind, code } = entry as { kind?: unknown; code?: unknown };
  if (code !== null && typeof code !== "string") return undefined;
  if (probe.kind !== "write") return kind === undefined ? { code } : undefined;
  if (kind === undefined) return code === null ? undefined : { code };
  return typeof kind === "string" && KINDS.includes(kind) ? { kind: kind as ProbeObservation["kind"], code } : undefined;
}

function resultOf(probe: FileBoundaryProbe, { kind, code }: ProbeObservation): FileBoundaryProbeResult {
  if (code === null) return kind === "other" ? { probe, outcome: "inconclusive", code: "not a file or a directory" } : { probe, outcome: "allowed" };
  if (REFUSED.has(code)) return { probe, outcome: "refused" };
  if (ABSENT.has(code)) return { probe, outcome: "absent" };
  return { probe, outcome: "inconclusive", code: code.slice(0, MAX_CODE_CHARS) };
}

/* The observations the probing child printed, one per planned attempt and in its order. Anything that is not exactly that is no report at all, which the judgment takes as attempts that were not made. */
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
    const probe = probes[i]!;
    const observation = observationOf(probe, entry);
    if (!observation) return [];
    results.push(resultOf(probe, observation));
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
