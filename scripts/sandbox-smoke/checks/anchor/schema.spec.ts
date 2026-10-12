// Runs INSIDE the execution sandbox. PASSES when it does NOT run although its name ends in `a.spec.ts`: see scripts/sandbox-smoke-checks.ts.
import { test } from "@playwright/test";

test("anchor-schema ran", () => {});
