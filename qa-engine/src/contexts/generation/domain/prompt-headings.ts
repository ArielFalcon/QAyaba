/*
 * Names of the sections the generator prompt assembles. The builders render them, the shell's brief
 * renderer titles itself with one, and the prompt-contract lint reads them, so static role text can
 * be checked for naming an assembled artifact without re-typing a heading.
 */

export const PROMPT_HEADINGS = {
  workingRules: "Working rules",
  architectureContext: "Architecture context",
  explorationBrief: "Exploration brief",
  groundTruthAtFailure: "GROUND TRUTH AT FAILURE",
  liveDevTree: "Live DEV accessibility tree",
  crossServiceLinks: "Cross-service links",
  appLogin: "App login",
  harnessFacts: "Harness facts",
} as const;

/* The context pack's sections. */
export const PACK_HEADINGS = {
  pack: "Context Pack",
  blastRadius: "Blast radius",
  feBe: "FE↔BE links",
  risks: "Risks / assert to catch regression",
  liveDom: "Live DOM",
  contracts: "Relevant API contracts",
  notCapturable: "Routes not capturable",
  redirected: "Pages reached by redirect",
} as const;

/* The artifacts only some prompts assemble: static role text is unconditional, so it must not name any of them. */
export const ASSEMBLED_ARTIFACT_NAMES: readonly string[] = [
  PACK_HEADINGS.pack,
  PACK_HEADINGS.liveDom,
  PROMPT_HEADINGS.explorationBrief,
  PROMPT_HEADINGS.architectureContext,
  PROMPT_HEADINGS.groundTruthAtFailure,
  PROMPT_HEADINGS.liveDevTree,
  PROMPT_HEADINGS.crossServiceLinks,
  PROMPT_HEADINGS.appLogin,
  PROMPT_HEADINGS.harnessFacts,
  /* The phrases a directive uses for the brief and for grounding it points back at. */
  "the brief",
  "the grounding above",
];
