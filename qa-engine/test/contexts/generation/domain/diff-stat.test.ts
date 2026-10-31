import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStat } from "@contexts/generation/domain/diff-stat.ts";

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
