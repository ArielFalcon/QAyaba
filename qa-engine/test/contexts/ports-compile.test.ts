import { test } from "node:test";
import assert from "node:assert/strict";

/* Importing every context's public surface forces tsc (via the npm run typecheck gate) to prove that the
   ports and the types they re-export compile against the kernel and nothing external, and that the
   modules load at runtime. `import * as X` (NOT `import type * as X`) is required: `import type` is
   fully erased at runtime, so referencing the namespace would throw ReferenceError.
 */
import * as Core from "@contexts/run-orchestration/application/index.ts";
import * as Analysis from "@contexts/change-analysis/application/index.ts";
import * as Generation from "@contexts/generation/application/index.ts";
import * as Execution from "@contexts/test-execution/application/index.ts";
import * as Signal from "@contexts/objective-signal/application/index.ts";
import * as Learning from "@contexts/cross-run-learning/application/index.ts";
import * as Catalog from "@contexts/app-catalog/application/index.ts";

test("every bounded-context public surface compiles and is importable", () => {
  const names = [Core, Analysis, Generation, Execution, Signal, Learning, Catalog];
  assert.equal(names.length, 7);
});
