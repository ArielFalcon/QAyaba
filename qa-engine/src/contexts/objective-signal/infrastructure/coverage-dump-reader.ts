/* Coverage dump readers. Fail-open: absent or corrupt files degrade to [] — never throw. An empty report is unmeasured → unknown → never blocks publish. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { V8DumpFile } from "./v8-browser-coverage.adapter.ts";
import type { CoverageFile } from "./lcov-coverage.adapter.ts";
import type { IstanbulFile } from "./c8-coverage.adapter.ts";
import type { JacocoFile } from "./jacoco-coverage.adapter.ts";

export async function readV8Dumps(e2eDir: string, namespace: string): Promise<V8DumpFile[]> {
  const dir = join(e2eDir, ".qa", "coverage", namespace);
  if (!existsSync(dir)) return [];
  const out: V8DumpFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      out.push({ path, entries: Array.isArray(parsed) ? parsed : [] });
    } catch {
      /* Corrupt dump — skip it, never throw (fail-open). */
      continue;
    }
  }
  return out;
}

export async function readLcovFiles(repoDir: string, _namespace: string): Promise<CoverageFile[]> {
  const lcovPaths = ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"];
  for (const rel of lcovPaths) {
    const p = join(repoDir, rel);
    if (existsSync(p)) return [{ path: p, text: readFileSync(p, "utf8") }];
  }
  return [];
}

export async function readIstanbulFiles(repoDir: string, _namespace: string): Promise<IstanbulFile[]> {
  const p = join(repoDir, "coverage", "coverage-final.json");
  if (!existsSync(p)) return [];
  try {
    return [{ path: p, json: JSON.parse(readFileSync(p, "utf8")) }];
  } catch {
    /* corrupt report — degrade to [], never throw (fail-open). */
    return [];
  }
}

export async function readJacocoFiles(repoDir: string, _namespace: string): Promise<JacocoFile[]> {
  const jacocoPaths = [
    "target/site/jacoco/jacoco.xml",
    "build/reports/jacoco/test/jacocoTestReport.xml",
    "target/jacoco.xml",
  ];
  for (const rel of jacocoPaths) {
    const p = join(repoDir, rel);
    if (existsSync(p)) return [{ path: p, text: readFileSync(p, "utf8") }];
  }
  return [];
}
