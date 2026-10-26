/*
 * ValidationPort decorator that keeps the text of the specs a run delivered when it validates them (docs/observability-design.md §11.1): every
 * validation looks at the suite as it stands, so a spec rewritten by a static-fix round or a regeneration is snapshotted in its new bytes too
 * (the snapshot key includes the bytes' hash, so an unchanged spec is stored once).
 *
 * Which specs were delivered is the run's to say: the use case passes the paths its generators reported (`run.deliveredSpecs`), and a spec the
 * run did not deliver (the suite restored from the store, the specs already in git) is not kept. When the run reports none, nothing is kept: the
 * set is never guessed from the directory.
 *
 * The directory is where the agent writes, so the listing and every read go through the confined reader: nothing is followed, a pipe is never
 * waited on and a file over the reader's cap is left out. The text is taken through the run's secrets by value and then the outbound sanitizer,
 * and is capped; the hash is of the bytes as read. A (path, bytes) pair already kept in this process is skipped before any text is made, and a run
 * keeps at most MAX_SPEC_SNAPSHOT_BYTES_PER_RUN of text.
 *
 * Never blocks or fails a run: the validation result is returned as it was, and a fault here is logged and ignored.
 */

import { createHash } from "node:crypto";
import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { redactByValue } from "../../../../shared-infrastructure/run-secret-redaction.ts";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile, scanSpecTree } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { MAX_SPEC_SNAPSHOTS_PER_CAPTURE, MAX_SPEC_SNAPSHOT_BYTES_PER_RUN, MAX_SPEC_SNAPSHOT_TEXT_BYTES, type SpecSnapshot, type SpecSnapshotPort } from "@kernel/ports/spec-snapshot.port.ts";
import type { ValidationPort, ValidationRunInfo } from "@contexts/qa-run-orchestration/application/index.ts";

/* How many runs' kept specs a port remembers. */
export const MAX_REMEMBERED_RUNS = 4;

export interface SpecSnapshotDeps {
  port: SpecSnapshotPort;
  /* The outbound sanitizer (data leaving the system). Injected: the engine never imports the shell. */
  sanitize: (text: string) => string;
  /* Wall-clock ms. */
  now?: () => number;
}

/* What a run has kept so far: the (path, bytes) pairs, and the text bytes. */
interface RunKept {
  seen: Set<string>;
  textBytes: number;
}

function cappedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_SPEC_SNAPSHOT_TEXT_BYTES) return text;
  /* Cut on a whole character: a partial sequence at the end is dropped. */
  return bytes.subarray(0, MAX_SPEC_SNAPSHOT_TEXT_BYTES).toString("utf8").replace(/�+$/, "");
}

/* The snapshots of the delivered specs as they stand, within what the run may still keep. */
export function snapshotSpecs(specDir: string, runId: string, delivered: readonly string[], deps: SpecSnapshotDeps, kept: RunKept = { seen: new Set(), textBytes: 0 }): SpecSnapshot[] {
  const wanted = new Set(delivered.map(normalizeSpecPath));
  if (wanted.size === 0) return [];
  const root = { mirrorDir: specDir, specDir };
  const capturedAt = (deps.now ?? Date.now)();
  const out: SpecSnapshot[] = [];
  /* Sorted before it is cut, so that which specs are kept does not depend on the order the directory lists them in. */
  const listed = scanSpecTree(specDir).specs.map(normalizeSpecPath).sort().filter((rel) => wanted.has(rel)).slice(0, MAX_SPEC_SNAPSHOTS_PER_CAPTURE);
  for (const rel of listed) {
    let read;
    try {
      read = readOwnedSpecFile(root, rel, MAX_SPEC_SOURCE_BYTES);
    } catch {
      continue;
    }
    if (!("bytes" in read)) continue;
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    const key = `${rel}\0${sha256}`;
    if (kept.seen.has(key)) continue;
    const text = cappedText(deps.sanitize(redactByValue(read.bytes.toString("utf8"))));
    const size = Buffer.byteLength(text, "utf8");
    if (kept.textBytes + size > MAX_SPEC_SNAPSHOT_BYTES_PER_RUN) continue;
    kept.seen.add(key);
    kept.textBytes += size;
    out.push({ runId, path: rel, sha256, text, bytes: read.bytes.length, capturedAt, delivered: true });
  }
  return out;
}

export class SpecSnapshotValidationPort implements ValidationPort {
  /* The runs this port has kept specs for, newest last. A run is over long before the next few begin, so only the last few are remembered (a run that returns to a forgotten entry only re-keeps its specs). */
  private readonly keptByRun = new Map<string, RunKept>();

  constructor(
    private readonly inner: ValidationPort,
    private readonly deps: SpecSnapshotDeps,
  ) {}

  async validate(specDir: string, changedFiles?: string[], run?: ValidationRunInfo): ReturnType<ValidationPort["validate"]> {
    const result = await this.inner.validate(specDir, changedFiles, run);
    this.capture(specDir, run);
    return result;
  }

  async autofix(specDir: string, run: ValidationRunInfo): Promise<string[]> {
    return (await this.inner.autofix?.(specDir, run)) ?? [];
  }

  private capture(specDir: string, run: ValidationRunInfo | undefined): void {
    try {
      const runId = activeExecScope()?.runId;
      if (runId === undefined || runId === "") return;
      let kept = this.keptByRun.get(runId);
      if (!kept) {
        kept = { seen: new Set(), textBytes: 0 };
        this.keptByRun.set(runId, kept);
        while (this.keptByRun.size > MAX_REMEMBERED_RUNS) this.keptByRun.delete(this.keptByRun.keys().next().value as string);
      }
      const snapshots = snapshotSpecs(specDir, runId, run?.deliveredSpecs ?? [], this.deps, kept);
      if (snapshots.length > 0) this.deps.port.record(snapshots);
    } catch (err) {
      console.error(`[qa] spec snapshots could not be kept (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
