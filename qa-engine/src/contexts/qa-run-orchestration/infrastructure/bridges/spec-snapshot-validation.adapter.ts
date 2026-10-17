/*
 * ValidationPort decorator that keeps the text of the specs a run holds when it validates them (docs/observability-design.md §11.1): every
 * validation looks at the suite as it stands, so a spec rewritten by a static-fix round or a regeneration is snapshotted in its new bytes too
 * (the snapshot key includes the bytes' hash, so an unchanged spec is stored once).
 *
 * What it keeps is the suite directory's `*.spec.ts` files, a superset of the specs this run delivered (the suite restored from the store is
 * there too). The directory is where the agent writes, so the listing and every read go through the confined reader, nothing is followed, a
 * pipe is never waited on and a file over the reader's cap is left out. The text is taken through the run's secrets by value and then the
 * outbound sanitizer, and is capped; the hash is of the bytes as read.
 *
 * Never blocks or fails a run: the validation result is returned as it was, and a fault here is logged and ignored.
 */

import { createHash } from "node:crypto";
import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { redactByValue } from "../../../../shared-infrastructure/run-secret-redaction.ts";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile, scanSpecTree } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { MAX_SPEC_SNAPSHOTS_PER_CAPTURE, MAX_SPEC_SNAPSHOT_TEXT_BYTES, type SpecSnapshot, type SpecSnapshotPort } from "@kernel/ports/spec-snapshot.port.ts";
import type { ValidationPort } from "../../application/ports/index.ts";

export interface SpecSnapshotDeps {
  port: SpecSnapshotPort;
  /* The outbound sanitizer (data leaving the system). Injected: the engine never imports the shell. */
  sanitize: (text: string) => string;
  /* Wall-clock ms. */
  now?: () => number;
}

function cappedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_SPEC_SNAPSHOT_TEXT_BYTES) return text;
  /* Cut on a whole character: a partial sequence at the end is dropped. */
  return bytes.subarray(0, MAX_SPEC_SNAPSHOT_TEXT_BYTES).toString("utf8").replace(/�+$/, "");
}

/* The snapshots of the suite directory as it stands. */
export function snapshotSpecs(specDir: string, runId: string, deps: SpecSnapshotDeps): SpecSnapshot[] {
  const root = { mirrorDir: specDir, specDir };
  const capturedAt = (deps.now ?? Date.now)();
  const out: SpecSnapshot[] = [];
  for (const rel of scanSpecTree(specDir).specs.slice(0, MAX_SPEC_SNAPSHOTS_PER_CAPTURE)) {
    let read;
    try {
      read = readOwnedSpecFile(root, rel, MAX_SPEC_SOURCE_BYTES);
    } catch {
      continue;
    }
    if (!("bytes" in read)) continue;
    const text = cappedText(deps.sanitize(redactByValue(read.bytes.toString("utf8"))));
    out.push({ runId, path: rel, sha256: createHash("sha256").update(read.bytes).digest("hex"), text, bytes: read.bytes.length, capturedAt });
  }
  return out;
}

export class SpecSnapshotValidationPort implements ValidationPort {
  constructor(
    private readonly inner: ValidationPort,
    private readonly deps: SpecSnapshotDeps,
  ) {}

  async validate(specDir: string, changedFiles?: string[]): ReturnType<ValidationPort["validate"]> {
    const result = await this.inner.validate(specDir, changedFiles);
    this.capture(specDir);
    return result;
  }

  private capture(specDir: string): void {
    try {
      const runId = activeExecScope()?.runId;
      if (runId === undefined || runId === "") return;
      const snapshots = snapshotSpecs(specDir, runId, this.deps);
      if (snapshots.length > 0) this.deps.port.record(snapshots);
    } catch (err) {
      console.error(`[qa] spec snapshots could not be kept (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
