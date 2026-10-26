/* What a mutant's re-run ran, put back on the served script: the edit undone in the text, every offset after it moved back, so the lines and arms the mutant made run are those of the script the coverage saw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { undoMutant } from "@contexts/objective-signal/infrastructure/undo-mutant.ts";
import { defaultParseV8Coverage } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

const SERVED = "if (a) {\n  yes();\n}\nafter();\n";
const URL = "https://dev.example/src/svc.ts";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/* The negated condition: `a` (bytes 4..5) becomes `!(a)`, three bytes longer. */
const MUTANT = { url: URL, sha256: sha(SERVED), edit: { start: 4, end: 5, replacement: "!(a)" }, original: "a" };
const MUTATED = SERVED.slice(0, 4) + "!(a)" + SERVED.slice(5);

test("a dump of the mutated script is read on the served script's own lines: what the mutant made run lands where it is in the repository", () => {
  /* Under the mutant the then-block ran and `after();` did not. */
  const yes = MUTATED.indexOf("  yes();");
  const after = MUTATED.indexOf("after();");
  const entries = [{ url: URL, source: MUTATED, functions: [{ ranges: [{ startOffset: 0, endOffset: MUTATED.length, count: 1 }, { startOffset: yes, endOffset: yes + 9, count: 1 }, { startOffset: after, endOffset: MUTATED.length, count: 0 }] }] }];

  const [undone] = undoMutant(entries, MUTANT);

  assert.equal(undone!.source, SERVED);
  assert.deepEqual(undone!.functions![0]!.ranges!.map((r) => [r.startOffset, r.endOffset]), [[0, SERVED.length], [SERVED.indexOf("  yes();"), SERVED.indexOf("  yes();") + 9], [SERVED.indexOf("after();"), SERVED.length]]);
  assert.deepEqual([...defaultParseV8Coverage(undoMutant(entries, MUTANT), ["src/svc.ts"]).get("src/svc.ts")!], [1, 2, 3], "after() did not run");
});

test("an entry of another script is kept as it is, the served script itself is kept, and a text that is neither is left out", () => {
  const other = { url: "https://dev.example/other.js", source: "x();", functions: [] };
  const served = { url: URL, source: SERVED, functions: [] };
  const foreign = { url: URL, source: "something else", functions: [] };

  assert.deepEqual(undoMutant([other, served, foreign], MUTANT), [other, served]);
});
