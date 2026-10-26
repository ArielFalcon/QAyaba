/* The task block of a generator prompt: what this turn is asked to do, per mode, target and turn kind. The "how" lives in agents/agent/*.md. Never import src/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { diffStat, diffTier, type DiffStat, type DiffTier } from "@kernel/diff-stat.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import { claim, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { isTestWritingTurn } from "@contexts/generation/domain/step-limit.ts";
import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import { CODE_TOOLS, COMMIT_DIFF_HEADING, cappedDiffText, renderCommitMessage } from "./prompt-text.ts";

/* What a turn that writes tests says about the outcome its tests assert. The question is asked where the turn has no supplied, undisputed objective to go by; the rule against weakening a test is stated on every turn that writes tests, whether or not the question is asked, and by no other section. */
export const OBJECTIVE_HEADING = `## Objective — commit to this BEFORE writing`;

export const OBJECTIVE_QUESTION =
  `Before writing, state in ONE line the concrete, user-observable OUTCOME this change introduces — ` +
  `the specific thing a user can see that proves it works (e.g. "the discounted total shows after the ` +
  `cart re-queries"). Write the test to ASSERT that outcome, not merely that the flow runs.`;

export const ANTI_WEAKENING_RULE = `Preserve each test's objective and assertions: a spec MUST still fail if the behavior it covers regresses.`;

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
    `   Also give implementationFiles: the repo-relative files that implement the route's page (the files a change to that page would touch, with its template and style files when separate).`,
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
    `2. Find ALL Angular routing files (glob: **/*routes*.ts, **/app-routing*.ts).`,
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
    `End with ONLY this JSON (no other text). \`specs\` names the map relative to ${input.e2eRelDir}/, like every spec path:`,
    `{"specs":[".qa/context.json"],"note":"built architecture map with X routes, Y api operations, Z links"}`,
  ].join("\n");
}

export interface TaskParts {
  text: string;
  claims: PromptClaim[];
}

/* The changed-files line every diff-shaped task carries. */
function changedFilesLine(input: OpencodeRunInput, label: string): string {
  return `- ${label}: ${sanitizeText(input.intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`;
}

/* The objective part of a task: the rule against weakening a test on every turn that writes tests, and the question of the outcome ahead of it, with its heading and its claim, only where the turn asks it. A regeneration asks unless the listing found every spec under correction to have an objective its lead declared and nobody disputes; a first pass asks, except a code run on a diff, whose first pass has never asked for it. A turn that writes no tests says nothing of either. */
function objectivePart(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  if (!isTestWritingTurn(input)) return { text: "", claims: [] };
  const asked = isReGenTurn(input) ? guards.reaskObjective : !(input.target === "code" && input.mode === "diff");
  return asked
    ? { text: [OBJECTIVE_HEADING, OBJECTIVE_QUESTION, ANTI_WEAKENING_RULE].join("\n"), claims: [claim.directs("state-outcome")] }
    : { text: ANTI_WEAKENING_RULE, claims: [] };
}

/* A regeneration is a correction turn: the whole-repository analysis, the diff and the scope budget of a first pass are already in the session, and the regen-discipline section owns scope. Every mode keeps what a correction still needs — the objective part, and the intent, guidance or changed files that say what the corrections are about. */
function buildCodeRegenTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  const intent = input.intent;
  const lines: string[] = [];
  if (input.mode === "manual") {
    lines.push(
      `Re-generation pass for the UNIT/INTEGRATION tests of ${input.repo}, FOCUSED on:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
    );
  } else if (input.mode === "complete" || input.mode === "exhaustive") {
    lines.push(`Re-generation pass for the ${input.mode} source-code test suite run of ${input.repo}.`);
  } else {
    lines.push(
      `Re-generation pass for the UNIT/INTEGRATION tests of commit ${input.sha} of ${input.repo}.`,
      ``,
      `## Change intent (Conventional Commits)`,
      `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
      ``,
      `## Commit message (the author's intent — derive each test's objective from this)`,
      renderCommitMessage(intent, false),
    );
  }
  if (intent?.changedFiles?.length) lines.push(``, changedFilesLine(input, "Changed files (derive the scope from these)"));
  const objective = objectivePart(input, guards);
  if (objective.text) lines.push(``, objective.text);
  return { text: lines.join("\n"), claims: objective.claims };
}

function buildCodeTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  if (isReGenTurn(input)) return buildCodeRegenTask(input, guards);
  const objective = objectivePart(input, guards);
  if (input.mode === "manual") {
    const text = [
      `Generate or update UNIT/INTEGRATION tests for the source code of ${input.repo}, FOCUSED on:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      objective.text,
      ``,
      `Read the relevant source and the repo's existing tests (serena); match their framework and conventions.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
    return { text, claims: [claim.directs("analyze-repo"), ...objective.claims] };
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    const text = [
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
    return { text, claims: [claim.directs("analyze-repo")] };
  }

  const intent = input.intent;
  const text = [
    `Generate or update UNIT/INTEGRATION tests for the source-code changes in commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    changedFilesLine(input, "Changed files (derive the scope from these)"),
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, true),
    ``,
    `Cross-check against the diff: if the code does more than the message claims, test what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    COMMIT_DIFF_HEADING,
    "```diff",
    cappedDiffText(input.diff),
    "```",
    ``,
    `Test the changed logic DIRECTLY (no web, no browser, no Playwright): call the changed functions/`,
    `modules and assert behavior + edge cases. Match the repo's existing test framework and conventions.`,
    ``,
    objective.text,
  ].join("\n");
  return { text, claims: [claim.provides("diff"), claim.directs("consult", "diff"), ...objective.claims] };
}

/* A cross-repo change is read from the service's staged snapshot, never from its working copy: the block that says so declares the fact. */
const serviceSnapshotClaims = (input: OpencodeRunInput): PromptClaim[] => (input.service ? [claim.provides("staged-service-snapshot")] : []);

function buildServiceBlock(input: OpencodeRunInput): string[] {
  if (!input.service) return [];
  const svcOpenapiHints = input.service.openapi
    ? Array.isArray(input.service.openapi)
      ? input.service.openapi
      : [input.service.openapi]
    : undefined;
  const svcOpenapi = svcOpenapiHints?.map((h) => `contracts/${h}`).join(", ");
  return [
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
  ];
}

/* Rendered whenever the classifier computed a reason, regardless of regen round (unlike the diff cross-check instruction of a first pass, this explains a decision already made, not evidence that may have shed). classificationReason is a MODEL-bound string (it only ever reaches the generation prompt, never an Issue body), so it is sanitized in "model" mode — matching the sibling model-bound calls on this path (domSnapshot). `contradiction` only toggles a STATIC literal suffix (no user/model text flows through it), so there is nothing to sanitize on that field. */
function classifierNoteLines(input: OpencodeRunInput): string[] {
  if (!input.classificationReason) return [];
  return [
    `## Classifier note`,
    `${sanitizeText(input.classificationReason, "model").text}${input.contradiction ? " (the commit message under-promised — trust the diff)" : ""}`,
    ``,
  ];
}

function buildRegenTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  const intent = input.intent;
  const opening =
    input.mode === "manual"
      ? [
          `Re-generation pass for the E2E tests of ${input.repo}, FOCUSED on the following guidance:`,
          ``,
          sanitizeText(input.guidance ?? "(no guidance provided)").text,
        ]
      : input.mode === "complete" || input.mode === "exhaustive"
      ? [`Re-generation pass for the ${input.mode} E2E suite run of ${input.repo}.`]
      : [
          `Re-generation pass for the E2E tests of commit ${input.sha} of ${input.repo}.`,
          ``,
          `## Change intent (Conventional Commits)`,
          `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
          changedFilesLine(input, "Changed files (derive the scope/area from these)"),
          ``,
          `## Commit message (the author's intent — derive each test's objective from this)`,
          renderCommitMessage(intent, false),
          ``,
          ...classifierNoteLines(input),
        ];
  const objective = objectivePart(input, guards);
  const text = [
    ...opening,
    ``,
    objective.text,
    ...buildServiceBlock(input),
  ].join("\n");
  return { text, claims: [...objective.claims, ...serviceSnapshotClaims(input)] };
}

/* What the prompt already supplies, so the task does not send the agent to fetch it again. */
export interface TaskGuards {
  /* The architecture map is rendered in this prompt. */
  mapInjected: boolean;
  /* The prompt carries an explored blast radius: a structural signal that names symbols. */
  blastRadiusGrounded: boolean;
  /* The listing of the specs that already exist is in this prompt, which the byte budget may have shed from it. */
  suiteListed: boolean;
  /* The turn asks for the outcome again: a spec under correction has no objective its lead declared, or a reviewer disputes one. Read on a regeneration only. */
  reaskObjective: boolean;
}

/* What a diff of each size asks of the agent. The effort is a ceiling on the work and never a floor: no tier asks for a spec, and declaring the no-op, for either of its reasons, is within every bound. `upperBound` counts spec files (a flow each) for the whole change, or for each affected flow; inside each, a test per behaviour the change decides. The texts carry no figure and no word the lint counts, so the line adds nothing to the directive budget and declares no claim. */
export interface EffortTier {
  upperBound: { specs: number; per: "change" | "flow" };
  admitsNoOp: true;
  text: string;
}

/* The clause every tier ends with, so that what the data declares (the no-op is admitted) is what the text says. */
export const NO_OP_REASONS = {
  nothingWorthATest: "nothing here is worth a test",
  devCannotShow: "cannot be observed on DEV in its current state",
} as const;
export const EFFORT_NO_OP_CLAUSE = `or none if ${NO_OP_REASONS.nothingWorthATest} or the change ${NO_OP_REASONS.devCannotShow}`;
/* What each spec file holds: the change's own decisions, not its happy path alone. */
export const EFFORT_PER_BEHAVIOUR = "each with a test per behaviour the change decides";
const effortText = (tier: DiffTier, bound: string): string => `Expected effort (${tier} change): at most ${bound}, ${EFFORT_PER_BEHAVIOUR}, ${EFFORT_NO_OP_CLAUSE}.`;

export const EFFORT_BY_TIER: Record<DiffTier, EffortTier> = {
  tiny: { upperBound: { specs: 2, per: "change" }, admitsNoOp: true, text: effortText("tiny", "one or two spec files") },
  focused: { upperBound: { specs: 4, per: "change" }, admitsNoOp: true, text: effortText("focused", "a few spec files for the affected flows") },
  broad: { upperBound: { specs: 1, per: "flow" }, admitsNoOp: true, text: effortText("broad", "one spec file per affected flow, not a suite rewrite") },
};

/* The change's real size, from the changed files and the diff's own lines. */
function sizeSentence({ files, added, removed }: DiffStat): string {
  return `The change touches ${files} file${files === 1 ? "" : "s"} with +${added}/-${removed} lines,`;
}

export function buildTask(input: OpencodeRunInput, guards: TaskGuards): TaskParts {
  if (input.mode === "context") {
    return { text: buildContextTask(input), claims: [claim.directs("analyze-repo"), ...(input.services?.length ? [claim.provides("staged-service-snapshot")] : [])] };
  }
  if (input.target === "code") return buildCodeTask(input, guards);
  if (isReGenTurn(input)) return buildRegenTask(input, guards);
  if (input.mode === "complete" || input.mode === "exhaustive") {
    const text = [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the entire E2E suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow the E2E suite where it matters.`,
      ``,
      `1. Read the existing tests in ${input.e2eRelDir}/ and the app code (with ${CODE_TOOLS}) to`,
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
    return { text, claims: [claim.directs("analyze-repo")] };
  }
  const objective = objectivePart(input, guards);
  if (input.mode === "manual") {
    const text = [
      `Generate/update E2E tests for ${input.repo}, FOCUSED on the following guidance:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      objective.text,
      ``,
      /* The listing supplies the suite; the read of it is declared only where nothing lists it. */
      `Read the relevant code${guards.suiteListed ? "" : ` and the existing ${input.e2eRelDir}/ suite`} with ${CODE_TOOLS}.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
    return {
      text,
      claims: [claim.directs("analyze-repo"), ...objective.claims, ...(guards.suiteListed ? [] : [claim.directs("read", "existing-suite")])],
    };
  }

  const intent = input.intent;
  const stat = diffStat({ diff: input.diff, changedFiles: input.intent?.changedFiles });
  const text = [
    `Generate/update E2E tests for the flows affected by commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    changedFilesLine(input, "Changed files (derive the scope/area from these)"),
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, true),
    ``,
    `Cross-check against the diff: cover what the code actually changes, not only what the message promises.`,
    ``,
    ...classifierNoteLines(input),
    objective.text,
    ``,
    ...(guards.mapInjected
      ? []
      : [
          `## ${PROMPT_HEADINGS.architectureContext}`,
          `If ${input.e2eRelDir}/.qa/context.json exists, READ it to understand which routes and`,
          `API operations the changed files belong to. Use the feBe links to widen the blast`,
          `radius across the frontend→backend boundary: a frontend change may affect the`,
          `backend behaviour and vice-versa. If the map is missing or stale, note the`,
          `limitation explicitly in your verdict note.`,
          ``,
        ]),
    `## Scope budget (diff mode)`,
    `The blast radius IS your budget. ${sizeSentence(stat)} so keep it focused:`,
    ...(guards.blastRadiusGrounded ? [] : [`- Read ONLY the changed symbols and their direct callers/callees, with ${CODE_TOOLS}.`]),
    `- Do NOT read the whole repository, the entire e2e suite, or unrelated flows/files.`,
    /* The listing supplies the suite; the read of it is declared only where nothing lists it. */
    ...(guards.suiteListed ? [] : [`- Read existing specs ONLY for the one or two flows this commit actually touches.`]),
    /* The bound holds in every diff cell. It names no exploration: where the live page is navigated is the working rules' to say, and only without a pack DOM and a tree. */
    `- Work ONLY on the page(s) the change affects — not the whole app.`,
    EFFORT_BY_TIER[diffTier(stat)].text,
    ...buildServiceBlock(input),
  ].join("\n");
  const claims: PromptClaim[] = [...objective.claims];
  if (!guards.mapInjected) claims.push(claim.directs("read", "arch-map"), claim.frames("arch-map", "unverified"));
  if (!guards.blastRadiusGrounded) claims.push(claim.directs("orient", "blast-radius"));
  if (!guards.suiteListed) claims.push(claim.directs("read", "existing-suite"));
  /* The instruction to cross-check the diff is in this text, so the diff it refers to is declared consulted. */
  claims.push(claim.directs("consult", "diff"), ...serviceSnapshotClaims(input));
  return { text, claims };
}
