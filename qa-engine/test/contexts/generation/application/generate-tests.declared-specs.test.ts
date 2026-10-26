import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type AuthoringPorts, type GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable } from "@contexts/generation/domain/manifest-repository.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";

interface Options {
  target?: OpencodeRunInput["target"];
  /** What the manifest keeps of the entries it is given; absent keeps them all. */
  reconcile?: (entries: ManifestEntry[]) => ManifestEntry[];
}

/* A generation whose verdict parses to `deliverable`, run through the use case with the ports faked at the boundary. */
function generate(deliverable: GeneratorDeliverable, options: Options = {}): Promise<GenerationResult> {
  const ports: AuthoringPorts = {
    runtime: {
      openSession: async () => ({ prompt: async () => ({ output: "VERDICT" }), dispose: () => {} }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN PROMPT", sectionSizes: {} }),
      renderReviewer: () => ({ text: "REVIEW PROMPT", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => deliverable,
      parseReview: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_root, entries) => (options.reconcile ? options.reconcile([...entries]) : [...entries]) },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
  };
  return new GenerateTestsUseCase(ports).author({
    repo: "org/demo",
    sha: "abc1234",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    target: options.target ?? "e2e",
    mode: "diff",
    appName: "a",
  });
}

const meta = (file: string, flow: string, objective: string) => ({ file, flow, objective, targets: ["src/x.ts"] });

const LOGIN = meta("flows/login.spec.ts", "login", "the user signs in");
const DELIVERED = { specs: ["flows/login.spec.ts", "flows/cart.spec.ts"], specMetas: [LOGIN], parsed: true };
const DECLARED = [{ file: "flows/login.spec.ts", flow: "login", objective: "the user signs in" }, { file: "flows/cart.spec.ts" }];

test(`the delivered specs are declared with what the verdict's metas state, and a spec with no meta by its path alone`, async () => {
  const result = await generate(DELIVERED, {});
  assert.deepEqual(result.declaredSpecs, DECLARED);
});

test(`a verdict that delivered no spec declares none`, async () => {
  const result = await generate({ specs: [], parsed: true }, {});
  assert.equal("declaredSpecs" in result, false);
});

test(`the join is on the resolved file, however the meta spells it`, async () => {
  const result = await generate({ specs: ["./flows/login.spec.ts"], specMetas: [meta("flows\\login.spec.ts", "login", "the user signs in")], parsed: true }, {});
  assert.deepEqual(result.declaredSpecs, [{ file: "flows/login.spec.ts", flow: "login", objective: "the user signs in" }]);
});

test(`a code target declares its specs too`, async () => {
  const result = await generate({ specs: ["src/foo.test.ts"], specMetas: [meta("src/foo.test.ts", "foo", "foo adds")], parsed: true }, { target: "code" });
  assert.deepEqual(result.declaredSpecs, [{ file: "src/foo.test.ts", flow: "foo", objective: "foo adds" }]);
});

test("the declaration comes from the verdict, not from what the manifest kept of it", async () => {
  const result = await generate(DELIVERED, { reconcile: () => [] });
  assert.deepEqual(result.declaredSpecs, DECLARED);
  assert.deepEqual(result.specMetas, [], "what is published is still what the manifest kept");
});

test("the manifest entries that are published are left as the manifest reconciled them", async () => {
  const kept = { id: "login", file: "flows/login.spec.ts", flow: "login", objective: "the user signs in", targets: ["src/x.ts"], changeRef: { sha: "abc1234", type: "unknown" } } satisfies ManifestEntry;
  const result = await generate(DELIVERED, { reconcile: () => [kept] });
  assert.deepEqual(result.specMetas, [kept]);
});

test("the result publishes the manifest's entries whatever the run's review setting", async () => {
  const result = await generate(DELIVERED);
  assert.equal(result.specMetas?.length, 1);
  assert.deepEqual(result.specs, DELIVERED.specs);
});
