/* Git SHA value object: hex, validated at construction. Length is a git object name: 4 (minimum abbreviation) to 40 (full SHA-1). */

const HEX_SHA = /^[0-9a-f]{4,40}$/;

export class Sha {
  private constructor(readonly value: string) {}

  static of(raw: string): Sha {
    const v = raw.trim().toLowerCase();
    if (!HEX_SHA.test(v)) {
      throw new Error(`Sha: not a valid commit sha (expected 4-40 hex chars): ${JSON.stringify(raw)}`);
    }
    return new Sha(v);
  }

  static tryOf(raw: string): Sha | null {
    const v = raw.trim().toLowerCase();
    return HEX_SHA.test(v) ? new Sha(v) : null;
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
