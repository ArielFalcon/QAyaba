/* Lever-2 selector check plus catalog-gate extractors. Pure: no browser, no FS I/O.
unscopedMultipleContradictions suppresses false-block idioms: (1) a selector immediately followed by .first(/.nth(/.filter( — the author already disambiguated it; (2) the page-rooted check applies unconditionally (not gated on anyNonExtractable). Suppression only narrows blocking — MULTIPLE contradictions feed the one-shot corrective regen, never a bare pass/fail. */

export interface ProposedSelector {
  kind: "role" | "text" | "label";
  role?: string;
  name?: string;
  exact?: boolean;
  isRegex?: boolean;
}

/* Accessible-name placeholder when parseAriaSnapshot confirmed presence but dropped the composed name. selectorPresent must not treat this as a real name. */
const STRUCTURAL_PRESENT_MARKER = "(present)";

export interface PresenceResult {
  present: boolean;
  /* Conclusive when the role is known WITH a real name. False when absence may be snapshot pruning or a `(present)` marker — advisory, never an invalid spec. `present: false` must not hard-block; the executor is the final oracle. */
  verifiable: boolean;
}

/* Collapse whitespace on both expected and snapshot names so multi-line YAML still matches. */
export function normalizeName(s: string): string {
  return s.replace(/[\r\n\t\f\s]+/g, " ").trim();
}

/* Strips only known ARIA state tokens (disabled, expanded, checked, required, selected, pressed, level=<digits>). Arbitrary brackets ("Inbox [5]", "Edit [Draft]") stay in the accessible name. */
const ARIA_STATE_STRIP_RE = /(?:\s*\[(disabled|expanded|checked|required|selected|pressed|level=\d+)\])+\s*$/;

function parseLine(line: string): { role: string; name: string } | null {
  const clean = line.replace(ARIA_STATE_STRIP_RE, "").trim();
  const colon = clean.indexOf(": ");
  if (colon === -1) {
    /* "role: (present)" — colon exists but with value "(present)". */
    const colon2 = clean.indexOf(":");
    if (colon2 === -1) return null;
    return { role: clean.slice(0, colon2).trim().toLowerCase(), name: clean.slice(colon2 + 1).trim() };
  }
  return { role: clean.slice(0, colon).trim().toLowerCase(), name: clean.slice(colon + 2).trim() };
}

const TEXT_KIND_ROLES = new Set(["text", "heading", "listitem", "cell", "gridcell"]);
const LABEL_KIND_ROLES = new Set(["textbox", "combobox", "checkbox", "radio"]);

function roleMatches(sel: ProposedSelector, snapshotRole: string): boolean {
  const norm = snapshotRole.toLowerCase();
  if (sel.kind === "role") {
    return norm === (sel.role ?? "").toLowerCase();
  }
  if (sel.kind === "text") {
    return TEXT_KIND_ROLES.has(norm) || norm === "button" || norm === "link";
  }
  if (sel.kind === "label") {
    return LABEL_KIND_ROLES.has(norm);
  }
  return false;
}

/* Accname: no name → any node of that role; isRegex → regex.test(normalize(actual)); exact → equality after normalize; else case-insensitive substring. */
function nameMatches(sel: ProposedSelector, snapshotName: string): boolean {
  if (!sel.name) return true;
  /* `(present)` is a structural marker, not a real name. A name-bearing selector must never match it — otherwise "Present"/"res" would substring-match and fake uniqueness, starving the real-bug guard. */
  if (snapshotName === STRUCTURAL_PRESENT_MARKER) return false;
  const normActual = normalizeName(snapshotName);
  if (sel.isRegex) {
    try {
      const re = new RegExp(sel.name);
      return re.test(normActual);
    } catch {
      return false; /* invalid regex from spec → no match (never throw) */
    }
  }
  const normExpected = normalizeName(sel.name);
  if (sel.exact) {
    return normActual === normExpected;
  }
  return normActual.toLowerCase().includes(normExpected.toLowerCase());
}

/* treeLines is the parseAriaSnapshot "role: name" array the agent was shown — identical ground truth, never a re-parsed tree. Never throws. Role absent → unverifiable (may be pruned), never invalid. */
export function selectorPresent(sel: ProposedSelector, treeLines: string[]): PresenceResult {
  try {
    let anyRoleWithRealName = false; /* role matched a node carrying a real (non-(present)) name */
    for (const line of treeLines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (!roleMatches(sel, parsed.role)) continue;
      /* A name-bearing selector cannot be judged absent against a `(present)` marker — the name might exist. Only a real name makes a mismatch conclusive. */
      const isPresentMarker = parsed.name === STRUCTURAL_PRESENT_MARKER;
      if (!isPresentMarker) anyRoleWithRealName = true;
      if (nameMatches(sel, parsed.name)) {
        return { present: true, verifiable: true };
      }
    }
    /* Conclusive absence requires the role seen WITH a real name. Role absent, or present only as `(present)`, is unverifiable — never a contradiction. */
    return { present: false, verifiable: anyRoleWithRealName };
  } catch {
    return { present: false, verifiable: false };
  }
}

/* Exactly one matching node. Multiple matches → getByRole throws in strict mode. */
export function selectorUnique(sel: ProposedSelector, treeLines: string[]): boolean {
  let count = 0;
  for (const line of treeLines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (roleMatches(sel, parsed.role) && nameMatches(sel, parsed.name)) {
      count++;
      if (count > 1) return false;
    }
  }
  return count === 1;
}

/* Cut a line at its first `//` outside a string literal. A `//` inside quotes (URL, breadcrumb, path) is preserved. Regex cannot distinguish those; this is a char-scanner. */
function stripTrailingLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return `${line.slice(0, i)} `;
    }
  }
  return line;
}

/* Three passes: drop full-line comments, strip block comments, then trailing line comments. Order matters so a /* inside a block is not treated as a line comment. Result is one space-separated line so Prettier-wrapped calls match as a whole. * / */
function stripCommentsAndJoin(specSrc: string): string {
  /* Block comments first on the raw multi-line source (dotall). Each block collapses to a space. */
  const noBlocks = specSrc.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlocks
    .split("\n")
    .filter((rawLine) => {
      const trimmed = rawLine.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*"));
    })
    .map(stripTrailingLineComment)
    .join(" ");
}

/* Regex over call sites — no AST. Only getByRole / getByText / getByLabel. Matched over comment-stripped joined source so wrapped calls are captured and commented-out calls are not. */
export function extractProposedSelectors(specSrc: string): ProposedSelector[] {
  const joined = stripCommentsAndJoin(specSrc);

  /* Collect with source index, then emit in source order. Option objects may span joined lines; lazy `[\s\S]*?` stops at the first closing brace. */
  const found: Array<{ index: number; sel: ProposedSelector }> = [];

  const roleRe = /\.getByRole\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(joined)) !== null) {
    const role = m[1]!.trim();
    const { name, exact, isRegex } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, sel: { kind: "role", role, ...(name !== undefined ? { name } : {}), ...(exact ? { exact } : {}), ...(isRegex ? { isRegex } : {}) } });
  }

  const textRe = /\.getByText\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  while ((m = textRe.exec(joined)) !== null) {
    const name = m[1]!.trim();
    const { exact } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, sel: { kind: "text", name, ...(exact ? { exact } : {}) } });
  }

  const labelRe = /\.getByLabel\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  while ((m = labelRe.exec(joined)) !== null) {
    const name = m[1]!.trim();
    const { exact } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, sel: { kind: "label", name, ...(exact ? { exact } : {}) } });
  }

  return found.sort((a, b) => a.index - b.index).map((f) => f.sel);
}

/* Families the ARIA-path checker cannot see (test-ids live in attributes, not the a11y tree). Empty arrays when unused. idsNames unifies id and name locators. */
export interface CatalogSelectors {
  testIds: string[];
  placeholders: string[];
  altTexts: string[];
  titles: string[];
  idsNames: string[]; /* locator('#id') and locator('[name=x]') — simple groundable forms only */
}

/* Catalog families for the pre-exec catalog gate. Additive to extractProposedSelectors — does not change aria-path semantics. Only string-literal first args; complex CSS/XPath, `${…}`, and non-name attributes are un-groundable → advisory, never a false block. */
export function extractCatalogSelectors(specSrc: string): CatalogSelectors {
  const joined = stripCommentsAndJoin(specSrc);
  const collect = (re: RegExp): string[] => {
    const out: string[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined)) !== null) {
      const v = m[1]!.trim();
      if (v && !v.includes("${")) out.push(v);
    }
    return out;
  };
  return {
    testIds: collect(/\.getByTestId\(\s*["'`]([^"'`]+)["'`]/g),
    placeholders: collect(/\.getByPlaceholder\(\s*["'`]([^"'`]+)["'`]/g),
    altTexts: collect(/\.getByAltText\(\s*["'`]([^"'`]+)["'`]/g),
    titles: collect(/\.getByTitle\(\s*["'`]([^"'`]+)["'`]/g),
    idsNames: [
      ...collect(/\.locator\(\s*["'`]#([\w-]+)["'`]\s*\)/g),
      ...collect(/\.locator\(\s*["'`]\[name=["']?([^"'\]\s]+)["']?(?:\s+[isIS])?\s*\]["'`]\s*\)/g),
    ],
  };
}

/* Index of the first action that makes the initial-route catalog stale: first `.click()`/`.tap()` or the second `.goto()`. Selectors after this may live on a later page — must not fail-close. fill/type/press/hover/check/selectOption do not close the window. Closing on any second goto only narrows the window (safe direction). Infinity when nothing closes it. */
export function confidentWindowEnd(specSrc: string): number {
  const joined = stripCommentsAndJoin(specSrc);
  const firstClick = joined.search(/\.(?:dblclick|click|tap)\s*\(/);
  const gotoRe = /\.goto\s*\(/g;
  let count = 0;
  let secondGoto = -1;
  for (let m: RegExpExecArray | null; (m = gotoRe.exec(joined)) !== null; ) {
    if (++count === 2) { secondGoto = m.index; break; }
  }
  const ends = [firstClick, secondGoto].filter((i) => i >= 0);
  return ends.length > 0 ? Math.min(...ends) : Infinity;
}

/* getByTestId with position in the same comment-stripped coordinate space as confidentWindowEnd. Interpolated `${…}` values are dropped (un-groundable). */
export function extractTestIdSelectorsWithIndex(specSrc: string): Array<{ value: string; index: number }> {
  const joined = stripCommentsAndJoin(specSrc);
  const re = /\.getByTestId\(\s*["'`]([^"'`]+)["'`]/g;
  const out: Array<{ value: string; index: number }> = [];
  for (let m: RegExpExecArray | null; (m = re.exec(joined)) !== null; ) {
    const value = m[1]!.trim();
    if (value && !value.includes("${")) out.push({ value, index: m.index });
  }
  return out;
}

/* First literal page.goto route, or undefined when un-navigable (`${…}` or absolute URL) so the gate leaves the spec advisory. Leading-slash normalized to match RouteSnapshot.route keys. */
export function firstGotoRoute(specSrc: string): string | undefined {
  const m = /\.goto\(\s*["'`]([^"'`]+)["'`]/.exec(stripCommentsAndJoin(specSrc));
  if (!m) return undefined;
  const raw = m[1]!.trim();
  if (!raw || raw.includes("${") || /^https?:\/\//i.test(raw)) return undefined;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/* Locator families Lever-2 cannot extract against an aria snapshot. Their presence makes uniqueness incomplete — the real-bug branch must treat uniqueness as indeterminate. getByText with a regex first arg is non-extractable; string-literal getByText is still extracted. */
const NON_EXTRACTABLE_LOCATOR_RE = /\.(?:getByTestId|locator|getByPlaceholder|getByAltText|getByTitle)\s*\(|\.(?:getByText|getByLabel)\s*\(\s*\//;

export function hasNonExtractableLocator(specSrc: string): boolean {
  return NON_EXTRACTABLE_LOCATOR_RE.test(stripCommentsAndJoin(specSrc));
}

/* Surface a MULTIPLE only for a selector proven unscoped — rooted on `page` / `this.page`. Any other rooting (locator chain, variable-held locator) is indeterminate → suppress. */
const PAGE_ROOT_BEFORE_RE = /(?:^|[^.\w$])(?:this\s*\.\s*)?page$/;
function isPageRootedAt(joined: string, index: number): boolean {
  return PAGE_ROOT_BEFORE_RE.test(joined.slice(0, index).replace(/\s+$/, ""));
}

/* Selector followed by `.first(`/`.nth(`/`.filter(` is always suppressed — the author already disambiguated it. */
const DISAMBIGUATING_SUFFIX_RE = /^\s*\.(?:first|nth|filter)\s*\(/;
function isDisambiguatedAfter(joined: string, endIndex: number): boolean {
  return DISAMBIGUATING_SUFFIX_RE.test(joined.slice(endIndex));
}

/* MULTIPLE-node contradictions only for extractable selectors that are page-rooted and not disambiguated. Walks each selector individually (not gated on anyNonExtractable). anyNonExtractable is still returned by checkSpecSelectors — the real-bug branch must still hold false when a non-extractable locator is present. */
export function unscopedMultipleContradictions(
  specSources: string[],
  trees: string[][],
  treeLabel = "pre-write",
): string[] {
  const findings = checkSpecSelectors(specSources, trees, treeLabel);
  const unsuppressed: string[] = [];
  for (const specSrc of specSources) {
    const joined = stripCommentsAndJoin(specSrc);
    const extractedWithIndex = extractProposedSelectorsWithIndex(joined);
    for (const { index, endIndex, sel } of extractedWithIndex) {
      if (isDisambiguatedAfter(joined, endIndex)) continue;
      if (!isPageRootedAt(joined, index)) continue;
      const roleLabel = sel.role ?? sel.kind;
      const nameLabel = sel.name ? ` "${sel.name}"` : "";
      const contradictionPrefix = `${roleLabel}:${nameLabel} matches MULTIPLE`;
      const match = findings.contradictions.find((c) => c.startsWith(contradictionPrefix));
      if (match) unsuppressed.push(match);
    }
  }
  return [...new Set(unsuppressed)];
}

/* Internal: also returns start/end index so disambiguation and page-root checks can align with the call site. */
function extractProposedSelectorsWithIndex(joined: string): Array<{ index: number; endIndex: number; sel: ProposedSelector }> {
  const found: Array<{ index: number; endIndex: number; sel: ProposedSelector }> = [];

  const roleRe = /\.getByRole\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(joined)) !== null) {
    const role = m[1]!.trim();
    const { name, exact, isRegex } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, endIndex: m.index + m[0].length, sel: { kind: "role", role, ...(name !== undefined ? { name } : {}), ...(exact ? { exact } : {}), ...(isRegex ? { isRegex } : {}) } });
  }

  const textRe = /\.getByText\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  while ((m = textRe.exec(joined)) !== null) {
    const name = m[1]!.trim();
    const { exact } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, endIndex: m.index + m[0].length, sel: { kind: "text", name, ...(exact ? { exact } : {}) } });
  }

  const labelRe = /\.getByLabel\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{([\s\S]*?)\})?\s*\)/g;
  while ((m = labelRe.exec(joined)) !== null) {
    const name = m[1]!.trim();
    const { exact } = extractNameOpts(m[2] ?? "");
    found.push({ index: m.index, endIndex: m.index + m[0].length, sel: { kind: "label", name, ...(exact ? { exact } : {}) } });
  }

  return found.sort((a, b) => a.index - b.index);
}

function extractNameOpts(opts: string): { name?: string; exact?: boolean; isRegex?: boolean } {
  if (!opts.trim()) return {};

  const regexNameMatch = /\bname\s*:\s*\/([^/]+)\/[a-z]*/i.exec(opts);
  if (regexNameMatch) {
    return { name: regexNameMatch[1]!, isRegex: true };
  }

  const strNameMatch = /\bname\s*:\s*["'`]([^"'`]*)["'`]/.exec(opts);
  const name = strNameMatch ? strNameMatch[1]! : undefined;

  const exactMatch = /\bexact\s*:\s*true\b/.test(opts);

  return { ...(name !== undefined ? { name } : {}), ...(exactMatch ? { exact: true } : {}) };
}

/* Structured identity for cross-round comparison. Do not compare human-readable contradiction strings — an absent→ambiguous transition would look "still absent". */
export function selectorKey(sel: ProposedSelector): string {
  return `${sel.kind}|${sel.role ?? ""}|${sel.name ?? ""}|${sel.exact ? "1" : "0"}|${sel.isRegex ? "1" : "0"}`;
}

export interface SpecSelectorFindings {
  contradictions: string[];
  absentKeys: Set<string>;
  anyVerifiedPresent: boolean;
  /* Locator family Lever-2 cannot extract — uniqueness is then indeterminate. */
  anyNonExtractable: boolean;
  /* Extracted selector neither present nor verifiable-absent — uniqueness cannot be trusted. */
  anyUnverifiable: boolean;
}

/* Check extractable selectors against a11y trees. Agnostic to tree source. Per-tree, never fused: non-unique only within a single tree; absent only when absent in every tree. Empty trees → empty findings. treeLabel only names the absent message. */
export function checkSpecSelectors(
  specSources: string[],
  trees: string[][],
  treeLabel = "failure-point",
): SpecSelectorFindings {
  const contradictions: string[] = [];
  const absentKeys = new Set<string>();
  let anyVerifiedPresent = false;
  let anyNonExtractable = false;
  let anyUnverifiable = false;

  for (const specSrc of specSources) {
    if (hasNonExtractableLocator(specSrc)) anyNonExtractable = true;
    for (const sel of extractProposedSelectors(specSrc)) {
      const presences = trees.map((t) => selectorPresent(sel, t));
      const anyPresent = presences.some((p) => p.present);
      const anyVerifiable = presences.some((p) => p.verifiable);
      if (anyPresent) {
        anyVerifiedPresent = true;
        /* Non-unique within any single tree → strict-mode risk (per-tree, never fused). */
        if (presences.some((p, i) => p.present && !selectorUnique(sel, trees[i]!))) {
          const roleLabel = sel.role ?? sel.kind;
          const nameLabel = sel.name ? ` "${sel.name}"` : "";
          contradictions.push(`${roleLabel}:${nameLabel} matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)`);
        }
      } else if (anyVerifiable) {
        /* Verifiable-absent in every tree → real contradiction. Unverifiable-everywhere is skipped below. */
        absentKeys.add(selectorKey(sel));
        const roleLabel = sel.role ?? sel.kind;
        const nameLabel = sel.name ? ` "${sel.name}"` : "";
        const presentRoles = [...new Set(trees.flatMap((t) => t.map((l) => l.split(":")[0]?.trim())).filter(Boolean))].join(", ");
        contradictions.push(
          `${roleLabel}:${nameLabel} is NOT in the captured ${treeLabel} tree. Present roles: ${presentRoles || "(none)"}`,
        );
      } else {
        /* Neither present nor verifiable-absent → unverifiable (role never appeared with a real name). Not a contradiction; uniqueness cannot be trusted. */
        anyUnverifiable = true;
      }
    }
  }
  return { contradictions, absentKeys, anyVerifiedPresent, anyNonExtractable, anyUnverifiable };
}
