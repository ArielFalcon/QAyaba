/* The sections of a generator prompt, in prompt order. Each declares when it applies and how it renders from the turn's PromptContext; buildPromptAssembled filters and renders them. Never import src/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { renderExemplarsForPrompt } from "@kernel/scenario-catalog.ts";
import { advisoryLineIds, itemId } from "@kernel/context-item-ids.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import {
  claim,
  AGENT_BROWSER_SECTION_ID,
  APP_LOGIN_SECTION_ID,
  CLOSED_LOOP_SECTION_ID,
  GEOLOCATION_SECTION_ID,
  HARNESS_FACTS_SECTION_ID,
  LEAD_PLAN_SECTION_ID,
  STEP_LIMIT_SECTION_ID,
  type PromptClaim,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import { STEP_MILESTONE_SECTION_ID } from "@contexts/generation/domain/step-limit.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import { LISTING_ENTRY_SAFETY_BOUND_REASON } from "@contexts/generation/domain/suite-listing.ts";
import { suiteListingDegrade } from "@contexts/generation/domain/suite-listing-render.ts";
import type { PromptContext } from "./generator-context.ts";
import { NOT_SHOWN, advisoryListsDegrade, packDegrade, referenceDegrade } from "../../domain/window-fit-references.ts";
import { WINDOW_FIT_REASON, type SectionDegradation } from "@kernel/prompt-sections.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import { boundedEvidenceCount, EVIDENCE_SAFETY_BOUND_REASON } from "../prompt-cap.ts";
import { PACK_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import {
  CONTRACT_DRIFT_HEADING,
  CONTRACT_FEEDBACK_SECTION_ID,
  type ContractViolationShape,
  type FixCaseShape,
  FIX_STEPS,
  RUNTIME_SIGNALS_LINES,
  buildDiffSection,
  numbered,
  renderAgentBrowser,
  renderClosedLoop,
  renderContractViolations,
  renderFixCase,
  renderGeolocation,
  renderHarnessFacts,
  renderLeadPlan,
  renderServiceLinkLine,
  renderStepMilestone,
} from "./generator-renderers.ts";
import { CODE_TOOLS, renderStepLimit } from "./prompt-text.ts";
import { buildTask } from "./task-builders.ts";
import { diffWindowDegrade } from "./plan-diff-section.ts";
import { commitDiffBlock } from "./prompt-text.ts";
import type { PromptSectionDef, SectionRender } from "./prompt-sections.ts";

/* What the working rules call the API contracts a Context Pack holds, when it holds them. */
export const PACK_CONTRACTS_NOUN = "contracts";

/* The id of the section that lists the suite; it titles the section as well. */
export const SUITE_LISTING_SECTION_ID = PROMPT_HEADINGS.existingSuiteManifest;

/* What the working rules direct, following the branch of the text that renders: a context run directs nothing; a code run is told who compiles and runs its tests; a planning turn opens no browser; a turn with a DOM tree keeps a browser only for a route the tree does not cover; any other turn reads the live page. */
function workingRulesClaims({ input, isCode, planningTurn, packProvides, treeInPrompt }: PromptContext): PromptClaim[] {
  if (input.mode === "context") return [];
  if (isCode) return [claim.provides("orchestrator-validation")];
  if (planningTurn) return [];
  if (packProvides("dom-live") || treeInPrompt) return [claim.directs("use-browser-for-uncovered-route")];
  return [claim.directs("use-runtime-signals")];
}

function renderWorkingRules(ctx: PromptContext): SectionRender {
  const { input, isCode, isReGen, planningTurn, packProvides, treeInPrompt, browser, openapiHint } = ctx;
  const workingRulesLines: string[] = [
    `## ${PROMPT_HEADINGS.workingRules}`,
    ...(input.mode === "context"
      ? [
          `- This is a CONTEXT mode run: you are building the FE↔BE architecture map, not writing tests.`,
          `- Your ONLY output is ${input.e2eRelDir}/.qa/context.json — do not create or modify any .spec.ts files.`,
          `- Use ONLY serena to read code (activate_project, find_symbol, get_symbols_overview) — no Playwright MCP.`,
          `- Extract from STRUCTURED sources: every route from a routing file, every operation from an OpenAPI spec.`,
          `- Consult the architecture-mapping skill for detailed extraction patterns per source type.`,
          `- The task block in this prompt has the complete procedure. Follow it precisely.`,
        ]
      : isCode
      ? [
          `- This is a CODE mode run: you are testing source-code logic, not a deployed web app.`,
          /* The conventions of the repo's tests are read once, on the first pass: a regeneration works from the failing tests and the code under test. */
          `- Detect the test framework from the repo's dependencies.${isReGen ? "" : " Read 2-3 existing test files for conventions. Match them exactly."}`,
          `- Place generated tests alongside existing ones. Do not install new dependencies. Run no command: the orchestrator compiles and runs the tests after you finish and returns any compile or test failure to you.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec so the orchestrator can write the manifest deterministically.`,
          `- Classify each affected symbol:`,
          `  * Pure function → unit test: call with inputs, assert outputs`,
          `  * Module with deps → integration test: real module + test doubles`,
          `  * Handler/endpoint → integration test: test client, real request, assert status + body`,
          `  * Trivial delegation/getter/setter → skip`,
          `- Assert on BEHAVIOR, not implementation. Include edge cases.`,
          `- One objective per test. Use realistic test data.`,
          `- Never write a test whose only assertion is "does not throw".`,
        ]
      : [
          `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git). Reuse and improve existing fixtures/specs; do not duplicate.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec. The orchestrator writes the manifest deterministically from these.`,
          `- LIVE DEV URL: ${input.baseUrl ?? "(not provided — ABORT and report infra-error: no base URL)"}`,
          `  In the SPEC files, reach the app via the PW_BASE_URL env var (the orchestrator sets it at run time).`,
          ...(planningTurn
            ? [
                `- This turn plans and opens no browser.${packProvides("dom-live") ? ` The "Live DOM" section is what DEV rendered for the pages it lists; a flow that visits another page names it, and its author reads it.` : " The authors of the flows read the pages they visit."}`,
                `  Find what the change reaches (its callers and the pages that use it) with ${CODE_TOOLS}.`,
              ]
            : packProvides("dom-live")
            ? [
                `- A Context Pack (live DOM${packProvides("api-operations") ? ` + ${PACK_CONTRACTS_NOUN}` : ""}) was pushed into this prompt by the`,
                `  orchestrator before this session started. Where the pack supplies the DOM for a route,`,
                `  TRANSCRIBE selectors directly from the "Live DOM" section — do NOT use ${browser.navigate} or`,
                `  ${browser.snapshot} on routes already covered in the pack.`,
                `  For routes NOT covered in the pack (not listed in the DOM section), use ${browser.name}`,
                `  to explore the live page before writing selectors.`,
              ]
            : treeInPrompt
            ? [
                `- An injected a11y tree is provided below for the affected routes —`,
                `  transcribe selectors from it; do NOT ${browser.navigate} a route it covers. Use ${browser.name}`,
                `  only for a route NOT present in that tree.`,
              ]
            : [
                `- You MUST read the live page with ${browser.name} BEFORE writing any test: ${browser.navigate} to`,
                `  the LIVE DEV URL above, then ${browser.snapshot} to read the ACTUAL DOM. Selectors MUST be verified`,
                `  against the real DOM, NEVER invented from code analysis alone.`,
                ...(browser.runtimeSignals ? RUNTIME_SIGNALS_LINES : []),
              ]),
          /* Where the contract is, as a fact; the static layers own the rule for reading it. */
          ...(openapiHint ? [`- OpenAPI contract(s) for this repo: ${openapiHint}.`] : []),
        ]),
  ];
  const workingRulesContent = workingRulesLines.join("\n");
  return { content: workingRulesContent, claims: workingRulesClaims(ctx) };
}

/* The run's namespace for the data its tests create: a fact of the run, so it renders apart from the working rules and outside the stable prefix. */
function renderTestDataPrefix({ input }: PromptContext): SectionRender {
  return { content: `- Test-data prefix: ${input.namespace}` };
}

function renderRegenDiscipline(ctx: PromptContext): SectionRender {
  const { isReGen, blastRadiusGrounded } = ctx;
  const regenDisciplineContent = isReGen
    ? [
        `## Re-generation turn — do NOT re-orient`,
        ``,
        blastRadiusGrounded
          ? `Re-generation turn: the blast radius was already explored and distilled above. Do NOT trace the`
          : `Re-generation turn: do NOT trace the`,
        `change's callers again, do NOT re-skim the repository or re-read unchanged`,
        blastRadiusGrounded
          ? `code. Work from the grounding already in this prompt and change only what the correction requires.`
          : `code. Change only what the correction requires.`,
        `(One exception: if a correction names a specific symbol you have not seen, read ONLY that symbol.)`,
        ``,
      ].join("\n")
    : "";
  /* The one exception to the rule against re-reading: a symbol a correction names and the grounding lacks. */
  return { content: regenDisciplineContent, claims: regenDisciplineContent ? [claim.directs("read")] : [] };
}

/* The map whole; over the window, one line naming what it holds and the file it is in. */
function renderArchMap(ctx: PromptContext): SectionRender {
  const { archMap, input } = ctx;
  const map = input.contextMap;
  const reference = archMap && map
    ? [
        `## ${PROMPT_HEADINGS.architectureContext} (from ${input.e2eRelDir}/.qa/context.json)`,
        `The map's ${map.routes.length} route(s), ${map.api.length} API operation(s), ${map.feBe?.length ?? 0} FE↔BE link(s) and ${map.flows?.length ?? 0} named flow(s) are ${NOT_SHOWN}: they are in ${input.e2eRelDir}/.qa/context.json.`,
        ``,
      ].join("\n")
    : "";
  return {
    content: [archMap?.text ?? "", ``].join("\n"),
    claims: archMap?.claims ?? [],
    ...(archMap ? { itemIds: archMap.itemIds, omissions: archMap.omissions } : {}),
    ...(archMap ? { degrade: (step: number) => (step === 1 ? { content: reference, omissions: [...archMap.omissions, { class: "truncation" as const, reason: WINDOW_FIT_REASON, count: archMap.itemIds.length }] } : undefined) } : {}),
  };
}

function renderStaticSignal(ctx: PromptContext): SectionRender {
  const content = ctx.input.staticSignal ?? "";
  const signalFact = ctx.blastRadiusGrounded ? "structural-signal" : "co-change";
  /* Whole while the window holds it; over it, the lists give way to the files they name, the last symbol list first. */
  return { content, claims: [claim.provides(signalFact), claim.frames(signalFact, "unverified")], itemIds: advisoryLineIds(content), degrade: advisoryListsDegrade(content) };
}

/* The links and the drift whole while the window holds them; over it, the links the change reaches stay and the others are counted, then every link is counted, then the drift too. */
function renderServiceLinks(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode } = ctx;
  /* Local sanitize wrapper (this function's own scope — NOT the DIFFERENT s() declared inside renderArchitectureContext further down this file) so untrusted cross-repo strings (data leaving/entering the model boundary) are redacted before reaching the prompt. */
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const hasServiceLinks = Boolean(input.serviceLinks?.length);
  const hasContractDrift = Boolean(input.contractDrift?.length);
  const linkKey = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string =>
    `${l.from.repo}/${l.from.file}#${l.from.symbol}->${l.to.repo}`;
  const impactedTierByKey = new Map(
    (input.crossRepoImpact?.impactedLinks ?? []).map(({ link, tier }) => [linkKey(link), tier] as const),
  );
  const tierFor = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string | undefined =>
    impactedTierByKey.get(linkKey(l));
  const orderedLinks =
    impactedTierByKey.size > 0 && hasServiceLinks
      ? [
          ...input.serviceLinks!.filter((l) => tierFor(l) !== undefined),
          ...input.serviceLinks!.filter((l) => tierFor(l) === undefined),
        ]
      : input.serviceLinks ?? [];
  type Link = (typeof orderedLinks)[number];
  const impactedLinks = orderedLinks.filter((l) => tierFor(l) !== undefined);
  const drift = input.contractDrift ?? [];
  const render = (shownLinks: readonly Link[], driftShown: boolean): string =>
    [
      `## ${PROMPT_HEADINGS.crossServiceLinks} (deterministic — from the stitcher, advisory)`,
      "Structural cross-service contract links resolved from the code, advisory and NOT a gate; absent links do NOT imply no dependency. Transport/source name how each hop was derived (FE→BE HTTP, BE→BE HTTP, event).",
      "",
      ...shownLinks.map((l) => renderServiceLinkLine(l, s, tierFor(l))),
      ...(shownLinks.length < orderedLinks.length ? [`${orderedLinks.length - shownLinks.length} link(s) are ${NOT_SHOWN}.`] : []),
      ...(hasContractDrift
        ? ["", `### ${CONTRACT_DRIFT_HEADING} (WARNINGS — front calls an endpoint the backend contract does not declare):`,
           ...(driftShown
             ? drift.map((d) => `- WARNING: \`${s(d.from.repo)}/${s(d.from.file)}#${s(d.from.symbol)}\` calls ${s(d.verb)} ${s(d.path)} — not in the contract`)
             : [`${drift.length} warning(s) are ${NOT_SHOWN}.`])]
        : []),
    ].join("\n");
  const present = (hasServiceLinks || hasContractDrift) && isGenerationMode;
  const serviceLinksContent = present ? render(orderedLinks, true) : "";

  const serviceLinksClaims: PromptClaim[] = serviceLinksContent
    ? [claim.provides("service-links"), claim.frames("service-links", "unverified")]
    : [];
  const itemsOf = (links: readonly Link[]): string[] => links.map((l) => itemId.svcLink(l));
  /* The renders the window can ask for, each with the links it keeps and what it leaves out. */
  const steps: Array<{ links: readonly Link[]; driftShown: boolean }> = [
    ...(impactedLinks.length > 0 && impactedLinks.length < orderedLinks.length ? [{ links: impactedLinks, driftShown: true }] : []),
    ...(orderedLinks.length > 0 ? [{ links: [] as readonly Link[], driftShown: true }] : []),
    ...(drift.length > 0 ? [{ links: [] as readonly Link[], driftShown: false }] : []),
  ];
  const degrade = (step: number): SectionDegradation | undefined => {
    const next = steps[step - 1];
    if (!present || next === undefined) return undefined;
    return {
      content: render(next.links, next.driftShown),
      itemIds: itemsOf(next.links),
      omissions: [{ class: "truncation", reason: WINDOW_FIT_REASON, count: orderedLinks.length - next.links.length + (next.driftShown ? 0 : drift.length) }],
    };
  };
  return {
    content: serviceLinksContent,
    claims: serviceLinksClaims,
    ...(hasServiceLinks ? { itemIds: itemsOf(orderedLinks) } : {}),
    ...(present ? { degrade } : {}),
  };
}

function renderSkillExemplars(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode } = ctx;
  const skillExemplarsContent = (() => {
    if (!isGenerationMode || !input.skillExemplars?.length) return "";
    const proven: Record<string, number> = {};
    for (const e of input.skillExemplars) if (e.proven && e.promotionCount > 0) proven[e.archetype] = e.promotionCount;
    return renderExemplarsForPrompt(input.skillExemplars, { proven });
  })();
  const exemplars = input.skillExemplars?.length ?? 0;
  return {
    content: skillExemplarsContent,
    claims: [claim.provides("exemplars")],
    degrade: referenceDegrade(`## Skill exemplars for the detected structural patterns\n${exemplars} test template(s) for the patterns this change shows are ${NOT_SHOWN}.`, exemplars),
  };
}

function renderAppLogin(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode, isCode } = ctx;
  const authSetupPath = `${input.e2eRelDir}/auth.setup.ts`;
  const appLoginContent =
    input.authSeedUnauthored && isGenerationMode && !isCode
      ? [
          `## ${PROMPT_HEADINGS.appLogin}`,
          `${PROMPT_HEADINGS.appLogin} is configured, but ${authSetupPath} is still the stock seed and did not sign in.`,
          `Rewrite ${authSetupPath}: open the login page with the Playwright MCP and read its real fields before writing selectors.`,
          `Import test from @playwright/test, not from ./fixtures.`,
          `Keep reading DEV_TEST_USER and DEV_TEST_PASS. Delete the seed marker on the first line.`,
          `Wait until the password field is hidden (cookies are set on the redirect) before storageState.`,
          `Then write the specs for this change. Each spec that needs the app calls authenticate().`,
          `The orchestrator signs in with your setup file before execute.`,
        ].join("\n")
      : "";
  return { content: appLoginContent, shedAs: "critical-recap" };
}

/* The pack whole; over the window its Live DOM gives way page by page, the lowest-ranked page first, each named by its route, then its availability facts, the last-ranked first, counted. */
function renderContextPack(ctx: PromptContext): SectionRender {
  const { input, contextPackContent, contextPackClaims } = ctx;
  return {
    content: contextPackContent,
    shedAs: "critical-recap",
    claims: contextPackClaims,
    ...(input.contextPackItemIds ? { itemIds: input.contextPackItemIds } : {}),
    ...(input.contextPackOmissions ? { omissions: input.contextPackOmissions } : {}),
    degrade: packDegrade({
      pack: contextPackContent,
      liveDom: PACK_HEADINGS.liveDom,
      ...(input.contextPackItemIds ? { itemIds: input.contextPackItemIds } : {}),
      ...(input.contextPackOmissions ? { omissions: input.contextPackOmissions } : {}),
    }),
  };
}

function renderDomSnapshot(ctx: PromptContext): SectionRender {
  const { isGenerationMode, sanitizedDomSnapshot, hasFailureTree, hasLiveTree } = ctx;
  const domContent = sanitizedDomSnapshot && isGenerationMode
    ? hasFailureTree
      ? [
          `## ${PROMPT_HEADINGS.groundTruthAtFailure}`,
          ``,
          `The tree below is the page AT THE FAILURE POINT — the ONLY source of truth for this fix.`,
          `Do NOT use general knowledge of what tables, forms, or components usually contain.`,
          `The ACTUAL rendered tree is what matters, and it is captured below.`,
          ``,
          `⚠ Counterfactual warning: even if element types commonly expose a given role`,
          `(e.g. tables commonly expose \`columnheader\`, forms commonly expose \`textbox\`),`,
          `if THIS tree does NOT show it — trust the tree, not the convention. The live page`,
          `may use CSS \`role="presentation"\` or a custom component that drops standard roles.`,
          ``,
          `📌 Quote-then-assert contract: before writing any locator, cite the EXACT \`role: name\``,
          `line from the tree below that the locator relies on. An unquotable locator`,
          `(i.e. no matching line exists in this tree) MUST be rejected and replaced with a`,
          `\`getByText\` locator quoted from the SAME tree — text visible in the tree below. NEVER`,
          `invent a CSS selector or data-testid value that is not present in this grounding.`,
          ``,
          sanitizedDomSnapshot,
          ``,
        ].join("\n")
      : [
          `## ${PROMPT_HEADINGS.liveDevTree} (GROUND TRUTH for selectors — trust this over HTML intuition)`,
          ``,
          `These are the roles + accessible names the browser ACTUALLY exposes for the target routes.`,
          `Lines may carry a trailing \`-> [attr=…]\` hint showing id=, name=, href, or type= as well as the test-id attribute.`,
          `Author selectors ONLY from what appears below:`,
          `- If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the a11y tree —`,
          `  do NOT use \`getByRole\` for it. Fall back to \`getByText\` or a scoped locator.`,
          `- If a name appears MORE THAN ONCE, a bare \`getByRole\`/\`getByText\` matches multiple elements`,
          `  (strict-mode violation) — scope it to a unique parent/section, or use a unique attribute.`,
          ``,
          `Lines tagged [CHANGED: …] are what THIS change introduced — your objective targets these.`,
          ``,
          sanitizedDomSnapshot,
          ``,
        ].join("\n")
    : "";

  const domClaims: PromptClaim[] =
    domContent === ""
      ? []
      : hasFailureTree
      ? [claim.provides("dom-failure"), claim.frames("dom-failure", "established")]
      : [claim.provides("dom-live"), claim.frames("dom-live", "established")];
  return { content: domContent, claims: domClaims };
}

function renderSelectorContradictions(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode, hasFailureTree, hasLiveTree, treeInPrompt } = ctx;
  const selectorContradictionsContent =
    input.selectorContradictions?.length && isGenerationMode
      ? [
          `## ⚠ Lever-2 selector contradictions (DETERMINISTIC — resolve EVERY one)`,
          ``,
          `These selectors were checked against ${hasFailureTree ? "the captured failure-point tree above" : hasLiveTree ? "the captured tree above" : "the page's captured a11y tree"} and FAILED.`,
          `Each is a verified fact, not a hint: a contradicted \`role:name\` is NOT ${treeInPrompt ? "in the captured tree" : "on the page"}`,
          `(the listed present roles are what IS there) — do NOT re-use it. Replace it with a role/name`,
          `${treeInPrompt ? "that appears in the tree" : "from the present roles listed"}, or a \`getByText\`/scoped locator; for a "matches MULTIPLE" finding,`,
          `scope the locator to a unique parent. You MUST resolve every item before finishing:`,
          ``,
          "```",
          ...input.selectorContradictions.map((c) => `- ${sanitizeText(c).text}`),
          "```",
          ``,
        ].join("\n")
      : "";

  const selectorContradictionsClaims: PromptClaim[] = !selectorContradictionsContent
    ? []
    : hasFailureTree
    ? [claim.directs("consult", "dom-failure")]
    : hasLiveTree
    ? [claim.directs("consult", "dom-live")]
    : [];
  return { content: selectorContradictionsContent, claims: selectorContradictionsClaims };
}

function renderFixCases(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode, isCode, hasFailureTree, treeInPrompt, editableListed, browser, groundingUncoveredEscape: GROUNDING_UNCOVERED_ESCAPE } = ctx;
  const hasStaticGateCase = Boolean(input.fixCases?.some((c) => c.name === "static-gate"));
  /* The listing tells the agent to read the specs it changes; where it does not, the fix reads the test file itself. */
  const readTestStep = editableListed ? [] : [FIX_STEPS.readTestFile];

  /* The failed cases as the prompt lists them, whole while the window holds them. */
  const casesText = (shape: FixCaseShape): string => (input.fixCases ?? []).flatMap((c) => renderFixCase(c, shape)).join("\n");
  const fixContent = input.fixCases?.length && isGenerationMode
    ? [
        `## Fix failing tests`,
        ``,
        ...(hasStaticGateCase
          ? [
              `The following is a failing gate (static analysis — compile/lint), not an executed test`,
              `failure. Fix the underlying error; do NOT rewrite or touch tests that passed the gate.`,
            ]
          : [
              `The following tests FAILED during execution${isCode ? "" : " against DEV"}. Fix ONLY these`,
              `tests; do NOT rewrite or touch tests that passed.`,
            ]),
        ``,
        `Failed cases:`,
        casesText("whole"),
        ``,
        ...(hasFailureTree
          ? [
              `The captured a11y tree at the failure point is injected ABOVE as "${PROMPT_HEADINGS.groundTruthAtFailure}".`,
              ...numbered([
                ...readTestStep,
                [
                  `Consult ONLY that tree — do NOT navigate or snapshot the live page.`,
                  `   The tree above is the page AT THE FAILURE POINT, not the current live state.`,
                  `   ${GROUNDING_UNCOVERED_ESCAPE}`,
                ].join("\n"),
                [
                  `Fix the ROOT CAUSE, guided by the error type:`,
                  `   - "strict mode violation" → scope the selector to a section first`,
                  `   - "locator.click: … not found" → the element doesn't exist; check role/label in that tree`,
                  `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
                  `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
                ].join("\n"),
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]
          : treeInPrompt
          ? [
              `Fix from the injected grounding above (the DOM tree) — do NOT navigate to re-derive`,
              `a route it already covers; navigate ONLY a route absent from the injected grounding.`,
              GROUNDING_UNCOVERED_ESCAPE,
              ...numbered([
                ...readTestStep,
                `Resolve the failing selector/assertion against the injected grounding above`,
                [
                  `Fix the ROOT CAUSE, guided by the error type:`,
                  `   - "strict mode violation" → scope the selector to a section first`,
                  `   - "locator.click: … not found" → the element doesn't exist; check role/label in the injected grounding`,
                  `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
                  `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
                ].join("\n"),
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]
          : isCode
          ? [
              `For each failure:`,
              ...numbered([
                ...readTestStep,
                FIX_STEPS.readCodeUnderTest,
                `Fix the ROOT CAUSE: a wrong expectation, a wrong test double or setup, or a compile error`,
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]
          : [
              `For each failure, use ${browser.name} to explore the page and verify`,
              `your fix BEFORE writing it:`,
              ...numbered([
                ...readTestStep,
                `Use ${browser.navigate} + ${browser.snapshot} to see the ACTUAL page structure`,
                [
                  `Fix the ROOT CAUSE, guided by the error type:`,
                  `   - "strict mode violation" → scope the selector to a section first`,
                  `   - "locator.click: … not found" → the element doesn't exist; check role/label`,
                  `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
                  `   - "NS_ERROR_…" / network error → the URL or route is wrong; verify with ${browser.navigate}`,
                  `   - "locator resolved to N elements" → use .first() ONLY as last resort; prefer scoping`,
                ].join("\n"),
                FIX_STEPS.changeOnlyWhatIsBroken,
              ]),
            ]),
        ``,
      ].join("\n")
    : "";

  /* Where the fix turns for the page, following the branch of the text that renders: the tree captured at the failure or any other injected tree (each with the way out for a route it does not cover), or the live page (a code run has none). A failing gate is a fact of its own: nothing was executed. */
  const fixContentClaims: PromptClaim[] = !fixContent
    ? []
    : [
        ...(hasStaticGateCase ? [claim.provides("gate-failure")] : []),
        ...(hasFailureTree
          ? [claim.directs("consult", "dom-failure"), claim.directs("use-browser-for-uncovered-route")]
          : treeInPrompt
          ? [claim.directs("consult", "dom-live"), claim.directs("use-browser-for-uncovered-route")]
          : isCode
          ? []
          : [claim.directs("use-runtime-signals")]),
      ];
  /* Over the window the failed cases give up their evidence lines, then all but the first line of their error, then their error; the instructions stay. */
  const whole = casesText("whole");
  const shapes: FixCaseShape[] = ["no-evidence", "first-line", "named"];
  const degrade = fixContent
    ? (step: number): SectionDegradation | undefined => {
        const shape = shapes[step - 1];
        return shape === undefined
          ? undefined
          : { content: fixContent.replace(whole, () => casesText(shape)), omissions: [{ class: "truncation", reason: WINDOW_FIT_REASON, count: input.fixCases?.length ?? 0 }] };
      }
    : undefined;
  return { content: fixContent, claims: fixContentClaims, ...boundOmissions(fixContent), ...(degrade ? { degrade } : {}) };
}

function renderReviewerCorrections(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode, isCode, hasFailureTree, treeInPrompt, browser, groundingUncoveredEscape: GROUNDING_UNCOVERED_ESCAPE } = ctx;
  const reviewContent = input.reviewCorrections?.length && isGenerationMode
    ? [
        `## Apply reviewer corrections (HIGHEST priority)`,
        ``,
        `An independent reviewer REJECTED the previous specs. Address each finding below: fix the spec`,
        `when the finding holds, or rebut it with the evidence the correction turn accepts when you can show`,
        `it is wrong. Do NOT rewrite specs that were not flagged.`,
        treeInPrompt
          ? `Re-verify against the injected grounding above (the DOM tree) before editing — do NOT re-navigate a route it already covers. ${GROUNDING_UNCOVERED_ESCAPE}`
          : isCode
          ? `Where a fix concerns an assertion, re-verify it against the code under test before editing.`
          : `Where a fix concerns a selector or an assertion, re-verify it against the live page with ${browser.name} before editing.`,
        ``,

        ...input.reviewCorrections.map((c) => `- ${sanitizeText(c).text}`),
        ``,
      ].join("\n")
    : "";
  /* Where a correction is re-verified, following the branch of the text that renders: the injected tree, the code under test, or the live page. */
  const reviewClaims: PromptClaim[] = !reviewContent
    ? []
    : treeInPrompt
    ? [claim.directs("consult", hasFailureTree ? "dom-failure" : "dom-live"), claim.directs("use-browser-for-uncovered-route")]
    : isCode
    ? []
    : [claim.directs("use-runtime-signals")];
  /* The corrections are what the turn answers: whole, never degraded for the window. */
  return { content: reviewContent, claims: reviewClaims, overflow: "drop" };
}

function renderCoverageGap(ctx: PromptContext): SectionRender {
  const { input, isGenerationMode, hasFailureTree, treeInPrompt, groundingUncoveredEscape: GROUNDING_UNCOVERED_ESCAPE } = ctx;
  const sectionOf = (gap: string): string => [
    `## Cover the change (HIGH priority)`,
    ``,
    `The tests ran green but did NOT exercise all of what this commit changed (the lines or decision`,
    `arms below). Extend or add tests so each is actually executed and asserted (covering ≠ asserting —`,
    `assert the behavior of the changed code, do not just touch the line). An arm the page cannot be`,
    `brought to through the UI against DEV (one only a mocked network could provoke) is not a case:`,
    `leave it and say why in your verdict note.`,
    ``,
    ...(treeInPrompt
      ? [
          `Resolve any new selectors from the injected grounding above — do NOT re-navigate routes it already covers.`,
          GROUNDING_UNCOVERED_ESCAPE,
          ``,
        ]
      : []),
    gap,
    ``,
  ].join("\n");
  const coverageContent = input.coverageGap && isGenerationMode ? sectionOf(input.coverageGap) : "";
  const coverageClaims: PromptClaim[] = coverageContent && treeInPrompt
    ? [claim.directs("consult", hasFailureTree ? "dom-failure" : "dom-live"), claim.directs("use-browser-for-uncovered-route")]
    : [];
  /* Every unit of the gap is listed while the prompt fits the window; over it, the gap is the files it is about and how many units each holds. */
  const reference = input.coverageGapReference;
  const degrade = coverageContent && reference ? referenceDegrade(sectionOf(`${reference}\n(The lines and arms themselves are ${NOT_SHOWN}.)`), input.coverageGap!.split("\n").length) : undefined;
  return { content: coverageContent, claims: coverageClaims, shedAs: "critical-recap", ...(degrade ? { degrade } : {}) };
}

/* A-2b: the deltas the intent lock found in the previous turn, as facts of this one. Sanitized, and never an order: the generator decides how to restore what its bytes weakened. */
function renderContractFeedback(ctx: PromptContext): SectionRender {
  const violations = ctx.input.contractFeedback ?? [];
  const content = renderContractViolations(violations);
  const shapes: ContractViolationShape[] = ["named", "counted"];
  return {
    content,
    overflow: "drop",
    ...boundOmissions(content),
    degrade: (step) => {
      const shape = shapes[step - 1];
      return shape === undefined ? undefined : { content: renderContractViolations(violations, shape), omissions: [{ class: "truncation", reason: WINDOW_FIT_REASON, count: violations.length }] };
    },
  };
}

/* The omission the safety bound on evidence text records when it cut something in a rendered section. */
function boundOmissions(rendered: string): { omissions?: Omission[] } {
  const cut = boundedEvidenceCount(rendered);
  return cut > 0 ? { omissions: [{ class: "truncation", reason: EVIDENCE_SAFETY_BOUND_REASON, count: cut }] } : {};
}

function renderTask(ctx: PromptContext): SectionRender {
  const { input, mapInjected, blastRadiusGrounded, assembly } = ctx;
  const guards = { mapInjected, blastRadiusGrounded, suiteListed: assembly.suiteListed, reaskObjective: assembly.reaskObjective };
  const task = buildTask(input, guards);
  /* Over the window the commit body goes first, as the line that says where to read it. */
  const bodyAside = task.commitBodyLines !== undefined ? buildTask(input, { ...guards, commitBody: "reference" }) : undefined;
  const bodyOmission = { class: "truncation" as const, reason: WINDOW_FIT_REASON, count: task.commitBodyLines ?? 0 };
  /* The task carries the commit diff only on a code run's diff turn: whole, and over the window its hunks give way as references inside the task's own text. */
  const whole = task.diff !== undefined ? commitDiffBlock(task.diff) : undefined;
  const diffDegrade = task.diff !== undefined && whole !== undefined ? diffWindowDegrade(task.diff, (section) => (bodyAside ?? task).text.replace(whole, () => section)) : undefined;
  const degrade = bodyAside
    ? (step: number): SectionDegradation | undefined => {
        if (step === 1) return { content: bodyAside.text, omissions: [bodyOmission] };
        const next = diffDegrade?.(step - 1);
        return next ? { ...next, omissions: [bodyOmission, ...next.omissions] } : undefined;
      }
    : diffDegrade;
  return { content: task.text, claims: task.claims, ...boundOmissions(task.text), ...(degrade ? { degrade } : {}) };
}

/* Every definition appears in the order the prompt lists its sections. A definition whose `applies` is false leaves nothing in the assembled prompt. */
export const GENERATOR_SECTIONS: readonly PromptSectionDef<PromptContext>[] = [
  { id: "working-rules", tier: "stable-prefix", priority: 1, stability: "static", reason: "The mode's rules: where the suite lives, the specMetas the manifest is written from, when to read the live page", applies: () => true, render: renderWorkingRules },
  { id: "regen-discipline", tier: "stable-prefix", priority: 2, stability: "static", reason: "A regeneration re-oriented and re-read the repository instead of answering its correction (RE-1, d45c3cea)", applies: (ctx) => ctx.isReGen, render: renderRegenDiscipline },
  /* First of the run's facts: the test-data prefix, right after the stable prefix. */
  { id: "test-data-prefix", tier: "semi-stable", priority: -1, stability: "run", reason: "The run's namespace for the data its tests create, kept out of the working rules so the stable prefix carries no run id", applies: (ctx) => ctx.input.mode !== "context" && !ctx.isCode, render: renderTestDataPrefix },
  { id: "arch-map", tier: "semi-stable", priority: 1, stability: "run", reason: "The stored context map, so the agent consumes the FE-BE map instead of rebuilding it from files (5298e9ea)", applies: (ctx) => Boolean(ctx.input.contextMap), render: renderArchMap },
  {
    id: HARNESS_FACTS_SECTION_ID,
    tier: "semi-stable",
    priority: 0, stability: "run", reason: "Authors read the fixtures and the Playwright config on every turn; the run already held them (2ffab22f)",
    applies: (ctx) => ctx.isGenerationMode && Boolean(ctx.input.harnessFacts),
    render: (ctx) => ({ content: renderHarnessFacts(ctx.input.harnessFacts!, ctx.input.e2eRelDir), claims: [claim.provides("harness-facts")] }),
  },
  {
    id: CLOSED_LOOP_SECTION_ID,
    tier: "semi-stable",
    priority: 0, stability: "run", reason: "States the run_spec budget, and only when the run granted the tool (8301dacb)",
    /* The lead plans with neither tool: a planning turn is not told their budgets. */
    applies: (ctx) => ctx.isGenerationMode && ctx.input.target === "e2e" && Boolean(ctx.input.closedLoop) && !ctx.planningTurn,
    render: (ctx) => ({ content: renderClosedLoop(ctx.input.closedLoop!), claims: [claim.provides("closed-loop")] }),
  },
  {
    id: AGENT_BROWSER_SECTION_ID,
    tier: "semi-stable",
    priority: 0, stability: "run", reason: "States the authenticated browser budget, and only when the run granted it (eb23387c)",
    applies: (ctx) => ctx.isGenerationMode && ctx.input.target === "e2e" && Boolean(ctx.input.agentBrowser) && !ctx.planningTurn,
    render: (ctx) => ({ content: renderAgentBrowser(ctx.input.agentBrowser!), claims: [claim.provides("agent-browser")] }),
  },
  {
    id: GEOLOCATION_SECTION_ID,
    tier: "semi-stable",
    priority: 0, stability: "run", reason: "Where the authoring scope is, so a spec whose result depends on a location pins it (fbca018f)",
    applies: (ctx) => ctx.isGenerationMode && ctx.input.target === "e2e" && Boolean(ctx.input.geolocation),
    render: (ctx) => ({ content: renderGeolocation(ctx.input.geolocation!), claims: [claim.provides("geolocation")] }),
  },
  {
    id: SUITE_LISTING_SECTION_ID,
    tier: "semi-stable",
    priority: 2, stability: "run", reason: "The specs that already exist, so a flow's spec is updated instead of duplicated; which ones this turn may change",
    applies: (ctx) => ctx.suiteIsListed,
    render: (ctx) => {
      const cut = ctx.listing.entries.filter((entry) => entry.cut).length;
      /* Every entry while the window holds the listing; over it, the entries to leave alone as their directories, then the unnamed editable ones. An entry cut at the safety bound is recorded. */
      return {
        content: ctx.listingContent,
        claims: [claim.provides("existing-suite")],
        degrade: suiteListingDegrade(ctx.listing),
        ...(cut > 0 ? { omissions: [{ class: "truncation" as const, reason: LISTING_ENTRY_SAFETY_BOUND_REASON, count: cut }] } : {}),
        ...(ctx.editableListed ? { overflow: "summarize" as const } : {}),
      };
    },
  },
  { id: "static-signal", tier: "semi-stable", priority: 3, stability: "run", reason: "Advisory structural or co-change signal of what the change reaches, framed unverified (643c4672)", applies: (ctx) => Boolean(ctx.input.staticSignal && ctx.isGenerationMode), render: renderStaticSignal },
  {
    id: "service-links",
    tier: "semi-stable",
    priority: 3, stability: "run", reason: "Cross-repo runs: the stitcher's links and contract drift one repository does not show (0c348e62)",
    applies: (ctx) => (Boolean(ctx.input.serviceLinks?.length) || Boolean(ctx.input.contractDrift?.length)) && ctx.isGenerationMode,
    render: renderServiceLinks,
  },
  { id: "skill-exemplars", tier: "semi-stable", priority: 3, stability: "run", reason: "Proven test archetypes matched to the change; restored in 8379da09 to give its module a caller, no observed failure behind it", applies: (ctx) => ctx.isGenerationMode && Boolean(ctx.input.skillExemplars?.length), render: renderSkillExemplars },
  {
    id: APP_LOGIN_SECTION_ID,
    tier: "volatile",
    priority: 0, stability: "run", reason: "The stock login seed did not sign in: the author rewrites auth.setup.ts before the specs",
    applies: (ctx) => Boolean(ctx.input.authSeedUnauthored) && ctx.isGenerationMode && !ctx.isCode,
    render: renderAppLogin,
  },
  { id: "context-pack", tier: "volatile", priority: 0, stability: "run", reason: "Live DOM and API contracts the orchestrator captured, so selectors are transcribed, never invented (178a8ea2)", applies: (ctx) => ctx.contextPackContent !== "", render: renderContextPack },
  /* VOLATILE: grounding (DOM snapshot — priority 1 within VOLATILE so it's first and the selectorContradictions section can reference "the tree above" correctly). */
  { id: "dom-snapshot", tier: "volatile", priority: 1, stability: "run", reason: "The affected routes' accessibility tree when no Context Pack carries the DOM (71f21e5e)", applies: (ctx) => Boolean(ctx.sanitizedDomSnapshot) && ctx.isGenerationMode, render: renderDomSnapshot },
  {
    id: "selector-contradictions",
    tier: "volatile",
    priority: 2, stability: "run", reason: "Selectors the catalog gate found fabricated against a settled capture: the one corrective regeneration (875a6004)",
    applies: (ctx) => Boolean(ctx.input.selectorContradictions?.length) && ctx.isGenerationMode,
    render: renderSelectorContradictions,
  },
  { id: "fix-cases", tier: "volatile", priority: 3, stability: "run", reason: "The failing cases of the last execution with their ground truth at failure: what the fix loop corrects", applies: (ctx) => Boolean(ctx.input.fixCases?.length) && ctx.isGenerationMode, render: renderFixCases },
  /* VOLATILE: reviewer corrections (priority 4 — after grounding context is established). */
  {
    id: "reviewer-corrections",
    tier: "volatile",
    priority: 4, stability: "run", reason: "The reviewer's verified blocking findings a regeneration must answer",
    applies: (ctx) => Boolean(ctx.input.reviewCorrections?.length) && ctx.isGenerationMode,
    render: renderReviewerCorrections,
  },
  {
    id: CONTRACT_FEEDBACK_SECTION_ID,
    tier: "volatile",
    priority: 4, stability: "run", reason: "The intent lock's contract deltas, handed back to the turn that must restore them (abb73758)",
    applies: (ctx) => Boolean(ctx.input.contractFeedback?.length) && ctx.isGenerationMode,
    render: renderContractFeedback,
  },
  { id: "coverage-gap", tier: "volatile", priority: 5, stability: "run", reason: "The changed lines and arms no test ran: the one coverage or branch-case regeneration (change-coverage)", applies: (ctx) => Boolean(ctx.input.coverageGap) && ctx.isGenerationMode, render: renderCoverageGap },
  {
    id: "learned-rules",
    tier: "volatile",
    priority: 2, stability: "run", reason: "Proven rules of the app's cross-run learning ledger",
    applies: (ctx) => Boolean(ctx.input.learnedRules) && ctx.isGenerationMode,
    render: (ctx) => ({ content: [ctx.input.learnedRules, ``].join("\n"), claims: [claim.provides("learned-rules")] }),
  },
  { id: "task", tier: "task", priority: 1, stability: "run", reason: "The turn's task and procedure for its mode, with the run's change and guidance", applies: () => true, render: renderTask },
  {
    id: "diff",
    tier: "task",
    priority: 2, stability: "run", reason: "The commit diff a diff run's first pass tests, relevance-ordered (178a8ea2)",
    applies: (ctx) => ctx.isGenerationMode && ctx.input.target !== "code" && ctx.input.mode === "diff" && !ctx.isReGen,
    /* The lead's planning diff is fitted to its window by the builder (planDiffShown); the author's is whole, and over the window gives hunks up as references. */
    render: (ctx) => ({ content: ctx.planDiff ? ctx.planDiff.render(ctx.planDiffShown) : buildDiffSection(ctx.input), shedAs: "semi-stable", claims: [claim.provides("diff")], ...(ctx.planDiff ? {} : { degrade: diffWindowDegrade(ctx.input.diff) }) }),
  },
  /* The cap the runtime enforces for this turn, when the host resolved one: a fact of its own, then, on a turn that writes tests, the step by which it should have written something. Both close the prompt. */
  {
    id: LEAD_PLAN_SECTION_ID,
    tier: "critical-recap",
    priority: 0, stability: "run", reason: "The plan contract a coordinated run's lead answers with instead of specs (2c566984)",
    applies: (ctx) => ctx.planningTurn,
    render: (ctx) => ({ content: renderLeadPlan(ctx.input.planning!), claims: [claim.provides("lead-plan")] }),
  },
  {
    id: STEP_LIMIT_SECTION_ID,
    tier: "critical-recap",
    priority: 1, stability: "run", reason: "The cap the runtime enforces, so step exhaustion is classified against the number the prompt stated (78d1bef4)",
    applies: (ctx) => ctx.input.stepLimit !== undefined,
    render: (ctx) => ({ content: renderStepLimit(ctx.input.stepLimit!), claims: [claim.provides("step-limit")] }),
  },
  {
    id: STEP_MILESTONE_SECTION_ID,
    tier: "critical-recap",
    priority: 2, stability: "run", reason: "Turns spent their step budget without writing: the first spec or a reasoned no-op is due by half the limit (78d1bef4)",
    applies: (ctx) => ctx.milestone !== undefined,
    render: (ctx) => ({ content: renderStepMilestone(ctx.milestone!) }),
  },
];
