import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

const svc = new DiffParserService();

const diffOf = (file: string, tab: string): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}${tab}`, `+++ b/${file}${tab}`, "@@ -1,1 +1,2 @@", '-<b label="Texto viejo">', ' <p>', '+<b label="Texto nuevo">'].join("\n");

for (const [name, tab] of [["a path with a space", ""], ["a path with a space that git ends with a tab", "\t"]] as const) {
  test(`labels and changed lines agree on ${name}`, () => {
    const file = "web/mi pagina/lista.html";
    const d = diffOf(file, tab);
    const changedFiles = [...svc.changedLines(d).keys()];
    assert.deepEqual(changedFiles, [file]);
    const literals = svc.changedLiterals(d);
    assert.deepEqual(literals.map((l) => [l.file, l.value, l.side]), [
      [file, "Texto nuevo", "added"],
      [file, "Texto viejo", "removed"],
    ]);
    assert.equal(svc.changedElements(d).find((e) => e.text === "Texto nuevo")?.file, file);
  });
}

test("a deleted file keeps the path of its old side for its removed labels", () => {
  const d = ["diff --git a/web/mi pagina/viejo.html b/web/mi pagina/viejo.html", "--- a/web/mi pagina/viejo.html", "+++ /dev/null", "@@ -1,1 +0,0 @@", '-<b label="Texto viejo">'].join("\n");
  assert.deepEqual(svc.changedLiterals(d).map((l) => [l.file, l.side]), [["web/mi pagina/viejo.html", "removed"]]);
});

test("a rename keeps the new path for added labels", () => {
  const d = ["diff --git a/a.html b/b c.html", "similarity index 90%", "rename from a.html", "rename to b c.html", "--- a/a.html", "+++ b/b c.html", "@@ -1,1 +1,1 @@", '-<b label="Texto viejo">', '+<b label="Texto nuevo">'].join("\n");
  assert.deepEqual(svc.changedLiterals(d).filter((l) => l.side === "added").map((l) => l.file), ["b c.html"]);
});
