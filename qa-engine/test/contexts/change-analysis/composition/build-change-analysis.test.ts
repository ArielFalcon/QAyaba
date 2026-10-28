/* buildChangeAnalysis: the returned API serves the ports the context's public surface declares, and each reaches the dependency it was built from. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeAnalysis } from "@contexts/change-analysis/composition/build-change-analysis.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "abc1234";

function fakeVcs(calls: string[]): VcsReadPort {
  return {
    diff: async () => {
      calls.push("diff");
      return "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n+if (x) { return 1; }\n";
    },
    message: async () => {
      calls.push("message");
      return "feat: add foo";
    },
    blastRadius: async (sha) => BlastRadius.of(sha, ["src/foo.ts"]),
  };
}

const graph: CodeGraphPort = {
  syncTo: async (repo, sha) => ({ repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 }),
  impactedSymbols: async () => ok({ indexedSha: SHA, symbols: [], truncated: false, seedBasis: "lines" as const }),
  callersOf: async () => ok({ indexedSha: SHA, symbols: [], truncated: false, seedBasis: "lines" as const }),
  routes: async () => ok([]),
};
const coChange: CoChangePort = { coChangeCoupling: async () => ok([]) };

test("the change-analysis port reads the commit through the vcs it was built from", async () => {
  const calls: string[] = [];
  const api = buildChangeAnalysis({ vcs: fakeVcs(calls) });

  const result = await api.changeAnalysis.classify({ repo: "org/front", role: "primary", headSha: Sha.of(SHA) });

  assert.equal(result.action, "generate");
  assert.deepEqual(calls.sort(), ["diff", "message"]);
});

test("a run without a code graph and its co-change history has no structural signal", () => {
  assert.equal(buildChangeAnalysis({ vcs: fakeVcs([]) }).structuralSignal, undefined);
});

test("the structural signal reads the code graph it was built from", async () => {
  const seen: string[] = [];
  const api = buildChangeAnalysis({
    vcs: fakeVcs([]),
    structural: {
      codeGraph: { ...graph, impactedSymbols: async (repo) => { seen.push(repo); return ok({ indexedSha: SHA, symbols: [], truncated: false, seedBasis: "lines" as const }); } },
      coChange,
      repoDir: "/repo",
    },
  });

  assert.ok(api.structuralSignal);
  await api.structuralSignal.render("/repo", BlastRadius.of(Sha.of(SHA), ["src/foo.ts"]));
  assert.deepEqual(seen, ["/repo"]);
});

test("the mirror reader is bound to the mirror it is asked for", () => {
  const api = buildChangeAnalysis({ vcs: fakeVcs([]) });
  const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) } as never;

  const reader = api.mirrorReader("/mirrors/a", runner);

  assert.equal(typeof reader.diff, "function");
  assert.equal(typeof reader.message, "function");
});

test("the change scope reads which changed non-code files the changed source files declare, from the mirror it walks, and its candidates are seeded by them", async () => {
  const mirror = mkdtempSync(join(tmpdir(), "declared-"));
  try {
    mkdirSync(join(mirror, "src/card"), { recursive: true });
    writeFileSync(join(mirror, "src/card/card.ts"), "@Component({ templateUrl: './card.html', styleUrls: ['./card.css'] }) export class Card {}\n");
    writeFileSync(join(mirror, "src/card/card.html"), "<p>{{ total }}</p>\n");
    writeFileSync(join(mirror, "src/card/card.css"), "p { color: red }\n");
    const seed = { file: "src/card/card.ts", symbol: "Card", kind: "class", depth: 0, confidence: 1 };
    const page = { file: "src/cards.page.ts", symbol: "CardsPage", kind: "class", depth: 1, confidence: 1, via: { file: seed.file, symbol: seed.symbol } };
    const api = buildChangeAnalysis({
      vcs: fakeVcs([]),
      scope: {
        codeGraph: { ...graph, impactedSymbols: async () => ok({ indexedSha: SHA, symbols: [seed, page], truncated: false, seedBasis: "lines" as const }), routes: async () => ok([{ file: page.file, line: 1, path: "/cards" }]) },
        serves: () => false,
        loadMap: () => ({ routes: [{ path: "/cards", implementationFiles: ["src/card/card.ts"] }] }),
      },
    });
    const repo = { repo: "org/web", role: "primary" as const, repoDir: mirror, headSha: SHA, changedFiles: ["src/card/card.ts", "src/card/card.html"] };
    const scope = await api.changeScope!.resolve({ specDir: join(mirror, "e2e"), repos: [repo] });
    assert.deepEqual(scope.repos[0]!.declaredResources, { "src/card/card.ts": ["src/card/card.html"] }, "only a changed file, and only what the source declares");
    const [candidate] = await api.changeScope!.candidates({ specDir: join(mirror, "e2e"), scope });
    assert.ok(candidate!.seeds.some((s) => s.file === "src/card/card.html"), "the page's use case is seeded by the template its source declares");
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
});
