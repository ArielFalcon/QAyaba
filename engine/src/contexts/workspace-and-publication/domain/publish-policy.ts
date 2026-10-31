/* What a publication commits and pushes, by what the run produced: the pathspecs staged, the patterns kept out of the repo's index, and the commit message. The exclude lists are a denylist: a path they name never reaches a commit pushed to an app repo. */

import type { RunMode } from "@kernel/run-mode.ts";

export type PublishKind = "e2e" | "context";

const E2E_PUBLISH_ADD = ["e2e"];
/* `e2e/.qa-probe/` holds the throwaway specs the generator tries with run_spec: swept after every generation and never a deliverable, excluded here as well so that a sweep that left something cannot publish it. */
const E2E_PUBLISH_EXCLUDES = ["node_modules/", "e2e/.qa/coverage/", "e2e/.qa/fault-injection/", "e2e/.qa-probe/", "e2e/.qa/measured.json", "e2e/.qa/service-context/", "e2e/.qa/*.tmp", "e2e/.auth/"];
const CONTEXT_PUBLISH_ADD = ["e2e/.qa/context.json"];

export function publishKindFor(mode: RunMode): PublishKind {
  return mode === "context" ? "context" : "e2e";
}

export function pathspecsFor(kind: PublishKind): readonly string[] {
  return kind === "context" ? CONTEXT_PUBLISH_ADD : E2E_PUBLISH_ADD;
}

/* A context is staged by exact pathspec: exclude patterns have nothing to filter. */
export function excludesFor(kind: PublishKind): readonly string[] {
  return kind === "context" ? [] : E2E_PUBLISH_EXCLUDES;
}

export function commitMessageFor(kind: PublishKind): string {
  return kind === "context" ? "docs(context): automated QA context map" : "test(e2e): automated QA";
}
