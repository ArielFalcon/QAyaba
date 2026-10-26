import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  GEOLOCATION_SECTION_ID,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/generation-input.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";


const FACTS: GeolocationFacts = {
  default: { latitude: 40.4168, longitude: -3.7038 },
  current: { latitude: 41.3874, longitude: 2.1686 },
  places: { barcelona: { latitude: 41.3874, longitude: 2.1686 } },
  scope: "run",
};

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/map.ts b/src/app/map.ts\n+export function nearby() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

function sectionOf(assembled: AssembledPrompt): string | undefined {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    if (id === GEOLOCATION_SECTION_ID) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return undefined;
}

test("an app that declares a location states it on every e2e turn that writes tests", () => {
  for (const mode of ["diff", "manual", "complete", "exhaustive"] as const) {
    const section = sectionOf(buildPromptAssembled(mkInput({ mode, geolocation: FACTS }), { budgetBytes: 0 }));
    assert.ok(section, mode);
    assert.match(section, /40\.4168/);
    assert.match(section, /41\.3874/);
    assert.match(section, /barcelona/);
  }
});

test("a flow's section says it is the flow's value, and names the helper a delivered spec uses", () => {
  const section = sectionOf(buildPromptAssembled(mkInput({ geolocation: { ...FACTS, scope: "flow" } }), { budgetBytes: 0 }))!;
  assert.match(section, /this flow/);
  assert.match(section, /setLocation/);
});

test("no declared location, no section: the prompt is what it always was", () => {
  const without = buildPromptAssembled(mkInput(), { budgetBytes: 0 });
  assert.equal(sectionOf(without), undefined);
  assert.equal(without.text.includes(PROMPT_HEADINGS.geolocation), false);
});
