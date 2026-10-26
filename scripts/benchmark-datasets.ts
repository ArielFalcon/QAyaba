/*
 * Loads a benchmark dataset from config/benchmarks/datasets/<name>@<version>.json and validates it
 * (qa-engine/src/contexts/evaluation/domain/benchmark-dataset.ts). A campaign replays the dataset's items; an item's `description`
 * is metadata and is never sent to a run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetError, datasetFileName, parseDataset, parseDatasetFileName, type BenchmarkDataset } from "@contexts/evaluation/application/index.ts";

export const DATASETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "benchmarks", "datasets");

export interface DatasetFiles {
  read(path: string): string;
  list(dir: string): string[];
}

const realFiles: DatasetFiles = { read: (path) => readFileSync(path, "utf8"), list: (dir) => readdirSync(dir) };

/* `real-failures@2` (a name and a version) to its parts. */
export function parseDatasetRef(ref: string): { name: string; version: string } {
  const at = ref.lastIndexOf("@");
  if (at < 1 || at === ref.length - 1) throw new DatasetError(`a dataset is named <name>@<version>, got '${ref}'`);
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

export function loadDataset(ref: string, dir: string = DATASETS_DIR, files: DatasetFiles = realFiles): BenchmarkDataset {
  const { name, version } = parseDatasetRef(ref);
  const file = datasetFileName(name, version);
  if (parseDatasetFileName(file) === undefined) throw new DatasetError(`'${ref}' is not a valid dataset name and version`);
  let text: string;
  try {
    text = files.read(join(dir, file));
  } catch {
    throw new DatasetError(`dataset ${ref} not found: ${join(dir, file)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DatasetError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseDataset(raw, { name, version });
  } catch (err) {
    throw new DatasetError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* The dataset files in the directory, by name@version. Files that do not follow the convention are ignored. */
export function listDatasets(dir: string = DATASETS_DIR, files: DatasetFiles = realFiles): string[] {
  return files
    .list(dir)
    .map((f) => parseDatasetFileName(f))
    .filter((p): p is { name: string; version: string } => p !== undefined)
    .map((p) => `${p.name}@${p.version}`)
    .sort();
}
