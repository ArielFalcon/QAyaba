/* The static prompt digest a run records: AGENTS.md and every role file, read from the orchestrator's own copy of the repository. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashStaticPrompts } from "../../../../src/contexts/run-orchestration/infrastructure/static-prompt-hash.ts";

test("the static prompt hash covers AGENTS.md and every role file, in name order, and changes with any of them", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-prompt-hash-"));
  try {
    mkdirSync(join(root, "agents", "agent"), { recursive: true });
    writeFileSync(join(root, "agents", "AGENTS.md"), "shared");
    writeFileSync(join(root, "agents", "agent", "b.md"), "role b");
    writeFileSync(join(root, "agents", "agent", "a.md"), "role a");
    const first = hashStaticPrompts(root);
    assert.match(first ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(hashStaticPrompts(root), first);
    writeFileSync(join(root, "agents", "agent", "a.md"), "role a changed");
    assert.notEqual(hashStaticPrompts(root), first);
    assert.equal(hashStaticPrompts(join(root, "missing")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
