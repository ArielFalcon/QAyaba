/*
 * Prompt-contract lint: a pure, deterministic check over ONE assembled prompt (plus the static role
 * layer it ships with). It never reads prose to judge meaning. Builders DECLARE claims on each
 * section — what fact the section provides, how it frames that fact's trust, what it directs the
 * agent to do about a fact — and the rules below check those declarations against each other, plus
 * exact-line duplicates, static-layer artifact names and size/directive budgets.
 *
 * Known limit: the rules bound contradiction and duplication, they do not prove the absence of a
 * paraphrased restatement; claim/text drift is caught by the per-behavior tests, not here.
 */

export type FactId =
  | "blast-radius"
  | "risks"
  | "fe-be-links"
  | "contracts"
  | "api-operations"
  | "dom-live"
  | "dom-failure"
  | "landmarks"
  | "arch-map"
  | "structural-signal"
  | "service-links"
  | "harness-facts"
  | "diff";

export type ClaimAction =
  | "read"
  | "consult"
  | "orient"
  | "analyze-repo"
  | "state-outcome"
  | "derive-from-code"
  | "use-runtime-signals";

export type PromptClaim =
  | { kind: "provides"; fact: FactId }
  | { kind: "frames"; fact: FactId; as: "established" | "unverified" }
  | { kind: "directs"; action: ClaimAction; target?: FactId };

/* Builders declare claims with these; the shape is the only thing the lint reads. */
export const claim = {
  provides: (fact: FactId): PromptClaim => ({ kind: "provides", fact }),
  frames: (fact: FactId, as: "established" | "unverified"): PromptClaim => ({ kind: "frames", fact, as }),
  directs: (action: ClaimAction, target?: FactId): PromptClaim =>
    target ? { kind: "directs", action, target } : { kind: "directs", action },
};

export interface LintSection {
  id: string;
  /* static = the role/AGENTS text the agent ships with; assembled = a section of the per-turn user prompt. */
  layer: "static" | "assembled";
  text: string;
  claims: readonly PromptClaim[];
  /* Captured data (a DOM tree, a diff): its lines are not scaffold, so it never takes part in duplicate-line detection. */
  verbatim?: boolean;
  /* A section that may carry facts only: no directive claim, no framing, no directive language. */
  factsOnly?: boolean;
}

export interface LintCell {
  name: string;
  /* The turn is a regeneration (fix / reviewer corrections / coverage gap / selector contradictions). */
  regen: boolean;
  sections: readonly LintSection[];
}

export interface LintBudget {
  /* Ceiling for the summed bytes of the assembled sections (the user prompt). */
  maxAssembledBytes?: number;
  /* Ceiling for the summed bytes of the static sections (the role and shared-rule text the agent ships with). */
  maxStaticBytes?: number;
  /* Ceiling for directive-lexicon hits across the assembled sections (captured verbatim data such as a diff is not counted). */
  maxDirectives?: number;
}

/* How a directive refers to an artifact only some prompts assemble, and what must be in the cell for the reference to mean something. */
export interface ArtifactReference {
  artifact: string;
  /* The words that refer to it. */
  pattern: RegExp;
  /* The artifact is provided when a section carries any of these facts, or has this id. */
  provider: { facts: readonly FactId[] } | { section: string };
}

export interface LintOptions {
  budget?: LintBudget;
  /* Names of assembled artifacts (headings of the rendered sections); static text must not mention them. */
  assembledArtifactNames?: readonly string[];
  /* References an assembled section may make only to an artifact the cell provides. */
  artifactReferences?: readonly ArtifactReference[];
}

export type LintRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12" | "R13" | "R14";

export interface LintFinding {
  rule: LintRule;
  /* Section ids the finding names: the offending pair, or the single offending section; empty for a cell-level budget breach. */
  sections: readonly string[];
  fact?: FactId;
  /* The artifact a section refers to and the cell does not provide (R13). */
  artifact?: string;
  /* The numbers behind a size finding: duplicated bytes (R7), or what a budget measured against its limit (R9). */
  measured?: number;
  limit?: number;
  budget?: "bytes" | "directives" | "static-bytes" | "unrecorded";
}

export const APP_LOGIN_SECTION_ID = "app-login";
export const HARNESS_FACTS_SECTION_ID = "harness-facts" satisfies FactId;

/* Facts that exactly one section may provide: a second copy is a duplicated source of truth. */
const SINGLE_SOURCE_FACTS: readonly FactId[] = ["blast-radius", "risks", "fe-be-links", "dom-live", "api-operations"];

/* Imperative and prohibition markers. Counted for the directive budget and forbidden in facts-only sections. */
export const DIRECTIVE_LEXICON: readonly RegExp[] = [
  /\bmust\b/gi,
  /\bdo not\b/gi,
  /\bdon't\b/gi,
  /\bnever\b/gi,
  /\balways\b/gi,
  /\bverify\b/gi,
  /\bensure\b/gi,
  /\bmake sure\b/gi,
  /\bavoid\b/gi,
];

/* Words that assign a trust level to a fact. A section using them must declare the framing it applies. */
export const TRUST_LEXICON: readonly RegExp[] = [
  /\bauthoritative\b/gi,
  /\bground truth\b/gi,
  /\bonly source of truth\b/gi,
  /\btrust(?:ed)?\b/gi,
  /\bstale\b/gi,
  /\bunverified\b/gi,
  /\bestablished\b/gi,
];

/* Words that take trust away from a fact. A section that declares its fact established must not use them. */
export const NEGATED_TRUST_LEXICON: readonly RegExp[] = [
  /\bnot authoritative\b/i,
  /\bnon-authoritative\b/i,
  /\bverify before trust(?:ing)?\b/i,
  /\bmust be verified\b/i,
];

/* Words that give trust to a fact. A section that declares its fact unverified must not use them; a negated "authoritative" does not count. */
export const ESTABLISHED_TRUST_LEXICON: readonly RegExp[] = [
  /(?<!not )(?<!non-)\bauthoritative\b/i,
  /\bground truth\b/i,
  /\bonly source of truth\b/i,
];

function countMatches(lexicon: readonly RegExp[], text: string): number {
  let total = 0;
  for (const pattern of lexicon) total += [...text.matchAll(pattern)].length;
  return total;
}

export function countDirectives(text: string): number {
  return countMatches(DIRECTIVE_LEXICON, text);
}

export function hasTrustLanguage(text: string): boolean {
  return countMatches(TRUST_LEXICON, text) > 0;
}

export function findingKey(finding: LintFinding): string {
  return [finding.rule, ...[...finding.sections].sort()].join("|");
}

/* A line shorter than this (once trimmed) is too generic to count as a duplicate. */
export const MIN_DUPLICATE_LINE_BYTES = 40;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function providersOf(cell: LintCell, fact: FactId): string[] {
  return uniqueSorted(
    cell.sections.filter((s) => s.claims.some((c) => c.kind === "provides" && c.fact === fact)).map((s) => s.id),
  );
}

/* Every unordered pair of the items, each once, in list order. */
function allPairs<T>(items: readonly T[]): Array<[T, T]> {
  return items.flatMap((first, i): Array<[T, T]> => items.slice(i + 1).map((second) => [first, second]));
}

/* R1: at most one section frames a fact. A second framing is a contradiction when the stance differs and a duplicate owner when it does not. */
function ruleSingleFraming(cell: LintCell): LintFinding[] {
  const framed = new Map<FactId, string[]>();
  for (const section of cell.sections) {
    for (const claim of section.claims) {
      if (claim.kind === "frames") framed.set(claim.fact, [...(framed.get(claim.fact) ?? []), section.id]);
    }
  }
  return [...framed].flatMap(([fact, owners]) =>
    allPairs(owners).map(([a, b]) => ({ rule: "R1" as const, fact, sections: uniqueSorted([a, b]) })),
  );
}

/* R2: single-source facts have one provider; landmarks and a DOM tree never coexist. */
function ruleSingleProvider(cell: LintCell): LintFinding[] {
  const duplicated = SINGLE_SOURCE_FACTS.flatMap((fact) =>
    allPairs(providersOf(cell, fact)).map(([a, b]) => ({ rule: "R2" as const, fact, sections: [a, b] })),
  );
  const trees = uniqueSorted([...providersOf(cell, "dom-live"), ...providersOf(cell, "dom-failure")]);
  const hintsBesideTree = providersOf(cell, "landmarks").flatMap((landmarks) =>
    trees.map((tree) => ({ rule: "R2" as const, fact: "landmarks" as const, sections: uniqueSorted([landmarks, tree]) })),
  );
  return [...duplicated, ...hintsBesideTree];
}

/* R3: never direct a read of a fact that is already provided; never consult a fact nothing provides. */
function ruleDirectivesAgainstProviders(cell: LintCell): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const section of cell.sections) {
    for (const claim of section.claims) {
      if (claim.kind !== "directs" || !claim.target) continue;
      const providers = providersOf(cell, claim.target);
      if (claim.action === "read" || claim.action === "orient") {
        for (const provider of providers) {
          findings.push({ rule: "R3", fact: claim.target, sections: uniqueSorted([section.id, provider]) });
        }
      } else if (claim.action === "consult" && providers.length === 0) {
        findings.push({ rule: "R3", fact: claim.target, sections: [section.id] });
      }
    }
  }
  return findings;
}

/* R4: a regeneration turn carries no orientation, repo analysis or diff re-embed. */
function ruleRegenTurn(cell: LintCell): LintFinding[] {
  if (!cell.regen) return [];
  return cell.sections
    .filter((section) =>
      section.claims.some(
        (c) =>
          (c.kind === "directs" && (c.action === "analyze-repo" || c.action === "orient")) ||
          (c.kind === "provides" && c.fact === "diff"),
      ),
    )
    .map((section) => ({ rule: "R4" as const, sections: [section.id] }));
}

/* R5: selectors are never derived from source code. */
function ruleNoDeriveFromCode(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter((s) => s.claims.some((c) => c.kind === "directs" && c.action === "derive-from-code"))
    .map((s) => ({ rule: "R5" as const, sections: [s.id] }));
}

/* R6: a facts-only section carries data, never a directive, a framing or directive language. */
function ruleFactsOnly(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter(
      (s) =>
        s.factsOnly &&
        (s.claims.some((c) => c.kind === "directs" || c.kind === "frames") || countDirectives(s.text) > 0),
    )
    .map((s) => ({ rule: "R6" as const, sections: [s.id] }));
}

/* The scaffold lines of a section, trimmed so the same words indented differently are one line. The rows of a captured DOM tree are indented data: a section that provides a tree contributes none of its indented lines. */
function duplicateCandidateLines(text: string, providesTree: boolean): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (providesTree && /^\s/.test(line)) continue;
    const trimmed = line.trim();
    if (bytes(trimmed) < MIN_DUPLICATE_LINE_BYTES) continue;
    lines.push(trimmed);
  }
  return lines;
}

const TREE_FACTS: readonly FactId[] = ["dom-live", "dom-failure"];

/* R7: an exact scaffold line present in two sections (assembled or static) is duplicated content. */
function ruleDuplicateLines(cell: LintCell): LintFinding[] {
  const owners = new Map<string, Set<string>>();
  for (const section of cell.sections) {
    if (section.verbatim) continue;
    const providesTree = section.claims.some((c) => c.kind === "provides" && TREE_FACTS.includes(c.fact));
    for (const line of new Set(duplicateCandidateLines(section.text, providesTree))) {
      owners.set(line, (owners.get(line) ?? new Set<string>()).add(section.id));
    }
  }
  const duplicatedBytes = new Map<string, { sections: [string, string]; total: number }>();
  for (const [line, ids] of owners) {
    for (const pair of allPairs(uniqueSorted([...ids]))) {
      const key = JSON.stringify(pair);
      duplicatedBytes.set(key, { sections: pair, total: (duplicatedBytes.get(key)?.total ?? 0) + bytes(line) });
    }
  }
  return [...duplicatedBytes.values()].map(({ sections, total }) => ({ rule: "R7" as const, sections, measured: total }));
}

/* R8: the static layer holds unconditional craft rules and never names an artifact that only some prompts assemble. */
function ruleStaticNamesNoArtifact(cell: LintCell, names: readonly string[] | undefined): LintFinding[] {
  return cell.sections
    .filter((s) => s.layer === "static" && names?.some((name) => name && s.text.includes(name)))
    .map((s) => ({ rule: "R8" as const, sections: [s.id] }));
}

/* R9: the assembled prompt stays inside its recorded size and directive budget, and the static layer inside its own size budget. */
function ruleBudget(cell: LintCell, budget: LintBudget | undefined): LintFinding[] {
  if (!budget) return [];
  const assembled = cell.sections.filter((s) => s.layer === "assembled");
  const staticLayer = cell.sections.filter((s) => s.layer === "static");
  const findings: LintFinding[] = [];
  const check = (kind: "bytes" | "directives" | "static-bytes", measured: number, limit: number | undefined): void => {
    if (limit !== undefined && measured > limit) findings.push({ rule: "R9", sections: [], budget: kind, measured, limit });
  };
  check("bytes", assembled.reduce((sum, s) => sum + bytes(s.text), 0), budget.maxAssembledBytes);
  check("static-bytes", staticLayer.reduce((sum, s) => sum + bytes(s.text), 0), budget.maxStaticBytes);
  check("directives", assembled.filter((s) => !s.verbatim).reduce((sum, s) => sum + countDirectives(s.text), 0), budget.maxDirectives);
  return findings;
}

/* The pieces of the text between references to sections by their heading: a reference is not trust language, and removing it must not glue the words around it into a new one. */
function outsideReferences(text: string, headingNames: readonly string[] | undefined): string[] {
  return headingNames?.reduce((pieces, name) => (name ? pieces.flatMap((piece) => piece.split(name)) : pieces), [text]) ?? [text];
}

/* R10: an assembled section that talks about trust must declare the framing it applies. Naming another section by its heading is a reference, not a framing, and captured data (a diff) may say anything, so verbatim sections are not judged. */
function ruleTrustNeedsFraming(cell: LintCell, headingNames: readonly string[] | undefined): LintFinding[] {
  return cell.sections
    .filter(
      (s) =>
        s.layer === "assembled" &&
        !s.verbatim &&
        outsideReferences(s.text, headingNames).some(hasTrustLanguage) &&
        !s.claims.some((c) => c.kind === "frames"),
    )
    .map((s) => ({ rule: "R10" as const, sections: [s.id] }));
}

/* R14: what a section says about trust agrees with the framing it declares. Only a section that declares a single stance is judged; one that declares both frames facts of its own and cannot be read as a whole. */
function rulePolarityAgreesWithFraming(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter((s) => s.layer === "assembled" && !s.verbatim)
    .filter((s) => {
      const stances = new Set(s.claims.flatMap((c) => (c.kind === "frames" ? [c.as] : [])));
      if (stances.size !== 1) return false;
      const contradicting = stances.has("established") ? NEGATED_TRUST_LEXICON : ESTABLISHED_TRUST_LEXICON;
      return contradicting.some((pattern) => pattern.test(s.text));
    })
    .map((s) => ({ rule: "R14" as const, sections: [s.id] }));
}

/* R11: the runtime-signals directive only belongs where no DOM tree is available. */
function ruleRuntimeSignalsOnlyWithoutTree(cell: LintCell): LintFinding[] {
  const trees = uniqueSorted([...providersOf(cell, "dom-live"), ...providersOf(cell, "dom-failure")]);
  return cell.sections
    .filter((s) => s.claims.some((c) => c.kind === "directs" && c.action === "use-runtime-signals"))
    .flatMap((s) => trees.map((tree) => ({ rule: "R11" as const, sections: uniqueSorted([s.id, tree]) })));
}

/* R12: the login section never sends the agent to the pack's live DOM, which may not include the login page. */
function ruleLoginNotPackDependent(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter(
      (s) =>
        s.id === APP_LOGIN_SECTION_ID &&
        s.claims.some((c) => c.kind === "directs" && c.action === "consult" && c.target === "dom-live"),
    )
    .map((s) => ({ rule: "R12" as const, sections: [s.id] }));
}

function isProvided(cell: LintCell, provider: ArtifactReference["provider"]): boolean {
  return "section" in provider
    ? cell.sections.some((s) => s.id === provider.section)
    : provider.facts.some((fact) => providersOf(cell, fact).length > 0);
}

/* A markdown title line. */
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;

/* The prompt's own words: a section's titles and the fenced blocks of captured data it embeds refer to nothing. */
function proseOf(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .filter((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return false;
      }
      return !inFence && !HEADING_LINE.test(line);
    })
    .join("\n");
}

/* R13: an assembled section that refers to an artifact (the tree above, the brief, the diff, a named section) needs that artifact in the cell; a directive must never point at something the prompt does not carry. */
function ruleReferencesNeedTheirArtifact(cell: LintCell, references: readonly ArtifactReference[] | undefined): LintFinding[] {
  return cell.sections
    .filter((s) => s.layer === "assembled" && !s.verbatim)
    .flatMap((s) => {
      const body = proseOf(s.text);
      return (references ?? [])
        .filter((ref) => ref.pattern.test(body) && !isProvided(cell, ref.provider))
        .map((ref) => ({ rule: "R13" as const, sections: [s.id], artifact: ref.artifact }));
    });
}

export function lintCell(cell: LintCell, options: LintOptions = {}): readonly LintFinding[] {
  const findings = [
    ...ruleSingleFraming(cell),
    ...ruleSingleProvider(cell),
    ...ruleDirectivesAgainstProviders(cell),
    ...ruleRegenTurn(cell),
    ...ruleNoDeriveFromCode(cell),
    ...ruleFactsOnly(cell),
    ...ruleDuplicateLines(cell),
    ...ruleStaticNamesNoArtifact(cell, options.assembledArtifactNames),
    ...ruleBudget(cell, options.budget),
    ...ruleTrustNeedsFraming(cell, options.assembledArtifactNames),
    ...ruleRuntimeSignalsOnlyWithoutTree(cell),
    ...ruleLoginNotPackDependent(cell),
    ...ruleReferencesNeedTheirArtifact(cell, options.artifactReferences),
    ...rulePolarityAgreesWithFraming(cell),
  ];
  /* Ordered by key as text, then by fact: the same cell always yields the same list, comparable across runs. */
  return findings
    .map((finding) => ({ finding, order: `${findingKey(finding)}\u0001${String(finding.fact)}\u0001${String(finding.artifact)}` }))
    .sort((a, b) => (a.order < b.order ? -1 : 1))
    .map(({ finding }) => finding);
}
