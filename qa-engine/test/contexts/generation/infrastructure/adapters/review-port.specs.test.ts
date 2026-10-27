/* What the reviewer is shown of the specs: one entry per spec file, and one outcome (inline or read) that the instruction and the specs section agree on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewPortAdapter } from "@contexts/generation/infrastructure/adapters/review-port.adapter.ts";
import { buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort } from "@contexts/generation/application/ports/prompt-rendering.port.ts";
import type { VerdictParserPort } from "@contexts/generation/application/ports/verdict-parser.port.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";
import type { QaCase } from "@kernel/qa-case.ts";


const runtime: AgentRuntimePort = { openSession: async () => ({ prompt: async () => ({ output: "{}" }), dispose: async () => {} }) };
const verdicts: VerdictParserPort = {
  parseGenerator: () => ({ specs: [] }),
  parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
};

/* A rendering port that records the input and renders the real reviewer prompt from it. */
function recordingRendering(seen: ReviewInput[]): PromptRenderingPort {
  return {
    render: () => "",
    renderMain: () => ({ text: "", sectionSizes: {} }),
    renderReviewer: (input: ReviewInput) => {
      seen.push(input);
      return buildReviewerPromptAssembled(input);
    },
    specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
  };
}

function mirrorWith(files: Record<string, string>): string {
  const mirror = mkdtempSync(join(tmpdir(), "review-specs-"));
  mkdirSync(join(mirror, "e2e", "flows"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(mirror, "e2e", name), text);
  return mirror;
}

async function reviewWith(mirror: string, cases: QaCase[]): Promise<ReviewInput> {
  const seen: ReviewInput[] = [];
  const adapter = new ReviewPortAdapter({ runtime, rendering: recordingRendering(seen), verdicts }, { diff: "", mirrorDir: mirror, e2eRelDir: "e2e", appName: "app", mode: "diff" });
  await adapter.review(join(mirror, "e2e"), cases);
  return seen[0]!;
}

const KB = (n: number): string => `// ${"x".repeat(1000)}\n`.repeat(n);

/* The assembled prompt cut back into its sections, as the lint reads them. */
function lintSectionsOf(assembled: AssembledPrompt): LintSection[] {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  return Object.entries(assembled.sectionSizes).map(([id, size]) => {
    const text = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
    return { id, layer: "assembled" as const, text, claims: assembled.claims[id] ?? [] };
  });
}

/* Two specs that together exceed the inline cap. */
function overCapReviewerInput(mirror: string): ReviewInput {
  const specs = ["flows/big-a.spec.ts", "flows/big-b.spec.ts"];
  for (const spec of specs) writeFileSync(join(mirror, "e2e", spec), KB(25));
  return { diff: "+export const total = 1;\n", specs, mirrorDir: mirror, e2eRelDir: "e2e", appName: "shop", mode: "diff", target: "e2e", baseUrl: "http://localhost:3000" };
}

test("the reviewer lists each spec file once however many cases ran in it, and gets the contents inline", async () => {
  const mirror = mirrorWith({ "flows/a.spec.ts": "test('a', () => {});\n", "flows/b.spec.ts": "test('b', () => {});\n" });
  const cases: QaCase[] = [
    { name: "a one", file: "flows/a.spec.ts", status: "pass" },
    { name: "a two", file: "flows/a.spec.ts", status: "pass" },
    { name: "b one", file: "./flows/b.spec.ts", status: "pass" },
    { name: "b two", file: "flows/b.spec.ts", status: "pass" },
  ];
  const input = await reviewWith(mirror, cases);
  assert.deepEqual(input.specs, ["flows/a.spec.ts", "flows/b.spec.ts"]);
  const assembled = buildReviewerPromptAssembled(input);
  assert.match(assembled.text, /contents provided inline/);
  assert.equal(assembled.text.match(/### e2e\/flows\/a\.spec\.ts/g)?.length, 1);
});

test("duplicate case rows alone do not push the specs over the inline cap", async () => {
  /* Two ~19 KB specs fit inline (about 38 KB); listed once per case (8 times) they would be four times that. */
  const mirror = mirrorWith({ "flows/a.spec.ts": KB(19), "flows/b.spec.ts": KB(19) });
  const cases: QaCase[] = ["a", "b"].flatMap((f) => [1, 2, 3, 4].map((n): QaCase => ({ name: `${f} ${n}`, file: `flows/${f}.spec.ts`, status: "pass" })));
  const input = await reviewWith(mirror, cases);
  assert.equal(input.specs.length, 2);
  assert.match(buildReviewerPromptAssembled(input).text, /contents provided inline/);
});

test("an unreadable spec is judged from a placeholder, never dropped", async () => {
  const mirror = mirrorWith({ "flows/a.spec.ts": "test('a', () => {});\n" });
  const input = await reviewWith(mirror, [
    { name: "a", file: "flows/a.spec.ts", status: "pass" },
    { name: "gone", file: "flows/gone.spec.ts", status: "pass" },
  ]);
  const text = buildReviewerPromptAssembled(input).text;
  assert.match(text, /### e2e\/flows\/gone\.spec\.ts\n\( could not read file/);
});

function r13Findings(input: ReviewInput, claimsOfSpecs?: "none", opts: Parameters<typeof buildReviewerPromptAssembled>[1] = {}) {
  const assembled = buildReviewerPromptAssembled(input, opts);
  const sections = lintSectionsOf(assembled).map((s) => (claimsOfSpecs === "none" && s.id === "reviewer-specs" ? { ...s, claims: [] } : s));
  return lintCell({ name: "reviewer", regen: false, sections }, { artifactReferences: ARTIFACT_REFERENCES }).filter((f) => f.rule === "R13");
}

test("a spec set over the reviewer's window sends the reviewer to read the files in both the instruction and the section, and the lint finds no dangling reference", () => {
  const input = overCapReviewerInput(mirrorWith({}));
  const overWindow = { fit: () => "over" as const };
  const text = buildReviewerPromptAssembled(input, overWindow).text;
  assert.match(text, /read each listed spec file/);
  assert.match(text, /read each file with the read tool/);
  assert.doesNotMatch(text, /contents are provided in this prompt/);
  assert.deepEqual(r13Findings(input, undefined, overWindow), []);
});

test("a spec set of any size is inlined while the reviewer's window holds it", () => {
  const input = overCapReviewerInput(mirrorWith({}));
  const text = buildReviewerPromptAssembled(input, { fit: () => "fits" }).text;
  assert.match(text, /contents are provided in this prompt/);
  assert.doesNotMatch(text, /read each file with the read tool/);
  assert.deepEqual(r13Findings(input, undefined, { fit: () => "fits" }), []);
});

test("an inline spec set says the contents are in the prompt, and the fact that backs it is provided", () => {
  const input: ReviewInput = { ...overCapReviewerInput(mirrorWith({ "flows/a.spec.ts": "test('a', () => {});\n" })), specs: ["flows/a.spec.ts"] };
  const text = buildReviewerPromptAssembled(input).text;
  assert.match(text, /contents are provided in this prompt/);
  assert.doesNotMatch(text, /read each file with the read tool/);
  assert.deepEqual(r13Findings(input), []);
});

test("the instruction's reference to inline contents is a lint finding when no section provides them", () => {
  const input: ReviewInput = { ...overCapReviewerInput(mirrorWith({ "flows/a.spec.ts": "test('a', () => {});\n" })), specs: ["flows/a.spec.ts"] };
  assert.deepEqual(r13Findings(input, "none").map((f) => f.sections), [["reviewer-instructions"]]);
});
