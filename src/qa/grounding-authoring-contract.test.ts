import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* The agent must NEVER fabricate a selector it did not observe. The fabrication license
   ("derive selectors from source code when no live DOM is reachable") is removed from BOTH
   authoring roles in BOTH prompt trees, and the grounded-only contract is explicit. This test
   fails CI if that license returns.
 */

const AUTHORING_PROMPTS = [
  "agent/roles/qa-generator.md",
  "agents/agent/qa-generator.md",
];

const REVIEWER_PROMPTS = [
  "agent/roles/qa-reviewer.md",
  "agents/agent/qa-reviewer.md",
];

for (const file of AUTHORING_PROMPTS) {
  test(`${file} carries no fabrication license`, () => {
    const src = readFileSync(file, "utf8");
    assert.ok(
      !/derive them from the code/i.test(src),
      `${file}: must NOT license deriving selectors from source code`,
    );
    assert.ok(
      !/do your best with code analysis alone/i.test(src),
      `${file}: must NOT license code-only authoring of selectors`,
    );
  });

  test(`${file} forbids constructing a test-id from source`, () => {
    const src = readFileSync(file, "utf8");
    assert.ok(
      /never construct a test-id/i.test(src),
      `${file}: must explicitly forbid constructing a test-id value from source code / naming convention`,
    );
  });

  /* The verdict parser reads specs, specMetas, note, noop and plan. A prompt that offers an exit the parser does not accept (flag a flow in the note) ends the run as an undecided empty verdict. */
  test(`${file} offers no exit the verdict contract does not accept`, () => {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /ungroundable/i, `${file}: a flow that cannot be grounded is a spec that creates its state or a no-op, never a flag in the note`);
    assert.doesNotMatch(src, /wrote tests from code analysis/i, `${file}: the note's example must not license tests written from source code alone`);
  });

  /* The sentences that name the second reason of the no-op, say that source grounds nothing and forbid the same-label stand-in are pinned once, as owned rules (src/agent-runtime/prompt-sync.test.ts); what no owned rule counts is the alternative to the no-op. */
  test(`${file} offers a spec that creates the state through the UI as the alternative to the no-op`, () => {
    const src = readFileSync(file, "utf8").replace(/\s+/g, " ");
    assert.match(src, /creates,? through the UI,? the state/i, `${file}: the alternative to a no-op is a spec that creates the state through the UI`);
  });
}

for (const file of REVIEWER_PROMPTS) {
  test(`${file} rejects a spec that only asserts pre-existing elements with the changed label, and grants no leniency for a blind spec`, () => {
    const src = readFileSync(file, "utf8");
    assert.match(src, /^\|.*only assert.*pre-existing.*same (?:label|text).*\[wrong-objective\]/im, `${file}: the same-label stand-in is a wrong objective, in one row of the anti-pattern catalog`);
    assert.doesNotMatch(src.replace(/\s+/g, " "), /more lenient/i, `${file}: no leniency on selector precision for a spec written without the page`);
  });
}
