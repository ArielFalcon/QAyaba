/* The change-token set a test contract is anchored to. The orchestrator derives it from the diff (string
   literals on ADDED lines) and, when the grounding port reports them, the changed containers. It is the
   part of a contract the agent cannot author: the tokens come from the change, so a test that never names
   one of them is measurably unanchored. Pure: no I/O. */

/** A normalized token set. Normalization is trim + collapsed whitespace + lowercase, applied on both
    sides, so a literal matches a token whatever the quoting or spacing around it. */
export interface ChangeTokenSet {
  /** String literals (a test-id value included) that appear on added diff lines. */
  readonly literals: ReadonlySet<string>;
  /** Containers the grounding port reported as changed (element names, section scopes). */
  readonly containers: ReadonlySet<string>;
  /** Every token, literals and containers together. Empty means "no-tokens" — never "unanchored". */
  readonly all: ReadonlySet<string>;
}

export const EMPTY_TOKEN_SET: ChangeTokenSet = { literals: new Set(), containers: new Set(), all: new Set() };

/** Trim, collapse internal whitespace and lowercase. The one normalization both sides of a comparison use. */
export function normalizeToken(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const QUOTED_LITERAL_RE = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

/** The text of every added line in a unified diff, header lines excluded. */
function addedLineTexts(diff: string): string[] {
  const out: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) out.push(raw.slice(1));
  }
  return out;
}

/**
 * The change's own tokens: every non-empty string literal on an added line, plus the containers the
 * caller reports (an absent report contributes none — the diff literals alone still bind).
 */
export function changeTokens(diff: string, containers: readonly string[] = []): ChangeTokenSet {
  const literals = new Set<string>();
  for (const line of addedLineTexts(diff)) {
    for (const match of line.matchAll(QUOTED_LITERAL_RE)) {
      const value = normalizeToken(match[1] ?? match[2] ?? match[3] ?? "");
      if (value) literals.add(value);
    }
  }
  const containerSet = new Set<string>();
  for (const container of containers) {
    const value = normalizeToken(container);
    if (value) containerSet.add(value);
  }
  return { literals, containers: containerSet, all: new Set([...literals, ...containerSet]) };
}
