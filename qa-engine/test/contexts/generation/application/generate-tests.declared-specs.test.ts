import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts, type GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable, ManifestEntry } from "@contexts/generation/application/ports/index.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";

interface Options {
  needsReview?: boolean;
  target?: OpencodeRunInput["target"];
  /** The reviewer's verdict; absent approves. */
  approved?: boolean;
  /** What the manifest keeps of the entries it is given; absent keeps them all. */
  reconcile?: (entries: ManifestEntry[]) => ManifestEntry[];
}

/* A generation whose verdict parses to `deliverable`, run through the use case with the ports faked at the boundary. */
function generate(deliverable: GeneratorDeliverable, options: Options = {}): Promise<GenerationResult> {
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({ prompt: async () => ({ output: "VERDICT" }), dispose: () => {} }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN PROMPT", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "REVIEW PROMPT", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => deliverable,
      parseReview: () => ({ approved: options.approved ?? true, corrections: [], blockingCount: options.approved === false ? 1 : 0, parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_root, entries) => (options.reconcile ? options.reconcile([...entries]) : [...entries]) },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
  };
  return new GenerateTestsUseCase(ports).generate({
    repo: "org/demo",
    sha: "abc1234",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: options.needsReview ?? false,
    target: options.target ?? "e2e",
    mode: "diff",
    appName: "a",
  });
}

const meta = (file: string, flow: string, objective: string) => ({ file, flow, objective, targets: ["src/x.ts"] });

const LOGIN = meta("flows/login.spec.ts", "login", "the user signs in");
const DELIVERED = { specs: ["flows/login.spec.ts", "flows/cart.spec.ts"], specMetas: [LOGIN], parsed: true };
const DECLARED = [{ file: "flows/login.spec.ts", flow: "login", objective: "the user signs in" }, { file: "flows/cart.spec.ts" }];

for (const needsReview of [false, true]) {
  const path = needsReview ? "review path" : "no-review path";

  test(`${path}: the delivered specs are declared with what the verdict's metas state, and a spec with no meta by its path alone`, async () => {
    const result = await generate(DELIVERED, { needsReview });
    assert.deepEqual(result.declaredSpecs, DECLARED);
  });

  test(`${path}: a verdict that delivered no spec declares none`, async () => {
    const result = await generate({ specs: [], parsed: true }, { needsReview });
    assert.equal("declaredSpecs" in result, false);
  });

  test(`${path}: the join is on the resolved file, however the meta spells it`, async () => {
    const result = await generate({ specs: ["./flows/login.spec.ts"], specMetas: [meta("flows\\login.spec.ts", "login", "the user signs in")], parsed: true }, { needsReview });
    assert.deepEqual(result.declaredSpecs, [{ file: "flows/login.spec.ts", flow: "login", objective: "the user signs in" }]);
  });

  test(`${path}: a code target declares its specs too`, async () => {
    const result = await generate({ specs: ["src/foo.test.ts"], specMetas: [meta("src/foo.test.ts", "foo", "foo adds")], parsed: true }, { needsReview, target: "code" });
    assert.deepEqual(result.declaredSpecs, [{ file: "src/foo.test.ts", flow: "foo", objective: "foo adds" }]);
  });
}

test("review path: a spec the reviewer rejected is still a delivered spec, declared for the regeneration that follows", async () => {
  const result = await generate(DELIVERED, { needsReview: true, approved: false });
  assert.equal(result.approved, false);
  assert.deepEqual(result.declaredSpecs, DECLARED);
});

test("review path: the declaration comes from the verdict, not from what the manifest kept of it", async () => {
  const result = await generate(DELIVERED, { needsReview: true, reconcile: () => [] });
  assert.deepEqual(result.declaredSpecs, DECLARED);
  assert.deepEqual(result.specMetas, [], "what is published is still what the manifest kept");
});

test("review path: the manifest entries that are published are left as the manifest reconciled them", async () => {
  const kept = { id: "login", file: "flows/login.spec.ts", flow: "login", objective: "the user signs in", targets: ["src/x.ts"], changeRef: { sha: "abc1234", type: "unknown" } } satisfies ManifestEntry;
  const result = await generate(DELIVERED, { needsReview: true, reconcile: () => [kept] });
  assert.deepEqual(result.specMetas, [kept]);
});

test("no-review path: the result still publishes no specMetas, as before", async () => {
  const result = await generate(DELIVERED, { needsReview: false });
  assert.equal("specMetas" in result, false);
  assert.deepEqual(result.specs, DELIVERED.specs);
});
