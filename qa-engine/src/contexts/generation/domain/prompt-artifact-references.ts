/*
 * How an assembled section refers to an artifact only some prompts carry, and what the cell must hold
 * for the reference to mean something. A directive that points at "the tree above" while no tree is in
 * the prompt sends the agent to something that does not exist. Patterns carry no `g` flag: they are
 * tested, never iterated.
 */
import { APP_LOGIN_SECTION_ID, HARNESS_FACTS_SECTION_ID, type ArtifactReference } from "./prompt-contract-lint.ts";
import { PACK_HEADINGS, PROMPT_HEADINGS } from "./prompt-headings.ts";

const escape = (words: string): string => words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (words: string): RegExp => new RegExp(escape(words));

/* Section ids the builders give the sections that only some prompts assemble. */
const SECTION = {
  contextPack: "context-pack",
  contextBrief: "context-brief",
  archMap: "arch-map",
  serviceLinks: "service-links",
} as const;

export const ARTIFACT_REFERENCES: readonly ArtifactReference[] = [
  { artifact: "context-pack", pattern: named(PACK_HEADINGS.pack), provider: { section: SECTION.contextPack } },
  { artifact: "live-dom", pattern: /\blive DOM\b/i, provider: { facts: ["dom-live"] } },
  { artifact: "live-dev-tree", pattern: named(PROMPT_HEADINGS.liveDevTree), provider: { facts: ["dom-live"] } },
  { artifact: "failure-tree", pattern: named(PROMPT_HEADINGS.groundTruthAtFailure), provider: { facts: ["dom-failure"] } },
  {
    artifact: "tree",
    pattern: /\bthe (?:[\w-]+ ){0,2}tree (?:above|below)\b|\bin the (?:captured )?tree\b|\bthe captured (?:[\w-]+ )?tree\b|\binjected (?:a11y )?tree\b|\binjected grounding\b|\bthe grounding above\b/i,
    provider: { facts: ["dom-live", "dom-failure"] },
  },
  {
    artifact: "blast-radius",
    pattern: /\bblast radius was already explored\b|\bdistilled above\b|\bgrounding already in this prompt\b/i,
    provider: { facts: ["blast-radius", "structural-signal"] },
  },
  { artifact: "brief", pattern: new RegExp(`${escape(PROMPT_HEADINGS.explorationBrief)}|\\bthe brief\\b`, "i"), provider: { section: SECTION.contextBrief } },
  { artifact: "arch-map", pattern: named(PROMPT_HEADINGS.architectureContext), provider: { section: SECTION.archMap } },
  { artifact: "service-links", pattern: named(PROMPT_HEADINGS.crossServiceLinks), provider: { section: SECTION.serviceLinks } },
  { artifact: "app-login", pattern: named(PROMPT_HEADINGS.appLogin), provider: { section: APP_LOGIN_SECTION_ID } },
  { artifact: "harness-facts", pattern: named(PROMPT_HEADINGS.harnessFacts), provider: { section: HARNESS_FACTS_SECTION_ID } },
  { artifact: "diff", pattern: /\bthe diff\b/i, provider: { facts: ["diff"] } },
];
