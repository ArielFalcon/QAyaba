/* src/contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts CoverageCollectorPort over lcov. The missing DI seam: the file read is injected (no hard-coded readFileSync), so this is unit-testable without disk and fail-open by contract (no files → empty report, never a throw). */
import { isAbsolute, relative } from "node:path";
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

export interface CoverageFile { path: string; text: string; }
type ReadLcovFiles = (specDir: string, namespace: string) => Promise<CoverageFile[]>;
type ParseLcov = (text: string, repoDir?: string) => Map<string, Set<number>>;

export class LcovCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readFiles: ReadLcovFiles,
    private readonly repoDir: string,
    private readonly parse: ParseLcov = defaultParseLcov,
  ) {}

  async collect(specDir: string, namespace: string): Promise<CoverageReport> {
    const files = await this.readFiles(specDir, namespace);
    const merged = new Map<string, Set<number>>();
    for (const f of files) {
      for (const [file, lines] of this.parse(f.text, this.repoDir)) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

function normalizeRepoPath(p: string, repoDir?: string): string {
  let out = p.replace(/\\/g, "/").trim();
  if (repoDir) {
    const root = repoDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (isAbsolute(out) && out.startsWith(root + "/")) out = out.slice(root.length + 1);
    else if (isAbsolute(out)) {
      const rel = relative(repoDir, p).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..")) out = rel;
    }
  }
  return out.replace(/^\.\//, "").replace(/^\/+/, "");
}

export function defaultParseLcov(text: string, repoDir?: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = normalizeRepoPath(line.slice(3).trim(), repoDir);
      if (!out.has(file)) out.set(file, new Set());
    } else if (line.startsWith("DA:") && file) {
      const [lnStr, hitsStr] = line.slice(3).split(",");
      const ln = Number(lnStr); const hits = Number(hitsStr);
      if (Number.isFinite(ln) && hits > 0) out.get(file)!.add(ln);
    } else if (line.startsWith("end_of_record")) {
      file = null;
    }
  }
  return out;
}
