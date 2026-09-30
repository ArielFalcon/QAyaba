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
  /* Ceiling for directive-lexicon hits across the assembled sections. */
  maxDirectives?: number;
}

export interface LintOptions {
  budget?: LintBudget;
  /* Names of assembled artifacts (headings of the rendered sections); static text must not mention them. */
  assembledArtifactNames?: readonly string[];
}

export type LintRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12";

export interface LintFinding {
  rule: LintRule;
  /* Section ids the finding names: the offending pair, or the single offending section; empty for a cell-level budget breach. */
  sections: readonly string[];
  fact?: FactId;
  detail?: string;
}

export const APP_LOGIN_SECTION_ID = "app-login";
export const HARNESS_FACTS_SECTION_ID = "harness-facts";

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
  /\bsource of truth\b/gi,
  /\btrust(?:ed)?\b/gi,
  /\bstale\b/gi,
  /\bunverified\b/gi,
  /\bestablished\b/gi,
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

const MIN_DUPLICATE_LINE_BYTES = 40;

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

function allPairs(ids: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
  }
  return pairs;
}

/* R1: at most one section frames a fact. A second framing is a contradiction when the stance differs and a duplicate owner when it does not. */
function ruleSingleFraming(cell: LintCell): LintFinding[] {
  const findings: LintFinding[] = [];
  const framed = new Map<FactId, Array<{ section: string; as: string }>>();
  for (const section of cell.sections) {
    for (const claim of section.claims) {
      if (claim.kind !== "frames") continue;
      const list = framed.get(claim.fact) ?? [];
      list.push({ section: section.id, as: claim.as });
      framed.set(claim.fact, list);
    }
  }
  for (const [fact, framings] of framed) {
    for (let i = 0; i < framings.length; i++) {
      for (let j = i + 1; j < framings.length; j++) {
        const a = framings[i]!;
        const b = framings[j]!;
        findings.push({
          rule: "R1",
          fact,
          sections: uniqueSorted([a.section, b.section]),
          detail: a.as === b.as ? `framed twice as ${a.as}` : `framed as ${a.as} and as ${b.as}`,
        });
      }
    }
  }
  return findings;
}

/* R2: single-source facts have one provider; landmarks and a DOM tree never coexist. */
function ruleSingleProvider(cell: LintCell): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const fact of SINGLE_SOURCE_FACTS) {
    for (const [a, b] of allPairs(providersOf(cell, fact))) {
      findings.push({ rule: "R2", fact, sections: [a, b], detail: `${fact} provided twice` });
    }
  }
  const trees = uniqueSorted([...providersOf(cell, "dom-live"), ...providersOf(cell, "dom-failure")]);
  for (const landmarks of providersOf(cell, "landmarks")) {
    for (const tree of trees) {
      findings.push({
        rule: "R2",
        fact: "landmarks",
        sections: uniqueSorted([landmarks, tree]),
        detail: "landmark hints alongside a DOM tree",
      });
    }
  }
  return findings;
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
          findings.push({
            rule: "R3",
            fact: claim.target,
            sections: uniqueSorted([section.id, provider]),
            detail: `directs ${claim.action} of ${claim.target} while it is provided`,
          });
        }
      } else if (claim.action === "consult" && providers.length === 0) {
        findings.push({
          rule: "R3",
          fact: claim.target,
          sections: [section.id],
          detail: `consults ${claim.target}, which nothing provides`,
        });
      }
    }
  }
  return findings;
}

/* R4: a regeneration turn carries no orientation, repo analysis or diff re-embed. */
function ruleRegenTurn(cell: LintCell): LintFinding[] {
  if (!cell.regen) return [];
  const findings: LintFinding[] = [];
  for (const section of cell.sections) {
    for (const claim of section.claims) {
      if (claim.kind === "directs" && (claim.action === "analyze-repo" || claim.action === "orient")) {
        findings.push({ rule: "R4", sections: [section.id], detail: `regeneration directs ${claim.action}` });
      }
      if (claim.kind === "provides" && claim.fact === "diff") {
        findings.push({ rule: "R4", sections: [section.id], detail: "regeneration re-embeds the diff" });
      }
    }
  }
  return findings;
}

/* R5: selectors are never derived from source code. */
function ruleNoDeriveFromCode(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter((s) => s.claims.some((c) => c.kind === "directs" && c.action === "derive-from-code"))
    .map((s) => ({ rule: "R5" as const, sections: [s.id], detail: "directs deriving from code" }));
}

/* R6: a facts-only section carries data, never a directive, a framing or directive language. */
function ruleFactsOnly(cell: LintCell): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const section of cell.sections) {
    if (!section.factsOnly) continue;
    const hasClaim = section.claims.some((c) => c.kind === "directs" || c.kind === "frames");
    if (hasClaim || countDirectives(section.text) > 0) {
      findings.push({ rule: "R6", sections: [section.id], detail: "facts-only section carries a directive or framing" });
    }
  }
  return findings;
}

function duplicateCandidateLines(text: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s/.test(line)) continue;
    if (bytes(line) < MIN_DUPLICATE_LINE_BYTES) continue;
    lines.push(line);
  }
  return lines;
}

/* R7: an exact scaffold line present in two sections (assembled or static) is duplicated content. */
function ruleDuplicateLines(cell: LintCell): LintFinding[] {
  const owners = new Map<string, Set<string>>();
  for (const section of cell.sections) {
    if (section.verbatim) continue;
    for (const line of new Set(duplicateCandidateLines(section.text))) {
      const set = owners.get(line) ?? new Set<string>();
      set.add(section.id);
      owners.set(line, set);
    }
  }
  const duplicatedBytes = new Map<string, number>();
  for (const [line, ids] of owners) {
    if (ids.size < 2) continue;
    for (const [a, b] of allPairs(uniqueSorted([...ids]))) {
      const key = `${a}\u0000${b}`;
      duplicatedBytes.set(key, (duplicatedBytes.get(key) ?? 0) + bytes(line));
    }
  }
  return [...duplicatedBytes].map(([key, total]) => {
    const [a, b] = key.split("\u0000") as [string, string];
    return { rule: "R7" as const, sections: [a, b], detail: `${total} duplicated bytes` };
  });
}

/* R8: the static layer holds unconditional craft rules and never names an artifact that only some prompts assemble. */
function ruleStaticNamesNoArtifact(cell: LintCell, names: readonly string[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const section of cell.sections) {
    if (section.layer !== "static") continue;
    const hit = names.find((name) => name && section.text.includes(name));
    if (hit) findings.push({ rule: "R8", sections: [section.id], detail: `static text names the assembled artifact "${hit}"` });
  }
  return findings;
}

/* R9: the assembled prompt stays inside its recorded size and directive budget. */
function ruleBudget(cell: LintCell, budget: LintBudget | undefined): LintFinding[] {
  if (!budget) return [];
  const assembled = cell.sections.filter((s) => s.layer === "assembled");
  const findings: LintFinding[] = [];
  if (budget.maxAssembledBytes !== undefined) {
    const total = assembled.reduce((sum, s) => sum + bytes(s.text), 0);
    if (total > budget.maxAssembledBytes) {
      findings.push({ rule: "R9", sections: [], detail: `${total} assembled bytes exceed the ${budget.maxAssembledBytes} budget` });
    }
  }
  if (budget.maxDirectives !== undefined) {
    const total = assembled.reduce((sum, s) => sum + countDirectives(s.text), 0);
    if (total > budget.maxDirectives) {
      findings.push({ rule: "R9", sections: [], detail: `${total} directive hits exceed the ${budget.maxDirectives} budget` });
    }
  }
  return findings;
}

/* R10: an assembled section that talks about trust must declare the framing it applies. Captured data (a diff) may say anything, so verbatim sections are not judged. */
function ruleTrustNeedsFraming(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter((s) => s.layer === "assembled" && !s.verbatim && hasTrustLanguage(s.text) && !s.claims.some((c) => c.kind === "frames"))
    .map((s) => ({ rule: "R10" as const, sections: [s.id], detail: "trust language without a declared framing" }));
}

/* R11: the runtime-signals directive only belongs where no DOM tree is available. */
function ruleRuntimeSignalsOnlyWithoutTree(cell: LintCell): LintFinding[] {
  const trees = uniqueSorted([...providersOf(cell, "dom-live"), ...providersOf(cell, "dom-failure")]);
  if (trees.length === 0) return [];
  const findings: LintFinding[] = [];
  for (const section of cell.sections) {
    if (!section.claims.some((c) => c.kind === "directs" && c.action === "use-runtime-signals")) continue;
    for (const tree of trees) {
      findings.push({ rule: "R11", sections: uniqueSorted([section.id, tree]), detail: "runtime signals directed while a DOM tree is provided" });
    }
  }
  return findings;
}

/* R12: the login section never sends the agent to the pack's live DOM, which may not include the login page. */
function ruleLoginNotPackDependent(cell: LintCell): LintFinding[] {
  return cell.sections
    .filter(
      (s) =>
        s.id === APP_LOGIN_SECTION_ID &&
        s.claims.some((c) => c.kind === "directs" && c.action === "consult" && c.target === "dom-live"),
    )
    .map((s) => ({ rule: "R12" as const, sections: [s.id], detail: "login section consults the pack's live DOM" }));
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
    ...ruleStaticNamesNoArtifact(cell, options.assembledArtifactNames ?? []),
    ...ruleBudget(cell, options.budget),
    ...ruleTrustNeedsFraming(cell),
    ...ruleRuntimeSignalsOnlyWithoutTree(cell),
    ...ruleLoginNotPackDependent(cell),
  ];
  return findings.sort((a, b) => {
    const ka = findingKey(a);
    const kb = findingKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : (a.fact ?? "") < (b.fact ?? "") ? -1 : (a.fact ?? "") > (b.fact ?? "") ? 1 : 0;
  });
}
