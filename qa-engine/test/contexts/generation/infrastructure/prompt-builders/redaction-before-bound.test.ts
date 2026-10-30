/* Text a prompt carries from outside the orchestrator is redacted before a safety bound cuts it, so a secret that straddles the bound leaves nothing of itself, by pattern or by run secret. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMIT_BODY_SAFETY_BOUND, EVIDENCE_TEXT_SAFETY_BOUND } from "@contexts/generation/infrastructure/prompt-cap.ts";
import type { CommitIntent } from "@contexts/generation/domain/generation-input.ts";
import { renderCommitMessage } from "@contexts/generation/infrastructure/prompt-builders/prompt-text.ts";
import { renderExecutionResult } from "@contexts/generation/infrastructure/prompt-builders/review-render.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../../src/shared-kernel/run-secret-redaction.ts";

/* Word-like filler: a run of one repeated character trips the entropy redaction and would hide the cut. */
const filler = (chars: number): string => "the change reworks the page header layout. ".repeat(Math.ceil(chars / 42)).slice(0, chars);
const TOKEN = `sk-${"Q7x9Zk2M".repeat(6)}`;
const intent = (body: string): CommitIntent => ({ type: "fix", breaking: false, message: "fix: header", body, changedFiles: [] });
const PASSWORD = "tangerine-staple-orbit-9";

/* Text whose secret begins `inside` characters before the bound. */
const straddling = (secret: string, bound: number, inside = 12): string => `${filler(bound - inside)}${secret} and more words after it`;

test("a token straddling the commit body bound leaves no part of itself in the commit message", () => {
  const message = renderCommitMessage(intent(straddling(TOKEN, COMMIT_BODY_SAFETY_BOUND)), true);
  assert.ok(!message.includes("sk-Q7x9"), message.slice(-80));
});

test("a run secret straddling the commit body bound leaves no part of itself in the commit message", () => {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD]);
  const message = withRunSecretScope(scope, () => renderCommitMessage(intent(straddling(PASSWORD, COMMIT_BODY_SAFETY_BOUND)), true));
  assert.ok(!message.includes("tangerine"), message.slice(-80));
});

test("a token straddling the bound of a case's detail leaves no part of itself in the execution result", () => {
  const out = renderExecutionResult({ verdict: "fail", cases: [{ name: "checkout", detail: straddling(TOKEN, EVIDENCE_TEXT_SAFETY_BOUND) }] });
  assert.ok(!out.includes("sk-Q7x9"), out.slice(-80));
});
