/* Text helpers every prompt builder shares: model-bound redaction, the capped diff, the commit message and the step-limit fact. Never import src/. */

import { sanitizeText, assertNoSecretLeak, type RedactionMode } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { capText, extractDiffFilePath } from "../prompt-cap.ts";
import type { CommitIntent } from "../../domain/generation-input.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";

export function renderCommitMessage(intent: CommitIntent | undefined, includeBody: boolean): string {
  const subject = intent?.message ?? "";
  const body = includeBody ? intent?.body : undefined;
  return sanitizeText(body ? `${subject}\n\n${capText(body)}` : subject).text;
}

/* The cap the runtime enforces for the turn, stated as a fact: the number and nothing else. It bounds the turn the prompt is sent for, never the session. A generator prompt and a reviewer prompt state it the same way. */
export function renderStepLimit(limit: number): string {
  return [`## ${PROMPT_HEADINGS.stepLimit}`, `This turn runs at most ${limit} steps.`].join("\n");
}

/* Free text an agent or a test run wrote (what the listing says of a spec, what a failing case reports) crosses the model boundary through the same redaction as any other model-bound text. */
export function redactForModel(text: string): string {
  return sanitizeText(text, "model").text;
}

/* THE single way to embed a commit diff into any prompt: secret-scrubbed section by section on the raw `diff --git` boundaries. Each section is redacted AND guarded (assertNoSecretLeak) independently, with that section's own mode. A diff with no file header at all (several unit-test fixtures pass raw, header-less snippets as `diff`) has no file to key a mode off, so the whole text keeps the prior "model" mode — unchanged for those callers. */
const CODE_FILE_EXTENSIONS = new Set([
  /* Every language this system's watched apps and self-maintenance target today (see AGENTS.md's "Java + JavaScript/TypeScript" scope note) plus common ecosystems, so a diff hunk touching source code keeps model-mode's narrower, code-aware redaction instead of the config-file default. */
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "go", "rs", "kt", "cs", "rb", "php", "swift",
]);

export function diffSectionMode(filePath: string): RedactionMode {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return CODE_FILE_EXTENSIONS.has(ext) ? "model" : "issue";
}

const DIFF_HEADER_RE = /^diff --git /;

/* The heading of the diff section of a prompt. The judges read the diff back out of a stored prompt by it (src/server/judge-evidence.ts), so the heading is one constant. */
export const COMMIT_DIFF_HEADING = "## Commit diff";

/* The commit diff as a prompt section: its heading and the redacted diff in one fence, whole. A prompt over its role's window gives hunks of it up as references (diffWindowDegrade); no character count cuts it. */
export function commitDiffBlock(diff: string): string {
  return [COMMIT_DIFF_HEADING, "```diff", redactedDiffText(diff), "```"].join("\n");
}

/* A diff, or part of one, redacted for a model section by section by each file's kind, and never cut. */
export function redactedDiffText(capped: string): string {
  const sections = capped.split(/^(?=diff --git )/m);
  const hasFileHeader = sections.some((s) => DIFF_HEADER_RE.test(s));
  if (!hasFileHeader) return redactedDiffOf(capped, "model");
  return sections.map((section) => redactedDiffOf(section, DIFF_HEADER_RE.test(section) ? diffSectionMode(extractDiffFilePath(section)) : "issue")).join("");
}

/* Diff text redacted with the given mode and guarded, so no secret-shaped string reaches the model. */
export function redactedDiffOf(text: string, mode: RedactionMode): string {
  const redacted = sanitizeText(text, mode).text;
  assertNoSecretLeak(redacted, mode, "diff→model");
  return redacted;
}

/* How a turn reads code the prompt does not provide: the order the shared rules give, so no prompt names a tool a role may not hold. */
export const CODE_TOOLS = "your code tools in the order AGENTS.md gives";
