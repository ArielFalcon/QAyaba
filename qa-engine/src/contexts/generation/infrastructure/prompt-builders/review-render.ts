/* What the independent reviewer is shown besides the rules: the objective of the review, the specs under review read through the confined reader, and the orchestrator's execution evidence. Never import src/. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { join } from "node:path";
import { readConfinedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { boundEvidenceText } from "../prompt-cap.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import { COMMIT_DIFF_HEADING, redactedDiffText } from "./prompt-text.ts";

/* Whether the review judges a commit's change by flow under review (a planned e2e diff run with a change view) instead of its whole diff. */
export function reviewsByFlow(input: ReviewInput): input is ReviewInput & { changeView: NonNullable<ReviewInput["changeView"]> } {
  return input.mode === "diff" && input.target !== "code" && input.changeView !== undefined;
}

/* `diff` is set when the objective carries the whole commit diff: the part of it a prompt over its window gives up first. */
export function reviewObjective(input: ReviewInput): { subject: string; heading: string; body: string[]; targetNoun: string; diff?: string } {
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
    heading: COMMIT_DIFF_HEADING,
    body: ["```diff", redactedDiffText(input.diff), "```"],
    targetNoun: "the change",
    diff: input.diff,
  });
  /* A planned run's change is given by flow under review in the sections that follow (reviewer-change-sections.ts), never cut: no whole diff here. */
  if (reviewsByFlow(input)) {
    return {
      subject: "this commit",
      heading: `## Objective — this commit, by the flow each spec was planned for`,
      body: [
        `Each spec under review was planned for a flow, and the next sections give the part of the commit that flow`,
        `must exercise, every changed file, and in full the part of the commit no flow under review was assigned.`,
        `Judge each spec against its flow's part of the change; the rest is context it was not asked to cover.`,
      ],
      targetNoun: "the change",
    };
  }
  if (input.mode === "diff" || input.target === "code") return commitDiffObjective();
  engineLog.warn(`[qa] reviewObjective: unhandled review mode ${JSON.stringify(input.mode)} — defaulting to the commit-diff objective`);
  return commitDiffObjective();
}

/* Whether the specs section carries the spec contents (`inline`) or only their names, to be read from the working copy (`read`). Computed once per prompt: the instruction line and the section both render from it. */
export type ReviewSpecContents = "inline" | "read";

export interface ReviewSpecsOutcome {
  readonly text: string;
  readonly contents: ReviewSpecContents;
}

export function renderReviewSpecs(input: ReviewInput): string {
  return reviewSpecsOutcome(input).text;
}

/*
 * The specs inline, every one, whatever their size; with `asReferences` (the reviewer's prompt does not fit its window with them
 * inline) only their names, to be read. No fixed byte count decides which.
 */
export function reviewSpecsOutcome(input: ReviewInput, opts: { asReferences?: boolean } = {}): ReviewSpecsOutcome {
  const rel = (s: string) => (input.e2eRelDir ? `${input.e2eRelDir}/${s}` : s);
  if (opts.asReferences && input.specs.length > 0) {
    engineLog.warn(`[qa] WARNING: the contents of ${input.specs.length} spec(s) do not fit the reviewer's window — the reviewer reads the files itself instead of judging inlined contents.`);
    return {
      contents: "read",
      text: `## Specs to review\n\n${input.specs.map((n, i) => `${i + 1}. ${rel(n)}`).join("\n")}\n\n( the spec contents are not shown here, to fit the window — read each file with the read tool )`,
    };
  }
  /* The specs are the names the generator reported: each is read through the confined reader, so one that leaves the spec directory is judged from the placeholder below, never from what it points at. */
  const root: SpecRoot = { mirrorDir: input.mirrorDir, specDir: join(input.mirrorDir, input.e2eRelDir) };
  const contents: string[] = [];
  for (const s of input.specs) {
    let content: string;
    try {
      content = readConfinedSpecFile(root, s);
    } catch (err) {
      /* A spec the independent reviewer NEVER sees can otherwise ship inside an approved batch — that silently bypasses the quality gate. Surface it loudly (AGENTS.md: never swallow), like the window's switch to references does for its own. */
      engineLog.warn(`[qa] WARNING: could not read spec '${rel(s)}' for review (${err instanceof Error ? err.message : String(err)}) — it will be judged from a placeholder, NOT its real content.`);
      contents.push(`### ${rel(s)}\n( could not read file — review skipped for this spec )`);
      continue;
    }
    contents.push(`### ${rel(s)}\n\`\`\`typescript\n${content}\n\`\`\``);
  }
  return { contents: "inline", text: `## Specs to review (${contents.length} file(s) — contents provided inline)\n\n${contents.join("\n\n")}` };
}

/** Renders a deterministic RUNTIME EXECUTION RESULT section from the orchestrator's evidence (HTTP status codes and final URLs captured during test execution). This is evidence the reviewer can use to distinguish an app defect (5xx) from a test defect — captured by the orchestrator, not inferred from the generator's reasoning, so reviewer independence is preserved. Every case is listed whole (a detail past the safety bound on evidence text is cut and says so); over the reviewer's window the section gives up the details, then the urls (reviewer-sections.ts). finalUrl is sanitized via sanitizeText before being included in the prompt (prevents secrets in redirect URLs from leaking to the reviewer model). */
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
  const lines: string[] = [
    `## RUNTIME EXECUTION RESULT (captured by the orchestrator, not inferred)`,
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
      lines.push(`  detail: ${boundEvidenceText(c.detail)}`);
    }
  }

  return lines.join("\n");
}

/* The execution result's lines a prompt over its window can do without, in the order they give way: each case's detail, then its final url. The verdict, the case names and their status stay. */
export const EXECUTION_RESULT_DETAIL_PREFIX = "  detail: ";
export const EXECUTION_RESULT_URL_PREFIX = "  finalUrl: ";

/* The result without the lines that start with `prefix`, and how many that was. */
export function withoutExecutionResultLines(result: string, prefix: string): { text: string; left: number } {
  const kept = result.split("\n").filter((line) => !line.startsWith(prefix));
  return { text: kept.join("\n"), left: result.split("\n").length - kept.length };
}
