/*
 * The checks of `npm run sandbox:smoke` that need the harness itself rather than a spec running inside the sandbox: they start
 * children through the real launcher and read what is left afterwards, from the orchestrator's side, which is where a boundary
 * that fails open shows. Each check says in its name what holding means, and returns the problems it found (none: it holds).
 * Add a check here for every fix whose effect can be observed in a running container.
 */

import { cpSync } from "node:fs";
import { join } from "node:path";
import type { QaCase } from "../qa-engine/src/shared-kernel/qa-case.ts";

export interface SmokeCheckContext {
  /* The throwaway project the smoke installed, as a spec directory. */
  e2eDir: string;
  /* Where the check specs are kept: scripts/sandbox-smoke/checks. */
  checksDir: string;
  /* Runs the named spec files of `e2eDir` through the real runner, the way a production run does. */
  runSpecs(specFiles: readonly string[]): Promise<{ verdict: string; cases: ReadonlyArray<Pick<QaCase, "name" | "status">> }>;
}

export interface SmokeCheck {
  name: string;
  run(ctx: SmokeCheckContext): Promise<string[]>;
}

/* `a.spec.ts` must run `a.spec.ts` and not `schema.spec.ts`: Playwright reads a bare argument as an unanchored pattern over the path. */
export const specSelectionIsExact: SmokeCheck = {
  name: "a spec named alone does not also run the spec whose name ends the same way",
  async run(ctx) {
    for (const file of ["a.spec.ts", "schema.spec.ts"]) cpSync(join(ctx.checksDir, "anchor", file), join(ctx.e2eDir, file));
    const run = await ctx.runSpecs(["a.spec.ts"]);
    const names = run.cases.map((c) => c.name);
    const problems: string[] = [];
    if (!names.some((n) => n.includes("anchor-a ran"))) problems.push(`the named spec did not run (cases: ${JSON.stringify(names)})`);
    if (names.some((n) => n.includes("anchor-schema ran"))) problems.push("schema.spec.ts ran although only a.spec.ts was asked for");
    return problems;
  },
};

export const SMOKE_CHECKS: readonly SmokeCheck[] = [specSelectionIsExact];
