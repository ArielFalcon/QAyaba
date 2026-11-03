/* "A commit" has one definition, engine/src/shared-kernel/git-revision.ts. A source file that writes a hex-length regex for a
   commit id of its own is a second definition: an entry point that accepts what the kernel refuses (or the reverse) is how a
   value reaches git unjudged. The frozen list below holds the files that still do, each with why; it only shrinks. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const SOURCE_ROOTS = ["platform", "engine/src", "scripts"];
const KERNEL_RULE_FILES: ReadonlySet<string> = new Set(["engine/src/shared-kernel/git-revision.ts"]);
/* A hex class repeated 4 or 7 times at least, up to a full object name: an abbreviated or full commit id. */
const COMMIT_ID_REGEX = /\[0-9a-f(?:A-F)?\]\{(?:4|7),(?:40|64)\}/;

const FROZEN: Readonly<Record<string, string>> = {
  "engine/src/contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts": "fileAt's grammar: a commit id of either object format with a ~n or ^ suffix, not a commit id on its own",
  "engine/src/shared-infrastructure/code-graph/codegraph-workspace.ts": "the code-graph export, which accepts the SHA-256 object format up to 64 characters",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split("/").includes("node_modules"));
}

test("no source file defines a commit-id rule of its own beside git-revision.ts", () => {
  const offenders = SOURCE_ROOTS.flatMap(sourceFiles)
    .filter((path) => !KERNEL_RULE_FILES.has(path) && COMMIT_ID_REGEX.test(readFileSync(join(repoRoot, path), "utf8")))
    .sort();
  assert.deepEqual(offenders, Object.keys(FROZEN).sort());
});
