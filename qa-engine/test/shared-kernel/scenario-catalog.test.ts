import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_EXEMPLARS, renderExemplarsForPrompt } from "@kernel/scenario-catalog.ts";

/* The skill-exemplars prompt section is rendered at { maxBytes: 1536, overflow: "drop" } — an
   over-budget match set is omitted ENTIRELY. The curriculum folds "what the generator was shown",
   so a silently dropped section would corrupt every `evaluated` counter. Capping at 3 in the
   selector is only honest if EVERY 3-exemplar subset provably fits: this enumerates all C(6,3)=20.
   If this ever fails, LOWER MAX_SELECTED_EXEMPLARS to 2 — do not raise maxBytes, which would steal
   window from the other priority-3 sections (static-signal, service-links, diff-archetypes).
 */
const SECTION_MAX_BYTES = 1536;

describe("skill-exemplar section fits the prompt budget at the selection cap", () => {
  it("every 3-exemplar subset renders under 1536 bytes, worst case (all marked PROVEN)", () => {
    const list = [...BUILT_IN_EXEMPLARS];
    let combos = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        for (let k = j + 1; k < list.length; k++) {
          combos++;
          const subset = [list[i]!, list[j]!, list[k]!];
          const text = renderExemplarsForPrompt(
            subset,
            { proven: { [list[i]!.archetype]: 99, [list[j]!.archetype]: 99, [list[k]!.archetype]: 99 } },
          );
          for (const exemplar of subset) {
            assert.ok(
              text.includes(`### ${exemplar.name} (${exemplar.archetype}) — PROVEN (99 bugs)`),
              `subset entry ${exemplar.id} must carry its worst-case PROVEN marker`,
            );
          }
          assert.ok(
            Buffer.byteLength(text, "utf8") < SECTION_MAX_BYTES,
            `subset ${list[i]!.id}/${list[j]!.id}/${list[k]!.id} rendered ${Buffer.byteLength(text, "utf8")} bytes`,
          );
        }
      }
    }
    assert.equal(combos, 20);
  });

  it("renders no fabricated PROVEN marker for absent or zero promotion counts", () => {
    const exemplar = BUILT_IN_EXEMPLARS[0]!;
    const absent = renderExemplarsForPrompt([exemplar]);
    const zero = renderExemplarsForPrompt([exemplar], { proven: { [exemplar.archetype]: 0 } });

    assert.equal(absent.includes("PROVEN"), false);
    assert.equal(zero.includes("PROVEN"), false);
  });
});
