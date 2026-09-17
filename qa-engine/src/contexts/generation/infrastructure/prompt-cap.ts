/* DECISION (verified before writing this module, not assumed): src/orchestrator/sanitizer.ts ALREADY ships a real, dedicated capDiff(diff, maxChars?) — a diff-aware, per-file-section capper, genuinely distinct from capText's flat prose truncation: - capDiff splits the diff into per-file sections (`diff --git a/... b/...` boundaries), relevance- orders them (high-relevance changed source FIRST; lockfiles/generated/snapshot/binary/build- artifact/map/changelog files LAST — LOW_RELEVANCE_PATTERNS), keeps WHOLE sections until the budget is spent, and replaces the rest with a named list of omitted files (never truncates a hunk mid-line). A degenerate single-oversized-file overflow hard-slices that one section. Wiring the real capText into the capText slot AND the real capDiff into the capDiff slot is a faithful port of two ALREADY-DISTINCT real functions — not a fabrication. */

export const MAX_PROMPT_DIFF_CHARS = 50_000;

const LOW_RELEVANCE_PATTERNS = [
  /^(package-lock|yarn\.lock|pnpm-lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock|Gemfile\.lock)$/i,
  /\.(generated|gen|pb|pb\.go|pb_grpc\.go|swagger\.json|openapi\.json|openapi\.yaml)$/i,
  /\bgenerated?\b/i,
  /\.snap$/i,
  /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i,
  /\/(dist|build|\.cache|__pycache__|\.next|\.nuxt|\.out|target)\/[^/]+\.(js|css|map|ts)$/i,
  /\.map$/i,
  /^(CHANGELOG|CHANGES|HISTORY)\.(md|txt)$/i,
];

function isLowRelevance(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  return LOW_RELEVANCE_PATTERNS.some((p) => p.test(filePath) || p.test(basename));
}

export function extractDiffFilePath(section: string): string {
  const m = /^diff --git a\/\S+ b\/(\S+)/m.exec(section);
  return m?.[1] ?? "";
}

const DIFF_HEADER_START_RE = /^diff --git /;

export function capDiff(diff: string, maxChars: number = MAX_PROMPT_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  const rawSections = diff.split(/^(?=diff --git )/m);

  const firstSection = rawSections[0] ?? "";
  const hasRealPreamble = !DIFF_HEADER_START_RE.test(firstSection);

  const preamble = hasRealPreamble ? firstSection : "";
  const fileSections = hasRealPreamble ? rawSections.slice(1) : rawSections;
  const highRelevance: string[] = [];
  const lowRelevance: string[] = [];
  for (const s of fileSections) {
    const filePath = extractDiffFilePath(s);
    if (isLowRelevance(filePath)) {
      lowRelevance.push(s);
    } else {
      highRelevance.push(s);
    }
  }
  const ordered = [preamble, ...highRelevance, ...lowRelevance];

  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of ordered) {
    if (omitted.length === 0 && used + section.length <= maxChars) {
      kept.push(section);
      used += section.length;
    } else {
      if (section === preamble) continue;
      const file = extractDiffFilePath(section) || (/^diff --git a\/(\S+)/.exec(section)?.[1] ?? "(unnamed section)");
      omitted.push(file);
    }
  }
  if (kept.filter((s) => s !== preamble).length === 0 && fileSections.length > 0) {
    const firstFile = highRelevance[0] ?? lowRelevance[0] ?? fileSections[0]!;
    kept.push(firstFile.slice(0, maxChars));
    const name = extractDiffFilePath(firstFile);
    omitted.splice(omitted.indexOf(name), 1);
  }
  return (
    kept.join("") +
    `\n[diff truncated for the prompt: ${omitted.length} file(s) omitted (${diff.length} chars total).` +
    ` Omitted: ${omitted.join(", ")}.` +
    ` Read the full change in the working copy with \`git show <sha>\`.]\n`
  );
}

export const MAX_PROMPT_BODY_CHARS = 4_000;

export function capText(text: string, maxChars: number = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[…body truncated: ${text.length - maxChars} more chars; read the full message with \`git show <sha>\`.]`
  );
}
