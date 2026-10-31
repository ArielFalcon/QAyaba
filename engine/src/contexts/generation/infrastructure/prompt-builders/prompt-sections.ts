/* A prompt is a list of section definitions: each declares the section it is, when it applies to a turn's context and how it renders from it. The primitives live in the shared kernel (`shared-kernel/prompt-sections.ts`), where the coordination prompts use them too; the generator and reviewer registries build on them from here. Never import src/. */

export { renderSectionDefs as renderSections } from "@kernel/prompt-sections.ts";
export type { PromptSectionDef, SectionRender } from "@kernel/prompt-sections.ts";
