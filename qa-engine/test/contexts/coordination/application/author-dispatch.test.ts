import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTHOR_TARGET, SIDEKICK_BUDGET, SIDEKICK_WORKSPACE, authorTargetOf, authorTargetSpec, dispatchAuthor } from "@contexts/coordination/application/index.ts";
import type { AuthorPort, GenerationEnrichment } from "@contexts/generation/application/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";

const LOOP = { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 };

function recordingAuthor() {
  const calls: Array<{ specDir: string; signal?: AbortSignal; diff?: string; enrichment?: GenerationEnrichment }> = [];
  const port: AuthorPort = {
    author: async (specDir, signal, diff, enrichment) => {
      calls.push({ specDir, ...(signal ? { signal } : {}), ...(diff !== undefined ? { diff } : {}), ...(enrichment ? { enrichment } : {}) });
      return scriptedGeneration({ specs: ["a.spec.ts"] });
    },
  };
  return { port, calls };
}

test("the run authors the repo's tests, the architecture map or specs according to its target and mode", () => {
  assert.equal(authorTargetOf({ isCode: true, mode: "diff" }), AUTHOR_TARGET.CODE);
  assert.equal(authorTargetOf({ isCode: false, mode: "context" }), AUTHOR_TARGET.CONTEXT);
  assert.equal(authorTargetOf({ isCode: false, mode: "diff" }), AUTHOR_TARGET.E2E);
  assert.equal(authorTargetOf({ isCode: false, mode: "manual" }), AUTHOR_TARGET.E2E);
});

test("every target the run authors for works in the run's working copy under the run's own deadline; a flow works in a private copy under its flow budget", () => {
  for (const target of [AUTHOR_TARGET.E2E, AUTHOR_TARGET.CODE, AUTHOR_TARGET.CONTEXT]) {
    assert.deepEqual(authorTargetSpec(target), { workspace: SIDEKICK_WORKSPACE.WORKING_COPY, budget: SIDEKICK_BUDGET.RUN }, target);
  }
  assert.deepEqual(authorTargetSpec(AUTHOR_TARGET.FLOW), { workspace: SIDEKICK_WORKSPACE.ISOLATED_SPEC_FILE, budget: SIDEKICK_BUDGET.FLOW });
});

test("dispatching an author hands the author port the spec directory, the signal, the diff and the enrichment, and returns what it delivered", async () => {
  const { port, calls } = recordingAuthor();
  const controller = new AbortController();

  const out = await dispatchAuthor(port, { target: AUTHOR_TARGET.E2E, specDir: "/m/e2e", signal: controller.signal, diff: "the diff", enrichment: { sha: "abc1234", learnedRules: [] } });

  assert.deepEqual(out.specs, ["a.spec.ts"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.specDir, "/m/e2e");
  assert.equal(calls[0]!.signal, controller.signal);
  assert.equal(calls[0]!.diff, "the diff");
  assert.equal(calls[0]!.enrichment?.sha, "abc1234");
});

test("an author of the run's own authoring is told no run_spec budget: a loop belongs to one flow of a plan", async () => {
  const { port, calls } = recordingAuthor();

  await dispatchAuthor(port, { target: AUTHOR_TARGET.E2E, specDir: "/m/e2e", enrichment: { sha: "abc1234", closedLoop: LOOP } });

  assert.equal(calls[0]!.enrichment?.closedLoop, undefined);
  assert.equal(calls[0]!.enrichment?.sha, "abc1234", "nothing else of the grounding is dropped");
});

test("an author dispatched with no grounding is dispatched with none, and a refused target is an error", async () => {
  const { port, calls } = recordingAuthor();

  await dispatchAuthor(port, { target: AUTHOR_TARGET.CODE, specDir: "/m/src" });
  assert.deepEqual(calls[0]!.enrichment, {});

  await assert.rejects(dispatchAuthor(port, { target: "unknown" as never, specDir: "/m/e2e" }), /no author target "unknown"/);
  assert.equal(calls.length, 1, "no author is asked for a target nobody registered");
});
