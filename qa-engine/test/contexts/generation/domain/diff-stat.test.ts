import { test } from "node:test";
import assert from "node:assert/strict";
import { DIFF_TIER_NAMES, DIFF_TIERS, diffStat, diffTier, type DiffStat } from "@contexts/generation/domain/diff-stat.ts";

const HEADERS = (path: string): string[] => [
  `diff --git a/${path} b/${path}`,
  "index 1111111..2222222 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
];

test("added and removed lines are counted from the hunks, and file headers are not lines", () => {
  const diff = [...HEADERS("src/a.ts"), "@@ -1,3 +1,4 @@", " keep", "-old one", "-old two", "+new one", "+new two", "+new three", ""].join("\n");
  assert.deepEqual(diffStat({ diff, changedFiles: ["src/a.ts"] }), { files: 1, added: 3, removed: 2 });
});

test("a content line that starts like a header is still a content line inside a hunk", () => {
  const diff = [...HEADERS("src/a.ts"), "@@ -1,1 +1,2 @@", "--- a comment marker", "+++counter", ""].join("\n");
  assert.deepEqual(diffStat({ diff, changedFiles: ["src/a.ts"] }), { files: 1, added: 1, removed: 1 });
});

test("several files add up, each file's headers stay out of the count", () => {
  const diff = [
    ...HEADERS("src/a.ts"),
    "@@ -1 +1 @@",
    "-a",
    "+A",
    ...HEADERS("src/b.ts"),
    "@@ -5,2 +5,3 @@",
    " x",
    "+y",
    "+z",
    "",
  ].join("\n");
  assert.deepEqual(diffStat({ diff, changedFiles: ["src/a.ts", "src/b.ts"] }), { files: 2, added: 3, removed: 1 });
});

test("new, deleted and renamed file headers add no lines", () => {
  const diff = [
    "diff --git a/n.ts b/n.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/n.ts",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/o.ts b/p.ts",
    "similarity index 100%",
    "rename from o.ts",
    "rename to p.ts",
    "",
  ].join("\n");
  assert.deepEqual(diffStat({ diff, changedFiles: ["n.ts", "p.ts"] }), { files: 2, added: 2, removed: 0 });
});

test("the file count comes from the changed files, and from the diff's file headers when they are unknown", () => {
  const diff = [...HEADERS("src/a.ts"), "@@ -1 +1 @@", "+x", ...HEADERS("src/b.ts"), "@@ -1 +1 @@", "-y", ""].join("\n");
  assert.equal(diffStat({ diff, changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] }).files, 3);
  assert.equal(diffStat({ diff }).files, 2);
  assert.equal(diffStat({ diff, changedFiles: [] }).files, 2);
});

test("a header-less snippet counts its plus and minus lines and an empty diff counts nothing", () => {
  assert.deepEqual(diffStat({ diff: "+export function foo() {}\n-old\n" }), { files: 0, added: 1, removed: 1 });
  assert.deepEqual(diffStat({ diff: "" }), { files: 0, added: 0, removed: 0 });
});

test("an added line that merely mentions a file-side marker mid-line is still an added line", () => {
  assert.deepEqual(diffStat({ diff: "+note --- and +++ inside a line\n-was --- too\n" }), { files: 0, added: 1, removed: 1 });
});

test("a plain unified diff without a git header reads its file sides as headers, not as lines", () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", "-a", "+b", "+c", ""].join("\n");
  assert.deepEqual(diffStat({ diff }), { files: 0, added: 2, removed: 1 });
});

test("a hunk header that carries trailing context still opens the hunk", () => {
  const diff = [...HEADERS("src/a.ts"), "@@ -1,2 +1,3 @@ export class Cart {", "--- a comment marker", "+++counter", ""].join("\n");
  assert.deepEqual(diffStat({ diff, changedFiles: ["src/a.ts"] }), { files: 1, added: 1, removed: 1 });
});

test("a diff with no trailing newline and a file header only still counts correctly", () => {
  assert.deepEqual(diffStat({ diff: [...HEADERS("a.ts"), "@@ -1 +1 @@", "+x"].join("\n"), changedFiles: ["a.ts"] }), { files: 1, added: 1, removed: 0 });
});

/* ── the tier a change falls in ── */

/* A change of the given size: its files, and the lines it adds. */
const sized = (files: number, lines: number, removed = 0): DiffStat => ({ files, added: lines, removed });

test("a change at the limits of the tiny tier is tiny, and one file or one line past either limit is focused", () => {
  const { maxFiles, maxLines } = DIFF_TIERS.tiny;
  assert.equal(diffTier(sized(maxFiles, maxLines)), "tiny", "at both limits");
  assert.equal(diffTier(sized(maxFiles - 1, maxLines - 1)), "tiny", "below both limits");
  assert.equal(diffTier(sized(maxFiles + 1, maxLines)), "focused", "one file past");
  assert.equal(diffTier(sized(maxFiles, maxLines + 1)), "focused", "one line past");
});

test("a change at the limits of the focused tier is focused, and one file or one line past either limit is broad", () => {
  const { maxFiles, maxLines } = DIFF_TIERS.focused;
  assert.equal(diffTier(sized(maxFiles, maxLines)), "focused", "at both limits");
  assert.equal(diffTier(sized(maxFiles + 1, maxLines)), "broad", "one file past");
  assert.equal(diffTier(sized(maxFiles, maxLines + 1)), "broad", "one line past");
});

test("each limit decides on its own: many files with one line, and one file with many lines, leave the tier they would otherwise fit", () => {
  assert.equal(diffTier(sized(DIFF_TIERS.focused.maxFiles + 1, 1)), "broad", "files alone");
  assert.equal(diffTier(sized(1, DIFF_TIERS.focused.maxLines + 1)), "broad", "lines alone");
  assert.equal(diffTier(sized(DIFF_TIERS.tiny.maxFiles + 1, 1)), "focused", "files alone, past tiny");
  assert.equal(diffTier(sized(1, DIFF_TIERS.tiny.maxLines + 1)), "focused", "lines alone, past tiny");
});

test("the lines of a tier are the lines a change adds plus the lines it removes", () => {
  const { maxFiles, maxLines } = DIFF_TIERS.tiny;
  assert.equal(diffTier(sized(maxFiles, 1, maxLines - 1)), "tiny", "split between the two sides, at the limit");
  assert.equal(diffTier(sized(maxFiles, 1, maxLines)), "focused", "one past, with the excess on the removed side");
  assert.equal(diffTier(sized(maxFiles, maxLines, 1)), "focused", "one past, with the excess on the added side");
});

test("an empty diff is tiny", () => {
  assert.equal(diffTier({ files: 0, added: 0, removed: 0 }), "tiny");
  assert.equal(diffTier(diffStat({ diff: "" })), "tiny");
});

test("the tiers are nested, and the declared names run from the smallest change to the largest", () => {
  assert.ok(DIFF_TIERS.tiny.maxFiles <= DIFF_TIERS.focused.maxFiles, "a larger tier never admits fewer files");
  assert.ok(DIFF_TIERS.tiny.maxLines <= DIFF_TIERS.focused.maxLines, "a larger tier never admits fewer lines");
  const smallestToLargest = [sized(0, 0), sized(DIFF_TIERS.tiny.maxFiles + 1, 1), sized(DIFF_TIERS.focused.maxFiles + 1, 1)];
  assert.deepEqual(smallestToLargest.map((stat) => DIFF_TIER_NAMES.indexOf(diffTier(stat))), [0, 1, 2]);
});

test("a tier is read from the size a diff really shows", () => {
  const files = DIFF_TIERS.tiny.maxFiles + 1;
  const paths = Array.from({ length: files }, (_, i) => `src/f${i}.ts`);
  const diff = paths.flatMap((p) => [...HEADERS(p), "@@ -1 +1 @@", "+x"]).join("\n") + "\n";
  assert.equal(diffTier(diffStat({ diff, changedFiles: paths })), "focused");
  assert.equal(diffTier(diffStat({ diff: [...HEADERS("src/a.ts"), "@@ -1 +1 @@", "+x", ""].join("\n"), changedFiles: ["src/a.ts"] })), "tiny");
});
