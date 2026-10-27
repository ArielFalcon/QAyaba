/* A role prompt is built from registered section definitions and from nowhere else, and each section states why it is there. The sign of a prompt built by hand is a markdown heading literal in a module that is not a section registry. The cases check the real tree and, with the same checker, small synthetic sources, so a checker that stopped matching would fail here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";
import { GENERATOR_SECTIONS } from "@contexts/generation/infrastructure/prompt-builders/generator-sections.ts";
import { REVIEWER_SECTIONS } from "@contexts/generation/infrastructure/prompt-builders/reviewer-sections.ts";
import { COORDINATION_PROMPTS } from "@contexts/coordination/application/coordination-sections/index.ts";

const root = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SRC = join(root, "qa-engine", "src", "contexts");

/* A quoted or backticked string that opens with a markdown heading: the first line of a hand-built prompt section. */
const HEADING_LITERAL = /["'`]#{2,3} /;

/* Where a prompt's headings may be written: the section registries. */
const isRegistry = (file: string): boolean => /\/coordination-sections\//.test(file) || /-sections\.ts$/.test(file);

/*
 * Modules that still write a role prompt's heading outside a registry. The list only shrinks: moving a prompt into a registry
 * removes its module here, and a module that stops writing a heading must leave the list (the last case below).
 *  - the generation renderers are helpers the generator and reviewer registries call to render their sections' bodies;
 */
const HELPERS_OF_REGISTERED_SECTIONS: readonly string[] = [
  "generation/domain/changed-values.ts",
  "generation/infrastructure/context-pack.ts",
  "generation/infrastructure/dom-snapshot.ts",
  "generation/domain/pack-pages.ts",
  "generation/domain/review-fingerprint.ts",
  "generation/domain/suite-listing-render.ts",
  "generation/infrastructure/prompt-builders/architecture-context.ts",
  "generation/infrastructure/prompt-builders/generator-renderers.ts",
  "generation/infrastructure/prompt-builders/prompt-text.ts",
  "generation/infrastructure/prompt-builders/review-render.ts",
  "generation/infrastructure/prompt-builders/task-builders.ts",
];
const PENDING_MIGRATION: readonly string[] = [];

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/* The modules (path relative to contexts/) that write a heading literal and are not a registry. */
function promptsBuiltOutsideRegistry(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, text]) => !isRegistry(file) && HEADING_LITERAL.test(text))
    .map(([file]) => file)
    .sort();
}

const realTree = (): Record<string, string> =>
  Object.fromEntries(
    ["coordination", "generation"].flatMap((context) => sourcesUnder(join(SRC, context))).map((path) => [relative(SRC, path).replaceAll("\\", "/"), readFileSync(path, "utf8")]),
  );

test("a role prompt is assembled from a section registry: no module outside the registries and the frozen lists writes a prompt heading", () => {
  const allowed = new Set([...HELPERS_OF_REGISTERED_SECTIONS, ...PENDING_MIGRATION]);
  assert.deepEqual(promptsBuiltOutsideRegistry(realTree()).filter((file) => !allowed.has(file)), []);
});

test("every module of the frozen lists still writes a heading, so the lists only shrink", () => {
  const built = new Set(promptsBuiltOutsideRegistry(realTree()));
  assert.deepEqual([...HELPERS_OF_REGISTERED_SECTIONS, ...PENDING_MIGRATION].filter((file) => !built.has(file)), []);
});

test("the checker flags a prompt written by hand and accepts the same text in a registry", () => {
  const prompt = 'export const ask = () => ["## Review of the flows", "ask"].join("\\n");\n';
  assert.deepEqual(promptsBuiltOutsideRegistry({ "coordination/application/new-turn.ts": prompt }), ["coordination/application/new-turn.ts"]);
  assert.deepEqual(promptsBuiltOutsideRegistry({ "coordination/application/coordination-sections/new-turn.ts": prompt, "generation/infrastructure/prompt-builders/x-sections.ts": prompt }), []);
  assert.deepEqual(promptsBuiltOutsideRegistry({ "coordination/application/plain.ts": "export const x = 'a title is # not a heading';\n" }), []);
});

/* Every registered section declares the observed failure or the contract it exists for. A section that cannot is a removal candidate, measured by a campaign before it goes. */
const sectionsWithoutReason = (registries: Record<string, readonly PromptSectionDef<never>[]>): string[] =>
  Object.entries(registries).flatMap(([name, defs]) => defs.filter((def) => typeof def.reason !== "string" || def.reason.trim() === "").map((def) => `${name}:${def.id}`));

const EVERY_REGISTRY: Record<string, readonly PromptSectionDef<never>[]> = {
  generator: GENERATOR_SECTIONS as readonly PromptSectionDef<never>[],
  reviewer: REVIEWER_SECTIONS as readonly PromptSectionDef<never>[],
  ...COORDINATION_PROMPTS,
};

test("every registered prompt section states the failure or the contract it exists for", () => {
  assert.deepEqual(sectionsWithoutReason(EVERY_REGISTRY), []);
});

test("the reason check flags a section with a blank or missing reason", () => {
  const section = (id: string, reason: string): PromptSectionDef<never> => ({ id, tier: "task", priority: 0, stability: "run", reason, applies: () => true, render: () => ({ content: id }) });
  const missing = { ...section("missing", "x"), reason: undefined } as unknown as PromptSectionDef<never>;
  assert.deepEqual(sectionsWithoutReason({ turn: [section("kept", "a contract"), section("blank", "  "), missing] }), ["turn:blank", "turn:missing"]);
});
