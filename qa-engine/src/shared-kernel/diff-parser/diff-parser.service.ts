/* Canonical unified-diff parser. Git-status parsers are not diffs and stay in their own contexts. Pure: no I/O, no spawn, deterministic. */
import type { ChangedLines } from "./changed-lines.ts";
import type { ChangedElement } from "./changed-element.ts";
import {
  labelLiteralsOfLine,
  MAX_ADDED_LITERALS,
  MAX_ADDED_LITERALS_IN_ALL,
  MAX_REMOVED_LITERALS,
  MAX_REMOVED_LITERALS_IN_ALL,
  type ChangedLiteral,
} from "./changed-literal.ts";

/* A literal with the line it was read from. */
interface ScannedLiteral extends ChangedLiteral {
  raw: string;
}

export class DiffParserService {
  /* Added/modified lines per file, numbered on the new side. Pure deletions contribute nothing. */
  changedLines(diff: string): ChangedLines {
    const changed: ChangedLines = new Map();
    let file: string | null = null;
    let newLine = 0;
    let inHunk = false;
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("diff --git")) { file = null; inHunk = false; continue; }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
      if (!inHunk) {
        if (raw.startsWith("+++ ")) {
          file = headerPath(raw);
        }
        continue;
      }
      if (file === null) continue;
      const c = raw[0];
      if (c === "+") {
        let set = changed.get(file);
        if (!set) changed.set(file, (set = new Set()));
        set.add(newLine);
        newLine++;
      } else if (c === "-") { /* old side only */ }
      else if (c === "\\") { /* "\ No newline at end of file" */ }
      else { newLine++; }
    }
    return changed;
  }

  /* The new-side lines a diff touched per file: every added line, and for a deletion the line that follows it on the new side (the place the removed code was). A pure deletion of a file touches nothing on the new side. */
  touchedLines(diff: string): ChangedLines {
    const touched: ChangedLines = new Map();
    let file: string | null = null;
    let newLine = 0;
    let inHunk = false;
    const mark = (line: number): void => {
      if (file === null) return;
      let set = touched.get(file);
      if (!set) touched.set(file, (set = new Set()));
      set.add(line);
    };
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("diff --git")) { file = null; inHunk = false; continue; }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
      if (!inHunk) {
        if (raw.startsWith("+++ ")) file = headerPath(raw);
        continue;
      }
      const c = raw[0];
      if (c === "+") { mark(newLine); newLine++; }
      else if (c === "-") mark(Math.max(1, newLine));
      else if (c === "\\") { /* "\ No newline at end of file" */ }
      else newLine++;
    }
    return touched;
  }

  /* Every changed path from `diff --git a/X b/Y` headers (added, modified, deleted). Prefer the b/ side, fall back to a/. */
  changedFiles(diff: string): string[] {
    const files: string[] = [];
    for (const line of diff.split("\n")) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
      if (m) files.push(m[2] ?? m[1]!);
    }
    return files;
  }

  /* Only files present on both sides (modified). A pure add (--- /dev/null) or pure delete (+++ /dev/null) is excluded. */
  modifiedFiles(diff: string): string[] {
    const files: string[] = [];
    let basePath: string | null = null;
    let headPath: string | null = null;
    let afterDiffGit = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        if (basePath !== null && headPath !== null) files.push(headPath);
        afterDiffGit = true; basePath = null; headPath = null;
        continue;
      }
      if (!afterDiffGit) continue;
      if (line.startsWith("--- a/")) { basePath = line.slice(6).trim(); continue; }
      if (line.startsWith("+++ b/")) { headPath = line.slice(6).trim(); continue; }
      if (line.startsWith("@@")) afterDiffGit = false;
    }
    if (basePath !== null && headPath !== null) files.push(headPath);
    return files;
  }

  /* Two-pass by contract: pass 1 owns line-number truth; pass 2 extracts HTML selector signals from `+` content with the same advance rules. Do not collapse to a single pass — that silently diverges line numbering across hunks and interleaved deletions. */
  changedElements(diff: string, options: { quotedLabels?: boolean } = {}): ChangedElement[] {
    if (!diff) return [];

    const hunkLines = this.changedLines(diff);
    if (hunkLines.size === 0) return [];

    const results: ChangedElement[] = [];
    /* The lines that gave an element: a quoted label is read only from a line that gave none. */
    const lineHasElement = new Set<string>();

    let file: string | null = null;
    let newLine = 0;
    let inHunk = false;

    for (const raw of diff.split("\n")) {
      if (results.length >= MAX_ELEMENTS) break;

      if (raw.startsWith("diff --git")) {
        file = null;
        inHunk = false;
        continue;
      }

      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }

      if (!inHunk) {
        if (raw.startsWith("+++ ")) {
          file = headerPath(raw);
        }
        continue;
      }

      if (file === null) continue;

      const c = raw[0];
      if (c === "+") {
        const content = raw.slice(1);
        const trimmed = content.trim();
        const lineNum = newLine;
        newLine++;

        if (trimmed.length === 0) continue;

        const el = extractSignalsFromLine(trimmed, file, lineNum);
        if (el) {
          results.push(el);
          lineHasElement.add(`${file}\u0000${lineNum}`);
        }

      } else if (c === "-") {
        /* old side — does not advance new-file counter */
      } else if (c === "\\") {
        /* "\ No newline at end of file" */
      } else {
        newLine++;
      }
    }

    /* A label that sits on a line of its own (an attribute of a component, a constant, a template string) has no tag to read a role from: it is an element by its text alone. */
    for (const { added } of options.quotedLabels === false ? [] : this.scanLiterals(diff)) {
      for (const literal of added) {
        if (results.length >= MAX_ELEMENTS) break;
        if (lineHasElement.has(`${literal.file}\u0000${literal.line}`)) continue;
        results.push({ file: literal.file, line: literal.line, text: literal.value, raw: literal.raw });
      }
    }

    return results;
  }

  /* The quoted labels a diff added and removed, whatever language it is written in: the string literals of its added and removed lines that a page could show as text (see `isLabelLike`). A value that is on both sides of the same file only moved, so it is no change. Each file reports each value once per side, within its own cap, and the files are taken in turn up to the ceiling of the whole diff, so the first files of a diff cannot crowd out the rest. With `preferFiles` (the changed files a map links to pages), only their labels are kept when any of them has one. */
  changedLiterals(diff: string, options: { preferFiles?: ReadonlySet<string> } = {}): ChangedLiteral[] {
    const perFile = this.scanLiterals(diff);
    const prefer = options.preferFiles;
    const linked = prefer && prefer.size > 0 ? perFile.filter((entry) => prefer.has(entry.file)) : [];
    const chosen = linked.length > 0 ? linked : perFile;
    return [
      ...takeInTurn(chosen.map((entry) => entry.added), MAX_ADDED_LITERALS_IN_ALL),
      ...takeInTurn(chosen.map((entry) => entry.removed), MAX_REMOVED_LITERALS_IN_ALL),
    ].map(({ raw: _raw, ...literal }) => literal);
  }

  /* The labels of each file of the diff that has any, each side bounded per file. */
  private scanLiterals(diff: string): Array<{ file: string; added: ScannedLiteral[]; removed: ScannedLiteral[] }> {
    if (!diff) return [];
    const files = new Map<string, { added: ScannedLiteral[]; removed: ScannedLiteral[] }>();
    const of = (file: string): { added: ScannedLiteral[]; removed: ScannedLiteral[] } => {
      let entry = files.get(file);
      if (!entry) files.set(file, (entry = { added: [], removed: [] }));
      return entry;
    };
    /* The path of each side comes from the `---` and `+++` header lines, as `changedLines` reads it, so that both name a file the same way whatever its name holds. */
    let oldFile: string | null = null;
    let newFile: string | null = null;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("diff --git")) {
        oldFile = null;
        newFile = null;
        inHunk = false;
        continue;
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        if (raw.startsWith("--- ")) oldFile = headerPath(raw);
        else if (raw.startsWith("+++ ")) newFile = headerPath(raw);
        continue;
      }
      const c = raw[0];
      if (c === "+") {
        if (newFile !== null) for (const value of labelLiteralsOfLine(raw.slice(1))) of(newFile).added.push({ file: newFile, line: newLine, value, side: "added", raw: raw.slice(1).trim() });
        newLine++;
      } else if (c === "-") {
        const file = newFile ?? oldFile;
        if (file !== null) for (const value of labelLiteralsOfLine(raw.slice(1))) of(file).removed.push({ file, line: oldLine, value, side: "removed", raw: raw.slice(1).trim() });
        oldLine++;
      } else if (c !== "\\") {
        oldLine++;
        newLine++;
      }
    }
    const firstOfEach = (literals: readonly ScannedLiteral[], max: number): ScannedLiteral[] => {
      const seen = new Set<string>();
      return literals.filter((literal) => !seen.has(literal.value) && seen.add(literal.value)).slice(0, max);
    };
    return [...files.entries()]
      .map(([name, entry]) => {
        /* A value on both sides of the same file only moved. */
        const movedValues = new Set(entry.added.filter((a) => entry.removed.some((r) => r.value === a.value)).map((a) => a.value));
        return {
          file: name,
          added: firstOfEach(entry.added.filter((literal) => !movedValues.has(literal.value)), MAX_ADDED_LITERALS),
          removed: firstOfEach(entry.removed.filter((literal) => !movedValues.has(literal.value)), MAX_REMOVED_LITERALS),
        };
      })
      .filter((entry) => entry.added.length > 0 || entry.removed.length > 0);
  }

  /* Manual mode: quoted spans kept whole; standalone tokens must be ≥5 chars or a proper noun and not a QA stopword. Returns ChangedElement{ text } only. */
  changedElementsFromGuidance(guidance: string): ChangedElement[] {
    if (!guidance.trim()) return [];

    const phrases: string[] = [];

    const withoutQuotes = guidance.replace(/"([^"]+)"/g, (_m, p: string) => {
      phrases.push(p.trim());
      return " ";
    });

    const words = withoutQuotes.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-zA-Z0-9-]/g, "").trim();
      if (!cleaned) continue;
      const isProperNoun = /^[A-Z]/.test(cleaned);
      const isLongEnough = cleaned.length >= 5;
      const isStopword = GUIDANCE_STOPWORDS.has(cleaned.toLowerCase());
      if (isStopword) continue; /* stopwords are never emitted, even if uppercase */
      if (isLongEnough || isProperNoun) {
        phrases.push(cleaned);
      }
    }

    const seen = new Set<string>();
    const unique = phrases.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });

    return unique.map((phrase) => ({
      file: "",
      line: 0,
      text: phrase,
      raw: phrase,
    }));
  }
}

const MAX_ELEMENTS = 200;

/* The path a `--- ` or `+++ ` header line names: without the a/ or b/ prefix and the tab git puts after a name that holds a space, or null for /dev/null. */
function headerPath(headerLine: string): string | null {
  const p = headerLine.slice(4).trim();
  return p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

/* The first `max` entries of the lists taken one from each in turn, a value taken once: every list keeps a share before any keeps more. */
function takeInTurn(lists: ReadonlyArray<readonly ScannedLiteral[]>, max: number): ScannedLiteral[] {
  const taken: ScannedLiteral[] = [];
  const seen = new Set<string>();
  for (let round = 0; taken.length < max && lists.some((list) => round < list.length); round++) {
    for (const list of lists) {
      const literal = list[round];
      if (literal === undefined || seen.has(literal.value) || taken.length >= max) continue;
      seen.add(literal.value);
      taken.push(literal);
    }
  }
  return taken;
}

const TAG_TO_ROLE: Record<string, string> = {
  a: "link",
  button: "button",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  label: "label",
  input: "textbox",
  select: "combobox",
  textarea: "textbox",
};

function tagRole(tag: string): string | undefined {
  return TAG_TO_ROLE[tag.toLowerCase()];
}

const VISIBLE_TEXT_TAGS = new Set(["button", "a", "h1", "h2", "h3", "h4", "h5", "h6", "label"]);
function isVisibleTextTag(tag: string): boolean {
  const low = tag.toLowerCase();
  return VISIBLE_TEXT_TAGS.has(low) || low.startsWith("mat-");
}

function extractOpeningTag(line: string): string | null {
  const m = /<([a-zA-Z][a-zA-Z0-9-]*)/.exec(line);
  return m ? m[1]!.toLowerCase() : null;
}

function extractAttr(line: string, attr: string): string | undefined {
  const re = new RegExp(`\\b${attr}=["']([^"']+)["']`);
  const m = re.exec(line);
  return m ? m[1]! : undefined;
}

/* [routerLink]="'/path'" must be a string literal. Dynamic expressions → undefined. */
function extractBoundRouterLink(line: string): string | undefined {
  const m = /\[routerLink\]=["']'([^'"]+)'["']/.exec(line);
  return m ? m[1]! : undefined;
}

/* Undefined when the text contains Angular interpolation or template literals. */
function extractInnerText(line: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)<\\/(?:${tag}|)`, "i");
  const m = re.exec(line);
  if (!m) return undefined;
  const text = m[1]!.trim();
  if (!text) return undefined;
  if (text.includes("{{") || text.includes("${")) return undefined;
  return text;
}

function extractMatInnerText(line: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, "i");
  const m = re.exec(line);
  if (!m) return undefined;
  const text = m[1]!.trim();
  if (!text || text.includes("{{") || text.includes("${")) return undefined;
  return text;
}

function extractSignalsFromLine(
  line: string,
  file: string,
  lineNum: number,
): ChangedElement | null {
  const hasHtmlSignal =
    line.includes("<") ||
    /\b(?:data-cy|data-testid|data-test|id=|name=|href=|routerLink|formControlName)=/.test(line);

  if (!hasHtmlSignal) {
    const text = isMarkupFile(file) ? textAttributeOf(line) ?? bareTextOf(line) : undefined;
    return text === undefined ? null : { file, line: lineNum, text, raw: line };
  }

  const el: Partial<ChangedElement> & { file: string; line: number; raw: string } = {
    file,
    line: lineNum,
    raw: line,
  };
  let hasSignal = false;

  const testId = extractAttr(line, "data-cy") ?? extractAttr(line, "data-testid") ?? extractAttr(line, "data-test");
  if (testId) {
    el.testId = testId;
    hasSignal = true;
  }

  const idVal = extractAttr(line, "id");
  if (idVal) {
    el.id = idVal;
    hasSignal = true;
  }

  const nameVal = extractAttr(line, "name") ?? extractAttr(line, "formControlName");
  if (nameVal) {
    el.name = nameVal;
    hasSignal = true;
  }

  const hrefVal = extractAttr(line, "href");
  if (hrefVal && (hrefVal.startsWith("/") || hrefVal.startsWith("#"))) {
    el.href = hrefVal;
    hasSignal = true;
  }

  /* Bare relative routerLink="products" is ambiguous (DOM href renders as "/products") and would never join with a DOM attr — skip it. */
  if (!el.href) {
    const routerLinkRe = /\brouterLink=["']([^"']+)["']/.exec(line);
    if (routerLinkRe) {
      const val = routerLinkRe[1]!;
      if (val.startsWith("/") || val.startsWith("#")) {
        el.href = val;
        hasSignal = true;
      }
    }
  }

  if (!el.href) {
    const bound = extractBoundRouterLink(line);
    if (bound !== undefined) {
      el.href = bound;
      hasSignal = true;
    }
  }

  const tag = extractOpeningTag(line);
  if (tag && !el.text) {
    el.role = tagRole(tag);
    if (isVisibleTextTag(tag)) {
      const visibleText = tag.startsWith("mat-")
        ? extractMatInnerText(line, tag)
        : extractInnerText(line, tag);
      if (visibleText) {
        el.text = visibleText;
        hasSignal = true;
      }
    }
  }

  if (!el.text && isMarkupFile(file)) {
    const text = textAttributeOf(line);
    if (text !== undefined) {
      el.text = text;
      hasSignal = true;
    }
  }

  if (!hasSignal) return null;
  return el as ChangedElement;
}

/* Files whose lines are markup a page shows: templates and the components that hold their markup inline. */
const MARKUP_EXTENSIONS = /\.(?:html?|xhtml|vue|svelte|jsx|tsx|hbs|handlebars|ejs|jsp|jspx|ftl|mustache)$/i;
const isMarkupFile = (file: string): boolean => MARKUP_EXTENSIONS.test(file);

/* A literal attribute (`name="value"`, never a bound `[name]`, `:name` or `name={…}`): the first whose name says it holds text the page shows and whose value reads as such. */
const LITERAL_ATTR = /(?:^|\s)([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function textAttributeOf(line: string): string | undefined {
  for (const m of line.matchAll(LITERAL_ATTR)) {
    const value = (m[2] ?? m[3] ?? "").trim();
    if (isTextAttribute(m[1]!) && readsAsText(value)) return value;
  }
  return undefined;
}

/* Whether an attribute (or a component input or prop) of this name holds text the page shows to a person: an allow-list, since a style or config attribute taken for text would put a false [CHANGED] mark in the pack. A component input is matched by its camelCase suffix (`endActionLabel`, `emptyText`). */
const TEXT_ATTRIBUTES = new Set(["label", "title", "placeholder", "alt", "aria-label", "aria-description", "text", "caption", "heading", "header", "subtitle", "message", "tooltip", "summary"]);
const TEXT_SUFFIX = /[a-z0-9](?:Label|Text|Title|Placeholder|Caption|Heading|Header|Subtitle|Message|Tooltip|Summary)$/;
function isTextAttribute(name: string): boolean {
  return TEXT_ATTRIBUTES.has(name.toLowerCase()) || TEXT_SUFFIX.test(name);
}

/* Words a person reads: at least one letter, no interpolation, not an address. */
function readsAsText(value: string): boolean {
  return /\p{L}/u.test(value) && !/\{\{|\$\{/.test(value) && !/^(?:\/|#|\.|https?:|mailto:)/i.test(value);
}

/* A line that is only text (a multi-line element's content): no markup, code or comment on it. */
function bareTextOf(line: string): string | undefined {
  if (/^(?:\/\/|\/\*|\*|<!--|#|@)/.test(line) || /[<>=;(){}[\]]/.test(line)) return undefined;
  return readsAsText(line) ? line : undefined;
}

/* Standalone stopwords produce false-positive text-fallback matches. Quoted multi-word phrases are not filtered. */
const GUIDANCE_STOPWORDS = new Set([
  "test", "tests", "form", "forms", "page", "pages",
  "button", "buttons", "link", "links",
  "click", "check", "verify", "ensure", "should",
  "with", "flow", "screen", "field", "fields",
  "input", "submit", "smoke", "the", "and",
]);
