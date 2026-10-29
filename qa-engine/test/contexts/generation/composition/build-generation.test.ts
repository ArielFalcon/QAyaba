/* buildGeneration: the generation and review ports reach the run's agent runtime, an e2e run is grounded three ways, and the trace wrappers exist only with telemetry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeneration, type GenerationDeps } from "@contexts/generation/composition/build-generation.ts";

function deps(over: Partial<GenerationDeps> = {}, run: Partial<GenerationDeps["run"]> = {}): GenerationDeps {
  return {
    run: { repo: "o/app", appName: "app", mirrorDir: "/mirrors/o/app", e2eRelDir: "e2e", branch: "qa/x", mode: "diff", ...run },
    generationUseCase: { author: async () => { throw new Error("unused"); } },
    review: { runtime: { runtime: { openSession: async () => { throw new Error("unused"); } }, rendering: {} as never, verdicts: {} as never } },
    grounding: {},
    ...over,
  };
}

test("an e2e run is grounded before generation, before execution and before review", () => {
  const api = buildGeneration(deps());

  assert.ok(api.generation);
  assert.ok(api.review);
  assert.ok(api.preGenerationGrounding);
  assert.ok(api.preExecGrounding);
  assert.ok(api.reviewDomGrounding);
});

test("generating reaches the injected use case", async () => {
  const seen: string[] = [];
  const api = buildGeneration(deps({ generationUseCase: { author: async () => { seen.push("generate"); throw new Error("stop"); } } }));

  await assert.rejects(() => api.generation.author({ specDir: "/mirrors/o/app/e2e", objectives: [], signal: undefined } as never), /stop/);
  assert.deepEqual(seen, ["generate"]);
});

test("the trace wrappers return the port itself without telemetry and a decorator with it", () => {
  const port = { select: async () => [] } as never;
  const telemetry = { startSpan: () => ({}) } as never;

  assert.equal(buildGeneration(deps()).traced.curriculum(port), port);
  assert.notEqual(buildGeneration(deps({ telemetry })).traced.curriculum(port), port);
});
