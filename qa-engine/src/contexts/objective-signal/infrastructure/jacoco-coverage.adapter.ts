/* src/contexts/objective-signal/infrastructure/jacoco-coverage.adapter.ts CoverageCollectorPort over JaCoCo XML (JVM: Maven/Gradle). The missing DI seam: the file read is injected (no hard-coded readFileSync), so this is unit-testable without disk and fail-open by contract (no files → empty report, never a throw). */
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

export interface JacocoFile { path: string; text: string; }
type ReadJacocoFiles = (specDir: string, namespace: string) => Promise<JacocoFile[]>;
type ParseJacoco = (xml: string, changedFiles: string[]) => Map<string, Set<number>>;

export class JacocoCoverageAdapter implements CoverageCollectorPort {
  constructor(
    private readonly readFiles: ReadJacocoFiles,
    private readonly changedFiles: string[],
    private readonly parse: ParseJacoco = defaultParseJacocoXml,
  ) {}

  async collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport> {
    const files = await this.readFiles(specDir, namespace);
    const changed = changedFiles ?? this.changedFiles;
    const merged = new Map<string, Set<number>>();
    for (const f of files) {
      for (const [file, lines] of this.parse(f.text, changed)) {
        const set = merged.get(file) ?? new Set<number>();
        for (const ln of lines) set.add(ln);
        merged.set(file, set);
      }
    }
    return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
  }
}

function resolveUrlToRepoFile(url: string, changedFiles: string[]): string | null {
  const path = url.replace(/\\/g, "/").replace(/^\/+/, "");
  let best: string | null = null;
  let bestLen = 0;
  for (const f of changedFiles) {
    const nf = f.replace(/\\/g, "/");
    if (path === nf || path.endsWith("/" + nf) || nf.endsWith("/" + path)) {
      const len = Math.min(path.length, nf.length);
      if (len > bestLen) {
        best = f;
        bestLen = len;
      }
    }
  }
  return best;
}

export function defaultParseJacocoXml(xml: string, changedFiles: string[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const pkgRe = /<package\s+name="([^"]*)"\s*>([\s\S]*?)<\/package>/g;
  let pkg: RegExpExecArray | null;
  while ((pkg = pkgRe.exec(xml))) {
    const pkgName = pkg[1]!;
    const sfRe = /<sourcefile\s+name="([^"]*)"\s*>([\s\S]*?)<\/sourcefile>/g;
    let sf: RegExpExecArray | null;
    while ((sf = sfRe.exec(pkg[2]!))) {
      const rel = (pkgName ? pkgName + "/" : "") + sf[1]!;
      const repoFile = resolveUrlToRepoFile(rel, changedFiles);
      if (!repoFile) continue;
      const set = out.get(repoFile) ?? new Set<number>();
      const lineRe = /<line\s+([^>]*?)\/>/g;
      let ln: RegExpExecArray | null;
      while ((ln = lineRe.exec(sf[2]!))) {
        const attrs = ln[1]!;
        const nr = Number(/\bnr="(\d+)"/.exec(attrs)?.[1]);
        const ci = Number(/\bci="(\d+)"/.exec(attrs)?.[1] ?? "0");
        if (Number.isFinite(nr) && ci > 0) set.add(nr);
      }
      if (set.size) out.set(repoFile, set);
    }
  }
  return out;
}
