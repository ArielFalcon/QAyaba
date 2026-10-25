/*
 * A benchmark dataset (config/benchmarks/datasets/<name>@<version>.json): the commits a campaign replays, versioned by file name.
 *
 * `description` is metadata for people and is NEVER sent to a run (docs/observability-design.md section 14): an item that needs focused
 * guidance declares an explicit `guidance` and runs in `manual` mode. Pure; the file system is the loader's business.
 */

import { RUN_MODES, type RunMode } from "@kernel/run-mode.ts";

export const DATASET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DATASET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
export const MAX_GUIDANCE_CHARS = 2000;
export const MAX_DATASET_ITEMS = 500;

export interface DatasetItem {
  readonly app: string;
  readonly sha: string;
  /* Metadata only. */
  readonly description: string;
  readonly guidance?: string;
  readonly mode: RunMode;
}

export interface BenchmarkDataset {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly items: readonly DatasetItem[];
}

export class DatasetError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, where: string, max = 2000): string {
  if (typeof value !== "string" || value.trim() === "") throw new DatasetError(`${where} must be a non-empty string`);
  if (value.length > max) throw new DatasetError(`${where} is longer than ${max} characters`);
  return value;
}

function parseItem(raw: unknown, index: number): DatasetItem {
  const where = `items[${index}]`;
  if (!isRecord(raw)) throw new DatasetError(`${where} must be an object`);
  const known = new Set(["app", "sha", "description", "guidance", "mode"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new DatasetError(`${where} has an unknown field '${key}'`);
  const app = text(raw.app, `${where}.app`, 100);
  const sha = text(raw.sha, `${where}.sha`, 40);
  if (!SHA_PATTERN.test(sha)) throw new DatasetError(`${where}.sha must be 7-40 hex characters`);
  const description = text(raw.description, `${where}.description`);
  const guidance = raw.guidance === undefined ? undefined : text(raw.guidance, `${where}.guidance`, MAX_GUIDANCE_CHARS);
  let mode: RunMode;
  if (raw.mode === undefined) {
    mode = guidance !== undefined ? "manual" : "diff";
  } else {
    if (typeof raw.mode !== "string" || !(RUN_MODES as readonly string[]).includes(raw.mode)) throw new DatasetError(`${where}.mode must be one of ${RUN_MODES.join(", ")}`);
    mode = raw.mode as RunMode;
  }
  if (guidance !== undefined && mode !== "manual") throw new DatasetError(`${where} declares guidance, which only a manual run uses; its mode is '${mode}'`);
  return { app, sha, description, ...(guidance !== undefined ? { guidance } : {}), mode };
}

/* Validates a parsed JSON document. `expected` is the name and version the file name promises; the content must agree with it. */
export function parseDataset(raw: unknown, expected?: { name: string; version: string }): BenchmarkDataset {
  if (!isRecord(raw)) throw new DatasetError("a dataset must be an object");
  const name = text(raw.name, "name", 64);
  const version = text(raw.version, "version", 32);
  if (!DATASET_NAME_PATTERN.test(name)) throw new DatasetError(`name '${name}' must match ${DATASET_NAME_PATTERN}`);
  if (!DATASET_VERSION_PATTERN.test(version)) throw new DatasetError(`version '${version}' must match ${DATASET_VERSION_PATTERN}`);
  if (expected && (expected.name !== name || expected.version !== version)) throw new DatasetError(`the file is ${expected.name}@${expected.version} but its content says ${name}@${version}`);
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new DatasetError("items must be a non-empty array");
  if (raw.items.length > MAX_DATASET_ITEMS) throw new DatasetError(`a dataset has at most ${MAX_DATASET_ITEMS} items`);
  const items = raw.items.map(parseItem);
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = JSON.stringify([item.app, item.sha.toLowerCase(), item.mode, item.guidance ?? null]);
    if (seen.has(key)) throw new DatasetError(`items[${i}] repeats an earlier item (same app, sha, mode and guidance)`);
    seen.add(key);
  });
  const description = raw.description === undefined ? undefined : text(raw.description, "description");
  return { name, version, ...(description !== undefined ? { description } : {}), items };
}


export function datasetFileName(name: string, version: string): string {
  return `${name}@${version}.json`;
}

/* `name@version` from a file name, or undefined when the name does not follow the convention. */
export function parseDatasetFileName(file: string): { name: string; version: string } | undefined {
  const m = /^(.+)@(.+)\.json$/.exec(file);
  if (!m || !DATASET_NAME_PATTERN.test(m[1]!) || !DATASET_VERSION_PATTERN.test(m[2]!)) return undefined;
  return { name: m[1]!, version: m[2]! };
}
