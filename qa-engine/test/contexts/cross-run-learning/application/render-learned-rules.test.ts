import type { RetrievedRule } from "@kernel/learned-rule";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLearnedRules, renderLearnedRulesForReviewer } from "@contexts/cross-run-learning/application/index.ts";

/* renderLearnedRules: proven (active) rules and experimental (candidate) hints go to separate
   sections, proven first, each rule carrying its trigger, action and error class. */

const activeRule: RetrievedRule = {
  id: "rule-active", trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL",
  status: "active", confidence: "high",
};
const candidateRule: RetrievedRule = {
  id: "rule-candidate", trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY",
  status: "candidate", confidence: "low",
};

/* The rendered markdown split into its "## " sections. */
function sections(rendered: string): Array<{ heading: string; body: string }> {
  return rendered
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [heading = "", ...rest] = chunk.split("\n");
      return { heading, body: rest.join("\n") };
    });
}
const isExperimental = (heading: string): boolean => /experimental|unproven/i.test(heading);

test("renderLearnedRules: an active rule is offered as a proven rule with its trigger, action, error class and confidence", () => {
  const found = sections(renderLearnedRules([activeRule]));

  assert.equal(found.length, 1);
  assert.equal(isExperimental(found[0]!.heading), false);
  for (const field of ["selector absent", "use role+name", "E-EXEC-FAIL", "high"]) {
    assert.ok(found[0]!.body.includes(field), `the proven rule must carry ${field}`);
  }
});

test("renderLearnedRules: a candidate rule is offered only as an experimental hint, never as a proven rule", () => {
  const found = sections(renderLearnedRules([candidateRule]));

  assert.equal(found.length, 1);
  assert.equal(isExperimental(found[0]!.heading), true);
  for (const field of ["flaky wait", "use expect.poll", "E-FLAKY"]) {
    assert.ok(found[0]!.body.includes(field), `the experimental hint must carry ${field}`);
  }
});

test("renderLearnedRules: a mixed set renders the proven section first and keeps each rule in its own section", () => {
  const [proven, experimental, ...rest] = sections(renderLearnedRules([activeRule, candidateRule]));

  assert.equal(rest.length, 0);
  assert.equal(isExperimental(proven!.heading), false);
  assert.equal(isExperimental(experimental!.heading), true);
  assert.ok(proven!.body.includes("use role+name") && !proven!.body.includes("use expect.poll"));
  assert.ok(experimental!.body.includes("use expect.poll") && !experimental!.body.includes("use role+name"));
});

test("renderLearnedRules: empty input renders the empty string", () => {
  assert.equal(renderLearnedRules([]), "");
});

/* renderLearnedRulesForReviewer: active rules only (never candidates), framed as reject-on-sight
   rules, one line per rule carrying its trigger, action and error class. */

test("renderLearnedRulesForReviewer: an active rule becomes a reject-on-sight line with its trigger, action and error class", () => {
  const rendered = renderLearnedRulesForReviewer([activeRule]);

  assert.match(rendered, /reject/i, "the reviewer must be told a violated proven rule is grounds to reject");
  const line = rendered.split("\n").find((l) => l.includes("selector absent"));
  assert.ok(line, "the rule appears in the list");
  assert.ok(line.includes("use role+name") && line.includes("E-EXEC-FAIL"), `one line carries trigger, action and error class: ${line}`);
});

test("renderLearnedRulesForReviewer: candidate-only input renders '' — unproven rules never gate the reviewer", () => {
  assert.equal(renderLearnedRulesForReviewer([candidateRule]), "");
});

test("renderLearnedRulesForReviewer: a mixed set renders ONLY the active rule's line", () => {
  const rendered = renderLearnedRulesForReviewer([activeRule, candidateRule]);

  assert.ok(rendered.includes("- selector absent → use role+name (E-EXEC-FAIL)"));
  assert.ok(!rendered.includes("flaky wait"), "candidate rules must never appear in the reviewer's reject-on-sight list");
});

test("renderLearnedRulesForReviewer: empty input renders the empty string", () => {
  assert.equal(renderLearnedRulesForReviewer([]), "");
});
