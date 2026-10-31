/* decision without knowing provider or model. Generation / FixLoop / AgentRuntime
   call sites stay equivalent: this file also pins that they do not import the seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COORDINATION_ACTIONS } from "@contexts/coordination/application/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const qaEngineRoot = join(here, "..", "..");

test("the coordination actions are the assignment union, not OrchestrationDecision verbs", () => {
  assert.deepEqual(
    [...COORDINATION_ACTIONS],
    ["direct", "delegate", "retry", "escalate", "abort"],
  );
});

test("wires coordination only into RunQaUseCase — generation/FixLoop/AgentRuntime stay free of the seam", () => {
  const forbidden = [
    "src/contexts/generation/application/generate-tests.use-case.ts",
    "src/contexts/run-orchestration/domain/fix-loop.aggregate.ts",
    "src/shared-kernel/ports/agent-runtime.port.ts",
    "src/shared-kernel/agent-role.ts",
  ];
  for (const rel of forbidden) {
    const src = readFileSync(join(qaEngineRoot, rel), "utf8");
    assert.equal(
      src.includes("application/coordination"),
      false,
      `${rel} must not import the coordination seam`,
    );
    assert.equal(
      src.includes("CoordinationPort"),
      false,
      `${rel} must not name CoordinationPort`,
    );
  }
  /* The use case and the types of its dependencies, which name the seam it is given. */
  const useCase = ["run-qa.use-case.ts", "run-flow/run-types.ts"]
    .map((file) => readFileSync(join(qaEngineRoot, "src/contexts/run-orchestration/application", file), "utf8"))
    .join("\n");
  assert.equal(useCase.includes("LeadSidekicks"), true);
  assert.equal(useCase.includes("advisoryOnly"), false, "advisory downgrade was removed with the modes");
  const composition = readFileSync(
    join(qaEngineRoot, "..", "platform/composition/engine-root.ts"),
    "utf8",
  );
  assert.equal(
    composition.includes("coordinationMode"),
    false,
    "the engine-wide mode selector is gone — a run's mode is a setting, not a branch of the composition",
  );
});
