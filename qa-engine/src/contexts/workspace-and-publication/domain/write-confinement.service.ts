
/** Code-target denylist: paths (or glob patterns) the agent must NOT write. e2e-target uses an allowlist (only `e2e/` is permitted), not this list. `.git/` is intentionally NOT listed: git status never reports paths inside `.git/`, so a denylist entry for it would be dead — `.git/` is hardened separately via core.hooksPath. HONESTY: the `.env*` entries only catch a secret write that is NOT git-ignored — git status (the only input) omits git-ignored paths, and `.env*` is git-ignored in most repos. The publish exclude (CODE_EXCLUDES + e2e add, publish.ts) is the actual guard against committing a secret; these entries are defense-in-depth. See the module header. */
export const CONFINEMENT_DENYLIST: string[] = [
  ".env",
  ".env.*",
  "*.env",
  ".github/",
  "Dockerfile",
  "docker-compose*",
  ".gitattributes",
  ".gitmodules",
];

export interface ParsedChange {
  xy: string;
  path: string;
  renameCounterpart?: string;
}

export interface ClassifiedStrays {
  tracked: string[];
  untracked: string[];
  dangerousByPath: string[];
}

export interface GitRename {
  from: string;
  to: string;
}

export interface UnstagedRenamePairing {
  restore: string[];
}

const SIMPLE_ESCAPES: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

export class WriteConfinementService {
  private decodeQuotedSegment(inner: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i] ?? "";
      if (ch !== "\\") {
        const codePoint = inner.codePointAt(i) as number;
        bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
        if (codePoint > 0xffff) i += 1;
        continue;
      }
      const octal = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        i += 3;
        continue;
      }
      const next = inner[i + 1];
      if (next !== undefined && next in SIMPLE_ESCAPES) {
        bytes.push(SIMPLE_ESCAPES[next] as number);
        i += 1;
        continue;
      }
      /* Unrecognized escape shape — no known git C-style-quoting escape starts this way. Fail LOUDLY (CLAUDE.md invariant "surface integration errors loudly — never swallow errors into an empty/degraded result") instead of silently keeping the bare backslash, which would hand a corrupted path to the revert git calls and reproduce the same revert-matches-nothing silent bypass this function exists to prevent. enforce()'s caller (RunQaUseCase's enforceConfinement wrapper) already catches, logs loudly, and records this in gateSignals — a throw here is fault-isolated, never a run crash. */
      throw new Error(
        `decodeQuoted: unrecognized escape sequence starting at ${JSON.stringify(inner.slice(i, i + 4))} in quoted path segment ${JSON.stringify(inner)}`,
      );
    }
    return Buffer.from(bytes).toString("utf8");
  }

  decodeGitPath(raw: string): string {
    return raw.startsWith('"') && raw.endsWith('"') ? this.decodeQuotedSegment(raw.slice(1, -1)) : raw;
  }

  pairUnstagedRenames(deleted: string[], strays: string[], gitRenames: GitRename[]): UnstagedRenamePairing {
    const deletedSet = new Set(deleted);
    const straySet = new Set(strays);
    const restore = new Set<string>();
    for (const { from, to } of gitRenames) {
      if (deletedSet.has(from) && straySet.has(to)) restore.add(from);
    }
    return { restore: [...restore] };
  }

  parseStatusOutput(out: string): ParsedChange[] {
    const findArrowSplit = (rest: string): number => {
      if (rest[0] === '"') {
        let i = 1;
        while (i < rest.length) {
          if (rest[i] === "\\") {
            i += 2;
            continue;
          }
          if (rest[i] === '"') break;
          i++;
        }
        if (i < rest.length && rest.startsWith(" -> ", i + 1)) return i + 1;
      }
      return rest.indexOf(" -> ");
    };
    return out
      .split("\n")
      .filter((l) => l.length > 3)
      .flatMap((l): ParsedChange[] => {
        const xy = l.slice(0, 2);
        const rest = l.slice(3);
        if (xy[0] === "R" || xy[0] === "C") {
          const arrowIdx = findArrowSplit(rest);
          if (arrowIdx !== -1) {
            const oldPath = this.decodeGitPath(rest.slice(0, arrowIdx));
            const newPath = this.decodeGitPath(rest.slice(arrowIdx + 4));
            return [
              { xy, path: oldPath, renameCounterpart: newPath },
              { xy, path: newPath, renameCounterpart: oldPath },
            ];
          }
        }
        return [{ xy, path: this.decodeGitPath(rest) }];
      });
  }

  isE2eStray(path: string): boolean {
    return path !== "e2e" && !path.startsWith("e2e/");
  }

  isCodeDenied(path: string): boolean {
    /* The backslash→slash normalization is defensive-only: git status output (the only caller's input) is already forward-slashed, so it is a guard for non-git callers, never hit on-path. Lowercase BOTH sides: on a case-insensitive host (.ENV, DOCKERFILE, .GitHub/) the OS treats them as the same file, so the denylist must match them too — comparing raw would let them slip. */
    const f = path.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
    return CONFINEMENT_DENYLIST.some((entry) => {
      const p = entry.toLowerCase();
      if (p === ".env.*") return f.startsWith(".env.");
      if (p.startsWith("*")) return f.endsWith(p.slice(1));
      if (p.endsWith("/")) return f.startsWith(p); /* directory prefix: .github/ */
      if (p.endsWith("*")) return f.startsWith(p.slice(0, -1));
      return f === p;
    });
  }

  /* True when the path meets the dangerous tier: a secret-file write (.env exact, .env. prefix, or a name ending in .env). Applies regardless of run target. .git/ is not a case here — git status never surfaces paths inside .git/; hook RCE is hardened separately via core.hooksPath. */
  isDangerousPath(path: string): boolean {
    const f = path.replace(/\\/g, "/").toLowerCase();
    return f === ".env" || f.startsWith(".env.") || f.endsWith(".env");
  }

  revertUnit(path: string, renameCounterpart?: string): string[] {
    return renameCounterpart !== undefined ? [path, renameCounterpart] : [path];
  }

  classifyStrays(changes: ParsedChange[], isCode: boolean): ClassifiedStrays {
    const isStray = isCode ? this.isCodeDenied.bind(this) : this.isE2eStray.bind(this);
    const tracked: string[] = [];
    const untracked: string[] = [];
    const dangerousByPath: string[] = [];
    const renameHandled = new Set<string>();

    for (const { xy, path, renameCounterpart } of changes) {
      if (renameCounterpart !== undefined) {
        if (renameHandled.has(path)) continue;
        renameHandled.add(path);
        renameHandled.add(renameCounterpart);
        if (isStray(path) || isStray(renameCounterpart)) {
          for (const p of this.revertUnit(path, renameCounterpart)) {
            tracked.push(p);
            if (this.isDangerousPath(p)) dangerousByPath.push(p);
          }
        }
        continue;
      }

      if (!isStray(path)) continue;
      if (xy === "??") {
        untracked.push(path);
      } else {
        tracked.push(path);
      }
      if (this.isDangerousPath(path)) dangerousByPath.push(path);
    }

    return { tracked, untracked, dangerousByPath };
  }
}
