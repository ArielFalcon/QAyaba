/* Assembles the per-run TASK + CONTEXT the agent receives. The "how" lives in agents/agent/*.md. Diffs are capped then secret-scrubbed; never import src/. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeText, assertNoSecretLeak, type SanitizeMode } from "../sanitize-text.ts";
import { capText, capDiff, extractDiffFilePath } from "../prompt-cap.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type {
  ArchitectureContext,
  CommitIntent,
  OpencodeRunInput,
  ParallelWorkerInput,
  ReviewInput,
  ExplorationBrief,
} from "@contexts/generation/application/ports/generation-ports.ts";
import { ExplorationBriefAdapter, type BriefFns } from "../exploration-brief.adapter.ts";
import { matchExemplars, renderExemplarsForPrompt } from "@kernel/scenario-catalog.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import { assemble, section, type AssembledPrompt } from "./context-assembler.ts";
import { roleWindowBytes } from "./model-window-catalog.ts";

export type { AssembledPrompt };

/* Throws loudly if a brief render is attempted before wiring — never a silent no-op (CLAUDE.md's "surface integration errors loudly" invariant) — but every real production path wires this before any run starts, and every test either wires it locally or never exercises `w.brief`/ `input.contextBrief` (renderBrief is only called when a brief is actually present). */
let explorationBriefAdapter: ExplorationBriefAdapter | undefined;

export function setExplorationBriefCollaborators(fns: BriefFns): void {
  explorationBriefAdapter = new ExplorationBriefAdapter(fns);
}

function renderBrief(brief: ExplorationBrief, opts?: { suppressFeBe?: boolean }): string {
  if (!explorationBriefAdapter) {
    throw new Error(
      "prompts: renderExplorationBrief collaborator not wired — call setExplorationBriefCollaborators() at composition time (see rewritten-engine-factory.ts)",
    );
  }
  return explorationBriefAdapter.render(brief, opts);
}

function renderCommitMessage(intent: CommitIntent | undefined, includeBody: boolean): string {
  const subject = intent?.message ?? "";
  const body = includeBody ? intent?.body : undefined;
  return sanitizeText(body ? `${subject}\n\n${capText(body)}` : subject).text;
}

const ACCEPTANCE_CRITERION_RULE =
  `Before writing, state in ONE line the concrete, user-observable OUTCOME this change introduces — ` +
  `the specific thing a user can see that proves it works (e.g. "the discounted total shows after the ` +
  `cart re-queries"). Write the test to ASSERT that outcome, not merely that the flow runs: the spec ` +
  `MUST fail if this specific behavior regresses.`;

/* THE single way to embed a commit diff into any prompt: capped FIRST (capDiff needs raw `diff --git` boundaries to split/rank files), then secret-scrubbed. Each section is redacted AND guarded (assertNoSecretLeak) independently, with that section's own mode. A diff with no file header at all (several unit-test fixtures pass raw, header-less snippets as `diff`) has no file to key a mode off, so the whole text keeps the prior "model" mode — unchanged for those callers. */
const CODE_FILE_EXTENSIONS = new Set([
  /* Every language this system's watched apps and self-maintenance target today (see CLAUDE.md's "Java + JavaScript/TypeScript" scope note) plus common ecosystems, so a diff hunk touching source code keeps model-mode's narrower, code-aware redaction instead of the config-file default. */
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "go", "rs", "kt", "cs", "rb", "php", "swift",
]);

function diffSectionMode(filePath: string): SanitizeMode {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return CODE_FILE_EXTENSIONS.has(ext) ? "model" : "issue";
}

const DIFF_HEADER_RE = /^diff --git /;

function cappedDiffText(diff: string): string {
  const capped = capDiff(diff);
  const sections = capped.split(/^(?=diff --git )/m);
  const hasFileHeader = sections.some((s) => DIFF_HEADER_RE.test(s));
  if (!hasFileHeader) {
    const redacted = sanitizeText(capped, "model").text;
    assertNoSecretLeak(redacted, "model", "diff→model");
    return redacted;
  }
  return sections
    .map((section) => {
      const mode: SanitizeMode = DIFF_HEADER_RE.test(section) ? diffSectionMode(extractDiffFilePath(section)) : "issue";
      const redacted = sanitizeText(section, mode).text;
      assertNoSecretLeak(redacted, mode, "diff→model");
      return redacted;
    })
    .join("");
}

export function specFileForFlow(flow: string): string {
  const safe = flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  return `flows/${safe}.spec.ts`;
}
export function buildWorkerPromptAssembled(w: ParallelWorkerInput): AssembledPrompt {
  const rules = w.needsUi
    ? [
        w.domSnapshot
          ? `- You have NO browser. The injected a11y tree section in this prompt is your ONLY source of DOM truth — transcribe it directly into selectors; do NOT navigate or snapshot.`
          : `- You have NO browser. No a11y tree was injected — derive selectors from the brief and mark them unverified in a comment (e.g. // selector unverified — no snapshot available).`,
        `- Selector priority: (1) when a tree line's \`-> [attr]\` hint STARTS WITH the configured testIdAttribute name (e.g. \`data-testid=value\`) — not an \`id=\`/\`name=\`/href hint — use \`getByTestId('value')\`; (2) fall back to \`getByRole\`/\`getByLabel\` when no test-id hint is present; (3) no CSS/XPath.`,
        `- Dynamic-DOM: the injected tree is a STATIC snapshot of initial load. Post-interaction elements (modals, dynamic lists) are NOT in this tree — assert them with auto-waiting (\`await expect(locator).toBeVisible()\`, \`waitForURL\`), never \`waitForTimeout\`.`,
        `- getByRole matches the ACCESSIBILITY TREE, not the HTML tag: a <th> is often NOT a "columnheader", a <table> may lose its "table"/"row"/"cell" roles (Bootstrap/CSS strips them). Use ONLY roles + names you LITERALLY SEE in the injected tree; if the role isn't there, use getByText or a scoped locator. A getByRole that matches 0 elements passes review but TIMES OUT on execution.`,
        `- Framework authoring attributes are NOT runtime DOM attributes — never assert them. Examples: Angular's \`routerLink\` is transformed to a rendered \`href\` (assert the \`href\`); \`*ngIf\`, \`ng-reflect-*\`, and \`formControlName\` do not appear in the live DOM (use \`getByLabel\`, \`getByTestId\`, or \`getByRole\` targeting the rendered element instead). The same principle applies to Vue directive attrs and React prop-only attrs. Asserting them always fails at runtime.`,
        `- At least ONE real assertion on the observable OUTCOME (not just a click). Clean up created data via cleanup().`,
      ]
    : [
        `- This is a CODE-ONLY objective (no UI). Read the affected symbols with serena, write unit/integration tests using the repo's test framework.`,
        `- Assert on BEHAVIOR (the correct output for given inputs), not implementation details. Include edge cases from the objective.`,
        `- Do NOT attempt to navigate or use browser tools — you have no Playwright MCP.`,
      ];

  /* STABLE prefix: procedural rules for this worker role (stable across turns/runs for same role). The JSON output contract is kept in its own critical-recap section (canonical order places it after volatile content such as learned-rules, so the "lessons precede the JSON contract" invariant is preserved while also reinforcing the contract at the very end of the prompt). */
  const rulesBlock = [
    ``,
    `## Rules`,
    ...(w.brief
      ? [`- The Exploration brief already distilled the code — do NOT re-explore it with serena.`]
      : []),
    ...rules,
    `- Do NOT write to the manifest — the orchestrator records metadata. Do NOT read or edit other workers' files.`,
  ].join("\n");

  const outputContract = `- End your reply with ONLY this JSON: {"spec":"${w.specFile}"}`;

  const taskHeader = [
    `Write ONE test for this objective. Write ONLY your assigned file.`,
    ``,
    `## ⚠ The ONE required outcome: the file exists on disk`,
    `Your step budget is LIMITED. Writing ${w.e2eRelDir}/${w.specFile} with the \`write\` tool is the only`,
    `result that counts — a perfect spec you never wrote is a TOTAL FAILURE (it counts as a phantom and`,
    `the whole flow is dropped). So: WRITE the file EARLY with selectors from the injected tree,`,
    `and only then refine if budget remains. Never end your turn without having written the file.`,
    ``,
    `## Objective`,
    sanitizeText(w.objective).text,
  ].join("\n");

  const contextLines = [
    `## Context`,
    `- Flow: ${w.flow}`,
    w.brief
      ? `- The blast radius is distilled in the Exploration brief below — use it; do NOT re-read the code.`
      : `- Affected code symbols (read them with serena): ${w.symbols.join(", ") || "(none specified)"}`,
    `- Namespace prefix for any data you create: ${w.namespace}`,
    `- Write EXACTLY this file: ${w.e2eRelDir}/${w.specFile}  — do not create or edit any other file.`,
    ...(w.needsUi ? [`- Import the shared harness: import { test, expect } from "../fixtures"`] : []),
    ...(w.brief ? [``, renderBrief(w.brief)] : []),
  ].join("\n");

  const domContent = w.needsUi && w.domSnapshot
    ? [
        `## Injected a11y tree (GROUND TRUTH — your ONLY source of DOM truth)`,
        `These are the roles + accessible names the browser ACTUALLY exposes for this flow's route(s).`,
        `You have NO browser MCP. You do NOT need to navigate or snapshot — the tree is below.`,
        `Author selectors ONLY from what appears here (transcribe, do NOT guess).`,
        `ONLY the route(s) printed below are grounded. If your objective also touches a route that is NOT`,
        `shown here, mark that route's selectors unverified (e.g. // selector unverified — route not captured).`,
        `If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the tree:`,
        `use \`getByText\` or a scoped locator instead. If a name appears MORE THAN ONCE,`,
        `scope it to a unique parent (a bare getByRole/getByText would match multiple → strict-mode error).`,
        `Lines tagged [CHANGED: …] are what THIS change introduced — your objective targets these.`,
        w.domSnapshot,
      ].join("\n")
    : "";

  const learnedRulesContent = w.learnedRules
    ? [`## Lessons learned from past runs (avoid repeating these)`, w.learnedRules].join("\n")
    : "";

  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_LINKS = 40;
  const MAX_DRIFT = 20;
  const hasLinks = Boolean(w.serviceLinks?.length);
  const hasDrift = Boolean(w.contractDrift?.length);
  const linkKey = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string =>
    `${l.from.repo}/${l.from.file}#${l.from.symbol}->${l.to.repo}`;
  const impactedTierByKey = new Map(
    (w.crossRepoImpact?.impactedLinks ?? []).map(({ link, tier }) => [linkKey(link), tier] as const),
  );
  const tierFor = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string | undefined =>
    impactedTierByKey.get(linkKey(l));
  const orderedLinks =
    impactedTierByKey.size > 0 && hasLinks
      ? [
          ...w.serviceLinks!.filter((l) => tierFor(l) !== undefined),
          ...w.serviceLinks!.filter((l) => tierFor(l) === undefined),
        ]
      : w.serviceLinks ?? [];
  const workerOmittedLinkCount = hasLinks ? Math.max(0, orderedLinks.length - MAX_LINKS) : 0;
  const workerServiceLinksContent =
    hasLinks || hasDrift
      ? [
          "## Cross-service links (deterministic — from the stitcher, advisory)",
          "Structural cross-service contract links resolved from the code, NOT a gate. Verify against the live app; absent links do NOT imply no dependency. Transport/source name how each hop was derived (FE→BE HTTP, BE→BE HTTP, event).",
          "",
          ...(hasLinks
            ? orderedLinks.slice(0, MAX_LINKS).map((l) => {
                const tier = tierFor(l);
                return renderServiceLinkLine(l, s, tier);
              })
            : []),
          ...(workerOmittedLinkCount > 0 ? [`...and ${workerOmittedLinkCount} more link${workerOmittedLinkCount === 1 ? "" : "s"} (truncated at MAX_LINKS=${MAX_LINKS})`] : []),
          ...(hasDrift
            ? ["", "### Contract drift (WARNINGS — front calls an endpoint the backend contract does not declare):",
               ...w.contractDrift!.slice(0, MAX_DRIFT).map((d) =>
                 `- WARNING: \`${s(d.from.repo)}/${s(d.from.file)}#${s(d.from.symbol)}\` calls ${s(d.verb)} ${s(d.path)} — not in the contract`)]
            : []),
        ].join("\n")
      : "";

  return assemble([
    section("worker-rules", "stable-prefix", rulesBlock, { priority: 1, cacheable: true }),
    section("worker-context", "semi-stable", contextLines, { priority: 1 }),
    ...(w.staticSignal ? [section("static-signal", "semi-stable", w.staticSignal, { priority: 3 })] : []),
    ...(workerServiceLinksContent ? [section("worker-service-links", "semi-stable", workerServiceLinksContent, { priority: 3 })] : []),
    ...(domContent ? [section("worker-dom", "volatile", domContent, { priority: 1 })] : []),
    ...(learnedRulesContent ? [section("worker-learned-rules", "volatile", learnedRulesContent, { priority: 2 })] : []),
    section("worker-task", "task", taskHeader, { priority: 1 }),
    section("worker-output-contract", "critical-recap", outputContract, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes(w.needsUi ? "qa-worker" : "qa-worker-code") });
}

export function buildWorkerPrompt(w: ParallelWorkerInput): string {
  return buildWorkerPromptAssembled(w).text;
}

export function buildExplorerPrompt(input: OpencodeRunInput): string {
  /* Rendering the (empty) diff would give the explorer nothing to map, so its brief would be empty and the manual Context Pack would carry no grounding. Drive the exploration from the guidance instead. */
  if (input.mode === "manual") {
    const guidance = sanitizeText((input.guidance ?? "(no guidance provided)").trim()).text;
    return [
      `Explore the blast radius of the following GUIDANCE for ${input.repo} and return a distilled ExplorationBrief.`,
      `You are READ-ONLY: do NOT write tests or any file. Map the affected flows, then emit ONLY the brief JSON.`,
      ``,
      `## Guidance (the user's instruction — the scope to explore)`,
      guidance,
      ``,
      `Use serena (activate_project, find_symbol, find_referencing_symbols) to locate the code that`,
      `implements the guidance's flows and map its blast radius. Stay strictly within the guidance scope.`,
      ...(input.baseUrl ? [``, `Route context only — you do NOT navigate; selectors stay unverified. LIVE DEV URL: ${input.baseUrl}`] : []),
      ...(input.service
        ? [``, `## Cross-repo (microservice)`, `Related service: ${input.service.repo} (a READ-ONLY staged snapshot — contracts + this commit's changed files, not the full source — is at ${input.service.mirrorDir}). Map the FRONTEND flows that exercise it.`]
        : []),
      ``,
      `## Output — set builtForSha to ${input.sha}; end with ONLY the ExplorationBrief JSON (schema in your role prompt).`,
    ].join("\n");
  }
  return [
    `Explore the blast radius of commit ${input.sha} of ${input.repo} and return a distilled ExplorationBrief.`,
    `You are READ-ONLY: do NOT write tests or any file. Map the change, then emit ONLY the brief JSON.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files: ${sanitizeText(input.intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — subject + body)`,
    renderCommitMessage(input.intent, true),
    ``,
    `## Commit diff`,
    "```diff",
    cappedDiffText(input.diff),
    "```",
    ...(input.baseUrl ? [``, `Route context only — you do NOT navigate; selectors stay unverified. LIVE DEV URL: ${input.baseUrl}`] : []),
    ...(input.service
      ? [``, `## Cross-repo change (microservice)`, `The change is in ${input.service.repo} (a READ-ONLY staged snapshot — contracts + this commit's changed files, not the full source — is at ${input.service.mirrorDir}). Map the FRONTEND flows that exercise it.`]
      : []),
    ``,
    `## Output — set builtForSha to ${input.sha}; end with ONLY the ExplorationBrief JSON (schema in your role prompt).`,
  ].join("\n");
}

/* Assembles the dynamic message for the agent. The "how" lives in agents/agent/qa-generator.md and the skills; only the task + context go here. The diff/guidance are sanitized (cheap defense in depth). Return type is unchanged (string). Use buildPromptAssembled() to get the sectionSizes map for telemetry. JD-C3: `hasInjectedGrounding` is a coarse boolean — the injected grounding (Context Pack ≤6 routes / failure DOM ≤4 routes) may NOT cover the route a regen must touch. To avoid suppressing navigation into a blind/wrong fix, every grounded regen branch carries this explicit anti-blinding escape. */
const GROUNDING_UNCOVERED_ESCAPE =
  `If a route you must touch is NOT represented in the injected grounding above, you MUST still ` +
  `browser_navigate that specific route before writing its selectors — never guess them.`;

function linkKindLabel(l: { transport: string; source: string }): string {
  if (l.source === "http-backend-resolver") return "BE→BE HTTP";
  if (l.transport === "event") return "event";
  if (l.transport === "rpc") return "RPC";
  return "FE→BE HTTP";
}

function renderServiceLinkLine(
  l: {
    from: { repo: string; file: string; symbol: string };
    to: { repo: string; symbol: string };
    transport: string;
    source: string;
    contractRef?: string;
    confidence: number;
  },
  s: (x: unknown) => string,
  tier?: string,
): string {
  return `- ${tier ? `[IMPACTED:${s(tier)}] ` : ""}\`${s(l.from.repo)}/${s(l.from.file)}#${s(l.from.symbol)}\` -> ` +
    `${s(l.to.repo)} ${s(l.contractRef ?? l.to.symbol)} (${linkKindLabel(l)}, source ${s(l.source)}, confidence ${l.confidence.toFixed(2)})`;
}

function renderFixCaseEvidenceLines(c: QaCase): string[] {
  const lines: string[] = [];
  if (c.httpStatus !== undefined || c.finalUrl !== undefined) {
    const statusPart = c.httpStatus !== undefined ? `HTTP ${c.httpStatus}` : "HTTP (unknown)";
    const urlPart = c.finalUrl !== undefined ? ` at ${c.finalUrl}` : "";
    lines.push(`  ${statusPart}${urlPart}`);
  }
  if (c.runtimeErrors?.length) {
    for (const e of c.runtimeErrors.slice(0, 3)) {
      lines.push(`  [${e.type}] ${e.text.slice(0, 200)}`);
    }
  }
  return lines;
}

export interface BuildPromptAssembledOpts {
  /** Explicit byte-budget override for tests/telemetry that must not depend on the live model-window catalog. Undefined ⇒ the qa-generator catalog window (production path). */
  budgetBytes?: number;
}

export function buildPromptAssembled(input: OpencodeRunInput, opts: BuildPromptAssembledOpts = {}): AssembledPrompt {
  const isGenerationMode = input.mode !== "context";
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  const memTarget = input.mode === "context" ? "context" : input.target;
  /* Authoritative grounding (Context Pack DOM slice or injected a11y tree): regeneration must not command a re-navigation — the agent fixes from the injected grounding. */
  const hasInjectedGrounding = isGenerationMode && Boolean(input.contextPack || input.domSnapshot);
  /* A re-generation turn (fix / reviewer-corrections / coverage-gap) has already distilled the blast radius — it must not re-activate serena or re-skim the repo. */
  const isReGen =
    isGenerationMode &&
    Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);

  const workingRulesLines: string[] = [
    `## Working rules`,
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
          `- Detect the test framework from the repo's dependencies. Read 2-3 existing test files for conventions. Match them exactly.`,
          `- Place generated tests alongside existing ones. Use the repo's existing test command. Do not install new dependencies.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec so the orchestrator can write the manifest deterministically.`,
          `- Classify each affected symbol:`,
          `  * Pure function → unit test: call with inputs, assert outputs`,
          `  * Module with deps → integration test: real module + test doubles`,
          `  * Handler/endpoint → integration test: test client, real request, assert status + body`,
          `  * Trivial delegation/getter/setter → skip`,
          `- Assert on BEHAVIOR, not implementation. Include edge cases from the diff.`,
          `- One objective per test, derived from commit intent. Use realistic test data.`,
          `- Never write a test whose only assertion is "does not throw".`,
          `- COMPILE-CHECK before finishing: after writing/fixing the tests, compile them with the project's build tool (mvn -B test-compile · gradle testClasses · go vet ./... · cargo check --tests · npx tsc --noEmit) and FIX any errors BEFORE emitting your verdict. The orchestrator runs the suite only AFTER you finish — a compile failure costs a full regeneration round, so a clean compile is cheaper than a fix loop.`,
        ]
      : [
          `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git). Reuse and improve existing fixtures/specs; do not duplicate.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec. The orchestrator writes the manifest deterministically from these.`,
          `- Test-data prefix: ${input.namespace}`,
          `- LIVE DEV URL: ${input.baseUrl ?? "(not provided — ABORT and report infra-error: no base URL)"}`,
          `  In the SPEC files, reach the app via the PW_BASE_URL env var (the orchestrator sets it at run time).`,
          ...(input.contextPack
            ? [
                `- A Context Pack (blast-radius + DOM slice + contracts) was pushed into this prompt by the`,
                `  orchestrator BEFORE this session started. Where the pack supplies the DOM for a route,`,
                `  TRANSCRIBE selectors directly from the "Live DOM" section — do NOT use browser_navigate or`,
                `  browser_snapshot on routes already covered in the pack (the ground truth is already here).`,
                `  For routes NOT covered in the pack (not listed in the DOM section), use the Playwright MCP`,
                `  to explore the live page before writing selectors.`,
              ]
            : input.domSnapshot
            ? [
                `- An injected a11y tree is provided below (the ground truth for the affected routes) —`,
                `  transcribe selectors from it; do NOT browser_navigate a route it covers. Use the Playwright`,
                `  MCP only for a route NOT present in that tree.`,
              ]
            : [
                `- Playwright MCP is AVAILABLE and you MUST use it BEFORE writing any test: browser_navigate to`,
                `  the LIVE DEV URL above, then browser_snapshot to read the ACTUAL DOM. Selectors MUST be verified`,
                `  against the real DOM, NEVER invented from code analysis alone.`,
              ]),
          `- Also inspect runtime signals with the Playwright MCP: browser_console_messages (catch JS errors`,
          `  and warnings — a console error on the changed flow is a real bug signal) and browser_network_requests`,
          `  (read the actual API calls/responses the flow makes, and assert against their real shape — status,`,
          `  required fields, error responses — not invented contracts). Drive the backend through the UI only.`,
          `- Consult the playwright-authoring skill for robust specs and this app's capabilities.`,
          ...(openapiHint
            ? [
                `- OpenAPI contract(s) for this repo: ${openapiHint}. For any backend endpoint the affected flow touches, read the matching operation and assert against its contract (required fields, enums, validation/error responses). Drive the app through the web UI like a user — never call the API directly.`,
              ]
            : []),
          `- Selector priority: (1) getByTestId when the tree line's \`-> [attr]\` hint STARTS WITH the configured testIdAttribute name (e.g. \`data-testid=value\`) — an \`id=\`/\`name=\`/href hint does NOT qualify; (2) getByRole / getByLabel when no test-id hint; (3) getByText for text-only elements; (4) scoped CSS/locator only as last resort. No raw CSS classes or XPath — these break on refactor.`,
        ]),
    `- engram memory: scoped per app AND per mode (e2e, code, or context). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${memTarget}/" so each mode's memory lives in its own namespace (e.g. topic_key="context/angular-routes" or "e2e/checkout-flow"). When searching, include "${memTarget}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- An INDEPENDENT reviewer judges your specs after you finish and may return corrections for a follow-up turn. Self-review against the test-value-review criteria BEFORE finishing (every spec must fail if its feature breaks); do not rely on spawning a subagent.`
      : `- Review disabled for this run.`,
  ];
  const workingRulesContent = workingRulesLines.join("\n");

  const archMapContent = input.contextMap
    ? [
        renderArchitectureContext(
          input.contextMap,
          input.mode === "diff" ? input.intent?.changedFiles : undefined,
          { suppressFeBeLinks: !!input.contextPack },
        ) ?? "",
        ``,
      ].join("\n")
    : "";

  const contextBriefContent = input.contextBrief
    ? [
        renderBrief(input.contextBrief, { suppressFeBe: !!input.contextPack }),
        `(The brief above distilled the blast radius — do NOT re-read that code. Verify selectors against the live DOM.)`,
        ``,
      ].join("\n")
    : "";

  const sanitizedDomSnapshot = input.domSnapshot ? sanitizeText(input.domSnapshot, "model").text : undefined;

  const domContent = sanitizedDomSnapshot && isGenerationMode
    ? input.failureSourced
      ? [
          `## GROUND TRUTH AT FAILURE`,
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
          `## Live DEV accessibility tree (GROUND TRUTH for selectors — trust this over HTML intuition)`,
          ``,
          `These are the roles + accessible names the browser ACTUALLY exposes for the target routes.`,
          `Lines may carry a trailing \`-> [attr=…]\` hint — it can show id=, name=, href, or type= as well as`,
          `the test-id attribute, so only a hint that STARTS WITH the configured testIdAttribute name (e.g.`,
          `\`data-testid=value\`) means \`getByTestId('value')\` will resolve; an \`id=\`/\`name=\`/href/type= hint does`,
          `NOT qualify — use \`getByRole\`/\`getByLabel\` with the accessible name from the tree instead.`,
          `When no \`-> [...]\` hint is present at all, also use \`getByRole\` with the accessible name from the tree.`,
          `Author selectors ONLY from what appears below:`,
          `- If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the a11y tree —`,
          `  do NOT use \`getByRole\` for it. Fall back to \`getByText\` or a scoped locator.`,
          `- If a name appears MORE THAN ONCE, a bare \`getByRole\`/\`getByText\` matches multiple elements`,
          `  (strict-mode violation) — scope it to a unique parent/section, or use a unique attribute.`,
          `- This tree is a STATIC snapshot of initial load. Post-interaction elements (modals, dynamic`,
          `  lists, multi-step form steps) are NOT here. Assert them with auto-waiting`,
          `  (\`await expect(locator).toBeVisible()\`, \`waitForURL\`), never \`waitForTimeout\`.`,
          ``,
          `Lines tagged [CHANGED: …] are what THIS change introduced — your objective targets these.`,
          ``,
          sanitizedDomSnapshot,
          ``,
        ].join("\n")
    : "";

  /* VOLATILE: Lever-2 deterministic selector contradictions (W1). Each is a VERIFIED finding from comparing the generated specs' selectors against the captured failure-point a11y tree — an absent selector ("role:name is NOT in the captured tree; present roles: …") or an ambiguous one ("matches MULTIPLE nodes …"). */
  const selectorContradictionsContent =
    input.selectorContradictions?.length && isGenerationMode
      ? [
          `## ⚠ Lever-2 selector contradictions (DETERMINISTIC — resolve EVERY one)`,
          ``,
          `These selectors were checked against the captured failure-point tree above and FAILED.`,
          `Each is a verified fact, not a hint: a contradicted \`role:name\` is NOT in the captured tree`,
          `(the listed present roles are what IS there) — do NOT re-use it. Replace it with a role/name`,
          `that appears in the tree, or a \`getByText\`/scoped locator; for a "matches MULTIPLE" finding,`,
          `scope the locator to a unique parent. You MUST resolve every item before finishing:`,
          ``,
          ...input.selectorContradictions.map((c) => `- ${sanitizeText(c).text}`),
          ``,
        ].join("\n")
      : "";

  const hasStaticGateCase = Boolean(input.fixCases?.some((c) => c.name === "static-gate"));

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
              `The following tests FAILED during execution against DEV. Fix ONLY these`,
              `tests; do NOT rewrite or touch tests that passed.`,
            ]),
        ``,
        `Failed cases:`,
        ...input.fixCases.flatMap((c) => [
          `- ${c.name}\n  Error: ${c.detail?.slice(0, 500) ?? "(no detail)"}`,
          ...renderFixCaseEvidenceLines(c),
        ]),
        ``,
        ...(input.failureSourced
          ? [
              `The captured a11y tree at the failure point is injected ABOVE as "GROUND TRUTH AT FAILURE".`,
              `1. Read the test file to understand what it asserts`,
              `2. Consult ONLY the GROUND TRUTH tree above — do NOT navigate or snapshot the live page.`,
              `   The tree above is the page AT THE FAILURE POINT, not the current live state.`,
              `   ${GROUNDING_UNCOVERED_ESCAPE}`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label in the GROUND TRUTH tree`,
              `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
              `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
              `4. PRESERVE each test's objective and assertions — fix only what's broken`,
            ]
          : hasInjectedGrounding
          ? [
              `Fix from the injected grounding above (Context Pack / DOM tree) — do NOT navigate to re-derive`,
              `a route it already covers; navigate ONLY a route absent from the injected grounding.`,
              GROUNDING_UNCOVERED_ESCAPE,
              `1. Read the test file to understand what it asserts`,
              `2. Resolve the failing selector/assertion against the injected grounding above`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label in the injected grounding`,
              `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
              `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
              `4. PRESERVE each test's objective and assertions — fix only what's broken`,
            ]
          : [
              `For each failure, use the Playwright MCP to explore the page and verify`,
              `your fix BEFORE writing it:`,
              `1. Read the test file to understand what it asserts`,
              `2. Use browser_navigate + browser_snapshot to see the ACTUAL page structure`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label`,
              `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
              `   - "NS_ERROR_…" / network error → the URL or route is wrong; verify with browser_navigate`,
              `   - "locator resolved to N elements" → use .first() ONLY as last resort; prefer scoping`,
              `4. PRESERVE each test's objective and assertions — fix only what's broken`,
            ]),
        ``,
      ].join("\n")
    : "";

  /* VOLATILE: Reviewer corrections — the highest-priority re-generation signal. The agent must resolve every flagged item before finishing. Positioned in VOLATILE after DOM so the DOM grounding is already established when the corrections reference it. */
  const reviewContent = input.reviewCorrections?.length && isGenerationMode
    ? [
        `## Apply reviewer corrections (HIGHEST priority)`,
        ``,
        `An independent reviewer REJECTED the previous specs. Fix EACH item below precisely;`,
        `do NOT rewrite specs that were not flagged.`,
        hasInjectedGrounding
          ? `Re-verify against the injected grounding above (Context Pack / DOM tree) before editing — do NOT re-navigate a route it already covers. ${GROUNDING_UNCOVERED_ESCAPE}`
          : `Where a fix concerns a selector or an assertion, re-verify it against the live DOM with the Playwright MCP before editing.`,
        ``,

        ...input.reviewCorrections.map((c) => `- ${sanitizeText(c).text}`),
        ``,
      ].join("\n")
    : "";

  const coverageContent = input.coverageGap && isGenerationMode
    ? [
        `## Cover the change (HIGH priority)`,
        ``,
        `The tests ran green but did NOT exercise all the lines this commit changed. Extend or add`,
        `tests so those lines are actually executed and asserted (covering ≠ asserting — assert the`,
        `behavior of the changed code, do not just touch the line):`,
        ``,
        ...(hasInjectedGrounding
          ? [
              `Resolve any new selectors from the injected grounding above — do NOT re-navigate routes it already covers.`,
              GROUNDING_UNCOVERED_ESCAPE,
              ``,
            ]
          : []),
        input.coverageGap,
        ``,
      ].join("\n")
    : "";

  const learnedRulesContent = input.learnedRules && isGenerationMode
    ? [input.learnedRules, ``].join("\n")
    : "";

  /* A re-generation turn must not re-orient; the blast radius is already in the grounding above. Suppress serena re-activation. */
  const regenDisciplineContent = isReGen
    ? [
        `## Re-generation turn — do NOT re-orient`,
        ``,
        `Re-generation turn: the blast radius was already explored and distilled above. Do NOT re-activate`,
        `serena, do NOT re-run find_referencing_symbols, do NOT re-skim the repository or re-read unchanged`,
        `code. Work from the grounding already in this prompt and change only what the correction requires.`,
        `(One exception: if a correction names a specific symbol that is NOT in the grounding above, read ONLY that symbol.)`,
        ``,
      ].join("\n")
    : "";

  const contextPackContent = input.contextPack && isGenerationMode ? input.contextPack : "";

  const taskContent = buildTask(input);

  const staticSignalContent = input.staticSignal && isGenerationMode ? input.staticSignal : "";

  /* Local sanitize wrapper (this function's own scope — NOT the DIFFERENT s() declared inside renderArchitectureContext further down this file) so untrusted cross-repo strings (data leaving/entering the model boundary) are redacted before reaching the prompt. */
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_LINKS = 40;
  const MAX_DRIFT = 20;
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
  const omittedLinkCount = hasServiceLinks ? Math.max(0, orderedLinks.length - MAX_LINKS) : 0;
  const serviceLinksContent =
    (hasServiceLinks || hasContractDrift) && isGenerationMode
      ? [
          "## Cross-service links (deterministic — from the stitcher, advisory)",
          "Structural cross-service contract links resolved from the code, NOT a gate. Verify against the live app; absent links do NOT imply no dependency. Transport/source name how each hop was derived (FE→BE HTTP, BE→BE HTTP, event).",
          "",
          ...(hasServiceLinks
            ? orderedLinks.slice(0, MAX_LINKS).map((l) => {
                const tier = tierFor(l);
                return renderServiceLinkLine(l, s, tier);
              })
            : []),
          ...(omittedLinkCount > 0 ? [`...and ${omittedLinkCount} more link${omittedLinkCount === 1 ? "" : "s"} (truncated at MAX_LINKS=${MAX_LINKS})`] : []),
          ...(hasContractDrift
            ? ["", "### Contract drift (WARNINGS — front calls an endpoint the backend contract does not declare):",
               ...input.contractDrift!.slice(0, MAX_DRIFT).map((d) =>
                 `- WARNING: \`${s(d.from.repo)}/${s(d.from.file)}#${s(d.from.symbol)}\` calls ${s(d.verb)} ${s(d.path)} — not in the contract`)]
            : []),
        ].join("\n")
      : "";

  const diffArchetypesContent =
    input.diffArchetypes?.length && isGenerationMode
      ? `Change shape (deterministic): ${input.diffArchetypes.join(", ")} — prioritise tests that exercise these`
      : "";

  /* CHANGE-COVERAGE OBSERVATION marker (design D-E rationale): no deterministic oracle exists for "did the rich exemplar template change generation quality" — flagging here (+ engram) so a future audit can measure rich-exemplar vs one-line-diffArchetypes-hint defect-catch rate. apply-batch-3 rider (orchestrator-directed): no live caller populates input.structuralPatterns, so without a local derivation the "archetype-matched templates re-enter the generation prompt" scenario went unmet for a real run. Derived HERE instead, at the layer that already holds the diff (this function already reads input.diff for cappedDiffText above), rather than adding new qa-engine plumbing: an explicitly-supplied input.structuralPatterns still wins; only a genuinely absent/empty one falls back to a local derivation from the diff already in scope. */
  const skillExemplarsContent = (() => {
    if (!isGenerationMode) return "";
    if (input.skillExemplars?.length) {
      const proven: Record<string, number> = {};
      for (const e of input.skillExemplars) if (e.proven && e.promotionCount > 0) proven[e.archetype] = e.promotionCount;
      return renderExemplarsForPrompt(input.skillExemplars, { proven });
    }
    const patterns = input.structuralPatterns?.length
      ? input.structuralPatterns
      : detectStructuralPatterns(input.diff, input.intent?.changedFiles ?? []);
    const matched = patterns.flatMap((p) => matchExemplars(p));
    const seenNames = new Set<string>();
    const deduped = matched.filter((e) => {
      if (seenNames.has(e.name)) return false;
      seenNames.add(e.name);
      return true;
    });
    return renderExemplarsForPrompt(deduped);
  })();

  return assemble([
    section("working-rules", "stable-prefix", workingRulesContent, { priority: 1, cacheable: true }),
    ...(regenDisciplineContent ? [section("regen-discipline", "stable-prefix", regenDisciplineContent, { priority: 2 })] : []),
    ...(archMapContent ? [section("arch-map", "semi-stable", archMapContent, { priority: 1, cacheable: true })] : []),
    ...(contextBriefContent ? [section("context-brief", "semi-stable", contextBriefContent, { priority: 2 })] : []),
    ...(() => {
      const specFiles = isGenerationMode && (input.mode === "diff" || input.mode === "manual")
        ? input.existingSpecFiles
        : undefined;
      if (!specFiles?.length) return [];
      const manifestContent = [
        `## existing-suite-manifest (${specFiles.length} spec file(s) — do NOT rewrite flows already covered here)`,
        ...specFiles.map((f) => `- ${f}`),
      ].join("\n");
      return [section("existing-suite-manifest", "semi-stable", manifestContent, { priority: 2 })];
    })(),
    ...(staticSignalContent ? [section("static-signal", "semi-stable", staticSignalContent, { priority: 3 })] : []),
    ...(serviceLinksContent ? [section("service-links", "semi-stable", serviceLinksContent, { priority: 3 })] : []),
    ...(diffArchetypesContent ? [section("diff-archetypes", "semi-stable", diffArchetypesContent, { priority: 3 })] : []),
    ...(skillExemplarsContent ? [section("skill-exemplars", "semi-stable", skillExemplarsContent, { priority: 3, maxBytes: 1536 })] : []),
    ...(contextPackContent ? [section("context-pack", "volatile", contextPackContent, { priority: 0, shedAs: "critical-recap" })] : []),
    /* VOLATILE: grounding (DOM snapshot — priority 1 within VOLATILE so it's first and the selectorContradictions section can reference "the tree above" correctly). */
    ...(domContent ? [section("dom-snapshot", "volatile", domContent, { priority: 1 })] : []),
    ...(selectorContradictionsContent ? [section("selector-contradictions", "volatile", selectorContradictionsContent, { priority: 2 })] : []),
    ...(fixContent ? [section("fix-cases", "volatile", fixContent, { priority: 3 })] : []),
    /* VOLATILE: reviewer corrections (priority 4 — after grounding context is established). */
    ...(reviewContent ? [section("reviewer-corrections", "volatile", reviewContent, { priority: 4, maxBytes: 20_000, overflow: "drop" })] : []),
    ...(coverageContent ? [section("coverage-gap", "volatile", coverageContent, { priority: 5, shedAs: "critical-recap" })] : []),
    ...(learnedRulesContent ? [section("learned-rules", "volatile", learnedRulesContent, { priority: 2 })] : []),
    section("task", "task", taskContent, { priority: 1 }),
    ...(() => {
      const diffContent = isGenerationMode ? buildDiffSection(input) : "";
      return diffContent ? [section("diff", "task", diffContent, { priority: 2, shedAs: "semi-stable" })] : [];
    })(),
  ], { budgetBytes: opts.budgetBytes ?? roleWindowBytes("qa-generator") });
}

export function buildPrompt(input: OpencodeRunInput): string {
  return buildPromptAssembled(input).text;
}

export function buildFollowupPrompt(input: OpencodeRunInput): string {
  const parts: string[] = [
    `## Continuation — same session; do NOT re-explore`,
    ``,
    `The suite you wrote was executed against DEV. The working rules, blast-radius brief, Context Pack`,
    `and diff are ALREADY in this session above — do NOT re-read them, do NOT re-activate serena, do NOT`,
    `re-run find_referencing_symbols, and do NOT re-navigate a route you already explored. Fix from what`,
    `you already have, plus the new failure signal below.`,
    GROUNDING_UNCOVERED_ESCAPE,
    ``,
  ];
  if (input.domSnapshot && input.failureSourced) {
    parts.push(
      `## GROUND TRUTH AT FAILURE`,
      ``,
      `The tree below is the page AT THE FAILURE POINT — the ONLY source of truth for this fix. Quote the`,
      `exact \`role: name\` line before writing any locator; an unquotable locator MUST be replaced.`,
      ``,
      sanitizeText(input.domSnapshot, "model").text,
      ``,
    );
  }
  if (input.selectorContradictions?.length) {
    parts.push(
      `## ⚠ Selector contradictions (DETERMINISTIC — resolve EVERY one)`,
      `Each was checked against the captured tree and FAILED — replace it with a role/name that appears there:`,
      ...input.selectorContradictions.map((c) => `- ${sanitizeText(c).text}`),
      ``,
    );
  }
  if (input.fixCases?.length) {
    parts.push(
      `## Fix failing tests`,
      `These tests FAILED against DEV. Fix ONLY these; do NOT touch tests that passed.`,
      ...input.fixCases.flatMap((c) => [
        `- ${c.name}\n  Error: ${c.detail?.slice(0, 500) ?? "(no detail)"}`,
        ...renderFixCaseEvidenceLines(c),
      ]),
      ``,
    );
  }
  if (input.reviewCorrections?.length) {
    parts.push(
      `## Apply reviewer corrections (HIGHEST priority)`,
      `An independent reviewer REJECTED the previous specs. Fix EACH item; do NOT rewrite specs not flagged.`,
      ...input.reviewCorrections.map((c) => `- ${sanitizeText(c).text}`),
      ``,
    );
  }
  if (input.coverageGap) {
    parts.push(
      `## Cover the change (HIGH priority)`,
      `The tests ran green but did NOT exercise all the changed lines. Extend/add tests so they are asserted:`,
      input.coverageGap,
      ``,
    );
  }
  return parts.join("\n");
}


/** context.json is read from the WATCHED repo (and committed by this system's own PRs), so it is attacker-influenceable. Every field is sanitized before it reaches the test-writing agent (prompt-injection / secret-exfil defense), and the map is BOUNDED so a huge file cannot blow the token budget. `s()` redacts; MAX_ITEMS caps each section. */
export function renderArchitectureContext(
  ctx: ArchitectureContext,
  changedFiles?: string[],
  opts: { suppressFeBeLinks?: boolean } = {},
): string | null {
  if (!ctx.routes?.length && !ctx.api?.length) return null;

  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_ITEMS = 200;
  const MAX_LEN = 20_000;

  const relevantLinks = (changedFiles?.length
    ? ctx.feBe?.filter((link) => {
        const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
        return changedFiles.some((f) => terms.some((t) => f.includes(t)));
      }) ?? ctx.feBe ?? []
    : ctx.feBe ?? []
  ).slice(0, MAX_ITEMS);

  const lines: string[] = [];
  lines.push("## Architecture context (from e2e/.qa/context.json)");
  lines.push(`Built at ${s(ctx.builtAtSha).slice(0, 7)} — the FE↔BE map this app's QA uses to cross the frontend→backend boundary.`);
  lines.push(
    "This map is a non-authoritative AID, extracted from source and possibly STALE or INCOMPLETE: " +
      "use it to widen the blast radius and locate flows, but verify every route, selector and contract " +
      "against the actual code and the live DOM. If the map and what you observe disagree, the code/DOM wins.",
  );
  lines.push("");

  if (ctx.routes.length) {
    lines.push(`### Routes (${ctx.routes.length} entry points)`);
    for (const r of ctx.routes.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(r.path)}\` → ${s(r.component ?? "(unknown component)")}${r.name ? ` ("${s(r.name)}")` : ""}`);
    }
    lines.push("");
  }

  if (ctx.api.length) {
    lines.push(`### API operations (${ctx.api.length} endpoints)`);
    for (const o of ctx.api.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(o.operationId)}\`: ${s(o.method)} ${s(o.path)}${o.service ? ` (${s(o.service)})` : ""}`);
    }
    lines.push("");
  }

  if (relevantLinks.length && !opts.suppressFeBeLinks) {
    lines.push(`### FE↔BE links (${relevantLinks.length} of ${ctx.feBe?.length ?? 0} total)`);
    lines.push("Each link tells you which frontend route calls which backend operation — use this to widen the blast radius:");
    for (const l of relevantLinks) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
    lines.push("");
  }

  if (ctx.flows?.length) {
    lines.push("### Named flows");
    for (const f of ctx.flows.slice(0, MAX_ITEMS)) {
      const opList = f.operations?.length ? ` → ${f.operations.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- **${s(f.id)}**: ${f.routes.slice(0, MAX_ITEMS).map(s).join(", ")}${opList}`);
    }
    lines.push("");
  }

  lines.push("When the blast radius from the diff touches a route, use its FE↔BE links");
  lines.push("to also consider the backend operations — a frontend change can break backend");
  lines.push("behaviour and vice-versa.");
  const out = lines.join("\n");
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN) + "\n…(context truncated)" : out;
}


export function buildContextTask(input: OpencodeRunInput): string {
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const serviceLines = input.services?.length
    ? [
        ``,
        `## Microservice repos (${input.services.length})`,
        `This app's backend is split into microservices. For each repo below, a READ-ONLY staged`,
        `snapshot of its OpenAPI/contract files (NOT its full source) is at the local path shown;`,
        `extract its OpenAPI operations into the SAME context.json, setting each operation's`,
        `"service" field to the repo name shown here:`,
        ``,
        ...input.services.flatMap((s) => {
          const hints = s.openapi ? (Array.isArray(s.openapi) ? s.openapi : [s.openapi]) : undefined;
          const stagedHint = hints?.map((h) => `contracts/${h}`).join(", ");
          return [
            `- **${s.repo}** — staged contract snapshot at: ${s.mirrorDir}`,
            ...(stagedHint ? [`  OpenAPI hint: ${stagedHint} (relative to that staged snapshot)`] : [`  No OpenAPI hint — search that staged snapshot's contracts/ subdir for openapi/swagger files.`]),
          ];
        }),
        ``,
        `The feBe JOIN is still derived from THIS frontend repo's API clients: a client method's`,
        `operationId must match an operation extracted from one of the services above (or from`,
        `this repo's own specs). Do not invent links for services the frontend never calls.`,
      ]
    : [];
  return [
    `Build or refresh the FE↔BE architecture map for ${input.repo}.`,
    ``,
    `## Goal`,
    `Produce a distilled map of the app's architecture so future QA runs can cross the`,
    `frontend→backend boundary without re-deriving it from raw code.`,
    ``,
    `## What to produce`,
    `Write a single JSON file at ${input.e2eRelDir}/.qa/context.json with these sections:`,
    ``,
    `1. **routes** — every frontend entry URL (the unit an E2E targets) + the component it renders.`,
    `   Extract FROM the Angular routing files (e.g. app.routes.ts, *.routes.ts).`,
    `   Required per entry: path (e.g. "/checkout"). Optional: name, component, source.`,
    ``,
    `2. **api** — every backend operation the app calls.`,
    `   Extract FROM the OpenAPI specs${openapiHint ? ` (hint: ${openapiHint})` : " (search with serena/glob for openapi or swagger files)"}.`,
    `   Required per entry: operationId, method (GET/POST/...), path. Optional: service, spec.`,
    ``,
    `3. **feBe** — the JOIN between frontend routes and backend operations: which route calls which operation.`,
    `   Derive BY following each generated API client method to its operationId.`,
    `   Required per entry: route (a path from routes), operationId (from api). Optional: via (the client method).`,
    `   THE JOIN IS THE WHOLE POINT: every link must resolve to a known route AND a known operation.`,
    ``,
    `4. **flows** (optional) — named user flows grouping routes + operations for readability.`,
    ...serviceLines,
    ``,
    `## Procedure`,
    `1. Activate serena (activate_project) on the working directory.`,
    `2. Find ALL Angular routing files (serena glob: **/*routes*.ts, **/app-routing*.ts).`,
    `   For each route definition (path + component), add an entry to routes.`,
    `3. Find ALL OpenAPI spec files${openapiHint ? ` (start with ${openapiHint})` : ""}.${input.services?.length ? " Include every microservice repo listed above (their staged contract snapshots are local paths you can read)." : ""}`,
    `   For each operation (operationId + method + path), add an entry to api.`,
    `4. Find the generated API client files (typically src/app/generated/ or similar).`,
    `   For each client method that calls a backend operation, map its call site to a route`,
    `   and add the link to feBe. The operationId in the client MUST match an api entry.`,
    `5. Self-validate: every feBe route exists in routes AND every feBe operationId exists in api.`,
    `   Remove any dangling link BEFORE writing.`,
    `6. Write ${input.e2eRelDir}/.qa/context.json with the four sections + "builtAtSha":"${input.sha}".`,
    ``,
    `## Rules`,
    `- Extract from STRUCTURED sources, never invent. Every route comes from a routing file;`,
    `  every operation from an OpenAPI spec; every link from a generated client.`,
    `- If no OpenAPI spec is found, leave api and feBe empty (a repo with no backend).`,
    `- If routing is file-based (not a central Routes array), enumerate the route files.`,
    `- Do NOT guess or hallucinate paths/operationIds. If a source is missing, leave that section empty.`,
    `- Keep the map small: this is an E2E authoring aid, not exhaustive documentation.`,
    ``,
    `## Output`,
    `End with ONLY this JSON (no other text):`,
    `{"approved":true,"specs":["${input.e2eRelDir}/.qa/context.json"],"note":"built architecture map with X routes, Y api operations, Z links"}`,
  ].join("\n");
}

function buildCodeTask(input: OpencodeRunInput): string {
  if (input.mode === "manual") {
    return [
      `Generate or update UNIT/INTEGRATION tests for the source code of ${input.repo}, FOCUSED on:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      `## Objective — commit to this BEFORE writing`,
      ACCEPTANCE_CRITERION_RULE,
      ``,
      `Read the relevant source and the repo's existing tests (serena); match their framework and conventions.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the source-code test suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow its source-code test suite where it matters.`,
      ``,
      `Read the existing tests and the code (serena: activate_project, get_symbols_overview, find_symbol).`,
      `Test important, UNCOVERED logic; match the repo's existing test framework and conventions.`,
      input.mode === "exhaustive"
        ? `Re-evaluate every existing test for correctness, value and necessity; remove or rewrite the trivial, false-positive, redundant or obsolete.`
        : `Generate tests ONLY for important UNCOVERED logic (the delta). Do not duplicate existing coverage.`,
    ].join("\n");
  }

  const intent = input.intent;
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  return [
    `Generate or update UNIT/INTEGRATION tests for the source-code changes in commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files (derive the scope from these): ${sanitizeText(intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, !isReGen),
    ``,
    `Cross-check against the diff: if the code does more than the message claims, test what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    `## Commit diff`,
    "```diff",
    cappedDiffText(input.diff),
    "```",
    ``,
    `Test the changed logic DIRECTLY (no web, no browser, no Playwright): call the changed functions/`,
    `modules and assert behavior + edge cases. Match the repo's existing test framework and conventions.`,
  ].join("\n");
}

function buildTask(input: OpencodeRunInput): string {
  if (input.target === "code") return buildCodeTask(input);
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the entire E2E suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow the E2E suite where it matters.`,
      ``,
      `1. Read the existing tests in ${input.e2eRelDir}/ and the app code (use serena:`,
      `   activate_project, get_symbols_overview, find_symbol, find_referencing_symbols) to`,
      `   build a COVERAGE + IMPORTANCE map: which user flows already have tests and which`,
      `   important/complex flows do NOT. Until real coverage instrumentation exists,`,
      `   estimate coverage by reading the existing specs and the code.`,
      `2. Persist this analysis in ${input.e2eRelDir}/.qa/analysis.json (flows, covered vs`,
      `   uncovered, importance, lastSha:"${input.sha}") so it need not be redone from`,
      `   scratch next time; if it already exists, update it incrementally.`,
      input.mode === "exhaustive"
        ? `3. Re-evaluate EVERY existing test for correctness, value and necessity (apply the test-value-review criteria): remove or rewrite tests that are trivial, false positives, redundant or obsolete. Ensure every important flow is covered — a fully re-evaluated suite, not a delta.`
        : `3. Generate tests ONLY for the important UNCOVERED flows (the delta over the existing suite). Do not duplicate existing coverage.`,
    ].join("\n");
  }
  if (input.mode === "manual") {
    return [
      `Generate/update E2E tests for ${input.repo}, FOCUSED on the following guidance:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      `## Objective — commit to this BEFORE writing`,
      ACCEPTANCE_CRITERION_RULE,
      ``,
      `Use serena to read the relevant code and the existing ${input.e2eRelDir}/ suite.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
  }
  if (input.mode === "context") return buildContextTask(input);

  const intent = input.intent;
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  const svcOpenapiHints = input.service?.openapi
    ? Array.isArray(input.service.openapi)
      ? input.service.openapi
      : [input.service.openapi]
    : undefined;
  const svcOpenapi = svcOpenapiHints?.map((h) => `contracts/${h}`).join(", ");
  const serviceBlock = input.service
    ? [
        ``,
        `## Cross-repo change (microservice)`,
        `The commit under test belongs to the microservice ${input.service.repo}, NOT to this frontend repo.`,
        `- A READ-ONLY staged snapshot (its OpenAPI/contract files under contracts/, plus this commit's`,
        `  diff as CHANGE.patch and its changed files' post-change content under changed/ — NOT the`,
        `  service's full source) is at: ${input.service.mirrorDir}`,
        ...(svcOpenapi ? [`- The service's OpenAPI contract(s): ${svcOpenapi} (relative to that staged snapshot)`] : []),
        `- Use the architecture context below (operations whose service matches this repo) plus the`,
        `  staged contract and this commit's staged diff/changed files to find which frontend routes`,
        `  and flows this change affects.`,
        `- Exercise the backend ONLY through the frontend UI at the LIVE DEV URL — never call the service directly.`,
      ]
    : [];
  return [
    `Generate/update E2E tests for the flows affected by commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files (derive the scope/area from these): ${sanitizeText(intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, !isReGen),
    ``,
    ...(isReGen
      ? []
      : [
          `Cross-check against the diff: if the code does more than the message claims, cover what`,
          `the code actually changes, not just what the message promises.`,
          ``,
        ]),
    /* Rendered whenever the classifier computed a reason, regardless of regen round (unlike the diff cross-check instruction above, this explains a decision already made, not evidence that may have shed). F2 fix (adversarial review, LOW): classificationReason is a MODEL-bound string (it only ever reaches the generation prompt, never an Issue body), so it is sanitized in "model" mode — matching the sibling model-bound calls on this path (domSnapshot at :687/:1083/:1743). The previous call omitted the mode arg, defaulting to the aggressive "issue" (Issue-bound) policy: it failed safe (over-redacted) but contradicted this very comment. `contradiction` only toggles a STATIC literal suffix (no user/model text flows through it), so there is nothing to sanitize on that field. */
    ...(input.classificationReason
      ? [
          `## Classifier note`,
          `${sanitizeText(input.classificationReason, "model").text}${input.contradiction ? " (the commit message under-promised — trust the diff)" : ""}`,
          ``,
        ]
      : []),
    `## Objective — commit to this BEFORE writing`,
    ACCEPTANCE_CRITERION_RULE,
    ``,
    `## Architecture context`,
    `If ${input.e2eRelDir}/.qa/context.json exists, READ it to understand which routes and`,
    `API operations the changed files belong to. Use the feBe links to widen the blast`,
    `radius across the frontend→backend boundary: a frontend change may affect the`,
    `backend behaviour and vice-versa. If the map is missing or stale, note the`,
    `limitation explicitly in your verdict note.`,
    ``,
    /* JD-C1: the first pass scopes the blast radius (serena + page exploration). A RE-generation pass already has that grounding distilled above and is governed by the regen-discipline section — re-commanding `find_referencing_symbols` / "explore the page" here would CONTRADICT it and let the agent justify re-exploring. So the scope-budget orientation lines are first-pass only. */
    ...(isReGen
      ? [
          `## Scope (re-generation pass)`,
          `Change ONLY what the correction/coverage-gap above requires. Do not broaden scope or re-survey`,
          `the repo — work from the grounding already in this prompt.`,
        ]
      : [
          `## Scope budget (diff mode — do NOT over-work)`,
          `The blast radius IS your budget. This is ONE commit, so keep generation fast and focused:`,
          `- Read ONLY the changed symbols and their direct callers/callees (find_referencing_symbols).`,
          `- Do NOT read the whole repository, the entire e2e suite, or unrelated flows/files.`,
          `- Read existing specs ONLY for the one or two flows this commit actually touches.`,
          `- Explore ONLY the page(s) the change affects — not the whole app.`,
          `A handful of focused specs is the right output for a single-commit diff, not a suite rewrite.`,
        ]),
    ...serviceBlock,
  ].join("\n");
}

/* Returns empty string for all non-diff modes, code mode, and re-generation passes (where the diff is already distilled in the grounding above and repeating it burns tokens). */
function buildDiffSection(input: OpencodeRunInput): string {
  if (input.target === "code") return "";
  if (input.mode !== "diff") return "";
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  if (isReGen) return "";
  /* Cap BEFORE sanitizing: capDiff splits on diff file-header boundaries and must see the raw structure; sanitizeText only redacts secret-shaped substrings. */
  return [
    `## Commit diff`,
    "```diff",
    cappedDiffText(input.diff),
    "```",
  ].join("\n");
}

/* ── Reviewer prompt assembly (Phase 1a precursor) ────────────────────────── The prompt for the independent reviewer session. The contract-repair re-prompt and session lifecycle stay in reviewIndependently; only the BUILD of the initial prompt string lives here. */

export function reviewObjective(input: ReviewInput): { subject: string; heading: string; body: string[]; targetNoun: string } {
  if (input.mode === "manual") {
    const g = sanitizeText(((input.guidance ?? "").trim() || "(no guidance was provided)")).text;
    return {
      subject: "a guided (manual) run",
      heading: `## Objective — the requested behavior (judge against THIS, NOT any commit diff)`,
      body: [g],
      targetNoun: "the requested behavior",
    };
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return {
      subject: `a whole-repo ${input.mode} run`,
      heading: `## Objective — there is no single commit; judge each spec against its OWN stated objective`,
      body: [
        `Each spec declares the user flow it targets (in its header comment / the manifest). Judge`,
        `whether it meaningfully exercises that flow, or could the flow break while the test stays green.`,
      ],
      targetNoun: "the targeted user flow",
    };
  }
  const commitDiffObjective = () => ({
    subject: "this commit",
    heading: `## Commit diff`,
    /* Cap BEFORE sanitizing: capDiff splits on diff file-header boundaries and must see the raw structure; sanitizeText only redacts secret-shaped substrings. */
    body: ["```diff", cappedDiffText(input.diff), "```"],
    targetNoun: "the change",
  });
  if (input.mode === "diff" || input.target === "code") return commitDiffObjective();
  console.warn(`[qa] reviewObjective: unhandled review mode ${JSON.stringify(input.mode)} — defaulting to the commit-diff objective`);
  return commitDiffObjective();
}

const REVIEW_SPECS_MAX_BYTES = 40_000;

export function renderReviewSpecs(input: ReviewInput): string {
  const rel = (s: string) => (input.e2eRelDir ? `${input.e2eRelDir}/${s}` : s);
  const contents: string[] = [];
  let totalBytes = 0;
  for (const s of input.specs) {
    let content: string;
    try {
      content = readFileSync(join(input.mirrorDir, input.e2eRelDir, s), "utf8");
    } catch (err) {
      /* A spec the independent reviewer NEVER sees can otherwise ship inside an approved batch — that silently bypasses the quality gate. Surface it loudly (CLAUDE.md: never swallow), like the byte-cap branch below does for its own mode switch. */
      console.warn(`[qa] WARNING: could not read spec '${rel(s)}' for review (${err instanceof Error ? err.message : String(err)}) — it will be judged from a placeholder, NOT its real content.`);
      contents.push(`### ${rel(s)}\n( could not read file — review skipped for this spec )`);
      continue;
    }
    const block = `### ${rel(s)}\n\`\`\`typescript\n${content}\n\`\`\``;
    totalBytes += Buffer.byteLength(block, "utf8");
    if (totalBytes > REVIEW_SPECS_MAX_BYTES) {
      console.warn(
        `[qa] WARNING: the combined contents of ${input.specs.length} spec(s) exceed the ${REVIEW_SPECS_MAX_BYTES}-byte inline cap — ` +
          `the reviewer will read files itself instead of judging inlined contents (weaker determinism).`,
      );
      return `## Specs to review\n\n${input.specs.map((n, i) => `${i + 1}. ${rel(n)}`).join("\n")}\n\n( spec contents exceed ${REVIEW_SPECS_MAX_BYTES} bytes — read each file with the read tool )`;
    }
    contents.push(block);
  }
  return `## Specs to review (${contents.length} file(s) — contents provided inline)\n\n${contents.join("\n\n")}`;
}

/** Renders a deterministic RUNTIME EXECUTION RESULT section from the orchestrator's evidence (HTTP status codes and final URLs captured during test execution). This is authoritative evidence the reviewer can use to distinguish an app defect (5xx) from a test defect — injected by the orchestrator, not inferred from the generator's reasoning, so reviewer independence is preserved. Output is bounded at 4000 chars total; per-case detail is capped at 500 chars. finalUrl is sanitized via sanitizeText before being included in the prompt (prevents secrets in redirect URLs from leaking to the reviewer model). */
export interface ExecutionResultCase {
  name: string;
  httpStatus?: number;
  finalUrl?: string;
  detail?: string;
}

export function renderExecutionResult(evidence: {
  verdict: string;
  cases: ExecutionResultCase[];
}): string {
  const CAP_TOTAL = 4000;
  const CAP_TOTAL_INTERNAL = CAP_TOTAL - 130;
  const CAP_DETAIL = 500;
  const CAP_DETAIL_INTERNAL = CAP_DETAIL - 130;

  const lines: string[] = [
    `## RUNTIME EXECUTION RESULT (authoritative — captured by the orchestrator, not inferred)`,
    ``,
    `Verdict: ${evidence.verdict}`,
    ``,
  ];

  for (const c of evidence.cases) {
    lines.push(`- ${c.name}`);
    if (c.httpStatus !== undefined) {
      lines.push(`  httpStatus: ${c.httpStatus}`);
    }
    if (c.finalUrl !== undefined) {
      const { text: sanitized } = sanitizeText(c.finalUrl);
      lines.push(`  finalUrl: ${sanitized}`);
    }
    if (c.detail !== undefined) {
      const capped = capText(c.detail, CAP_DETAIL_INTERNAL);
      lines.push(`  detail: ${capped}`);
    }
  }

  const raw = lines.join("\n");
  if (raw.length <= CAP_TOTAL) return raw;
  return capText(raw, CAP_TOTAL_INTERNAL);
}

export function buildReviewerPromptAssembled(input: ReviewInput): AssembledPrompt {
  const changeType = input.intent?.type ?? input.mode;
  const specBlock = renderReviewSpecs(input);
  const kind = input.target === "code" ? "tests" : "E2E tests";
  const obj = reviewObjective(input);

  const roleFramingContent = [
    `## Independent review — judge these ${kind} WITHOUT the generator's reasoning`,
    ``,
    `You are reviewing tests written for ${obj.subject}, but you have NO access to the`,
    `generator's thought process. Judge the tests on their own merit using the`,
    `test-value-review skill.`,
    ``,
    `## Review context`,
    `- Run type: ${changeType}`,
    `- Base URL: ${input.baseUrl ?? "(not provided)"}`,
  ].join("\n");

  const rulesInstruction = input.learnedRules
    ? [`6. Also REJECT if any spec violates an app-specific reject-on-sight rule provided in this prompt.`]
    : [];
  const instructionsContent = [
    `## Instructions`,
    `1. The spec contents are provided in this prompt — no need to read files.`,
    `2. Apply the test-value-review skill from BOTH perspectives (value + robustness).`,
    `3. Answer: could ${obj.targetNoun} be BROKEN and these tests STILL be green?`,
    `4. Be strict — a single anti-pattern in any spec means rejection.`,
    `5. STAY IN YOUR LANE — judge VALUE and ROBUSTNESS. The GENERATOR owns ground-truth against the`
      + ` live app (it navigated DEV). Judge a concrete UI fact (exact label, button/link text, route)`
      + ` ONLY when the ${input.domSnapshot ? "Live DEV DOM section" : "spec itself"} confirms it. NEVER`
      + ` assert a UI fact from memory: an unconfirmed guess that a label/route "should be" something is`
      + ` NOT a valid correction — omit it. Reject on what you can SEE (no assertions, fragile selectors,`
      + ` wrong objective, missing cleanup), not on guessed app specifics.`,
    ...rulesInstruction,
  ].join("\n");

  const outputContractContent = [
    `Output your verdict as JSON with no text before or after. Always include a one or two`,
    `sentence "rationale" explaining the verdict — on APPROVAL too (why these tests genuinely`,
    `defend ${obj.targetNoun}), not only on rejection.`,
    `Prefix EVERY correction with exactly one class tag from this closed list so the failure`,
    `is machine-classifiable: [false-positive] (asserts nothing / passes when the feature is`,
    `broken), [wrong-objective] (does not test ${obj.targetNoun}), [fragile-selector] (ambiguous or`,
    `brittle locator), [no-cleanup] (leaves test data behind), or [other].`,
    `Each correction MUST be a structured object with "text" (the actionable message, prefixed with the class tag) and "severity":`,
    `- "blocking": this issue makes the test worthless (false-positive, wrong-objective, missing cleanup) — fails the gate.`,
    `- "advisory": style/robustness nit that does not make the test worthless alone — recorded but does not fail the gate.`,
    `An unconfirmable UI selector (no DOM evidence in this prompt) MUST be advisory, never blocking.`,
    `{"approved":false,"rationale":"why, in 1-2 sentences","corrections":[{"text":"[fragile-selector] file.spec.ts: specific actionable fix","severity":"blocking"},{"text":"[other] file.spec.ts: minor style nit","severity":"advisory"}]}`,
  ].join("\n");

  const objectiveContent = [obj.heading, ...obj.body].join("\n");

  /* Live DEV DOM: actual roles + accessible names on the routes this spec targets. Captured by the orchestrator (reviewer independence). Model-mode sanitization — this is prompt text, never an Issue body. */
  const domContent = input.domSnapshot
    ? [
        `## Live DEV DOM — the ACTUAL roles + accessible names on the routes this spec targets`,
        `Captured by the orchestrator from ${input.baseUrl ?? "DEV"}. Judge EVERY concrete UI fact`,
        `(button/link labels, headings, routes) against THIS, never against prior knowledge of similar apps.`,
        "```",
        sanitizeText(input.domSnapshot, "model").text,
        "```",
      ].join("\n")
    : "";

  const specContent = specBlock;

  const learnedRulesContent = input.learnedRules ? [``, input.learnedRules].join("\n") : "";

  const PRIOR_CORRECTIONS_MAX_BYTES = 8_000;
  const priorCorrectionsContent = (() => {
    if (!input.priorCorrections || input.priorCorrections.length === 0) return "";
    const lines = input.priorCorrections.map((c, i) => `${i + 1}. ${sanitizeText(c).text}`).join("\n");
    const raw = [
      `## Prior-round corrections (from YOUR previous verdict on these specs)`,
      ``,
      `The generator has addressed these corrections. Your task for this round:`,
      `- APPROVE if the previously-raised BLOCKING issues are now resolved (do not re-raise them as new blocking corrections).`,
      `- NEW blocking issues on UNCHANGED specs: only if the prior-round fix introduced a new anti-pattern.`,
      `- Advisory nits on specs that are functionally identical to the prior round: omit.`,
      ``,
      lines,
    ].join("\n");
    if (Buffer.byteLength(raw, "utf8") > PRIOR_CORRECTIONS_MAX_BYTES) {
      const truncated = raw.slice(0, PRIOR_CORRECTIONS_MAX_BYTES);
      return truncated + "\n… (truncated — see spec contents for the full picture)";
    }
    return raw;
  })();

  /* VOLATILE: runtime execution evidence — D4/D5 injection. Deterministic orchestrator evidence (HTTP status codes + final URLs captured via page.on('response')) injected BEFORE the spec contents so the reviewer can weigh the objective server-error signal before reading test code. Priority 1.5 — after DOM grounding (which grounds UI facts) but before specs themselves. Absent when the run produced no execution evidence (first-time generate, code mode, etc.). */
  const executionResultContent = input.executionResult ?? "";

  return assemble([
    section("reviewer-role-framing", "stable-prefix", roleFramingContent, { priority: 1, cacheable: true }),
    section("reviewer-instructions", "stable-prefix", instructionsContent, { priority: 2, cacheable: true }),
    section("reviewer-objective", "semi-stable", objectiveContent, { priority: 1, language: "verbatim", maxBytes: 56_000, overflow: "summarize" }),
    /* VOLATILE: DOM grounding (priority 1 — first in VOLATILE so it precedes the spec contents that reference it; the instructions refer to it position-independently as "the Live DEV DOM section"). 20,000B mirrors the reviewer-corrections idiom; overflow:"summarize" for a visible-marker truncation instead of a silent whole-section drop. */
    ...(domContent ? [section("reviewer-dom", "volatile", domContent, { priority: 1, maxBytes: 20_000, overflow: "summarize" })] : []),
    ...(executionResultContent ? [section("reviewer-execution-result", "volatile", executionResultContent, { priority: 1.5 })] : []),
    section("reviewer-specs", "volatile", specContent, { priority: 2, maxBytes: 44_000, overflow: "summarize" }),
    ...(learnedRulesContent ? [section("reviewer-learned-rules", "volatile", learnedRulesContent, { priority: 3 })] : []),
    /* VOLATILE: Phase 4 prior-round corrections (priority 4 — convergence context; lowest priority in VOLATILE so it does not crowd out the spec contents or DOM grounding on budget overflow). */
    ...(priorCorrectionsContent ? [section("reviewer-prior-corrections", "volatile", priorCorrectionsContent, { priority: 4 })] : []),
    section("reviewer-output-contract", "critical-recap", outputContractContent, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes("qa-reviewer") });
}

export function buildReviewerPrompt(input: ReviewInput): string {
  return buildReviewerPromptAssembled(input).text;
}
