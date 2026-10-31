/*
 * The reference sets of use cases an operator labelled (`config/benchmarks/use-cases/<app>.json`), read from disk. Shared by the labelling
 * script and the evidence assembly, so both read the same files the same way.
 */
import { appLogger } from "../integrations/redacting-logger";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUseCaseReference, type UseCaseReference } from "@contexts/evaluation/application/index";

export const USE_CASES_DIR = "config/benchmarks/use-cases";

function referenceFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

const parseFile = (dir: string, name: string): UseCaseReference => parseUseCaseReference(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown, name);

/* Every reference set of the directory; a missing directory yields none, and a file that is not a reference set stops the read, naming it. */
export function loadReferences(dir: string = USE_CASES_DIR): UseCaseReference[] {
  return referenceFiles(dir).map((n) => parseFile(dir, n));
}

/* The same read for a caller that must go on: a file that is not a reference set is logged loudly and yields none. */
export function loadReferencesLeniently(dir: string = USE_CASES_DIR, log: (line: string) => void = (line) => appLogger.error(line)): UseCaseReference[] {
  return referenceFiles(dir).flatMap((n) => {
    try {
      return [parseFile(dir, n)];
    } catch (err) {
      log(`[qa] the use case reference ${n} is unreadable and is left out: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });
}
