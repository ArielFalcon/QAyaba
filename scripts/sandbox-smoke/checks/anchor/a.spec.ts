// Runs INSIDE the execution sandbox. PASSES when it is the only spec of this pair that runs: see scripts/sandbox-smoke-checks.ts.
import { test } from "@playwright/test";

test("anchor-a ran", () => {});
