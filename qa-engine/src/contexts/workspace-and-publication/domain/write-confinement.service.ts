
/* Secret env files. Matched against every path segment, not from the root: as gitignore-style
   publish excludes, a pattern without a slash already reaches any depth, and confinement agrees. */
const ENV_FILE_PATTERNS = [
  // Stryker disable next-line StringLiteral: equivalent — "*.env" denies ".env" as well
  ".env",
  ".env.*",
  "*.env",
];

/* Build, CI and git-metadata files; confinement matches them from the repo root. */
const ROOT_DENYLIST = [".github/", "Dockerfile", "docker-compose*", ".gitattributes", ".gitmodules"];

/** Code-target denylist: paths (or glob patterns) the agent must NOT write. e2e-target uses an allowlist (only `e2e/` is permitted), not this list. `.git/` is intentionally NOT listed: git status never reports paths inside `.git/`, so a denylist entry for it would be dead — `.git/` is hardened separately via core.hooksPath. HONESTY: the `.env*` entries only catch a secret write that is NOT git-ignored — git status (the only input) omits git-ignored paths, and `.env*` is git-ignored in most repos. The publish exclude (CODE_EXCLUDES + e2e add, publish.ts) is the actual guard against committing a secret; these entries are defense-in-depth. See the module header. */
export const CONFINEMENT_DENYLIST: string[] = [...ENV_FILE_PATTERNS, ...ROOT_DENYLIST];

/* Whether one denylist entry denies a normalized, lowercased path. An env-file pattern holds for any
   path segment, gitignore-style; every other entry is matched from the repo root. */
function deniedBy(entry: string, path: string): boolean {
  const pattern = entry.toLowerCase();
  const candidates = ENV_FILE_PATTERNS.includes(entry) ? path.split("/") : [path];
  return candidates.some((candidate) => {
    if (pattern.startsWith("*")) return candidate.endsWith(pattern.slice(1));
    if (pattern.endsWith("/")) return candidate.startsWith(pattern); /* directory prefix: .github/ */
    if (pattern.endsWith("*")) return candidate.startsWith(pattern.slice(0, -1));
    return candidate === pattern;
  });
}

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
      // Stryker disable next-line StringLiteral: equivalent — i < inner.length, so inner[i] is always defined
      const ch = inner[i] ?? "";
      if (ch !== "\\") {
        const codePoint = inner.codePointAt(i) as number;
        bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
        if (codePoint > 0xffff) i += 1;
        continue;
      }
      const octal = inner.slice(i + 1, i + 4);
      // Stryker disable next-line Regex: equivalent — `octal` holds at most three characters, so either anchor alone pins the whole string
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
        // Stryker disable next-line ArithmeticOperator,MethodExpression: message detail only — the message always carries the whole quoted segment
        `decodeQuoted: unrecognized escape sequence starting at ${JSON.stringify(inner.slice(i, i + 4))} in quoted path segment ${JSON.stringify(inner)}`,
      );
    }
    return Buffer.from(bytes).toString("utf8");
  }

  decodeGitPath(raw: string): string {
    // Stryker disable next-line LogicalOperator,MethodExpression,StringLiteral: equivalent — git quotes every path containing `"`, so a raw path has a quote at both ends or at neither
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
    /* Unquoted paths never contain `"` or `\` (git quotes such paths), and in a well-formed R/C line a
       quoted old path's closing quote is always followed by " -> "; the directives below mark the
       mutants those two facts make equivalent. */
    const findArrowSplit = (rest: string): number => {
      // Stryker disable next-line ConditionalExpression: equivalent — see above
      if (rest[0] === '"') {
        let i = 1;
        // Stryker disable next-line EqualityOperator: equivalent — rest[rest.length] is undefined and only advances i past the end
        while (i < rest.length) {
          if (rest[i] === "\\") {
            i += 2;
            continue;
          }
          if (rest[i] === '"') break;
          i++;
        }
        // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral: equivalent — see above
        if (i < rest.length && rest.startsWith(" -> ", i + 1)) return i + 1;
      }
      return rest.indexOf(" -> ");
    };
    return out
      .split("\n")
      .filter(
        // Stryker disable next-line EqualityOperator: equivalent — git never emits a status line with an empty path
        (l) => l.length > 3,
      )
      .flatMap((l): ParsedChange[] => {
        const xy = l.slice(0, 2);
        const rest = l.slice(3);
        if (xy[0] === "R" || xy[0] === "C") {
          const arrowIdx = findArrowSplit(rest);
          // Stryker disable next-line ConditionalExpression: equivalent — an R/C line always contains the arrow
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
    // Stryker disable next-line Regex: equivalent — git paths never contain "./" past the start, so the ^ anchor never decides
    const f = path.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
    return CONFINEMENT_DENYLIST.some((entry) => deniedBy(entry, f));
  }

  /* True when the path meets the dangerous tier: a secret-file write — any path segment named .env, .env.<anything> or <anything>.env, at any depth (so a nested packages/api/.env.local counts, and .env.example-style templates count everywhere as they do at the root). Applies regardless of run target. .git/ is not a case here — git status never surfaces paths inside .git/; hook RCE is hardened separately via core.hooksPath. */
  isDangerousPath(path: string): boolean {
    const f = path.replace(/\\/g, "/").toLowerCase();
    return ENV_FILE_PATTERNS.some((entry) => deniedBy(entry, f));
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
