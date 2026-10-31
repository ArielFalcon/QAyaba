import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* `agents/` is OpenCode's config directory, bind-mounted read-only into the agents container (docker-compose.yml).
   At start OpenCode writes a `.gitignore` there when none exists, which a read-only mount refuses: every session then
   fails to open (`EROFS ... /root/.config/opencode/.gitignore`). The agents image installs the tools' plugin package
   from `package.json` and `package-lock.json` (agents/Dockerfile). A clone must therefore carry all three. The plugin
   package is 1.16.0 beside OpenCode 1.17.7 on purpose: the two are pinned apart (agents/Dockerfile `OPENCODE_VERSION`,
   agents/package.json), no pin has moved, and the tools' smoke scripts (agents/smoke/*) are what confirm a pair works,
   so no test ties the two versions together; the next move of either re-runs them (AGENTS.md "Conventions & gotchas"). */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED = ["agents/.gitignore", "agents/package.json", "agents/package-lock.json"];

test("a clone holds the files the agents image and OpenCode's read-only config directory need", () => {
  const tracked = execFileSync("git", ["ls-files", "--", ...REQUIRED], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.deepEqual(tracked.sort(), [...REQUIRED].sort());
});

test("the agents' plugin package is pinned to one exact version, the one the lock installs", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "agents/package.json"), "utf8")) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(repoRoot, "agents/package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
  const pinned = pkg.dependencies["@opencode-ai/plugin"];
  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages["node_modules/@opencode-ai/plugin"]?.version, pinned);
});
