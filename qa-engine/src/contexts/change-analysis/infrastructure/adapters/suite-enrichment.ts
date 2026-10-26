/*
 * What the suite already holds, for the candidates: the manifest's entries and the text of the spec files. The suite directory
 * is written by the agent, so every read goes through the confined reader (a link or a pipe is refused, sizes are capped) and
 * a read that fails is no enrichment, never an error.
 */
import { MANIFEST_FILE, MAX_MANIFEST_BYTES } from "@kernel/manifest/manifest-entry.ts";
import { listSpecFiles, readConfinedSpecFile, readOwnedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import type { CandidateEnrichment } from "../../domain/use-case-candidate.ts";

/* The most spec files read for their text, and the most of each: a candidate's existing specs are found among the first of a large suite. */
export const MAX_SUITE_FILES_READ = 400;
export const MAX_SUITE_FILE_BYTES = 256 * 1024;

export function readManifestTargets(specDir: string): NonNullable<CandidateEnrichment["manifest"]> {
  try {
    const read = readOwnedSpecFile({ mirrorDir: specDir, specDir }, MANIFEST_FILE, MAX_MANIFEST_BYTES);
    if (!("bytes" in read)) return [];
    const parsed: unknown = JSON.parse(read.bytes.toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      const e = entry as { file?: unknown; useCase?: unknown; objective?: unknown; targets?: unknown };
      if (!e || typeof e !== "object" || !Array.isArray(e.targets)) return [];
      return [{
        ...(typeof e.file === "string" ? { file: e.file } : {}),
        ...(typeof e.useCase === "string" ? { useCase: e.useCase } : {}),
        ...(typeof e.objective === "string" ? { objective: e.objective } : {}),
        targets: e.targets.filter((t): t is string => typeof t === "string"),
      }];
    });
  } catch {
    return [];
  }
}

export function readSuiteTexts(specDir: string): NonNullable<CandidateEnrichment["suiteFiles"]> {
  const out: Array<{ file: string; text: string }> = [];
  try {
    for (const file of listSpecFiles(specDir).slice(0, MAX_SUITE_FILES_READ)) {
      try {
        out.push({ file, text: readConfinedSpecFile({ mirrorDir: specDir, specDir }, file, MAX_SUITE_FILE_BYTES) });
      } catch {
        /* a file the strict reader refuses holds no evidence */
      }
    }
  } catch {
    return out;
  }
  return out;
}
