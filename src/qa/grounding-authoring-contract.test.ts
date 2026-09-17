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
  "agent/roles/qa-worker.md",
  "agents/agent/qa-worker.md",
];

for (const file of AUTHORING_PROMPTS) {
  test(`Pillar 3: ${file} carries no fabrication license`, () => {
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

  test(`Pillar 3: ${file} forbids constructing a test-id from source`, () => {
    const src = readFileSync(file, "utf8");
    assert.ok(
      /never construct a test-id/i.test(src),
      `${file}: must explicitly forbid constructing a test-id value from source code / naming convention`,
    );
  });
}
