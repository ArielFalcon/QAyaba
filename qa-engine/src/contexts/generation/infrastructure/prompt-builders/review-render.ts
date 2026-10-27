/* What the independent reviewer is shown besides the rules: the objective of the review, the specs under review read through the confined reader, and the orchestrator's execution evidence. Never import src/. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { join } from "node:path";
import { readConfinedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { capText } from "../prompt-cap.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import { COMMIT_DIFF_HEADING, cappedDiffText } from "./prompt-text.ts";

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
    heading: COMMIT_DIFF_HEADING,
    /* Cap BEFORE sanitizing: capDiff splits on diff file-header boundaries and must see the raw structure; sanitizeText only redacts secret-shaped substrings. */
    body: ["```diff", cappedDiffText(input.diff), "```"],
    targetNoun: "the change",
  });
  if (input.mode === "diff" || input.target === "code") return commitDiffObjective();
  engineLog.warn(`[qa] reviewObjective: unhandled review mode ${JSON.stringify(input.mode)} — defaulting to the commit-diff objective`);
  return commitDiffObjective();
}

const REVIEW_SPECS_MAX_BYTES = 40_000;

/* Whether the specs section carries the spec contents (`inline`) or only their names, to be read from the working copy (`read`). Computed once per prompt: the instruction line and the section both render from it. */
export type ReviewSpecContents = "inline" | "read";

export interface ReviewSpecsOutcome {
  readonly text: string;
  readonly contents: ReviewSpecContents;
}

export function renderReviewSpecs(input: ReviewInput): string {
  return reviewSpecsOutcome(input).text;
}

export function reviewSpecsOutcome(input: ReviewInput): ReviewSpecsOutcome {
  const rel = (s: string) => (input.e2eRelDir ? `${input.e2eRelDir}/${s}` : s);
  /* The specs are the names the generator reported: each is read through the confined reader, so one that leaves the spec directory is judged from the placeholder below, never from what it points at. */
  const root: SpecRoot = { mirrorDir: input.mirrorDir, specDir: join(input.mirrorDir, input.e2eRelDir) };
  const contents: string[] = [];
  let totalBytes = 0;
  for (const s of input.specs) {
    let content: string;
    try {
      content = readConfinedSpecFile(root, s);
    } catch (err) {
      /* A spec the independent reviewer NEVER sees can otherwise ship inside an approved batch — that silently bypasses the quality gate. Surface it loudly (AGENTS.md: never swallow), like the byte-cap branch below does for its own mode switch. */
      engineLog.warn(`[qa] WARNING: could not read spec '${rel(s)}' for review (${err instanceof Error ? err.message : String(err)}) — it will be judged from a placeholder, NOT its real content.`);
      contents.push(`### ${rel(s)}\n( could not read file — review skipped for this spec )`);
      continue;
    }
    const block = `### ${rel(s)}\n\`\`\`typescript\n${content}\n\`\`\``;
    totalBytes += Buffer.byteLength(block, "utf8");
    if (totalBytes > REVIEW_SPECS_MAX_BYTES) {
      engineLog.warn(
        `[qa] WARNING: the combined contents of ${input.specs.length} spec(s) exceed the ${REVIEW_SPECS_MAX_BYTES}-byte inline cap — ` +
          `the reviewer will read files itself instead of judging inlined contents (weaker determinism).`,
      );
      return {
        contents: "read",
        text: `## Specs to review\n\n${input.specs.map((n, i) => `${i + 1}. ${rel(n)}`).join("\n")}\n\n( spec contents exceed ${REVIEW_SPECS_MAX_BYTES} bytes — read each file with the read tool )`,
      };
    }
    contents.push(block);
  }
  return { contents: "inline", text: `## Specs to review (${contents.length} file(s) — contents provided inline)\n\n${contents.join("\n\n")}` };
}

/** Renders a deterministic RUNTIME EXECUTION RESULT section from the orchestrator's evidence (HTTP status codes and final URLs captured during test execution). This is evidence the reviewer can use to distinguish an app defect (5xx) from a test defect — captured by the orchestrator, not inferred from the generator's reasoning, so reviewer independence is preserved. Output is bounded at 4000 chars total; per-case detail is capped at 500 chars. finalUrl is sanitized via sanitizeText before being included in the prompt (prevents secrets in redirect URLs from leaking to the reviewer model). */
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
      const capped = capText(c.detail, CAP_DETAIL_INTERNAL);
      lines.push(`  detail: ${capped}`);
    }
  }

  const raw = lines.join("\n");
  if (raw.length <= CAP_TOTAL) return raw;
  return capText(raw, CAP_TOTAL_INTERNAL);
}
