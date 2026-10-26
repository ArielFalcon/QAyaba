/* test/contexts/service-topology/infrastructure/level3-wiring.test.ts
   1. OpencodeRunInput.serviceLinks field presence and renderMain prompt section
   2. GenerateTestsUseCase with optional ServiceBoundaryResolverPort
 */
import type { ServiceLink } from "@kernel/service-links";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpencodeRunInput } from "@contexts/generation/application/index.ts";
import type { GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";

/* ---- OpencodeRunInput.serviceLinks field ----
   The field must be optional (no existing tests break) and accept ServiceLink[].
 */

test("OpencodeRunInput accepts serviceLinks as an optional field", () => {
  const link: ServiceLink = {
    from: { repo: "front/webapp", file: "src/api.ts", symbol: "listOrders" },
    to: { repo: "back/api", file: "openapi.yaml", symbol: "listOrders" },
    transport: "http",
    contractRef: "listOrders",
    confidence: 1.0,
    source: "openapi-http",
  };
  /* Construct an OpencodeRunInput with serviceLinks — must compile and be assignable. */
  const input: OpencodeRunInput = {
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
    serviceLinks: [link],
  };
  assert.ok(Array.isArray(input.serviceLinks), "serviceLinks should be an array");
  assert.equal(input.serviceLinks?.length, 1, "expected one serviceLink");
  assert.equal(input.serviceLinks?.[0]?.contractRef, "listOrders");
});

test("OpencodeRunInput without serviceLinks is still valid (optional field)", () => {
  const input: OpencodeRunInput = {
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  };
  assert.equal(input.serviceLinks, undefined, "serviceLinks is absent when not provided");
});

/* ---- GenerateTestsUseCase propagates serviceLinks to renderMain intact ----
   NOTE: no production renderMain implementation renders a "CROSS-REPO LINKS" prompt section
   from serviceLinks yet (that rendering is deferred to the runtime-wiring step — see the
   comment on OpencodeRunInput.serviceLinks in generation-input.ts). What IS real today is that
   GenerateTestsUseCase.generate() passes the full OpencodeRunInput through to
   rendering.renderMain(input) unchanged — so serviceLinks (or its absence) reaches renderMain
   intact. These tests assert only that real propagation, via a stub renderMain that captures
   the input it received — the stub does NOT masquerade as production prompt rendering.
 */

function makeGenerationPorts(capturedInput: { value: OpencodeRunInput | undefined }): GenerationPorts {
  return {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: '{"specs":[]}' }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: (input: OpencodeRunInput) => {
        /* Stub renderMain: captures the input it was called with so the test can assert on
           what the use-case PASSED, not on any rendering behavior (none is implemented here).
         */
        capturedInput.value = input;
        return { text: "BASE_PROMPT", sectionSizes: {} };
      },
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: [], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_root, e: readonly ManifestEntry[]) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d: string) => d,
      capText: (t: string) => t,
      budgetForRole: () => 0,
    },
  };
}

test("GenerateTestsUseCase propagates serviceLinks to renderMain intact when present", async () => {
  const capturedInput: { value: OpencodeRunInput | undefined } = { value: undefined };
  const ports = makeGenerationPorts(capturedInput);
  const useCase = new GenerateTestsUseCase(ports);
  const link: ServiceLink = {
    from: { repo: "front/webapp", file: "src/orders.api.ts", symbol: "listOrders" },
    to: { repo: "back/api", file: "openapi.yaml", symbol: "listOrders" },
    transport: "http",
    contractRef: "listOrders",
    confidence: 1.0,
    source: "openapi-http",
  };
  await useCase.author({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
    serviceLinks: [link],
  });
  assert.ok(capturedInput.value?.serviceLinks, "the use-case must pass serviceLinks through to renderMain");
  assert.equal(capturedInput.value?.serviceLinks?.length, 1);
  assert.equal(
    capturedInput.value?.serviceLinks?.[0],
    link,
    "renderMain must receive the SAME link object the use-case was given (passed through, not transformed)",
  );
});

test("GenerateTestsUseCase passes serviceLinks as absent to renderMain when not provided", async () => {
  const capturedInput: { value: OpencodeRunInput | undefined } = { value: undefined };
  const ports = makeGenerationPorts(capturedInput);
  const useCase = new GenerateTestsUseCase(ports);
  await useCase.author({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: "e2e",
    mode: "diff",
    appName: "a",
  });
  assert.equal(
    capturedInput.value?.serviceLinks,
    undefined,
    "renderMain must receive serviceLinks as undefined when the use-case was not given any",
  );
});
