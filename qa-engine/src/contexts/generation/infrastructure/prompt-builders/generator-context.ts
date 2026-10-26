/* The facts a generator prompt is derived from, computed once per turn. The sections of generator-sections.ts read them and compute nothing the context already holds. Never import src/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { deriveClaimsFromPackText, withoutPackSection } from "../context-pack.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import { type FactId, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { stepMilestone, type StepMilestone } from "@contexts/generation/domain/step-limit.ts";
import { buildSuiteListing, type SuiteListing } from "@contexts/generation/domain/suite-listing.ts";
import { renderSuiteListing } from "@contexts/generation/domain/suite-listing-render.ts";
import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import { renderArchitectureContextParts } from "./architecture-context.ts";
import { roleWindowBytes } from "./model-window-catalog.ts";
import { redactForModel } from "./prompt-text.ts";

export interface BuildPromptAssembledOpts {
  /** Explicit byte-budget override for tests/telemetry that must not depend on the live model-window catalog. Undefined ⇒ the author's catalog window (production path). */
  budgetBytes?: number;
}

/* The injected grounding (Context Pack ≤6 routes, failure DOM ≤4 routes) may not cover the route a regeneration must touch. Every grounded regeneration branch carries this explicit escape, so a fix is never written blind for lack of navigation. */
const groundingUncoveredEscape = (browser: LiveBrowser): string =>
  `If a route you must touch is NOT represented in the injected grounding above, you MUST still ` +
  `${browser.navigate} that specific route before writing its selectors — never guess them.`;

/* The browser an authoring turn reads a page the prompt does not show with: the authenticated one when the run granted it (signed in as the test account), else the Playwright MCP. */
export interface LiveBrowser {
  name: string;
  navigate: string;
  snapshot: string;
  /* The plain Playwright MCP also reads console messages and network requests; the authenticated browser does not. */
  runtimeSignals: boolean;
}
/* The two browsers an authoring turn may be told to use, and the tools each is read with. */
export const LIVE_BROWSERS = {
  authenticated: { name: "the authenticated browser", navigate: "authbrowser_navigate", snapshot: "authbrowser_snapshot", runtimeSignals: false },
  playwright: { name: "the Playwright MCP", navigate: "browser_navigate", snapshot: "browser_snapshot", runtimeSignals: true },
} as const satisfies Record<string, LiveBrowser>;
const liveBrowserOf = (input: Pick<OpencodeRunInput, "agentBrowser">): LiveBrowser =>
  input.agentBrowser ? { ...LIVE_BROWSERS.authenticated } : { ...LIVE_BROWSERS.playwright };

/* What differs between the two assemblies of one turn: the task is worded for a prompt that lists the suite or does not, and asks for the outcome again or not. Everything else a section reads is the same in both. */
export interface Assembly {
  suiteListed: boolean;
  reaskObjective: boolean;
}

export interface PromptContext {
  readonly input: OpencodeRunInput;
  /* The byte budget the prompt is assembled to. */
  readonly budgetBytes: number;
  readonly isGenerationMode: boolean;
  readonly isCode: boolean;
  /* A re-generation turn (fix / reviewer-corrections / coverage-gap) has already distilled the blast radius — it must not trace it again or re-skim the repo. */
  readonly isReGen: boolean;
  readonly openapiHint: string | undefined;
  readonly sanitizedDomSnapshot: string | undefined;
  /* The tree is a failure-point tree only when the run says so; any other captured tree is the live page. */
  readonly hasFailureTree: boolean;
  readonly hasLiveTree: boolean;
  readonly contextPackContent: string;
  readonly contextPackClaims: readonly PromptClaim[];
  readonly packProvides: (fact: FactId) => boolean;
  /* A DOM tree is in the prompt when the pack carries a live DOM or a captured tree is injected: the tree is then the only selector source. A pack of contracts alone is not a tree. */
  readonly treeInPrompt: boolean;
  readonly browser: LiveBrowser;
  readonly groundingUncoveredEscape: string;
  /* A lead's planning turn opens no browser (its session is denied one): it plans from the pack and the code. */
  readonly planningTurn: boolean;
  readonly archMap: ReturnType<typeof renderArchitectureContextParts>;
  readonly mapInjected: boolean;
  readonly listing: SuiteListing;
  readonly listingContent: string;
  readonly suiteIsListed: boolean;
  /* The listing tells the agent to read the specs it changes when it has some editable. */
  readonly editableListed: boolean;
  /* Only a signal that names symbols is an explored blast radius. */
  readonly blastRadiusGrounded: boolean;
  readonly milestone: StepMilestone | undefined;
  readonly assembly: Assembly;
}

export function derivePromptContext(input: OpencodeRunInput, opts: BuildPromptAssembledOpts = {}): PromptContext {
  const isGenerationMode = input.mode !== "context";
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  const isReGen = isGenerationMode && isReGenTurn(input);

  const sanitizedDomSnapshot = input.domSnapshot ? sanitizeText(input.domSnapshot, "model").text : undefined;

  const hasFailureTree = Boolean(sanitizedDomSnapshot && isGenerationMode && input.failureSourced);
  const hasLiveTree = Boolean(sanitizedDomSnapshot && isGenerationMode && !input.failureSourced);

  /* The live DOM has one section: a freshly captured live tree replaces the pack's own (older) live DOM, and the pack keeps whatever else it holds. A failure tree is a different fact and coexists with it. */
  const packText = input.contextPack && isGenerationMode ? input.contextPack : "";
  const packHasLiveDom = packText !== "" && deriveClaimsFromPackText(packText).some((c) => c.kind === "provides" && c.fact === "dom-live");
  const contextPackContent = packHasLiveDom && hasLiveTree ? (withoutPackSection(packText, PACK_HEADINGS.liveDom) ?? "") : packText;
  const contextPackClaims: PromptClaim[] = contextPackContent ? deriveClaimsFromPackText(contextPackContent) : [];
  const packProvides = (fact: FactId): boolean => contextPackClaims.some((c) => c.kind === "provides" && c.fact === fact);
  const treeInPrompt = packProvides("dom-live") || hasFailureTree || hasLiveTree;
  const browser = liveBrowserOf(input);

  /* The pack's contracts section owns API operations when present (the map yields its list). */
  const archMap = input.contextMap
    ? renderArchitectureContextParts(
        input.contextMap,
        input.mode === "diff" ? input.intent?.changedFiles : undefined,
        {
          suppressApiOperations: packProvides("api-operations"),
        },
      )
    : null;
  /* The suite as this turn knows it: the specs that already exist, listed for a diff or a manual run, and the specs this run has delivered, which only a regeneration carries; with, on a regeneration, the marks of the specs it must change. A prompt that lists no spec has no listing section. */
  const listing = buildSuiteListing(
    isGenerationMode
      ? {
          ...(input.mode === "diff" || input.mode === "manual" ? { existing: input.existingSpecFiles } : {}),
          delivered: input.deliveredSpecs,
          fixCases: input.fixCases,
          reviewCorrections: input.reviewCorrections,
          coverageGap: input.coverageGap,
          selectorContradictions: input.selectorContradictions,
          attributedSpecFiles: input.attributedSpecFiles,
        }
      : {},
    { sanitize: redactForModel },
  );
  const listingContent = renderSuiteListing(listing);
  /* Only a signal that names symbols is an explored blast radius. One of co-change files alone says which files tend to move together, so it claims nothing explored; a signal that arrives without the flag cannot prove it names symbols and is read the same way. */
  const planningTurn = isGenerationMode && input.target === "e2e" && Boolean(input.planning) && !isReGen;
  const staticSignalHasSymbols = Boolean(input.staticSignal && isGenerationMode) && input.staticSignalHasSymbols === true;

  return {
    input,
    budgetBytes: opts.budgetBytes ?? roleWindowBytes("qa-author"),
    isGenerationMode,
    isCode,
    isReGen,
    openapiHint,
    sanitizedDomSnapshot,
    hasFailureTree,
    hasLiveTree,
    contextPackContent,
    contextPackClaims,
    packProvides,
    treeInPrompt,
    browser,
    groundingUncoveredEscape: groundingUncoveredEscape(browser),
    planningTurn,
    archMap,
    mapInjected: archMap !== null,
    listing,
    listingContent,
    suiteIsListed: listingContent !== "",
    editableListed: listing.editable.length > 0,
    blastRadiusGrounded: staticSignalHasSymbols,
    milestone: input.stepLimit !== undefined ? stepMilestone(input, input.stepLimit) : undefined,
    assembly: { suiteListed: listingContent !== "", reaskObjective: listing.reaskObjective },
  };
}

/* The same turn worded for another assembly. */
export function withAssembly(ctx: PromptContext, assembly: Assembly): PromptContext {
  return { ...ctx, assembly };
}
