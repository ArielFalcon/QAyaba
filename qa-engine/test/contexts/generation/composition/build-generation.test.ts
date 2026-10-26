/* buildGeneration: the generation and review ports reach the run's agent runtime, an e2e run is grounded three ways and a code run none, and the trace wrappers exist only with telemetry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeneration, type GenerationDeps } from "@contexts/generation/composition/build-generation.ts";

function deps(over: Partial<GenerationDeps> = {}, run: Partial<GenerationDeps["run"]> = {}): GenerationDeps {
  return {
    run: { repo: "o/app", appName: "app", mirrorDir: "/mirrors/o/app", e2eRelDir: "e2e", branch: "qa/x", target: "e2e", mode: "diff", isCode: false, ...run },
    generationUseCase: { generate: async () => { throw new Error("unused"); } },
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

test("a code run is grounded on nothing", () => {
  const api = buildGeneration(deps({}, { isCode: true, target: "code" }));

  assert.equal(api.preGenerationGrounding, undefined);
  assert.equal(api.preExecGrounding, undefined);
  assert.equal(api.reviewDomGrounding, undefined);
});

test("generating reaches the injected use case", async () => {
  const seen: string[] = [];
  const api = buildGeneration(deps({ generationUseCase: { generate: async () => { seen.push("generate"); throw new Error("stop"); } } }));

  await assert.rejects(() => api.generation.generate({ specDir: "/mirrors/o/app/e2e", objectives: [], signal: undefined } as never), /stop/);
  assert.deepEqual(seen, ["generate"]);
});

test("the trace wrappers return the port itself without telemetry and a decorator with it", () => {
  const port = { select: async () => [] } as never;
  const telemetry = { startSpan: () => ({}) } as never;

  assert.equal(buildGeneration(deps()).traced.curriculum(port), port);
  assert.notEqual(buildGeneration(deps({ telemetry })).traced.curriculum(port), port);
});
