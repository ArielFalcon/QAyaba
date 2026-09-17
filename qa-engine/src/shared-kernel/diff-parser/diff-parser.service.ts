/* Canonical unified-diff parser. Git-status parsers are not diffs and stay in their own contexts. Pure: no I/O, no spawn, deterministic. */
import type { ChangedLines } from "./changed-lines.ts";
import type { ChangedElement } from "./changed-element.ts";

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
          const p = raw.slice(4).trim();
          file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
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
  changedElements(diff: string): ChangedElement[] {
    if (!diff) return [];

    const hunkLines = this.changedLines(diff);
    if (hunkLines.size === 0) return [];

    const results: ChangedElement[] = [];

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
          const p = raw.slice(4).trim();
          file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
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
        if (el) results.push(el);

      } else if (c === "-") {
        /* old side — does not advance new-file counter */
      } else if (c === "\\") {
        /* "\ No newline at end of file" */
      } else {
        newLine++;
      }
    }

    return results;
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

  if (!hasHtmlSignal) return null;

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

  if (!hasSignal) return null;
  return el as ChangedElement;
}

/* Standalone stopwords produce false-positive text-fallback matches. Quoted multi-word phrases are not filtered. */
const GUIDANCE_STOPWORDS = new Set([
  "test", "tests", "form", "forms", "page", "pages",
  "button", "buttons", "link", "links",
  "click", "check", "verify", "ensure", "should",
  "with", "flow", "screen", "field", "fields",
  "input", "submit", "smoke", "the", "and",
]);
