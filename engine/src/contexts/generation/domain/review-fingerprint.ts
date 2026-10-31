/*
 * What a review round judges: the spec source with comments removed. Two rounds whose specs differ
 * only in comments or whitespace test the same thing, so the second round must not re-review them —
 * the previous rejection stands. The key is deterministic and app-agnostic: every spec file, its
 * path, and its normalized source. A material change (a selector, an assertion, a step) changes the
 * key; a comment-only change does not.
 */

export interface ReviewSpecText {
  file: string;
  text: string;
}

/*
 * Drop comments and collapse whitespace. Full-line `//` comments and `/* ... *\/` blocks are the
 * shapes a regeneration adds when it explains itself; trailing `//` comments are left in place
 * because telling one from a URL inside a string needs a parser, and treating that change as
 * material only costs one extra review (it never rejects a changed spec).
 */
export function normalizeSpecForReview(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlocks
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/^\s*\*(?:\s|$)/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The material identity of a whole review round: files sorted, each with its normalized source. */
export function reviewSpecsKey(specs: readonly ReviewSpecText[]): string {
  return specs
    .map((spec) => ({ file: spec.file, text: normalizeSpecForReview(spec.text) }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((spec) => `${spec.file}\u0000${spec.text}`)
    .join("\u0001");
}

/** Whether two rounds' specs are materially the same (same files, same non-comment source). */
export function sameReviewedSpecs(previous: readonly ReviewSpecText[], current: readonly ReviewSpecText[]): boolean {
  return previous.length > 0 && previous.length === current.length && reviewSpecsKey(previous) === reviewSpecsKey(current);
}

const DEFAULT_SPEC_CHANGE_MAX_CHARS = 3_000;

/* The lines that actually changed, as a bounded unified-ish excerpt. Nothing is inferred: the common
 * prefix and suffix are skipped, the middle is shown as removed and added lines. */
function changeLines(previous: string, current: string, maxChars: number): string {
  const before = previous.split("\n");
  const after = current.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
    endBefore--;
    endAfter--;
  }
  const removed = before.slice(start, endBefore + 1).map((line) => `- ${line}`);
  const added = after.slice(start, endAfter + 1).map((line) => `+ ${line}`);
  const lines = [`@@ line ${start + 1} @@`, ...removed, ...added];
  const rendered = lines.join("\n");
  return rendered.length <= maxChars ? rendered : `${rendered.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n… (change truncated)`;
}

/*
 * What the reviewer is shown on a second round: only the specs that materially changed, and only
 * their changed lines. An unchanged file is omitted, an added one is named as new, a removed one as
 * removed. Bounded so the focus never becomes a second copy of the suite.
 */
export function renderSpecChanges(
  previous: readonly ReviewSpecText[],
  current: readonly ReviewSpecText[],
  maxChars: number = DEFAULT_SPEC_CHANGE_MAX_CHARS,
): string {
  const before = new Map(previous.map((spec) => [spec.file, spec]));
  const after = new Map(current.map((spec) => [spec.file, spec]));
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  const blocks: string[] = [];
  for (const file of files) {
    const was = before.get(file);
    const now = after.get(file);
    if (was && now && normalizeSpecForReview(was.text) === normalizeSpecForReview(now.text)) continue;
    if (!was && now) {
      blocks.push(`### ${file} (new file)\n${changeLines("", now.text, 800)}`);
      continue;
    }
    if (was && !now) {
      blocks.push(`### ${file} (removed)`);
      continue;
    }
    if (was && now) blocks.push(`### ${file}\n${changeLines(was.text, now.text, 1_200)}`);
  }
  if (blocks.length === 0) return "";
  const rendered = blocks.join("\n\n");
  return rendered.length <= maxChars ? rendered : `${rendered.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n… (change list truncated)`;
}
