/* The sidekick kind registry against the roster: an entry never names an agent or a prompt the roster does not hold. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REGISTERED_SIDEKICK_KINDS, SIDEKICK_KIND, sidekickKindSpec, delegatingKindSpec } from "@contexts/coordination/application/sidekick-kinds.ts";
import { REVIEW_SIDEKICK } from "@kernel/sidekick-session.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const roster = JSON.parse(readFileSync(`${ROOT}agents/opencode.json`, "utf8")) as { agent: Record<string, { prompt?: string; tools?: Record<string, boolean> }> };

test("every registered kind names an agent that exists in the roster and a prompt file that exists", () => {
  for (const spec of REGISTERED_SIDEKICK_KINDS()) {
    const entry = roster.agent[spec.agent];
    assert.ok(entry, `${spec.id}: ${spec.agent} is in the roster`);
    const file = /\{file:\.\/(.+)\}/.exec(entry.prompt ?? "")?.[1];
    assert.ok(file && existsSync(`${ROOT}agents/${file}`), `${spec.id}: its prompt file exists`);
  }
});

test("the author kind works in a private copy holding its one writable file", () => {
  assert.equal(sidekickKindSpec(SIDEKICK_KIND.AUTHOR).workspace, "isolated-spec-file");
});

test("a kind that is not registered is refused loudly", () => {
  assert.throws(() => sidekickKindSpec("unknown" as never), /no sidekick kind/);
});

test("the review kind is the read-only reviewer agent working in the working copy under the reviewer's session timeout", () => {
  const spec = sidekickKindSpec(SIDEKICK_KIND.REVIEW);
  assert.equal(spec.agent, REVIEW_SIDEKICK.agent);
  assert.equal(spec.role, REVIEW_SIDEKICK.role);
  assert.equal(spec.workspace, "working-copy");
  assert.equal(spec.budget, "review-timeout");
});

test("the author kind reads an unreadable answer as a failed result", () => {
  const spec = delegatingKindSpec(SIDEKICK_KIND.AUTHOR);
  const redaction = new PatternRedactionAdapter();
  const brief = { delegationId: "d", runId: "r", acceptanceCriteria: [], scope: { writablePaths: ["e2e/a.spec.ts"] } } as never;
  assert.equal(spec.parse(redaction, "no json here", brief).status, "failed");
});
