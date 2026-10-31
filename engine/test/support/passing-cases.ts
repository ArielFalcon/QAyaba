import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { QaCase } from "@kernel/qa-case.ts";

const specFilesUnder = (root: string, rel = ""): string[] =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) return specFilesUnder(root, path);
    return entry.name.endsWith(".spec.ts") ? [path] : [];
  });

/**
 * The cases a passing Playwright run reports: one passing case for each spec file it ran, each naming its file as every report does.
 * The files are the ones the run was asked for, else the suite's own on disk. A run over a directory with no spec reports one case
 * that names no file, as a run that delivered nothing does.
 */
export function passingCases(specDir: string | undefined, opts?: unknown): QaCase[] {
  const asked = typeof opts === "object" && opts !== null && "specFiles" in opts ? (opts.specFiles as readonly string[] | undefined) : undefined;
  const files = asked ?? (specDir !== undefined && existsSync(specDir) ? specFilesUnder(specDir) : []);
  return files.length === 0 ? [{ name: "runs", status: "pass" }] : files.map((file) => ({ name: `${file} › runs`, status: "pass", expectedStatus: "passed", file }));
}
