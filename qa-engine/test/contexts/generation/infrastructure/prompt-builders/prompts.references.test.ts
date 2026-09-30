/* What a prompt says about the artifacts it carries matches what it carries: the pack is described by the sections it holds, and a code run is never sent to a browser. Asserted on the sections present and on tool identifiers, not on wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  PROMPT_HEADINGS,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat(cart): shows the total", changedFiles: ["src/app/cart/cart.service.ts"] },
    ...overrides,
  };
}

function sectionText(assembled: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(assembled.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

const PACK_HEAD = `## ${PACK_HEADINGS.pack} (pushed by the orchestrator)\n\n`;
const DOM_SECTION = `### ${PACK_HEADINGS.liveDom} (a11y tree)\nroute /cart:\n  button: Apply coupon`;
const CONTRACTS_SECTION = `### ${PACK_HEADINGS.contracts}\n- \`applyCoupon\`: POST /cart/coupon`;

const PACK_WITH_DOM = PACK_HEAD + DOM_SECTION;
const PACK_CONTRACTS_ONLY = PACK_HEAD + CONTRACTS_SECTION;

test("the working rules describe the pack by the sections it holds: a pack with a DOM and no contracts is not a contracts pack", () => {
  const domOnly = sectionText(buildPromptAssembled(mkInput({ contextPack: PACK_HEAD + DOM_SECTION })), "working-rules");
  assert.doesNotMatch(domOnly, /contracts/i);
  const both = sectionText(buildPromptAssembled(mkInput({ contextPack: `${PACK_HEAD}${DOM_SECTION}\n\n${CONTRACTS_SECTION}` })), "working-rules");
  assert.match(both, /contracts/i);
});

test("a code run is never sent to a browser tool, whichever correction it is asked to make", () => {
  const corrections: Array<Partial<OpencodeRunInput>> = [
    { fixCases: [{ name: "cart total", status: "fail", detail: "expected 3 to equal 4" }] },
    { reviewCorrections: ["[false-positive] cart.test.ts: assert the total"] },
    { coverageGap: "src/app/cart/cart.service.ts: lines 10-14 were not executed" },
  ];
  for (const correction of corrections) {
    for (const mode of ["diff", "complete", "manual"] as const) {
      const { baseUrl: _unused, ...codeInput } = mkInput({ target: "code", mode, guidance: "cover the total", ...correction });
      void _unused;
      const assembled = buildPromptAssembled(codeInput);
      assert.doesNotMatch(assembled.text, /\bbrowser_\w+/, `${Object.keys(correction)[0]} in ${mode} mode`);
    }
  }
});

function lintSectionsOf(assembled: AssembledPrompt): LintSection[] {
  return Object.keys(assembled.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(assembled, id),
    claims: assembled.claims[id] ?? [],
    ...(id === "diff" ? { verbatim: true } : {}),
  }));
}

const danglingReferences = (assembled: AssembledPrompt, regen: boolean): string[] =>
  lintCell({ name: "seeded", regen, sections: lintSectionsOf(assembled) }, { artifactReferences: ARTIFACT_REFERENCES })
    .filter((f) => f.rule === "R13")
    .map((f) => `${f.sections.join("+")}:${f.artifact}`);

const CORRECTIONS: Array<Partial<OpencodeRunInput>> = [
  { fixCases: [{ name: "cart total", status: "fail", detail: "expected 3 to equal 4" }] },
  { reviewCorrections: ["[fragile-selector] cart.spec.ts: scope the coupon button"] },
  { coverageGap: "src/app/cart/cart.service.ts: lines 10-14 were not executed" },
  { selectorContradictions: ["button:Apply is NOT in the captured tree; present roles: button:Apply coupon"] },
];

test("a regeneration refers only to the blast radius, tree and diff its prompt carries", () => {
  const shapes: Array<[string, Partial<OpencodeRunInput>]> = [
    ["no grounding at all", {}],
    ["a pack of contracts alone", { contextPack: PACK_CONTRACTS_ONLY }],
    ["a pack with a DOM", { contextPack: PACK_WITH_DOM }],
    ["a live tree", { domSnapshot: "route /cart:\n  button: Apply coupon" }],
    ["a failure tree", { domSnapshot: "route /cart:\n  button: Apply coupon", failureSourced: true }],
    ["a code run", { target: "code" }],
  ];
  for (const [shape, base] of shapes) {
    for (const correction of CORRECTIONS) {
      const assembled = buildPromptAssembled(mkInput({ ...base, ...correction }));
      assert.deepEqual(danglingReferences(assembled, true), [], `${shape} / ${Object.keys(correction)[0]}`);
    }
  }
});

test("the re-generation section speaks of a distilled blast radius only when the prompt carries one", () => {
  const fix = { fixCases: [{ name: "cart total", status: "fail" as const, detail: "boom" }] };
  const brief: ExplorationBrief = {
    builtForSha: "abc1234",
    objective: "the total shows",
    blastRadius: [{ symbol: "CartService.total", file: "src/app/cart/cart.service.ts", role: "computes the total" }],
  };
  const without = buildPromptAssembled(mkInput(fix));
  const withBrief = buildPromptAssembled(mkInput({ ...fix, contextBrief: brief }));
  const withSignal = buildPromptAssembled(mkInput({ ...fix, staticSignal: "## Blast radius (structural signal)\n- CartService.total" }));
  const emptyBrief = buildPromptAssembled(mkInput({ ...fix, contextBrief: { ...brief, blastRadius: [] } }));
  const size = (a: AssembledPrompt): number | undefined => a.sectionSizes["regen-discipline"];
  assert.ok((size(withBrief) ?? 0) > (size(without) ?? 0), "a brief with a blast radius adds the statement");
  assert.equal(size(withSignal), size(withBrief), "the structural signal supports it as well");
  assert.equal(size(emptyBrief), size(without), "a brief with no blast radius supports nothing");
});
