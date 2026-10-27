/*
 * Names of the sections the generator prompt assembles. The builders render them and the
 * prompt-contract lint reads them, so static role text can be checked for naming an assembled
 * artifact without re-typing a heading.
 */

export const PROMPT_HEADINGS = {
  workingRules: "Working rules",
  architectureContext: "Architecture context",
  groundTruthAtFailure: "GROUND TRUTH AT FAILURE",
  liveDevTree: "Live DEV accessibility tree",
  crossServiceLinks: "Cross-service links",
  /* The code-graph exploration a structural signal that names symbols is titled with. */
  structuralBlastRadius: "Structural blast radius",
  appLogin: "App login",
  harnessFacts: "Harness facts",
  /* The listing of the specs that already exist, titled by the id of its section. */
  existingSuiteManifest: "existing-suite-manifest",
  /* The files that changed in the same commits as the changed files: what a structural signal holding no symbol is titled with. */
  coChangeFiles: "Files that historically change together",
  /* The cap the runtime enforces for the turn: titles the statement of a generator and a reviewer prompt alike. */
  stepLimit: "Step limit",
  /* The calls, time and DEV writes a run grants the generator's run_spec tool; a prompt states it only when the run granted the tool. */
  closedLoop: "Run spec budget",
  /* The calls and time a run grants the authoring agents' authenticated browser; a prompt states it only when the run granted the tools. */
  agentBrowser: "Authenticated browser budget",
  /* The app's default location, its declared places and where this authoring scope is; a prompt states it only when the app declares geolocation. */
  geolocation: "Device location",
  /* The plan a lead is asked for when its run is coordinated; a prompt carries it only on the planning turn. */
  leadPlan: "Lead plan contract",
} as const;

/* The lines of the suite listing's groups on a turn that has specs to change. The editable label is the one place a prompt tells the agent to read the specs it is about to change; the new-spec line says a turn that covers changed lines may add a spec of its own; the last label says which specs are left as they are. */
export const SUITE_LISTING_LABELS = {
  editable: "Editable this turn (read a file before you change it):",
  newSpec: "A new spec is allowed for a flow none of the specs listed here covers.",
  doNotRewrite: "Do NOT rewrite (flows already covered):",
} as const;

/* The context pack's sections. */
export const PACK_HEADINGS = {
  pack: "Context Pack",
  liveDom: "Live DOM",
  contracts: "Relevant API contracts",
  notCapturable: "Routes not capturable",
  redirected: "Pages reached by redirect",
  /* Why the routes the capture could not show at their own address were not. */
  availability: "Route availability",
  /* What the captured pages say of the labels the change added and removed. */
  changedValues: "Changed values",
} as const;

/* The artifacts only some prompts assemble: static role text is unconditional, so it must not name any of them. */
export const ASSEMBLED_ARTIFACT_NAMES: readonly string[] = [
  PACK_HEADINGS.pack,
  PACK_HEADINGS.liveDom,
  PROMPT_HEADINGS.architectureContext,
  PROMPT_HEADINGS.groundTruthAtFailure,
  PROMPT_HEADINGS.liveDevTree,
  PROMPT_HEADINGS.crossServiceLinks,
  PROMPT_HEADINGS.appLogin,
  PROMPT_HEADINGS.harnessFacts,
  PROMPT_HEADINGS.existingSuiteManifest,
  PROMPT_HEADINGS.coChangeFiles,
  PROMPT_HEADINGS.stepLimit,
  PROMPT_HEADINGS.closedLoop,
  PROMPT_HEADINGS.agentBrowser,
  PROMPT_HEADINGS.geolocation,
  PROMPT_HEADINGS.leadPlan,
  /* The phrase a directive uses for the grounding it points back at. */
  "the grounding above",
];
