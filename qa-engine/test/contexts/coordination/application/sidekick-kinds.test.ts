/* The sidekick kind registry against the roster that grants the tools: an entry never names an agent, a prompt or a tool the roster does not hold. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_TOOL, REGISTERED_SIDEKICK_KINDS, SIDEKICK_KIND, sidekickKindSpec, delegatingKindSpec, type AgentTool } from "@contexts/coordination/application/sidekick-kinds.ts";
import { REVIEW_SIDEKICK } from "@kernel/sidekick-session.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const roster = JSON.parse(readFileSync(`${ROOT}agents/opencode.json`, "utf8")) as { agent: Record<string, { prompt?: string; tools?: Record<string, boolean> }> };

const FAMILY: ReadonlyArray<[RegExp, AgentTool | undefined]> = [
  [/^(write|edit)$/, AGENT_TOOL.WRITE],
  [/^authbrowser_/, AGENT_TOOL.AUTHBROWSER],
  [/^codegraph_explore$/, AGENT_TOOL.CODEGRAPH],
  [/^playwright\*$/, AGENT_TOOL.PLAYWRIGHT],
  [/^(read|run_spec|set_geolocation)$/, undefined],
];

/* The tool families a roster entry grants. */
function grantedBy(agent: string): AgentTool[] {
  const out = new Set<AgentTool>();
  for (const [tool, on] of Object.entries(roster.agent[agent]!.tools ?? {})) {
    if (!on) continue;
    const hit = FAMILY.find(([re]) => re.test(tool));
    if (hit) out.add(hit[1] ?? (tool as AgentTool));
  }
  return [...out].sort();
}

test("every registered kind names an agent that exists in the roster and a prompt file that exists", () => {
  for (const spec of REGISTERED_SIDEKICK_KINDS()) {
    const entry = roster.agent[spec.agent];
    assert.ok(entry, `${spec.id}: ${spec.agent} is in the roster`);
    const file = /\{file:\.\/(.+)\}/.exec(entry.prompt ?? "")?.[1];
    assert.ok(file && existsSync(`${ROOT}agents/${file}`), `${spec.id}: its prompt file exists`);
  }
});

test("a kind's registered tools equal the tools its agent is granted in the roster", () => {
  for (const spec of REGISTERED_SIDEKICK_KINDS()) {
    assert.deepEqual([...spec.tools].sort(), grantedBy(spec.agent), spec.id);
  }
});

test("the author kind\'s brief names its one writable file", () => {
  const spec = sidekickKindSpec(SIDEKICK_KIND.AUTHOR);
  assert.equal(spec.workspace, "isolated-spec-file");
  assert.ok(spec.tools.includes(AGENT_TOOL.WRITE));
});

test("a kind that is not registered is refused loudly", () => {
  assert.throws(() => sidekickKindSpec("unknown" as never), /no sidekick kind/);
});

test("the review kind is the read-only reviewer agent working in the working copy under the reviewer's session timeout", () => {
  const spec = sidekickKindSpec(SIDEKICK_KIND.REVIEW);
  assert.equal(spec.agent, REVIEW_SIDEKICK.agent);
  assert.equal(spec.role, REVIEW_SIDEKICK.role);
  assert.deepEqual([...spec.tools], [AGENT_TOOL.READ]);
  assert.equal(spec.workspace, "working-copy");
  assert.equal(spec.budget, "review-timeout");
});

test("the author kind reads an unreadable answer as a failed result", () => {
  const spec = delegatingKindSpec(SIDEKICK_KIND.AUTHOR);
  const redaction = new PatternRedactionAdapter();
  const brief = { delegationId: "d", runId: "r", acceptanceCriteria: [], scope: { writablePaths: ["e2e/a.spec.ts"] } } as never;
  assert.equal(spec.parse(redaction, "no json here", brief).status, "failed");
});
