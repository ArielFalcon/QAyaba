/* Git SHA value object: hex, validated at construction by the kernel's object-name rule (git-revision.ts): 4 (minimum abbreviation) to 40 (full SHA-1). It also carries the commit a product reports as served, which can be any abbreviation git makes, so it is wider than the 7 characters a requested commit needs (`isCommitSha`). */
import { isObjectName } from "@kernel/git-revision.ts";

export class Sha {
  private constructor(readonly value: string) {}

  static of(raw: string): Sha {
    const v = raw.trim().toLowerCase();
    if (!isObjectName(v)) {
      throw new Error(`Sha: not a valid commit sha (expected 4-40 hex chars): ${JSON.stringify(raw)}`);
    }
    return new Sha(v);
  }

  static tryOf(raw: string): Sha | null {
    const v = raw.trim().toLowerCase();
    return isObjectName(v) ? new Sha(v) : null;
  }

  get short(): string {
    return this.value.slice(0, 7);
  }

  equals(other: Sha): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

/* DEV /version may report a short SHA while the trigger carries the full 40-char form (or vice versa). Match equal or >=7-char prefix, case-insensitive — the floor avoids weak matches on tiny prefixes. Callers pass untrusted possibly-short strings; forcing Sha.of would reject those at the boundary. */
export function shaMatches(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 7 && y.startsWith(x)) return true;
  if (y.length >= 7 && x.startsWith(y)) return true;
  return false;
}
