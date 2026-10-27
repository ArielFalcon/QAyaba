/* The static decision listing: from a changed file's source text and its changed lines, the decisions whose head a changed line holds, each with its kind and its arms' lines, through the lister the language registry declares for the file's language. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { listDecisions } from "../../src/shared-infrastructure/decision-listing.ts";

const lines = (...n: number[]): Set<number> => new Set(n);

test("an if with an else lists both arms at the lines their code starts on", () => {
  const source = ["function f(a) {", "  if (a > 1) {", "    return 1;", "  } else {", "    return 2;", "  }", "}"].join("\n");
  assert.deepEqual(listDecisions("src/f.ts", source, lines(2)), {
    decisions: [{ file: "src/f.ts", line: 2, kind: "if", arms: [{ label: "then", line: 2 }, { label: "else", line: 4 }] }],
  });
});

test("an if with no else lists the implicit else as an arm with no code of its own", () => {
  const source = ["function f(a) {", "  if (a)", "    go();", "  done();", "}"].join("\n");
  assert.deepEqual(listDecisions("src/f.js", source, lines(2)), {
    decisions: [{ file: "src/f.js", line: 2, kind: "if", arms: [{ label: "then", line: 3 }, { label: "else" }] }],
  });
});

test("a conditional expression lists its true and false arms", () => {
  const source = ["const label = items.length > 0", "  ? `${items.length} items`", "  : 'empty';"].join("\n");
  assert.deepEqual(listDecisions("src/label.ts", source, lines(1)), {
    decisions: [{ file: "src/label.ts", line: 1, kind: "conditional", arms: [{ label: "true", line: 2 }, { label: "false", line: 3 }] }],
  });
});

test("each logical operator (&&, ||, ??) is a decision whose short circuit has no code of its own", () => {
  const source = ["const a = x && y;", "const b = x || y;", "const c = x ?? y;"].join("\n");
  assert.deepEqual(listDecisions("src/l.ts", source, lines(1, 2, 3)), {
    decisions: [
      { file: "src/l.ts", line: 1, kind: "logical", arms: [{ label: "right of && evaluated", line: 1 }, { label: "&& short-circuited" }] },
      { file: "src/l.ts", line: 2, kind: "logical", arms: [{ label: "right of || evaluated", line: 2 }, { label: "|| short-circuited" }] },
      { file: "src/l.ts", line: 3, kind: "logical", arms: [{ label: "right of ?? evaluated", line: 3 }, { label: "?? short-circuited" }] },
    ],
  });
});

test("a switch lists one arm per clause, the default included", () => {
  const source = ["switch (status) {", "  case 'open':", "    return 1;", "  case 'closed':", "    return 2;", "  default:", "    return 0;", "}"].join("\n");
  assert.deepEqual(listDecisions("src/s.ts", source, lines(1)), {
    decisions: [{ file: "src/s.ts", line: 1, kind: "switch", arms: [{ label: "case 'open'", line: 2 }, { label: "case 'closed'", line: 4 }, { label: "default", line: 6 }] }],
  });
});

test("a switch whose only changed line is a case label is a changed decision", () => {
  const source = ["switch (status) {", "  case 'open':", "    return 1;", "  case 'new':", "    return 3;", "}"].join("\n");
  const listed = listDecisions("src/s.ts", source, lines(4, 5));
  assert.ok("decisions" in listed);
  assert.deepEqual(listed.decisions.map((d) => [d.kind, d.line]), [["switch", 1]]);
});

test("a decision whose head a changed line does not hold is not listed, even when an arm changed", () => {
  const source = ["if (a) {", "  b();", "  c();", "}"].join("\n");
  assert.deepEqual(listDecisions("src/f.ts", source, lines(3)), { decisions: [] });
});

test("a condition spread over lines counts when any of its lines changed, at the line the condition starts on", () => {
  const source = ["if (", "  ready", "  && open", ") {", "  go();", "}"].join("\n");
  const listed = listDecisions("src/f.ts", source, lines(3));
  assert.ok("decisions" in listed);
  assert.deepEqual(listed.decisions.map((d) => [d.kind, d.line]), [["if", 2], ["logical", 2]]);
});

test("an if whose only changed line is its keyword line is a changed decision", () => {
  const source = ["if (", "  ready", ") {", "  go();", "}"].join("\n");
  const listed = listDecisions("src/f.ts", source, lines(1));
  assert.ok("decisions" in listed);
  assert.deepEqual(listed.decisions.map((d) => [d.kind, d.line]), [["if", 2]]);
});

test("a JSX conditional in a component file is listed", () => {
  const source = ["export const C = ({ n }) => (", "  <ul>{n > 0 ? <li>{n}</li> : <li>none</li>}</ul>", ");"].join("\n");
  const listed = listDecisions("src/C.tsx", source, lines(2));
  assert.ok("decisions" in listed);
  assert.deepEqual(listed.decisions.map((d) => d.kind), ["conditional"]);
});

test("a file that does not parse lists nothing and says it did not parse", () => {
  assert.deepEqual(listDecisions("src/broken.ts", "if (a { b(); ", lines(1)), { unparsed: true });
});

test("a language with no declared lister states nothing", () => {
  const source = ["class A {", "  int f(int a) {", "    if (a > 1) return 1;", "    return 0;", "  }", "}"].join("\n");
  assert.deepEqual(listDecisions("src/A.java", source, lines(3)), { unlisted: true });
  assert.deepEqual(listDecisions("src/page.html", "<p></p>", lines(1)), { unlisted: true });
});
